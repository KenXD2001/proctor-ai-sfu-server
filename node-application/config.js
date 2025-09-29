/**
 * Configuration management for the ProctorAI SFU Server
 * Centralizes all configuration values and environment variables
 */

const config = {
  // Server Configuration
  server: {
    port: process.env.PORT || 3000,
    host: process.env.HOST || '0.0.0.0',
    cors: {
      origin: process.env.CORS_ORIGIN || '*',
      methods: ['GET', 'POST'],
      credentials: true,
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
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  },

  // MediaSoup Configuration
  mediasoup: {
    worker: {
      logLevel: process.env.MEDIASOUP_LOG_LEVEL || 'warn',
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
      rtcMinPort: parseInt(process.env.RTC_MIN_PORT) || 10000,
      rtcMaxPort: parseInt(process.env.RTC_MAX_PORT) || 59999,
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
    basePath: process.env.RECORDING_PATH || 'recordings',
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
    level: process.env.LOG_LEVEL || 'info',
    enableTimestamps: true,
  },
};

module.exports = config;
