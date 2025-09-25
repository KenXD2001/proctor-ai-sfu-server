import soundfile as sf
import numpy as np
import webrtcvad
import io
import os
from datetime import datetime
from typing import Dict, Any, Optional
import logging
from pydub import AudioSegment

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class OptimizedAudioAnalyzer:
    def __init__(self):
        """Initialize the optimized audio analyzer"""
        self.vad = webrtcvad.Vad(2)  # Aggressiveness level 2 (0-3)
        self.sample_rate = 16000  # WebRTC VAD works best at 16kHz
        
        # Create saved_audio directory if it doesn't exist
        os.makedirs("uploads/saved_audio", exist_ok=True)
    
    def analyze(self, audio_data: bytes, calibration_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Fast audio analysis focusing on essential metrics
        Optimized for 5-second audio segments for real-time processing
        """
        start_time = datetime.now()
        
        try:
            logger.info("Starting OPTIMIZED audio analysis...")
            
            # Fast audio conversion
            audio_array, sample_rate = self._fast_bytes_to_audio(audio_data)
            logger.info(f"Audio loaded: {len(audio_array)} samples at {sample_rate}Hz")
            
            # Fast volume analysis
            volume_level = self._fast_analyze_volume(audio_array, calibration_data)
            logger.info(f"Volume analysis: {volume_level}")
            
            # Fast speech detection
            speech_detected = self._fast_detect_speech(audio_data)
            logger.info(f"Speech detection: {speech_detected}")
            
            # Fast background sound detection
            background_sounds = self._fast_detect_background_sounds(audio_array, sample_rate)
            suspicious_sounds_detected = len(background_sounds) > 0
            logger.info(f"Background sounds: {background_sounds}")
            
            # Basic metrics
            rms_energy = np.sqrt(np.mean(audio_array**2))
            
            processing_time = (datetime.now() - start_time).total_seconds()
            logger.info(f"OPTIMIZED analysis completed in {processing_time:.3f} seconds!")
            
            return {
                "volume_level": volume_level,
                "rms_energy": float(rms_energy),
                "human_speech_detected": speech_detected,
                "suspicious_sounds_detected": suspicious_sounds_detected,
                "detected_background_sounds": background_sounds,
                "sample_rate": sample_rate,
                "duration_seconds": len(audio_array) / sample_rate,
                "processing_time_seconds": processing_time
            }
            
        except Exception as e:
            processing_time = (datetime.now() - start_time).total_seconds()
            logger.error(f"OPTIMIZED analysis failed after {processing_time:.3f}s: {str(e)}")
            raise
    
    def _fast_bytes_to_audio(self, audio_data: bytes) -> tuple:
        """Fast audio conversion"""
        try:
            # Try soundfile first (fastest)
            audio_io = io.BytesIO(audio_data)
            audio_array, sample_rate = sf.read(audio_io)
            
            # Convert to mono if stereo
            if len(audio_array.shape) > 1:
                audio_array = np.mean(audio_array, axis=1)
            
            return audio_array.astype(np.float32), sample_rate
            
        except Exception:
            try:
                # Fallback to pydub
                audio_segment = AudioSegment.from_file(io.BytesIO(audio_data))
                audio_segment = audio_segment.set_channels(1).set_frame_rate(self.sample_rate)
                audio_array = np.array(audio_segment.get_array_of_samples(), dtype=np.float32)
                
                # Normalize
                max_val = np.max(np.abs(audio_array))
                if max_val > 0:
                    audio_array = audio_array / max_val
                
                return audio_array, self.sample_rate
                
            except Exception as e:
                raise Exception(f"Fast audio conversion failed: {str(e)}")
    
    def _fast_analyze_volume(self, audio_array: np.ndarray, calibration_data: Dict[str, Any]) -> str:
        """Fast volume analysis"""
        rms_energy = np.sqrt(np.mean(audio_array**2))
        thresholds = calibration_data["thresholds"]
        
        if rms_energy < thresholds["low"]:
            return "low"
        elif rms_energy < thresholds["medium"]:
            return "medium"
        else:
            return "high"
    
    def _fast_detect_speech(self, audio_data: bytes) -> bool:
        """Fast speech detection using WebRTC VAD"""
        try:
            # Convert to 16kHz mono PCM for VAD
            audio_segment = AudioSegment.from_file(io.BytesIO(audio_data))
            audio_segment = audio_segment.set_channels(1).set_frame_rate(self.sample_rate)
            
            # Get raw audio data
            raw_audio = audio_segment.raw_data
            
            # WebRTC VAD expects 10ms, 20ms, or 30ms frames
            frame_duration_ms = 20
            frame_size = int(self.sample_rate * frame_duration_ms / 1000)
            
            speech_frames = 0
            total_frames = 0
            
            # Process frames (sample every other frame for speed)
            step_size = frame_size * 2
            for i in range(0, len(raw_audio) - frame_size * 2, step_size):
                frame = raw_audio[i:i + frame_size * 2]
                if len(frame) == frame_size * 2:
                    is_speech = self.vad.is_speech(frame, self.sample_rate)
                    if is_speech:
                        speech_frames += 1
                    total_frames += 1
            
            # Consider speech detected if more than 30% of frames contain speech
            speech_ratio = speech_frames / total_frames if total_frames > 0 else 0
            return speech_ratio > 0.3
            
        except Exception as e:
            logger.warning(f"Fast speech detection failed: {str(e)}")
            return False
    
    def _fast_detect_background_sounds(self, audio_array: np.ndarray, sample_rate: int) -> list:
        """Fast background sound detection using simple frequency analysis"""
        detected_sounds = []
        
        try:
            # Fast FFT analysis
            fft_size = min(1024, len(audio_array))  # Smaller FFT for speed
            fft = np.fft.fft(audio_array[:fft_size])
            magnitude = np.abs(fft)
            
            # Simple frequency band analysis
            frequencies = np.fft.fftfreq(fft_size, 1/sample_rate)
            
            # Calculate energy in different frequency bands
            low_freq_mask = np.abs(frequencies) <= 500
            mid_freq_mask = (np.abs(frequencies) > 500) & (np.abs(frequencies) <= 4000)
            high_freq_mask = np.abs(frequencies) > 4000
            
            low_energy = np.sum(magnitude[low_freq_mask])
            mid_energy = np.sum(magnitude[mid_freq_mask])
            high_energy = np.sum(magnitude[high_freq_mask])
            total_energy = low_energy + mid_energy + high_energy
            
            # Simple zero crossing rate
            zero_crossings = np.where(np.diff(np.sign(audio_array)))[0]
            zcr = len(zero_crossings) / len(audio_array)
            
            # Simple spectral centroid (weighted average frequency)
            if total_energy > 0:
                spectral_centroid = np.sum(np.abs(frequencies) * magnitude) / total_energy
            else:
                spectral_centroid = 0
            
            # Detect typing sounds (high zero-crossing rate, mid-range spectral centroid)
            if zcr > 0.1 and 1000 < spectral_centroid < 4000:
                detected_sounds.append("typing")
            
            # Detect phone sounds (high energy in voice band)
            if mid_energy / total_energy > 0.7:
                detected_sounds.append("phone")
            
            # Detect door sounds (low frequency, high energy)
            if spectral_centroid < 500 and low_energy / total_energy > 0.6:
                detected_sounds.append("door")
            
            # Detect mechanical sounds (high zero-crossing rate)
            if zcr > 0.05 and mid_energy / total_energy > 0.5:
                detected_sounds.append("mechanical")
                
        except Exception as e:
            logger.warning(f"Fast background sound detection failed: {str(e)}")
        
        return detected_sounds
    
    def save_audio_file(self, audio_data: bytes, analysis_result: Dict[str, Any]) -> str:
        """Save audio file based on analysis results"""
        try:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            
            # Create filename with analysis details
            volume = analysis_result["volume_level"]
            speech = "speech" if analysis_result["human_speech_detected"] else "no_speech"
            sounds = "_".join(analysis_result["detected_background_sounds"]) if analysis_result["detected_background_sounds"] else "clean"
            
            filename = f"audio_{timestamp}_{volume}_{speech}_{sounds}.wav"
            filepath = os.path.join("uploads", "saved_audio", filename)
            
            # Save the audio file
            with open(filepath, 'wb') as f:
                f.write(audio_data)
            
            logger.info(f"Audio file saved: {filepath}")
            return filepath
            
        except Exception as e:
            logger.error(f"Failed to save audio file: {str(e)}")
            raise
