const express = require("express");
const http = require("http");
const cors = require("cors");
const socketIO = require("socket.io");
const { startSocketServer } = require("./socketServer");
const AudioIntegrationService = require("./audioIntegration");

const app = express();
app.use(cors());
app.use(express.json());

// Store audio integration service globally for API access
let audioIntegrationService = null;

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

// initialize audio integration service
const audioIntegration = new AudioIntegrationService();
audioIntegrationService = audioIntegration;

// listen on all network interfaces (0.0.0.0)
const PORT = 3000;
server.listen(PORT, "0.0.0.0", async () => {
  console.log(`SFU server running on port ${PORT}`);
  
  // Initialize audio integration service
  try {
    await audioIntegration.initialize();
    console.log('Audio integration service initialized successfully');
  } catch (error) {
    console.error('Failed to initialize audio integration service:', error.message);
    console.log('Audio recording will continue, but analysis will be disabled');
  }
});

// API endpoints for audio integration
app.get('/audio-integration/status', (req, res) => {
  if (!audioIntegrationService) {
    return res.status(503).json({ error: 'Audio integration service not initialized' });
  }
  
  const status = audioIntegrationService.getStatus();
  res.json(status);
});

// API endpoints for face analysis integration
app.get('/face-analysis/status', async (req, res) => {
  try {
    const FaceAnalysisService = require('./faceAnalysisService');
    const faceAnalysisService = new FaceAnalysisService();
    
    const status = faceAnalysisService.getStatus();
    const serviceHealth = await faceAnalysisService.checkServiceHealth();
    
    res.json({
      ...status,
      pythonServiceHealthy: serviceHealth,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Face analysis service error', 
      details: error.message 
    });
  }
});

app.post('/audio-integration/calibrate', async (req, res) => {
  try {
    if (!audioIntegrationService) {
      return res.status(503).json({ error: 'Audio integration service not initialized' });
    }
    
    const { calibrationFilePath } = req.body;
    
    if (!calibrationFilePath) {
      return res.status(400).json({ error: 'calibrationFilePath is required' });
    }
    
    const result = await audioIntegrationService.performCalibration(calibrationFilePath);
    res.json(result);
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/audio-integration/check-calibration', async (req, res) => {
  try {
    if (!audioIntegrationService) {
      return res.status(503).json({ error: 'Audio integration service not initialized' });
    }
    
    await audioIntegrationService.checkCalibrationStatus();
    const status = audioIntegrationService.getStatus();
    res.json(status);
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/audio-integration/reset-calibration', (req, res) => {
  try {
    if (!audioIntegrationService) {
      return res.status(503).json({ error: 'Audio integration service not initialized' });
    }
    
    audioIntegrationService.resetAutoCalibrationAttempts();
    const status = audioIntegrationService.getStatus();
    res.json({ message: 'Auto-calibration attempts reset', status });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
