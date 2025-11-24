/**
 * Professional Socket.IO server for mediasoup WebRTC communication
 * Optimized with proper error handling, role-based access control, and resource management
 */

const jwt = require("jsonwebtoken");
const path = require("path");
const fs = require("fs").promises;
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
const { createConsumerAndRecord, createCombinedWebcamRecording } = require('./recorder');

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
    socket.on("join-room", async ({ roomId, role, examId, sessionId }) => {
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
          examId: examId || null, // Store examId from client
          sessionId: sessionId || null, // Store sessionId from client
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
          examId: examId || null,
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
          await startRecording(producer, room.router, socket.userId, appData, peer, room.id, room);
        }

        callback({ id: producer.id });

        // Cleanup handler
        producer.on("close", async () => {
          peer.producers = peer.producers.filter(p => p.id !== producer.id);
          
          // Clean up recording session
          if (peer.recordingSessions.has(producer.id)) {
            const session = peer.recordingSessions.get(producer.id);
            await session.cleanup();
            // Remove session from all producer IDs that reference it
            for (const [producerId, sess] of peer.recordingSessions.entries()) {
              if (sess === session) {
                peer.recordingSessions.delete(producerId);
              }
            }
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
 * Start recording based on stream type (screen, webcam video with audio)
 */
async function startRecording(producer, router, userId, appData, peer, roomId, room = null) {
  try {
    // Determine candidate_id (userId if role is student/candidate)
    const candidateId = (peer.role === 'student' || peer.role === 'candidate') ? userId : null;
    const examId = peer.examId || null;
    const batchId = roomId || null; // roomId is the batch_id
    
    // Screen recording - record immediately
    if (producer.kind === 'video' && 
        (appData.source === 'screen' || appData.type === 'screen' || appData.source === 'screen-share')) {
      
      // Generate filename with date format
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      const hours = String(now.getHours()).padStart(2, '0');
      const minutes = String(now.getMinutes()).padStart(2, '0');
      const seconds = String(now.getSeconds()).padStart(2, '0');
      const dateStr = `${year}_${month}_${day}_${hours}_${minutes}_${seconds}`;
      const filename = `screen_recording_${dateStr}.webm`;
      
      // Build path: recordings/screen/exam_id/batch_id/candidate_id/filename
      let recordingPath = path.join(config.recording.basePath, 'screen');
      
      if (examId) {
        recordingPath = path.join(recordingPath, examId);
      }
      if (batchId) {
        recordingPath = path.join(recordingPath, batchId);
      }
      if (candidateId) {
        recordingPath = path.join(recordingPath, candidateId);
      }
      
      // Ensure directory exists
      await fs.mkdir(recordingPath, { recursive: true });
      
      const fullPath = path.join(recordingPath, filename);
      const session = await createConsumerAndRecord(producer, router, fullPath, 'screen', examId, batchId, candidateId);
      peer.recordingSessions.set(producer.id, session);
      
      socketLogger.recording('started', { 
        type: 'screen',
        kind: producer.kind,
        userId,
        candidateId,
        examId,
        batchId,
        path: fullPath
      });
      return;
    }
    
    // Webcam video recording - check if audio is available
    if (producer.kind === 'video' && (appData.type === 'webcam' || appData.source === 'camera')) {
      
      // Check if audio producer already exists
      const audioProducer = peer.producers.find(
        p => p.kind === 'audio' && 
        (p.appData?.type === 'webcam' || p.appData?.source === 'microphone')
      );
      
      if (audioProducer) {
        // Audio is available - create combined recording immediately
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        const dateStr = `${year}_${month}_${day}_${hours}_${minutes}_${seconds}`;
        const filename = `webcam_recording_${dateStr}.webm`;
        
        // Build path: recordings/webcam/exam_id/batch_id/candidate_id/filename
        let recordingPath = path.join(config.recording.basePath, 'webcam');
        
        if (examId) {
          recordingPath = path.join(recordingPath, examId);
        }
        if (batchId) {
          recordingPath = path.join(recordingPath, batchId);
        }
        if (candidateId) {
          recordingPath = path.join(recordingPath, candidateId);
        }
        
        // Ensure directory exists
        await fs.mkdir(recordingPath, { recursive: true });
        
        const fullPath = path.join(recordingPath, filename);
        const session = await createCombinedWebcamRecording(
          producer,
          audioProducer,
          router,
          fullPath,
          examId,
          batchId,
          candidateId
        );
        
        // Store session for both producers
        peer.recordingSessions.set(producer.id, session);
        peer.recordingSessions.set(audioProducer.id, session);
        
        socketLogger.recording('started', { 
          type: 'webcam',
          kind: 'combined',
          userId,
          candidateId,
          examId,
          batchId,
          videoProducerId: producer.id,
          audioProducerId: audioProducer.id,
          path: fullPath
        });
      } else {
        // Audio not available - record video only immediately
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        const dateStr = `${year}_${month}_${day}_${hours}_${minutes}_${seconds}`;
        const filename = `webcam_recording_${dateStr}.webm`;
        
        // Build path: recordings/webcam/exam_id/batch_id/candidate_id/filename
        let recordingPath = path.join(config.recording.basePath, 'webcam');
        
        if (examId) {
          recordingPath = path.join(recordingPath, examId);
        }
        if (batchId) {
          recordingPath = path.join(recordingPath, batchId);
        }
        if (candidateId) {
          recordingPath = path.join(recordingPath, candidateId);
        }
        
        // Ensure directory exists
        await fs.mkdir(recordingPath, { recursive: true });
        
        const fullPath = path.join(recordingPath, filename);
        const session = await createConsumerAndRecord(producer, router, fullPath, 'webcam', examId, batchId, candidateId);
        peer.recordingSessions.set(producer.id, session);
        
        socketLogger.recording('started', { 
          type: 'webcam',
          kind: 'video-only',
          userId,
          candidateId,
          examId,
          batchId,
          videoProducerId: producer.id,
          path: fullPath
        });
      }
      return;
    }
    
    // Webcam audio recording - check if video recording already exists
    if (producer.kind === 'audio' && (appData.type === 'webcam' || appData.source === 'microphone')) {
      
      // Check if video producer exists and is already being recorded
      const videoProducer = peer.producers.find(
        p => p.kind === 'video' && 
        (p.appData?.type === 'webcam' || p.appData?.source === 'camera')
      );
      
      // If video recording already exists (video-only), audio will be handled separately or ignored
      // If video doesn't exist yet, wait for it or do nothing
      // For simplicity, if video recording is already active, we don't add audio to it
      // This means audio will only be recorded if it arrives before video
      if (!videoProducer) {
        // No video producer yet - could wait or do nothing
        // For now, do nothing - audio will be combined if video arrives later
        socketLogger.info('Audio producer created before video, waiting', {
          audioProducerId: producer.id,
          userId
        });
      } else if (peer.recordingSessions.has(videoProducer.id)) {
        // Video recording already started (video-only)
        // Check if recording started recently (within 5 seconds) - if so, restart with audio
        const existingSession = peer.recordingSessions.get(videoProducer.id);
        const recordingAge = Date.now() - existingSession.createdAt.getTime();
        const MAX_RESTART_WINDOW_MS = 5000; // 5 seconds
        
        if (recordingAge < MAX_RESTART_WINDOW_MS) {
          // Recording started recently - restart with combined video+audio
          socketLogger.info('Restarting video recording to include audio', {
            videoProducerId: videoProducer.id,
            audioProducerId: producer.id,
            recordingAge: recordingAge,
            userId
          });
          
          // Stop existing video-only recording
          await existingSession.cleanup();
          peer.recordingSessions.delete(videoProducer.id);
          
          // Create new combined recording
          const now = new Date();
          const year = now.getFullYear();
          const month = String(now.getMonth() + 1).padStart(2, '0');
          const day = String(now.getDate()).padStart(2, '0');
          const hours = String(now.getHours()).padStart(2, '0');
          const minutes = String(now.getMinutes()).padStart(2, '0');
          const seconds = String(now.getSeconds()).padStart(2, '0');
          const dateStr = `${year}_${month}_${day}_${hours}_${minutes}_${seconds}`;
          const filename = `webcam_recording_${dateStr}.webm`;
          
          // Build path: recordings/webcam/exam_id/batch_id/candidate_id/filename
          let recordingPath = path.join(config.recording.basePath, 'webcam');
          
          if (examId) {
            recordingPath = path.join(recordingPath, examId);
          }
          if (batchId) {
            recordingPath = path.join(recordingPath, batchId);
          }
          if (candidateId) {
            recordingPath = path.join(recordingPath, candidateId);
          }
          
          // Ensure directory exists
          await fs.mkdir(recordingPath, { recursive: true });
          
          const fullPath = path.join(recordingPath, filename);
          const session = await createCombinedWebcamRecording(
            videoProducer,
            producer,
            router,
            fullPath,
            examId,
            batchId,
            candidateId
          );
          
          // Store session for both producers
          peer.recordingSessions.set(videoProducer.id, session);
          peer.recordingSessions.set(producer.id, session);
          
          socketLogger.recording('started', { 
            type: 'webcam',
            kind: 'combined',
            userId,
            candidateId,
            examId,
            batchId,
            videoProducerId: videoProducer.id,
            audioProducerId: producer.id,
            path: fullPath,
            restarted: true
          });
        } else {
          // Recording started too long ago - don't restart, audio will not be included
          socketLogger.info('Video recording already active for too long, audio not combined', {
            videoProducerId: videoProducer.id,
            audioProducerId: producer.id,
            recordingAge: recordingAge,
            userId
          });
        }
      } else {
        // Video exists but not recorded yet - should not happen as video records immediately
        // But if it does, create combined recording
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        const dateStr = `${year}_${month}_${day}_${hours}_${minutes}_${seconds}`;
        const filename = `webcam_recording_${dateStr}.webm`;
        
        // Build path: recordings/webcam/exam_id/batch_id/candidate_id/filename
        let recordingPath = path.join(config.recording.basePath, 'webcam');
        
        if (examId) {
          recordingPath = path.join(recordingPath, examId);
        }
        if (batchId) {
          recordingPath = path.join(recordingPath, batchId);
        }
        if (candidateId) {
          recordingPath = path.join(recordingPath, candidateId);
        }
        
        // Ensure directory exists
        await fs.mkdir(recordingPath, { recursive: true });
        
        const fullPath = path.join(recordingPath, filename);
        const session = await createCombinedWebcamRecording(
          videoProducer,
          producer,
          router,
          fullPath,
          examId,
          batchId,
          candidateId
        );
        
        // Store session for both producers
        peer.recordingSessions.set(videoProducer.id, session);
        peer.recordingSessions.set(producer.id, session);
        
        socketLogger.recording('started', { 
          type: 'webcam',
          kind: 'combined',
          userId,
          candidateId,
          examId,
          batchId,
          videoProducerId: videoProducer.id,
          audioProducerId: producer.id,
          path: fullPath
        });
      }
      return;
    }
    
    // Not a stream that should be recorded
  } catch (error) {
    socketLogger.error('Recording setup failed', {
      userId,
      producerKind: producer.kind,
      appDataType: appData?.type,
      error: error.message
    });
  }
}

module.exports = { startSocketServer };