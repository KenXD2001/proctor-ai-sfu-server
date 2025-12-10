/**
 * Service to upload recordings to S3 bucket (DigitalOcean Spaces)
 * Uploads recordings with structure: exam_name/batch_name/student_name/recording_type/filename
 */

const AWS = require('aws-sdk');
const fs = require('fs').promises;
const path = require('path');
const config = require('./config');
const { logger, createLogger } = require('./utils/logger');

const uploadLogger = createLogger('UploadService');

// Use node-fetch for HTTP requests
let fetch;
try {
  // Try built-in fetch first (Node.js 18+)
  if (typeof globalThis.fetch === 'function') {
    fetch = globalThis.fetch;
  } else {
    // Fallback to node-fetch
    fetch = require('node-fetch');
  }
} catch (error) {
  uploadLogger.warn('Fetch not available, using require', { error: error.message });
  fetch = require('node-fetch');
}

// S3 Configuration
const DO_REGION = process.env.DO_REGION || 'blr1';
const DO_SPACE = process.env.DO_SPACE || process.env.S3_BUCKET_NAME || 'aiproctor';
const DO_ENDPOINT = process.env.DO_ENDPOINT || `https://${DO_REGION}.digitaloceanspaces.com`;
const DO_ACCESS_KEY = process.env.DO_ACCESS_KEY;
const DO_SECRET_KEY = process.env.DO_SECRET_KEY;
const BACKEND_API_URL = process.env.BACKEND_API_URL;

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
  uploadLogger.info('S3 client initialized', { endpoint: DO_ENDPOINT, bucket: DO_SPACE });
} else {
  uploadLogger.warn('S3 credentials not configured, uploads will be disabled');
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
 * Get exam, batch, and student names from backend API
 * We'll get the names from the save-recording endpoint response
 * which fetches them from the database
 */
async function getNamesFromAPI(examId, batchId, candidateId) {
  // We'll fetch names when saving recording metadata
  // For S3 upload, we'll use IDs first, then update if we get names from the save response
  return {
    examName: sanitizeFilename(examId),
    batchName: sanitizeFilename(batchId || 'default'),
    studentName: sanitizeFilename(candidateId || 'unknown')
  };
}

/**
 * Upload recording file to S3
 */
async function uploadToS3(filePath, examId, batchId, candidateId, recordingType, filename) {
  if (!s3) {
    throw new Error('S3 client not configured. Please check environment variables.');
  }

  // Check if file exists
  try {
    await fs.access(filePath);
  } catch (error) {
    throw new Error(`File not found: ${filePath}`);
  }

  // Get file stats
  const stats = await fs.stat(filePath);
  const fileSize = stats.size;

  // Get names from API
  const names = await getNamesFromAPI(examId, batchId, candidateId);

  // Build S3 object key (new convention):
  // PROCTOR_AI/{examId}/{batchId}/{candidateId}/{recording_type}/{filename}
  // recording_type ∈ {screen_recordings, webcam_recordings}
  const sanitizedExamId = sanitizeFilename(examId || 'unknown');
  const sanitizedBatchId = sanitizeFilename(batchId || 'default');
  const sanitizedCandidateId = sanitizeFilename(candidateId || 'unknown');

  // Map recording types to new folder names
  let recordingFolder = 'unknown';
  if (recordingType === 'screen') {
    recordingFolder = 'screen_recordings';
  } else if (recordingType === 'webcam') {
    recordingFolder = 'webcam_recordings';
  } else {
    recordingFolder = sanitizeFilename(recordingType || 'unknown');
  }

  const objectKey = `PROCTOR_AI/${sanitizedExamId}/${sanitizedBatchId}/${sanitizedCandidateId}/${recordingFolder}/${filename}`;

  uploadLogger.info('Uploading recording to S3', {
    filePath,
    objectKey,
    fileSize,
    examName: names.examName,
    batchName: names.batchName,
    studentName: names.studentName,
    recordingType
  });

  // Read file and upload to S3
  const fileContent = await fs.readFile(filePath);

  const uploadParams = {
    Bucket: DO_SPACE,
    Key: objectKey,
    Body: fileContent,
    ACL: 'public-read',
    ContentType: 'video/webm',
  };

  try {
    await s3.putObject(uploadParams).promise();
    
    // Generate public URL
    const publicUrl = `https://${DO_SPACE}.${DO_REGION}.cdn.digitaloceanspaces.com/${objectKey}`;
    
    uploadLogger.info('Recording uploaded successfully', {
      objectKey,
      publicUrl,
      fileSize
    });

    return {
      url: publicUrl,
      objectKey,
      fileSize,
      examName: names.examName,
      batchName: names.batchName,
      studentName: names.studentName
    };
  } catch (error) {
    uploadLogger.error('Failed to upload recording to S3', {
      error: error.message,
      objectKey,
      filePath
    });
    throw error;
  }
}

/**
 * Save recording metadata to backend API
 */
async function saveRecordingMetadata(examId, batchId, candidateId, recordingType, videoUrl, metadata) {
  try {
    const params = new URLSearchParams({
      exam_id: examId,
      batch_id: batchId || 'none',
      candidate_id: candidateId,
    });
    
    const response = await fetch(
      `${BACKEND_API_URL}/api/exam-sessions/save-recording?${params.toString()}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recording_type: recordingType,
          video_url: videoUrl,
          recording_started_at: metadata.recordingStartedAt || new Date().toISOString(),
          recording_ended_at: metadata.recordingEndedAt || new Date().toISOString(),
          duration_seconds: metadata.durationSeconds,
          file_size_bytes: metadata.fileSizeBytes,
          upload_status: 'completed',
          exit_reason: metadata.exitReason || null,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to save recording metadata: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    uploadLogger.info('Recording metadata saved', {
      examId,
      batchId,
      candidateId,
      recordingId: data.recording_id,
      sessionId: data.session_id,
      recordingType
    });

    return data;
  } catch (error) {
    uploadLogger.error('Error saving recording metadata', {
      error: error.message,
      examId,
      batchId,
      candidateId,
      recordingType
    });
    throw error;
  }
}

/**
 * Upload recording and save metadata
 */
async function uploadAndSaveRecording(
  filePath,
  examId,
  batchId,
  candidateId,
  recordingType,
  metadata = {}
) {
  try {
    // Extract filename from path
    const filename = path.basename(filePath);

    // Upload to S3
    const uploadResult = await uploadToS3(
      filePath,
      examId,
      batchId,
      candidateId,
      recordingType,
      filename
    );

    // Save metadata to backend
    await saveRecordingMetadata(
      examId,
      batchId || null,
      candidateId,
      recordingType,
      uploadResult.url,
      {
        ...metadata,
        fileSizeBytes: uploadResult.fileSize,
      }
    );

    uploadLogger.info('Recording upload and save completed', {
      examId,
      batchId,
      candidateId,
      recordingType,
      url: uploadResult.url
    });

    return uploadResult;
  } catch (error) {
    uploadLogger.error('Failed to upload and save recording', {
      error: error.message,
      filePath,
      examId,
      batchId,
      candidateId,
      recordingType
    });
    throw error;
  }
}

module.exports = {
  uploadToS3,
  saveRecordingMetadata,
  uploadAndSaveRecording,
  getNamesFromAPI,
};

