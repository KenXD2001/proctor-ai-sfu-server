/**
 * Service to upload detection images to S3 bucket (DigitalOcean Spaces)
 * Handles image uploads for detection events (face_mismatch, fullscreen_exit, etc.)
 */

const AWS = require('aws-sdk');
const path = require('path');
const { logger, createLogger } = require('./utils/logger');

const imageUploadLogger = createLogger('ImageUploadService');

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
  imageUploadLogger.info('S3 client initialized for image uploads', { endpoint: DO_ENDPOINT, bucket: DO_SPACE });
} else {
  imageUploadLogger.warn('S3 credentials not configured, image uploads will be disabled');
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
 * Upload detection image buffer to S3
 * @param {Buffer} imageBuffer - Image data as buffer
 * @param {string} examId - Exam ID
 * @param {string} batchId - Batch ID
 * @param {string} candidateId - Candidate/Student ID
 * @param {string} eventType - Event type (e.g., 'face_mismatch', 'fullscreen_exit')
 * @param {string} filename - Filename (optional, will be generated if not provided)
 * @returns {Promise<{url: string, objectKey: string, fileSize: number}>}
 */
async function uploadDetectionImageToS3(imageBuffer, examId, batchId, candidateId, eventType, filename = null) {
  if (!s3) {
    throw new Error('S3 client not configured. Please check environment variables.');
  }

  if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
    throw new Error('Invalid image buffer provided');
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
    filename = `${eventType}_${dateStr}.webp`;
  }

  // Build S3 object key (new convention):
  // PROCTOR_AI/{examId}/{batchId}/{candidateId}/detection/webcam/{eventType}/{filename}
  const sanitizedExamId = sanitizeFilename(examId || 'unknown');
  const sanitizedBatchId = sanitizeFilename(batchId || 'default');
  const sanitizedCandidateId = sanitizeFilename(candidateId || 'unknown');
  const sanitizedEventType = sanitizeFilename(eventType || 'unknown');
  const sanitizedFilename = sanitizeFilename(filename);

  const objectKey = `PROCTOR_AI/${sanitizedExamId}/${sanitizedBatchId}/${sanitizedCandidateId}/detection/webcam/${sanitizedEventType}/${sanitizedFilename}`;

  // Determine content type based on filename extension
  let contentType = 'image/webp'; // default
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') {
    contentType = 'image/jpeg';
  } else if (ext === '.png') {
    contentType = 'image/png';
  } else if (ext === '.webp') {
    contentType = 'image/webp';
  }

  try {
    // Upload to S3
    const uploadParams = {
      Bucket: DO_SPACE,
      Key: objectKey,
      Body: imageBuffer,
      ContentType: contentType,
      ACL: 'public-read', // Make images publicly accessible
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

    imageUploadLogger.info('Detection image uploaded to S3', {
      objectKey,
      url: cdnUrl,
      fileSize: imageBuffer.length,
      eventType,
      examId,
      batchId,
      candidateId,
    });

    return {
      url: cdnUrl,
      objectKey,
      fileSize: imageBuffer.length,
      contentType,
      etag: uploadResult.ETag,
    };
  } catch (error) {
    imageUploadLogger.error('Error uploading detection image to S3', {
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
  uploadDetectionImageToS3,
  DO_CDN_URL,
};




