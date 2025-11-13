/**
 * Professional ProctorAI SFU Server
 * Optimized Express server with Socket.IO and MediaSoup integration
 */

const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");

// Load environment variables from repository root
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const express = require("express");
const http = require("http");
const cors = require("cors");
const socketIO = require("socket.io");
const config = require('./config');
const { logger, createLogger } = require('./utils/logger');
const { asyncHandler } = require('./utils/errors');
const { startSocketServer } = require("./socketServer");
const { mediaSoupManager } = require('./mediasoupServer');

const appLogger = createLogger('App');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const FACE_EVIDENCE_DIR = path.join(PUBLIC_DIR, 'face-detection');
const NOISE_EVIDENCE_DIR = path.join(PUBLIC_DIR, 'noise-detection');

const ensureDirSync = (directory) => {
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch (error) {
    appLogger.error('Failed to ensure directory', { directory, error: error.message });
    throw error;
  }
};

const sanitizeSegment = (value, fallback = 'unknown') => {
  const segment = String(value ?? '').trim();
  if (!segment) {
    return fallback;
  }
  return segment.replace(/[^a-z0-9_-]/gi, '_').slice(0, 48) || fallback;
};

const decodeBase64Data = (data) => {
  if (typeof data !== 'string' || !data) {
    return null;
  }
  const trimmed = data.trim();
  const cleaned = trimmed.replace(/^data:[^;]+;base64,/, '');
  try {
    return Buffer.from(cleaned, 'base64');
  } catch (error) {
    appLogger.warn('Failed to decode base64 payload', { error: error.message });
    return null;
  }
};

const guessImageExtension = (mimeType = '') => {
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  return 'webp';
};

const guessAudioExtension = (mimeType = '') => {
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mp3')) return 'mp3';
  if (mimeType.includes('wav')) return 'wav';
  return 'webm';
};

ensureDirSync(PUBLIC_DIR);
ensureDirSync(FACE_EVIDENCE_DIR);
ensureDirSync(NOISE_EVIDENCE_DIR);

class ProctorAIServer {
  constructor() {
    this.app = express();
    this.server = null;
    this.io = null;
    this.isShuttingDown = false;
    this.publicDir = PUBLIC_DIR;
    this.faceEvidenceDir = FACE_EVIDENCE_DIR;
    this.noiseEvidenceDir = NOISE_EVIDENCE_DIR;
    
    this.setupMiddleware();
    this.setupRoutes();
    this.setupSocketIO();
    this.setupGracefulShutdown();
  }

  /**
   * Setup Express middleware
   */
  setupMiddleware() {
    // CORS configuration
    this.app.use(cors(config.server.cors));
    
    // JSON parsing with size limit
    this.app.use(express.json({ limit: '10mb' }));

    // Serve stored evidence assets
    this.app.use(
      '/public',
      express.static(this.publicDir, {
        maxAge: '1d',
        extensions: ['jpg', 'jpeg', 'webp', 'png', 'webm', 'ogg', 'mp3', 'wav'],
      })
    );
    
    // Request logging
    this.app.use((req, res, next) => {
      appLogger.debug('HTTP request', {
        method: req.method,
        url: req.url,
        userAgent: req.get('User-Agent'),
        ip: req.ip
      });
      next();
    });
  }

  /**
   * Setup API routes
   */
  setupRoutes() {
    // Health check endpoint
    this.app.get('/health', asyncHandler(async (req, res) => {
      const stats = mediaSoupManager.getStats();
      
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'proctor-ai-sfu-server',
        version: process.env.npm_package_version || '1.0.0',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        stats
      });
    }));

    // Server statistics endpoint
    this.app.get('/stats', asyncHandler(async (req, res) => {
      const stats = mediaSoupManager.getStats();
      res.json({
        timestamp: new Date().toISOString(),
        server: {
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          cpu: process.cpuUsage(),
        },
        mediasoup: stats,
        config: {
          webrtc: config.webrtc,
          recording: config.recording,
          roles: config.roles,
        }
      });
    }));

    // Room information endpoint
    this.app.get('/rooms', asyncHandler(async (req, res) => {
      const rooms = mediaSoupManager.getRooms();
      const roomInfo = Array.from(rooms.entries()).map(([roomId, room]) => ({
        id: roomId,
        peers: room.peers.size,
        createdAt: room.createdAt,
        lastActivity: room.lastActivity,
        routerId: room.router.id,
      }));

      res.json({
        timestamp: new Date().toISOString(),
        totalRooms: rooms.size,
        rooms: roomInfo
      });
    }));

    // Store face evidence images
    this.app.post('/api/face-events', asyncHandler(async (req, res) => {
      const {
        userId,
        examRoomId,
        type = 'face_event',
        timestamp = Date.now(),
        meta = {},
        data,
        mimeType = 'image/webp',
      } = req.body || {};

      if (!data) {
        return res.status(400).json({ error: 'Missing image data' });
      }

      const buffer = decodeBase64Data(data);
      if (!buffer || buffer.length === 0) {
        return res.status(400).json({ error: 'Invalid image payload' });
      }

      const extension = guessImageExtension(mimeType);
      const safeUser = sanitizeSegment(userId, 'unknown');
      const safeRoom = sanitizeSegment(examRoomId, 'room');
      const safeType = sanitizeSegment(type, 'event');
      const safeTimestamp = Number.isFinite(Number(timestamp))
        ? Number(timestamp)
        : Date.now();

      const fileName = `${safeUser}_${safeRoom}_${safeType}_${safeTimestamp}.${extension}`;
      const filePath = path.join(this.faceEvidenceDir, fileName);

      await fsp.writeFile(filePath, buffer);

      appLogger.info('Stored face evidence', {
        userId: safeUser,
        roomId: safeRoom,
        type: safeType,
        fileName,
        size: buffer.length,
      });

      res.json({
        success: true,
        file: `/public/face-detection/${fileName}`,
        meta,
      });
    }));

    // Store noise evidence audio clips
    this.app.post('/api/noise-events', asyncHandler(async (req, res) => {
      const {
        userId,
        examRoomId,
        timestamp = Date.now(),
        meta = {},
        data,
        mimeType = 'audio/webm',
      } = req.body || {};

      if (!data) {
        return res.status(400).json({ error: 'Missing audio data' });
      }

      const buffer = decodeBase64Data(data);
      if (!buffer || buffer.length === 0) {
        return res.status(400).json({ error: 'Invalid audio payload' });
      }

      const extension = guessAudioExtension(mimeType);
      const safeUser = sanitizeSegment(userId, 'unknown');
      const safeRoom = sanitizeSegment(examRoomId, 'room');
      const safeTimestamp = Number.isFinite(Number(timestamp))
        ? Number(timestamp)
        : Date.now();

      const fileName = `${safeUser}_${safeRoom}_noise_${safeTimestamp}.${extension}`;
      const filePath = path.join(this.noiseEvidenceDir, fileName);

      await fsp.writeFile(filePath, buffer);

      appLogger.info('Stored noise evidence', {
        userId: safeUser,
        roomId: safeRoom,
        fileName,
        size: buffer.length,
      });

      res.json({
        success: true,
        file: `/public/noise-detection/${fileName}`,
        meta,
      });
    }));

    // 404 handler
    this.app.use('*', (req, res) => {
      res.status(404).json({
        error: 'Not found',
        path: req.originalUrl,
        timestamp: new Date().toISOString()
      });
    });

    // Global error handler
    this.app.use((error, req, res, next) => {
      appLogger.error('Express error', {
        error: error.message,
        stack: error.stack,
        url: req.url,
        method: req.method
      });

      res.status(error.statusCode || 500).json({
        error: error.message || 'Internal server error',
        timestamp: new Date().toISOString()
      });
    });
  }

  /**
   * Setup Socket.IO server
   */
  setupSocketIO() {
    this.server = http.createServer(this.app);
    
    this.io = socketIO(this.server, {
      cors: config.server.cors,
      transports: ['websocket', 'polling'],
      pingTimeout: 60000,
      pingInterval: 25000,
      maxHttpBufferSize: 1e8, // 100MB
    });

    // Initialize Socket.IO handlers
    startSocketServer(this.io);

    // Socket.IO connection logging
    this.io.on('connection', (socket) => {
      appLogger.info('Socket.IO connection established', {
        socketId: socket.id,
        totalConnections: this.io.engine.clientsCount
      });

      socket.on('disconnect', (reason) => {
        appLogger.info('Socket.IO connection closed', {
          socketId: socket.id,
          reason,
          totalConnections: this.io.engine.clientsCount
        });
      });
    });

    // Socket.IO error handling
    this.io.on('error', (error) => {
      appLogger.error('Socket.IO error', { error: error.message });
    });
  }

  /**
   * Setup graceful shutdown handlers
   */
  setupGracefulShutdown() {
    const shutdown = async (signal) => {
      if (this.isShuttingDown) return;
      
      this.isShuttingDown = true;
      appLogger.info(`Received ${signal}, starting graceful shutdown`);

      try {
        // Stop accepting new connections
        if (this.server) {
          this.server.close(() => {
            appLogger.info('HTTP server closed');
          });
        }

        // Close Socket.IO server
        if (this.io) {
          this.io.close(() => {
            appLogger.info('Socket.IO server closed');
          });
        }

        // Shutdown MediaSoup manager
        await mediaSoupManager.shutdown();

        appLogger.info('Graceful shutdown completed');
        process.exit(0);
    
  } catch (error) {
        appLogger.error('Error during shutdown', { error: error.message });
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    
    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      appLogger.error('Uncaught exception', { error: error.message, stack: error.stack });
      shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
      appLogger.error('Unhandled rejection', { reason, promise });
      shutdown('unhandledRejection');
    });
  }

  /**
   * Start the server
   */
  async start() {
    return new Promise((resolve, reject) => {
      try {
        this.server.listen(config.server.port, config.server.host, () => {
          appLogger.info('ProctorAI SFU Server started', {
            port: config.server.port,
            host: config.server.host,
            nodeVersion: process.version,
            pid: process.pid
          });
          resolve();
        });

        this.server.on('error', (error) => {
          appLogger.error('Server startup error', { error: error.message });
          reject(error);
        });
    
  } catch (error) {
        appLogger.error('Failed to start server', { error: error.message });
        reject(error);
      }
    });
  }

  /**
   * Get server instance for testing
   */
  getServer() {
    return {
      app: this.app,
      server: this.server,
      io: this.io
    };
  }
}

// Create and start server
const server = new ProctorAIServer();

// Start server if this file is run directly
if (require.main === module) {
  server.start().catch((error) => {
    appLogger.error('Failed to start ProctorAI SFU Server', { error: error.message });
    process.exit(1);
  });
}

module.exports = { ProctorAIServer, server };