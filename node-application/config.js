/**
 * Configuration management for the ProctorAI SFU Server
 * Centralizes all configuration values and environment variables
 * All hardcoded values have been moved to .env file
 */

// Helper function to parse boolean from environment variable
function parseBoolean(value, defaultValue) {
  if (value === undefined || value === '') return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

// Helper function to parse array from environment variable
function parseArray(value, defaultValue) {
  if (!value) return defaultValue;
  return value.split(',').map(item => item.trim());
}

const config = {
  // Server Configuration
  server: {
    port: parseInt(process.env.PORT) || 3000,
    host: process.env.HOST || '0.0.0.0',
    cors: {
      origin: process.env.CORS_ORIGIN || '*',
      methods: parseArray(process.env.CORS_METHODS, ['GET', 'POST']),
      credentials: parseBoolean(process.env.CORS_CREDENTIALS, true),
    },
  },

  // JWT Configuration
  jwt: {
    secret: process.env.JWT_SECRET || 'supersecret',
  },

  // WebRTC Configuration
  webrtc: {
    listenIps: [
      { 
        ip: process.env.WEBRTC_LISTEN_IP || '0.0.0.0', 
        announcedIp: process.env.WEBRTC_ANNOUNCED_IP || '192.168.137.89' 
      }
    ],
    enableUdp: parseBoolean(process.env.WEBRTC_ENABLE_UDP, true),
    enableTcp: parseBoolean(process.env.WEBRTC_ENABLE_TCP, true),
    preferUdp: parseBoolean(process.env.WEBRTC_PREFER_UDP, true),
  },

  // MediaSoup Configuration
  mediasoup: {
    worker: {
      logLevel: process.env.MEDIASOUP_LOG_LEVEL || 'warn',
      logTags: parseArray(process.env.MEDIASOUP_LOG_TAGS, ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp']),
      rtcMinPort: parseInt(process.env.RTC_MIN_PORT) || 10000,
      rtcMaxPort: parseInt(process.env.RTC_MAX_PORT) || 59999,
    },
    codecs: [
      {
        kind: 'audio',
        mimeType: process.env.MEDIASOUP_AUDIO_CODEC || 'audio/opus',
        clockRate: parseInt(process.env.MEDIASOUP_AUDIO_CLOCK_RATE) || 48000,
        channels: parseInt(process.env.MEDIASOUP_AUDIO_CHANNELS) || 2,
      },
      {
        kind: 'video',
        mimeType: process.env.MEDIASOUP_VIDEO_CODEC || 'video/VP8',
        clockRate: parseInt(process.env.MEDIASOUP_VIDEO_CLOCK_RATE) || 90000,
        parameters: {},
      },
    ],
  },

  // Recording Configuration
  recording: {
    basePath: process.env.RECORDING_PATH || 'recordings',
    recorderIp: process.env.RECORDING_IP || '127.0.0.1',
    ffmpegPortOffset: parseInt(process.env.RECORDING_FFMPEG_PORT_OFFSET) || 10000,
    ffmpeg: {
      timeout: parseInt(process.env.RECORDING_FFMPEG_TIMEOUT) || 5000000,
      logLevel: process.env.RECORDING_FFMPEG_LOG_LEVEL || 'error',
      flags: parseArray(process.env.RECORDING_FFMPEG_FLAGS, ['+genpts']),
    },
    audio: {
      duration: parseInt(process.env.RECORDING_AUDIO_DURATION) || 10, // seconds
      bitrate: process.env.RECORDING_AUDIO_BITRATE || '128k',
      sampleRate: parseInt(process.env.RECORDING_AUDIO_SAMPLE_RATE) || 44100,
      channels: parseInt(process.env.RECORDING_AUDIO_CHANNELS) || 2,
      codec: process.env.RECORDING_AUDIO_CODEC || 'libmp3lame',
    },
    webcam: {
      quality: parseInt(process.env.RECORDING_WEBCAM_QUALITY) || 2, // JPEG quality (1-31, lower is better)
      maxFrames: parseInt(process.env.RECORDING_WEBCAM_MAX_FRAMES) || 1,
    },
  },

  // Timeout Configuration
  timeouts: {
    producerActive: parseInt(process.env.TIMEOUT_PRODUCER_ACTIVE) || 10000, // 10 seconds
    producerCheckInterval: parseInt(process.env.TIMEOUT_PRODUCER_CHECK_INTERVAL) || 1000, // 1 second
    ffmpegInit: parseInt(process.env.TIMEOUT_FFMPEG_INIT) || 1000, // 1 second
    transportStabilize: parseInt(process.env.TIMEOUT_TRANSPORT_STABILIZE) || 2000, // 2 seconds
  },

  // Role-based Access Control
  roles: {
    hierarchy: {
      admin: parseArray(process.env.ROLE_ADMIN_CAN_ACCESS, ['invigilator']),
      invigilator: parseArray(process.env.ROLE_INVIGILATOR_CAN_ACCESS, ['student']),
      student: parseArray(process.env.ROLE_STUDENT_CAN_ACCESS, []),
    },
  },

  // Logging Configuration
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    enableTimestamps: parseBoolean(process.env.LOG_ENABLE_TIMESTAMPS, true),
  },
};

module.exports = config;
