import cv2
import face_recognition
import numpy as np
import os
import io
import psycopg2
import psycopg2.extras
from datetime import datetime
from typing import Dict, Any, Optional, List
import logging
import json
import requests
from PIL import Image
import base64
from face_analysis_logger import face_analysis_logger

# Configure basic logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class FaceAnalyzer:
    def __init__(self, db_config: Dict[str, str]):
        """
        Initialize the face analyzer with database connection and AI models
        
        Args:
            db_config: Database configuration dictionary
        """
        self.db_config = db_config
        self.face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        
        # Create directories for storing frames
        os.makedirs("uploads/saved_frames", exist_ok=True)
        os.makedirs("uploads/violation_frames", exist_ok=True)
        
        # Cache for reference face encodings
        self.reference_cache = {}
        
        # Alert cooldown system to prevent flooding
        self.last_alert_state = {}
        self.ALERT_COOLDOWN = 30  # seconds
        
        logger.info("Face analyzer initialized successfully")
        face_analysis_logger.logger.info("Face analyzer initialized with database connection")
    
    def get_db_connection(self):
        """Get database connection"""
        try:
            conn = psycopg2.connect(
                host=self.db_config['host'],
                port=self.db_config['port'],
                database=self.db_config['database'],
                user=self.db_config['user'],
                password=self.db_config['password']
            )
            return conn
        except Exception as e:
            logger.error(f"Database connection error: {e}")
            return None
    
    def get_reference_face(self, user_id: str) -> Optional[np.ndarray]:
        """
        Get reference face encoding from database
        
        Args:
            user_id: User ID to get reference face for
            
        Returns:
            Face encoding or None if not found
        """
        try:
            # Check cache first
            if user_id in self.reference_cache:
                logger.info(f"Using cached reference face for user: {user_id}")
                face_analysis_logger.log_reference_face_loaded(user_id, "cached", True)
                return self.reference_cache[user_id]
            
            conn = self.get_db_connection()
            if not conn:
                return None
            
            cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            
            # Get face filename from VerificationSession table
            cursor.execute("""
                SELECT face_filename, ai_analysis_data 
                FROM "VerificationSession" 
                WHERE user_id = %s AND status = 'verified'
                ORDER BY verified_at DESC 
                LIMIT 1
            """, (user_id,))
            
            result = cursor.fetchone()
            cursor.close()
            conn.close()
            
            if not result or not result['face_filename']:
                logger.warning(f"No reference face found for user: {user_id}")
                return None
            
            face_filename = result['face_filename']
            logger.info(f"Found reference face filename: {face_filename} for user: {user_id}")
            face_analysis_logger.log_reference_face_loaded(user_id, face_filename, False)
            
            # Load reference image
            reference_image = self._load_reference_image(face_filename)
            if reference_image is None:
                logger.error(f"Failed to load reference image: {face_filename}")
                face_analysis_logger.log_error(user_id, "reference_image_load_failed", f"Failed to load: {face_filename}")
                return None
            
            # Get face encoding
            face_encoding = self._get_face_encoding(reference_image)
            if face_encoding is not None:
                # Cache the encoding
                self.reference_cache[user_id] = face_encoding
                logger.info(f"Reference face encoding cached for user: {user_id}")
                face_analysis_logger.log_database_operation("reference_face_cached", user_id, True, face_filename)
                return face_encoding
            
            return None
            
        except Exception as e:
            logger.error(f"Error getting reference face for user {user_id}: {e}")
            return None
    
    def _load_reference_image(self, face_filename: str) -> Optional[np.ndarray]:
        """
        Load reference image from file or URL
        
        Args:
            face_filename: Face filename or URL
            
        Returns:
            Image array or None
        """
        try:
            if face_filename.startswith("http://") or face_filename.startswith("https://"):
                # Create cache directory
                cache_dir = "cache/reference_faces"
                os.makedirs(cache_dir, exist_ok=True)
                
                # Generate cache filename from URL
                import hashlib
                url_hash = hashlib.md5(face_filename.encode()).hexdigest()
                cache_file = os.path.join(cache_dir, f"{url_hash}.jpg")
                
                # Check if cached file exists
                if os.path.exists(cache_file):
                    logger.info(f"Loading reference image from cache: {cache_file}")
                    image = cv2.imread(cache_file)
                    return image
                
                # Download and cache
                logger.info(f"Downloading reference image from URL: {face_filename}")
                response = requests.get(face_filename, timeout=5)  # Reduced timeout
                if response.status_code == 200:
                    image_bytes = response.content
                    nparr = np.frombuffer(image_bytes, np.uint8)
                    image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                    
                    # Save to cache
                    cv2.imwrite(cache_file, image)
                    logger.info(f"Cached reference image: {cache_file}")
                    
                    return image
                else:
                    logger.error(f"Failed to load image from URL: {face_filename}")
                    return None
            else:
                # Load from local file
                if os.path.exists(face_filename):
                    image = cv2.imread(face_filename, cv2.IMREAD_COLOR)
                    return image
                else:
                    logger.error(f"Reference image file not found: {face_filename}")
                    return None
                    
        except Exception as e:
            logger.error(f"Error loading reference image {face_filename}: {e}")
            return None
    
    def _get_face_encoding(self, image: np.ndarray) -> Optional[np.ndarray]:
        """
        Get face encoding from image
        
        Args:
            image: Image array
            
        Returns:
            Face encoding or None
        """
        try:
            # Convert BGR to RGB
            rgb_image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            
            # Find face locations
            face_locations = face_recognition.face_locations(rgb_image)
            
            if not face_locations:
                logger.warning("No face found in reference image")
                return None
            
            # Get face encodings
            face_encodings = face_recognition.face_encodings(rgb_image, face_locations)
            
            if not face_encodings:
                logger.warning("Could not encode face in reference image")
                return None
            
            return face_encodings[0]  # Return first face encoding
            
        except Exception as e:
            logger.error(f"Error getting face encoding: {e}")
            return None
    
    def should_trigger_alert(self, user_id: str, alert_type: str, condition_active: bool) -> bool:
        """
        Check if alert should be triggered based on cooldown system
        
        Args:
            user_id: User ID
            alert_type: Type of alert
            condition_active: Whether the condition is currently active
            
        Returns:
            True if alert should be triggered
        """
        now = datetime.now().timestamp()
        key = f"{user_id}_{alert_type}"
        state = self.last_alert_state.get(key, {"last_time": 0, "active": False})
        
        if condition_active:
            # If this is a new occurrence (was inactive before) → trigger immediately
            if not state["active"]:
                self.last_alert_state[key] = {"last_time": now, "active": True}
                logger.info(f"New alert triggered: {alert_type} for user {user_id}")
                face_analysis_logger.log_alert_state_change(user_id, alert_type, "triggered")
                return True
            # If still active but cooldown passed → trigger again
            elif now - state["last_time"] > self.ALERT_COOLDOWN:
                self.last_alert_state[key] = {"last_time": now, "active": True}
                logger.info(f"Re-alert triggered after {self.ALERT_COOLDOWN}s cooldown: {alert_type} for user {user_id}")
                face_analysis_logger.log_alert_state_change(user_id, alert_type, "triggered")
                return True
            else:
                remaining_cooldown = self.ALERT_COOLDOWN - (now - state["last_time"])
                logger.debug(f"Alert suppressed - cooldown active ({remaining_cooldown:.1f}s remaining) for {alert_type}")
                face_analysis_logger.log_alert_state_change(user_id, alert_type, "suppressed", remaining_cooldown)
                return False
        else:
            # Condition resolved → reset state
            self.last_alert_state[key] = {"last_time": now, "active": False}
            logger.info(f"Alert condition resolved: {alert_type} for user {user_id}")
            face_analysis_logger.log_alert_state_change(user_id, alert_type, "resolved")
            return False
    
    def analyze_frame(self, frame_data: bytes, user_id: str) -> Dict[str, Any]:
        """
        Analyze frame for face matching and violations
        
        Args:
            frame_data: Frame image data as bytes
            user_id: User ID for reference face lookup
            
        Returns:
            Analysis results dictionary
        """
        start_time = datetime.now()
        
        try:
            logger.info(f"[FACE ANALYSIS] Starting analysis for user: {user_id}")
            face_analysis_logger.log_analysis_start(user_id, len(frame_data))
            
            # Convert bytes to image
            nparr = np.frombuffer(frame_data, np.uint8)
            image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            
            if image is None:
                logger.error("[FACE ANALYSIS] Failed to decode frame")
                face_analysis_logger.log_error(user_id, "frame_decode_failed", "Failed to decode frame")
                return {
                    "status": "error",
                    "error": "Failed to decode frame",
                    "violations": [],
                    "processing_time": 0
                }
            
            # Convert to RGB for face_recognition
            rgb_image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            
            # Detect faces (use faster model for real-time processing)
            face_locations = face_recognition.face_locations(rgb_image, model="hog")  # Faster than CNN
            face_landmarks = face_recognition.face_landmarks(rgb_image, face_locations)
            
            violations = []
            analysis_data = {
                "total_faces_detected": len(face_locations),
                "face_mismatch": False,
                "face_not_detected": False,
                "multiple_faces": False,
                "face_partially_blocked": False,
                "head_turns": False,
                "eye_gaze_off": False
            }
            
            # Check for face not detected
            if len(face_locations) == 0:
                if self.should_trigger_alert(user_id, "Face not detected", True):
                    violations.append("Face not detected")
                    analysis_data["face_not_detected"] = True
            else:
                # Reset condition when face appears
                self.should_trigger_alert(user_id, "Face not detected", False)
                
                # Check for multiple faces
                if len(face_locations) > 1:
                    if self.should_trigger_alert(user_id, "Multiple faces found", True):
                        violations.append("Multiple faces found")
                        analysis_data["multiple_faces"] = True
                else:
                    # Reset condition when only one face is present
                    self.should_trigger_alert(user_id, "Multiple faces found", False)
                
                # Analyze first face
                if face_locations:
                    top, right, bottom, left = face_locations[0]
                    
                    # Check face blocking using landmarks
                    if face_landmarks:
                        face_landmark = face_landmarks[0]
                        if (len(face_landmark.get("left_eye", [])) < 6 or 
                            len(face_landmark.get("right_eye", [])) < 6):
                            if self.should_trigger_alert(user_id, "Face partially blocked", True):
                                violations.append("Face partially blocked")
                                analysis_data["face_partially_blocked"] = True
                        else:
                            self.should_trigger_alert(user_id, "Face partially blocked", False)
                    
                    # Face matching with reference
                    reference_encoding = self.get_reference_face(user_id)
                    if reference_encoding is not None:
                        try:
                            # Get face encoding from current frame
                            face_encodings = face_recognition.face_encodings(rgb_image, [face_locations[0]])
                            
                            if face_encodings:
                                # Calculate face distance
                                face_distance = face_recognition.face_distance([reference_encoding], face_encodings[0])[0]
                                
                                logger.info(f"Face distance for user {user_id}: {face_distance:.3f}")
                                
                                # Check for face mismatch (threshold: 0.6)
                                if face_distance > 0.6:
                                    if self.should_trigger_alert(user_id, "Face mismatch detected", True):
                                        violations.append("Face mismatch detected")
                                        analysis_data["face_mismatch"] = True
                                else:
                                    self.should_trigger_alert(user_id, "Face mismatch detected", False)
                                
                                analysis_data["face_distance"] = float(face_distance)
                                analysis_data["face_match_score"] = float((1 - face_distance) * 100)
                            else:
                                logger.warning(f"Could not encode face for user {user_id}")
                                
                        except Exception as e:
                            logger.error(f"Error in face matching for user {user_id}: {e}")
                    
                    # Simplified eye and head movement analysis (skip for performance)
                    # if face_landmarks:
                    #     self._analyze_eye_head_movement(face_landmarks[0], user_id, violations, analysis_data)
            
            # Determine if frame should be saved
            should_save = len(violations) > 0
            
            # Save frame if violations detected
            saved_file_path = None
            if should_save:
                saved_file_path = self._save_violation_frame(frame_data, user_id, violations)
                logger.info(f"[FACE ANALYSIS] Saved violation frame: {saved_file_path}")
                face_analysis_logger.log_frame_saved(user_id, saved_file_path, violations)
            
            processing_time = (datetime.now() - start_time).total_seconds()
            
            result = {
                "status": "success",
                "user_id": user_id,
                "violations": violations,
                "analysis_data": analysis_data,
                "frame_saved": should_save,
                "saved_file_path": saved_file_path,
                "processing_time_seconds": processing_time,
                "timestamp": datetime.now().isoformat()
            }
            
            logger.info(f"[FACE ANALYSIS] Completed for user {user_id} in {processing_time:.3f}s - Violations: {len(violations)}")
            face_analysis_logger.log_analysis_complete(user_id, processing_time, violations, analysis_data)
            
            return result
            
        except Exception as e:
            processing_time = (datetime.now() - start_time).total_seconds()
            logger.error(f"[FACE ANALYSIS] Failed for user {user_id} after {processing_time:.3f}s: {str(e)}")
            return {
                "status": "error",
                "user_id": user_id,
                "error": str(e),
                "violations": [],
                "processing_time_seconds": processing_time
            }
    
    def _analyze_eye_head_movement(self, landmarks: Dict, user_id: str, violations: List[str], analysis_data: Dict):
        """
        Analyze eye and head movement for violations
        
        Args:
            landmarks: Face landmarks dictionary
            user_id: User ID
            violations: List to append violations to
            analysis_data: Analysis data dictionary to update
        """
        try:
            # Eye center calculations
            left_eye = landmarks.get("left_eye")
            right_eye = landmarks.get("right_eye")
            
            if left_eye and right_eye:
                # Eye openness check
                def eye_open_ratio(eye_pts):
                    vertical = np.linalg.norm(np.array(eye_pts[1]) - np.array(eye_pts[5]))
                    horizontal = np.linalg.norm(np.array(eye_pts[0]) - np.array(eye_pts[3]))
                    return vertical / horizontal if horizontal != 0 else 0
                
                left_ratio = eye_open_ratio(left_eye)
                right_ratio = eye_open_ratio(right_eye)
                
                # Check for eyes closed
                if left_ratio < 0.2 and right_ratio < 0.2:
                    if self.should_trigger_alert(user_id, "Eyes closed", True):
                        violations.append("Eyes closed")
                else:
                    self.should_trigger_alert(user_id, "Eyes closed", False)
                
                # Eye gaze angle (horizontal tilt)
                left_eye_center = np.mean(left_eye, axis=0)
                right_eye_center = np.mean(right_eye, axis=0)
                
                dx = right_eye_center[0] - left_eye_center[0]
                dy = right_eye_center[1] - left_eye_center[1]
                eye_angle = np.degrees(np.arctan2(dy, dx))
                
                # Check for looking away
                if abs(eye_angle) > 10:
                    if self.should_trigger_alert(user_id, "Looking away repeatedly", True):
                        violations.append("Looking away repeatedly")
                        analysis_data["eye_gaze_off"] = True
                else:
                    self.should_trigger_alert(user_id, "Looking away repeatedly", False)
                
                # Head pose estimation
                nose_tip = np.array(landmarks["nose_tip"][2])
                chin = np.array(landmarks["chin"][8])
                top_of_face = np.array(landmarks["left_eyebrow"][0])
                
                # Calculate head tilt
                face_height = np.linalg.norm(chin - top_of_face)
                chin_nose_dist = np.linalg.norm(chin - nose_tip)
                tilt_ratio = chin_nose_dist / face_height if face_height > 0 else 1
                
                # Check for head turns
                face_center_x = (left_eye_center[0] + right_eye_center[0]) / 2
                x_diff = nose_tip[0] - face_center_x
                
                if abs(x_diff) > 15:
                    if self.should_trigger_alert(user_id, "Frequent head turns", True):
                        violations.append("Frequent head turns")
                        analysis_data["head_turns"] = True
                else:
                    self.should_trigger_alert(user_id, "Frequent head turns", False)
                
                analysis_data["eye_angle"] = float(eye_angle)
                analysis_data["head_tilt_ratio"] = float(tilt_ratio)
                
        except Exception as e:
            logger.error(f"Error in eye/head movement analysis for user {user_id}: {e}")
    
    def _save_violation_frame(self, frame_data: bytes, user_id: str, violations: List[str]) -> str:
        """
        Save violation frame to disk
        
        Args:
            frame_data: Frame image data as bytes
            user_id: User ID
            violations: List of violations detected
            
        Returns:
            Path to saved file
        """
        try:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
            violation_types = "_".join([v.replace(" ", "_").lower() for v in violations])
            filename = f"{user_id}_{timestamp}_{violation_types}.jpg"
            file_path = os.path.join("uploads/violation_frames", filename)
            
            with open(file_path, "wb") as f:
                f.write(frame_data)
            
            logger.info(f"[FRAME SAVE] Saved violation frame: {filename}")
            return file_path
            
        except Exception as e:
            logger.error(f"Error saving violation frame for user {user_id}: {e}")
            return None
    
    def cleanup_alert_states(self, user_id: str):
        """
        Clean up alert states for a user when they disconnect
        
        Args:
            user_id: User ID to clean up
        """
        keys_to_remove = [key for key in self.last_alert_state.keys() if key.startswith(f"{user_id}_")]
        
        for key in keys_to_remove:
            del self.last_alert_state[key]
        
        logger.info(f"🧹 [CLEANUP] Cleaned up {len(keys_to_remove)} alert states for user {user_id}")
    
    def get_status(self) -> Dict[str, Any]:
        """
        Get current status of the face analyzer
        
        Returns:
            Status dictionary
        """
        return {
            "cached_references": len(self.reference_cache),
            "active_alerts": len([state for state in self.last_alert_state.values() if state["active"]]),
            "total_alert_states": len(self.last_alert_state),
            "cooldown_seconds": self.ALERT_COOLDOWN,
            "timestamp": datetime.now().isoformat()
        }
