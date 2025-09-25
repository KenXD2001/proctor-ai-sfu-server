import librosa
import soundfile as sf
import numpy as np
import io
import logging
from typing import Dict, Any
from pydub import AudioSegment

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class CalibrationService:
    def __init__(self):
        """Initialize the calibration service"""
        self.target_sample_rate = 16000  # Standard sample rate for analysis
        
    def calibrate(self, audio_data: bytes) -> Dict[str, Any]:
        """
        Calibrate audio system by analyzing 10-second clip to find background noise thresholds
        
        Args:
            audio_data: Raw audio bytes from 10-second calibration clip
            
        Returns:
            Dictionary containing calibration results and thresholds
        """
        try:
            logger.info(f"Starting calibration process with {len(audio_data)} bytes of audio data")
            
            # Convert bytes to audio array
            logger.info("Converting audio bytes to numpy array...")
            audio_array, sample_rate = self._bytes_to_audio(audio_data)
            duration = len(audio_array) / sample_rate
            logger.info(f"Audio loaded: {duration:.2f}s duration, {sample_rate}Hz sample rate, {len(audio_array)} samples")
            
            # Analyze the audio for background noise characteristics
            logger.info("🔍 Analyzing background noise characteristics...")
            noise_analysis = self._analyze_background_noise(audio_array, sample_rate)
            logger.info(f"Noise analysis complete - RMS: {noise_analysis['rms_energy']:.6f}, Floor: {noise_analysis['noise_floor']:.6f}, Ceiling: {noise_analysis['noise_ceiling']:.6f}")
            
            # Calculate thresholds based on noise analysis
            logger.info("📏 Calculating volume thresholds...")
            thresholds = self._calculate_thresholds(noise_analysis)
            logger.info(f"Thresholds calculated - Low: {thresholds['low']:.6f}, Medium: {thresholds['medium']:.6f}, High: {thresholds['high']:.6f}")
            
            # Perform additional analysis for calibration insights
            logger.info("📈 Calculating calibration metrics...")
            calibration_metrics = self._calculate_calibration_metrics(audio_array, sample_rate)
            logger.info(f"Metrics calculated - Dynamic Range: {calibration_metrics['dynamic_range_db']:.2f}dB, SNR: {calibration_metrics['snr_estimate_db']:.2f}dB")
            
            result = {
                "status": "calibrated",
                "thresholds": thresholds,
                "noise_analysis": noise_analysis,
                "calibration_metrics": calibration_metrics,
                "sample_rate": sample_rate,
                "duration_seconds": duration
            }
            
            logger.info("Calibration process completed successfully!")
            return result
            
        except Exception as e:
            logger.error(f"Calibration failed: {str(e)}")
            raise Exception(f"Calibration failed: {str(e)}")
    
    def _bytes_to_audio(self, audio_data: bytes) -> tuple:
        """Convert raw audio bytes to numpy array and sample rate"""
        try:
            # Try to read with soundfile first
            audio_io = io.BytesIO(audio_data)
            audio_array, sample_rate = sf.read(audio_io)
            
            # Convert to mono if stereo
            if len(audio_array.shape) > 1:
                audio_array = np.mean(audio_array, axis=1)
            
            # Resample to target sample rate if needed
            if sample_rate != self.target_sample_rate:
                audio_array = librosa.resample(audio_array, orig_sr=sample_rate, target_sr=self.target_sample_rate)
                sample_rate = self.target_sample_rate
            
            return audio_array, sample_rate
            
        except Exception:
            try:
                # Fallback to pydub for more format support
                audio_segment = AudioSegment.from_file(io.BytesIO(audio_data))
                
                # Convert to mono and target sample rate
                audio_segment = audio_segment.set_channels(1).set_frame_rate(self.target_sample_rate)
                
                # Convert to numpy array
                audio_array = np.array(audio_segment.get_array_of_samples(), dtype=np.float32)
                audio_array = audio_array / np.max(np.abs(audio_array))  # Normalize
                
                return audio_array, self.target_sample_rate
                
            except Exception as e:
                raise Exception(f"Failed to read calibration audio data: {str(e)}")
    
    def _analyze_background_noise(self, audio_array: np.ndarray, sample_rate: int) -> Dict[str, Any]:
        """Analyze background noise characteristics"""
        try:
            # Calculate RMS energy
            rms_energy = np.sqrt(np.mean(audio_array**2))
            
            # Calculate energy in different frequency bands
            stft = librosa.stft(audio_array)
            magnitude = np.abs(stft)
            frequencies = librosa.fft_frequencies(sr=sample_rate)
            
            # Define frequency bands
            low_freq_mask = frequencies <= 500
            mid_freq_mask = (frequencies > 500) & (frequencies <= 4000)
            high_freq_mask = frequencies > 4000
            
            # Calculate energy in each band
            low_energy = np.sum(magnitude[low_freq_mask, :])
            mid_energy = np.sum(magnitude[mid_freq_mask, :])
            high_energy = np.sum(magnitude[high_freq_mask, :])
            total_energy = low_energy + mid_energy + high_energy
            
            # Calculate spectral centroid and rolloff
            spectral_centroid = np.sum(frequencies[:, np.newaxis] * magnitude, axis=0) / np.sum(magnitude, axis=0)
            spectral_centroid_mean = np.mean(spectral_centroid)
            
            spectral_rolloff = librosa.feature.spectral_rolloff(y=audio_array, sr=sample_rate)[0]
            spectral_rolloff_mean = np.mean(spectral_rolloff) / sample_rate
            
            # Calculate zero crossing rate
            zero_crossing_rate = librosa.feature.zero_crossing_rate(audio_array)[0]
            zcr_mean = np.mean(zero_crossing_rate)
            
            # Calculate noise floor (quietest 10% of the audio)
            frame_length = int(0.1 * sample_rate)  # 100ms frames
            frame_energies = []
            
            for i in range(0, len(audio_array) - frame_length, frame_length):
                frame = audio_array[i:i + frame_length]
                frame_energy = np.sqrt(np.mean(frame**2))
                frame_energies.append(frame_energy)
            
            frame_energies = np.array(frame_energies)
            noise_floor = np.percentile(frame_energies, 10)  # Bottom 10%
            noise_ceiling = np.percentile(frame_energies, 90)  # Top 10%
            
            return {
                "rms_energy": float(rms_energy),
                "noise_floor": float(noise_floor),
                "noise_ceiling": float(noise_ceiling),
                "spectral_centroid": float(spectral_centroid_mean),
                "spectral_rolloff": float(spectral_rolloff_mean),
                "zero_crossing_rate": float(zcr_mean),
                "frequency_band_energies": {
                    "low": float(low_energy / total_energy) if total_energy > 0 else 0,
                    "mid": float(mid_energy / total_energy) if total_energy > 0 else 0,
                    "high": float(high_energy / total_energy) if total_energy > 0 else 0
                }
            }
            
        except Exception as e:
            logger.error(f"Background noise analysis failed: {str(e)}")
            raise
    
    def _calculate_thresholds(self, noise_analysis: Dict[str, Any]) -> Dict[str, float]:
        """Calculate volume thresholds based on noise analysis"""
        try:
            noise_floor = noise_analysis["noise_floor"]
            noise_ceiling = noise_analysis["noise_ceiling"]
            rms_energy = noise_analysis["rms_energy"]
            
            # Calculate thresholds based on noise characteristics
            # Low threshold: slightly above noise floor
            low_threshold = noise_floor * 2.0
            
            # Medium threshold: between noise floor and ceiling
            medium_threshold = noise_floor + (noise_ceiling - noise_floor) * 0.6
            
            # High threshold: above noise ceiling
            high_threshold = noise_ceiling * 1.5
            
            # Ensure thresholds are reasonable (not too close together)
            min_separation = 0.01  # Minimum separation between thresholds
            
            if medium_threshold - low_threshold < min_separation:
                medium_threshold = low_threshold + min_separation
            
            if high_threshold - medium_threshold < min_separation:
                high_threshold = medium_threshold + min_separation
            
            return {
                "low": float(low_threshold),
                "medium": float(medium_threshold),
                "high": float(high_threshold),
                "noise_floor": float(noise_floor),
                "noise_ceiling": float(noise_ceiling)
            }
            
        except Exception as e:
            logger.error(f"Threshold calculation failed: {str(e)}")
            raise
    
    def _calculate_calibration_metrics(self, audio_array: np.ndarray, sample_rate: int) -> Dict[str, Any]:
        """Calculate additional metrics for calibration insights"""
        try:
            # Calculate dynamic range
            max_amplitude = np.max(np.abs(audio_array))
            min_amplitude = np.min(np.abs(audio_array))
            dynamic_range = 20 * np.log10(max_amplitude / min_amplitude) if min_amplitude > 0 else 0
            
            # Calculate signal-to-noise ratio estimation
            # Use quietest 20% as noise reference
            sorted_amplitudes = np.sort(np.abs(audio_array))
            noise_level = np.mean(sorted_amplitudes[:int(len(sorted_amplitudes) * 0.2)])
            signal_level = np.mean(sorted_amplitudes)
            snr_estimate = 20 * np.log10(signal_level / noise_level) if noise_level > 0 else 0
            
            # Calculate spectral characteristics
            spectral_bandwidth = librosa.feature.spectral_bandwidth(y=audio_array, sr=sample_rate)[0]
            spectral_bandwidth_mean = np.mean(spectral_bandwidth)
            
            # Calculate temporal characteristics
            onset_frames = librosa.onset.onset_detect(y=audio_array, sr=sample_rate)
            onset_rate = len(onset_frames) / (len(audio_array) / sample_rate)  # onsets per second
            
            return {
                "dynamic_range_db": float(dynamic_range),
                "snr_estimate_db": float(snr_estimate),
                "spectral_bandwidth": float(spectral_bandwidth_mean),
                "onset_rate_per_second": float(onset_rate),
                "max_amplitude": float(max_amplitude),
                "min_amplitude": float(min_amplitude)
            }
            
        except Exception as e:
            logger.warning(f"Calibration metrics calculation failed: {str(e)}")
            return {
                "dynamic_range_db": 0.0,
                "snr_estimate_db": 0.0,
                "spectral_bandwidth": 0.0,
                "onset_rate_per_second": 0.0,
                "max_amplitude": 0.0,
                "min_amplitude": 0.0
            }
