/**
 * Custom error classes and error handling utilities
 */

const { logger } = require('./logger');

/**
 * Base error class for all custom errors
 */
class ProctorError extends Error {
  constructor(message, code, statusCode = 500) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.timestamp = new Date().toISOString();
    
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Authentication related errors
 */
class AuthenticationError extends ProctorError {
  constructor(message = 'Authentication failed') {
    super(message, 'AUTH_ERROR', 401);
  }
}

/**
 * Authorization related errors
 */
class AuthorizationError extends ProctorError {
  constructor(message = 'Access denied') {
    super(message, 'AUTHZ_ERROR', 403);
  }
}

/**
 * WebRTC related errors
 */
class WebRTCError extends ProctorError {
  constructor(message, code = 'WEBRTC_ERROR') {
    super(message, code, 400);
  }
}

/**
 * Recording related errors
 */
class RecordingError extends ProctorError {
  constructor(message, code = 'RECORDING_ERROR') {
    super(message, code, 500);
  }
}

/**
 * Room management errors
 */
class RoomError extends ProctorError {
  constructor(message, code = 'ROOM_ERROR') {
    super(message, code, 400);
  }
}

/**
 * Transport related errors
 */
class TransportError extends ProctorError {
  constructor(message, code = 'TRANSPORT_ERROR') {
    super(message, code, 400);
  }
}

/**
 * Error handler middleware for async functions
 */
const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * Socket error handler
 */
const socketErrorHandler = (socket, error, event = 'unknown') => {
  logger.error(`Socket error in ${event}`, {
    socketId: socket.id,
    userId: socket.userId,
    error: error.message,
    stack: error.stack,
  });

  if (error instanceof ProctorError) {
    socket.emit('error', {
      code: error.code,
      message: error.message,
      statusCode: error.statusCode,
    });
  } else {
    socket.emit('error', {
      code: 'INTERNAL_ERROR',
      message: 'An internal error occurred',
      statusCode: 500,
    });
  }
};

/**
 * Validation helper
 */
const validateRequired = (obj, requiredFields) => {
  const missing = requiredFields.filter(field => !obj[field]);
  if (missing.length > 0) {
    throw new ProctorError(
      `Missing required fields: ${missing.join(', ')}`,
      'VALIDATION_ERROR',
      400
    );
  }
};

/**
 * Role validation helper
 */
const validateRole = (userRole, targetRole) => {
  const { logger } = require('./logger');
  
  if (!userRole || !targetRole) {
    throw new AuthorizationError('Invalid role provided');
  }

  const hierarchy = {
    admin: ['invigilator', 'student'],
    invigilator: ['student'],
    student: [],
  };

  const allowedRoles = hierarchy[userRole] || [];
  if (!allowedRoles.includes(targetRole)) {
    logger.warn(`Role validation failed`, { userRole, targetRole });
    throw new AuthorizationError(`Role ${userRole} cannot access ${targetRole} content`);
  }

  return true;
};

module.exports = {
  ProctorError,
  AuthenticationError,
  AuthorizationError,
  WebRTCError,
  RecordingError,
  RoomError,
  TransportError,
  asyncHandler,
  socketErrorHandler,
  validateRequired,
  validateRole,
};
