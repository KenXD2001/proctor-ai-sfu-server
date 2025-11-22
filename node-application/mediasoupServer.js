/**
 * MediaSoup server management with optimized worker and room handling
 */

const mediasoup = require("mediasoup");
const config = require('./config');
const { logger } = require('./utils/logger');
const { RoomError } = require('./utils/errors');

class MediaSoupManager {
  constructor() {
    this.worker = null;
    this.rooms = new Map();
    this.isShuttingDown = false;
  }

  /**
   * Create or get existing MediaSoup worker
   * @returns {Promise<Object>} MediaSoup worker instance
   */
  async createWorker() {
    if (!this.worker && !this.isShuttingDown) {
      try {
        this.worker = await mediasoup.createWorker(config.mediasoup.worker);
        logger.info('MediaSoup worker created', {
          pid: this.worker.pid,
          rtcPortRange: `${config.mediasoup.worker.rtcMinPort}-${config.mediasoup.worker.rtcMaxPort}`
        });
        
        // Handle worker events
        this.worker.on('died', (error) => {
          logger.error('MediaSoup worker died', { error: error.message });
          this.worker = null;
          
          // Attempt to restart worker if not shutting down
          if (!this.isShuttingDown) {
            logger.info('Attempting to restart MediaSoup worker');
            setTimeout(() => this.createWorker(), 1000);
          }
        });

        // Graceful shutdown handler
        process.on('SIGTERM', () => this.shutdown());
        process.on('SIGINT', () => this.shutdown());
        
      } catch (error) {
        logger.error('Failed to create MediaSoup worker', { error: error.message });
        throw error;
      }
    }
    
    if (!this.worker) {
      throw new RoomError('MediaSoup worker is not available');
    }
    
    return this.worker;
  }

  /**
   * Create a new router with media codecs
   * @param {Array} mediaCodecs - Media codecs configuration
   * @returns {Promise<Object>} MediaSoup router instance
   */
  async createRouter(mediaCodecs = config.mediasoup.codecs) {
    try {
      const worker = await this.createWorker();
      const router = await worker.createRouter({ mediaCodecs });
      
      logger.info('Router created', {
        routerId: router.id,
        codecs: mediaCodecs.length
      });
      
      return router;
    } catch (error) {
      logger.error('Failed to create router', { error: error.message });
      throw new RoomError(`Failed to create router: ${error.message}`);
    }
  }

  /**
   * Get the rooms map
   * @returns {Map} Rooms map
   */
  getRooms() {
    return this.rooms;
  }

  /**
   * Find room ID by socket
   * @param {Object} socket - Socket.IO socket instance
   * @returns {string|null} Room ID or null if not found
   */
  findRoomId(socket) {
    for (const [roomId, room] of this.rooms.entries()) {
      if (room.peers.has(socket.id)) {
        return roomId;
      }
    }
    return null;
  }

  /**
   * Create a new room
   * @param {string} roomId - Room identifier
   * @returns {Promise<Object>} Room object
   */
  async createRoom(roomId) {
    if (this.rooms.has(roomId)) {
      throw new RoomError(`Room ${roomId} already exists`);
    }

    try {
      const router = await this.createRouter();
      const room = {
        id: roomId,
        router,
        peers: new Map(),
        createdAt: new Date(),
        lastActivity: new Date(),
      };

      this.rooms.set(roomId, room);
      logger.room('created', roomId, {
        routerId: router.id,
        totalRooms: this.rooms.size
      });

      return room;
    } catch (error) {
      logger.error('Failed to create room', { roomId, error: error.message });
      throw new RoomError(`Failed to create room: ${error.message}`);
    }
  }

  /**
   * Get room by ID
   * @param {string} roomId - Room identifier
   * @returns {Object|null} Room object or null if not found
   */
  getRoom(roomId) {
    return this.rooms.get(roomId) || null;
  }

  /**
   * Delete room if empty
   * @param {string} roomId - Room identifier
   * @returns {boolean} True if room was deleted
   */
  deleteRoomIfEmpty(roomId) {
    const room = this.rooms.get(roomId);
    if (room && room.peers.size === 0) {
      room.router.close();
      this.rooms.delete(roomId);
      logger.room('deleted', roomId, { totalRooms: this.rooms.size });
      return true;
    }
    return false;
  }

  /**
   * Update room last activity
   * @param {string} roomId - Room identifier
   */
  updateRoomActivity(roomId) {
    const room = this.rooms.get(roomId);
    if (room) {
      room.lastActivity = new Date();
    }
  }

  /**
   * Get room statistics
   * @returns {Object} Room statistics
   */
  getStats() {
    const stats = {
      totalRooms: this.rooms.size,
      totalPeers: 0,
      workerPid: this.worker?.pid || null,
      uptime: process.uptime(),
    };

    for (const room of this.rooms.values()) {
      stats.totalPeers += room.peers.size;
    }

    return stats;
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    if (this.isShuttingDown) return;
    
    this.isShuttingDown = true;
    logger.info('Shutting down MediaSoup manager');

    // Close all rooms
    for (const [roomId, room] of this.rooms.entries()) {
      try {
        room.router.close();
        logger.room('closed', roomId);
      } catch (error) {
        logger.error('Error closing room', { roomId, error: error.message });
      }
    }

    this.rooms.clear();

    // Close worker
    if (this.worker) {
      try {
        this.worker.close();
        logger.info('MediaSoup worker closed');
      } catch (error) {
        logger.error('Error closing worker', { error: error.message });
      }
    }
  }
}

// Create singleton instance
const mediaSoupManager = new MediaSoupManager();

// Legacy function exports for backward compatibility
const createWorker = () => mediaSoupManager.createWorker();
const createRouter = (mediaCodecs) => mediaSoupManager.createRouter(mediaCodecs);
const getRooms = () => mediaSoupManager.getRooms();
const findRoomId = (socket) => mediaSoupManager.findRoomId(socket);

module.exports = {
  mediaSoupManager,
  createWorker,
  createRouter,
  getRooms,
  findRoomId,
};
