#!/usr/bin/env python3
"""
Test script for face analysis integration
Tests the complete workflow from frame capture to face matching
"""

import asyncio
import aiohttp
import json
import os
import sys
from datetime import datetime

# Test configuration
PYTHON_SERVICE_URL = "http://localhost:8080"
SFU_SERVICE_URL = "http://localhost:3000"
TEST_USER_ID = "test_user_123"
TEST_IMAGE_PATH = "test_frame.jpg"

async def test_python_service_health():
    """Test if Python microservice is running"""
    print("🔍 Testing Python microservice health...")
    
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{PYTHON_SERVICE_URL}/status") as response:
                if response.status == 200:
                    data = await response.json()
                    print("Python microservice is healthy")
                    print(f"   Face analyzer status: {data.get('face_analyzer', 'Not available')}")
                    return True
                else:
                    print(f"Python microservice health check failed: {response.status}")
                    return False
    except Exception as e:
        print(f"Python microservice connection error: {e}")
        return False

async def test_face_analysis_endpoint():
    """Test face analysis endpoint with a sample image"""
    print("🔍 Testing face analysis endpoint...")
    
    # Create a simple test image (1x1 pixel)
    test_image_data = b'\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x01\x00H\x00H\x00\x00\xff\xdb\x00C\x00\x08\x06\x06\x07\x06\x05\x08\x07\x07\x07\t\t\x08\n\x0c\x14\r\x0c\x0b\x0b\x0c\x19\x12\x13\x0f\x14\x1d\x1a\x1f\x1e\x1d\x1a\x1c\x1c $.\' ",#\x1c\x1c(7),01444\x1f\'9=82<.342\xff\xc0\x00\x11\x08\x00\x01\x00\x01\x01\x01\x11\x00\x02\x11\x01\x03\x11\x01\xff\xc4\x00\x14\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x08\xff\xc4\x00\x14\x10\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\xff\xda\x00\x0c\x03\x01\x00\x02\x11\x03\x11\x00\x3f\x00\xaa\xff\xd9'
    
    try:
        # Create form data
        data = aiohttp.FormData()
        data.add_field('frame_file', test_image_data, filename='test_frame.jpg', content_type='image/jpeg')
        data.add_field('user_id', TEST_USER_ID)
        
        async with aiohttp.ClientSession() as session:
            async with session.post(f"{PYTHON_SERVICE_URL}/analyze-face", data=data) as response:
                if response.status == 200:
                    result = await response.json()
                    print("Face analysis endpoint working")
                    print(f"   Status: {result.get('status')}")
                    print(f"   Processing time: {result.get('processing_time_seconds', 'N/A')}s")
                    
                    analysis = result.get('analysis', {})
                    print(f"   Violations: {analysis.get('violations', [])}")
                    print(f"   Frame saved: {analysis.get('frame_saved', False)}")
                    return True
                else:
                    error_text = await response.text()
                    print(f"Face analysis endpoint failed: {response.status}")
                    print(f"   Error: {error_text}")
                    return False
    except Exception as e:
        print(f"Face analysis endpoint error: {e}")
        return False

async def test_cleanup_endpoint():
    """Test user cleanup endpoint"""
    print("🔍 Testing user cleanup endpoint...")
    
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(f"{PYTHON_SERVICE_URL}/cleanup-user/{TEST_USER_ID}") as response:
                if response.status == 200:
                    result = await response.json()
                    print("User cleanup endpoint working")
                    print(f"   Status: {result.get('status')}")
                    return True
                else:
                    error_text = await response.text()
                    print(f"User cleanup endpoint failed: {response.status}")
                    print(f"   Error: {error_text}")
                    return False
    except Exception as e:
        print(f"User cleanup endpoint error: {e}")
        return False

async def test_sfu_service_health():
    """Test if SFU service is running"""
    print("🔍 Testing SFU service health...")
    
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{SFU_SERVICE_URL}/face-analysis/status") as response:
                if response.status == 200:
                    data = await response.json()
                    print("SFU service is healthy")
                    print(f"   Face analysis status: {data}")
                    return True
                else:
                    print(f"SFU service health check failed: {response.status}")
                    return False
    except Exception as e:
        print(f"SFU service connection error: {e}")
        return False

async def test_database_connection():
    """Test database connection by checking if we can query the VerificationSession table"""
    print("🔍 Testing database connection...")
    
    try:
        import psycopg2
        import psycopg2.extras
        
        conn = psycopg2.connect(
            host='localhost',
            port='5432',
            database='proctor_ai',
            user='postgres',
            password='root'
        )
        
        cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cursor.execute("SELECT COUNT(*) as count FROM \"VerificationSession\"")
        result = cursor.fetchone()
        
        cursor.close()
        conn.close()
        
        print(f"Database connection successful")
        print(f"   VerificationSession records: {result['count']}")
        return True
        
    except Exception as e:
        print(f"Database connection error: {e}")
        return False

async def run_all_tests():
    """Run all tests"""
    print("Starting face analysis integration tests...")
    print("=" * 60)
    
    tests = [
        ("Database Connection", test_database_connection),
        ("Python Service Health", test_python_service_health),
        ("SFU Service Health", test_sfu_service_health),
        ("Face Analysis Endpoint", test_face_analysis_endpoint),
        ("User Cleanup Endpoint", test_cleanup_endpoint),
    ]
    
    results = []
    
    for test_name, test_func in tests:
        print(f"\n📋 {test_name}")
        print("-" * 40)
        
        try:
            result = await test_func()
            results.append((test_name, result))
        except Exception as e:
            print(f"Test failed with exception: {e}")
            results.append((test_name, False))
    
    # Summary
    print("\n" + "=" * 60)
    print("TEST SUMMARY")
    print("=" * 60)
    
    passed = 0
    total = len(results)
    
    for test_name, result in results:
        status = "PASS" if result else "FAIL"
        print(f"{status} {test_name}")
        if result:
            passed += 1
    
    print(f"\nResults: {passed}/{total} tests passed")
    
    if passed == total:
        print("All tests passed! Face analysis integration is working correctly.")
        return True
    else:
        print("Some tests failed. Please check the errors above.")
        return False

def print_setup_instructions():
    """Print setup instructions"""
    print("""
🔧 SETUP INSTRUCTIONS

Before running the tests, make sure:

1. PostgreSQL database is running:
   - Host: localhost:5432
   - Database: proctor_ai
   - User: postgres
   - Password: root

2. Python microservice is running:
   - Install dependencies: pip install -r requirements.txt
   - Start service: python main.py
   - Should be running on: http://localhost:8080

3. SFU server is running:
   - Install dependencies: npm install
   - Start server: npm start
   - Should be running on: http://localhost:3000

4. Required Python packages:
   - opencv-python
   - face-recognition
   - psycopg2-binary
   - Pillow
   - requests

5. Make sure the VerificationSession table exists with at least one record
   containing a face_filename for testing.

""")

if __name__ == "__main__":
    print_setup_instructions()
    
    try:
        result = asyncio.run(run_all_tests())
        sys.exit(0 if result else 1)
    except KeyboardInterrupt:
        print("\nTests interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n💥 Unexpected error: {e}")
        sys.exit(1)
