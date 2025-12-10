/**
 * Event Queue System for Detection Events
 * 
 * Features:
 * - Queues detection events before saving to database
 * - Deduplicates events (same event type + session within 5 minutes = skip)
 * - Uploads images to S3 first, then saves flag session to DB
 * - Prevents integrity score from decreasing too rapidly
 */

const fs = require('fs').promises;
const path = require('path');
const { logger, createLogger } = require('./utils/logger');
const { uploadDetectionImageToS3 } = require('./imageUploadService');
const { uploadDetectionAudioToS3 } = require('./audioUploadService');

const queueLogger = createLogger('EventQueue');

// Queue configuration
const DEDUPLICATION_WINDOW_MS = 0; // disabled per current requirements
const MAX_QUEUE_SIZE = 1000;
const PROCESS_INTERVAL_MS = 5000; // Process queue every 5 seconds
const MAX_PARALLEL_UPLOADS = 4; // safe parallelism (2–4 recommended)
const MAX_UPLOAD_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 500;

// Use node-fetch for HTTP requests
let fetch;
try {
  if (typeof globalThis.fetch === 'function') {
    fetch = globalThis.fetch;
  } else {
    fetch = require('node-fetch');
  }
} catch (error) {
  queueLogger.warn('Fetch not available, using require', { error: error.message });
  fetch = require('node-fetch');
}

const BACKEND_API_URL = process.env.BACKEND_API_URL || 'http://localhost:8000';

/**
 * Event Queue Class
 */
class EventQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.processInterval = null;
    
    // Deduplication tracking: Map<sessionId_eventType, lastTriggerTime>
    this.lastEventTimes = new Map();
    
    // Start processing interval
    this.startProcessing();
    
    queueLogger.info('Event queue initialized', {
      deduplicationWindowMs: DEDUPLICATION_WINDOW_MS,
      processIntervalMs: PROCESS_INTERVAL_MS,
    });
  }

  /**
   * Add event to queue
   * @param {Object} event - Event object
   * @param {string} event.examId - Exam ID
   * @param {string} event.batchId - Batch ID
   * @param {string} event.candidateId - Candidate ID
   * @param {string} event.eventType - Event type (e.g., 'face_mismatch', 'fullscreen_exit', 'noise', 'speech')
   * @param {Buffer} event.imageBuffer - Image data as buffer (optional)
   * @param {Buffer} event.audioBuffer - Audio data as buffer (optional)
   * @param {string} event.filename - Filename for image/audio (optional)
   * @param {string} event.mimeType - MIME type for audio (optional, e.g., 'audio/webm')
   * @param {Object} event.metadata - Additional metadata (optional)
   * @returns {Promise<boolean>} - Returns true if added to queue, false if deduplicated
   */
  async enqueue(event) {
    const { examId, batchId, candidateId, eventType } = event;

    // Check queue size
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      queueLogger.warn('Queue full, dropping oldest event', {
        queueSize: this.queue.length,
        maxSize: MAX_QUEUE_SIZE,
      });
      this.queue.shift();
    }

    const sessionKey = `${examId}_${batchId}_${candidateId}`;
    const dedupKey = `${sessionKey}_${eventType}`;
    const now = Date.now();

    // Deduplication disabled (window = 0)

    // Add event to queue with timestamp
    const queueEvent = {
      ...event,
      queuedAt: now,
      id: `${dedupKey}_${now}`, // Unique ID for this event
    };

    this.queue.push(queueEvent);

    queueLogger.info('Event added to queue', {
      eventType,
      examId,
      batchId,
      candidateId,
      queueSize: this.queue.length,
      hasImage: !!event.imageBuffer,
      hasAudio: !!event.audioBuffer,
    });

    return true; // Event added to queue
  }

  /**
   * Process queue (processes events one by one)
   */
  async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, MAX_PARALLEL_UPLOADS);
        const results = await Promise.allSettled(
          batch.map((event) => this.processEvent(event))
        );

        results.forEach((result, idx) => {
          const event = batch[idx];
          if (result.status === 'rejected') {
            queueLogger.error('Error processing event', {
              error: result.reason?.message || String(result.reason),
              eventId: event.id,
              eventType: event.eventType,
              examId: event.examId,
              batchId: event.batchId,
              candidateId: event.candidateId,
            });
          }
        });
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Process a single event
   * 1. Upload image to S3 (if image exists)
   * 2. Upload audio to S3 (if audio exists)
   * 3. Save flag session to backend DB
   */
  async processEvent(event) {
    const {
      examId,
      batchId,
      candidateId,
      eventType,
      filePath, // staging file path (image or audio)
      kind, // 'image' | 'audio'
      imageBuffer,
      audioBuffer,
      filename,
      mimeType,
      metadata = {},
    } = event;

    queueLogger.info('Processing event', {
      eventId: event.id,
      eventType,
      examId,
      batchId,
      candidateId,
      kind,
      hasImage: !!imageBuffer,
      hasAudio: !!audioBuffer,
      hasFilePath: !!filePath,
    });

    let imageUrl = null;
    let imageObjectKey = null;
    let audioUrl = null;
    let audioObjectKey = null;

    const withRetry = async (fn, desc) => {
      let attempt = 0;
      let lastError;
      while (attempt < MAX_UPLOAD_ATTEMPTS) {
        try {
          return await fn();
        } catch (err) {
          lastError = err;
          attempt += 1;
          if (attempt >= MAX_UPLOAD_ATTEMPTS) {
            throw err;
          }
          const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          queueLogger.warn(`Retrying ${desc} (attempt ${attempt}/${MAX_UPLOAD_ATTEMPTS})`, {
            delayMs: delay,
            error: err.message,
          });
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      throw lastError;
    };

    const resolveBufferFromFile = async () => {
      if (!filePath) return null;
      try {
        return await fs.readFile(filePath);
      } catch (err) {
        queueLogger.error('Failed to read staged file', {
          filePath,
          error: err.message,
        });
        throw err;
      }
    };

    const effectiveFilename = filename || (filePath ? path.basename(filePath) : undefined);

    // Step 1: Upload image (if applicable)
    if (kind === 'image' || imageBuffer) {
      const buffer = imageBuffer || (await resolveBufferFromFile());
      if (buffer && Buffer.isBuffer(buffer)) {
        try {
          const uploadResult = await withRetry(
            () =>
              uploadDetectionImageToS3(
                buffer,
                examId,
                batchId,
                candidateId,
                eventType,
                effectiveFilename
              ),
            'image upload'
          );

          imageUrl = uploadResult.url;
          imageObjectKey = uploadResult.objectKey;

          queueLogger.info('Image uploaded to S3', {
            eventId: event.id,
            imageUrl,
            imageObjectKey,
            fileSize: uploadResult.fileSize,
          });
        } catch (error) {
          queueLogger.error('Failed to upload image to S3', {
            eventId: event.id,
            error: error.message,
            eventType,
          });
        }
      }
    }

    // Step 2: Upload audio (if applicable)
    if (kind === 'audio' || audioBuffer) {
      const buffer = audioBuffer || (await resolveBufferFromFile());
      if (buffer && Buffer.isBuffer(buffer)) {
        try {
          const uploadResult = await withRetry(
            () =>
              uploadDetectionAudioToS3(
                buffer,
                examId,
                batchId,
                candidateId,
                eventType,
                effectiveFilename,
                mimeType
              ),
            'audio upload'
          );

          audioUrl = uploadResult.url;
          audioObjectKey = uploadResult.objectKey;

          queueLogger.info('Audio uploaded to S3', {
            eventId: event.id,
            audioUrl,
            audioObjectKey,
            fileSize: uploadResult.fileSize,
            contentType: uploadResult.contentType,
          });
        } catch (error) {
          queueLogger.error('Failed to upload audio to S3', {
            eventId: event.id,
            error: error.message,
            eventType,
          });
        }
      }
    }

    // Step 3: Save flag session to backend DB
    try {
      await this.saveFlagSessionToBackend({
        examId,
        batchId,
        candidateId,
        eventType,
        imageUrl,
        imageObjectKey,
        audioUrl,
        audioObjectKey,
        metadata,
      });

      queueLogger.info('Flag session saved to backend', {
        eventId: event.id,
        eventType,
        examId,
        batchId,
        candidateId,
        imageUrl,
        audioUrl,
      });
    } catch (error) {
      queueLogger.error('Failed to save flag session to backend', {
        eventId: event.id,
        error: error.message,
        eventType,
        examId,
        batchId,
        candidateId,
      });
      throw error; // Re-throw so queue can retry if needed
    } finally {
      if (filePath) {
        try {
          await fs.unlink(filePath);
          queueLogger.info('Staged file removed after processing', { filePath });
        } catch (err) {
          queueLogger.warn('Failed to remove staged file', {
            filePath,
            error: err.message,
          });
        }
      }
    }
  }

  /**
   * Save flag session to backend API
   */
  async saveFlagSessionToBackend({ examId, batchId, candidateId, eventType, imageUrl, imageObjectKey, audioUrl, audioObjectKey, metadata }) {
    // Map violation types to backend event types (handles both camelCase and snake_case)
    const eventTypeMapping = {
      // Snake case mappings
      'face_mismatch': 'face_mismatch',
      'face_missing': 'face_missing',
      'fullscreen_exit': 'fullscreen_exit',
      'tab_switch_detected': 'tab_switched',
      'max_tab_switches_exceeded': 'tab_switched',
      'max_fullscreen_exit_exceeded': 'fullscreen_exit',
      'multiple_faces_detected': 'multiple_faces_detected',
      'looking_away': 'looking_away',
      'head_turns': 'head_turns',
      'frequent_head_turns': 'frequent_head_turns',
      'noise': 'noise_detected',
      'speech': 'speech_detected',
      // Camel case mappings (from frontend)
      'faceMismatch': 'face_mismatch',
      'faceMissing': 'face_missing',
      'fullscreenExit': 'fullscreen_exit',
      'tabSwitch': 'tab_switched',
      'tabSwitched': 'tab_switched',
      'multipleFaces': 'multiple_faces_detected',
      'multipleFacesDetected': 'multiple_faces_detected',
      'lookingAway': 'looking_away',
      'headTurns': 'head_turns',
      'frequentHeadTurns': 'frequent_head_turns',
    };

    const mappedEventType = eventTypeMapping[eventType] || eventType;

    // Prepare flag session data
    const flagData = {
      event_type: mappedEventType,
      severity: metadata.severity || 'medium',
      message: metadata.message || `${mappedEventType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())} detected during exam session`,
      screenshot_url: imageUrl || null, // Store S3 URL for image
      ai_analysis_data: JSON.stringify({
        ...metadata,
        image_object_key: imageObjectKey || null,
        audio_url: audioUrl || null, // Store S3 URL for audio
        audio_object_key: audioObjectKey || null,
        detection_method: 'frontend_monitoring',
        timestamp: new Date().toISOString(),
        original_event_type: eventType,
      }),
      auto_flagged: true,
      resolved: false,
    };

    // Build query parameters for exam_id, batch_id, candidate_id
    const params = new URLSearchParams({
      exam_id: examId,
      batch_id: batchId || 'none', // Pass 'none' if batchId is null
      candidate_id: candidateId,
    });

    // Call backend API to save flag session
    const apiUrl = `${BACKEND_API_URL}/api/exam-sessions/save-flag-session?${params.toString()}`;
    
    queueLogger.info('Calling backend API to save flag session', {
      url: apiUrl,
      eventType: mappedEventType,
      examId,
      batchId,
      candidateId,
    });

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(flagData),
    });

    if (!response.ok) {
      const errorText = await response.text();
      queueLogger.error('Backend API request failed', {
        url: apiUrl,
        status: response.status,
        statusText: response.statusText,
        errorText,
        eventType: mappedEventType,
        examId,
        batchId,
        candidateId,
      });
      throw new Error(`Backend API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const result = await response.json();

    queueLogger.info('Flag session saved successfully', {
      flagSessionId: result.flag_session_id,
      eventType: mappedEventType,
      examId,
      batchId,
      candidateId,
    });

    return result;
  }

  /**
   * Start processing interval
   */
  startProcessing() {
    if (this.processInterval) {
      clearInterval(this.processInterval);
    }

    this.processInterval = setInterval(() => {
      this.processQueue().catch((error) => {
        queueLogger.error('Error in queue processing interval', {
          error: error.message,
        });
      });
    }, PROCESS_INTERVAL_MS);

    queueLogger.info('Queue processing started', {
      intervalMs: PROCESS_INTERVAL_MS,
    });
  }

  /**
   * Stop processing interval
   */
  stopProcessing() {
    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = null;
    }
    queueLogger.info('Queue processing stopped');
  }

  /**
   * Get queue status
   */
  getStatus() {
    return {
      queueSize: this.queue.length,
      processing: this.processing,
      deduplicationEntries: this.lastEventTimes.size,
      maxQueueSize: MAX_QUEUE_SIZE,
      deduplicationWindowMs: DEDUPLICATION_WINDOW_MS,
    };
  }

  /**
   * Clear queue (for testing/cleanup)
   */
  clear() {
    this.queue = [];
    this.lastEventTimes.clear();
    queueLogger.info('Queue cleared');
  }
}

// Create singleton instance
const eventQueue = new EventQueue();

module.exports = {
  eventQueue,
  EventQueue,
};

