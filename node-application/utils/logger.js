/**
 * Professional logging utility with structured logging and different log levels
 */

const config = require('../config');

class Logger {
  constructor(context = '') {
    this.context = context;
    this.timestamp = config.logging.enableTimestamps;
  }

  _formatMessage(level, message, meta = {}) {
    const timestamp = this.timestamp ? `[${new Date().toISOString()}]` : '';
    const context = this.context ? `[${this.context}]` : '';
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    
    return `${timestamp}${context}[${level.toUpperCase()}] ${message}${metaStr}`;
  }

  _log(level, message, meta) {
    console.log(this._formatMessage(level, message, meta));
  }

  info(message, meta = {}) {
    this._log('info', message, meta);
  }

  warn(message, meta = {}) {
    this._log('warn', message, meta);
  }

  error(message, meta = {}) {
    this._log('error', message, meta);
  }

  debug(message, meta = {}) {
    if (config.logging.level === 'debug') {
      this._log('debug', message, meta);
    }
  }

  // Specialized logging methods for WebRTC events
  webrtc(event, data = {}) {
    this.info(`WebRTC: ${event}`, data);
  }

  room(event, roomId, data = {}) {
    this.info(`Room: ${event}`, { roomId, ...data });
  }

  transport(event, transportId, data = {}) {
    this.info(`Transport: ${event}`, { transportId, ...data });
  }

  producer(event, producerId, data = {}) {
    this.info(`Producer: ${event}`, { producerId, ...data });
  }

  consumer(event, consumerId, data = {}) {
    this.info(`Consumer: ${event}`, { consumerId, ...data });
  }

  recording(event, data = {}) {
    this.info(`Recording: ${event}`, data);
  }

  auth(event, data = {}) {
    this.info(`Auth: ${event}`, data);
  }
}

// Create default logger instance
const logger = new Logger();

// Create context-specific loggers
const createLogger = (context) => new Logger(context);

module.exports = { logger, createLogger, Logger };
