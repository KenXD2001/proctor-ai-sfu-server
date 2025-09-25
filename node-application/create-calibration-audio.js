/**
 * Simple script to create a calibration audio file for testing
 * This creates a 10-second audio file with background noise simulation
 * Note: For calibration, 10+ seconds is recommended for better accuracy
 */

const fs = require('fs');
const path = require('path');

// Create a simple calibration audio file using a basic approach
// In a real scenario, you would use actual audio recording or a proper audio library

function createCalibrationAudio() {
  const outputPath = path.join(__dirname, 'recordings', 'audio', 'calibration_audio.wav');
  const recordingsDir = path.dirname(outputPath);
  
  // Ensure directory exists
  if (!fs.existsSync(recordingsDir)) {
    fs.mkdirSync(recordingsDir, { recursive: true });
  }
  
  console.log('Creating calibration audio file...');
  console.log('Note: This is a placeholder file. In production, use actual 10-second audio recording.');
  
  // Create a minimal WAV file header (44 bytes) + some dummy data
  const sampleRate = 16000;
  const duration = 10; // seconds
  const numSamples = sampleRate * duration;
  const bytesPerSample = 2;
  const dataSize = numSamples * bytesPerSample;
  const fileSize = 44 + dataSize;
  
  // WAV file header
  const header = Buffer.alloc(44);
  
  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(fileSize - 8, 4);
  header.write('WAVE', 8);
  
  // fmt chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20);  // audio format (PCM)
  header.writeUInt16LE(1, 22);  // number of channels (mono)
  header.writeUInt32LE(sampleRate, 24); // sample rate
  header.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
  header.writeUInt16LE(bytesPerSample, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  
  // data chunk
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  
  // Create dummy audio data (silence with some low-level noise)
  const audioData = Buffer.alloc(dataSize);
  for (let i = 0; i < dataSize; i += 2) {
    // Create very low amplitude noise (background noise simulation)
    const noise = Math.sin(i * 0.01) * 100 + Math.random() * 50 - 25;
    const sample = Math.max(-32768, Math.min(32767, Math.floor(noise)));
    audioData.writeInt16LE(sample, i);
  }
  
  // Combine header and audio data
  const wavFile = Buffer.concat([header, audioData]);
  
  // Write file
  fs.writeFileSync(outputPath, wavFile);
  
  console.log(`Calibration audio file created: ${outputPath}`);
  console.log(`File size: ${wavFile.length} bytes`);
  console.log(`Duration: ${duration} seconds`);
  console.log(`Sample rate: ${sampleRate} Hz`);
  
  return outputPath;
}

if (require.main === module) {
  createCalibrationAudio();
}

module.exports = createCalibrationAudio;
