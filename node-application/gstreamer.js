const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

class GStreamer {
  constructor({ roomId, userId, video, audio }) {
    this.roomId = roomId;
    this.userId = userId;

    const basePath = path.join(__dirname, "Recording", roomId, userId);
    fs.mkdirSync(basePath, { recursive: true });
    const filePath = path.join(basePath, `${Date.now()}.mp4`);

    const args = [
      "-e",
      // Video
      "udpsrc", `port=${video.remoteRtpPort}`,
      "caps=application/x-rtp,media=video,encoding-name=VP8,payload=96",
      "!", "rtpvp8depay", "!", "vp8dec", "!", "x264enc",
      "!", "queue", "!", "mp4mux", "name=mux",
      "!", "filesink", `location=${filePath}`,
    ];

    if (audio) {
      args.push(
        "udpsrc", `port=${audio.remoteRtpPort}`,
        "caps=application/x-rtp,media=audio,encoding-name=OPUS,payload=97",
        "!", "rtpopusdepay", "!", "opusdec",
        "!", "voaacenc", "!", "mux."
      );
    }

    console.log(`[GStreamer] 🎬 Starting recording for User=${userId} Room=${roomId}`);
    this.process = spawn("gst-launch-1.0", args);

    this.process.stderr.on("data", (data) =>
      console.error(`[GStreamer] ${data.toString()}`)
    );
    this.process.on("exit", (code) =>
      console.log(`[GStreamer] 🚪 Exited with code ${code}`)
    );
  }

  kill() {
    if (this.process) {
      this.process.kill("SIGINT");
      console.log(`[GStreamer] ⏹️ Stopped recording User=${this.userId} Room=${this.roomId}`);
    }
  }
}

module.exports = GStreamer;
