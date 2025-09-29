#!/bin/bash

# ProctorAI SFU Server Startup Script
# This script starts the optimized ProctorAI SFU server

echo "🚀 Starting ProctorAI SFU Server..."
echo "📁 Working directory: $(pwd)"
echo "🐍 Node.js version: $(node --version)"
echo "📦 NPM version: $(npm --version)"
echo ""

# Check if FFmpeg is available
if command -v ffmpeg &> /dev/null; then
    echo "✅ FFmpeg is available: $(ffmpeg -version | head -n1)"
else
    echo "⚠️  Warning: FFmpeg not found. Recording functionality may not work."
fi

echo ""
echo "🔧 Starting server with optimized configuration..."
echo "📊 Server will be available at:"
echo "   - Health Check: http://localhost:3000/health"
echo "   - Statistics: http://localhost:3000/stats"
echo "   - Room Info: http://localhost:3000/rooms"
echo "   - WebRTC: ws://localhost:3000/socket.io/"
echo ""

# Start the server
node index.js
