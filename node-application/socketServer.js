/**
 * Professional Socket.IO server for mediasoup WebRTC communication
 * Optimized with proper error handling, role-based access control, and resource management
 */

const jwt = require("jsonwebtoken");
const path = require("path");
const config = require('./config');
const { logger, createLogger } = require('./utils/logger');
const { 
  AuthenticationError, 
  AuthorizationError, 
  WebRTCError, 
  RoomError,
  TransportError,
  socketErrorHandler,
  validateRequired,
  validateRole 
} = require('./utils/errors');
const { mediaSoupManager } = require('./mediasoupServer');
const { createConsumerAndRecord, createWebcamRecording, createAudioRecording } = require('./recorder');

const socketLogger = createLogger('SocketServer');

/**
 * Authentication middleware for Socket.IO
 */
function authenticateSocket(socket, next) {
  try {
    const token = socket.handshake.auth.token;
    if (!token) {
      throw new AuthenticationError('No token provided');
    }

    const decoded = jwt.verify(token, config.jwt.secret);
    socket.userId = decoded.user_id;
    socket.userRole = decoded.role || 'student'; // Default role
    
    socketLogger.auth('authenticated', {
      socketId: socket.id,
      userId: socket.userId,
      role: socket.userRole
    });
    
    next();
  } catch (error) {
    socketLogger.auth('failed', {
      socketId: socket.id,
      error: error.message
    });
    next(new AuthenticationError('Invalid token'));
  }
}

/**
 * Get room and peer with validation
 */
function getRoomAndPeer(socket, roomId = null) {
  const rooms = mediaSoupManager.getRooms();
  const room = roomId ? rooms.get(roomId) : [...rooms.values()].find(r => r.peers.has(socket.id));
  
  if (!room) {
    throw new RoomError('Room not found');
  }
  
  const peer = room.peers.get(socket.id);
  if (!peer) {
    throw new RoomError('Peer not found in room');
  }
  
  return { room, peer };
}

/**
 * Validate role-based access for stream visibility
 */
function canAccessStream(userRole, targetRole) {
  const hierarchy = config.roles.hierarchy;
  return hierarchy[userRole]?.includes(targetRole) || false;
}

/**
 * Get accessible producers for a user role
 */
function getAccessibleProducers(room, userRole) {
  const producers = [];
  
  for (const [socketId, peer] of room.peers.entries()) {
    if (canAccessStream(userRole, peer.role)) {
      peer.producers.forEach(producer => {
        producers.push({
          producerId: producer.id,
          userId: peer.socket.userId,
          type: producer.appData?.type || 'media',
        });
      });
    }
  }
  
  return producers;
}

/**
 * Start Socket.IO server with optimized event handlers
 */
function startSocketServer(io) {
  const rooms = mediaSoupManager.getRooms();

  // Authentication middleware
  io.use(authenticateSocket);

  io.on("connection", (socket) => {
    socketLogger.webrtc('connected', {
      socketId: socket.id,
      userId: socket.userId,
      role: socket.userRole
    });

    // Join room handler
    socket.on("join-room", async ({ roomId, role }) => {
      try {
        validateRequired({ roomId, role }, ['roomId', 'role']);
        
        // Validate role if provided
        if (role && !config.roles.hierarchy[role]) {
          throw new AuthorizationError(`Invalid role: ${role}`);
        }
        
        // Use authenticated role or provided role
        const userRole = role || socket.userRole;
        
        let room = rooms.get(roomId);
        if (!room) {
          room = await mediaSoupManager.createRoom(roomId);
        }

        // Create peer object
        const peer = {
          socket,
          role: userRole,
          transports: [],
          producers: [],
          consumers: [],
          recordingSessions: new Map(),
          joinedAt: new Date(),
        };

        room.peers.set(socket.id, peer);
        socket.join(roomId);
        mediaSoupManager.updateRoomActivity(roomId);

        socketLogger.room('joined', roomId, {
          userId: socket.userId,
          role: userRole,
          totalPeers: room.peers.size
        });

        // Send router capabilities
        socket.emit("router-rtp-capabilities", room.router.rtpCapabilities);

        // Send existing producers that this user can access
        const accessibleProducers = getAccessibleProducers(room, userRole);
        socket.emit("existing-producers", accessibleProducers);

      } catch (error) {
        socketErrorHandler(socket, error, 'join-room');
      }
    });

    // Create transport handler
    socket.on("create-transport", async ({ direction }, callback) => {
      try {
        validateRequired({ direction }, ['direction']);
        
        const { room } = getRoomAndPeer(socket);

        const transport = await room.router.createWebRtcTransport({
          listenIps: config.webrtc.listenIps,
          enableUdp: config.webrtc.enableUdp,
          enableTcp: config.webrtc.enableTcp,
          preferUdp: config.webrtc.preferUdp,
          appData: { direction },
        });

        transport.appData = { direction };
        
        // Find peer and add transport
        const peer = room.peers.get(socket.id);
        peer.transports.push(transport);

        socketLogger.transport('created', transport.id, {
          direction,
          userId: socket.userId,
          roomId: room.id
        });

        callback({
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        });

      } catch (error) {
        socketErrorHandler(socket, error, 'create-transport');
        callback({ error: error.message });
      }
    });

    // Connect transport handler
    socket.on("connect-transport", async ({ transportId, dtlsParameters }, callback) => {
      try {
        validateRequired({ transportId, dtlsParameters }, ['transportId', 'dtlsParameters']);
        
        const { room, peer } = getRoomAndPeer(socket);

        const transport = peer.transports.find(t => t.id === transportId);
        if (!transport) {
          throw new TransportError('Transport not found');
        }

        await transport.connect({ dtlsParameters });
        
        socketLogger.transport('connected', transportId, {
          userId: socket.userId,
          direction: transport.appData.direction
        });

        callback();

      } catch (error) {
        socketErrorHandler(socket, error, 'connect-transport');
        callback({ error: error.message });
      }
    });

    // Produce handler with optimized recording logic
    socket.on("produce", async ({ transportId, kind, rtpParameters, appData }, callback) => {
      try {
        validateRequired({ transportId, kind, rtpParameters }, ['transportId', 'kind', 'rtpParameters']);
        
        const { room, peer } = getRoomAndPeer(socket);

        const transport = peer.transports.find(t => t.id === transportId);
        if (!transport) {
          throw new TransportError('Transport not found');
        }

        const producer = await transport.produce({
          kind,
          rtpParameters,
          appData,
        });

        const type = appData?.type || "media";
        producer.appData = { userId: socket.userId, ...appData };

        peer.producers.push(producer);
        
        socketLogger.producer('created', producer.id, {
          kind,
          type,
          userId: socket.userId,
          role: peer.role
        });

        // Notify relevant peers about the new producer
        for (const [peerSocketId, peerData] of room.peers.entries()) {
          if (peerSocketId !== socket.id && canAccessStream(peerData.role, peer.role)) {
            io.to(peerSocketId).emit("new-producer", {
              producerId: producer.id,
              userId: socket.userId,
              type: producer.appData.type,
            });
            
            socketLogger.producer('notified', producer.id, {
              targetRole: peerData.role,
              type: producer.appData.type
            });
          }
        }

        // Start recording based on stream type and role
        if (peer.role === 'student') {
          await startRecording(producer, room.router, socket.userId, appData, peer);
        }

        callback({ id: producer.id });

        // Cleanup handler
        producer.on("close", async () => {
          peer.producers = peer.producers.filter(p => p.id !== producer.id);
          
          // Clean up recording session
          if (peer.recordingSessions.has(producer.id)) {
            const session = peer.recordingSessions.get(producer.id);
            await session.cleanup();
            peer.recordingSessions.delete(producer.id);
          }
          
          socketLogger.producer('closed', producer.id, {
            userId: socket.userId,
            remainingProducers: peer.producers.length
          });
        });

      } catch (error) {
        socketErrorHandler(socket, error, 'produce');
        callback({ error: error.message });
      }
    });

    // Consume handler with auto-transport creation
    socket.on("consume", async ({ producerId, rtpCapabilities }, callback) => {
      try {
        validateRequired({ producerId, rtpCapabilities }, ['producerId', 'rtpCapabilities']);
        
        const { room, peer } = getRoomAndPeer(socket);

        if (!room.router.canConsume({ producerId, rtpCapabilities })) {
          throw new WebRTCError('Cannot consume producer with current RTP capabilities');
        }

        let transport = peer.transports.find(t => t.appData.direction === "recv");
        
        // Auto-create receive transport if needed
        if (!transport) {
          transport = await room.router.createWebRtcTransport({
            listenIps: config.webrtc.listenIps,
            enableUdp: config.webrtc.enableUdp,
            enableTcp: config.webrtc.enableTcp,
            preferUdp: config.webrtc.preferUdp,
            appData: { direction: "recv" },
          });

          transport.appData = { direction: "recv" };
          peer.transports.push(transport);
          
          socketLogger.transport('auto-created', transport.id, {
            direction: 'recv',
            userId: socket.userId
          });
        }

        const consumer = await transport.consume({
          producerId,
          rtpCapabilities,
          paused: false,
        });

        peer.consumers.push(consumer);
        
        socketLogger.consumer('created', consumer.id, {
          producerId,
          userId: socket.userId
        });

        consumer.on("close", () => {
          peer.consumers = peer.consumers.filter(c => c.id !== consumer.id);
          socketLogger.consumer('closed', consumer.id, {
            userId: socket.userId,
            remainingConsumers: peer.consumers.length
          });
        });

        callback({
          id: consumer.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });

      } catch (error) {
        socketErrorHandler(socket, error, 'consume');
        callback({ error: error.message });
      }
    });

    // Get producers handler
    socket.on("get-producers", () => {
      try {
        const { room, peer } = getRoomAndPeer(socket);
        
        const accessibleProducers = getAccessibleProducers(room, peer.role);
        socket.emit("existing-producers", accessibleProducers);

      } catch (error) {
        socketErrorHandler(socket, error, 'get-producers');
      }
    });

    // Disconnect handler with comprehensive cleanup
    socket.on("disconnect", async () => {
      try {
        const roomId = mediaSoupManager.findRoomId(socket);
        if (!roomId) return;
        
        const room = rooms.get(roomId);
        const peer = room.peers.get(socket.id);
        
        if (!peer) return;

        socketLogger.webrtc('disconnecting', {
          socketId: socket.id,
          userId: socket.userId,
          role: peer.role,
          roomId
        });

        // Clean up recording sessions
        if (peer.recordingSessions.size > 0) {
          socketLogger.info('Cleaning up recording sessions', {
            userId: socket.userId,
            sessionCount: peer.recordingSessions.size
          });
          
          for (const [producerId, session] of peer.recordingSessions.entries()) {
            await session.cleanup();
          }
          peer.recordingSessions.clear();
        }

        // Close all transports
        for (const transport of peer.transports) {
          try {
            transport.close();
          } catch (error) {
            socketLogger.error('Error closing transport', {
              transportId: transport.id,
              error: error.message
            });
          }
        }

        // Remove peer from room
        room.peers.delete(socket.id);
        mediaSoupManager.updateRoomActivity(roomId);

        socketLogger.room('left', roomId, {
          userId: socket.userId,
          role: peer.role,
          remainingPeers: room.peers.size,
          sessionDuration: Date.now() - peer.joinedAt.getTime()
        });

        // Delete room if empty
        mediaSoupManager.deleteRoomIfEmpty(roomId);

      } catch (error) {
        socketLogger.error('Error during disconnect cleanup', {
          socketId: socket.id,
          error: error.message
        });
      }
    });
  });
}

/**
 * Start recording based on stream type
 */
async function startRecording(producer, router, userId, appData, peer) {
  const recordingPromises = [];

  // Screen recording
  if (producer.kind === 'video' && 
      (appData.source === 'screen' || appData.type === 'screen' || appData.source === 'screen-share')) {
    
    const filename = path.join(config.recording.basePath, 'screen', `${userId}_screen_${Date.now()}.webm`);
    recordingPromises.push(
      createConsumerAndRecord(producer, router, filename)
        .then(session => {
          peer.recordingSessions.set(producer.id, session);
          socketLogger.recording('started', { type: 'screen', userId });
        })
    );
  }

  // Webcam recording
  if (producer.kind === 'video' && 
      (appData.source === 'webcam' || appData.type === 'webcam' || appData.source === 'camera')) {
    
    recordingPromises.push(
      createWebcamRecording(producer, router, userId)
        .then(session => {
          peer.recordingSessions.set(producer.id, session);
          socketLogger.recording('started', { type: 'webcam', userId });
        })
    );
  }

  // Audio recording
  if (producer.kind === 'audio' && 
      (appData.source === 'mic' || appData.type === 'mic' || appData.source === 'microphone')) {
    
    recordingPromises.push(
      createAudioRecording(producer, router, userId)
        .then(session => {
          peer.recordingSessions.set(producer.id, session);
          socketLogger.recording('started', { type: 'audio', userId });
        })
    );
  }

  // Execute all recording promises
  try {
    await Promise.all(recordingPromises);
  } catch (error) {
    socketLogger.error('Recording setup failed', {
      userId,
      error: error.message
    });
  }
}

module.exports = { startSocketServer };