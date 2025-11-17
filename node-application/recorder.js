/**
 * Professional recording service with optimized FFmpeg integration
 * Handles screen recording with proper error handling
 */

const { spawn } = require("child_process");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const net = require("net");
const config = require('./config');
const { logger, createLogger } = require('./utils/logger');
const { RecordingError, validateRequired } = require('./utils/errors');

const recordLogger = createLogger('Recorder');

/**
 * Recording session manager
 */
class RecordingSession {
  constructor(producerId, type, outputPath) {
    this.producerId = producerId;
    this.type = type;
    this.outputPath = outputPath;
    this.ffmpeg = null;
    this.consumer = null;
    this.transport = null;
    this.sdpFile = null;
    this.createdAt = new Date();
    this.status = 'initializing';
  }

  async cleanup() {
    this.status = 'cleaning';
    
    try {
      // Stop FFmpeg process
      if (this.ffmpeg && !this.ffmpeg.killed) {
        this.ffmpeg.kill('SIGTERM');
        recordLogger.info('FFmpeg process terminated', { producerId: this.producerId });
      }
      
      // Close consumer
      if (this.consumer) {
        this.consumer.close();
        recordLogger.info('Consumer closed', { producerId: this.producerId });
      }
      
      // Close transport
      if (this.transport) {
        this.transport.close();
        recordLogger.info('Transport closed', { producerId: this.producerId });
      }
      
      // Clean up SDP file
      if (this.sdpFile && fsSync.existsSync(this.sdpFile)) {
        await fs.unlink(this.sdpFile);
        recordLogger.info('SDP file cleaned up', { sdpFile: this.sdpFile });
      }
      
      this.status = 'completed';
      recordLogger.info('Recording session cleaned up', { 
        producerId: this.producerId,
        duration: Date.now() - this.createdAt.getTime()
      });
      
    } catch (error) {
      recordLogger.error('Error during cleanup', { 
        producerId: this.producerId, 
        error: error.message 
      });
      this.status = 'error';
    }
  }
}

/**
 * Port availability checker with timeout
 */
function isPortAvailable(port, timeout = 1000) {
  return new Promise((resolve) => {
    const server = net.createServer();
    const timer = setTimeout(() => {
      server.close();
      resolve(false);
    }, timeout);

    server.listen(port, () => {
      clearTimeout(timer);
      server.once('close', () => resolve(true));
      server.close();
    });

    server.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * Create optimized recorder transport
 */
async function createRecorderTransport(router) {
  try {
    const recorderIp = config.recording.recorderIp;
    const transport = await router.createPlainTransport({
      listenIp: { ip: recorderIp, announcedIp: recorderIp },
      rtcpMux: true,
      comedia: false,
    });

    const tuple = transport.tuple;
    if (!tuple?.localIp || !tuple?.localPort) {
      throw new RecordingError('Transport tuple not available after creation');
    }

    recordLogger.transport('created', transport.id, {
      ip: tuple.localIp,
      port: tuple.localPort
    });

    transport.on('@close', () => {
      recordLogger.transport('closed', transport.id);
    });

    return transport;
  } catch (error) {
    recordLogger.error('Failed to create recorder transport', { error: error.message });
    throw new RecordingError(`Failed to create transport: ${error.message}`);
  }
}

/**
 * Wait for producer to become active with timeout
 */
async function waitForProducerActive(producer, timeout = config.timeouts.producerActive) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    
    const checkActive = () => {
      if (!producer.paused && !producer.closed) {
        resolve(true);
        return;
      }
      
      if (Date.now() - startTime > timeout) {
        reject(new RecordingError('Producer did not become active within timeout'));
        return;
      }
      
      setTimeout(checkActive, config.timeouts.producerCheckInterval);
    };
    
    checkActive();
  });
}

/**
 * Calculate optimal FFmpeg port
 */
function calculateFFmpegPort(basePort) {
  const portOffset = config.recording.ffmpegPortOffset;
  let ffmpegPort = basePort + portOffset;
  
  if (ffmpegPort > 65535) {
    ffmpegPort = basePort + 1000;
    if (ffmpegPort > 65535) {
      ffmpegPort = 50000 + (basePort % 1000);
    }
  }
  
  return ffmpegPort;
}

/**
 * Generate SDP content for FFmpeg (video only for screen recording)
 */
function generateSDPContent(rtpParameters, payloadType, kind, recordingType) {
  const codec = 'VP8';
  const clockRate = 90000;
  const recorderIp = config.recording.recorderIp;
  
  const sdpContent = `v=0
o=- 0 0 IN IP4 ${recorderIp}
s=mediasoup recording
c=IN IP4 ${recorderIp}
t=0 0
m=video ${rtpParameters.port} RTP/AVP ${payloadType}
a=rtpmap:${payloadType} ${codec}/${clockRate}
a=sendonly
a=fmtp:${payloadType} x-google-start-bitrate=800;x-google-min-bitrate=400;x-google-max-bitrate=2000`;
  
  return sdpContent;
}

/**
 * Generate FFmpeg arguments for screen recording
 */
function generateFFmpegArgs(recordingType, kind, output) {
  const baseArgs = [
    "-protocol_whitelist", "file,udp,rtp",
    "-loglevel", config.recording.ffmpeg.logLevel,
    "-y",
    "-f", "sdp", // Force SDP format for input
    "-fflags", "+genpts", // Only use valid FFmpeg flags
    "-avoid_negative_ts", "make_zero", // Separate parameter for timestamp handling
    "-analyzeduration", "0", // Analyze input duration
    "-probesize", "32", // Probe size for faster startup
    "-rtbufsize", "64M", // Real-time buffer size
    "-max_delay", "500000", // Maximum delay in microseconds
  ];

  // Screen recording - direct copy for efficiency
  return [
    ...baseArgs,
    "-i", "INPUT_PLACEHOLDER", // Will be replaced with SDP file
    "-c:v", "copy",
    output,
  ];
}

/**
 * Start FFmpeg recording process with enhanced error handling
 */
async function startFFmpegRecording(session, args) {
  return new Promise((resolve, reject) => {
    try {
      session.ffmpeg = spawn("ffmpeg", args);
      session.status = 'recording';
      
      let ffmpegStarted = false;
      let rtpDataReceived = false;
      let hasError = false;

      session.ffmpeg.stderr.on("data", (data) => {
        const message = data.toString();
        
        if (message.includes("Stream mapping:") && !ffmpegStarted) {
          ffmpegStarted = true;
          recordLogger.info('FFmpeg recording started', { 
            producerId: session.producerId,
            type: session.type 
          });
        }
        
        if (message.includes("frame=") || message.includes("size=")) {
          if (!rtpDataReceived) {
            rtpDataReceived = true;
            recordLogger.info('FFmpeg receiving data', { 
              producerId: session.producerId,
              type: session.type 
            });
          }
        }
        
        if (message.toLowerCase().includes("error") || message.toLowerCase().includes("failed")) {
          if (!hasError) {
            hasError = true;
            recordLogger.error('FFmpeg error detected', { 
              producerId: session.producerId,
              error: message.trim() 
            });
          }
        }
      });

      session.ffmpeg.on("close", (code) => {
        session.status = code === 0 ? 'completed' : 'failed';
        
        if (rtpDataReceived) {
          recordLogger.info('FFmpeg recording completed', { 
            producerId: session.producerId,
            exitCode: code,
            duration: Date.now() - session.createdAt.getTime()
          });
        } else {
          recordLogger.warn('FFmpeg recording stopped - no data received', { 
            producerId: session.producerId,
            exitCode: code 
          });
        }
        
        resolve();
      });

      session.ffmpeg.on("error", (error) => {
        session.status = 'error';
        recordLogger.error('FFmpeg process error', { 
          producerId: session.producerId,
          error: error.message 
        });
        reject(new RecordingError(`FFmpeg process error: ${error.message}`));
      });

      // Resolve immediately for async operation
      resolve();
      
    } catch (error) {
      session.status = 'error';
      reject(new RecordingError(`Failed to start FFmpeg: ${error.message}`));
    }
  });
}

/**
 * Create recording session with proper initialization
 */
async function createRecordingSession(producer, router, outputPath, type) {
  const session = new RecordingSession(producer.id, type, outputPath);
  
  try {
    // Ensure output directory exists
    const outputDir = path.dirname(outputPath);
    await fs.mkdir(outputDir, { recursive: true });

    // Create transport
    session.transport = await createRecorderTransport(router);
    const tuple = session.transport.tuple;
    
    if (!tuple?.localIp || !tuple?.localPort) {
      throw new RecordingError('Transport tuple not available');
    }

    // Wait for producer to be active
    await waitForProducerActive(producer);

    // Create consumer
    session.consumer = await session.transport.consume({
      producerId: producer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: true,
      appData: { recording: true, type }
    });

    recordLogger.info('Consumer created for recording', {
      consumerId: session.consumer.id,
      producerId: producer.id,
      type
    });

    // Calculate FFmpeg port and verify availability
    const ffmpegPort = calculateFFmpegPort(tuple.localPort);
    const portAvailable = await isPortAvailable(ffmpegPort);
    
    if (!portAvailable) {
      throw new RecordingError(`Port ${ffmpegPort} is not available`);
    }

    // Generate SDP file
    const payloadType = session.consumer.rtpParameters?.codecs?.[0]?.payloadType || 96;
    const sdpContent = generateSDPContent(
      { port: ffmpegPort }, 
      payloadType, 
      producer.kind, 
      type
    );
    
    session.sdpFile = path.join(outputDir, `temp_${Date.now()}.sdp`);
    await fs.writeFile(session.sdpFile, sdpContent);

    // Generate FFmpeg arguments
    const args = generateFFmpegArgs(type, producer.kind, outputPath);
    // Replace the INPUT_PLACEHOLDER with the actual SDP file path
    const inputIndex = args.indexOf("INPUT_PLACEHOLDER");
    if (inputIndex !== -1) {
      args[inputIndex] = session.sdpFile;
    }

    // Log the final FFmpeg command for debugging
    recordLogger.info('FFmpeg command', {
      producerId: producer.id,
      type,
      command: `ffmpeg ${args.join(' ')}`
    });

    // Start FFmpeg process
    await startFFmpegRecording(session, args);

    // Wait for initialization
    await new Promise(resolve => setTimeout(resolve, config.timeouts.ffmpegInit));

    // Connect transport to FFmpeg
    await session.transport.connect({
      ip: config.recording.recorderIp,
      port: ffmpegPort
    });

    // Wait for connection to stabilize
    await new Promise(resolve => setTimeout(resolve, config.timeouts.transportStabilize));

    // Resume consumer to start data flow
    await session.consumer.resume();
    
    recordLogger.recording('active', {
      producerId: producer.id,
      type,
      outputPath: path.basename(outputPath)
    });

    // Set up cleanup handler
    session.consumer.on('@close', () => {
      recordLogger.recording('ended', { producerId: producer.id, type });
      session.cleanup();
    });

    return session;

  } catch (error) {
    await session.cleanup();
    throw error;
  }
}

/**
 * Create screen recording session
 */
async function createConsumerAndRecord(producer, router, filename) {
  try {
    validateRequired({ producer, router, filename }, ['producer', 'router', 'filename']);
    
    recordLogger.recording('starting', { 
      type: 'screen',
      filename: path.basename(filename) 
    });

    const session = await createRecordingSession(
      producer, 
      router, 
      filename, 
      'screen'
    );

    return session;
  } catch (error) {
    recordLogger.error('Screen recording error', { error: error.message });
    throw new RecordingError(`Screen recording failed: ${error.message}`);
  }
}

module.exports = {
  createRecorderTransport,
  startFFmpegRecording,
  createConsumerAndRecord,
  RecordingSession,
};