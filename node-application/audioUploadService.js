/**
 * Service to upload detection audio clips to S3 bucket (DigitalOcean Spaces)
 * Handles audio uploads for detection events (noise, speech violations)
 */

const AWS = require('aws-sdk');
const path = require('path');
const { logger, createLogger } = require('./utils/logger');

const audioUploadLogger = createLogger('AudioUploadService');

// S3 Configuration
const DO_REGION = process.env.DO_REGION || 'blr1';
const DO_SPACE = process.env.DO_SPACE || process.env.S3_BUCKET_NAME || 'aiproctor';
const DO_ENDPOINT = process.env.DO_ENDPOINT || `https://${DO_REGION}.digitaloceanspaces.com`;
const DO_ACCESS_KEY = process.env.DO_ACCESS_KEY;
const DO_SECRET_KEY = process.env.DO_SECRET_KEY;
const DO_CDN_URL = process.env.DO_CDN_URL || `https://${DO_SPACE}.${DO_REGION}.cdn.digitaloceanspaces.com`;

// Initialize S3 client
let s3 = null;
if (DO_ACCESS_KEY && DO_SECRET_KEY) {
  const s3Config = {
    endpoint: DO_ENDPOINT,
    accessKeyId: DO_ACCESS_KEY,
    secretAccessKey: DO_SECRET_KEY,
    region: DO_REGION,
    s3ForcePathStyle: false,
    signatureVersion: 'v4',
  };
  
  s3 = new AWS.S3(s3Config);
  audioUploadLogger.info('S3 client initialized for audio uploads', { endpoint: DO_ENDPOINT, bucket: DO_SPACE });
} else {
  audioUploadLogger.warn('S3 credentials not configured, audio uploads will be disabled');
}

/**
 * Sanitize filename for safe use in S3 paths
 */
function sanitizeFilename(name) {
  if (!name) return 'unknown';
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/**
 * Upload detection audio buffer to S3
 * @param {Buffer} audioBuffer - Audio data as buffer
 * @param {string} examId - Exam ID
 * @param {string} batchId - Batch ID
 * @param {string} candidateId - Candidate/Student ID
 * @param {string} eventType - Event type (e.g., 'noise', 'speech')
 * @param {string} filename - Filename (optional, will be generated if not provided)
 * @param {string} mimeType - MIME type (e.g., 'audio/webm', 'audio/webm;codecs=opus')
 * @returns {Promise<{url: string, objectKey: string, fileSize: number}>}
 */
async function uploadDetectionAudioToS3(audioBuffer, examId, batchId, candidateId, eventType, filename = null, mimeType = 'audio/webm') {
  if (!s3) {
    throw new Error('S3 client not configured. Please check environment variables.');
  }

  if (!audioBuffer || !Buffer.isBuffer(audioBuffer)) {
    throw new Error('Invalid audio buffer provided');
  }

  // Generate filename if not provided
  if (!filename) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const dateStr = `${year}_${month}_${day}_${hours}_${minutes}_${seconds}`;
    
    // Determine extension based on mimeType
    let extension = 'webm';
    if (mimeType) {
      if (mimeType.includes('webm')) {
        extension = 'webm';
      } else if (mimeType.includes('mp4')) {
        extension = 'mp4';
      } else if (mimeType.includes('wav')) {
        extension = 'wav';
      } else if (mimeType.includes('ogg')) {
        extension = 'ogg';
      }
    }
    
    filename = `${eventType}_detected_${dateStr}.${extension}`;
  }

  // Build S3 object key (new convention):
  // PROCTOR_AI/{examId}/{batchId}/{candidateId}/detection/noise/{eventType}/{filename}
  const sanitizedExamId = sanitizeFilename(examId || 'unknown');
  const sanitizedBatchId = sanitizeFilename(batchId || 'default');
  const sanitizedCandidateId = sanitizeFilename(candidateId || 'unknown');
  const sanitizedEventType = sanitizeFilename(eventType || 'unknown');
  const sanitizedFilename = sanitizeFilename(filename);

  const objectKey = `PROCTOR_AI/${sanitizedExamId}/${sanitizedBatchId}/${sanitizedCandidateId}/detection/noise/${sanitizedEventType}/${sanitizedFilename}`;

  // Determine content type based on mimeType or filename extension
  let contentType = mimeType || 'audio/webm';
  const ext = path.extname(filename).toLowerCase();
  if (!mimeType || mimeType === 'audio/webm') {
    if (ext === '.webm') {
      contentType = 'audio/webm';
    } else if (ext === '.mp4') {
      contentType = 'audio/mp4';
    } else if (ext === '.wav') {
      contentType = 'audio/wav';
    } else if (ext === '.ogg') {
      contentType = 'audio/ogg';
    }
  }

  try {
    // Upload to S3
    const uploadParams = {
      Bucket: DO_SPACE,
      Key: objectKey,
      Body: audioBuffer,
      ContentType: contentType,
      ACL: 'public-read', // Make audio files publicly accessible
      Metadata: {
        'exam-id': examId || '',
        'batch-id': batchId || '',
        'candidate-id': candidateId || '',
        'event-type': eventType || '',
        'uploaded-at': new Date().toISOString(),
      },
    };

    const uploadResult = await s3.upload(uploadParams).promise();

    // Generate CDN URL
    const cdnUrl = `${DO_CDN_URL}/${objectKey}`;

    audioUploadLogger.info('Detection audio uploaded to S3', {
      objectKey,
      url: cdnUrl,
      fileSize: audioBuffer.length,
      eventType,
      examId,
      batchId,
      candidateId,
      contentType,
    });

    return {
      url: cdnUrl,
      objectKey,
      fileSize: audioBuffer.length,
      contentType,
      etag: uploadResult.ETag,
    };
  } catch (error) {
    audioUploadLogger.error('Error uploading detection audio to S3', {
      error: error.message,
      objectKey,
      eventType,
      examId,
      batchId,
      candidateId,
    });
    throw error;
  }
}

module.exports = {
  uploadDetectionAudioToS3,
  DO_CDN_URL,
};

