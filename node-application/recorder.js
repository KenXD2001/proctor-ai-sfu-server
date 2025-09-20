const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const net = require("net");

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

async function createRecorderTransport(router) {
  // Use PlainTransport for recording with correct configuration (based on working mediasoup3-record-demo)
  const transport = await router.createPlainTransport({
    listenIp: { ip: "127.0.0.1", announcedIp: "127.0.0.1" },
    rtcpMux: true, // Enable RTCP muxing (as per working example)
    comedia: false, // Disable comedia mode (as per working example)
  });

  const tuple = transport.tuple;
  if (!tuple || !tuple.localIp || !tuple.localPort) {
    console.error(`[Recorder] Transport tuple not available`);
    throw new Error('Transport tuple not available after creation');
  }

  console.log(`[Recorder Transport] Created: ID=${transport.id} IP=${tuple.localIp}:${tuple.localPort}`);

  // Add transport event listeners
  transport.on('@close', () => {
    console.log(`[Recorder] Transport closed: ${transport.id}`);
  });

  return transport;
}

async function startFfmpegRecording({ rtpParameters, output, kind, consumerRtpParams }) {
  // Ensure recordings directory exists
  const recordingsDir = path.dirname(output);
  if (!fs.existsSync(recordingsDir)) {
    fs.mkdirSync(recordingsDir, { recursive: true });
  }

  // Since we only record screen share video streams, validate the kind
  if (kind !== 'video') {
    throw new Error(`Expected video stream for screen recording, got: ${kind}`);
  }

  // Get the actual payload type from consumer RTP parameters
  const payloadType = consumerRtpParams?.codecs?.[0]?.payloadType || 96;
  console.log(`[FFmpeg] Using payload type: ${payloadType} from consumer RTP parameters`);

  // Create SDP file for FFmpeg (rtcpMux: true, so no separate RTCP port)
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

  // Use FFmpeg to receive RTP stream with SDP file
  const args = [
    "-protocol_whitelist", "file,udp,rtp",
    "-i", sdpFile, // Use SDP file for RTP format description
    "-c:v", "copy", // Copy the VP8 stream without re-encoding
    "-fflags", "+genpts", // Generate presentation timestamps
    "-avoid_negative_ts", "make_zero", // Avoid negative timestamps
    "-loglevel", "info", // Reduce logging verbosity
    "-timeout", "5000000", // 5 second timeout
    "-y",
    output,
  ];

  console.log(`[FFmpeg] Starting recording: ${output}`);
  console.log(`[FFmpeg] Command: ffmpeg ${args.join(' ')}`);
  console.log(`[FFmpeg] Listening on port: ${rtpParameters.port}`);
  
  // Check if port is available
  const portAvailable = await isPortAvailable(rtpParameters.port);
  if (!portAvailable) {
    console.error(`[FFmpeg] Port ${rtpParameters.port} is not available`);
    throw new Error(`Port ${rtpParameters.port} is not available`);
  }
  
  // Start FFmpeg directly without netcat
  const ffmpeg = spawn("ffmpeg", args);

  // Track FFmpeg startup
  let ffmpegStarted = false;
  let rtpDataReceived = false;
  let lastDataTime = Date.now();
  let frameCount = 0;

  ffmpeg.stderr.on("data", (data) => {
    const message = data.toString();
    const now = Date.now();
    
    // Log all FFmpeg output for debugging (first few lines)
    if (!ffmpegStarted) {
      console.log(`[FFmpeg] Output: ${message.trim()}`);
    }
    
    // Track if FFmpeg has started successfully
    if (message.includes("Stream mapping:") && !ffmpegStarted) {
      ffmpegStarted = true;
      console.log(`[FFmpeg] Started successfully - listening on IP=127.0.0.1:${rtpParameters.port}`);
    }
    
    // Track if we're receiving RTP data and frames
    if (message.includes("frame=") || message.includes("size=")) {
      if (!rtpDataReceived) {
        rtpDataReceived = true;
        console.log(`[FFmpeg] RTP data received - recording active on IP=127.0.0.1:${rtpParameters.port}`);
      }
      lastDataTime = now;
      
      // Extract frame count
      const frameMatch = message.match(/frame=\s*(\d+)/);
      if (frameMatch) {
        frameCount = parseInt(frameMatch[1]);
        if (frameCount % 30 === 0) { // Log every 30 frames
          console.log(`[FFmpeg] Processed ${frameCount} frames`);
        }
      }
    }
    
    // Log errors and important messages
    if (message.toLowerCase().includes("error") || message.toLowerCase().includes("failed") || message.toLowerCase().includes("warning")) {
      console.error(`[FFmpeg] ${message.trim()}`);
    }
    
    // Log any input-related issues
    if (message.includes("Input") || message.includes("rtp://") || message.includes("Connection")) {
      console.log(`[FFmpeg] Input: ${message.trim()}`);
    }
  });

  // Handle FFmpeg errors
  ffmpeg.on("close", (code) => {
    if (rtpDataReceived) {
      console.log(`[FFmpeg] Recording completed successfully with code: ${code}`);
    } else {
      console.log(`[FFmpeg] Recording stopped - no data received, code: ${code}`);
    }
    // Clean up SDP file
    try {
      if (fs.existsSync(sdpFile)) {
        fs.unlinkSync(sdpFile);
        console.log(`[FFmpeg] Cleaned up SDP file: ${sdpFile}`);
      }
    } catch (err) {
      console.error(`[FFmpeg] Error cleaning up SDP file: ${err.message}`);
    }
  });

  ffmpeg.on("error", (err) => {
    console.error(`[FFmpeg] Error: ${err.message}`);
    // Clean up SDP file on error
    try {
      if (fs.existsSync(sdpFile)) {
        fs.unlinkSync(sdpFile);
        console.log(`[FFmpeg] Cleaned up SDP file after error: ${sdpFile}`);
      }
    } catch (cleanupErr) {
      console.error(`[FFmpeg] Error cleaning up SDP file: ${cleanupErr.message}`);
    }
  });

  // Also log stdout for additional debugging
  ffmpeg.stdout.on("data", (data) => {
    const message = data.toString();
    if (message.trim()) {
      console.log(`[FFmpeg] Stdout: ${message.trim()}`);
    }
  });

  // Monitor for RTP data every 10 seconds
  const dataMonitor = setInterval(() => {
    const now = Date.now();
    if (ffmpegStarted && !rtpDataReceived && (now - lastDataTime) > 10000) {
      console.log(`[FFmpeg] Warning: No RTP data received in 10 seconds`);
    }
  }, 10000);

  // Monitor for FFmpeg startup timeout
  const startupTimeout = setTimeout(() => {
    if (!ffmpegStarted) {
      console.error(`[FFmpeg] Startup timeout - FFmpeg may be hanging on port ${rtpParameters.port}`);
    }
  }, 10000);

  // Clean up monitor when FFmpeg closes
  ffmpeg.on("close", () => {
    clearInterval(dataMonitor);
    clearTimeout(startupTimeout);
  });

  return { ffmpeg };
}

async function createConsumerAndRecord(producer, router, filename) {
  try {
    console.log(`[Screen Recorder] Starting screen recording: ${producer.kind} -> ${filename}`);

    // 1. Create PlainTransport
    const transport = await createRecorderTransport(router);

    // 2. Get transport tuple
    const tuple = transport.tuple;
    if (!tuple || !tuple.localIp || !tuple.localPort) {
      throw new Error('Transport tuple not available');
    }

    // 3. Wait for producer to be active and sending data
    console.log(`[Producer] Waiting for producer to be active: ${producer.id}`);
    console.log(`[Producer] Producer state: paused=${producer.paused}, closed=${producer.closed}, kind=${producer.kind}`);
    
    // Wait for producer to start sending data
    let producerActive = false;
    const producerMonitor = setInterval(() => {
      console.log(`[Producer] Monitoring: paused=${producer.paused}, closed=${producer.closed}`);
      if (!producer.paused && !producer.closed) {
        producerActive = true;
        clearInterval(producerMonitor);
      }
    }, 1000);
    
    // Wait up to 10 seconds for producer to be active
    let waitTime = 0;
    while (!producerActive && waitTime < 10000) {
      await new Promise(resolve => setTimeout(resolve, 500));
      waitTime += 500;
    }
    
    clearInterval(producerMonitor);
    console.log(`[Producer] Producer active: ${producerActive}, waited: ${waitTime}ms`);
    
    // 4. Create consumer on the PlainTransport
    console.log(`[Consumer] Creating consumer for producer: ${producer.id}`);
    console.log(`[Consumer] Producer transport: ${producer.transportId}`);
    console.log(`[Consumer] Recording transport: ${transport.id}`);
    
    const consumer = await transport.consume({
      producerId: producer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: true, // Start paused
      appData: { recording: true }
    });

    // Log consumer creation with transport details
    const consumerTransportInfo = `TransportID=${transport.id}`;
    console.log(`[Consumer] Created: ID=${consumer.id} ProducerID=${producer.id} ${consumerTransportInfo}`);
    
    // Log consumer RTP parameters for debugging
    console.log(`[Consumer] RTP Parameters: ${JSON.stringify(consumer.rtpParameters, null, 2)}`);
    
    // Add consumer event listeners
    consumer.on('transportclose', () => {
      console.log(`[Consumer] Transport closed: ${consumer.id}`);
    });

    consumer.on('producerclose', () => {
      console.log(`[Consumer] Producer closed: ${consumer.id}`);
    });

    consumer.on('@close', () => {
      console.log(`[Consumer] Consumer closed: ${consumer.id}`);
    });

    // Add transport event listeners
    transport.on('@close', () => {
      console.log(`[Transport] Transport closed: ${transport.id}`);
    });

    transport.on('@connect', () => {
      console.log(`[Transport] Transport connected: ${transport.id}`);
    });

    // 4. Start FFmpeg with RTP input
    let ffmpegPort = tuple.localPort + 10000;
    if (ffmpegPort > 65535) {
      ffmpegPort = tuple.localPort + 1000;
      if (ffmpegPort > 65535) {
        ffmpegPort = 50000 + (tuple.localPort % 1000);
      }
    }
    
    console.log(`[FFmpeg] Starting FFmpeg on port: ${ffmpegPort} (Transport port: ${tuple.localPort})`);
    
    const { ffmpeg } = await startFfmpegRecording({
      rtpParameters: { 
        ip: tuple.localIp, 
        port: ffmpegPort
      },
      output: filename,
      kind: producer.kind,
      consumerRtpParams: consumer.rtpParameters,
    });
    
    // 5. Wait for FFmpeg to start listening
    console.log(`[FFmpeg] Waiting for FFmpeg to start listening...`);
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // 6. Connect PlainTransport to send RTP to FFmpeg
    console.log(`[FFmpeg] Connecting transport to FFmpeg: 127.0.0.1:${ffmpegPort}`);
    console.log(`[Transport] Before connect - tuple: ${JSON.stringify(transport.tuple)}`);
    
    try {
      await transport.connect({
        ip: '127.0.0.1',
        port: ffmpegPort
      });
      
      console.log(`[Transport] After connect - tuple: ${JSON.stringify(transport.tuple)}`);
      console.log(`[FFmpeg] Connected: IP=127.0.0.1:${ffmpegPort} ConsumerID=${consumer.id} ProducerID=${producer.id}`);
    } catch (error) {
      console.error(`[Transport] Failed to connect to FFmpeg: ${error.message}`);
      // Clean up on connection failure
      if (ffmpeg && !ffmpeg.killed) {
        ffmpeg.kill('SIGTERM');
      }
      throw error;
    }
    
    // 7. Wait a bit more for everything to be connected
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 8. Resume the consumer to start receiving data
    await consumer.resume();
    console.log(`[Consumer] Resumed consumer: ${consumer.id}`);
    
    // 8. Log consumer state
    console.log(`[Consumer] State: paused=${consumer.paused}, kind=${consumer.kind}, producerId=${consumer.producerId}`);
    
    // 9. Log producer state
    console.log(`[Producer] State: paused=${producer.paused}, kind=${producer.kind}, id=${producer.id}`);
    
    // 10. Add data flow monitoring
    let packetCount = 0;
    const dataMonitor = setInterval(() => {
      console.log(`[Data Flow] Packets processed: ${packetCount}, Consumer paused: ${consumer.paused}, Producer paused: ${producer.paused}`);
    }, 5000);
    
    // 11. Monitor consumer for data with multiple event types
    consumer.on('@produce', (data) => {
      packetCount++;
      if (packetCount % 100 === 0) {
        console.log(`[Consumer] Processed ${packetCount} packets via @produce`);
      }
    });
    
    // Try other events
    consumer.on('message', (data) => {
      packetCount++;
      if (packetCount % 100 === 0) {
        console.log(`[Consumer] Processed ${packetCount} packets via message`);
      }
    });
    
    consumer.on('data', (data) => {
      packetCount++;
      if (packetCount % 100 === 0) {
        console.log(`[Consumer] Processed ${packetCount} packets via data`);
      }
    });
    
    consumer.on('rtp', (data) => {
      packetCount++;
      if (packetCount % 100 === 0) {
        console.log(`[Consumer] Processed ${packetCount} packets via rtp`);
      }
    });
    
    // 12. Monitor transport for data being sent
    transport.on('@produce', (data) => {
      console.log(`[Transport] Sending data to FFmpeg: ${JSON.stringify(data)}`);
    });
    
    // 13. Add producer monitoring
    producer.on('@produce', (data) => {
      console.log(`[Producer] Producer sending data: ${JSON.stringify(data)}`);
    });
    
    // 13. Force consumer to start producing data
    if (consumer.paused) {
      await consumer.resume();
      console.log(`[Consumer] Forced resume of consumer: ${consumer.id}`);
    }
    
    // 14. Ensure transport is ready to receive data
    console.log(`[Transport] Transport state: ${transport.closed ? 'closed' : 'open'}`);
    
    // 15. Add a small delay to ensure everything is connected
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log(`[Screen Recorder] Screen recording started: ${producer.kind} -> ${filename}`);

    // Clean up monitor when consumer closes
    consumer.on('@close', () => {
      console.log(`[Recorder] Recording ended: ${filename}`);
      clearInterval(dataMonitor);
      // Stop FFmpeg process when consumer closes
      if (ffmpeg && !ffmpeg.killed) {
        ffmpeg.kill('SIGTERM');
        console.log(`[FFmpeg] Stopped recording: ${filename}`);
      }
    });

    return { consumer, transport, ffmpeg };
  } catch (error) {
    console.error('[Recorder] Error creating consumer and record:', error);
    throw error;
  }
}

module.exports = {
  createRecorderTransport,
  startFfmpegRecording,
  createConsumerAndRecord,
};