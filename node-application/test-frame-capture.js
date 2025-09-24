/**
 * Test script to verify the webcam frame capture functionality
 * This script tests the 1 frame per second capture as individual JPEG images
 */

const { createWebcamRecording } = require('./recorder');

// Mock objects for testing
const mockProducer = {
  id: 'test-webcam-producer-id',
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

async function testFrameCapture() {
  console.log('Testing webcam frame capture functionality...');
  console.log('This will capture 1 frame per second as individual JPEG images');
  
  try {
    // Test webcam frame capture
    console.log('\n=== Testing Webcam Frame Capture ===');
    const frameCaptureSession = await createWebcamRecording(mockProducer, mockRouter, 'test-user-123');
    console.log('✅ Webcam frame capture session created successfully');
    console.log('Session details:', {
      consumerId: frameCaptureSession.consumer?.id,
      transportId: frameCaptureSession.transport?.id,
      hasFrameCaptureLoop: !!frameCaptureSession.frameCaptureLoop
    });
    
    console.log('\n📸 Frame capture is now running...');
    console.log('Check the recordings/webcam/ directory for captured frames');
    console.log('Files will be named: test-user-123_frame_[timestamp].jpg');
    
    // Let it run for 10 seconds to capture some frames
    console.log('\n⏱️  Running for 10 seconds to capture frames...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    console.log('\n✅ Frame capture test completed!');
    
    // Cleanup
    console.log('\nCleaning up test session...');
    if (frameCaptureSession.frameCaptureLoop) {
      clearInterval(frameCaptureSession.frameCaptureLoop);
    }
    console.log('Cleanup completed.');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack trace:', error.stack);
  }
}

// Run the test
testFrameCapture();
