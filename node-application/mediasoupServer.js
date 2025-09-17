const mediasoup = require("mediasoup");
const jwt = require("jsonwebtoken");

let worker, router;
let rooms = new Map();

function shortId(id) {
  return id ? id.toString().substring(0, 8) : "";
}

async function startMediasoup(io) {
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
  worker = await mediasoup.createWorker();
  console.log("[Worker] Created ✅");

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

    // room join
    socket.on("join-room", async ({ roomId, role }) => {
      let room = rooms.get(roomId);
      if (!room) {
        router = await worker.createRouter({ mediaCodecs });
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

    socket.on(
      "connect-transport",
      async ({ transportId, dtlsParameters }, callback) => {
        const room = [...rooms.values()].find((r) => r.peers.has(socket.id));
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
        const peer = room.peers.get(socket.id);
        const transport = peer.transports.find((t) => t.id === transportId);
        if (!transport) return;

        const producer = await transport.produce({
          kind,
          rtpParameters,
          appData,
        });
        const type = appData?.type || "media";
        producer.appData = { userId: socket.userId, type };
        peer.producers.push(producer);

        callback({ id: producer.id });

        // 🔹 Log aggregated
        logProducers(peer);

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
          logProducers(peer); // show remaining
        });
      }
    );

    socket.on("consume", async ({ producerId, rtpCapabilities }, callback) => {
      const room = [...rooms.values()].find((r) => r.peers.has(socket.id));
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
      logConsumers(peer); // 🔹 aggregated logging

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

function findRoomId(socket) {
  for (let [roomId, room] of rooms.entries()) {
    if (room.peers.has(socket.id)) return roomId;
  }
  return null;
}

module.exports = { startMediasoup };