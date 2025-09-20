const mediasoup = require("mediasoup");

let worker;
let rooms = new Map();

async function createWorker() {
  if (!worker) {
    worker = await mediasoup.createWorker();
    console.log("[Worker] Created");
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
