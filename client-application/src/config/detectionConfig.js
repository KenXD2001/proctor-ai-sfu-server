const numberFromEnv = (key, fallback) => {
  const raw = import.meta.env[key];
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const intFromEnv = (key, fallback, { min } = {}) => {
  const value = Math.round(numberFromEnv(key, fallback));
  if (Number.isNaN(value)) {
    return fallback;
  }
  if (typeof min === 'number') {
    return Math.max(min, value);
  }
  return value;
};

const detectionConfig = {
  face: {
    referenceMatchThreshold: numberFromEnv('VITE_FACE_REFERENCE_MATCH_THRESHOLD', 0.78),
    referenceMatchHysteresis: numberFromEnv('VITE_FACE_REFERENCE_MATCH_HYSTERESIS', 0.06),
    distanceNormalizer: numberFromEnv('VITE_FACE_DISTANCE_NORMALIZER', 0.45),
    earThreshold: numberFromEnv('VITE_FACE_EAR_THRESHOLD', 0.22),
    minEyesClosedMs: numberFromEnv('VITE_FACE_MIN_EYES_CLOSED_MS', 700),
    horizontalTurnThreshold: numberFromEnv('VITE_FACE_HORIZONTAL_TURN_THRESHOLD', 0.35),
    verticalTurnThreshold: numberFromEnv('VITE_FACE_VERTICAL_TURN_THRESHOLD', 0.28),
    depthTurnThreshold: numberFromEnv('VITE_FACE_DEPTH_TURN_THRESHOLD', 0.1),
    lookingAwayMinMs: numberFromEnv('VITE_FACE_LOOKING_AWAY_MIN_MS', 650),
    calibrationFrames: intFromEnv('VITE_FACE_CALIBRATION_FRAMES', 45, { min: 1 }),
    baselineSmoothing: numberFromEnv('VITE_FACE_BASELINE_SMOOTHING', 0.08),
    facePresentConfirmationMs: numberFromEnv('VITE_FACE_PRESENT_CONFIRMATION_MS', 180),
    multiFaceConfirmationMs: numberFromEnv('VITE_FACE_MULTI_FACE_CONFIRMATION_MS', 250),
    multiFaceGraceMs: numberFromEnv('VITE_FACE_MULTI_FACE_GRACE_MS', 600),
    faceMissingGraceMs: numberFromEnv('VITE_FACE_MISSING_GRACE_MS', 500),
    minDetectionConfidence: numberFromEnv('VITE_FACE_MIN_DETECTION_CONFIDENCE', 0.5),
    minPresenceConfidence: numberFromEnv('VITE_FACE_MIN_PRESENCE_CONFIDENCE', 0.5),
    minTrackingConfidence: numberFromEnv('VITE_FACE_MIN_TRACKING_CONFIDENCE', 0.5),
  },
  gaze: {
    headExtraTolerance: numberFromEnv('VITE_GAZE_HEAD_EXTRA_TOLERANCE', 0.12),
    eyeHorizontalTolerance: numberFromEnv('VITE_GAZE_EYE_HORIZONTAL_TOLERANCE', 0.45),
    eyeVerticalTolerance: numberFromEnv('VITE_GAZE_EYE_VERTICAL_TOLERANCE', 0.32),
    irisHorizontalThreshold: numberFromEnv('VITE_GAZE_IRIS_HORIZONTAL_THRESHOLD', 0.32),
    irisVerticalThreshold: numberFromEnv('VITE_GAZE_IRIS_VERTICAL_THRESHOLD', 0.28),
    blendHorizontalThreshold: numberFromEnv('VITE_GAZE_BLEND_HORIZONTAL_THRESHOLD', 0.16),
    blendVerticalThreshold: numberFromEnv('VITE_GAZE_BLEND_VERTICAL_THRESHOLD', 0.14),
    blinkBlendThreshold: numberFromEnv('VITE_GAZE_BLINK_BLEND_THRESHOLD', 0.45),
  },
  match: {
    poseToleranceYaw: numberFromEnv('VITE_MATCH_POSE_TOLERANCE_YAW', 0.35),
    poseTolerancePitch: numberFromEnv('VITE_MATCH_POSE_TOLERANCE_PITCH', 0.28),
    poseToleranceRoll: numberFromEnv('VITE_MATCH_POSE_TOLERANCE_ROLL', 0.28),
    poseHysteresis: numberFromEnv('VITE_MATCH_POSE_HYSTERESIS', 0.12),
    consecutiveMismatchFrames: intFromEnv('VITE_MATCH_CONSECUTIVE_MISMATCH_FRAMES', 5, {
      min: 1,
    }),
    poseBaselineSmoothing: numberFromEnv(
      'VITE_MATCH_POSE_BASELINE_SMOOTHING',
      0.04
    ),
    signatureBlendAlpha: numberFromEnv('VITE_MATCH_SIGNATURE_BLEND_ALPHA', 0.02),
  },
  head: {
    turnWindowMs: numberFromEnv('VITE_HEAD_TURN_WINDOW_MS', 10000),
    turnThreshold: numberFromEnv('VITE_HEAD_TURN_THRESHOLD', 3),
    turnCooldownMs: numberFromEnv('VITE_HEAD_TURN_COOLDOWN_MS', 500),
    turnClearMs: numberFromEnv('VITE_HEAD_TURN_CLEAR_MS', 4000),
  },
  noise: {
    threshold: numberFromEnv('VITE_NOISE_THRESHOLD', 0.003),
    sensitivity: numberFromEnv('VITE_NOISE_SENSITIVITY', 0.002),
    sampleInterval: numberFromEnv('VITE_NOISE_SAMPLE_INTERVAL', 200),
    minLevelDelta: numberFromEnv('VITE_NOISE_MIN_LEVEL_DELTA', 0.001),
    logInterval: numberFromEnv('VITE_NOISE_LOG_INTERVAL', 1000),
  },
  mobile: {
    intervalMs: numberFromEnv('VITE_MOBILE_INTERVAL_MS', 450),
    minScore: numberFromEnv('VITE_MOBILE_MIN_SCORE', 0.35),
    cooldownMs: numberFromEnv('VITE_MOBILE_COOLDOWN_MS', 1500),
  },
};

export default detectionConfig;

