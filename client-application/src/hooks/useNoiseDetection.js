import { useEffect, useRef, useState } from 'react';
import detectionConfig from '../config/detectionConfig';

const { noise: noiseConfig } = detectionConfig;

const DEFAULT_NOISE_THRESHOLD = noiseConfig.threshold;
const DEFAULT_SENSITIVITY = noiseConfig.sensitivity;
const SAMPLE_INTERVAL = noiseConfig.sampleInterval;
const MIN_LEVEL_DELTA = noiseConfig.minLevelDelta;
const LOG_INTERVAL = noiseConfig.logInterval;

const useNoiseDetection = (stream, options = {}) => {
  const threshold = options.threshold ?? DEFAULT_NOISE_THRESHOLD;
  const sensitivity = options.sensitivity ?? DEFAULT_SENSITIVITY;
  const [noiseLevel, setNoiseLevel] = useState(0);
  const [noiseDetected, setNoiseDetected] = useState(false);
  const [metrics, setMetrics] = useState({
    db: -Infinity,
    baseline: 0,
    absoluteThreshold: threshold,
    dynamicThreshold: threshold,
  });
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const dataArrayRef = useRef(null);
  const rafRef = useRef(null);
  const gainNodeRef = useRef(null);
  const lastLogTimeRef = useRef(0);
  const noiseLevelRef = useRef(0);
  const noiseDetectedRef = useRef(false);
  const baselineRef = useRef(null);
  const calibrationRef = useRef({
    samples: 0,
    durationMs: 0,
  });

  useEffect(() => {
    if (!stream) {
      setNoiseLevel(0);
      setNoiseDetected(false);
      setMetrics((prev) => ({
        db: -Infinity,
        baseline: 0,
        absoluteThreshold: threshold,
        dynamicThreshold: threshold,
      }));
      noiseLevelRef.current = 0;
      noiseDetectedRef.current = false;
      baselineRef.current = null;
      calibrationRef.current = { samples: 0, durationMs: 0 };
      return;
    }

    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    audioContextRef.current = audioContext;

    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;

    analyserRef.current = analyser;
    source.connect(analyser);
    dataArrayRef.current = new Float32Array(analyser.fftSize);

    const gainNode = audioContext.createGain();
    gainNode.gain.value = 0;
    analyser.connect(gainNode);
    gainNode.connect(audioContext.destination);
    gainNodeRef.current = gainNode;

    console.log('[NoiseDetection] Initialised', {
      threshold,
      sensitivity,
      sampleRate: audioContext.sampleRate,
      streamId: stream.id,
      tracks: stream.getAudioTracks().map((track) => ({
        id: track.id,
        label: track.label,
        muted: track.muted,
        enabled: track.enabled,
        readyState: track.readyState,
      })),
    });

    let lastSampleTime = 0;

    const sample = (timestamp) => {
      if (!analyserRef.current || !dataArrayRef.current) {
        return;
      }

      if (timestamp - lastSampleTime >= SAMPLE_INTERVAL) {
        analyserRef.current.getFloatTimeDomainData(dataArrayRef.current);

        let sumSquares = 0;
        for (let i = 0; i < dataArrayRef.current.length; i += 1) {
          const value = dataArrayRef.current[i];
          sumSquares += value * value;
        }

        const rms = Math.sqrt(sumSquares / dataArrayRef.current.length);
        const db = 20 * Math.log10(Math.max(rms, 1e-8));
        const elapsed = timestamp - lastSampleTime;

        if (baselineRef.current === null) {
          baselineRef.current = rms;
        } else if (!noiseDetectedRef.current) {
          baselineRef.current = (baselineRef.current * 0.98) + (rms * 0.02);
        }

        calibrationRef.current.samples += 1;
        calibrationRef.current.durationMs += elapsed;

        const dynamicThreshold = Math.max(threshold, baselineRef.current + sensitivity);
        const detected = rms > dynamicThreshold;
        const previousDetected = noiseDetectedRef.current;
        const baseline = baselineRef.current ?? 0;

        if (Math.abs(rms - noiseLevelRef.current) > MIN_LEVEL_DELTA) {
          setNoiseLevel(rms);
          noiseLevelRef.current = rms;
        }

        if (previousDetected !== detected) {
          setNoiseDetected(detected);
          noiseDetectedRef.current = detected;

          console.log('[NoiseDetection] State change', {
            detected,
            rms: Number(rms.toFixed(4)),
            db: Number(db.toFixed(1)),
            baseline: Number((baselineRef.current ?? 0).toFixed(4)),
            absoluteThreshold: threshold,
            dynamicThreshold: Number(dynamicThreshold.toFixed(4)),
            samples: calibrationRef.current.samples,
            durationMs: Math.round(calibrationRef.current.durationMs),
          });
        }

        if (timestamp - lastLogTimeRef.current >= LOG_INTERVAL) {
          lastLogTimeRef.current = timestamp;
          console.log('[NoiseDetection] Sample', {
            rms: Number(rms.toFixed(4)),
            db: Number(db.toFixed(1)),
            baseline: Number((baselineRef.current ?? 0).toFixed(4)),
            detected,
            absoluteThreshold: threshold,
            dynamicThreshold: Number(dynamicThreshold.toFixed(4)),
          });
        }

        setMetrics((prev) => {
          if (
            Math.abs(prev.db - db) < 0.1 &&
            Math.abs(prev.baseline - baseline) < 0.0005 &&
            Math.abs(prev.dynamicThreshold - dynamicThreshold) < 0.0005
          ) {
            if (prev.absoluteThreshold !== threshold) {
              return { ...prev, absoluteThreshold: threshold };
            }
            return prev;
          }

          return {
            db,
            baseline,
            absoluteThreshold: threshold,
            dynamicThreshold,
          };
        });

        lastSampleTime = timestamp;
      }

      rafRef.current = requestAnimationFrame(sample);
    };

    audioContext.resume().catch((error) => {
      console.warn('[NoiseDetection] Unable to resume AudioContext', error);
    });

    rafRef.current = requestAnimationFrame(sample);

    return () => {
      console.log('[NoiseDetection] Cleanup');
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (analyserRef.current) {
        analyserRef.current.disconnect();
        analyserRef.current = null;
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      if (gainNodeRef.current) {
        gainNodeRef.current.disconnect();
        gainNodeRef.current = null;
      }
    };
  }, [stream, sensitivity, threshold]);

  return {
    noiseLevel,
    noiseDetected,
    metrics,
  };
};

export default useNoiseDetection;

