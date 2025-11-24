/**
 * Event Queue System for Detection Events
 * 
 * Features:
 * - Queues detection events before saving to database
 * - Deduplicates events (same event type + session within 5 minutes = skip)
 * - Uploads images to S3 first, then saves flag session to DB
 * - Prevents integrity score from decreasing too rapidly
 */

const { logger, createLogger } = require('./utils/logger');
const { uploadDetectionImageToS3 } = require('./imageUploadService');

const queueLogger = createLogger('EventQueue');

// Queue configuration
const DEDUPLICATION_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_QUEUE_SIZE = 1000;
const PROCESS_INTERVAL_MS = 5000; // Process queue every 5 seconds

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
   * @param {string} event.eventType - Event type (e.g., 'face_mismatch', 'fullscreen_exit')
   * @param {Buffer} event.imageBuffer - Image data as buffer (optional)
   * @param {string} event.filename - Filename for image (optional)
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

    // Create deduplication key: sessionId_eventType
    // Since we don't have sessionId directly, use examId_batchId_candidateId as session identifier
    const sessionKey = `${examId}_${batchId}_${candidateId}`;
    const dedupKey = `${sessionKey}_${eventType}`;
    const now = Date.now();

    // Check if same event occurred recently (within 5 minutes)
    const lastEventTime = this.lastEventTimes.get(dedupKey);
    if (lastEventTime && (now - lastEventTime) < DEDUPLICATION_WINDOW_MS) {
      const remainingMs = DEDUPLICATION_WINDOW_MS - (now - lastEventTime);
      queueLogger.info('Event deduplicated - same event within 5 minutes', {
        eventType,
        examId,
        batchId,
        candidateId,
        lastEventTime: new Date(lastEventTime).toISOString(),
        remainingMs,
        remainingMinutes: Math.round(remainingMs / 1000 / 60 * 10) / 10,
      });
      return false; // Event deduplicated, not added to queue
    }

    // Update last event time
    this.lastEventTimes.set(dedupKey, now);

    // Clean up old entries from lastEventTimes (keep only last 1000 entries)
    if (this.lastEventTimes.size > 1000) {
      const entries = Array.from(this.lastEventTimes.entries());
      // Keep only entries from last hour
      const oneHourAgo = now - (60 * 60 * 1000);
      const recentEntries = entries.filter(([key, time]) => time > oneHourAgo);
      this.lastEventTimes = new Map(recentEntries);
    }

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
        const event = this.queue.shift();

        try {
          await this.processEvent(event);
        } catch (error) {
          queueLogger.error('Error processing event', {
            error: error.message,
            eventId: event.id,
            eventType: event.eventType,
            examId: event.examId,
            batchId: event.batchId,
            candidateId: event.candidateId,
          });
          // Continue processing other events even if one fails
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Process a single event
   * 1. Upload image to S3 (if image exists)
   * 2. Save flag session to backend DB
   */
  async processEvent(event) {
    const { examId, batchId, candidateId, eventType, imageBuffer, filename, metadata = {} } = event;

    queueLogger.info('Processing event', {
      eventId: event.id,
      eventType,
      examId,
      batchId,
      candidateId,
      hasImage: !!imageBuffer,
    });

    let imageUrl = null;
    let imageObjectKey = null;

    // Step 1: Upload image to S3 if image buffer exists
    if (imageBuffer && Buffer.isBuffer(imageBuffer)) {
      try {
        const uploadResult = await uploadDetectionImageToS3(
          imageBuffer,
          examId,
          batchId,
          candidateId,
          eventType,
          filename
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
        // Continue processing even if image upload fails
      }
    }

    // Step 2: Save flag session to backend DB
    try {
      await this.saveFlagSessionToBackend({
        examId,
        batchId,
        candidateId,
        eventType,
        imageUrl,
        imageObjectKey,
        metadata,
      });

      queueLogger.info('Flag session saved to backend', {
        eventId: event.id,
        eventType,
        examId,
        batchId,
        candidateId,
        imageUrl,
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
    }
  }

  /**
   * Save flag session to backend API
   */
  async saveFlagSessionToBackend({ examId, batchId, candidateId, eventType, imageUrl, imageObjectKey, metadata }) {
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
      screenshot_url: imageUrl || null, // Store S3 URL
      ai_analysis_data: JSON.stringify({
        ...metadata,
        image_object_key: imageObjectKey || null,
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

