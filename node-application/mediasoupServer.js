const mediasoup = require("mediasoup");

let worker;
let rooms = new Map();

async function createWorker() {
  if (!worker) {
    worker = await mediasoup.createWorker({
      logLevel: 'warn',
      logTags: [
        'info',
        'ice',
        'dtls',
        'rtp',
        'srtp',
        'rtcp',
      ],
      rtcMinPort: 10000,
      rtcMaxPort: 59999,
    });
    console.log("[Worker] Created");
    
    // Handle worker events
    worker.on('died', (error) => {
      console.error('[Worker] Worker died:', error);
      worker = null;
    });
  }
  return worker;
}

async function createRouter(mediaCodecs) {
  const worker = await createWorker();
  return worker.createRouter({ mediaCodecs });
}

function getRooms() {
  return rooms;
}

function findRoomId(socket) {
  for (let [roomId, room] of rooms.entries()) {
    if (room.peers.has(socket.id)) return roomId;
  }
  return null;
}

module.exports = {
  createWorker,
  createRouter,
  getRooms,
  findRoomId,
};
