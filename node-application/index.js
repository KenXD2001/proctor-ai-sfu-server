/**
 * Professional ProctorAI SFU Server
 * Optimized Express server with Socket.IO and MediaSoup integration
 */

// Load environment variables from .env file
// Look for .env in parent directory (proctor-ai-sfu-server/.env) or current directory
const path = require('path');
const fs = require('fs');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
} else {
  require('dotenv').config();
}

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

class ProctorAIServer {
  constructor() {
    this.app = express();
    this.server = null;
    this.io = null;
    this.isShuttingDown = false;
    
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

    // Detection frame upload endpoint - Uses queue system with S3 upload
    this.app.post('/api/detection/upload-frame', asyncHandler(async (req, res) => {
      const { examId, batchId, candidateId, violationType, frameData } = req.body;

      if (!examId || !batchId || !candidateId || !violationType || !frameData) {
        return res.status(400).json({
          error: 'Missing required fields: examId, batchId, candidateId, violationType, frameData'
        });
      }

      try {
        // Generate filename with date format: {violationType}_2025_11_17_12_23_50.webp
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        const dateStr = `${year}_${month}_${day}_${hours}_${minutes}_${seconds}`;
        const filename = `${violationType}_${dateStr}.webp`;

        // Convert base64 to buffer
        const buffer = Buffer.from(frameData, 'base64');

        // Add event to queue (will handle S3 upload and DB save with deduplication)
        const { eventQueue } = require('./eventQueue');
        const added = await eventQueue.enqueue({
          examId,
          batchId,
          candidateId,
          eventType: violationType,
          imageBuffer: buffer,
          filename,
          metadata: {
            original_filename: filename,
            uploaded_via: 'upload-frame-endpoint',
          },
        });

        if (!added) {
          // Event was deduplicated (same event within 5 minutes)
          return res.json({
            success: true,
            message: 'Event deduplicated - same event occurred recently',
            deduplicated: true,
            violationType,
            timestamp: now.toISOString(),
          });
        }

        appLogger.info('Detection frame queued for processing', {
          violationType,
          examId,
          batchId,
          candidateId,
          filename,
          size: buffer.length,
        });

        // Return success immediately (async processing will happen in queue)
        res.json({
          success: true,
          message: 'Frame queued for upload to S3 and database save',
          queued: true,
          violationType,
          timestamp: now.toISOString(),
        });
      } catch (error) {
        appLogger.error('Error queuing detection frame', {
          error: error.message,
          examId,
          batchId,
          candidateId,
          violationType
        });
        throw error;
      }
    }));

    // 404 handler - catch all unmatched routes
    this.app.use((req, res) => {
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