const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

async function createRecorderTransport(router) {
  const transport = await router.createPlainTransport({
    listenIp: { ip: "127.0.0.1", announcedIp: "127.0.0.1" },
    rtcpMux: true,
    comedia: true,
  });

  const tuple = transport.tuple;
  if (!tuple || !tuple.localIp || !tuple.localPort) {
    console.error(`[Recorder] Transport tuple not available`);
    throw new Error('Transport tuple not available after creation');
  }

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

  // Use FFmpeg to receive RTP stream from PlainTransport for video only
  const args = [
    "-protocol_whitelist", "file,udp,rtp",
    "-f", "rtp",
    "-payload_type", payloadType.toString(),
    "-i", `rtp://127.0.0.1:${rtpParameters.port}`,
    "-c:v", "libx264",
    "-preset", "ultrafast", // Fast encoding for real-time
    "-tune", "zerolatency", // Low latency
    "-y",
    output,
  ];

  console.log(`[FFmpeg] Starting recording: ${output}`);
  
  const ffmpeg = spawn("ffmpeg", args);

  // Track FFmpeg startup
  let ffmpegStarted = false;
  let rtpDataReceived = false;
  let lastDataTime = Date.now();

  ffmpeg.stderr.on("data", (data) => {
    const message = data.toString();
    const now = Date.now();
    
    // Track if FFmpeg has started successfully
    if (message.includes("Stream mapping:") && !ffmpegStarted) {
      ffmpegStarted = true;
      console.log(`[FFmpeg] Started successfully`);
    }
    
    // Track if we're receiving RTP data
    if (message.includes("frame=") || message.includes("size=")) {
      if (!rtpDataReceived) {
        rtpDataReceived = true;
        console.log(`[FFmpeg] RTP data received - recording active`);
      }
      lastDataTime = now;
    }
    
    // Log errors only
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
  });

  ffmpeg.on("error", (err) => {
    console.error(`[FFmpeg] Error: ${err.message}`);
  });

  // Monitor for RTP data every 10 seconds
  const dataMonitor = setInterval(() => {
    const now = Date.now();
    if (ffmpegStarted && !rtpDataReceived && (now - lastDataTime) > 10000) {
      console.log(`[FFmpeg] Warning: No RTP data received in 10 seconds`);
    }
  }, 10000);

  // Clean up monitor when FFmpeg closes
  ffmpeg.on("close", () => {
    clearInterval(dataMonitor);
  });

  return ffmpeg;
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

    // 3. Create consumer
    
    const consumer = await transport.consume({
      producerId: producer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: false,
    });

    console.log(`[Recorder] Consumer created: ${consumer.id}`);
    
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

    // 4. Start FFmpeg first to listen for RTP
    // Calculate FFmpeg port ensuring it stays within valid range (0-65535)
    let ffmpegPort = tuple.localPort + 10000;
    if (ffmpegPort > 65535) {
      ffmpegPort = tuple.localPort + 1000;
      if (ffmpegPort > 65535) {
        ffmpegPort = 50000 + (tuple.localPort % 1000);
      }
    }
    
    const ffmpeg = await startFfmpegRecording({
      rtpParameters: { 
        ip: tuple.localIp, 
        port: ffmpegPort 
      },
      output: filename,
      kind: producer.kind,
      consumerRtpParams: consumer.rtpParameters,
    });
    
    // 5. Wait for FFmpeg to start listening
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 6. Connect PlainTransport to send RTP to FFmpeg
    await transport.connect({
      ip: '127.0.0.1',
      port: ffmpegPort
    });
    
    console.log(`[Screen Recorder] Screen recording started: ${producer.kind} -> ${filename}`);

    // Clean up monitor when consumer closes
    consumer.on('@close', () => {
      console.log(`[Recorder] Recording ended: ${filename}`);
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