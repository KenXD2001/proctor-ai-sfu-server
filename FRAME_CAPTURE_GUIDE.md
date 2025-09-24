# Webcam Frame Capture Implementation

## Overview
The SFU server now captures **individual JPEG image frames** from webcam video streams at a rate of **1 frame per second** in a continuous loop. Each frame is saved as a separate image file that can be viewed directly on your website.

## How It Works

### Frame Capture Process
1. **Continuous Loop**: Every 1 second, a new frame is captured
2. **Individual Files**: Each frame is saved as a separate JPEG file
3. **Web Compatible**: JPEG format for direct browser display
4. **Automatic Naming**: Files named with timestamp for easy identification

### File Output
```
recordings/webcam/
├── user123_frame_1695567890123.jpg
├── user123_frame_1695567891124.jpg
├── user123_frame_1695567892125.jpg
└── ...
```

## Technical Implementation

### FFmpeg Configuration for Frame Capture
```bash
ffmpeg -protocol_whitelist file,udp,rtp -i input.sdp \
  -vf fps=1 \                    # Capture 1 frame per second
  -q:v 2 \                       # High quality JPEG (1-31, lower = better)
  -fflags +genpts \              # Generate presentation timestamps
  -avoid_negative_ts make_zero \ # Handle timestamp issues
  -loglevel error \              # Minimal logging
  -timeout 5000000 \             # 5 second timeout
  -y output.jpg                  # Output JPEG file
```

### Frame Capture Loop
```javascript
// Set up 1-second frame capture loop
const frameCaptureLoop = setInterval(async () => {
  try {
    const timestamp = Date.now();
    const filename = `recordings/webcam/${userId}_frame_${timestamp}.jpg`;
    
    // Start FFmpeg to capture single frame
    const { ffmpeg } = await startFfmpegRecording({
      rtpParameters: { ip: tuple.localIp, port: ffmpegPort },
      output: filename,
      kind: producer.kind,
      consumerRtpParams: consumer.rtpParameters,
      recordingType: 'webcam'
    });
    
    // Wait for frame capture (1.5 seconds)
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // Stop FFmpeg after capturing one frame
    if (ffmpeg && !ffmpeg.killed) {
      ffmpeg.kill('SIGTERM');
    }
    
    console.log(`[Recorder] Captured frame: ${path.basename(filename)}`);
  } catch (error) {
    console.error('[Recorder] Frame capture error:', error.message);
  }
}, 1000); // 1 second interval
```

## Client-Side Integration

### Producer Creation
When creating a webcam producer, include the appropriate metadata:

```javascript
// Webcam producer (triggers frame capture)
const webcamProducer = await sendTransport.produce({
  track: webcamTrack,
  appData: { source: 'webcam', type: 'webcam' }  // This triggers frame capture
});
```

### Stream Detection
The server automatically detects webcam streams based on metadata:
```javascript
const shouldRecordWebcam = producer.kind === 'video' && 
                         (appData.source === 'webcam' || 
                          appData.type === 'webcam' || 
                          appData.source === 'camera');
```

## Web Display

### Displaying Captured Frames
```html
<!-- Display latest frame -->
<img id="latestFrame" src="" alt="Latest webcam frame" />

<script>
// Update image every second with latest frame
setInterval(() => {
  const timestamp = Date.now();
  const frameUrl = `recordings/webcam/user123_frame_${timestamp}.jpg`;
  document.getElementById('latestFrame').src = frameUrl;
}, 1000);
</script>
```

### Gallery View
```html
<!-- Display multiple frames -->
<div id="frameGallery">
  <!-- Frames will be loaded here -->
</div>

<script>
// Load recent frames
function loadRecentFrames(userId, count = 10) {
  const gallery = document.getElementById('frameGallery');
  const now = Date.now();
  
  for (let i = 0; i < count; i++) {
    const timestamp = now - (i * 1000); // Go back 1 second each
    const frameUrl = `recordings/webcam/${userId}_frame_${timestamp}.jpg`;
    
    const img = document.createElement('img');
    img.src = frameUrl;
    img.alt = `Frame ${i + 1}`;
    img.style.width = '200px';
    img.style.margin = '5px';
    
    gallery.appendChild(img);
  }
}

// Load frames for user
loadRecentFrames('user123', 20);
</script>
```

## Performance Characteristics

### Resource Usage
- **CPU**: Low - only 1 frame per second processing
- **Storage**: Minimal - JPEG compression reduces file sizes
- **Memory**: Efficient - no buffering, immediate file writing
- **Network**: Minimal - only RTP stream consumption

### File Sizes
- **Typical JPEG**: 50-200KB per frame (depending on resolution)
- **Storage per hour**: ~180-720MB (1 frame/second)
- **Compression**: High-quality JPEG (quality level 2)

## File Management

### Automatic Cleanup
- Frames are automatically cleaned up when user disconnects
- No automatic file deletion (implement your own retention policy)
- Consider implementing cleanup for old frames

### Directory Structure
```
recordings/
├── screen/          # Screen recordings (WebM)
├── webcam/          # Webcam frames (JPEG)
│   ├── user123_frame_1695567890123.jpg
│   ├── user123_frame_1695567891124.jpg
│   └── ...
└── audio/           # Audio recordings (MP3)
```

## Error Handling

### Common Issues
1. **Port conflicts**: Automatic port selection with fallback
2. **FFmpeg failures**: Graceful error handling with retry
3. **Producer inactivity**: 10-second timeout for activation
4. **Storage issues**: Directory creation and permission handling

### Logging
```
[Recorder] Starting webcam frame capture for user: 12345678
[Recorder] Webcam consumer created: consumer-abc123
[Recorder] Webcam frame capture active for user: 12345678
[Recorder] Captured frame: user123_frame_1695567890123.jpg
[Recorder] Captured frame: user123_frame_1695567891124.jpg
```

## Testing

### Run Frame Capture Test
```bash
node test-frame-capture.js
```

This will:
1. Create a mock webcam producer
2. Start frame capture
3. Run for 10 seconds
4. Capture multiple frames
5. Clean up resources

### Manual Testing
1. Start your SFU server
2. Connect a client with webcam stream
3. Check `recordings/webcam/` directory
4. Verify new JPEG files appear every second

## Security Considerations

### File Access
- Frames stored in local filesystem
- Implement proper authentication for web access
- Consider file permissions and access controls

### Privacy
- Each frame contains user identification in filename
- Consider encryption for sensitive environments
- Implement retention policies for frame storage

## Future Enhancements

### Potential Improvements
1. **Frame compression**: Further optimize JPEG quality/size
2. **Batch processing**: Process multiple frames together
3. **Real-time analysis**: Analyze frames for proctoring
4. **Cloud storage**: Upload frames to cloud services
5. **Streaming**: Real-time frame streaming to web clients
6. **Metadata**: Add frame metadata (timestamp, resolution, etc.)

## Troubleshooting

### No Frames Being Captured
1. Check if webcam producer is created with correct metadata
2. Verify FFmpeg is installed and accessible
3. Check port availability and permissions
4. Review server logs for error messages

### Poor Frame Quality
1. Adjust JPEG quality in FFmpeg args (`-q:v` parameter)
2. Check source video resolution
3. Verify network conditions

### High CPU Usage
1. Frame capture is already optimized for low CPU
2. Check for multiple concurrent captures
3. Verify FFmpeg process cleanup
