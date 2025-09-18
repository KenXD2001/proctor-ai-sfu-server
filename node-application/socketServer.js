const jwt = require("jsonwebtoken");
const {
  createRouter,
  getRooms,
  findRoomId,
  plainRtpTransportConfig,
} = require("./mediasoupServer");
const GStreamer = require("./gstreamer");
const { getPort, releasePort } = require("./port");

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
        console.log(`[Room] 🆕 Created Room=${roomId}`);
      }

      room.peers.set(socket.id, {
        socket,
        role,
        transports: [],
        producers: [],
        consumers: [],
        gstreamer: null,
        remotePorts: [],
      });
      socket.join(roomId);

      console.log(
        `[Join] User=${shortId(
          socket.userId
        )} Role=${role} Room=${roomId} Count=${room.peers.size}`
      );

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
      if (!room) return;
      const peer = room.peers.get(socket.id);

      const transport = await room.router.createWebRtcTransport({
        listenIps: [{ ip: "0.0.0.0", announcedIp: "10.5.50.167" }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      });

      transport.appData = { direction };
      peer.transports.push(transport);

      callback({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });
    });

    socket.on("start-record", async (callback) => {
      const roomId = findRoomId(socket);
      const room = rooms.get(roomId);
      const peer = room.peers.get(socket.id);

      if (!peer) return;

      const videoProducer = peer.producers.find(
        (p) => p.kind === "video" && p.appData?.type === "screen"
      );
      if (!videoProducer) {
        console.log(`[Record] ⚠️ No screen producer found for User=${peer.socket.userId}`);
        return callback({ error: "No screen producer" });
      }

      const videoInfo = await publishProducerRtpStream(room, peer, videoProducer);

      const audioProducer = peer.producers.find((p) => p.kind === "audio");
      let audioInfo = null;
      if (audioProducer) {
        audioInfo = await publishProducerRtpStream(room, peer, audioProducer);
      }

      peer.gstreamer = new GStreamer({
        roomId,
        userId: peer.socket.userId,
        video: videoInfo,
        audio: audioInfo,
      });

      setTimeout(async () => {
        for (const consumer of peer.consumers) {
          await consumer.resume();
          await consumer.requestKeyFrame();
        }
      }, 1000);

      callback({ status: "recording", roomId, userId: peer.socket.userId });
    });

    socket.on("stop-record", () => {
      const roomId = findRoomId(socket);
      const room = rooms.get(roomId);
      const peer = room.peers.get(socket.id);

      if (peer?.gstreamer) {
        peer.gstreamer.kill();
        peer.gstreamer = null;

        peer.remotePorts.forEach((p) => releasePort(p));
        peer.remotePorts = [];
      }
    });

    socket.on(
      "connect-transport",
      async ({ transportId, dtlsParameters }, callback) => {
        const room = [...rooms.values()].find((r) => r.peers.has(socket.id));
        if (!room) return;
        const peer = room.peers.get(socket.id);

        const transport = peer.transports.find((t) => t.id === transportId);
        if (!transport) return;
        await transport.connect({ dtlsParameters });
        callback();
      }
    );

    function logProducers(peer) {
      const kinds = peer.producers.map(
        (p) => `${p.kind}:${p.rtpParameters.codecs?.[0]?.mimeType || "unknown"}`
      );
      console.log(
        `[Produce] 🎥 User=${shortId(peer.socket.userId)} Role=${
          peer.role
        } Total=${peer.producers.length} [${kinds.join(", ")}]`
      );
    }

    function logConsumers(peer) {
      console.log(
        `[Consume] 👀 User=${shortId(peer.socket.userId)} Role=${
          peer.role
        } Total=${peer.consumers.length}`
      );
    }

    socket.on(
      "produce",
      async ({ transportId, kind, rtpParameters, appData }, callback) => {
        const room = [...rooms.values()].find((r) => r.peers.has(socket.id));
        if (!room) return;
        const peer = room.peers.get(socket.id);
        const transport = peer.transports.find((t) => t.id === transportId);
        if (!transport) return;
    
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
    
        // Logging meta
        let metaParts = [
          `User=${shortId(socket.userId)}`,
          `Kind=${kind}`,
          `Type=${type}`,
        ];
        if (appData.resolution)
          metaParts.push(`Resolution=${appData.resolution}`);
        if (appData.fps) metaParts.push(`FPS=${appData.fps}`);
        if (appData.source) metaParts.push(`Source=${appData.source}`);
    
        console.log(`[Stream-Meta] 📡 ${metaParts.join(" ")}`);
    
        // 🔥 AUTO RECORD when screen is produced
        if (kind === "video" && type === "screen") {
          console.log(`[Record] 🎬 Auto-start for screen share User=${socket.userId}`);
    
          // Publish video
          const videoInfo = await publishProducerRtpStream(room, peer, producer);
    
          // Try also to attach audio if available
          const audioProducer = peer.producers.find((p) => p.kind === "audio");
          let audioInfo = null;
          if (audioProducer) {
            audioInfo = await publishProducerRtpStream(room, peer, audioProducer);
          }
    
          peer.gstreamer = new GStreamer({
            roomId: room.router.id || roomId,
            userId: peer.socket.userId,
            video: videoInfo,
            audio: audioInfo,
          });
    
          // Resume consumers
          setTimeout(async () => {
            for (const consumer of peer.consumers) {
              await consumer.resume();
              await consumer.requestKeyFrame();
            }
          }, 1000);
        }
    
        // Notify others
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
    
        producer.on("close", () => {
          peer.producers = peer.producers.filter(
            (prod) => prod.id !== producer.id
          );
          console.log(
            `[Produce-End] ⏹️ User=${shortId(socket.userId)} Role=${peer.role}`
          );
          logProducers(peer);
    
          // 🔥 Stop auto recording when screen producer closes
          if (peer.gstreamer) {
            peer.gstreamer.kill();
            peer.gstreamer = null;
            peer.remotePorts.forEach((p) => releasePort(p));
            peer.remotePorts = [];
          }
        });
      }
    );

    socket.on("consume", async ({ producerId, rtpCapabilities }, callback) => {
      const room = [...rooms.values()].find((r) => r.peers.has(socket.id));
      if (!room) return;
      const peer = room.peers.get(socket.id);

      if (!room.router.canConsume({ producerId, rtpCapabilities })) {
        return callback({ error: "Cannot consume" });
      }

      const transport = peer.transports.find(
        (t) => t.appData.direction === "recv"
      );
      if (!transport) return;

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: false,
      });

      peer.consumers.push(consumer);
      logConsumers(peer);

      consumer.on("close", () => {
        peer.consumers = peer.consumers.filter((c) => c.id !== consumer.id);
        console.log(
          `[Consume-End] ❌ User=${shortId(socket.userId)} Role=${peer.role}`
        );
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
      if (!room) return;
      const peer = room.peers.get(socket.id);
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
      peer.transports.forEach((t) => t.close());

      if (peer.gstreamer) {
        peer.gstreamer.kill();
      }

      room.peers.delete(socket.id);

      console.log(
        `[Leave] ❌ User=${shortId(socket.userId)} Role=${
          peer.role
        } Room=${roomId} Count=${room.peers.size}`
      );

      if (room.peers.size === 0) {
        rooms.delete(roomId);
        console.log(`[Room] 🗑️ Deleted Room=${roomId}`);
      }
    });
  });
}

async function publishProducerRtpStream(room, peer, producer) {
  const rtpTransport = await room.router.createPlainTransport({
    listenIp: { ip: "127.0.0.1", announcedIp: "127.0.0.1" },
    rtcpMux: false,
    comedia: false,
  });

  const remoteRtpPort = getPort();
  peer.remotePorts.push(remoteRtpPort);

  let remoteRtcpPort;
  if (!plainRtpTransportConfig.rtcpMux) {
    remoteRtcpPort = getPort();
    peer.remotePorts.push(remoteRtcpPort);
  }

  await rtpTransport.connect({
    ip: "127.0.0.1",
    port: remoteRtpPort,
    rtcpPort: remoteRtcpPort,
  });

  peer.transports.push(rtpTransport);

  const codecs = [];
  const routerCodec = room.router.rtpCapabilities.codecs.find(
    (c) => c.kind === producer.kind
  );
  codecs.push(routerCodec);

  const rtpCapabilities = { codecs, rtcpFeedback: [] };

  const rtpConsumer = await rtpTransport.consume({
    producerId: producer.id,
    rtpCapabilities,
    paused: true,
  });

  peer.consumers.push(rtpConsumer);

  return {
    remoteRtpPort,
    remoteRtcpPort,
    rtpParameters: rtpConsumer.rtpParameters,
  };
}

module.exports = { startSocketServer };
