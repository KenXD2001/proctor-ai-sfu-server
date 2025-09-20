const jwt = require("jsonwebtoken");
const { createRouter, getRooms, findRoomId } = require("./mediasoupServer");
const { createConsumerAndRecord } = require("./recorder");

const mediaCodecs = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: {},
  },
];

function shortId(id) {
  return id ? id.toString().substring(0, 8) : "";
}

function startSocketServer(io) {
  const rooms = getRooms();

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      const decoded = jwt.verify(token, "supersecret");
      socket.userId = decoded.user_id;
      next();
    } catch (err) {
      next(new Error("Authentication error"));
    }
  });

  io.on("connection", (socket) => {
    console.log(
      `[Connect] 🔌 Socket=${shortId(socket.id)} User=${shortId(socket.userId)}`
    );

    socket.on("join-room", async ({ roomId, role }) => {
      let room = rooms.get(roomId);
      if (!room) {
        const router = await createRouter(mediaCodecs);
        room = { router, peers: new Map() };
        rooms.set(roomId, room);
        console.log(`[Room] Created: ${roomId}`);
      }

      room.peers.set(socket.id, {
        socket,
        role,
        transports: [],
        producers: [],
        consumers: [],
      });
      socket.join(roomId);

      console.log(`[Join] User=${shortId(socket.userId)} Role=${role} Room=${roomId}`);

      socket.emit("router-rtp-capabilities", room.router.rtpCapabilities);

      const allProducerIds = [];
      room.peers.forEach((peer) => {
        if (
          (role === "invigilator" && peer.role === "student") ||
          (role === "admin" && peer.role === "invigilator")
        ) {
          peer.producers.forEach((producer) => {
            allProducerIds.push({
              producerId: producer.id,
              userId: peer.socket.userId,
              type: producer.appData?.type || "media",
            });
          });
        }
      });
      socket.emit("existing-producers", allProducerIds);
    });

    socket.on("create-transport", async ({ direction }, callback) => {
      const room = [...rooms.values()].find((r) => r.peers.has(socket.id));
      if (!room) {
        console.error(`[Create-Transport] No room found for socket=${shortId(socket.id)}`);
        return callback({ error: "Not in any room" });
      }
      const peer = room.peers.get(socket.id);
      if (!peer) {
        console.error(`[Create-Transport] No peer found for socket=${shortId(socket.id)}`);
        return callback({ error: "Peer not found" });
      }

      const transport = await room.router.createWebRtcTransport({
        listenIps: [{ ip: "0.0.0.0", announcedIp: "192.168.137.127" }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        appData: { direction },
      });

      transport.appData = { direction };
      peer.transports.push(transport);

      console.log(`[Transport] Created: ID=${transport.id} Direction=${direction} User=${shortId(socket.userId)} Role=${peer.role}`);

      callback({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });
    });

    socket.on(
      "connect-transport",
      async ({ transportId, dtlsParameters }, callback) => {
        const room = [...rooms.values()].find((r) => r.peers.has(socket.id));
        if (!room) {
          console.error(`[Connect-Transport] No room found for socket=${shortId(socket.id)}`);
          return callback({ error: "Not in any room" });
        }
        
        const peer = room.peers.get(socket.id);
        if (!peer) {
          console.error(`[Connect-Transport] No peer found for socket=${shortId(socket.id)}`);
          return callback({ error: "Peer not found" });
        }

        const transport = peer.transports.find((t) => t.id === transportId);
        if (!transport) {
          console.error(`[Connect-Transport] No transport found for id=${transportId}`);
          return callback({ error: "Transport not found" });
        }
        
        await transport.connect({ dtlsParameters });
        callback();
      }
    );

    function logProducers(peer) {
      const kinds = peer.producers.map(
        (p) => `${p.kind}:${p.rtpParameters.codecs?.[0]?.mimeType || "unknown"}`
      );
      console.log(
        `[Produce] User=${shortId(peer.socket.userId)} Role=${peer.role} Total=${peer.producers.length} [${kinds.join(", ")}]`
      );
    }

    function logConsumers(peer) {
      console.log(
        `[Consume] User=${shortId(peer.socket.userId)} Role=${peer.role} Total=${peer.consumers.length}`
      );
    }

    socket.on(
      "produce",
      async ({ transportId, kind, rtpParameters, appData }, callback) => {
        const room = [...rooms.values()].find((r) => r.peers.has(socket.id));
        if (!room) {
          console.error(`[Produce] No room found for socket=${shortId(socket.id)}`);
          return callback({ error: "Not in any room" });
        }
        
        const peer = room.peers.get(socket.id);
        if (!peer) {
          console.error(`[Produce] No peer found for socket=${shortId(socket.id)}`);
          return callback({ error: "Peer not found" });
        }
        
        const transport = peer.transports.find((t) => t.id === transportId);
        if (!transport) {
          console.error(`[Produce] No transport found for id=${transportId}`);
          return callback({ error: "Transport not found" });
        }

        const producer = await transport.produce({
          kind,
          rtpParameters,
          appData,
        });

        const type = appData?.type || "media";
        producer.appData = { userId: socket.userId, ...appData };

        peer.producers.push(producer);
        callback({ id: producer.id });
        logProducers(peer);
        
        // Log producer creation with transport details
        const transportInfo = transport.tuple ? 
          `IP=${transport.tuple.localIp}:${transport.tuple.localPort}` : 
          `TransportID=${transport.id}`;
        console.log(`[Producer] Created: ID=${producer.id} ${transportInfo} User=${shortId(socket.userId)} Kind=${kind}`);
        
        // Log stream metadata
        let metaParts = [`User=${shortId(socket.userId)}`, `Kind=${kind}`, `Type=${type}`];
        if (appData.resolution) metaParts.push(`Resolution=${appData.resolution}`);
        if (appData.fps) metaParts.push(`FPS=${appData.fps}`);
        if (appData.source) metaParts.push(`Source=${appData.source}`);
        console.log(`[Stream] ${metaParts.join(" ")}`);

        // Add producer event listeners
        producer.on('transportclose', () => {
          console.log(`[Producer] Transport closed: ${producer.id}`);
        });

        producer.on('close', () => {
          console.log(`[Producer] Producer closed: ${producer.id}`);
        });

        room.peers.forEach((p, id) => {
          if (
            (peer.role === "student" && p.role === "invigilator") ||
            (peer.role === "invigilator" && p.role === "admin")
          ) {
            if (id !== socket.id) {
              io.to(id).emit("new-producer", {
                producerId: producer.id,
                userId: socket.userId,
                type: producer.appData.type,
              });
            }
          }
        });

        // Only record screen share video streams
        const shouldRecord = producer.kind === 'video' && 
                           (appData.source === 'screen' || appData.type === 'screen' || appData.source === 'screen-share');
        
        if (shouldRecord) {
          const filename = `recordings/${socket.userId}_screen_${Date.now()}.webm`;
          const recordingSession = await createConsumerAndRecord(producer, room.router, filename);
          
          // Track recording session for cleanup
          if (!peer.recordingSessions) {
            peer.recordingSessions = new Map();
          }
          peer.recordingSessions.set(producer.id, recordingSession);
          
          console.log(`[Recording] Started screen recording for user: ${shortId(socket.userId)}`);
        } else {
          console.log(`[Recording] Skipping recording for ${producer.kind} stream (source: ${appData.source || 'unknown'})`);
        }

        producer.on("close", () => {
          peer.producers = peer.producers.filter(
            (prod) => prod.id !== producer.id
          );
          
          // Stop recording if this producer was being recorded
          if (peer.recordingSessions && peer.recordingSessions.has(producer.id)) {
            const recordingSession = peer.recordingSessions.get(producer.id);
            if (recordingSession) {
              // Stop FFmpeg process
              if (recordingSession.ffmpeg && !recordingSession.ffmpeg.killed) {
                recordingSession.ffmpeg.kill('SIGTERM');
                console.log(`[Recording] Stopped recording for producer: ${producer.id}`);
              }
              // Close consumer and transport
              if (recordingSession.consumer) {
                recordingSession.consumer.close();
              }
              if (recordingSession.transport) {
                recordingSession.transport.close();
              }
              peer.recordingSessions.delete(producer.id);
            }
          }
          
          console.log(`[Produce-End] User=${shortId(socket.userId)} Role=${peer.role}`);
          logProducers(peer);
        });
      }
    );

    socket.on("consume", async ({ producerId, rtpCapabilities }, callback) => {
      const room = [...rooms.values()].find((r) => r.peers.has(socket.id));
      if (!room) {
        console.error(`[Consume] No room found for socket=${shortId(socket.id)}`);
        return callback({ error: "Not in any room" });
      }
      
      const peer = room.peers.get(socket.id);
      if (!peer) {
        console.error(`[Consume] No peer found for socket=${shortId(socket.id)}`);
        return callback({ error: "Peer not found" });
      }

      if (!room.router.canConsume({ producerId, rtpCapabilities })) {
        return callback({ error: "Cannot consume" });
      }

      let transport = peer.transports.find(
        (t) => t.appData.direction === "recv"
      );
      
      // Auto-create receive transport if it doesn't exist
      if (!transport) {
        console.log(`[Consume] Auto-creating receive transport for socket=${shortId(socket.id)}`);
        
        const newTransport = await room.router.createWebRtcTransport({
          listenIps: [{ ip: "0.0.0.0", announcedIp: "192.168.137.127" }],
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
          appData: { direction: "recv" },
        });

        newTransport.appData = { direction: "recv" };
        peer.transports.push(newTransport);
        transport = newTransport;
        
        console.log(`[Transport] Auto-created: ID=${transport.id} Direction=recv User=${shortId(socket.userId)} Role=${peer.role}`);
      }

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: false,
      });

      peer.consumers.push(consumer);
      console.log(`[Consume] Success: ConsumerID=${consumer.id} ProducerID=${producerId} User=${shortId(socket.userId)} TransportID=${transport.id}`);
      logConsumers(peer);

      consumer.on("close", () => {
        peer.consumers = peer.consumers.filter((c) => c.id !== consumer.id);
        console.log(`[Consume-End] User=${shortId(socket.userId)} Role=${peer.role}`);
        logConsumers(peer);
      });

      callback({
        id: consumer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      });
    });

    socket.on("get-producers", () => {
      const room = [...rooms.values()].find((r) => r.peers.has(socket.id));
      if (!room) {
        console.error(`[Get-Producers] No room found for socket=${shortId(socket.id)}`);
        return;
      }
      
      const peer = room.peers.get(socket.id);
      if (!peer) {
        console.error(`[Get-Producers] No peer found for socket=${shortId(socket.id)}`);
        return;
      }
      
      const allProducerIds = [];

      room.peers.forEach((p) => {
        if (p.socket.id === socket.id) return;
        if (
          (peer.role === "invigilator" && p.role === "student") ||
          (peer.role === "admin" && p.role === "invigilator")
        ) {
          p.producers.forEach((prod) =>
            allProducerIds.push({
              producerId: prod.id,
              userId: p.socket.userId,
              type: prod.appData?.type || "media",
            })
          );
        }
      });

      socket.emit("existing-producers", allProducerIds);
    });

    socket.on("disconnect", () => {
      const roomId = findRoomId(socket);
      const room = rooms.get(roomId);
      if (!room) return;
      const peer = room.peers.get(socket.id);
      
      // Stop all recordings for this peer
      if (peer.recordingSessions) {
        peer.recordingSessions.forEach((recordingSession, producerId) => {
          // Stop FFmpeg process
          if (recordingSession.ffmpeg && !recordingSession.ffmpeg.killed) {
            recordingSession.ffmpeg.kill('SIGTERM');
            console.log(`[Recording] Stopped recording for disconnected user: ${shortId(socket.userId)}`);
          }
          // Close consumer and transport
          if (recordingSession.consumer) {
            recordingSession.consumer.close();
          }
          if (recordingSession.transport) {
            recordingSession.transport.close();
          }
        });
        peer.recordingSessions.clear();
      }
      
      peer.transports.forEach((t) => t.close());
      room.peers.delete(socket.id);

      console.log(`[Leave] User=${shortId(socket.userId)} Role=${peer.role} Room=${roomId}`);

      if (room.peers.size === 0) {
        rooms.delete(roomId);
        console.log(`[Room] Deleted: ${roomId}`);
      }
    });
  });
}

module.exports = { startSocketServer };
