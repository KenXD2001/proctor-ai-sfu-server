import logging
import os
import json
from datetime import datetime
from typing import Dict, Any, List
import threading

class FaceAnalysisLogger:
    """
    Comprehensive logging system for face analysis similar to noise detection
    """
    
    def __init__(self, log_dir: str = "logs"):
        """
        Initialize the face analysis logger
        
        Args:
            log_dir: Directory to store log files
        """
        self.log_dir = log_dir
        self.log_lock = threading.Lock()
        
        # Setup logging (this will create directories)
        self.setup_logging()
        
        self.logger.info("Face analysis logger initialized")
    
    def setup_logging(self):
        """Setup logging configuration"""
        # Create main logger
        self.logger = logging.getLogger('face_analysis')
        self.logger.setLevel(logging.INFO)
        
        # Create formatters
        detailed_formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
        )
        simple_formatter = logging.Formatter(
            '%(asctime)s - %(levelname)s - %(message)s'
        )
        
        # Console handler
        console_handler = logging.StreamHandler()
        console_handler.setLevel(logging.INFO)
        console_handler.setFormatter(simple_formatter)
        self.logger.addHandler(console_handler)
        
        # Ensure log directories exist before creating file handlers
        face_analysis_log_dir = os.path.join(self.log_dir, "face_analysis")
        performance_log_dir = os.path.join(self.log_dir, "performance")
        violations_log_dir = os.path.join(self.log_dir, "violations")
        
        os.makedirs(face_analysis_log_dir, exist_ok=True)
        os.makedirs(performance_log_dir, exist_ok=True)
        os.makedirs(violations_log_dir, exist_ok=True)
        
        # Main log file handler
        main_log_file = os.path.join(face_analysis_log_dir, "face_analysis.log")
        main_file_handler = logging.FileHandler(main_log_file)
        main_file_handler.setLevel(logging.INFO)
        main_file_handler.setFormatter(detailed_formatter)
        self.logger.addHandler(main_file_handler)
        
        # Error log file handler
        error_log_file = os.path.join(face_analysis_log_dir, "errors.log")
        error_file_handler = logging.FileHandler(error_log_file)
        error_file_handler.setLevel(logging.ERROR)
        error_file_handler.setFormatter(detailed_formatter)
        self.logger.addHandler(error_file_handler)
        
        # Performance logger
        self.performance_logger = logging.getLogger('face_analysis_performance')
        self.performance_logger.setLevel(logging.INFO)
        perf_log_file = os.path.join(performance_log_dir, "face_analysis_performance.log")
        perf_handler = logging.FileHandler(perf_log_file)
        perf_handler.setFormatter(detailed_formatter)
        self.performance_logger.addHandler(perf_handler)
        
        # Violation logger
        self.violation_logger = logging.getLogger('face_analysis_violations')
        self.violation_logger.setLevel(logging.INFO)
        violation_log_file = os.path.join(violations_log_dir, "face_violations.log")
        violation_handler = logging.FileHandler(violation_log_file)
        violation_handler.setFormatter(detailed_formatter)
        self.violation_logger.addHandler(violation_handler)
    
    def log_analysis_start(self, user_id: str, frame_size: int):
        """
        Log the start of face analysis
        
        Args:
            user_id: User ID
            frame_size: Size of frame in bytes
        """
        with self.log_lock:
            self.logger.info(f"[ANALYSIS START] User: {user_id} | Frame size: {frame_size} bytes")
    
    def log_analysis_complete(self, user_id: str, processing_time: float, violations: List[str], 
                            analysis_data: Dict[str, Any]):
        """
        Log the completion of face analysis
        
        Args:
            user_id: User ID
            processing_time: Processing time in seconds
            violations: List of violations detected
            analysis_data: Analysis data dictionary
        """
        with self.log_lock:
            violation_count = len(violations)
            violation_types = ", ".join(violations) if violations else "None"
            
            self.logger.info(
                f"[ANALYSIS COMPLETE] User: {user_id} | "
                f"Time: {processing_time:.3f}s | "
                f"Violations: {violation_count} | "
                f"Types: {violation_types}"
            )
            
            # Log performance metrics
            self.performance_logger.info(
                f"PERFORMANCE - User: {user_id} | "
                f"Processing time: {processing_time:.3f}s | "
                f"Faces detected: {analysis_data.get('total_faces_detected', 0)} | "
                f"Face distance: {analysis_data.get('face_distance', 'N/A')} | "
                f"Match score: {analysis_data.get('face_match_score', 'N/A')}%"
            )
            
            # Log violations if any
            if violations:
                self.log_violation(user_id, violations, analysis_data)
    
    def log_violation(self, user_id: str, violations: List[str], analysis_data: Dict[str, Any]):
        """
        Log detected violations
        
        Args:
            user_id: User ID
            violations: List of violations
            analysis_data: Analysis data
        """
        with self.log_lock:
            violation_data = {
                "timestamp": datetime.now().isoformat(),
                "user_id": user_id,
                "violations": violations,
                "analysis_data": analysis_data,
                "severity": self._calculate_severity(violations)
            }
            
            self.violation_logger.error(
                f"🚨 [VIOLATION DETECTED] User: {user_id} | "
                f"Violations: {', '.join(violations)} | "
                f"Severity: {violation_data['severity']}"
            )
            
            # Save detailed violation log
            self._save_violation_log(violation_data)
    
    def log_database_operation(self, operation: str, user_id: str, success: bool, details: str = ""):
        """
        Log database operations
        
        Args:
            operation: Database operation type
            user_id: User ID
            success: Whether operation was successful
            details: Additional details
        """
        with self.log_lock:
            status = "SUCCESS" if success else "FAILED"
            self.logger.info(
                f"[DATABASE {status}] Operation: {operation} | "
                f"User: {user_id} | Details: {details}"
            )
    
    def log_reference_face_loaded(self, user_id: str, face_filename: str, cached: bool):
        """
        Log reference face loading
        
        Args:
            user_id: User ID
            face_filename: Face filename
            cached: Whether face was loaded from cache
        """
        with self.log_lock:
            cache_status = "CACHED" if cached else "FROM_DB"
            self.logger.info(
                f"[REFERENCE FACE {cache_status}] User: {user_id} | "
                f"Filename: {face_filename}"
            )
    
    def log_frame_saved(self, user_id: str, file_path: str, violations: List[str]):
        """
        Log frame saving
        
        Args:
            user_id: User ID
            file_path: Path to saved frame
            violations: Violations that triggered saving
        """
        with self.log_lock:
            self.logger.info(
                f"[FRAME SAVED] User: {user_id} | "
                f"File: {os.path.basename(file_path)} | "
                f"Violations: {', '.join(violations)}"
            )
    
    def log_alert_state_change(self, user_id: str, alert_type: str, state: str, cooldown_remaining: float = 0):
        """
        Log alert state changes
        
        Args:
            user_id: User ID
            alert_type: Type of alert
            state: New state (triggered/resolved/suppressed)
            cooldown_remaining: Remaining cooldown time
        """
        with self.log_lock:
            if state == "triggered":
                self.logger.warning(
                    f"[ALERT TRIGGERED] User: {user_id} | "
                    f"Type: {alert_type}"
                )
            elif state == "resolved":
                self.logger.info(
                    f"[ALERT RESOLVED] User: {user_id} | "
                    f"Type: {alert_type}"
                )
            elif state == "suppressed":
                self.logger.debug(
                    f"[ALERT SUPPRESSED] User: {user_id} | "
                    f"Type: {alert_type} | "
                    f"Cooldown: {cooldown_remaining:.1f}s"
                )
    
    def log_error(self, user_id: str, error_type: str, error_message: str, context: Dict[str, Any] = None):
        """
        Log errors
        
        Args:
            user_id: User ID
            error_type: Type of error
            error_message: Error message
            context: Additional context
        """
        with self.log_lock:
            self.logger.error(
                f"[ERROR] User: {user_id} | "
                f"Type: {error_type} | "
                f"Message: {error_message}"
            )
            
            if context:
                self.logger.error(f"Context: {json.dumps(context, indent=2)}")
    
    def log_service_status(self, status_data: Dict[str, Any]):
        """
        Log service status
        
        Args:
            status_data: Service status data
        """
        with self.log_lock:
            self.logger.info(
                f"[SERVICE STATUS] "
                f"Cached references: {status_data.get('cached_references', 0)} | "
                f"Active alerts: {status_data.get('active_alerts', 0)} | "
                f"Total alert states: {status_data.get('total_alert_states', 0)}"
            )
    
    def _calculate_severity(self, violations: List[str]) -> str:
        """
        Calculate violation severity
        
        Args:
            violations: List of violations
            
        Returns:
            Severity level (low/medium/high)
        """
        high_severity = ["Face mismatch detected", "Multiple faces found"]
        medium_severity = ["Face not detected", "Face partially blocked"]
        
        if any(v in high_severity for v in violations):
            return "high"
        elif any(v in medium_severity for v in violations):
            return "medium"
        else:
            return "low"
    
    def _save_violation_log(self, violation_data: Dict[str, Any]):
        """
        Save detailed violation log to JSON file
        
        Args:
            violation_data: Violation data dictionary
        """
        try:
            date_str = datetime.now().strftime("%Y%m%d")
            log_file = os.path.join(
                self.log_dir, 
                "violations", 
                f"violations_{date_str}.jsonl"
            )
            
            with open(log_file, "a") as f:
                f.write(json.dumps(violation_data) + "\n")
                
        except Exception as e:
            self.logger.error(f"Failed to save violation log: {e}")
    
    def get_log_summary(self, hours: int = 24) -> Dict[str, Any]:
        """
        Get log summary for the last N hours
        
        Args:
            hours: Number of hours to look back
            
        Returns:
            Log summary dictionary
        """
        try:
            # This is a simplified version - in production you might want to use
            # a proper log analysis tool or database
            summary = {
                "period_hours": hours,
                "timestamp": datetime.now().isoformat(),
                "note": "Log analysis not implemented - use external tools for detailed analysis"
            }
            
            return summary
            
        except Exception as e:
            self.logger.error(f"Failed to get log summary: {e}")
            return {"error": str(e)}

# Global logger instance
face_analysis_logger = FaceAnalysisLogger()
