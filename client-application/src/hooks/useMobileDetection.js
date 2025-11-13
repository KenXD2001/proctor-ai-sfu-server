import { useEffect, useRef, useState } from 'react';
import { ObjectDetector, FilesetResolver } from '@mediapipe/tasks-vision';
import detectionConfig from '../config/detectionConfig';

const DEFAULT_OBJECT_MODEL_PATH = `${import.meta.env.BASE_URL}models/efficientdet_lite0.tflite`;
const FALLBACK_OBJECT_MODEL_URL = new URL(
  '../assets/googleapis/efficientdet_lite0.tflite',
  import.meta.url
).href;

const DEFAULT_WASM_PATH = `${import.meta.env.BASE_URL}mediapipe/wasm`;
const FALLBACK_WASM_URL = new URL(
  '../../node_modules/@mediapipe/tasks-vision/wasm',
  import.meta.url
).href;

const MOBILE_LABELS = new Set([
  'cell phone',
  'mobile phone',
  'phone',
  'telephone',
  'smartphone',
]);

const { mobile: mobileConfig } = detectionConfig;

const DEFAULT_INTERVAL_MS = mobileConfig.intervalMs;
const DEFAULT_MIN_SCORE = mobileConfig.minScore;
const DEFAULT_COOLDOWN_MS = mobileConfig.cooldownMs;

const normalizeBoundingBox = (box, frameWidth, frameHeight) => {
  if (!box) {
    return null;
  }

  const { originX = 0, originY = 0, width = 0, height = 0 } = box;
  const isAlreadyNormalised =
    originX >= 0 &&
    originY >= 0 &&
    width >= 0 &&
    height >= 0 &&
    originX <= 1 &&
    originY <= 1 &&
    width <= 1 &&
    height <= 1 &&
    originX + width <= 1.02 &&
    originY + height <= 1.02;

  if (isAlreadyNormalised) {
    return {
      x: Math.max(0, Math.min(1, originX)),
      y: Math.max(0, Math.min(1, originY)),
      width: Math.max(0, Math.min(1, width)),
      height: Math.max(0, Math.min(1, height)),
    };
  }

  if (!frameWidth || !frameHeight) {
    return null;
  }

  return {
    x: Math.max(0, originX / frameWidth),
    y: Math.max(0, originY / frameHeight),
    width: Math.max(0, width / frameWidth),
    height: Math.max(0, height / frameHeight),
  };
};

const useMobileDetection = (videoRef, options = {}) => {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const modelAssetPath =
    options.modelAssetPath ?? options.modelUrl ?? DEFAULT_OBJECT_MODEL_PATH;
  const wasmPath = options.wasmPath ?? DEFAULT_WASM_PATH;

  const [state, setState] = useState({
    detected: false,
    label: null,
    score: 0,
    lastDetected: null,
    box: null,
  });

  const detectorRef = useRef(null);
  const rafRef = useRef(null);
  const lastSampleTimeRef = useRef(0);
  const lastDetectionTimeRef = useRef(0);
  const [isDetectorReady, setDetectorReady] = useState(false);
  const activeModelUrlRef = useRef(null);

  const resolveVisionTasks = async () => {
    const candidates = [];
    if (wasmPath) {
      candidates.push(wasmPath);
    }
    if (!candidates.includes(DEFAULT_WASM_PATH)) {
      candidates.push(DEFAULT_WASM_PATH);
    }
    if (!candidates.includes(FALLBACK_WASM_URL)) {
      candidates.push(FALLBACK_WASM_URL);
    }

    let lastError = null;
    for (const base of candidates) {
      try {
        return await FilesetResolver.forVisionTasks(base);
      } catch (error) {
        lastError = error;
        console.warn('[MobileDetection] Failed to load vision WASM bundle', {
          base,
          message: error?.message,
        });
      }
    }
    throw lastError ?? new Error('Unable to load Mediapipe Tasks vision WASM assets.');
  };

  useEffect(() => {
    let isCancelled = false;

    const waitForVideo = () =>
      new Promise((resolve) => {
        const check = () => {
          if (isCancelled) {
            return;
          }

          const videoElement = videoRef.current;
          if (videoElement && videoElement.readyState >= HTMLMediaElement.HAVE_METADATA) {
            resolve(videoElement);
          } else {
            requestAnimationFrame(check);
          }
        };

        check();
      });

    const initialize = async () => {
      try {
        await waitForVideo();
      } catch {
        return;
      }

      if (isCancelled) {
        return;
      }

      try {
        const filesetResolver = await resolveVisionTasks();

        if (isCancelled) {
          return;
        }

        const modelCandidates = [];
        if (modelAssetPath) {
          modelCandidates.push(modelAssetPath);
        }
        if (!modelCandidates.includes(DEFAULT_OBJECT_MODEL_PATH)) {
          modelCandidates.push(DEFAULT_OBJECT_MODEL_PATH);
        }
        if (!modelCandidates.includes(FALLBACK_OBJECT_MODEL_URL)) {
          modelCandidates.push(FALLBACK_OBJECT_MODEL_URL);
        }

        let lastModelError = null;
        for (const candidate of modelCandidates) {
          try {
            detectorRef.current = await ObjectDetector.createFromOptions(filesetResolver, {
              baseOptions: {
                modelAssetPath: candidate,
                delegate: 'GPU',
              },
              scoreThreshold: minScore,
              runningMode: 'VIDEO',
              maxResults: 5,
            });
            activeModelUrlRef.current = candidate;
            console.log('[MobileDetection] Object detector initialised', {
              modelUrl: candidate,
            });
            lastModelError = null;
            break;
          } catch (error) {
            lastModelError = error;
            console.warn('[MobileDetection] Failed to load object detector model', {
              modelPath: candidate,
              message: error?.message,
            });
          }
        }

        if (!detectorRef.current) {
          throw lastModelError ?? new Error('Unable to initialise object detector model.');
        }

        setDetectorReady(true);
      } catch (error) {
        console.error('[MobileDetection] Failed to initialise:', error);
        console.error(
          '[MobileDetection] Ensure efficientdet_lite0.tflite is available locally (defaults to /models/efficientdet_lite0.tflite) or pass a custom path via hook options.',
        );
      }
    };

    initialize();

    return () => {
      isCancelled = true;
      setDetectorReady(false);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (detectorRef.current) {
        detectorRef.current.close();
        detectorRef.current = null;
      }
    };
  }, [minScore, videoRef]);

  useEffect(() => {
    if (!isDetectorReady) {
      return undefined;
    }

    const analyzeFrame = (timestamp) => {
      const videoElement = videoRef.current;

      if (!videoElement || !detectorRef.current) {
        rafRef.current = requestAnimationFrame(analyzeFrame);
        return;
      }

      if (videoElement.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        rafRef.current = requestAnimationFrame(analyzeFrame);
        return;
      }

      if (timestamp - lastSampleTimeRef.current >= intervalMs) {
        lastSampleTimeRef.current = timestamp;

        try {
          const detectionResult = detectorRef.current.detectForVideo(videoElement, timestamp);
          let bestMatch = null;

          detectionResult?.detections?.forEach((detection) => {
            detection.categories?.forEach((category) => {
              if (!category || typeof category.score !== 'number' || !category.categoryName) {
                return;
              }

              const isMobileLabel = MOBILE_LABELS.has(category.categoryName.toLowerCase());

              if (isMobileLabel && category.score >= minScore) {
                if (!bestMatch || category.score > bestMatch.score) {
                  bestMatch = {
                    label: category.categoryName,
                    score: category.score,
                    boundingBox: detection.boundingBox,
                  };
                }
              }
            });
          });

          if (bestMatch) {
            const videoWidth = videoElement.videoWidth || videoElement.clientWidth || 0;
            const videoHeight = videoElement.videoHeight || videoElement.clientHeight || 0;
            const normalisedBox = normalizeBoundingBox(bestMatch.boundingBox, videoWidth, videoHeight);

            console.log('[MobileDetection] Mobile device detected', {
              label: bestMatch.label,
              score: Number(bestMatch.score.toFixed(2)),
            });
            setState({
              detected: true,
              label: bestMatch.label,
              score: bestMatch.score,
              lastDetected: Date.now(),
              box: normalisedBox,
            });
            lastDetectionTimeRef.current = timestamp;
          } else {
            const timeSinceDetection = timestamp - lastDetectionTimeRef.current;
            setState((prev) => {
              if (prev.detected && timeSinceDetection >= cooldownMs) {
                return {
                  ...prev,
                  detected: false,
                  score: 0,
                  box: null,
                };
              }
              return prev;
            });
          }
        } catch (error) {
          console.error('[MobileDetection] Detection error:', error);
        }
      }

      rafRef.current = requestAnimationFrame(analyzeFrame);
    };

    rafRef.current = requestAnimationFrame(analyzeFrame);

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [intervalMs, isDetectorReady, minScore, videoRef]);

  return state;
};

export default useMobileDetection;


