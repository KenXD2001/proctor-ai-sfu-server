import librosa
import soundfile as sf
import numpy as np
import webrtcvad
import io
import os
from datetime import datetime
from typing import Dict, Any, Optional
import logging
from pydub import AudioSegment
from pydub.utils import which

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class AudioAnalyzer:
    def __init__(self):
        """Initialize the audio analyzer with required models and configurations"""
        self.vad = webrtcvad.Vad(2)  # Aggressiveness level 2 (0-3)
        self.sample_rate = 16000  # WebRTC VAD works best at 16kHz
        
        # Create saved_audio directory if it doesn't exist
        os.makedirs("uploads/saved_audio", exist_ok=True)
    
    def analyze(self, audio_data: bytes, calibration_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Analyze audio clip for volume, speech, and background sounds
        
        Args:
            audio_data: Raw audio bytes
            calibration_data: Calibration thresholds from /calibrate endpoint
            
        Returns:
            Dictionary containing analysis results
        """
        try:
            # Convert bytes to audio array
            audio_array, sample_rate = self._bytes_to_audio(audio_data)
            
            # Analyze volume level
            volume_level = self._analyze_volume(audio_array, calibration_data)
            
            # Detect human speech
            speech_detected = self._detect_speech(audio_data)
            
            # Detect background sounds
            background_sounds = self._detect_background_sounds(audio_array, sample_rate)
            suspicious_sounds_detected = len(background_sounds) > 0
            
            # Calculate additional metrics
            rms_energy = np.sqrt(np.mean(audio_array**2))
            spectral_centroid = self._calculate_spectral_centroid(audio_array, sample_rate)
            
            return {
                "volume_level": volume_level,
                "rms_energy": float(rms_energy),
                "spectral_centroid": float(spectral_centroid),
                "human_speech_detected": speech_detected,
                "suspicious_sounds_detected": suspicious_sounds_detected,
                "detected_background_sounds": background_sounds,
                "sample_rate": sample_rate,
                "duration_seconds": len(audio_array) / sample_rate
            }
            
        except Exception as e:
            logger.error(f"Error in audio analysis: {str(e)}")
            raise
    
    def _bytes_to_audio(self, audio_data: bytes) -> tuple:
        """Convert raw audio bytes to numpy array and sample rate"""
        try:
            # Try to read with soundfile first
            audio_io = io.BytesIO(audio_data)
            audio_array, sample_rate = sf.read(audio_io)
            
            # Convert to mono if stereo
            if len(audio_array.shape) > 1:
                audio_array = np.mean(audio_array, axis=1)
            
            return audio_array, sample_rate
            
        except Exception:
            try:
                # Fallback to pydub for more format support
                audio_segment = AudioSegment.from_file(io.BytesIO(audio_data))
                
                # Convert to mono and 16kHz
                audio_segment = audio_segment.set_channels(1).set_frame_rate(self.sample_rate)
                
                # Convert to numpy array
                audio_array = np.array(audio_segment.get_array_of_samples(), dtype=np.float32)
                audio_array = audio_array / np.max(np.abs(audio_array))  # Normalize
                
                return audio_array, self.sample_rate
                
            except Exception as e:
                raise Exception(f"Failed to read audio data: {str(e)}")
    
    def _analyze_volume(self, audio_array: np.ndarray, calibration_data: Dict[str, Any]) -> str:
        """Analyze volume level based on calibration thresholds"""
        rms_energy = np.sqrt(np.mean(audio_array**2))
        
        thresholds = calibration_data["thresholds"]
        
        if rms_energy < thresholds["low"]:
            return "low"
        elif rms_energy < thresholds["medium"]:
            return "medium"
        else:
            return "high"
    
    def _detect_speech(self, audio_data: bytes) -> bool:
        """Detect human speech using WebRTC VAD"""
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
            
            for i in range(0, len(raw_audio) - frame_size * 2, frame_size * 2):
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
            logger.warning(f"Speech detection failed: {str(e)}")
            return False
    
    def _detect_background_sounds(self, audio_array: np.ndarray, sample_rate: int) -> list:
        """Detect suspicious background sounds using spectral analysis"""
        detected_sounds = []
        
        try:
            # Calculate spectral features
            spectral_centroid = self._calculate_spectral_centroid(audio_array, sample_rate)
            spectral_rolloff = self._calculate_spectral_rolloff(audio_array, sample_rate)
            zero_crossing_rate = self._calculate_zero_crossing_rate(audio_array)
            
            # Detect typing sounds (high zero-crossing rate, mid-range spectral centroid)
            if zero_crossing_rate > 0.1 and 1000 < spectral_centroid < 4000:
                detected_sounds.append("typing")
            
            # Detect phone sounds (specific frequency patterns)
            if self._detect_phone_frequencies(audio_array, sample_rate):
                detected_sounds.append("phone")
            
            # Detect door sounds (low frequency, sudden onset)
            if spectral_centroid < 500 and self._detect_sudden_onset(audio_array):
                detected_sounds.append("door")
            
            # Detect other mechanical sounds
            if spectral_rolloff > 0.8 and zero_crossing_rate > 0.05:
                detected_sounds.append("mechanical")
                
        except Exception as e:
            logger.warning(f"Background sound detection failed: {str(e)}")
        
        return detected_sounds
    
    def _calculate_spectral_centroid(self, audio_array: np.ndarray, sample_rate: int) -> float:
        """Calculate spectral centroid"""
        stft = librosa.stft(audio_array)
        magnitude = np.abs(stft)
        frequencies = librosa.fft_frequencies(sr=sample_rate)
        
        spectral_centroid = np.sum(frequencies[:, np.newaxis] * magnitude, axis=0) / np.sum(magnitude, axis=0)
        return np.mean(spectral_centroid)
    
    def _calculate_spectral_rolloff(self, audio_array: np.ndarray, sample_rate: int) -> float:
        """Calculate spectral rolloff"""
        rolloff = librosa.feature.spectral_rolloff(y=audio_array, sr=sample_rate)[0]
        return np.mean(rolloff) / sample_rate
    
    def _calculate_zero_crossing_rate(self, audio_array: np.ndarray) -> float:
        """Calculate zero crossing rate"""
        zcr = librosa.feature.zero_crossing_rate(audio_array)[0]
        return np.mean(zcr)
    
    def _detect_phone_frequencies(self, audio_array: np.ndarray, sample_rate: int) -> bool:
        """Detect phone-specific frequency patterns"""
        try:
            # Analyze frequency spectrum
            stft = librosa.stft(audio_array)
            magnitude = np.abs(stft)
            
            # Phone calls often have specific frequency patterns
            frequencies = librosa.fft_frequencies(sr=sample_rate)
            
            # Check for phone frequency bands (300-3400 Hz for voice)
            voice_mask = (frequencies >= 300) & (frequencies <= 3400)
            voice_energy = np.sum(magnitude[voice_mask, :])
            total_energy = np.sum(magnitude)
            
            # Phone calls typically have high energy in voice band
            return (voice_energy / total_energy) > 0.7 if total_energy > 0 else False
            
        except Exception:
            return False
    
    def _detect_sudden_onset(self, audio_array: np.ndarray) -> bool:
        """Detect sudden onset of sound (like door closing)"""
        try:
            # Calculate energy envelope
            hop_length = 512
            frame_length = 2048
            
            # Simple energy calculation
            energy = []
            for i in range(0, len(audio_array) - frame_length, hop_length):
                frame = audio_array[i:i + frame_length]
                energy.append(np.sum(frame**2))
            
            energy = np.array(energy)
            
            # Detect sudden increase in energy
            if len(energy) > 2:
                energy_diff = np.diff(energy)
                max_diff = np.max(energy_diff)
                mean_diff = np.mean(np.abs(energy_diff))
                
                # Sudden onset if max difference is significantly higher than mean
                return max_diff > 3 * mean_diff
            
            return False
            
        except Exception:
            return False
    
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
