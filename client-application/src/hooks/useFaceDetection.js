import { useEffect, useRef, useState } from 'react';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import detectionConfig from '../config/detectionConfig';

const DEFAULT_FACE_LANDMARKER_PATH = `${import.meta.env.BASE_URL}models/face_landmarker.task`;
const FALLBACK_FACE_LANDMARKER_URL = new URL(
  '../assets/googleapis/face_landmarker.task',
  import.meta.url
).href;

const DEFAULT_WASM_PATH = `${import.meta.env.BASE_URL}mediapipe/wasm`;
const FALLBACK_WASM_URL = new URL(
  '../../node_modules/@mediapipe/tasks-vision/wasm',
  import.meta.url
).href;

const DEFAULT_REFERENCE_FACE_URL = new URL(
  '../assets/faceImage/CamImage.jpg',
  import.meta.url
).href;
const { face: faceConfig, gaze: gazeConfig, match: matchConfig, head: headConfig } =
  detectionConfig;

const DEFAULT_REFERENCE_MATCH_THRESHOLD = faceConfig.referenceMatchThreshold;
const FACE_DISTANCE_NORMALIZER = faceConfig.distanceNormalizer;

const LEFT_EYE_INDICES = [33, 160, 158, 133, 153, 144];
const RIGHT_EYE_INDICES = [362, 385, 387, 263, 373, 380];
const DEFAULT_EAR_THRESHOLD = faceConfig.earThreshold;
const DEFAULT_MIN_EYES_CLOSED_MS = faceConfig.minEyesClosedMs;
const DEFAULT_HORIZONTAL_TURN_THRESHOLD = faceConfig.horizontalTurnThreshold;
const DEFAULT_VERTICAL_TURN_THRESHOLD = faceConfig.verticalTurnThreshold;
const DEFAULT_DEPTH_TURN_THRESHOLD = faceConfig.depthTurnThreshold;
const DEFAULT_LOOKING_AWAY_MIN_MS = faceConfig.lookingAwayMinMs;
const DEFAULT_CALIBRATION_FRAMES = faceConfig.calibrationFrames;
const DEFAULT_BASELINE_SMOOTHING = faceConfig.baselineSmoothing;
const DEFAULT_FACE_PRESENT_CONFIRMATION_MS = faceConfig.facePresentConfirmationMs;
const DEFAULT_MULTI_FACE_CONFIRMATION_MS = faceConfig.multiFaceConfirmationMs;
const DEFAULT_MULTI_FACE_CLEAR_MS = faceConfig.multiFaceGraceMs;
const DEFAULT_FACE_MISSING_GRACE_MS = faceConfig.faceMissingGraceMs;
const GAZE_HEAD_EXTRA_TOLERANCE = gazeConfig.headExtraTolerance;
const GAZE_EYE_HORIZONTAL_TOLERANCE = gazeConfig.eyeHorizontalTolerance;
const GAZE_EYE_VERTICAL_TOLERANCE = gazeConfig.eyeVerticalTolerance;
const DEFAULT_MATCH_POSE_TOLERANCE_YAW = matchConfig.poseToleranceYaw;
const DEFAULT_MATCH_POSE_TOLERANCE_PITCH = matchConfig.poseTolerancePitch;
const DEFAULT_MATCH_POSE_TOLERANCE_ROLL = matchConfig.poseToleranceRoll;
const DEFAULT_MATCH_POSE_HYSTERESIS = matchConfig.poseHysteresis;
const DEFAULT_MATCH_CONSECUTIVE_MISMATCH_FRAMES = matchConfig.consecutiveMismatchFrames;
const DEFAULT_MATCH_POSE_BASELINE_SMOOTHING = matchConfig.poseBaselineSmoothing;
const MATCH_SIGNATURE_BLEND_ALPHA = matchConfig.signatureBlendAlpha;
const DEFAULT_HEAD_TURN_WINDOW_MS = headConfig.turnWindowMs;
const DEFAULT_HEAD_TURN_THRESHOLD = headConfig.turnThreshold;
const DEFAULT_HEAD_TURN_COOLDOWN_MS = headConfig.turnCooldownMs;
const DEFAULT_HEAD_TURN_CLEAR_MS = headConfig.turnClearMs;
const DEFAULT_MIN_FACE_DETECTION_CONFIDENCE = faceConfig.minDetectionConfidence;
const DEFAULT_MIN_FACE_PRESENCE_CONFIDENCE = faceConfig.minPresenceConfidence;
const DEFAULT_MIN_TRACKING_CONFIDENCE = faceConfig.minTrackingConfidence;
const DEFAULT_REFERENCE_MATCH_HYSTERESIS = faceConfig.referenceMatchHysteresis;

const LEFT_IRIS_INDICES = [468, 469, 470, 471, 472];
const RIGHT_IRIS_INDICES = [473, 474, 475, 476, 477];
const LEFT_EYE_INNER_INDEX = 133;
const LEFT_EYE_OUTER_INDEX = 33;
const LEFT_EYE_UPPER_INDEX = 159;
const LEFT_EYE_LOWER_INDEX = 145;
const RIGHT_EYE_INNER_INDEX = 362;
const RIGHT_EYE_OUTER_INDEX = 263;
const RIGHT_EYE_UPPER_INDEX = 386;
const RIGHT_EYE_LOWER_INDEX = 374;
const IRIS_HORIZONTAL_THRESHOLD = gazeConfig.irisHorizontalThreshold;
const IRIS_VERTICAL_THRESHOLD = gazeConfig.irisVerticalThreshold;
const BLEND_GAZE_HORIZONTAL_THRESHOLD = gazeConfig.blendHorizontalThreshold;
const BLEND_GAZE_VERTICAL_THRESHOLD = gazeConfig.blendVerticalThreshold;
const BLINK_BLEND_THRESHOLD = gazeConfig.blinkBlendThreshold;

const distance = (pointA, pointB) => {
  const dx = pointA.x - pointB.x;
  const dy = pointA.y - pointB.y;
  const dz = (pointA.z || 0) - (pointB.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

const calculateEyeAspectRatio = (landmarks, indices) => {
  if (!landmarks) {
    return 1;
  }

  const [p1, p2, p3, p4, p5, p6] = indices.map((index) => landmarks[index]);
  const vertical1 = distance(p2, p6);
  const vertical2 = distance(p3, p5);
  const horizontal = distance(p1, p4);

  if (horizontal === 0) {
    return 1;
  }

  return ((vertical1 + vertical2) / 2) / horizontal;
};

const clamp01 = (value) => Math.min(1, Math.max(0, value));

const approxEqual = (a, b, epsilon = 0.01) => Math.abs(a - b) <= epsilon;

const loadImageElement = (url) =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = (error) => reject(error);
    image.src = url;
  });

const normaliseLandmarks = (landmarks) => {
  if (!landmarks || !landmarks.length) {
    return null;
  }

  const xs = landmarks.map((point) => point?.x ?? 0);
  const ys = landmarks.map((point) => point?.y ?? 0);
  const zs = landmarks.map((point) => point?.z ?? 0);

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);

  const rangeX = maxX - minX;
  const rangeY = maxY - minY;
  const rangeZ = maxZ - minZ || 1;

  if (rangeX <= 0 || rangeY <= 0) {
    return null;
  }

  return landmarks.map((point) => ({
    x: (point.x - minX) / rangeX,
    y: (point.y - minY) / rangeY,
    z: ((point.z ?? 0) - minZ) / rangeZ,
  }));
};

const canonicaliseLandmarks = (landmarks) => {
  const normalised = normaliseLandmarks(landmarks);
  if (!normalised) {
    return null;
  }

  const leftEye = normalised[LEFT_EYE_INDICES[0]];
  const rightEye = normalised[RIGHT_EYE_INDICES[3]];

  if (!leftEye || !rightEye) {
    return normalised;
  }

  const eyeMidpointX = (leftEye.x + rightEye.x) / 2;
  const eyeMidpointY = (leftEye.y + rightEye.y) / 2;
  const eyeMidpointZ = ((leftEye.z ?? 0) + (rightEye.z ?? 0)) / 2;
  const eyeDx = rightEye.x - leftEye.x;
  const eyeDy = rightEye.y - leftEye.y;
  const eyeDistance = Math.hypot(eyeDx, eyeDy);

  if (eyeDistance <= 1e-6) {
    return normalised;
  }

  const cosTheta = eyeDx / eyeDistance;
  const sinTheta = eyeDy / eyeDistance;

  return normalised.map((point) => {
    const centeredX = (point.x - eyeMidpointX) / eyeDistance;
    const centeredY = (point.y - eyeMidpointY) / eyeDistance;
    const centeredZ = ((point.z ?? 0) - eyeMidpointZ) / eyeDistance;

    const rotatedX = centeredX * cosTheta + centeredY * sinTheta;
    const rotatedY = -centeredX * sinTheta + centeredY * cosTheta;

    return {
      x: rotatedX,
      y: rotatedY,
      z: centeredZ,
    };
  });
};

const computeFaceSignature = (landmarks) => {
  const canonical = canonicaliseLandmarks(landmarks);
  if (!canonical) {
    return null;
  }

  const sampleStep = Math.max(1, Math.floor(canonical.length / 120));
  return canonical.filter((_, index) => index % sampleStep === 0);
};

const computeFaceSimilarity = (referenceSignature, sampleSignature) => {
  if (!referenceSignature || !sampleSignature) {
    return null;
  }

  const sampleLength = Math.min(referenceSignature.length, sampleSignature.length);
  if (!sampleLength) {
    return null;
  }

  let distanceSum = 0;
  let validSamples = 0;

  for (let index = 0; index < sampleLength; index += 1) {
    const referencePoint = referenceSignature[index];
    const samplePoint = sampleSignature[index];
    if (!referencePoint || !samplePoint) {
      continue;
    }

    const dx = referencePoint.x - samplePoint.x;
    const dy = referencePoint.y - samplePoint.y;
    const dz = (referencePoint.z ?? 0) - (samplePoint.z ?? 0);
    distanceSum += dx * dx + dy * dy + dz * dz;
    validSamples += 1;
  }

  if (!validSamples) {
    return null;
  }

  const meanDistance = Math.sqrt(distanceSum / validSamples);
  const similarity = clamp01(1 - meanDistance / FACE_DISTANCE_NORMALIZER);
  return similarity;
};

const toMatrixArray = (matrix) => {
  if (!matrix) {
    return null;
  }
  if (Array.isArray(matrix)) {
    return matrix.flat ? matrix.flat() : matrix;
  }
  if (matrix.data) {
    return Array.from(matrix.data);
  }
  if (matrix.values) {
    return Array.from(matrix.values);
  }
  return null;
};

const extractEulerAnglesFromMatrix = (matrix) => {
  const data = toMatrixArray(matrix);
  if (!data || data.length < 16) {
    return null;
  }

  const r00 = data[0];
  const r01 = data[1];
  const r02 = data[2];
  const r10 = data[4];
  const r11 = data[5];
  const r12 = data[6];
  const r20 = data[8];
  const r21 = data[9];
  const r22 = data[10];

  const sy = Math.sqrt(r00 * r00 + r10 * r10);
  const singular = sy < 1e-6;

  let yaw;
  let pitch;
  let roll;

  if (!singular) {
    yaw = Math.atan2(r10, r00);
    pitch = Math.atan2(-r20, sy);
    roll = Math.atan2(r21, r22);
  } else {
    yaw = Math.atan2(-r01, r11);
    pitch = Math.atan2(-r20, sy);
    roll = 0;
  }

  return { yaw, pitch, roll };
};

const clampSigned = (value, limit = 1.5) => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(-limit, Math.min(limit, value));
};

const normaliseAngleDelta = (target, reference) => {
  if (!Number.isFinite(target) || !Number.isFinite(reference)) {
    return 0;
  }
  let diff = target - reference;
  while (diff > Math.PI) {
    diff -= Math.PI * 2;
  }
  while (diff < -Math.PI) {
    diff += Math.PI * 2;
  }
  return diff;
};

const smoothTowardsAngle = (current, target, factor) => {
  if (!Number.isFinite(target)) {
    return current;
  }
  const delta = normaliseAngleDelta(target, current);
  return current + delta * factor;
};

const computeEyeIrisGaze = (
  landmarks,
  {
    irisIndices,
    innerCornerIndex,
    outerCornerIndex,
    upperLidIndex,
    lowerLidIndex,
  }
) => {
  const irisPoints = irisIndices
    .map((index) => landmarks[index])
    .filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y));

  if (!irisPoints.length) {
    return null;
  }

  const irisCenterX =
    irisPoints.reduce((sum, point) => sum + point.x, 0) / irisPoints.length;
  const irisCenterY =
    irisPoints.reduce((sum, point) => sum + point.y, 0) / irisPoints.length;

  const innerCorner = landmarks[innerCornerIndex];
  const outerCorner = landmarks[outerCornerIndex];
  const upperLid = landmarks[upperLidIndex];
  const lowerLid = landmarks[lowerLidIndex];

  if (!innerCorner || !outerCorner || !upperLid || !lowerLid) {
    return null;
  }

  const eyeCenterX = (innerCorner.x + outerCorner.x) / 2;
  const eyeCenterY = (upperLid.y + lowerLid.y) / 2;
  const eyeWidth = Math.max(1e-5, Math.abs(innerCorner.x - outerCorner.x));
  const eyeHeight = Math.max(1e-5, Math.abs(upperLid.y - lowerLid.y));

  const horizontal = clampSigned((irisCenterX - eyeCenterX) / (eyeWidth * 0.5));
  const vertical = clampSigned((irisCenterY - eyeCenterY) / (eyeHeight * 0.5));

  return {
    horizontal,
    vertical,
    center: {
      x: irisCenterX,
      y: irisCenterY,
    },
    eyeCenter: {
      x: eyeCenterX,
      y: eyeCenterY,
    },
  };
};

const computeIrisGaze = (landmarks) => {
  const left = computeEyeIrisGaze(landmarks, {
    irisIndices: LEFT_IRIS_INDICES,
    innerCornerIndex: LEFT_EYE_INNER_INDEX,
    outerCornerIndex: LEFT_EYE_OUTER_INDEX,
    upperLidIndex: LEFT_EYE_UPPER_INDEX,
    lowerLidIndex: LEFT_EYE_LOWER_INDEX,
  });

  const right = computeEyeIrisGaze(landmarks, {
    irisIndices: RIGHT_IRIS_INDICES,
    innerCornerIndex: RIGHT_EYE_INNER_INDEX,
    outerCornerIndex: RIGHT_EYE_OUTER_INDEX,
    upperLidIndex: RIGHT_EYE_UPPER_INDEX,
    lowerLidIndex: RIGHT_EYE_LOWER_INDEX,
  });

  if (!left && !right) {
    return null;
  }

  let horizontal = 0;
  let vertical = 0;
  let count = 0;

  if (left) {
    horizontal += left.horizontal;
    vertical += left.vertical;
    count += 1;
  }
  if (right) {
    horizontal += right.horizontal;
    vertical += right.vertical;
    count += 1;
  }

  return {
    horizontal: count ? horizontal / count : 0,
    vertical: count ? vertical / count : 0,
    left,
    right,
  };
};

const buildBlendshapeMap = (categories) => {
  if (!categories || !categories.length) {
    return null;
  }
  const map = {};
  for (const category of categories) {
    const key = category?.categoryName ?? category?.displayName;
    if (!key) {
      continue;
    }
    map[key] = category.score ?? 0;
  }
  return map;
};

const computeBlendshapeGaze = (blendshapeMap) => {
  if (!blendshapeMap) {
    return null;
  }

  const leftOut = blendshapeMap.eyeLookOutLeft ?? 0;
  const leftIn = blendshapeMap.eyeLookInLeft ?? 0;
  const rightOut = blendshapeMap.eyeLookOutRight ?? 0;
  const rightIn = blendshapeMap.eyeLookInRight ?? 0;

  const leftUp = blendshapeMap.eyeLookUpLeft ?? 0;
  const leftDown = blendshapeMap.eyeLookDownLeft ?? 0;
  const rightUp = blendshapeMap.eyeLookUpRight ?? 0;
  const rightDown = blendshapeMap.eyeLookDownRight ?? 0;

  const horizontalLeft = leftOut - leftIn;
  const horizontalRight = rightIn - rightOut;
  const verticalLeft = leftUp - leftDown;
  const verticalRight = rightUp - rightDown;

  const horizontal = clampSigned((horizontalLeft + horizontalRight) / 2, 1);
  const vertical = clampSigned((verticalLeft + verticalRight) / 2, 1);

  return {
    horizontal,
    vertical,
  };
};

const combineGazeSignals = (values) => {
  const valid = values.filter((value) => Number.isFinite(value));
  if (!valid.length) {
    return null;
  }
  const sum = valid.reduce((acc, value) => acc + value, 0);
  return sum / valid.length;
};

const computeBlinkConfidence = (blendshapeMap) => {
  if (!blendshapeMap) {
    return null;
  }
  const blinkLeft = blendshapeMap.eyeBlinkLeft ?? 0;
  const blinkRight = blendshapeMap.eyeBlinkRight ?? 0;
  const wideLeft = blendshapeMap.eyeWideLeft ?? 0;
  const wideRight = blendshapeMap.eyeWideRight ?? 0;
  return Math.max(0, (blinkLeft + blinkRight) / 2 - (wideLeft + wideRight) * 0.25);
};

const boxesEqual = (a, b) => {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    approxEqual(a.x, b.x) &&
    approxEqual(a.y, b.y) &&
    approxEqual(a.width, b.width) &&
    approxEqual(a.height, b.height)
  );
};

const pointsEqual = (a, b, epsilon = 0.01) => {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return approxEqual(a.x, b.x, epsilon) && approxEqual(a.y, b.y, epsilon);
};

const gazeEqual = (a, b) => {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    approxEqual(a.yaw, b.yaw, 0.02) &&
    approxEqual(a.pitch, b.pitch, 0.02) &&
    approxEqual(a.roll, b.roll, 0.02) &&
    approxEqual(a.rawYaw ?? 0, b.rawYaw ?? 0, 0.02) &&
    approxEqual(a.rawPitch ?? 0, b.rawPitch ?? 0, 0.02) &&
    approxEqual(a.rawRoll ?? 0, b.rawRoll ?? 0, 0.02) &&
    approxEqual(a.baselineYaw ?? 0, b.baselineYaw ?? 0, 0.02) &&
    approxEqual(a.baselinePitch ?? 0, b.baselinePitch ?? 0, 0.02) &&
    approxEqual(a.baselineRoll ?? 0, b.baselineRoll ?? 0, 0.02) &&
    approxEqual(a.calibrationProgress ?? 0, b.calibrationProgress ?? 0, 0.02) &&
    !!a.calibrated === !!b.calibrated &&
    a.state === b.state &&
    a.horizontalTurn === b.horizontalTurn &&
    a.verticalTurn === b.verticalTurn &&
    a.depthTurn === b.depthTurn &&
    ((
      !a.iris &&
      !b.iris
    ) ||
      (a.iris &&
        b.iris &&
        approxEqual(a.iris.horizontal ?? 0, b.iris.horizontal ?? 0, 0.02) &&
        approxEqual(a.iris.vertical ?? 0, b.iris.vertical ?? 0, 0.02))) &&
    ((
      !a.eye &&
      !b.eye
    ) ||
      (a.eye &&
        b.eye &&
        approxEqual(a.eye.horizontal ?? 0, b.eye.horizontal ?? 0, 0.02) &&
        approxEqual(a.eye.vertical ?? 0, b.eye.vertical ?? 0, 0.02))) &&
    ((
      !a.headOrientation &&
      !b.headOrientation
    ) ||
      (a.headOrientation &&
        b.headOrientation &&
        approxEqual(a.headOrientation.yaw ?? 0, b.headOrientation.yaw ?? 0, 0.02) &&
        approxEqual(a.headOrientation.pitch ?? 0, b.headOrientation.pitch ?? 0, 0.02) &&
        approxEqual(a.headOrientation.roll ?? 0, b.headOrientation.roll ?? 0, 0.02)))
  );
};

const keypointsEqual = (a, b) => {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    pointsEqual(a.noseTip, b.noseTip) &&
    pointsEqual(a.eyeMidpoint, b.eyeMidpoint) &&
    pointsEqual(a.forehead, b.forehead)
  );
};

const createDefaultStatus = () => ({
  faceFound: false,
  facePresent: false,
  multipleFaces: false,
  eyesClosed: false,
  lookingAway: false,
  frequentHeadTurns: false,
  referenceFaceReady: false,
  referenceMatched: null,
  referenceMatchScore: null,
  referenceFaceError: null,
  facesDetected: 0,
  boundingBox: null,
  gaze: null,
  keypoints: null,
  metrics: null,
});

const createBaselineState = () => ({
  sumYaw: 0,
  sumPitch: 0,
  sumRoll: 0,
  samples: 0,
  ready: false,
  yaw: 0,
  pitch: 0,
  roll: 0,
});

const resetBaselineState = (baseline) => {
  if (!baseline) {
    return;
  }
  baseline.sumYaw = 0;
  baseline.sumPitch = 0;
  baseline.sumRoll = 0;
  baseline.samples = 0;
  baseline.ready = false;
  baseline.yaw = 0;
  baseline.pitch = 0;
  baseline.roll = 0;
};

const statusEquals = (a, b) =>
  a.faceFound === b.faceFound &&
  a.facePresent === b.facePresent &&
  a.multipleFaces === b.multipleFaces &&
  a.eyesClosed === b.eyesClosed &&
  a.lookingAway === b.lookingAway &&
  a.frequentHeadTurns === b.frequentHeadTurns &&
  a.referenceFaceReady === b.referenceFaceReady &&
  a.referenceMatched === b.referenceMatched &&
  approxEqual(a.referenceMatchScore ?? 0, b.referenceMatchScore ?? 0, 0.02) &&
  a.referenceFaceError === b.referenceFaceError &&
  a.facesDetected === b.facesDetected &&
  boxesEqual(a.boundingBox, b.boundingBox) &&
  gazeEqual(a.gaze, b.gaze) &&
  keypointsEqual(a.keypoints, b.keypoints) &&
  metricsEqual(a.metrics, b.metrics);

function metricsEqual(a, b) {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    approxEqual(a.calibrationProgress ?? 0, b.calibrationProgress ?? 0, 0.02) &&
    approxEqual(a.headTurnRate ?? 0, b.headTurnRate ?? 0, 0.1) &&
    approxEqual(a.headTurnCount ?? 0, b.headTurnCount ?? 0, 0.5) &&
    approxEqual(a.recentHeadTurnMs ?? 0, b.recentHeadTurnMs ?? 0, 50) &&
    approxEqual(a.headYaw ?? 0, b.headYaw ?? 0, 0.02) &&
    approxEqual(a.headPitch ?? 0, b.headPitch ?? 0, 0.02) &&
    approxEqual(a.headRoll ?? 0, b.headRoll ?? 0, 0.02) &&
    approxEqual(a.eyeHorizontal ?? 0, b.eyeHorizontal ?? 0, 0.02) &&
    approxEqual(a.eyeVertical ?? 0, b.eyeVertical ?? 0, 0.02) &&
    approxEqual(a.irisHorizontal ?? 0, b.irisHorizontal ?? 0, 0.02) &&
    approxEqual(a.irisVertical ?? 0, b.irisVertical ?? 0, 0.02) &&
    approxEqual(a.blendshapeHorizontal ?? 0, b.blendshapeHorizontal ?? 0, 0.02) &&
    approxEqual(a.blendshapeVertical ?? 0, b.blendshapeVertical ?? 0, 0.02) &&
    approxEqual(a.blinkConfidence ?? 0, b.blinkConfidence ?? 0, 0.02) &&
    ((
      !a.headOrientation &&
      !b.headOrientation
    ) ||
      (a.headOrientation &&
        b.headOrientation &&
        approxEqual(a.headOrientation.yaw ?? 0, b.headOrientation.yaw ?? 0, 0.02) &&
        approxEqual(a.headOrientation.pitch ?? 0, b.headOrientation.pitch ?? 0, 0.02) &&
        approxEqual(a.headOrientation.roll ?? 0, b.headOrientation.roll ?? 0, 0.02))) &&
    ((
      !a.iris &&
      !b.iris
    ) ||
      (a.iris &&
        b.iris &&
        approxEqual(a.iris.horizontal ?? 0, b.iris.horizontal ?? 0, 0.02) &&
        approxEqual(a.iris.vertical ?? 0, b.iris.vertical ?? 0, 0.02))) &&
    ((
      !a.headAlignment &&
      !b.headAlignment
    ) ||
      (a.headAlignment &&
        b.headAlignment &&
        approxEqual(
          a.headAlignment.horizontalMagnitude ?? 0,
          b.headAlignment.horizontalMagnitude ?? 0,
          0.02
        ) &&
        approxEqual(
          a.headAlignment.verticalMagnitude ?? 0,
          b.headAlignment.verticalMagnitude ?? 0,
          0.02
        ) &&
        approxEqual(
          a.headAlignment.depthMagnitude ?? 0,
          b.headAlignment.depthMagnitude ?? 0,
          0.02
        ) &&
        approxEqual(
          a.headAlignment.thresholds?.horizontal ?? 0,
          b.headAlignment.thresholds?.horizontal ?? 0,
          0.02
        ) &&
        approxEqual(
          a.headAlignment.thresholds?.vertical ?? 0,
          b.headAlignment.thresholds?.vertical ?? 0,
          0.02
        ) &&
        approxEqual(
          a.headAlignment.thresholds?.depth ?? 0,
          b.headAlignment.thresholds?.depth ?? 0,
          0.02
        ) &&
        (!!a.headAlignment.within?.horizontal === !!b.headAlignment.within?.horizontal) &&
        (!!a.headAlignment.within?.vertical === !!b.headAlignment.within?.vertical) &&
        (!!a.headAlignment.within?.depth === !!b.headAlignment.within?.depth))) &&
    ((
      !a.eyeAlignment &&
      !b.eyeAlignment
    ) ||
      (a.eyeAlignment &&
        b.eyeAlignment &&
        approxEqual(
          a.eyeAlignment.horizontalMagnitude ?? 0,
          b.eyeAlignment.horizontalMagnitude ?? 0,
          0.02
        ) &&
        approxEqual(
          a.eyeAlignment.verticalMagnitude ?? 0,
          b.eyeAlignment.verticalMagnitude ?? 0,
          0.02
        ) &&
        approxEqual(
          a.eyeAlignment.irisHorizontalMagnitude ?? 0,
          b.eyeAlignment.irisHorizontalMagnitude ?? 0,
          0.02
        ) &&
        approxEqual(
          a.eyeAlignment.irisVerticalMagnitude ?? 0,
          b.eyeAlignment.irisVerticalMagnitude ?? 0,
          0.02
        ) &&
        approxEqual(
          a.eyeAlignment.blendHorizontalMagnitude ?? 0,
          b.eyeAlignment.blendHorizontalMagnitude ?? 0,
          0.02
        ) &&
        approxEqual(
          a.eyeAlignment.blendVerticalMagnitude ?? 0,
          b.eyeAlignment.blendVerticalMagnitude ?? 0,
          0.02
        ) &&
        approxEqual(
          a.eyeAlignment.tolerances?.horizontal ?? 0,
          b.eyeAlignment.tolerances?.horizontal ?? 0,
          0.02
        ) &&
        approxEqual(
          a.eyeAlignment.tolerances?.vertical ?? 0,
          b.eyeAlignment.tolerances?.vertical ?? 0,
          0.02
        ) &&
        (!!a.eyeAlignment.within?.horizontal === !!b.eyeAlignment.within?.horizontal) &&
        (!!a.eyeAlignment.within?.vertical === !!b.eyeAlignment.within?.vertical))) &&
    ((
      !a.gazeTurns &&
      !b.gazeTurns
    ) ||
      (a.gazeTurns &&
        b.gazeTurns &&
        (!!a.gazeTurns.horizontal === !!b.gazeTurns.horizontal) &&
        (!!a.gazeTurns.vertical === !!b.gazeTurns.vertical) &&
        (!!a.gazeTurns.depth === !!b.gazeTurns.depth))) &&
    ((
      !a.matchPose &&
      !b.matchPose
    ) ||
      (a.matchPose &&
        b.matchPose &&
        (!!a.matchPose.within === !!b.matchPose.within) &&
        approxEqual(a.matchPose.delta?.yaw ?? 0, b.matchPose.delta?.yaw ?? 0, 0.02) &&
        approxEqual(a.matchPose.delta?.pitch ?? 0, b.matchPose.delta?.pitch ?? 0, 0.02) &&
        approxEqual(a.matchPose.delta?.roll ?? 0, b.matchPose.delta?.roll ?? 0, 0.02) &&
        approxEqual(
          a.matchPose.thresholds?.active?.yaw ?? 0,
          b.matchPose.thresholds?.active?.yaw ?? 0,
          0.02
        ) &&
        approxEqual(
          a.matchPose.thresholds?.active?.pitch ?? 0,
          b.matchPose.thresholds?.active?.pitch ?? 0,
          0.02
        ) &&
        approxEqual(
          a.matchPose.thresholds?.active?.roll ?? 0,
          b.matchPose.thresholds?.active?.roll ?? 0,
          0.02
        ) &&
        approxEqual(
          a.matchPose.thresholds?.enter?.yaw ?? 0,
          b.matchPose.thresholds?.enter?.yaw ?? 0,
          0.02
        ) &&
        approxEqual(
          a.matchPose.thresholds?.enter?.pitch ?? 0,
          b.matchPose.thresholds?.enter?.pitch ?? 0,
          0.02
        ) &&
        approxEqual(
          a.matchPose.thresholds?.enter?.roll ?? 0,
          b.matchPose.thresholds?.enter?.roll ?? 0,
          0.02
        ) &&
        approxEqual(
          a.matchPose.thresholds?.exit?.yaw ?? 0,
          b.matchPose.thresholds?.exit?.yaw ?? 0,
          0.02
        ) &&
        approxEqual(
          a.matchPose.thresholds?.exit?.pitch ?? 0,
          b.matchPose.thresholds?.exit?.pitch ?? 0,
          0.02
        ) &&
        approxEqual(
          a.matchPose.thresholds?.exit?.roll ?? 0,
          b.matchPose.thresholds?.exit?.roll ?? 0,
          0.02
        ) &&
        approxEqual(
          a.matchPose.baseline?.yaw ?? 0,
          b.matchPose.baseline?.yaw ?? 0,
          0.02
        ) &&
        approxEqual(
          a.matchPose.baseline?.pitch ?? 0,
          b.matchPose.baseline?.pitch ?? 0,
          0.02
        ) &&
        approxEqual(
          a.matchPose.baseline?.roll ?? 0,
          b.matchPose.baseline?.roll ?? 0,
          0.02
        ))) &&
    ((
      !a.faceMatch &&
      !b.faceMatch
    ) ||
      (a.faceMatch &&
        b.faceMatch &&
        approxEqual(a.faceMatch.score ?? 0, b.faceMatch.score ?? 0, 0.02) &&
        approxEqual(a.faceMatch.lastSimilarity ?? 0, b.faceMatch.lastSimilarity ?? 0, 0.02) &&
        (!!a.faceMatch.matched === !!b.faceMatch.matched) &&
        (!!a.faceMatch.poseWithin === !!b.faceMatch.poseWithin) &&
        approxEqual(
          a.faceMatch.thresholds?.high ?? 0,
          b.faceMatch.thresholds?.high ?? 0,
          0.02
        ) &&
        approxEqual(
          a.faceMatch.thresholds?.low ?? 0,
          b.faceMatch.thresholds?.low ?? 0,
          0.02
        ) &&
        (a.faceMatch.mismatchStreak ?? 0) === (b.faceMatch.mismatchStreak ?? 0)))
  );
}

/**
 * useFaceDetection hook
 * Continuously analyzes webcam video frames with MediaPipe FaceLandmarker.
 *
 * @param {React.MutableRefObject<HTMLVideoElement>} videoRef
 * @param {object} [options]
 * @param {number} [options.earThreshold]
 */
const useFaceDetection = (videoRef, options = {}) => {
  const dependencyKey = options.dependencyKey ?? null;
  const earThreshold = options.earThreshold ?? DEFAULT_EAR_THRESHOLD;
  const minEyesClosedMs = options.minEyesClosedMs ?? DEFAULT_MIN_EYES_CLOSED_MS;
  const horizontalTurnThreshold =
    options.horizontalTurnThreshold ?? DEFAULT_HORIZONTAL_TURN_THRESHOLD;
  const verticalTurnThreshold =
    options.verticalTurnThreshold ?? DEFAULT_VERTICAL_TURN_THRESHOLD;
  const depthTurnThreshold =
    options.depthTurnThreshold ?? DEFAULT_DEPTH_TURN_THRESHOLD;
  const lookingAwayMinMs = options.lookingAwayMinMs ?? DEFAULT_LOOKING_AWAY_MIN_MS;
  const calibrationFrames = options.calibrationFrames ?? DEFAULT_CALIBRATION_FRAMES;
  const baselineSmoothing = options.baselineSmoothing ?? DEFAULT_BASELINE_SMOOTHING;
  const multipleFacesConfirmationMs =
    options.multipleFacesConfirmationMs ?? DEFAULT_MULTI_FACE_CONFIRMATION_MS;
  const multipleFacesGraceMs =
    options.multipleFacesGraceMs ?? DEFAULT_MULTI_FACE_CLEAR_MS;
  const facePresentConfirmationMs =
    options.facePresentConfirmationMs ?? DEFAULT_FACE_PRESENT_CONFIRMATION_MS;
  const headTurnWindowMs = options.headTurnWindowMs ?? DEFAULT_HEAD_TURN_WINDOW_MS;
  const headTurnThreshold = options.headTurnThreshold ?? DEFAULT_HEAD_TURN_THRESHOLD;
  const headTurnCooldownMs = options.headTurnCooldownMs ?? DEFAULT_HEAD_TURN_COOLDOWN_MS;
  const headTurnClearMs = options.headTurnClearMs ?? DEFAULT_HEAD_TURN_CLEAR_MS;
  const modelAssetPath =
    options.modelAssetPath ?? options.modelUrl ?? DEFAULT_FACE_LANDMARKER_PATH;
  const wasmPath = options.wasmPath ?? DEFAULT_WASM_PATH;
  const referenceFaceUrl = options.referenceFaceUrl ?? DEFAULT_REFERENCE_FACE_URL;
  const faceMissingGraceMs =
    options.faceMissingGraceMs ?? DEFAULT_FACE_MISSING_GRACE_MS;
  const referenceMatchThreshold = clamp01(
    options.referenceMatchThreshold ?? DEFAULT_REFERENCE_MATCH_THRESHOLD
  );
  const referenceMatchHysteresis = clamp01(
    options.referenceMatchHysteresis ?? DEFAULT_REFERENCE_MATCH_HYSTERESIS
  );
  const matchPoseToleranceYaw =
    options.matchPoseToleranceYaw ?? DEFAULT_MATCH_POSE_TOLERANCE_YAW;
  const matchPoseTolerancePitch =
    options.matchPoseTolerancePitch ?? DEFAULT_MATCH_POSE_TOLERANCE_PITCH;
  const matchPoseToleranceRoll =
    options.matchPoseToleranceRoll ?? DEFAULT_MATCH_POSE_TOLERANCE_ROLL;
  const matchPoseHysteresis =
    options.matchPoseHysteresis ?? DEFAULT_MATCH_POSE_HYSTERESIS;
  const matchPoseBaselineSmoothing =
    options.matchPoseBaselineSmoothing ?? DEFAULT_MATCH_POSE_BASELINE_SMOOTHING;
  const matchConsecutiveMismatchFrames =
    options.matchConsecutiveMismatchFrames ?? DEFAULT_MATCH_CONSECUTIVE_MISMATCH_FRAMES;
  const minFaceDetectionConfidence =
    options.minFaceDetectionConfidence ?? DEFAULT_MIN_FACE_DETECTION_CONFIDENCE;
  const minFacePresenceConfidence =
    options.minFacePresenceConfidence ?? DEFAULT_MIN_FACE_PRESENCE_CONFIDENCE;
  const minTrackingConfidence =
    options.minTrackingConfidence ?? DEFAULT_MIN_TRACKING_CONFIDENCE;
  const [status, setStatus] = useState(createDefaultStatus);
  const [isReady, setIsReady] = useState(false);
  const landmarkerRef = useRef(null);
  const imageLandmarkerRef = useRef(null);
  const rafRef = useRef(null);
  const previousStatusRef = useRef(createDefaultStatus());
  const eyesStateRef = useRef({
    phase: 'open',
    changeTime: 0,
  });
  const gazeStateRef = useRef({
    state: 'facing',
    changeTime: 0,
    lastOffsets: null,
  });
  const gazeBaselineRef = useRef({
    sumYaw: 0,
    sumPitch: 0,
    sumRoll: 0,
    samples: 0,
    ready: false,
    yaw: 0,
    pitch: 0,
    roll: 0,
  });
  const facePresenceTrackerRef = useRef({
    firstSeenTime: null,
    lastSeenTime: null,
  });
  const headTurnTrackerRef = useRef({
    events: [],
    lastRecordedTime: 0,
    flaggedUntil: 0,
  });
  const multipleFacesTrackerRef = useRef({
    firstSeenTime: null,
    lastSeenTime: null,
  });
  const referenceFaceRef = useRef({
    url: referenceFaceUrl,
    loaded: false,
    signature: null,
    error: null,
    signatureSamples: 0,
  });
  const facePoseBaselineRef = useRef({
    yaw: null,
    pitch: null,
    roll: null,
    samples: 0,
  });
  const faceMatchStabilityRef = useRef({
    poseWithin: true,
    mismatchStreak: 0,
    lastSimilarity: null,
  });

  useEffect(() => {
    referenceFaceRef.current = {
      url: referenceFaceUrl,
      loaded: false,
      signature: null,
      error: null,
      signatureSamples: 0,
    };
  }, [referenceFaceUrl, dependencyKey]);

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
        console.warn('[FaceDetection] Failed to load vision WASM bundle', {
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

      previousStatusRef.current = createDefaultStatus();
      eyesStateRef.current = {
        phase: 'open',
        changeTime: performance.now(),
      };
      gazeBaselineRef.current = createBaselineState();
      headTurnTrackerRef.current = {
        events: [],
        lastRecordedTime: 0,
        flaggedUntil: 0,
      };
      facePresenceTrackerRef.current = {
        firstSeenTime: null,
        lastSeenTime: null,
      };
      multipleFacesTrackerRef.current = {
        firstSeenTime: null,
        lastSeenTime: null,
      };
      referenceFaceRef.current = {
        url: referenceFaceUrl,
        loaded: false,
        signature: null,
        error: null,
        signatureSamples: 0,
      };
      facePoseBaselineRef.current = {
        yaw: null,
        pitch: null,
        roll: null,
        samples: 0,
      };
      faceMatchStabilityRef.current = {
        poseWithin: true,
        mismatchStreak: 0,
        lastSimilarity: null,
      };
      setStatus(createDefaultStatus());
      setIsReady(false);

      try {
        const filesetResolver = await resolveVisionTasks();

        if (isCancelled) {
          return;
        }

        const modelCandidates = [];
        if (modelAssetPath) {
          modelCandidates.push(modelAssetPath);
        }
        if (!modelCandidates.includes(DEFAULT_FACE_LANDMARKER_PATH)) {
          modelCandidates.push(DEFAULT_FACE_LANDMARKER_PATH);
        }
        if (!modelCandidates.includes(FALLBACK_FACE_LANDMARKER_URL)) {
          modelCandidates.push(FALLBACK_FACE_LANDMARKER_URL);
        }

        let lastModelError = null;
        let modelUrlUsed = null;
        for (const candidate of modelCandidates) {
          try {
            landmarkerRef.current = await FaceLandmarker.createFromOptions(filesetResolver, {
              baseOptions: {
                modelAssetPath: candidate,
                delegate: 'GPU',
              },
              runningMode: 'VIDEO',
              numFaces: 2,
              outputFaceBlendshapes: true,
              outputFacialTransformationMatrixes: true,
              minFaceDetectionConfidence,
              minFacePresenceConfidence,
              minTrackingConfidence,
            });
            console.log('[FaceDetection] Face landmarker initialised', { modelPath: candidate });
            modelUrlUsed = candidate;
            lastModelError = null;
            break;
          } catch (error) {
            lastModelError = error;
            console.warn('[FaceDetection] Failed to load face landmarker model', {
              modelPath: candidate,
              message: error?.message,
            });
          }
        }

        if (!landmarkerRef.current) {
          throw lastModelError ?? new Error('Unable to initialise face landmarker model.');
        }

        if (modelUrlUsed) {
          try {
            imageLandmarkerRef.current = await FaceLandmarker.createFromOptions(filesetResolver, {
              baseOptions: {
                modelAssetPath: modelUrlUsed,
                delegate: 'CPU',
              },
              runningMode: 'IMAGE',
              numFaces: 1,
              outputFaceBlendshapes: false,
              outputFacialTransformationMatrixes: false,
              minFaceDetectionConfidence,
              minFacePresenceConfidence,
              minTrackingConfidence,
            });
            console.log('[FaceDetection] Reference image landmarker initialised', {
              modelPath: modelUrlUsed,
            });
          } catch (error) {
            imageLandmarkerRef.current = null;
            console.warn('[FaceDetection] Unable to initialise reference image landmarker', {
              modelPath: modelUrlUsed,
              message: error?.message,
            });
          }
        }

        if (!isCancelled) {
          setIsReady(true);
        }
      } catch (error) {
        console.error('[FaceDetection] Failed to initialise:', error);
      }
    };

    initialize();

    return () => {
      isCancelled = true;
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (landmarkerRef.current) {
        landmarkerRef.current.close();
        landmarkerRef.current = null;
      }
      if (imageLandmarkerRef.current) {
        imageLandmarkerRef.current.close();
        imageLandmarkerRef.current = null;
      }
    };
  }, [videoRef, dependencyKey]);

  useEffect(() => {
    if (!isReady || !referenceFaceRef.current?.url) {
      return;
    }

    let isCancelled = false;
    const imageLandmarker = imageLandmarkerRef.current;
    if (!imageLandmarker) {
      referenceFaceRef.current = {
        ...referenceFaceRef.current,
        loaded: false,
        signature: null,
        error: new Error('Reference landmarker not initialised.'),
      };
      return;
    }

    const loadReferenceFace = async () => {
      const currentReference = referenceFaceRef.current;
      if (currentReference.loaded && currentReference.signature && !currentReference.error) {
        return;
      }

      try {
        const imageElement = await loadImageElement(referenceFaceRef.current.url);
        if (isCancelled) {
          return;
        }

        const detection = imageLandmarker.detect(imageElement);
        const [landmarks] = detection?.faceLandmarks ?? [];
        if (!landmarks || !landmarks.length) {
          throw new Error('Reference face image does not contain a detectable face.');
        }

        const signature = computeFaceSignature(landmarks);
        if (!signature) {
          throw new Error('Failed to compute reference face signature.');
        }

        referenceFaceRef.current = {
          ...referenceFaceRef.current,
          loaded: true,
          signature,
          error: null,
          signatureSamples: 1,
        };
        console.log('[FaceDetection] Reference face processed', {
          url: referenceFaceRef.current.url,
          signaturePoints: signature.length,
        });
      } catch (error) {
        if (isCancelled) {
          return;
        }

        referenceFaceRef.current = {
          ...referenceFaceRef.current,
          loaded: false,
          signature: null,
          error,
          signatureSamples: 0,
        };
        console.error('[FaceDetection] Failed to process reference face image', error);
      }
    };

    loadReferenceFace();

    return () => {
      isCancelled = true;
    };
  }, [isReady, referenceFaceUrl]);

  useEffect(() => {
    if (!isReady || !videoRef.current || !landmarkerRef.current) {
      return;
    }

    const analyzeFrame = () => {
      if (!videoRef.current || videoRef.current.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        rafRef.current = requestAnimationFrame(analyzeFrame);
        return;
      }

      try {
        const timestamp = performance.now();
        const results = landmarkerRef.current.detectForVideo(videoRef.current, timestamp);
        const faces = results?.faceLandmarks ?? [];
        const blendshapeResults = results?.faceBlendshapes ?? [];
        const facialMatrices = results?.facialTransformationMatrixes ?? [];
        const facesDetected = faces.length;

        const previousStatus = previousStatusRef.current;
        let shouldUpdate = false;
        let nextStatus = previousStatus;
        const queueStatusUpdate = (statusUpdate) => {
          if (!statusEquals(previousStatus, statusUpdate)) {
            shouldUpdate = true;
            nextStatus = statusUpdate;
          }
        };
        const referenceState = referenceFaceRef.current ?? {};
        const referenceFaceReady = !!(referenceState.loaded && referenceState.signature);
        const referenceFaceError = referenceState.error
          ? referenceState.error.message ?? String(referenceState.error)
          : null;
        const previousReferenceMatched =
          typeof previousStatus.referenceMatched === 'boolean'
            ? previousStatus.referenceMatched
            : null;
        const matchingThresholdHigh = referenceMatchThreshold;
        const matchingThresholdLow = Math.max(
          0,
          Math.min(referenceMatchThreshold, referenceMatchThreshold - referenceMatchHysteresis)
        );

        let referenceMatchScore =
          referenceFaceReady && typeof previousStatus.referenceMatchScore === 'number'
            ? previousStatus.referenceMatchScore
            : null;
        let referenceMatched = referenceFaceReady ? previousReferenceMatched : previousStatus.referenceMatched;

        const presenceTracker = facePresenceTrackerRef.current;
        if (facesDetected > 0) {
          presenceTracker.lastSeenTime = timestamp;
          if (presenceTracker.firstSeenTime === null) {
            presenceTracker.firstSeenTime = timestamp;
          }
        } else if (!previousStatus.facePresent) {
          presenceTracker.firstSeenTime = null;
        }

        const timeSinceLastSeen =
          presenceTracker.lastSeenTime != null ? timestamp - presenceTracker.lastSeenTime : Infinity;
        const timeSinceFirstSeen =
          presenceTracker.firstSeenTime != null ? timestamp - presenceTracker.firstSeenTime : Infinity;

        let facePresent = previousStatus.facePresent;
        const graceMs =
          typeof faceMissingGraceMs === 'number'
            ? faceMissingGraceMs
            : DEFAULT_FACE_MISSING_GRACE_MS;

        if (previousStatus.facePresent) {
          facePresent = timeSinceLastSeen <= graceMs;
          if (!facePresent) {
            presenceTracker.firstSeenTime = null;
            presenceTracker.lastSeenTime = null;
          }
        } else {
          const confirmationMs =
            typeof facePresentConfirmationMs === 'number'
              ? facePresentConfirmationMs
              : DEFAULT_FACE_PRESENT_CONFIRMATION_MS;
          facePresent =
            facesDetected > 0 && timeSinceFirstSeen >= confirmationMs;
        }

        const faceBecameAbsent = previousStatus.facePresent && !facePresent;
        const faceBecamePresent = !previousStatus.facePresent && facePresent;

        if (faceBecameAbsent) {
          eyesStateRef.current = {
            phase: 'open',
            changeTime: timestamp,
          };
          gazeBaselineRef.current = createBaselineState();
        headTurnTrackerRef.current = {
          events: [],
          lastRecordedTime: 0,
          flaggedUntil: 0,
        };
          multipleFacesTrackerRef.current = {
            firstSeenTime: null,
            lastSeenTime: null,
          };
        } else if (faceBecamePresent) {
          gazeBaselineRef.current = createBaselineState();
        headTurnTrackerRef.current = {
          events: [],
          lastRecordedTime: 0,
          flaggedUntil: 0,
        };
        }

        if (!facePresent) {
          const hadUpdateBefore = shouldUpdate;
          queueStatusUpdate({
            facePresent: false,
            multipleFaces: false,
            eyesClosed: false,
            lookingAway: false,
            frequentHeadTurns: false,
            referenceFaceReady,
            referenceMatchScore: referenceFaceReady ? null : referenceMatchScore,
            referenceMatched: referenceFaceReady ? null : referenceMatched,
            referenceFaceError,
            facesDetected,
            boundingBox: null,
            gaze: null,
            keypoints: null,
            metrics: null,
          });

          if (!hadUpdateBefore && shouldUpdate) {
            console.log('[FaceDetection] No faces detected');
          }
        } else {
          const [firstFace] = faces;
          const hasCurrentFaceData = Array.isArray(firstFace) && firstFace.length > 0;

          const allowMultipleFaceCheck = facePresent;
          let multipleFaces = false;

          if (allowMultipleFaceCheck) {
            const multiTracker = multipleFacesTrackerRef.current;
            if (facesDetected > 1) {
              if (multiTracker.firstSeenTime === null) {
                multiTracker.firstSeenTime = timestamp;
              }
              multiTracker.lastSeenTime = timestamp;
            } else if (!previousStatus.multipleFaces) {
              multiTracker.firstSeenTime = null;
            }

            multipleFaces = previousStatus.multipleFaces;
            if (facesDetected > 1) {
              const confirmElapsed = multiTracker.firstSeenTime
                ? timestamp - multiTracker.firstSeenTime
                : 0;
              if (confirmElapsed >= multipleFacesConfirmationMs || multipleFaces) {
                multipleFaces = true;
              }
            } else if (multipleFaces) {
              const elapsedSinceLast = multiTracker.lastSeenTime
                ? timestamp - multiTracker.lastSeenTime
                : Infinity;
              if (elapsedSinceLast > multipleFacesGraceMs) {
                multipleFaces = false;
                multiTracker.lastSeenTime = null;
              }
            }
          }

          let reportedFaces = facesDetected;
          if (
            facePresent &&
            facesDetected === 0 &&
            typeof previousStatus.facesDetected === 'number' &&
            previousStatus.facesDetected > 0
          ) {
            reportedFaces = previousStatus.facesDetected;
          }

          let boundingBox = previousStatus.boundingBox;
          let keypoints = previousStatus.keypoints;
          let gazeSnapshot = null;
          let eyesClosed = false;
          let lookingAway = false;
          let frequentHeadTurns = false;
          let metrics = null;
          let leftEar = null;
          let rightEar = null;

          let leftEyeOuter = null;
          let rightEyeOuter = null;
          let noseTip = null;
          let foreheadCenter = null;
          let blendshapeMap = null;
          let blendshapeGaze = null;
          let blinkConfidence = null;

          if (hasCurrentFaceData) {
            leftEyeOuter = firstFace[33];
            rightEyeOuter = firstFace[263];
            noseTip = firstFace[1];
            foreheadCenter = firstFace[10];
            const xs = firstFace.map((point) => point?.x ?? 0);
            const ys = firstFace.map((point) => point?.y ?? 0);
            const minX = clamp01(Math.min(...xs));
            const maxX = clamp01(Math.max(...xs));
            const minY = clamp01(Math.min(...ys));
            const maxY = clamp01(Math.max(...ys));
            boundingBox = {
              x: minX,
              y: minY,
              width: clamp01(maxX - minX),
              height: clamp01(maxY - minY),
            };

            const eyeMidpointX =
              leftEyeOuter && rightEyeOuter
                ? (leftEyeOuter.x + rightEyeOuter.x) / 2
                : null;
            const eyeMidpointY =
              leftEyeOuter && rightEyeOuter
                ? (leftEyeOuter.y + rightEyeOuter.y) / 2
                : null;

            keypoints = {
              noseTip: noseTip
                ? {
                    x: clamp01(noseTip.x),
                    y: clamp01(noseTip.y),
                  }
                : null,
              eyeMidpoint:
                eyeMidpointX != null && eyeMidpointY != null
                  ? {
                      x: clamp01(eyeMidpointX),
                      y: clamp01(eyeMidpointY),
                    }
                  : keypoints?.eyeMidpoint ?? null,
              forehead: foreheadCenter
                ? {
                    x: clamp01(foreheadCenter.x),
                    y: clamp01(foreheadCenter.y),
                  }
                : null,
            };
          }

          const blendshapeCategories = blendshapeResults?.[0]?.categories ?? null;
          if (blendshapeCategories && blendshapeCategories.length) {
            blendshapeMap = buildBlendshapeMap(blendshapeCategories);
            blendshapeGaze = computeBlendshapeGaze(blendshapeMap);
            blinkConfidence = computeBlinkConfidence(blendshapeMap);
          }

          const faceMatrix = facialMatrices?.[0];
          const orientationAngles = faceMatrix ? extractEulerAnglesFromMatrix(faceMatrix) : null;
          const headYaw = orientationAngles?.yaw ?? null;
          const headPitch = orientationAngles?.pitch ?? null;
          const headRoll = orientationAngles?.roll ?? null;
          const orientationAvailable =
            Number.isFinite(headYaw) && Number.isFinite(headPitch) && Number.isFinite(headRoll);

          const poseBaseline = facePoseBaselineRef.current;
          const matchStability = faceMatchStabilityRef.current;
          const previousPoseWithin = matchStability.poseWithin ?? true;
          const poseEnterThresholds = {
            yaw: matchPoseToleranceYaw,
            pitch: matchPoseTolerancePitch,
            roll: matchPoseToleranceRoll,
          };
          const poseExitThresholds = {
            yaw: matchPoseToleranceYaw + matchPoseHysteresis,
            pitch: matchPoseTolerancePitch + matchPoseHysteresis,
            roll: matchPoseToleranceRoll + matchPoseHysteresis,
          };
          const activePoseThresholds = previousPoseWithin ? poseExitThresholds : poseEnterThresholds;

          let poseWithinMatchWindow = true;
          let poseDelta = null;

          if (orientationAvailable) {
            if (poseBaseline.samples > 0) {
              const yawDelta = normaliseAngleDelta(headYaw, poseBaseline.yaw ?? 0);
              const pitchDelta = normaliseAngleDelta(headPitch, poseBaseline.pitch ?? 0);
              const rollDelta = normaliseAngleDelta(headRoll, poseBaseline.roll ?? 0);
              poseDelta = {
                yaw: yawDelta,
                pitch: pitchDelta,
                roll: rollDelta,
              };

              poseWithinMatchWindow =
                Math.abs(yawDelta) <= activePoseThresholds.yaw &&
                Math.abs(pitchDelta) <= activePoseThresholds.pitch &&
                Math.abs(rollDelta) <= activePoseThresholds.roll;
            } else {
              poseWithinMatchWindow = true;
              poseDelta = {
                yaw: 0,
                pitch: 0,
                roll: 0,
              };
            }
          }

          matchStability.poseWithin = poseWithinMatchWindow;

          const allowIdentityCheck = facePresent && hasCurrentFaceData && referenceFaceReady;
          let latestSimilarity = null;

          if (allowIdentityCheck) {
            const liveSignature = computeFaceSignature(firstFace);
            const similarity = computeFaceSimilarity(referenceState.signature, liveSignature);
            if (typeof similarity === 'number') {
              latestSimilarity = similarity;
              if (poseWithinMatchWindow) {
                referenceMatchScore = similarity;
                const wasMatched = previousReferenceMatched === true;
                if (similarity >= matchingThresholdHigh) {
                  referenceMatched = true;
                  matchStability.mismatchStreak = 0;
                } else if (similarity < matchingThresholdLow) {
                  matchStability.mismatchStreak =
                    (matchStability.mismatchStreak ?? 0) + 1;
                  if (matchStability.mismatchStreak >= matchConsecutiveMismatchFrames) {
                    referenceMatched = false;
                  } else {
                    referenceMatched = wasMatched;
                  }
                } else {
                  referenceMatched = wasMatched;
                  matchStability.mismatchStreak = Math.max(
                    0,
                    (matchStability.mismatchStreak ?? 0) - 1
                  );
                }

                if (!referenceMatched && referenceMatched !== wasMatched) {
                  console.warn('[FaceDetection] Reference face mismatch detected', {
                    similarity: Number(similarity.toFixed(3)),
                    thresholdHigh: Number(matchingThresholdHigh.toFixed(3)),
                    thresholdLow: Number(matchingThresholdLow.toFixed(3)),
                    mismatchStreak: matchStability.mismatchStreak,
                  });
                }

                if (referenceMatched === true) {
                  matchStability.mismatchStreak = 0;
                if (
                  MATCH_SIGNATURE_BLEND_ALPHA > 0 &&
                  poseWithinMatchWindow &&
                  similarity >= matchingThresholdHigh &&
                  Array.isArray(referenceState.signature) &&
                  Array.isArray(liveSignature) &&
                  referenceState.signature.length === liveSignature.length &&
                  referenceState.signature.length > 0
                ) {
                  const alpha = MATCH_SIGNATURE_BLEND_ALPHA;
                  const blended = referenceState.signature.map((point, idx) => {
                    const livePoint = liveSignature[idx] ?? point;
                    return {
                      x: point.x + (livePoint.x - point.x) * alpha,
                      y: point.y + (livePoint.y - point.y) * alpha,
                      z: (point.z ?? 0) + ((livePoint.z ?? 0) - (point.z ?? 0)) * alpha,
                    };
                  });
                  const updatedSamples = (referenceState.signatureSamples ?? 0) + 1;
                  Object.assign(referenceFaceRef.current, {
                    signature: blended,
                    signatureSamples: updatedSamples,
                  });
                  referenceState.signature = blended;
                  referenceState.signatureSamples = updatedSamples;
                }
                }
              } else {
                referenceMatchScore = previousStatus.referenceMatchScore;
                referenceMatched = previousReferenceMatched;
                matchStability.mismatchStreak = Math.max(
                  0,
                  (matchStability.mismatchStreak ?? 0) - 1
                );
              }
            } else {
              const wasMatched = previousReferenceMatched === true;
              referenceMatchScore = null;
              referenceMatched = wasMatched ? false : null;
            }
          } else if (referenceFaceReady) {
            referenceMatchScore = null;
            referenceMatched = previousReferenceMatched;
          }
          matchStability.lastSimilarity = latestSimilarity;

          if (orientationAvailable && referenceMatched === true && poseWithinMatchWindow) {
            if (poseBaseline.samples === 0) {
              poseBaseline.yaw = headYaw ?? 0;
              poseBaseline.pitch = headPitch ?? 0;
              poseBaseline.roll = headRoll ?? 0;
            } else {
              const smoothingFactor = matchPoseBaselineSmoothing;
              poseBaseline.yaw = smoothTowardsAngle(poseBaseline.yaw ?? headYaw ?? 0, headYaw ?? 0, smoothingFactor);
              poseBaseline.pitch = smoothTowardsAngle(poseBaseline.pitch ?? headPitch ?? 0, headPitch ?? 0, smoothingFactor);
              poseBaseline.roll = smoothTowardsAngle(poseBaseline.roll ?? headRoll ?? 0, headRoll ?? 0, smoothingFactor);
            }
            poseBaseline.samples = Math.min(poseBaseline.samples + 1, Number.MAX_SAFE_INTEGER);
          }

          const irisGaze = hasCurrentFaceData ? computeIrisGaze(firstFace) : null;
          const irisHorizontal = irisGaze?.horizontal ?? null;
          const irisVertical = irisGaze?.vertical ?? null;
          const blendHorizontal = blendshapeGaze?.horizontal ?? null;
          const blendVertical = blendshapeGaze?.vertical ?? null;
          const combinedEyeHorizontal = combineGazeSignals([
            irisHorizontal,
            blendHorizontal,
          ]);
          const combinedEyeVertical = combineGazeSignals([
            irisVertical,
            blendVertical,
          ]);
          const eyeHorizontalValue = combinedEyeHorizontal ?? 0;
          const eyeVerticalValue = combinedEyeVertical ?? 0;
          const irisSnapshot =
            irisHorizontal != null || irisVertical != null
              ? {
                  horizontal: irisHorizontal ?? 0,
                  vertical: irisVertical ?? 0,
                }
              : null;
          const eyeSnapshot =
            combinedEyeHorizontal != null ||
            combinedEyeVertical != null ||
            irisSnapshot ||
            blendshapeGaze
              ? {
                  horizontal: combinedEyeHorizontal ?? null,
                  vertical: combinedEyeVertical ?? null,
                  iris: irisSnapshot,
                  blendshape: blendshapeGaze,
                }
              : null;

          const eyeHorizontalMagnitude = Math.abs(eyeHorizontalValue ?? 0);
          const eyeVerticalMagnitude = Math.abs(eyeVerticalValue ?? 0);
          const irisHorizontalMagnitude = Math.abs(irisHorizontal ?? 0);
          const irisVerticalMagnitude = Math.abs(irisVertical ?? 0);
          const blendHorizontalMagnitude = Math.abs(blendHorizontal ?? 0);
          const blendVerticalMagnitude = Math.abs(blendVertical ?? 0);

          let headHorizontalMagnitude = 0;
          let headVerticalMagnitude = 0;
          let headDepthMagnitude = 0;
          let effectiveHorizontalTurnThreshold =
            horizontalTurnThreshold + GAZE_HEAD_EXTRA_TOLERANCE;
          let effectiveVerticalTurnThreshold =
            verticalTurnThreshold + GAZE_HEAD_EXTRA_TOLERANCE;
          let effectiveDepthTurnThreshold =
            depthTurnThreshold + GAZE_HEAD_EXTRA_TOLERANCE * 0.6;
          let eyeHorizontalBeyondComfort = false;
          let eyeVerticalBeyondComfort = false;
          let headHorizontalTurn = false;
          let headVerticalTurn = false;
          let headDepthTurn = false;
          let horizontalEyeSignal = false;
          let verticalEyeSignal = false;
          let horizontalTurn = false;
          let verticalTurn = false;
          let depthTurn = false;

          const allowBehaviourChecks = facePresent && hasCurrentFaceData;

          const canProcessGaze = allowBehaviourChecks && leftEyeOuter && rightEyeOuter && noseTip;

          if (canProcessGaze) {
            leftEar = calculateEyeAspectRatio(firstFace, LEFT_EYE_INDICES);
            rightEar = calculateEyeAspectRatio(firstFace, RIGHT_EYE_INDICES);
            const belowThreshold =
              leftEar != null && rightEar != null
                ? leftEar < earThreshold && rightEar < earThreshold
                : false;

            const eyeMidpointX = (leftEyeOuter.x + rightEyeOuter.x) / 2;
            const eyeMidpointY = (leftEyeOuter.y + rightEyeOuter.y) / 2;
            const eyeDistance = Math.hypot(
              rightEyeOuter.x - leftEyeOuter.x,
              rightEyeOuter.y - leftEyeOuter.y
            );

            const baseline = gazeBaselineRef.current;
            const headTurnTracker = headTurnTrackerRef.current;

            const referencePoint = foreheadCenter ?? noseTip;
            const horizontalOffsetRaw =
              referencePoint && eyeMidpointX != null
                ? referencePoint.x - eyeMidpointX
                : 0;
            const verticalOffsetRaw =
              referencePoint && eyeMidpointY != null
                ? referencePoint.y - eyeMidpointY
                : 0;
            const depthDifferenceRaw = (leftEyeOuter.z ?? 0) - (rightEyeOuter.z ?? 0);

            let horizontalOffset = 0;
            let verticalOffset = 0;
            let depthOffset = 0;

            if (orientationAvailable) {
              horizontalOffset = headYaw;
              verticalOffset = headPitch;
              depthOffset = headRoll;
            } else if (eyeDistance > 0) {
              horizontalOffset = horizontalOffsetRaw / eyeDistance;
              verticalOffset = verticalOffsetRaw / eyeDistance;
              depthOffset = depthDifferenceRaw;
            }

            if (orientationAvailable || eyeDistance > 0) {
              let calibrationProgress = baseline.ready
                ? 1
                : Math.min(1, baseline.samples / Math.max(1, calibrationFrames));

              if (!baseline.ready) {
                baseline.sumYaw += horizontalOffset;
                baseline.sumPitch += verticalOffset;
                baseline.sumRoll += depthOffset;
                baseline.samples += 1;

                if (baseline.samples >= calibrationFrames) {
                  baseline.yaw = baseline.sumYaw / baseline.samples;
                  baseline.pitch = baseline.sumPitch / baseline.samples;
                  baseline.roll = baseline.sumRoll / baseline.samples;
                  baseline.ready = true;
                  console.log('[FaceDetection] Gaze baseline calibrated', {
                    samples: baseline.samples,
                    yaw: Number(baseline.yaw.toFixed(4)),
                    pitch: Number(baseline.pitch.toFixed(4)),
                    roll: Number(baseline.roll.toFixed(4)),
                  });
                }

                gazeStateRef.current = {
                  state: 'facing',
                  changeTime: timestamp,
                  lastOffsets: {
                    horizontal: 0,
                    vertical: 0,
                    depth: 0,
                  },
                };
                headTurnTracker.events = [];
                headTurnTracker.lastRecordedTime = 0;
                headTurnTracker.flaggedUntil = 0;
                eyesStateRef.current = {
                  phase: 'open',
                  changeTime: timestamp,
                };
                gazeSnapshot = {
                yaw: 0,
                pitch: 0,
                roll: 0,
                rawYaw: horizontalOffset,
                rawPitch: verticalOffset,
                rawRoll: depthOffset,
                baselineYaw: baseline.yaw,
                baselinePitch: baseline.pitch,
                baselineRoll: baseline.roll,
                calibrationProgress,
                calibrated: baseline.ready,
                state: gazeStateRef.current.state,
                horizontalTurn: false,
                verticalTurn: false,
                depthTurn: false,
                iris: irisSnapshot,
                eye: eyeSnapshot,
                headOrientation: orientationAvailable
                  ? {
                      yaw: headYaw,
                      pitch: headPitch,
                      roll: headRoll,
                    }
                  : null,
                comfort: {
                  headAligned: {
                    horizontal: true,
                    vertical: true,
                    depth: true,
                  },
                  eyeAligned: {
                    horizontal: true,
                    vertical: true,
                  },
                },
              };
              } else {
                const yawError = horizontalOffset - baseline.yaw;
                const pitchError = verticalOffset - baseline.pitch;
                const rollError = depthOffset - baseline.roll;

                if (Math.abs(yawError) < horizontalTurnThreshold * 0.6) {
                  baseline.yaw += yawError * baselineSmoothing;
                }
                if (Math.abs(pitchError) < verticalTurnThreshold * 0.6) {
                  baseline.pitch += pitchError * baselineSmoothing;
                }
                if (Math.abs(rollError) < depthTurnThreshold * 0.6) {
                  baseline.roll += rollError * baselineSmoothing;
                }

                const adjustedYaw = yawError;
                const adjustedPitch = pitchError;
                const adjustedRoll = rollError;

                headHorizontalMagnitude = Math.abs(adjustedYaw);
                headVerticalMagnitude = Math.abs(adjustedPitch);
                headDepthMagnitude = Math.abs(adjustedRoll);

                effectiveHorizontalTurnThreshold =
                  horizontalTurnThreshold + GAZE_HEAD_EXTRA_TOLERANCE;
                effectiveVerticalTurnThreshold =
                  verticalTurnThreshold + GAZE_HEAD_EXTRA_TOLERANCE;
                effectiveDepthTurnThreshold =
                  depthTurnThreshold + GAZE_HEAD_EXTRA_TOLERANCE * 0.6;

                eyeHorizontalBeyondComfort =
                  eyeHorizontalMagnitude > GAZE_EYE_HORIZONTAL_TOLERANCE;
                eyeVerticalBeyondComfort =
                  eyeVerticalMagnitude > GAZE_EYE_VERTICAL_TOLERANCE;

                horizontalEyeSignal =
                  irisHorizontalMagnitude > IRIS_HORIZONTAL_THRESHOLD ||
                  blendHorizontalMagnitude > BLEND_GAZE_HORIZONTAL_THRESHOLD;
                verticalEyeSignal =
                  irisVerticalMagnitude > IRIS_VERTICAL_THRESHOLD ||
                  blendVerticalMagnitude > BLEND_GAZE_VERTICAL_THRESHOLD;

                headHorizontalTurn =
                  headHorizontalMagnitude > effectiveHorizontalTurnThreshold;
                headVerticalTurn =
                  headVerticalMagnitude > effectiveVerticalTurnThreshold;
                headDepthTurn = headDepthMagnitude > effectiveDepthTurnThreshold;

                horizontalTurn =
                  headHorizontalTurn || (horizontalEyeSignal && eyeHorizontalBeyondComfort);
                verticalTurn =
                  headVerticalTurn || (verticalEyeSignal && eyeVerticalBeyondComfort);
                depthTurn = headDepthTurn;

                const significantHeadTurn =
                  headHorizontalMagnitude > effectiveHorizontalTurnThreshold + 0.15 ||
                  headVerticalMagnitude > effectiveVerticalTurnThreshold + 0.15 ||
                  headDepthMagnitude > effectiveDepthTurnThreshold + 0.15;

                headTurnTracker.events = headTurnTracker.events.filter(
                  (eventTime) => timestamp - eventTime <= headTurnWindowMs
                );
                if (significantHeadTurn) {
                  if (timestamp - headTurnTracker.lastRecordedTime >= headTurnCooldownMs) {
                    headTurnTracker.events.push(timestamp);
                    headTurnTracker.lastRecordedTime = timestamp;
                  }
                }

                if (headTurnTracker.events.length >= headTurnThreshold) {
                  headTurnTracker.flaggedUntil = timestamp + headTurnClearMs;
                } else if (
                  headTurnTracker.flaggedUntil &&
                  timestamp > headTurnTracker.flaggedUntil
                ) {
                  headTurnTracker.flaggedUntil = 0;
                }

                frequentHeadTurns = headTurnTracker.flaggedUntil > timestamp;

                if (!horizontalTurn && !verticalTurn && !depthTurn) {
                  gazeStateRef.current = {
                    state: 'facing',
                    changeTime: timestamp,
                    lastOffsets: {
                      horizontal: adjustedYaw,
                      vertical: adjustedPitch,
                      depth: adjustedRoll,
                    },
                  };
                  lookingAway = false;
                } else if (gazeStateRef.current.state === 'facing') {
                  gazeStateRef.current = {
                    state: 'turning',
                    changeTime: timestamp,
                    lastOffsets: {
                      horizontal: adjustedYaw,
                      vertical: adjustedPitch,
                      depth: adjustedRoll,
                    },
                  };
                  lookingAway = false;
                } else if (gazeStateRef.current.state === 'turning') {
                  const turningDuration = timestamp - gazeStateRef.current.changeTime;
                  if (turningDuration >= lookingAwayMinMs) {
                    gazeStateRef.current = {
                      state: 'away',
                      changeTime: timestamp,
                      lastOffsets: {
                        horizontal: adjustedYaw,
                        vertical: adjustedPitch,
                        depth: adjustedRoll,
                      },
                    };
                    lookingAway = true;
                    console.log('[FaceDetection] Looking away confirmed', {
                      yaw: Number(adjustedYaw.toFixed(3)),
                      pitch: Number(adjustedPitch.toFixed(3)),
                      roll: Number(adjustedRoll.toFixed(3)),
                      durationMs: Math.round(turningDuration),
                      headHorizontal: Number(headHorizontalMagnitude.toFixed(3)),
                      headVertical: Number(headVerticalMagnitude.toFixed(3)),
                      headDepth: Number(headDepthMagnitude.toFixed(3)),
                      horizontalThreshold: Number(effectiveHorizontalTurnThreshold.toFixed(3)),
                      verticalThreshold: Number(effectiveVerticalTurnThreshold.toFixed(3)),
                      depthThreshold: Number(effectiveDepthTurnThreshold.toFixed(3)),
                      eyeHorizontal:
                        combinedEyeHorizontal != null
                          ? Number(combinedEyeHorizontal.toFixed(3))
                          : null,
                      eyeVertical:
                        combinedEyeVertical != null
                          ? Number(combinedEyeVertical.toFixed(3))
                          : null,
                      irisHorizontal:
                        irisHorizontal != null ? Number(irisHorizontal.toFixed(3)) : null,
                      irisVertical:
                        irisVertical != null ? Number(irisVertical.toFixed(3)) : null,
                      blendshapeHorizontal:
                        blendHorizontal != null ? Number(blendHorizontal.toFixed(3)) : null,
                      blendshapeVertical:
                        blendVertical != null ? Number(blendVertical.toFixed(3)) : null,
                      eyeHorizontalComfort: !eyeHorizontalBeyondComfort,
                      eyeVerticalComfort: !eyeVerticalBeyondComfort,
                      eyeHorizontalTolerance: Number(GAZE_EYE_HORIZONTAL_TOLERANCE.toFixed(3)),
                      eyeVerticalTolerance: Number(GAZE_EYE_VERTICAL_TOLERANCE.toFixed(3)),
                    });
                  } else {
                    lookingAway = false;
                  }
                } else {
                  gazeStateRef.current = {
                    state: 'away',
                    changeTime: timestamp,
                    lastOffsets: {
                      horizontal: adjustedYaw,
                      vertical: adjustedPitch,
                      depth: adjustedRoll,
                    },
                  };
                  lookingAway = true;
                }

                if (lookingAway) {
                  console.log('[FaceDetection] Looking away detected', {
                    yaw: Number(adjustedYaw.toFixed(3)),
                    pitch: Number(adjustedPitch.toFixed(3)),
                    roll: Number(adjustedRoll.toFixed(3)),
                    headHorizontal: Number(headHorizontalMagnitude.toFixed(3)),
                    headVertical: Number(headVerticalMagnitude.toFixed(3)),
                    headDepth: Number(headDepthMagnitude.toFixed(3)),
                    horizontalThreshold: Number(effectiveHorizontalTurnThreshold.toFixed(3)),
                    verticalThreshold: Number(effectiveVerticalTurnThreshold.toFixed(3)),
                    depthThreshold: Number(effectiveDepthTurnThreshold.toFixed(3)),
                    eyeHorizontal:
                      combinedEyeHorizontal != null
                        ? Number(combinedEyeHorizontal.toFixed(3))
                        : null,
                    eyeVertical:
                      combinedEyeVertical != null
                        ? Number(combinedEyeVertical.toFixed(3))
                        : null,
                    irisHorizontal:
                      irisHorizontal != null ? Number(irisHorizontal.toFixed(3)) : null,
                    irisVertical:
                      irisVertical != null ? Number(irisVertical.toFixed(3)) : null,
                    blendshapeHorizontal:
                      blendHorizontal != null ? Number(blendHorizontal.toFixed(3)) : null,
                    blendshapeVertical:
                      blendVertical != null ? Number(blendVertical.toFixed(3)) : null,
                    eyeHorizontalComfort: !eyeHorizontalBeyondComfort,
                    eyeVerticalComfort: !eyeVerticalBeyondComfort,
                    eyeHorizontalTolerance: Number(GAZE_EYE_HORIZONTAL_TOLERANCE.toFixed(3)),
                    eyeVerticalTolerance: Number(GAZE_EYE_VERTICAL_TOLERANCE.toFixed(3)),
                  });
                }

                gazeSnapshot = {
                  yaw: adjustedYaw,
                  pitch: adjustedPitch,
                  roll: adjustedRoll,
                  rawYaw: horizontalOffset,
                  rawPitch: verticalOffset,
                  rawRoll: depthOffset,
                  baselineYaw: baseline.yaw,
                  baselinePitch: baseline.pitch,
                  baselineRoll: baseline.roll,
                  calibrationProgress,
                  calibrated: baseline.ready,
                  state: gazeStateRef.current.state,
                  horizontalTurn,
                  verticalTurn,
                  depthTurn,
                  iris: irisSnapshot,
                  eye: eyeSnapshot,
                  headOrientation: orientationAvailable
                    ? {
                        yaw: headYaw,
                        pitch: headPitch,
                        roll: headRoll,
                      }
                    : null,
                comfort: {
                  headAligned: {
                    horizontal: !headHorizontalTurn,
                    vertical: !headVerticalTurn,
                    depth: !headDepthTurn,
                  },
                  eyeAligned: {
                    horizontal: !eyeHorizontalBeyondComfort,
                    vertical: !eyeVerticalBeyondComfort,
                  },
                  thresholds: {
                    head: {
                      horizontal: effectiveHorizontalTurnThreshold,
                      vertical: effectiveVerticalTurnThreshold,
                      depth: effectiveDepthTurnThreshold,
                    },
                    eye: {
                      horizontal: GAZE_EYE_HORIZONTAL_TOLERANCE,
                      vertical: GAZE_EYE_VERTICAL_TOLERANCE,
                    },
                  },
                },
                };
              }

              const eyeState = eyesStateRef.current;
              let updatedPhase = eyeState.phase;

              const blinkActive =
                blinkConfidence != null && blinkConfidence > BLINK_BLEND_THRESHOLD;
              const eyeClosureSignal = belowThreshold || blinkActive;

              if (eyeClosureSignal) {
                if (eyeState.phase === 'open') {
                  updatedPhase = 'closing';
                  eyesStateRef.current = {
                    phase: updatedPhase,
                    changeTime: timestamp,
                  };
                  console.log('[FaceDetection] Eye closing started', {
                    leftEar: Number(leftEar?.toFixed(3) ?? 0),
                    rightEar: Number(rightEar?.toFixed(3) ?? 0),
                    blinkConfidence: Number((blinkConfidence ?? 0).toFixed(3)),
                  });
                } else if (eyeState.phase === 'closing') {
                  const closedDuration = timestamp - eyeState.changeTime;
                  if (closedDuration >= minEyesClosedMs) {
                    updatedPhase = 'closed';
                    eyesStateRef.current = {
                      phase: updatedPhase,
                      changeTime: timestamp,
                    };
                    console.log('[FaceDetection] Eyes considered closed', {
                      durationMs: Math.round(closedDuration),
                    });
                  }
                }
              } else if (eyeState.phase !== 'open') {
                updatedPhase = 'open';
                eyesStateRef.current = {
                  phase: updatedPhase,
                  changeTime: timestamp,
                };
                if (eyeState.phase === 'closed') {
                  console.log('[FaceDetection] Eyes reopened', {
                    durationMs: Math.round(timestamp - eyeState.changeTime),
                    blinkConfidence: Number((blinkConfidence ?? 0).toFixed(3)),
                  });
                }
              }

              eyesClosed = eyesStateRef.current.phase === 'closed';

                headTurnTracker.events = headTurnTracker.events.filter(
                  (eventTime) => timestamp - eventTime <= headTurnWindowMs
                );
                const headTurnEvents = headTurnTracker.events;
                const headTurnCount = headTurnEvents.length;
                const headTurnRate =
                  headTurnWindowMs > 0 ? (headTurnCount * 60000) / headTurnWindowMs : 0;
                const recentHeadTurnMs =
                  headTurnEvents.length > 0
                    ? timestamp - headTurnEvents[headTurnEvents.length - 1]
                    : null;

                metrics = {
                  calibrationProgress,
                  headTurnCount,
                  headTurnRate,
                  recentHeadTurnMs,
                headYaw: orientationAvailable ? headYaw : null,
                headPitch: orientationAvailable ? headPitch : null,
                headRoll: orientationAvailable ? headRoll : null,
                headOrientation: orientationAvailable
                  ? {
                      yaw: headYaw,
                      pitch: headPitch,
                      roll: headRoll,
                    }
                  : null,
                headAlignment: {
                  horizontalMagnitude: headHorizontalMagnitude,
                  verticalMagnitude: headVerticalMagnitude,
                  depthMagnitude: headDepthMagnitude,
                  thresholds: {
                    horizontal: effectiveHorizontalTurnThreshold,
                    vertical: effectiveVerticalTurnThreshold,
                    depth: effectiveDepthTurnThreshold,
                  },
                  within: {
                    horizontal: !headHorizontalTurn,
                    vertical: !headVerticalTurn,
                    depth: !headDepthTurn,
                  },
                },
                eyeHorizontal: combinedEyeHorizontal,
                eyeVertical: combinedEyeVertical,
                irisHorizontal,
                irisVertical,
                blendshapeHorizontal: blendHorizontal,
                blendshapeVertical: blendVertical,
                blinkConfidence,
                eyeAlignment: {
                  horizontalMagnitude: eyeHorizontalMagnitude,
                  verticalMagnitude: eyeVerticalMagnitude,
                  irisHorizontalMagnitude,
                  irisVerticalMagnitude,
                  blendHorizontalMagnitude,
                  blendVerticalMagnitude,
                  tolerances: {
                    horizontal: GAZE_EYE_HORIZONTAL_TOLERANCE,
                    vertical: GAZE_EYE_VERTICAL_TOLERANCE,
                  },
                  within: {
                    horizontal: !eyeHorizontalBeyondComfort,
                    vertical: !eyeVerticalBeyondComfort,
                  },
                },
                gazeTurns: {
                  horizontal: horizontalTurn,
                  vertical: verticalTurn,
                  depth: depthTurn,
                },
                matchPose: orientationAvailable
                  ? {
                      baseline:
                        poseBaseline.samples > 0
                          ? {
                              yaw: poseBaseline.yaw,
                              pitch: poseBaseline.pitch,
                              roll: poseBaseline.roll,
                            }
                          : null,
                      delta: poseDelta,
                      thresholds: {
                        active: activePoseThresholds,
                        enter: poseEnterThresholds,
                        exit: poseExitThresholds,
                      },
                      within: poseWithinMatchWindow,
                    }
                  : null,
                faceMatch: {
                  score: referenceMatchScore,
                  lastSimilarity: latestSimilarity,
                  matched: referenceMatched,
                  poseWithin: poseWithinMatchWindow,
                  mismatchStreak: matchStability.mismatchStreak ?? 0,
                  thresholds: {
                    high: matchingThresholdHigh,
                    low: matchingThresholdLow,
                  },
                },
              };
            }
          } else {
            gazeSnapshot = null;
            eyesClosed = false;
            lookingAway = false;
            frequentHeadTurns = false;
            metrics = null;

            if (gazeStateRef.current.state !== 'facing') {
              gazeStateRef.current = {
                state: 'facing',
                changeTime: timestamp,
                lastOffsets: null,
              };
            }
            resetBaselineState(gazeBaselineRef.current);

            headTurnTrackerRef.current = {
              events: [],
              lastRecordedTime: 0,
              flaggedUntil: 0,
            };
            eyesStateRef.current = {
              phase: 'open',
              changeTime: timestamp,
            };
          }

          const candidateStatus = {
            facePresent: true,
            multipleFaces,
            eyesClosed,
            lookingAway,
            frequentHeadTurns,
            referenceFaceReady,
            referenceMatchScore: referenceFaceReady ? referenceMatchScore : null,
            referenceMatched: referenceFaceReady ? referenceMatched : null,
            referenceFaceError,
            facesDetected: reportedFaces,
            boundingBox,
            gaze: gazeSnapshot
              ? {
                  ...gazeSnapshot,
                  calibrationProgress:
                    gazeSnapshot.calibrationProgress ??
                    metrics?.calibrationProgress ??
                    0,
                }
              : null,
            keypoints,
            metrics,
          };

          const hadUpdateBefore = shouldUpdate;
          queueStatusUpdate(candidateStatus);
          if (!hadUpdateBefore && shouldUpdate) {
            console.log('[FaceDetection] Update', {
              facesDetected: reportedFaces,
              leftEar: leftEar != null ? Number(leftEar.toFixed(3)) : null,
              rightEar: rightEar != null ? Number(rightEar.toFixed(3)) : null,
              eyesPhase: eyesStateRef.current.phase,
              eyesClosed,
            });
          }
        }

        if (shouldUpdate) {
          previousStatusRef.current = nextStatus;
          setStatus(nextStatus);
        }
      } catch (error) {
        console.error('[FaceDetection] Detection error:', error);
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
  }, [dependencyKey, earThreshold, isReady, videoRef]);

  return status;
};

export default useFaceDetection;

