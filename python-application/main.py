from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
from typing import Dict, Any
import io
import os
from datetime import datetime

from audio_analyzer_optimized import OptimizedAudioAnalyzer as AudioAnalyzer
from calibration_service_optimized import OptimizedCalibrationService as CalibrationService
from face_analyzer import FaceAnalyzer

app = FastAPI(title="AI Audio Analysis App", version="1.0.0")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Database configuration
DB_CONFIG = {
    'host': 'localhost',
    'port': '5432',
    'database': 'proctor_ai',
    'user': 'postgres',
    'password': 'root'
}

# Initialize services
audio_analyzer = AudioAnalyzer()
calibration_service = CalibrationService()
face_analyzer = FaceAnalyzer(DB_CONFIG)

# Global variable to store calibration data
calibration_data = None

@app.get("/")
async def root():
    """Health check endpoint"""
    return {"message": "AI Audio Analysis App is running", "status": "healthy"}

@app.post("/calibrate")
async def calibrate_audio(audio_file: UploadFile = File(...)):
    """
    Phase 1: OPTIMIZED Calibration endpoint
    Fast analysis of audio clip (5+ seconds recommended) to find background noise thresholds
    Note: Can work with 5-second files but 10+ seconds gives better calibration accuracy
    """
    global calibration_data
    
    start_time = datetime.now()
    
    try:
        print(f"[OPTIMIZED CALIBRATION] Received request for: {audio_file.filename}")
        print(f"[OPTIMIZED CALIBRATION] Content type: {audio_file.content_type}")
        
        # Validate file type
        if not audio_file.content_type or not audio_file.content_type.startswith('audio/'):
            print(f"[OPTIMIZED CALIBRATION] Invalid file type: {audio_file.content_type}")
            raise HTTPException(status_code=400, detail="File must be an audio file")
        
        print("[OPTIMIZED CALIBRATION] Reading audio data...")
        # Read audio data
        audio_data = await audio_file.read()
        print(f"[OPTIMIZED CALIBRATION] Audio data read: {len(audio_data)} bytes")
        
        print("[OPTIMIZED CALIBRATION] Starting OPTIMIZED calibration service...")
        # Perform optimized calibration
        calibration_result = calibration_service.calibrate(audio_data)
        
        print("[OPTIMIZED CALIBRATION] Storing calibration data...")
        # Store calibration data for use in analysis
        calibration_data = calibration_result
        
        total_time = (datetime.now() - start_time).total_seconds()
        print(f"[OPTIMIZED CALIBRATION] Completed successfully in {total_time:.3f} seconds!")
        
        return {
            "status": "success",
            "message": "OPTIMIZED calibration completed successfully",
            "thresholds": calibration_result["thresholds"],
            "processing_time_seconds": total_time,
            "timestamp": datetime.now().isoformat()
        }
        
    except Exception as e:
        total_time = (datetime.now() - start_time).total_seconds()
        print(f"[OPTIMIZED CALIBRATION] Failed after {total_time:.3f}s: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Optimized calibration failed: {str(e)}")

@app.post("/analyze")
async def analyze_audio(audio_file: UploadFile = File(...)):
    """
    Phase 2: OPTIMIZED Real-Time Monitoring endpoint
    Fast analysis of 5-second audio clips for volume, speech, and background sounds
    Optimized for real-time processing with 5-second segments
    """
    start_time = datetime.now()
    
    try:
        print(f"[OPTIMIZED ANALYSIS] Received request for: {audio_file.filename}")
        
        # Check if calibration has been performed
        if calibration_data is None:
            raise HTTPException(
                status_code=400, 
                detail="Please perform calibration first by calling /calibrate endpoint"
            )
        
        # Validate file type
        if not audio_file.content_type or not audio_file.content_type.startswith('audio/'):
            raise HTTPException(status_code=400, detail="File must be an audio file")
        
        print("[OPTIMIZED ANALYSIS] Reading audio data...")
        # Read audio data
        audio_data = await audio_file.read()
        print(f"[OPTIMIZED ANALYSIS] Audio data read: {len(audio_data)} bytes")
        
        print("[OPTIMIZED ANALYSIS] Starting OPTIMIZED analysis...")
        # Perform optimized analysis
        analysis_result = audio_analyzer.analyze(audio_data, calibration_data)
        
        # Check if file should be saved based on the rules
        should_save = (
            analysis_result["volume_level"] == "high" or
            analysis_result["human_speech_detected"] or
            analysis_result["suspicious_sounds_detected"]
        )
        
        # Save file if conditions are met
        saved_file_path = None
        if should_save:
            print("[OPTIMIZED ANALYSIS] Saving audio file...")
            saved_file_path = audio_analyzer.save_audio_file(audio_data, analysis_result)
        
        total_time = (datetime.now() - start_time).total_seconds()
        print(f"[OPTIMIZED ANALYSIS] Completed successfully in {total_time:.3f} seconds!")
        
        return {
            "status": "success",
            "analysis": analysis_result,
            "file_saved": should_save,
            "saved_file_path": saved_file_path,
            "processing_time_seconds": total_time,
            "timestamp": datetime.now().isoformat()
        }
        
    except Exception as e:
        total_time = (datetime.now() - start_time).total_seconds()
        print(f"[OPTIMIZED ANALYSIS] Failed after {total_time:.3f}s: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Optimized analysis failed: {str(e)}")

@app.post("/analyze-face")
async def analyze_face(frame_file: UploadFile = File(...), user_id: str = Form(...)):
    """
    Analyze webcam frame for face matching and violations
    
    Args:
        frame_file: Webcam frame image file
        user_id: User ID for reference face lookup
        
    Returns:
        Analysis results with violations and frame saving info
    """
    start_time = datetime.now()
    
    try:
        print(f"[FACE ANALYSIS] Received request for user: {user_id}")
        print(f"[FACE ANALYSIS] Content type: {frame_file.content_type}")
        
        # Validate file type
        if not frame_file.content_type or not frame_file.content_type.startswith('image/'):
            print(f"[FACE ANALYSIS] Invalid file type: {frame_file.content_type}")
            raise HTTPException(status_code=400, detail="File must be an image file")
        
        print("[FACE ANALYSIS] Reading frame data...")
        # Read frame data
        frame_data = await frame_file.read()
        print(f"[FACE ANALYSIS] Frame data read: {len(frame_data)} bytes")
        
        print("[FACE ANALYSIS] Starting face analysis...")
        # Perform face analysis
        analysis_result = face_analyzer.analyze_frame(frame_data, user_id)
        
        total_time = (datetime.now() - start_time).total_seconds()
        print(f"[FACE ANALYSIS] Completed successfully in {total_time:.3f} seconds!")
        
        return {
            "status": "success",
            "analysis": analysis_result,
            "processing_time_seconds": total_time,
            "timestamp": datetime.now().isoformat()
        }
        
    except Exception as e:
        total_time = (datetime.now() - start_time).total_seconds()
        print(f"[FACE ANALYSIS] Failed after {total_time:.3f}s: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Face analysis failed: {str(e)}")

@app.post("/cleanup-user/{user_id}")
async def cleanup_user_data(user_id: str):
    """
    Clean up user data when they disconnect
    
    Args:
        user_id: User ID to clean up
        
    Returns:
        Cleanup status
    """
    try:
        print(f"🧹 [CLEANUP] Cleaning up data for user: {user_id}")
        
        # Clean up face analyzer alert states
        face_analyzer.cleanup_alert_states(user_id)
        
        print(f"[CLEANUP] Cleanup completed for user: {user_id}")
        
        return {
            "status": "success",
            "message": f"User data cleaned up for {user_id}",
            "timestamp": datetime.now().isoformat()
        }
        
    except Exception as e:
        print(f"[CLEANUP] Failed for user {user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Cleanup failed: {str(e)}")

@app.get("/status")
async def get_status():
    """Get current status including calibration state and face analyzer status"""
    face_status = face_analyzer.get_status()
    
    return {
        "calibrated": calibration_data is not None,
        "calibration_thresholds": calibration_data["thresholds"] if calibration_data else None,
        "face_analyzer": face_status,
        "timestamp": datetime.now().isoformat()
    }

if __name__ == "__main__":
    # Create uploads directory if it doesn't exist
    os.makedirs("uploads", exist_ok=True)
    os.makedirs("uploads/saved_audio", exist_ok=True)
    
    uvicorn.run(app, host="0.0.0.0", port=8080)
