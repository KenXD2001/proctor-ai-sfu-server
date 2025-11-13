/**
 * Configuration management for the ProctorAI SFU Server
 * Centralizes all configuration values and environment variables
 */

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const getEnv = (key, { required = false, defaultValue } = {}) => {
  const value = process.env[key];

  if (value === undefined || value === '') {
    if (required) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return defaultValue;
  }

  return value;
};

const getNumberEnv = (key, { required = false, defaultValue } = {}) => {
  const rawValue = getEnv(key, { required, defaultValue });

  if (rawValue === undefined) {
    return undefined;
  }

  const parsedValue = Number(rawValue);

  if (Number.isNaN(parsedValue)) {
    throw new Error(`Environment variable ${key} must be a number`);
  }

  return parsedValue;
};

const config = {
  // Server Configuration
  server: {
    port: getNumberEnv('PORT', { defaultValue: 3000 }),
    host: getEnv('HOST', { defaultValue: '0.0.0.0' }),
    cors: {
      origin: getEnv('CORS_ORIGIN', { defaultValue: '*' }),
      methods: ['GET', 'POST'],
      credentials: true,
    },
  },

  // JWT Configuration
  jwt: {
    secret: getEnv('JWT_SECRET', { required: true }),
  },

  // WebRTC Configuration
  webrtc: {
    listenIps: [
      {
        ip: getEnv('WEBRTC_LISTEN_IP', { defaultValue: '0.0.0.0' }),
        announcedIp: getEnv('WEBRTC_ANNOUNCED_IP', { required: true }),
      },
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  },

  // MediaSoup Configuration
  mediasoup: {
    worker: {
      logLevel: getEnv('MEDIASOUP_LOG_LEVEL', { defaultValue: 'warn' }),
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
      rtcMinPort: getNumberEnv('RTC_MIN_PORT', { defaultValue: 10000 }),
      rtcMaxPort: getNumberEnv('RTC_MAX_PORT', { defaultValue: 59999 }),
    },
    codecs: [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
      },
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {},
      },
    ],
  },

  // Recording Configuration
  recording: {
    basePath: getEnv('RECORDING_PATH', { defaultValue: 'recordings' }),
    ffmpeg: {
      timeout: 5000000,
      logLevel: 'error',
      flags: ['+genpts'], // Only valid FFmpeg flags
    },
    audio: {
      duration: 10, // seconds
      bitrate: '128k',
      sampleRate: 44100,
      channels: 2,
      codec: 'libmp3lame',
    },
    webcam: {
      quality: 2, // JPEG quality (1-31, lower is better)
      maxFrames: 1,
    },
  },

  // Timeout Configuration
  timeouts: {
    producerActive: 10000, // 10 seconds
    producerCheckInterval: 1000, // 1 second
    ffmpegInit: 1000, // 1 second
    transportStabilize: 2000, // 2 seconds
  },

  // Role-based Access Control
  roles: {
    hierarchy: {
      admin: ['invigilator'],
      invigilator: ['student'],
      student: [],
    },
  },

  // Logging Configuration
  logging: {
    level: getEnv('LOG_LEVEL', { defaultValue: 'info' }),
    enableTimestamps: true,
  },
};

module.exports = config;
