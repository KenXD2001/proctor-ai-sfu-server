require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
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
    method: ["GET", "POST"],
    credentials: true,
  },
});

// initialize socket.io + mediasoup
startSocketServer(io);

// listen on all network interfaces (0.0.0.0)
const PORT = process.env.PORT;
const HOST = process.env.HOST;
server.listen(PORT, HOST, () => {
  console.log(`SFU server running on port ${PORT}`);
});
