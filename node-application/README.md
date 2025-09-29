# ProctorAI SFU Server

A professional WebRTC SFU (Selective Forwarding Unit) server optimized for online exam proctoring with advanced recording capabilities.

## 🚀 Features

- **High-Performance WebRTC**: Built with MediaSoup for optimal streaming performance
- **Role-Based Access Control**: Student → Invigilator → Admin hierarchy
- **Multi-Stream Recording**: Screen, webcam, and audio recording with FFmpeg
- **Professional Error Handling**: Comprehensive error management and logging
- **Resource Management**: Automatic cleanup and memory optimization
- **Scalable Architecture**: Class-based design with singleton patterns
- **Configuration Management**: Environment-based configuration system

## 📋 Requirements

- Node.js >= 16.0.0
- FFmpeg (for recording functionality)
- Ubuntu/Linux environment (recommended)

## 🛠️ Installation

```bash
# Clone the repository
git clone <repository-url>
cd proctor-ai-sfu-server/node-application

# Install dependencies
npm install

# Start the server
npm start
```

## ⚙️ Configuration

The server uses environment variables for configuration. Create a `.env` file or set the following variables:

```bash
# Server Configuration
PORT=3000
HOST=0.0.0.0
CORS_ORIGIN=*

# JWT Configuration
JWT_SECRET=your-secret-key

# WebRTC Configuration
WEBRTC_LISTEN_IP=0.0.0.0
WEBRTC_ANNOUNCED_IP=192.168.137.89

# MediaSoup Configuration
MEDIASOUP_LOG_LEVEL=warn
RTC_MIN_PORT=10000
RTC_MAX_PORT=59999

# Recording Configuration
RECORDING_PATH=recordings

# Logging Configuration
LOG_LEVEL=info
```

## 🏗️ Architecture

### Core Components

1. **ProctorAIServer**: Main server class with Express and Socket.IO integration
2. **MediaSoupManager**: Singleton class for MediaSoup worker and room management
3. **RecordingSession**: Professional recording session management with cleanup
4. **Logger**: Structured logging with different log levels and contexts
5. **ErrorHandler**: Custom error classes and comprehensive error handling

### File Structure

```
node-application/
├── config.js              # Centralized configuration management
├── index.js               # Main server entry point
├── socketServer.js        # Socket.IO WebRTC handlers
├── mediasoupServer.js     # MediaSoup worker and room management
├── recorder.js            # Professional recording service
├── utils/
│   ├── logger.js          # Structured logging utility
│   └── errors.js          # Custom error classes and handlers
├── package.json           # Dependencies and scripts
└── README.md             # This file
```

## 🔌 API Endpoints

### Health Check
```http
GET /health
```

### Server Statistics
```http
GET /stats
```

### Room Information
```http
GET /rooms
```

## 🎯 Socket.IO Events

### Client → Server Events

- `join-room`: Join a room with role-based access
- `create-transport`: Create WebRTC transport
- `connect-transport`: Connect transport with DTLS parameters
- `produce`: Start media production (screen/webcam/audio)
- `consume`: Consume media from other peers
- `get-producers`: Get list of accessible producers

### Server → Client Events

- `router-rtp-capabilities`: Router capabilities
- `existing-producers`: List of available producers
- `new-producer`: Notification of new producer
- `error`: Error notifications

## 🎥 Recording System

The server automatically records different types of media:

### Screen Recording
- **Format**: WebM video files
- **Trigger**: When students share screen
- **Storage**: `recordings/screen/{userId}_screen_{timestamp}.webm`

### Webcam Recording
- **Format**: Single JPEG frame
- **Trigger**: When students enable webcam
- **Storage**: `recordings/webcam/{userId}_frame.jpg`

### Audio Recording
- **Format**: 10-second MP3 chunks
- **Trigger**: When students enable microphone
- **Storage**: `recordings/audio/{userId}_audio.mp3`

## 🔐 Role-Based Access Control

### Role Hierarchy
- **Admin**: Can monitor invigilators
- **Invigilator**: Can monitor students
- **Student**: Can only be monitored

### Access Rules
- Students can only be viewed by invigilators
- Invigilators can only be viewed by admins
- Automatic producer filtering based on role hierarchy

## 📊 Monitoring & Logging

### Structured Logging
- Context-aware logging with timestamps
- Different log levels (debug, info, warn, error)
- Specialized logging for WebRTC events, rooms, transports, etc.

### Server Statistics
- Memory usage and CPU statistics
- Room and peer counts
- MediaSoup worker information
- Uptime and performance metrics

## 🚦 Error Handling

### Custom Error Classes
- `AuthenticationError`: JWT and authentication failures
- `AuthorizationError`: Role-based access violations
- `WebRTCError`: MediaSoup and WebRTC related errors
- `RecordingError`: FFmpeg and recording failures
- `RoomError`: Room management errors
- `TransportError`: Transport-related issues

### Error Recovery
- Automatic MediaSoup worker restart
- Graceful session cleanup
- Comprehensive error logging
- Client error notifications

## 🔧 Development

### Running in Development Mode
```bash
npm run dev
```

### Code Structure
- **ES6+ Classes**: Modern JavaScript with class-based architecture
- **Async/Await**: Proper asynchronous handling
- **Error Boundaries**: Comprehensive error handling
- **Resource Management**: Automatic cleanup and memory optimization

## 🚀 Production Deployment

### Environment Setup
1. Set all required environment variables
2. Ensure FFmpeg is installed and accessible
3. Configure firewall for WebRTC ports (10000-59999)
4. Set up proper logging and monitoring

### Performance Optimization
- Configure MediaSoup worker settings
- Optimize FFmpeg parameters for your hardware
- Set appropriate timeouts and limits
- Monitor memory usage and connection counts

## 📝 License

ISC License - See LICENSE file for details.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes with proper error handling
4. Add tests if applicable
5. Submit a pull request

## 📞 Support

For issues and questions, please create an issue in the repository or contact the ProctorAI team.
