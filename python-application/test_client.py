#!/usr/bin/env python3
"""
Test client for the AI Audio Analysis App
This script demonstrates how to use the API endpoints
"""

import requests
import os
import time
from pathlib import Path

# Configuration
BASE_URL = "http://localhost:8080"
CALIBRATION_FILE = "calibration_audio.wav"  # Replace with your 10-second calibration file
TEST_FILE = "test_audio.wav"  # Replace with your 5-second test file

def test_health_check():
    """Test the health check endpoint"""
    print("Testing health check...")
    try:
        response = requests.get(f"{BASE_URL}/")
        print(f"Status: {response.status_code}")
        print(f"Response: {response.json()}")
        return response.status_code == 200
    except Exception as e:
        print(f"Health check failed: {e}")
        return False

def test_calibration():
    """Test the calibration endpoint"""
    print("\nTesting calibration...")
    
    if not os.path.exists(CALIBRATION_FILE):
        print(f"Calibration file not found: {CALIBRATION_FILE}")
        print("Please provide a 10-second audio file for calibration")
        return False
    
    try:
        with open(CALIBRATION_FILE, 'rb') as f:
            files = {'audio_file': f}
            response = requests.post(f"{BASE_URL}/calibrate", files=files)
        
        print(f"Status: {response.status_code}")
        if response.status_code == 200:
            result = response.json()
            print(f"Calibration successful!")
            print(f"Thresholds: {result['thresholds']}")
            return True
        else:
            print(f"Calibration failed: {response.text}")
            return False
            
    except Exception as e:
        print(f"Calibration test failed: {e}")
        return False

def test_analysis():
    """Test the analysis endpoint"""
    print("\nTesting analysis...")
    
    if not os.path.exists(TEST_FILE):
        print(f"Test file not found: {TEST_FILE}")
        print("Please provide a 5-second audio file for testing")
        return False
    
    try:
        with open(TEST_FILE, 'rb') as f:
            files = {'audio_file': f}
            response = requests.post(f"{BASE_URL}/analyze", files=files)
        
        print(f"Status: {response.status_code}")
        if response.status_code == 200:
            result = response.json()
            print(f"Analysis successful!")
            print(f"Volume level: {result['analysis']['volume_level']}")
            print(f"Speech detected: {result['analysis']['human_speech_detected']}")
            print(f"Suspicious sounds: {result['analysis']['suspicious_sounds_detected']}")
            print(f"File saved: {result['file_saved']}")
            if result['file_saved']:
                print(f"Saved to: {result['saved_file_path']}")
            return True
        else:
            print(f"Analysis failed: {response.text}")
            return False
            
    except Exception as e:
        print(f"Analysis test failed: {e}")
        return False

def test_status():
    """Test the status endpoint"""
    print("\nTesting status...")
    try:
        response = requests.get(f"{BASE_URL}/status")
        print(f"Status: {response.status_code}")
        if response.status_code == 200:
            result = response.json()
            print(f"Calibrated: {result['calibrated']}")
            if result['calibrated']:
                print(f"Current thresholds: {result['calibration_thresholds']}")
            return True
        else:
            print(f"Status check failed: {response.text}")
            return False
    except Exception as e:
        print(f"Status test failed: {e}")
        return False

def create_sample_audio_files():
    """Create sample audio files for testing (requires additional libraries)"""
    print("\nCreating sample audio files for testing...")
    try:
        import numpy as np
        import soundfile as sf
        
        # Create a simple sine wave for calibration (10 seconds)
        sample_rate = 16000
        duration = 10
        t = np.linspace(0, duration, sample_rate * duration, False)
        # Low amplitude sine wave (background noise simulation)
        calibration_audio = 0.1 * np.sin(2 * np.pi * 440 * t)  # 440 Hz tone
        sf.write(CALIBRATION_FILE, calibration_audio, sample_rate)
        print(f"Created calibration file: {CALIBRATION_FILE}")
        
        # Create test audio with speech-like characteristics (5 seconds)
        duration = 5
        t = np.linspace(0, duration, sample_rate * duration, False)
        # Higher amplitude with multiple frequencies (speech simulation)
        test_audio = 0.5 * (np.sin(2 * np.pi * 200 * t) + 0.5 * np.sin(2 * np.pi * 800 * t))
        sf.write(TEST_FILE, test_audio, sample_rate)
        print(f"Created test file: {TEST_FILE}")
        
        return True
        
    except ImportError:
        print("soundfile not available. Please install it or provide your own audio files.")
        return False
    except Exception as e:
        print(f"Failed to create sample files: {e}")
        return False

def main():
    """Run all tests"""
    print("AI Audio Analysis App - Test Client")
    print("=" * 50)
    
    # Check if sample files exist, create them if not
    if not os.path.exists(CALIBRATION_FILE) or not os.path.exists(TEST_FILE):
        print("Sample audio files not found. Attempting to create them...")
        if not create_sample_audio_files():
            print("Please provide your own audio files:")
            print(f"  - {CALIBRATION_FILE} (10 seconds)")
            print(f"  - {TEST_FILE} (5 seconds)")
            return
    
    # Run tests
    tests = [
        ("Health Check", test_health_check),
        ("Calibration", test_calibration),
        ("Status Check", test_status),
        ("Analysis", test_analysis),
    ]
    
    results = []
    for test_name, test_func in tests:
        print(f"\n{'='*20} {test_name} {'='*20}")
        success = test_func()
        results.append((test_name, success))
        time.sleep(1)  # Brief pause between tests
    
    # Summary
    print(f"\n{'='*50}")
    print("TEST SUMMARY")
    print("=" * 50)
    for test_name, success in results:
        status = "✓ PASS" if success else "✗ FAIL"
        print(f"{test_name}: {status}")
    
    total_passed = sum(1 for _, success in results if success)
    print(f"\nTotal: {total_passed}/{len(results)} tests passed")
    
    if total_passed == len(results):
        print("All tests passed! The API is working correctly.")
    else:
        print("Some tests failed. Check the server logs for details.")

if __name__ == "__main__":
    main()
