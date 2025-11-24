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
const { uploadAndSaveRecording } = require('./uploadService');

const recordLogger = createLogger('Recorder');

/**
 * Recording session manager
 */
class RecordingSession {
  constructor(producerId, type, outputPath, examId = null, batchId = null, candidateId = null) {
    this.producerId = producerId;
    this.type = type;
    this.outputPath = outputPath;
    this.examId = examId;
    this.batchId = batchId;
    this.candidateId = candidateId;
    this.ffmpeg = null;
    this.consumer = null;
    this.consumers = []; // For combined recording (video + audio)
    this.transport = null;
    this.transports = []; // For combined recording
    this.sdpFile = null;
    this.sdpFiles = []; // For combined recording
    this.createdAt = new Date();
    this.status = 'initializing';
    this.uploaded = false; // Track if uploaded to S3
  }

  async cleanup() {
    this.status = 'cleaning';
    
    try {
      // Calculate duration
      const duration = Math.floor((Date.now() - this.createdAt.getTime()) / 1000);
      
      // Upload to S3 before cleanup if we have the required IDs and file exists
      if (this.examId && this.candidateId && this.outputPath && !this.uploaded) {
        try {
          // Check if file exists and get stats
          if (fsSync.existsSync(this.outputPath)) {
            const stats = fsSync.statSync(this.outputPath);
            
            await uploadAndSaveRecording(
              this.outputPath,
              this.examId,
              this.batchId,
              this.candidateId,
              this.type,
              {
                recordingStartedAt: this.createdAt.toISOString(),
                recordingEndedAt: new Date().toISOString(),
                durationSeconds: duration,
                fileSizeBytes: stats.size,
                exitReason: 'disconnect' // Default exit reason
              }
            );
            
            this.uploaded = true;
            recordLogger.info('Recording uploaded to S3 during cleanup', {
              producerId: this.producerId,
              type: this.type,
              outputPath: this.outputPath
            });
          } else {
            recordLogger.warn('Recording file not found for upload', {
              producerId: this.producerId,
              outputPath: this.outputPath
            });
          }
        } catch (uploadError) {
          // Log error but don't fail cleanup
          recordLogger.error('Failed to upload recording during cleanup', {
            producerId: this.producerId,
            error: uploadError.message,
            outputPath: this.outputPath
          });
        }
      }
      
      // Stop FFmpeg process
      if (this.ffmpeg && !this.ffmpeg.killed) {
        this.ffmpeg.kill('SIGTERM');
        recordLogger.info('FFmpeg process terminated', { producerId: this.producerId });
      }
      
      // Close consumer(s)
      if (this.consumer) {
        this.consumer.close();
        recordLogger.info('Consumer closed', { producerId: this.producerId });
      }
      if (this.consumers && this.consumers.length > 0) {
        for (const consumer of this.consumers) {
          if (consumer) consumer.close();
        }
        recordLogger.info('Consumers closed', { producerId: this.producerId, count: this.consumers.length });
      }
      
      // Close transport(s)
      if (this.transport) {
        this.transport.close();
        recordLogger.info('Transport closed', { producerId: this.producerId });
      }
      if (this.transports && this.transports.length > 0) {
        for (const transport of this.transports) {
          if (transport) transport.close();
        }
        recordLogger.info('Transports closed', { producerId: this.producerId, count: this.transports.length });
      }
      
      // Clean up SDP file(s)
      if (this.sdpFile && fsSync.existsSync(this.sdpFile)) {
        await fs.unlink(this.sdpFile);
        recordLogger.info('SDP file cleaned up', { sdpFile: this.sdpFile });
      }
      if (this.sdpFiles && this.sdpFiles.length > 0) {
        for (const sdpFile of this.sdpFiles) {
          if (sdpFile && fsSync.existsSync(sdpFile)) {
            await fs.unlink(sdpFile);
          }
        }
        recordLogger.info('SDP files cleaned up', { producerId: this.producerId, count: this.sdpFiles.length });
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
 * Generate SDP content for FFmpeg (supports both video and audio)
 */
function generateSDPContent(rtpParameters, payloadType, kind, recordingType) {
  const recorderIp = config.recording.recorderIp;
  
  let codec, clockRate, mediaType, fmtpLine;
  
  if (kind === 'audio') {
    // Audio recording - Opus codec
    codec = 'OPUS';
    clockRate = 48000;
    mediaType = 'audio';
    fmtpLine = `a=fmtp:${payloadType} minptime=10;useinbandfec=1`;
  } else {
    // Video recording - VP8 codec
    codec = 'VP8';
    clockRate = 90000;
    mediaType = 'video';
    fmtpLine = `a=fmtp:${payloadType} x-google-start-bitrate=800;x-google-min-bitrate=400;x-google-max-bitrate=2000`;
  }
  
  const sdpContent = `v=0
o=- 0 0 IN IP4 ${recorderIp}
s=mediasoup recording
c=IN IP4 ${recorderIp}
t=0 0
m=${mediaType} ${rtpParameters.port} RTP/AVP ${payloadType}
a=rtpmap:${payloadType} ${codec}/${clockRate}
a=sendonly
${fmtpLine}`;
  
  return sdpContent;
}

/**
 * Generate FFmpeg arguments for recording (supports both video and audio)
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

  if (kind === 'audio') {
    // Audio recording - copy codec for efficiency
    return [
      ...baseArgs,
      "-i", "INPUT_PLACEHOLDER", // Will be replaced with SDP file
      "-c:a", "copy",
      output,
    ];
  } else {
    // Video recording - direct copy for efficiency
    return [
      ...baseArgs,
      "-i", "INPUT_PLACEHOLDER", // Will be replaced with SDP file
      "-c:v", "copy",
      output,
    ];
  }
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
async function createRecordingSession(producer, router, outputPath, type, examId = null, batchId = null, candidateId = null) {
  const session = new RecordingSession(producer.id, type, outputPath, examId, batchId, candidateId);
  
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
<<<<<<< HEAD
 * Generate combined SDP content for FFmpeg (video + audio)
 */
function generateCombinedSDPContent(videoRtpParams, audioRtpParams, videoPayloadType, audioPayloadType) {
  const recorderIp = config.recording.recorderIp;
  
  const sdpContent = `v=0
o=- 0 0 IN IP4 ${recorderIp}
s=mediasoup combined recording
c=IN IP4 ${recorderIp}
t=0 0
m=video ${videoRtpParams.port} RTP/AVP ${videoPayloadType}
a=rtpmap:${videoPayloadType} VP8/90000
a=sendonly
a=fmtp:${videoPayloadType} x-google-start-bitrate=800;x-google-min-bitrate=400;x-google-max-bitrate=2000
m=audio ${audioRtpParams.port} RTP/AVP ${audioPayloadType}
a=rtpmap:${audioPayloadType} OPUS/48000
a=sendonly
a=fmtp:${audioPayloadType} minptime=10;useinbandfec=1`;
  
  return sdpContent;
}

/**
 * Generate FFmpeg arguments for combined recording (video + audio)
 */
function generateCombinedFFmpegArgs(videoSdpFile, audioSdpFile, output) {
  return [
    "-protocol_whitelist", "file,udp,rtp",
    "-loglevel", config.recording.ffmpeg.logLevel,
    "-y",
    "-f", "sdp",
    "-fflags", "+genpts",
    "-avoid_negative_ts", "make_zero",
    "-analyzeduration", "0",
    "-probesize", "32",
    "-rtbufsize", "64M",
    "-max_delay", "500000",
    "-i", videoSdpFile,
    "-f", "sdp",
    "-fflags", "+genpts",
    "-avoid_negative_ts", "make_zero",
    "-analyzeduration", "0",
    "-probesize", "32",
    "-rtbufsize", "64M",
    "-max_delay", "500000",
    "-i", audioSdpFile,
    "-c:v", "copy",
    "-c:a", "copy",
    "-map", "0:v:0",
    "-map", "1:a:0",
    output,
  ];
}

/**
 * Create combined webcam recording session (video + audio together)
 */
async function createCombinedWebcamRecording(videoProducer, audioProducer, router, outputPath, examId = null, batchId = null, candidateId = null) {
  const session = new RecordingSession(videoProducer.id, 'webcam', outputPath, examId, batchId, candidateId);
  
  try {
    // Ensure output directory exists
    const outputDir = path.dirname(outputPath);
    await fs.mkdir(outputDir, { recursive: true });

    // Wait for both producers to be active
    await waitForProducerActive(videoProducer);
    await waitForProducerActive(audioProducer);

    // Create transports for video and audio
    const videoTransport = await createRecorderTransport(router);
    const audioTransport = await createRecorderTransport(router);
    session.transports = [videoTransport, audioTransport];
    
    const videoTuple = videoTransport.tuple;
    const audioTuple = audioTransport.tuple;
    
    if (!videoTuple?.localIp || !videoTuple?.localPort || !audioTuple?.localIp || !audioTuple?.localPort) {
      throw new RecordingError('Transport tuples not available');
    }

    // Create consumers for video and audio
    const videoConsumer = await videoTransport.consume({
      producerId: videoProducer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: true,
      appData: { recording: true, type: 'webcam', kind: 'video' }
    });

    const audioConsumer = await audioTransport.consume({
      producerId: audioProducer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: true,
      appData: { recording: true, type: 'webcam', kind: 'audio' }
    });

    session.consumers = [videoConsumer, audioConsumer];

    recordLogger.info('Consumers created for combined recording', {
      videoConsumerId: videoConsumer.id,
      audioConsumerId: audioConsumer.id,
      videoProducerId: videoProducer.id,
      audioProducerId: audioProducer.id
    });

    // Calculate FFmpeg ports
    const videoFFmpegPort = calculateFFmpegPort(videoTuple.localPort);
    const audioFFmpegPort = calculateFFmpegPort(audioTuple.localPort);
    
    const videoPortAvailable = await isPortAvailable(videoFFmpegPort);
    const audioPortAvailable = await isPortAvailable(audioFFmpegPort);
    
    if (!videoPortAvailable || !audioPortAvailable) {
      throw new RecordingError(`Ports ${videoFFmpegPort} or ${audioFFmpegPort} not available`);
    }

    // Generate SDP files
    const videoPayloadType = videoConsumer.rtpParameters?.codecs?.[0]?.payloadType || 96;
    const audioPayloadType = audioConsumer.rtpParameters?.codecs?.[0]?.payloadType || 111;
    
    // Create combined SDP file (better approach: use separate SDP files and combine in FFmpeg)
    const videoSdpContent = generateSDPContent({ port: videoFFmpegPort }, videoPayloadType, 'video', 'webcam');
    const audioSdpContent = generateSDPContent({ port: audioFFmpegPort }, audioPayloadType, 'audio', 'webcam');
    
    const timestamp = Date.now();
    const videoSdpFile = path.join(outputDir, `temp_video_${timestamp}.sdp`);
    const audioSdpFile = path.join(outputDir, `temp_audio_${timestamp}.sdp`);
    
    session.sdpFiles = [videoSdpFile, audioSdpFile];
    
    await fs.writeFile(videoSdpFile, videoSdpContent);
    await fs.writeFile(audioSdpFile, audioSdpContent);

    // Generate FFmpeg arguments for combined recording
    const args = generateCombinedFFmpegArgs(videoSdpFile, audioSdpFile, outputPath);

    // Log the final FFmpeg command
    recordLogger.info('FFmpeg combined command', {
      videoProducerId: videoProducer.id,
      audioProducerId: audioProducer.id,
      command: `ffmpeg ${args.join(' ')}`
    });

    // Start FFmpeg process
    await startFFmpegRecording(session, args);

    // Wait for initialization
    await new Promise(resolve => setTimeout(resolve, config.timeouts.ffmpegInit));

    // Connect transports to FFmpeg
    await videoTransport.connect({
      ip: config.recording.recorderIp,
      port: videoFFmpegPort
    });

    await audioTransport.connect({
      ip: config.recording.recorderIp,
      port: audioFFmpegPort
    });

    // Wait for connection to stabilize
    await new Promise(resolve => setTimeout(resolve, config.timeouts.transportStabilize));

    // Resume consumers to start data flow
    await videoConsumer.resume();
    await audioConsumer.resume();
    
    recordLogger.recording('active', {
      producerId: videoProducer.id,
      type: 'webcam',
      kind: 'combined',
      outputPath: path.basename(outputPath)
    });

    // Set up cleanup handlers
    videoConsumer.on('@close', () => {
      recordLogger.recording('ended', { producerId: videoProducer.id, type: 'webcam-video' });
      session.cleanup();
    });

    audioConsumer.on('@close', () => {
      recordLogger.recording('ended', { producerId: audioProducer.id, type: 'webcam-audio' });
      session.cleanup();
    });

    return session;

  } catch (error) {
    await session.cleanup();
    throw error;
  }
}

/**
 * Create recording session (supports screen, webcam video, and audio)
 */
async function createConsumerAndRecord(producer, router, filename, recordingType = 'screen', examId = null, batchId = null, candidateId = null) {
  try {
    validateRequired({ producer, router, filename }, ['producer', 'router', 'filename']);
    
    recordLogger.recording('starting', { 
      type: recordingType,
      kind: producer.kind,
      filename: path.basename(filename) 
    });

    const session = await createRecordingSession(
      producer, 
      router, 
      filename, 
      recordingType,
      examId,
      batchId,
      candidateId
    );

    return session;
  } catch (error) {
    recordLogger.error('Recording error', { 
      type: recordingType,
      kind: producer.kind,
      error: error.message 
    });
    throw new RecordingError(`${recordingType} recording failed: ${error.message}`);
  }
}

module.exports = {
  createRecorderTransport,
  startFFmpegRecording,
  createConsumerAndRecord,
  createCombinedWebcamRecording,
  RecordingSession,
};