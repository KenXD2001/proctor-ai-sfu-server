/**
 * Test script to verify the new recording functionality
 * This script tests the webcam and audio recording functions
 */

const { createWebcamRecording, createAudioRecording } = require('./recorder');

// Mock objects for testing
const mockProducer = {
  id: 'test-producer-id',
  kind: 'video',
  paused: false,
  closed: false,
  on: (event, callback) => {
    console.log(`Mock producer event: ${event}`);
  }
};

const mockRouter = {
  rtpCapabilities: {
    codecs: [
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        payloadType: 96
      }
    ]
  }
};

const mockAudioProducer = {
  id: 'test-audio-producer-id',
  kind: 'audio',
  paused: false,
  closed: false,
  on: (event, callback) => {
    console.log(`Mock audio producer event: ${event}`);
  }
};

const mockAudioRouter = {
  rtpCapabilities: {
    codecs: [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        payloadType: 97
      }
    ]
  }
};

async function testRecording() {
  console.log('Testing recording functionality...');
  
  try {
    // Test webcam recording
    console.log('\n=== Testing Webcam Recording ===');
    const webcamSession = await createWebcamRecording(mockProducer, mockRouter, 'test-user-123');
    console.log('✅ Webcam recording session created successfully');
    console.log('Session details:', {
      consumerId: webcamSession.consumer?.id,
      transportId: webcamSession.transport?.id,
      filename: webcamSession.filename
    });
    
    // Test audio recording
    console.log('\n=== Testing Audio Recording ===');
    const audioSession = await createAudioRecording(mockAudioProducer, mockAudioRouter, 'test-user-123');
    console.log('✅ Audio recording session created successfully');
    console.log('Session details:', {
      consumerId: audioSession.consumer?.id,
      transportId: audioSession.transport?.id,
      filename: audioSession.filename,
      hasRecordingLoop: !!audioSession.recordingLoop
    });
    
    console.log('\n✅ All recording tests passed!');
    
    // Cleanup
    setTimeout(() => {
      console.log('\nCleaning up test sessions...');
      if (webcamSession.ffmpeg && !webcamSession.ffmpeg.killed) {
        webcamSession.ffmpeg.kill('SIGTERM');
      }
      if (audioSession.ffmpeg && !audioSession.ffmpeg.killed) {
        audioSession.ffmpeg.kill('SIGTERM');
      }
      if (audioSession.recordingLoop) {
        clearInterval(audioSession.recordingLoop);
      }
      console.log('Cleanup completed.');
    }, 5000);
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack trace:', error.stack);
  }
}

// Run the test
testRecording();
