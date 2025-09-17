const express = require('express')
const http = require('http')
const cors = require('cors')
const socketIO = require('socket.io')
const { startMediasoup } = require('./mediasoupServer')

const app = express()
app.use(cors())
const server = http.createServer(app)
const io = socketIO(server, {
  cors: {
    origin: '*',
    method: ['GET', 'POST'],
    credentials: true,
  },
})

startMediasoup(io)

server.listen(3000, () => {
  console.log('SFU server running on port 3000')
})
