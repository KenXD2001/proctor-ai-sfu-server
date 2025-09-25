/**
 * Audio Integration Service
 * Monitors recorded audio files and sends them to Python microservice for analysis
 */

const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');

class AudioIntegrationService {
  constructor() {
    this.pythonServiceUrl = 'http://localhost:8080';
    this.audioDir = path.join(__dirname, 'recordings', 'audio');
    this.watchedFiles = new Set();
    this.isCalibrated = false;
    this.calibrationInProgress = false;
    this.autoCalibrationAttempts = 0;
    this.maxAutoCalibrationAttempts = 3;
    
    // Ensure audio directory exists
    if (!fs.existsSync(this.audioDir)) {
      fs.mkdirSync(this.audioDir, { recursive: true });
    }
    
    console.log('[AudioIntegration] Service initialized');
    console.log(`[AudioIntegration] Monitoring directory: ${this.audioDir}`);
    console.log(`[AudioIntegration] Python service URL: ${this.pythonServiceUrl}`);
  }

  /**
   * Initialize the service - perform calibration if needed
   */
  async initialize() {
    try {
      await this.checkPythonServiceHealth();
      await this.checkCalibrationStatus();
      
      if (!this.isCalibrated) {
        console.log('[AudioIntegration] No calibration found. Please perform calibration first.');
        console.log('[AudioIntegration] You can calibrate by calling: POST http://localhost:8080/calibrate');
      } else {
        console.log('[AudioIntegration] System is calibrated and ready for analysis');
      }
      
      this.startFileWatcher();
    } catch (error) {
      console.error('[AudioIntegration] Initialization failed:', error.message);
    }
  }

  /**
   * Check if Python service is healthy
   */
  async checkPythonServiceHealth() {
    try {
      const response = await axios.get(`${this.pythonServiceUrl}/`);
      console.log('[AudioIntegration] Python service health check:', response.data);
      return true;
    } catch (error) {
      console.error('[AudioIntegration] Python service is not available:', error.message);
      throw error;
    }
  }

  /**
   * Check calibration status
   */
  async checkCalibrationStatus() {
    try {
      const response = await axios.get(`${this.pythonServiceUrl}/status`);
      this.isCalibrated = response.data.calibrated;
      console.log(`[AudioIntegration] Calibration status: ${this.isCalibrated ? 'CALIBRATED' : 'NOT CALIBRATED'}`);
      
      if (this.isCalibrated) {
        console.log('[AudioIntegration] Current thresholds:', response.data.calibration_thresholds);
      }
    } catch (error) {
      console.error('[AudioIntegration] Failed to check calibration status:', error.message);
      this.isCalibrated = false;
    }
  }

  /**
   * Start watching for new audio files
   */
  startFileWatcher() {
    console.log('[AudioIntegration] Starting file watcher...');
    
    // Check for existing audio files on startup
    this.checkExistingAudioFiles();
    
    fs.watch(this.audioDir, { recursive: false }, (eventType, filename) => {
      if (eventType === 'rename' && filename && filename.endsWith('.mp3')) {
        const filePath = path.join(this.audioDir, filename);
        
        // Check if file exists and is not already being processed
        if (fs.existsSync(filePath) && !this.watchedFiles.has(filePath)) {
          console.log(`[AudioIntegration] New audio file detected: ${filename}`);
          this.processAudioFile(filePath);
        }
      }
    });
  }

  /**
   * Check for existing audio files on startup
   */
  checkExistingAudioFiles() {
    try {
      console.log('[AudioIntegration] Checking for existing audio files...');
      
      const files = fs.readdirSync(this.audioDir);
      const audioFiles = files
        .filter(file => file.endsWith('.mp3') && !file.includes('temp_'))
        .map(file => ({
          name: file,
          path: path.join(this.audioDir, file),
          stats: fs.statSync(path.join(this.audioDir, file))
        }))
        .sort((a, b) => b.stats.mtime - a.stats.mtime); // Sort by modification time, newest first
      
      console.log(`[AudioIntegration] Found ${audioFiles.length} existing audio files`);
      
      if (audioFiles.length > 0 && !this.isCalibrated) {
        // Use the most recent audio file for calibration
        const newestFile = audioFiles[0];
        console.log(`[AudioIntegration] Using most recent file for auto-calibration: ${newestFile.name}`);
        console.log(`[AudioIntegration] File size: ${(newestFile.stats.size / 1024).toFixed(2)} KB`);
        
        // Process the newest file for calibration
        setTimeout(() => {
          this.processAudioFile(newestFile.path);
        }, 1000); // Small delay to ensure everything is initialized
      }
      
    } catch (error) {
      console.error('[AudioIntegration] Error checking existing files:', error.message);
    }
  }

  /**
   * Process a single audio file
   */
  async processAudioFile(filePath) {
    const filename = path.basename(filePath);
    const fileId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    console.log(`[AudioIntegration] Processing audio file: ${filename} (ID: ${fileId})`);
    
    // Mark file as being processed
    this.watchedFiles.add(filePath);
    
    try {
      // Wait a moment for file to be completely written
      await this.waitForFileComplete(filePath);
      
      // Check if calibration is needed
      if (!this.isCalibrated) {
        // Attempt automatic calibration if not already in progress
        if (!this.calibrationInProgress && this.autoCalibrationAttempts < this.maxAutoCalibrationAttempts) {
          console.log(`[AudioIntegration] System not calibrated. Attempting auto-calibration with: ${filename}`);
          await this.attemptAutoCalibration(filePath, filename);
        } else {
          console.log(`[AudioIntegration] Skipping analysis - system not calibrated: ${filename}`);
        }
        return;
      }
      
      // Send file to Python service for analysis
      const analysisResult = await this.sendForAnalysis(filePath, filename, fileId);
      
      // Log analysis results
      this.logAnalysisResults(filename, analysisResult);
      
      // Handle analysis results (you can extend this for your specific needs)
      await this.handleAnalysisResults(filename, analysisResult);
      
    } catch (error) {
      console.error(`[AudioIntegration] Error processing ${filename}:`, error.message);
    } finally {
      // Remove from watched files after processing
      this.watchedFiles.delete(filePath);
    }
  }

  /**
   * Wait for file to be completely written
   */
  async waitForFileComplete(filePath, maxWaitTime = 10000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWaitTime) {
      try {
        const stats = fs.statSync(filePath);
        const currentSize = stats.size;
        
        // Wait a bit and check if size changed
        await new Promise(resolve => setTimeout(resolve, 500));
        const newStats = fs.statSync(filePath);
        
        if (newStats.size === currentSize && currentSize > 0) {
          console.log(`[AudioIntegration] File complete: ${path.basename(filePath)} (${currentSize} bytes)`);
          return;
        }
      } catch (error) {
        // File might still be being written
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    
    console.log(`[AudioIntegration] Timeout waiting for file completion: ${path.basename(filePath)}`);
  }

  /**
   * Send audio file to Python service for analysis
   */
  async sendForAnalysis(filePath, filename, fileId) {
    try {
      console.log(`[AudioIntegration] Sending ${filename} for analysis...`);
      
      const formData = new FormData();
      formData.append('audio_file', fs.createReadStream(filePath));
      
      const response = await axios.post(`${this.pythonServiceUrl}/analyze`, formData, {
        headers: {
          ...formData.getHeaders(),
        },
        timeout: 30000, // 30 second timeout
      });
      
      console.log(`[AudioIntegration] Analysis completed for ${filename}`);
      return response.data;
      
    } catch (error) {
      if (error.response) {
        console.error(`[AudioIntegration] Analysis failed for ${filename}:`, error.response.data);
      } else {
        console.error(`[AudioIntegration] Network error for ${filename}:`, error.message);
      }
      throw error;
    }
  }

  /**
   * Log analysis results in a readable format
   */
  logAnalysisResults(filename, result) {
    console.log('\n' + '='.repeat(60));
    console.log(`[AudioIntegration] ANALYSIS RESULTS: ${filename}`);
    console.log('='.repeat(60));
    
    if (result.analysis) {
      const analysis = result.analysis;
      console.log(`Volume Level: ${analysis.volume_level.toUpperCase()}`);
      console.log(`Human Speech: ${analysis.human_speech_detected ? 'YES' : 'NO'}`);
      console.log(`Suspicious Sounds: ${analysis.suspicious_sounds_detected ? 'YES' : 'NO'}`);
      
      if (analysis.detected_background_sounds && analysis.detected_background_sounds.length > 0) {
        console.log(`Background Sounds: ${analysis.detected_background_sounds.join(', ')}`);
      }
      
      console.log(`RMS Energy: ${analysis.rms_energy.toFixed(6)}`);
      console.log(`Duration: ${analysis.duration_seconds.toFixed(2)} seconds`);
      console.log(`Sample Rate: ${analysis.sample_rate} Hz`);
    }
    
    console.log(`File Saved: ${result.file_saved ? 'YES' : 'NO'}`);
    if (result.file_saved && result.saved_file_path) {
      console.log(`Saved Path: ${result.saved_file_path}`);
    }
    
    console.log(`Timestamp: ${result.timestamp}`);
    console.log('='.repeat(60) + '\n');
  }

  /**
   * Handle analysis results (extend this for your specific needs)
   */
  async handleAnalysisResults(filename, result) {
    const analysis = result.analysis;
    
    // Example: Send alerts for suspicious activity
    if (analysis.suspicious_sounds_detected || analysis.human_speech_detected) {
      console.log(`[AudioIntegration] ALERT: Suspicious activity detected in ${filename}`);
      
      // You can extend this to:
      // - Send notifications to admins
      // - Log to database
      // - Trigger other security measures
      // - Send to external monitoring systems
      
      if (analysis.human_speech_detected) {
        console.log(`[AudioIntegration] 🔴 Speech detected - potential communication violation`);
      }
      
      if (analysis.detected_background_sounds && analysis.detected_background_sounds.length > 0) {
        console.log(`[AudioIntegration] 🔴 Background sounds detected: ${analysis.detected_background_sounds.join(', ')}`);
      }
    } else {
      console.log(`[AudioIntegration] No suspicious activity detected in ${filename}`);
    }
  }

  /**
   * Attempt automatic calibration using an audio file
   */
  async attemptAutoCalibration(filePath, filename) {
    this.calibrationInProgress = true;
    this.autoCalibrationAttempts++;
    
    try {
      console.log(`[AudioIntegration] Auto-calibration attempt ${this.autoCalibrationAttempts}/${this.maxAutoCalibrationAttempts} using: ${filename}`);
      console.log(`[AudioIntegration] File path: ${filePath}`);
      
      // Wait a bit longer for the file to be completely written
      console.log(`[AudioIntegration] Waiting for file to stabilize (2 seconds)...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Check if file is large enough for calibration (should be around 10 seconds)
      const stats = fs.statSync(filePath);
      const fileSizeKB = stats.size / 1024;
      
      console.log(`[AudioIntegration] File analysis:`);
      console.log(`  • Size: ${fileSizeKB.toFixed(2)} KB`);
      console.log(`  • Modified: ${stats.mtime.toISOString()}`);
      console.log(`  • Age: ${Math.round((Date.now() - stats.mtime.getTime()) / 1000)} seconds ago`);
      
      // Only attempt calibration if file is reasonably sized (at least 25KB for a 5-second audio)
      // Note: Analysis files are now 5 seconds, so we need smaller files for calibration
      if (fileSizeKB < 25) {
        console.log(`[AudioIntegration] File too small for calibration (${fileSizeKB.toFixed(2)} KB). Waiting for larger file...`);
        console.log(`[AudioIntegration] Recommended: Use audio files with at least 25KB for proper calibration (5-second analysis files)`);
        this.calibrationInProgress = false;
        return;
      }
      
      console.log(`[AudioIntegration] File size is adequate for calibration. Proceeding...`);
      
      // Perform calibration
      const result = await this.performCalibration(filePath);
      
      console.log('[AudioIntegration] Auto-calibration completed successfully!');
      console.log(`[AudioIntegration] Final calibration thresholds:`, result.thresholds);
      
      this.isCalibrated = true;
      this.calibrationInProgress = false;
      
      // Now process this file for analysis since we're calibrated
      console.log(`[AudioIntegration] 🔍 Now analyzing the calibration file: ${filename}`);
      await this.sendForAnalysis(filePath, filename, `calibration_${Date.now()}`);
      
    } catch (error) {
      console.error(`[AudioIntegration] Auto-calibration attempt ${this.autoCalibrationAttempts} failed:`, error.message);
      console.error(`[AudioIntegration] 🔍 Error details:`, error.stack);
      this.calibrationInProgress = false;
      
      if (this.autoCalibrationAttempts >= this.maxAutoCalibrationAttempts) {
        console.log('[AudioIntegration] Max auto-calibration attempts reached. Manual calibration required.');
        console.log('[AudioIntegration] To calibrate manually, call: POST http://localhost:8080/calibrate');
        console.log('[AudioIntegration] 🔧 Or use a proper calibration audio file (5+ seconds of ambient noise)');
      } else {
        console.log(`[AudioIntegration] Will retry with next audio file (${this.maxAutoCalibrationAttempts - this.autoCalibrationAttempts} attempts remaining)`);
      }
    }
  }

  /**
   * Manually trigger calibration (for testing or manual setup)
   */
  async performCalibration(calibrationFilePath) {
    try {
      console.log(`[AudioIntegration] Performing calibration with file: ${calibrationFilePath}`);
      
      // Check file details before sending
      const stats = fs.statSync(calibrationFilePath);
      const fileSizeKB = (stats.size / 1024).toFixed(2);
      console.log(`[AudioIntegration] Calibration file details: ${fileSizeKB} KB, modified: ${stats.mtime.toISOString()}`);
      
      console.log(`[AudioIntegration] Sending calibration request to Python service...`);
      const startTime = Date.now();
      
      const formData = new FormData();
      formData.append('audio_file', fs.createReadStream(calibrationFilePath));
      
      const response = await axios.post(`${this.pythonServiceUrl}/calibrate`, formData, {
        headers: {
          ...formData.getHeaders(),
        },
        timeout: 60000, // 60 second timeout for calibration
      });
      
      const duration = Date.now() - startTime;
      console.log(`[AudioIntegration] Calibration completed in ${duration}ms`);
      console.log('[AudioIntegration] Calibration completed successfully');
      
      // Log detailed calibration results
      if (response.data && response.data.thresholds) {
        console.log('[AudioIntegration] Calibration Results:');
        console.log(`  • Low Threshold: ${response.data.thresholds.low.toFixed(6)}`);
        console.log(`  • Medium Threshold: ${response.data.thresholds.medium.toFixed(6)}`);
        console.log(`  • High Threshold: ${response.data.thresholds.high.toFixed(6)}`);
        console.log(`  • Noise Floor: ${response.data.thresholds.noise_floor.toFixed(6)}`);
        console.log(`  • Noise Ceiling: ${response.data.thresholds.noise_ceiling.toFixed(6)}`);
        
        if (response.data.calibration_metrics) {
          console.log('[AudioIntegration] 📈 Calibration Metrics:');
          console.log(`  • Dynamic Range: ${response.data.calibration_metrics.dynamic_range_db.toFixed(2)} dB`);
          console.log(`  • SNR Estimate: ${response.data.calibration_metrics.snr_estimate_db.toFixed(2)} dB`);
          console.log(`  • Spectral Bandwidth: ${response.data.calibration_metrics.spectral_bandwidth.toFixed(2)}`);
          console.log(`  • Onset Rate: ${response.data.calibration_metrics.onset_rate_per_second.toFixed(2)} per second`);
        }
      }
      
      this.isCalibrated = true;
      return response.data;
      
    } catch (error) {
      console.error('[AudioIntegration] Calibration failed:', error.message);
      if (error.response) {
        console.error('[AudioIntegration] Response details:', error.response.data);
      }
      throw error;
    }
  }

  /**
   * Reset auto-calibration attempts (useful for retrying)
   */
  resetAutoCalibrationAttempts() {
    this.autoCalibrationAttempts = 0;
    this.calibrationInProgress = false;
    console.log('[AudioIntegration] Auto-calibration attempts reset');
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      isCalibrated: this.isCalibrated,
      calibrationInProgress: this.calibrationInProgress,
      autoCalibrationAttempts: this.autoCalibrationAttempts,
      maxAutoCalibrationAttempts: this.maxAutoCalibrationAttempts,
      watchedFiles: this.watchedFiles.size,
      audioDirectory: this.audioDir,
      pythonServiceUrl: this.pythonServiceUrl
    };
  }
}

module.exports = AudioIntegrationService;
