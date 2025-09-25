const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

/**
 * Face Analysis Service
 * Handles communication with Python microservice for face analysis
 */
class FaceAnalysisService {
  constructor() {
    this.pythonServiceUrl = 'http://localhost:8080';
    this.analysisInterval = 5000; // 5 seconds
    this.activeAnalyses = new Map(); // Track active analyses per user
    this.frameQueues = new Map(); // Queue frames for batch processing
    
    console.log('[FaceAnalysis] Service initialized');
  }

  /**
   * Start face analysis for a user
   * @param {string} userId - User ID
   * @param {string} framePath - Path to frame file
   */
  async startAnalysis(userId, framePath) {
    try {
      console.log(`[FaceAnalysis] Starting analysis for user: ${userId}`);
      
      // Initialize queue for user if not exists
      if (!this.frameQueues.has(userId)) {
        this.frameQueues.set(userId, []);
      }
      
      // Add frame to queue
      this.frameQueues.get(userId).push(framePath);
      
      // Start analysis interval if not already running
      if (!this.activeAnalyses.has(userId)) {
        this.activeAnalyses.set(userId, setInterval(() => {
          this.processFrameQueue(userId);
        }, this.analysisInterval));
        
        console.log(`[FaceAnalysis] Analysis interval started for user: ${userId}`);
      }
      
    } catch (error) {
      console.error(`[FaceAnalysis] Error starting analysis for user ${userId}:`, error.message);
    }
  }

  /**
   * Process frame queue for a user
   * @param {string} userId - User ID
   */
  async processFrameQueue(userId) {
    try {
      const queue = this.frameQueues.get(userId);
      if (!queue || queue.length === 0) {
        return;
      }
      
      // Get the latest frame (remove others to avoid processing old frames)
      const latestFrame = queue.pop();
      
      // Clear the queue (keep only the latest frame)
      queue.length = 0;
      
      if (!latestFrame || !fs.existsSync(latestFrame)) {
        return;
      }
      
      console.log(`[FaceAnalysis] Processing frame for user ${userId}: ${path.basename(latestFrame)}`);
      
      // Send frame to Python microservice
      await this.sendFrameForAnalysis(userId, latestFrame);
      
    } catch (error) {
      console.error(`[FaceAnalysis] Error processing frame queue for user ${userId}:`, error.message);
    }
  }

  /**
   * Send frame to Python microservice for analysis
   * @param {string} userId - User ID
   * @param {string} framePath - Path to frame file
   */
  async sendFrameForAnalysis(userId, framePath) {
    try {
      // Create form data
      const formData = new FormData();
      formData.append('frame_file', fs.createReadStream(framePath));
      formData.append('user_id', userId);
      
      // Send to Python microservice
      const response = await axios.post(
        `${this.pythonServiceUrl}/analyze-face`,
        formData,
        {
          headers: {
            ...formData.getHeaders(),
          },
          timeout: 15000, // 15 second timeout (for initial download)
        }
      );
      
      if (response.data && response.data.status === 'success') {
        const analysis = response.data.analysis;
        
        console.log(`[FaceAnalysis] Analysis completed for user ${userId}:`, {
          violations: analysis.violations,
          processingTime: analysis.processing_time_seconds,
          frameSaved: analysis.frame_saved
        });
        
        // Handle violations if any
        if (analysis.violations && analysis.violations.length > 0) {
          await this.handleViolations(userId, analysis.violations, analysis.analysis_data);
        }
        
        // Clean up frame file if no violations (to save space)
        if (!analysis.frame_saved) {
          try {
            fs.unlinkSync(framePath);
            console.log(`[FaceAnalysis] Cleaned up frame: ${path.basename(framePath)}`);
          } catch (cleanupError) {
            console.error(`[FaceAnalysis] Error cleaning up frame: ${cleanupError.message}`);
          }
        }
        
      } else {
        console.error(`[FaceAnalysis] Analysis failed for user ${userId}:`, response.data);
      }
      
    } catch (error) {
      console.error(`[FaceAnalysis] Error sending frame for analysis (user ${userId}):`, error.message);
      
      // Clean up frame file on error
      try {
        if (fs.existsSync(framePath)) {
          fs.unlinkSync(framePath);
          console.log(`[FaceAnalysis] Cleaned up frame after error: ${path.basename(framePath)}`);
        }
      } catch (cleanupError) {
        console.error(`[FaceAnalysis] Error cleaning up frame after error: ${cleanupError.message}`);
      }
    }
  }

  /**
   * Handle violations detected by face analysis
   * @param {string} userId - User ID
   * @param {Array} violations - List of violations
   * @param {Object} analysisData - Analysis data
   */
  async handleViolations(userId, violations, analysisData) {
    try {
      console.log(`[FaceAnalysis] 🚨 Violations detected for user ${userId}:`, violations);
      
      // Here you can implement your violation handling logic
      // For example, send notifications, log to database, etc.
      
      // Example: Send violation notification via socket
      // socket.emit('face_violation_detected', {
      //   userId,
      //   violations,
      //   analysisData,
      //   timestamp: new Date().toISOString()
      // });
      
      // Log violation details
      const violationLog = {
        userId,
        violations,
        analysisData,
        timestamp: new Date().toISOString(),
        type: 'face_analysis_violation'
      };
      
      console.log(`[FaceAnalysis] 📝 Violation log:`, JSON.stringify(violationLog, null, 2));
      
    } catch (error) {
      console.error(`[FaceAnalysis] Error handling violations for user ${userId}:`, error.message);
    }
  }

  /**
   * Stop face analysis for a user
   * @param {string} userId - User ID
   */
  stopAnalysis(userId) {
    try {
      console.log(`[FaceAnalysis] Stopping analysis for user: ${userId}`);
      
      // Clear analysis interval
      if (this.activeAnalyses.has(userId)) {
        clearInterval(this.activeAnalyses.get(userId));
        this.activeAnalyses.delete(userId);
      }
      
      // Clear frame queue
      if (this.frameQueues.has(userId)) {
        const queue = this.frameQueues.get(userId);
        
        // Clean up queued frames
        queue.forEach(framePath => {
          try {
            if (fs.existsSync(framePath)) {
              fs.unlinkSync(framePath);
              console.log(`[FaceAnalysis] Cleaned up queued frame: ${path.basename(framePath)}`);
            }
          } catch (error) {
            console.error(`[FaceAnalysis] Error cleaning up queued frame: ${error.message}`);
          }
        });
        
        this.frameQueues.delete(userId);
      }
      
      // Notify Python microservice to cleanup user data
      this.cleanupUserData(userId);
      
      console.log(`[FaceAnalysis] Analysis stopped for user: ${userId}`);
      
    } catch (error) {
      console.error(`[FaceAnalysis] Error stopping analysis for user ${userId}:`, error.message);
    }
  }

  /**
   * Clean up user data in Python microservice
   * @param {string} userId - User ID
   */
  async cleanupUserData(userId) {
    try {
      await axios.post(`${this.pythonServiceUrl}/cleanup-user/${userId}`, {}, {
        timeout: 5000
      });
      
      console.log(`[FaceAnalysis] User data cleaned up in Python service: ${userId}`);
      
    } catch (error) {
      console.error(`[FaceAnalysis] Error cleaning up user data for ${userId}:`, error.message);
    }
  }

  /**
   * Get service status
   * @returns {Object} Service status
   */
  getStatus() {
    return {
      activeAnalyses: this.activeAnalyses.size,
      frameQueues: this.frameQueues.size,
      pythonServiceUrl: this.pythonServiceUrl,
      analysisInterval: this.analysisInterval,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Check if Python microservice is available
   * @returns {Promise<boolean>} True if service is available
   */
  async checkServiceHealth() {
    try {
      const response = await axios.get(`${this.pythonServiceUrl}/status`, {
        timeout: 5000
      });
      
      return response.status === 200;
      
    } catch (error) {
      console.error(`[FaceAnalysis] Python service health check failed:`, error.message);
      return false;
    }
  }
}

module.exports = FaceAnalysisService;
