const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const net = require("net");

/**
 * Checks if a port is available for use
 * @param {number} port - Port number to check
 * @returns {Promise<boolean>} - True if port is available
 */
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      server.once('close', () => {
        resolve(true);
      });
      server.close();
    });
    server.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Creates a PlainTransport for recording RTP streams
 * Uses rtcpMux: true and comedia: false for optimal recording performance
 * @param {Object} router - mediasoup router instance
 * @returns {Promise<Object>} - PlainTransport instance
 */
async function createRecorderTransport(router) {
  const transport = await router.createPlainTransport({
    listenIp: { ip: "127.0.0.1", announcedIp: "127.0.0.1" },
    rtcpMux: true,
    comedia: false,
  });

  const tuple = transport.tuple;
  if (!tuple || !tuple.localIp || !tuple.localPort) {
    throw new Error('Transport tuple not available after creation');
  }

  console.log(`[Recorder] Transport created: ${transport.id} on ${tuple.localIp}:${tuple.localPort}`);

  transport.on('@close', () => {
    console.log(`[Recorder] Transport closed: ${transport.id}`);
  });

  return transport;
}

/**
 * Starts FFmpeg process to record RTP stream to WebM file
 * Creates SDP file for FFmpeg to understand RTP stream format
 * @param {Object} params - Recording parameters
 * @param {Object} params.rtpParameters - RTP connection parameters
 * @param {string} params.output - Output file path
 * @param {string} params.kind - Media kind (video/audio)
 * @param {Object} params.consumerRtpParams - Consumer RTP parameters
 * @returns {Promise<Object>} - FFmpeg process instance
 */
async function startFfmpegRecording({ rtpParameters, output, kind, consumerRtpParams }) {
  const recordingsDir = path.dirname(output);
  if (!fs.existsSync(recordingsDir)) {
    fs.mkdirSync(recordingsDir, { recursive: true });
  }

  if (kind !== 'video') {
    throw new Error(`Expected video stream for screen recording, got: ${kind}`);
  }

  const payloadType = consumerRtpParams?.codecs?.[0]?.payloadType || 96;

  // Create SDP file for FFmpeg RTP input
  const sdpContent = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=mediasoup recording
c=IN IP4 127.0.0.1
t=0 0
m=video ${rtpParameters.port} RTP/AVP ${payloadType}
a=rtpmap:${payloadType} VP8/90000
a=sendonly`;

  const sdpFile = path.join(path.dirname(output), `temp_${Date.now()}.sdp`);
  fs.writeFileSync(sdpFile, sdpContent);

  const args = [
    "-protocol_whitelist", "file,udp,rtp",
    "-i", sdpFile,
    "-c:v", "copy",
    "-fflags", "+genpts",
    "-avoid_negative_ts", "make_zero",
    "-loglevel", "error",
    "-timeout", "5000000",
    "-y",
    output,
  ];

  console.log(`[FFmpeg] Starting recording: ${path.basename(output)}`);
  
  const portAvailable = await isPortAvailable(rtpParameters.port);
  if (!portAvailable) {
    throw new Error(`Port ${rtpParameters.port} is not available`);
  }
  
  const ffmpeg = spawn("ffmpeg", args);

  let ffmpegStarted = false;
  let rtpDataReceived = false;

  ffmpeg.stderr.on("data", (data) => {
    const message = data.toString();
    
    if (message.includes("Stream mapping:") && !ffmpegStarted) {
      ffmpegStarted = true;
      console.log(`[FFmpeg] Recording started successfully`);
    }
    
    if (message.includes("frame=") || message.includes("size=")) {
      if (!rtpDataReceived) {
        rtpDataReceived = true;
        console.log(`[FFmpeg] Receiving video data`);
      }
    }
    
    if (message.toLowerCase().includes("error") || message.toLowerCase().includes("failed")) {
      console.error(`[FFmpeg] ${message.trim()}`);
    }
  });

  ffmpeg.on("close", (code) => {
    if (rtpDataReceived) {
      console.log(`[FFmpeg] Recording completed successfully`);
    } else {
      console.log(`[FFmpeg] Recording stopped - no data received`);
    }
    
    try {
      if (fs.existsSync(sdpFile)) {
        fs.unlinkSync(sdpFile);
      }
    } catch (err) {
      console.error(`[FFmpeg] Error cleaning up SDP file: ${err.message}`);
    }
  });

  ffmpeg.on("error", (err) => {
    console.error(`[FFmpeg] Process error: ${err.message}`);
    try {
      if (fs.existsSync(sdpFile)) {
        fs.unlinkSync(sdpFile);
      }
    } catch (cleanupErr) {
      console.error(`[FFmpeg] Error cleaning up SDP file: ${cleanupErr.message}`);
    }
  });

  return { ffmpeg };
}

/**
 * Creates a consumer on PlainTransport and starts recording the producer stream
 * This is the main function that orchestrates the recording process
 * @param {Object} producer - mediasoup producer instance
 * @param {Object} router - mediasoup router instance
 * @param {string} filename - Output filename for recording
 * @returns {Promise<Object>} - Recording session with consumer, transport, and ffmpeg
 */
async function createConsumerAndRecord(producer, router, filename) {
  try {
    console.log(`[Recorder] Starting screen recording: ${path.basename(filename)}`);

    // Create PlainTransport for recording
    const transport = await createRecorderTransport(router);
    const tuple = transport.tuple;
    
    if (!tuple || !tuple.localIp || !tuple.localPort) {
      throw new Error('Transport tuple not available');
    }

    // Wait for producer to be active
    let producerActive = false;
    const producerMonitor = setInterval(() => {
      if (!producer.paused && !producer.closed) {
        producerActive = true;
        clearInterval(producerMonitor);
      }
    }, 1000);
    
    let waitTime = 0;
    while (!producerActive && waitTime < 10000) {
      await new Promise(resolve => setTimeout(resolve, 500));
      waitTime += 500;
    }
    
    clearInterval(producerMonitor);
    
    if (!producerActive) {
      throw new Error('Producer did not become active within timeout');
    }
    
    // Create consumer on PlainTransport
    const consumer = await transport.consume({
      producerId: producer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: true,
      appData: { recording: true }
    });

    console.log(`[Recorder] Consumer created: ${consumer.id}`);

    // Calculate FFmpeg port
    let ffmpegPort = tuple.localPort + 10000;
    if (ffmpegPort > 65535) {
      ffmpegPort = tuple.localPort + 1000;
      if (ffmpegPort > 65535) {
        ffmpegPort = 50000 + (tuple.localPort % 1000);
      }
    }
    
    // Start FFmpeg recording process
    const { ffmpeg } = await startFfmpegRecording({
      rtpParameters: { 
        ip: tuple.localIp, 
        port: ffmpegPort
      },
      output: filename,
      kind: producer.kind,
      consumerRtpParams: consumer.rtpParameters,
    });
    
    // Wait for FFmpeg to initialize
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Connect PlainTransport to FFmpeg
    await transport.connect({
      ip: '127.0.0.1',
      port: ffmpegPort
    });
    
    // Wait for connection to stabilize
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Resume consumer to start data flow
    await consumer.resume();
    console.log(`[Recorder] Recording active: ${path.basename(filename)}`);

    // Clean up when consumer closes
    consumer.on('@close', () => {
      console.log(`[Recorder] Recording ended: ${path.basename(filename)}`);
      if (ffmpeg && !ffmpeg.killed) {
        ffmpeg.kill('SIGTERM');
      }
    });

    return { consumer, transport, ffmpeg };
  } catch (error) {
    console.error('[Recorder] Error:', error.message);
    throw error;
  }
}

module.exports = {
  createRecorderTransport,
  startFfmpegRecording,
  createConsumerAndRecord,
};