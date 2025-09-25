import soundfile as sf
import numpy as np
import io
import logging
import time
from typing import Dict, Any
from pydub import AudioSegment

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class OptimizedCalibrationService:
    def __init__(self):
        """Initialize the optimized calibration service"""
        self.target_sample_rate = 16000  # Standard sample rate for analysis
        
    def calibrate(self, audio_data: bytes) -> Dict[str, Any]:
        """
        Optimized calibration using fast audio processing
        Works with 5+ second audio files (10+ seconds recommended for better accuracy)
        Focuses on essential metrics only for speed
        """
        start_time = time.time()
        
        try:
            logger.info(f"Starting OPTIMIZED calibration with {len(audio_data)} bytes")
            
            # Fast audio conversion
            logger.info("Fast audio conversion...")
            audio_array, sample_rate = self._fast_bytes_to_audio(audio_data)
            duration = len(audio_array) / sample_rate
            logger.info(f"Audio loaded: {duration:.2f}s, {sample_rate}Hz, {len(audio_array)} samples")
            
            # Fast noise analysis - simplified but effective
            logger.info("Fast noise analysis...")
            noise_analysis = self._fast_noise_analysis(audio_array, sample_rate)
            logger.info(f"Noise analysis: RMS={noise_analysis['rms_energy']:.6f}, Floor={noise_analysis['noise_floor']:.6f}")
            
            # Fast threshold calculation
            logger.info("Fast threshold calculation...")
            thresholds = self._fast_calculate_thresholds(noise_analysis)
            logger.info(f"Thresholds: Low={thresholds['low']:.6f}, Med={thresholds['medium']:.6f}, High={thresholds['high']:.6f}")
            
            # Basic metrics only
            logger.info("Basic metrics calculation...")
            basic_metrics = self._fast_basic_metrics(audio_array, sample_rate)
            
            processing_time = time.time() - start_time
            logger.info(f"OPTIMIZED calibration completed in {processing_time:.3f} seconds!")
            
            return {
                "status": "calibrated",
                "thresholds": thresholds,
                "noise_analysis": noise_analysis,
                "basic_metrics": basic_metrics,
                "sample_rate": sample_rate,
                "duration_seconds": duration,
                "processing_time_seconds": processing_time
            }
            
        except Exception as e:
            processing_time = time.time() - start_time
            logger.error(f"OPTIMIZED calibration failed after {processing_time:.3f}s: {str(e)}")
            raise Exception(f"Optimized calibration failed: {str(e)}")
    
    def _fast_bytes_to_audio(self, audio_data: bytes) -> tuple:
        """Fast audio conversion with minimal overhead"""
        try:
            # Try soundfile first (fastest for most formats)
            audio_io = io.BytesIO(audio_data)
            audio_array, sample_rate = sf.read(audio_io)
            
            # Convert to mono if stereo
            if len(audio_array.shape) > 1:
                audio_array = np.mean(audio_array, axis=1)
            
            # Fast resampling using scipy (much faster than librosa)
            if sample_rate != self.target_sample_rate:
                from scipy import signal
                # Calculate resampling ratio
                ratio = self.target_sample_rate / sample_rate
                new_length = int(len(audio_array) * ratio)
                audio_array = signal.resample(audio_array, new_length)
                sample_rate = self.target_sample_rate
            
            return audio_array.astype(np.float32), sample_rate
            
        except Exception:
            # Fallback to pydub only if soundfile fails
            try:
                audio_segment = AudioSegment.from_file(io.BytesIO(audio_data))
                audio_segment = audio_segment.set_channels(1).set_frame_rate(self.target_sample_rate)
                audio_array = np.array(audio_segment.get_array_of_samples(), dtype=np.float32)
                # Normalize
                max_val = np.max(np.abs(audio_array))
                if max_val > 0:
                    audio_array = audio_array / max_val
                return audio_array, self.target_sample_rate
            except Exception as e:
                raise Exception(f"Fast audio conversion failed: {str(e)}")
    
    def _fast_noise_analysis(self, audio_array: np.ndarray, sample_rate: int) -> Dict[str, Any]:
        """Fast noise analysis using only essential calculations"""
        try:
            # Calculate RMS energy (fast)
            rms_energy = np.sqrt(np.mean(audio_array**2))
            
            # Calculate noise floor and ceiling using simple percentile method
            # Use smaller frame size for speed
            frame_length = int(0.2 * sample_rate)  # 200ms frames (faster than 100ms)
            frame_energies = []
            
            # Sample every other frame for speed
            step_size = frame_length // 2
            for i in range(0, len(audio_array) - frame_length, step_size):
                frame = audio_array[i:i + frame_length]
                frame_energy = np.sqrt(np.mean(frame**2))
                frame_energies.append(frame_energy)
            
            frame_energies = np.array(frame_energies)
            noise_floor = np.percentile(frame_energies, 10)  # Bottom 10%
            noise_ceiling = np.percentile(frame_energies, 90)  # Top 10%
            
            # Simple frequency analysis using FFT (much faster than STFT)
            # Use smaller FFT size for speed
            fft_size = min(2048, len(audio_array))  # Smaller FFT
            fft = np.fft.fft(audio_array[:fft_size])
            magnitude = np.abs(fft)
            
            # Simple frequency band analysis
            frequencies = np.fft.fftfreq(fft_size, 1/sample_rate)
            low_freq_mask = np.abs(frequencies) <= 500
            mid_freq_mask = (np.abs(frequencies) > 500) & (np.abs(frequencies) <= 4000)
            high_freq_mask = np.abs(frequencies) > 4000
            
            low_energy = np.sum(magnitude[low_freq_mask])
            mid_energy = np.sum(magnitude[mid_freq_mask])
            high_energy = np.sum(magnitude[high_freq_mask])
            total_energy = low_energy + mid_energy + high_energy
            
            # Simple zero crossing rate (fast calculation)
            zero_crossings = np.where(np.diff(np.sign(audio_array)))[0]
            zcr = len(zero_crossings) / len(audio_array)
            
            return {
                "rms_energy": float(rms_energy),
                "noise_floor": float(noise_floor),
                "noise_ceiling": float(noise_ceiling),
                "zero_crossing_rate": float(zcr),
                "frequency_band_energies": {
                    "low": float(low_energy / total_energy) if total_energy > 0 else 0,
                    "mid": float(mid_energy / total_energy) if total_energy > 0 else 0,
                    "high": float(high_energy / total_energy) if total_energy > 0 else 0
                }
            }
            
        except Exception as e:
            logger.error(f"Fast noise analysis failed: {str(e)}")
            raise
    
    def _fast_calculate_thresholds(self, noise_analysis: Dict[str, Any]) -> Dict[str, float]:
        """Fast threshold calculation with simplified logic"""
        try:
            noise_floor = noise_analysis["noise_floor"]
            noise_ceiling = noise_analysis["noise_ceiling"]
            rms_energy = noise_analysis["rms_energy"]
            
            # Simplified threshold calculation
            # Low threshold: 2x noise floor
            low_threshold = noise_floor * 2.0
            
            # Medium threshold: between floor and ceiling
            medium_threshold = noise_floor + (noise_ceiling - noise_floor) * 0.6
            
            # High threshold: 1.5x noise ceiling
            high_threshold = noise_ceiling * 1.5
            
            # Ensure minimum separation
            min_separation = 0.001  # Smaller minimum for faster processing
            
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
            logger.error(f"Fast threshold calculation failed: {str(e)}")
            raise
    
    def _fast_basic_metrics(self, audio_array: np.ndarray, sample_rate: int) -> Dict[str, Any]:
        """Fast basic metrics calculation"""
        try:
            # Basic amplitude metrics
            max_amplitude = np.max(np.abs(audio_array))
            min_amplitude = np.min(np.abs(audio_array))
            
            # Simple dynamic range
            dynamic_range = 20 * np.log10(max_amplitude / min_amplitude) if min_amplitude > 0 else 0
            
            # Simple SNR estimation
            sorted_amplitudes = np.sort(np.abs(audio_array))
            noise_level = np.mean(sorted_amplitudes[:int(len(sorted_amplitudes) * 0.2)])
            signal_level = np.mean(sorted_amplitudes)
            snr_estimate = 20 * np.log10(signal_level / noise_level) if noise_level > 0 else 0
            
            return {
                "dynamic_range_db": float(dynamic_range),
                "snr_estimate_db": float(snr_estimate),
                "max_amplitude": float(max_amplitude),
                "min_amplitude": float(min_amplitude)
            }
            
        except Exception as e:
            logger.warning(f"Fast basic metrics calculation failed: {str(e)}")
            return {
                "dynamic_range_db": 0.0,
                "snr_estimate_db": 0.0,
                "max_amplitude": 0.0,
                "min_amplitude": 0.0
            }
