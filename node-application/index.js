const express = require("express");
const http = require("http");
const cors = require("cors");
const socketIO = require("socket.io");
const { startSocketServer } = require("./socketServer");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// initialize socket.io + mediasoup
startSocketServer(io);

// listen on all network interfaces (0.0.0.0)
const PORT = 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`SFU server running on port ${PORT}`);
});
