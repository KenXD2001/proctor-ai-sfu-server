import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { io } from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';
import config from '../config';
import useFaceDetection from '../hooks/useFaceDetection';
import useNoiseDetection from '../hooks/useNoiseDetection';
import useMobileDetection from '../hooks/useMobileDetection';

const MAX_ALERT_EVENTS = 5;
const FACE_EVIDENCE_TYPES = new Set([
  'face_missing',
  'eyes_closed',
  'looking_away',
  'multiple_faces',
]);
const NOISE_RECORDING_DURATION_MS = 5000;
const NOISE_CAPTURE_COOLDOWN_MS = 15000;

const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    try {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result;
        if (typeof result === 'string') {
          const base64 = result.split(',')[1] ?? '';
          resolve(base64);
        } else {
          resolve('');
        }
      };
      reader.onerror = (error) => reject(error);
      reader.readAsDataURL(blob);
    } catch (error) {
      reject(error);
    }
  });

const ALERT_EVENT_LABELS = {
  face_missing: 'Face not detected',
  eyes_closed: 'Eyes closed',
  looking_away: 'Looking away',
  multiple_faces: 'Multiple faces detected',
  mobile_detected: 'Mobile device detected',
};

const getEventDescription = (event) => {
  switch (event.type) {
    case 'looking_away':
      return 'Candidate gaze deviated away from the screen.';
    case 'mobile_detected':
      return `Detected a potential mobile device${event.meta?.label ? ` (${event.meta.label})` : ''}.`;
    case 'eyes_closed':
      return 'Candidate eyes were closed at capture time.';
    case 'multiple_faces':
      if (event.meta?.facesDetected) {
        return `Detected ${event.meta.facesDetected} faces simultaneously.`;
      }
      return 'Detected more than one face in the frame.';
    case 'face_missing':
    default:
      return 'Candidate face left the camera frame.';
  }
};

const formatTimestamp = (timestamp) =>
  new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const Candidate = ({ user, onLogout }) => {
  const [socket, setSocket] = useState(null);
  const [device, setDevice] = useState(null);
  const [sendTransport, setSendTransport] = useState(null);
  const [producers, setProducers] = useState({
    screen: null,
    webcam: null,
    mic: null
  });
  const [permissions, setPermissions] = useState({
    mic: false,
    webcam: false,
    screen: false
  });
  const [streams, setStreams] = useState({
    screen: null,
    webcam: null,
    mic: null
  });
  const [currentStep, setCurrentStep] = useState('permissions'); // permissions, screen, ready
  const [alertEvents, setAlertEvents] = useState([]);

  const screenVideoRef = useRef(null);
  const webcamVideoRef = useRef(null);
  const socketInitializedRef = useRef(false);
  const sendTransportRef = useRef(null);
  const socketRef = useRef(null);
  const streamsStartedRef = useRef(false);
  const snapshotCanvasRef = useRef(null);
  const alertEventsRef = useRef([]);
  const playPromisesRef = useRef({
    webcam: null,
    screen: null,
  });
  const noiseRecorderRef = useRef(null);
  const noiseRecordingTimeoutRef = useRef(null);
  const noiseRecordingChunksRef = useRef([]);
  const lastNoiseCaptureRef = useRef(0);
  const previousNoiseDetectedRef = useRef(false);

  const faceStatus = useFaceDetection(webcamVideoRef, {
    dependencyKey: streams.webcam ? streams.webcam.id : null,
  });
  const previousFaceStatusRef = useRef(faceStatus);
  const { noiseLevel, noiseDetected, metrics: noiseMetrics } = useNoiseDetection(streams.mic);
  const mobileDetection = useMobileDetection(webcamVideoRef);
  const previousMobileDetectionRef = useRef(mobileDetection);

  const toDb = (value) => (value > 0 ? 20 * Math.log10(value) : Number.NEGATIVE_INFINITY);
  const noiseDbValue = noiseMetrics.db;
  const baselineDbValue = toDb(noiseMetrics.baseline);
  const dynamicThresholdDbValue = toDb(noiseMetrics.dynamicThreshold);
  const noiseDbDisplay = Number.isFinite(noiseDbValue) ? noiseDbValue.toFixed(1) : 'N/A';
  const baselineDbDisplay = Number.isFinite(baselineDbValue) ? baselineDbValue.toFixed(1) : 'N/A';
  const thresholdDbDisplay = Number.isFinite(dynamicThresholdDbValue) ? dynamicThresholdDbValue.toFixed(1) : 'N/A';
  const noiseRmsDisplay = Number.isFinite(noiseLevel) ? noiseLevel.toFixed(4) : 'N/A';
  const thresholdRmsDisplay = Number.isFinite(noiseMetrics.dynamicThreshold)
    ? noiseMetrics.dynamicThreshold.toFixed(4)
    : 'N/A';
  const audioIntensityRatio = noiseMetrics.dynamicThreshold > 0
    ? noiseLevel / noiseMetrics.dynamicThreshold
    : 0;
  const audioMeterPercent = Math.max(0, Math.min(1, audioIntensityRatio));
  const audioMeterWidth = `${Math.round(audioMeterPercent * 100)}%`;
  const audioRatioDisplay = Math.max(0, audioIntensityRatio).toFixed(2);
  const latestEventByType = useMemo(() => {
    const map = {};
    alertEvents.forEach((event) => {
      if (!map[event.type]) {
        map[event.type] = event;
      }
    });
    return map;
  }, [alertEvents]);
  const latestFaceMissing = latestEventByType.face_missing;
  const latestEyesClosed = latestEventByType.eyes_closed;
  const latestLookingAway = latestEventByType.looking_away;
  const latestMultipleFaces = latestEventByType.multiple_faces;
  const latestMobileDetected = latestEventByType.mobile_detected;
  const latestFaceMissingTime = latestFaceMissing ? formatTimestamp(latestFaceMissing.timestamp) : null;
  const latestEyesClosedTime = latestEyesClosed ? formatTimestamp(latestEyesClosed.timestamp) : null;
  const latestLookingAwayTime = latestLookingAway ? formatTimestamp(latestLookingAway.timestamp) : null;
  const latestMultipleFacesTime = latestMultipleFaces ? formatTimestamp(latestMultipleFaces.timestamp) : null;
  const latestMobileDetectedTime = latestMobileDetected ? formatTimestamp(latestMobileDetected.timestamp) : null;
  const mobileConfidenceDisplay = mobileDetection.score
    ? `${Math.round(mobileDetection.score * 100)}%`
    : '—';
  const faceBoundingBox = faceStatus.boundingBox;
  const faceKeypoints = faceStatus.keypoints;
  const gazeInfo = faceStatus.gaze;
  const mobileBoundingBox = mobileDetection.box;
  const gazeMagnitude = gazeInfo
    ? Math.min(1, Math.sqrt((gazeInfo.yaw ?? 0) ** 2 + (gazeInfo.pitch ?? 0) ** 2))
    : 0;
  const calibrationProgress = gazeInfo?.calibrationProgress ?? faceStatus.metrics?.calibrationProgress ?? 0;
  const calibrationDisplay = calibrationProgress >= 1
    ? 'Calibrated'
    : `${Math.min(100, Math.round(calibrationProgress * 100))}%`;
  const headTurnFlag = faceStatus.frequentHeadTurns;
  const headTurnCount = faceStatus.metrics?.headTurnCount ?? 0;
  const headTurnRate = faceStatus.metrics?.headTurnRate ?? 0;
  const recentHeadTurnMs = faceStatus.metrics?.recentHeadTurnMs ?? null;
  const recentHeadTurnDisplay = recentHeadTurnMs != null
    ? `${Math.max(0, Math.round(recentHeadTurnMs / 1000))}s ago`
    : '—';
  const faceIdentityReady = faceStatus.referenceFaceReady;
  const faceIdentityMatched = faceStatus.referenceMatched;
  const faceIdentityScore = faceStatus.referenceMatchScore;
  const faceIdentityError = faceStatus.referenceFaceError;
  const faceIdentityScoreDisplay = faceIdentityScore != null
    ? `${Math.round(faceIdentityScore * 100)}%`
    : '—';
  const faceIdentityState = useMemo(() => {
    if (!faceIdentityReady) {
      return faceIdentityError ? 'error' : 'loading';
    }
    if (!faceStatus.facePresent) {
      return 'awaiting_face';
    }
    if (faceIdentityMatched === null) {
      return 'pending';
    }
    return faceIdentityMatched ? 'matched' : 'mismatch';
  }, [faceIdentityReady, faceIdentityError, faceStatus.facePresent, faceIdentityMatched]);
  const faceIdentityLabel = useMemo(() => {
    switch (faceIdentityState) {
      case 'matched':
        return 'Reference face matched';
      case 'mismatch':
        return 'Reference face mismatch';
      case 'pending':
        return 'Matching reference face…';
      case 'awaiting_face':
        return 'Awaiting live face for match';
      case 'error':
        return 'Reference image unavailable';
      case 'loading':
      default:
        return 'Loading reference face…';
    }
  }, [faceIdentityState]);
  const faceIdentityHint = useMemo(() => {
    switch (faceIdentityState) {
      case 'matched':
        return `Similarity score: ${faceIdentityScoreDisplay}.`;
      case 'mismatch':
        return `Similarity score: ${faceIdentityScoreDisplay}. Please align yourself with the reference photo.`;
      case 'pending':
        return 'Capturing additional measurements to confirm identity.';
      case 'awaiting_face':
        return 'Ensure your face is visible so we can confirm identity.';
      case 'error':
        return faceIdentityError;
      case 'loading':
      default:
        return 'Fetching and preparing your reference photo for matching.';
    }
  }, [faceIdentityState, faceIdentityScoreDisplay, faceIdentityError]);
  const faceIdentityIndicatorClass =
    faceIdentityState === 'matched' ? 'active' : 'inactive';
  const faceIdentityValueClass =
    faceIdentityState === 'mismatch' || faceIdentityState === 'error' ? 'alert' : '';

  const releaseEventResources = useCallback((event) => {
    if (event?.imageUrl && (event.isBlob || event.imageUrl.startsWith('blob:'))) {
      URL.revokeObjectURL(event.imageUrl);
    }
  }, []);

  const addAlertEvent = useCallback(
    (event) => {
      setAlertEvents((previous) => {
        const next = [event, ...previous];
        if (next.length > MAX_ALERT_EVENTS) {
          const removed = next.pop();
          releaseEventResources(removed);
        }
        return next;
      });
    },
    [releaseEventResources]
  );

  const uploadFaceEvidence = useCallback(
    async ({ blob, type, timestamp, meta }) => {
      if (!config.serverUrl) {
        console.warn('[Snapshot] Server URL not configured, skipping face evidence upload');
        return;
      }
      try {
        const base64Data = await blobToBase64(blob);
        if (!base64Data) {
          throw new Error('Failed to encode face evidence');
        }

        const response = await fetch(`${config.serverUrl}/api/face-events`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            userId: user.userId,
            examRoomId: user.examRoomId,
            type,
            timestamp,
            meta,
            mimeType: blob.type || 'image/webp',
            data: base64Data,
          }),
        });

        if (!response.ok) {
          throw new Error(`Face evidence upload failed with status ${response.status}`);
        }
      } catch (error) {
        console.error('[Snapshot] Face evidence upload failed', error);
      }
    },
    [user.examRoomId, user.userId]
  );

  const uploadNoiseEvidence = useCallback(
    async ({ blob, timestamp, metrics }) => {
      if (!config.serverUrl) {
        console.warn('[NoiseDetection] Server URL not configured, skipping noise evidence upload');
        return;
      }
      try {
        const base64Data = await blobToBase64(blob);
        if (!base64Data) {
          throw new Error('Failed to encode audio evidence');
        }

        const response = await fetch(`${config.serverUrl}/api/noise-events`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            userId: user.userId,
            examRoomId: user.examRoomId,
            timestamp,
            meta: metrics,
            mimeType: blob.type || 'audio/webm',
            data: base64Data,
          }),
        });

        if (!response.ok) {
          throw new Error(`Noise evidence upload failed with status ${response.status}`);
        }
      } catch (error) {
        console.error('[NoiseDetection] Noise evidence upload failed', error);
      }
    },
    [user.examRoomId, user.userId]
  );

  const stopNoiseRecording = useCallback(() => {
    if (noiseRecordingTimeoutRef.current) {
      clearTimeout(noiseRecordingTimeoutRef.current);
      noiseRecordingTimeoutRef.current = null;
    }
    if (noiseRecorderRef.current && noiseRecorderRef.current.state === 'recording') {
      try {
        noiseRecorderRef.current.stop();
      } catch (error) {
        console.warn('[NoiseDetection] Failed to stop MediaRecorder', error);
      }
    }
  }, []);

  const startNoiseRecording = useCallback(
    (metricsSnapshot) => {
      if (!streams.mic) {
        console.warn('[NoiseDetection] Cannot record evidence, microphone stream unavailable');
        return;
      }
      if (noiseRecorderRef.current) {
        return;
      }
      if (typeof MediaRecorder === 'undefined') {
        console.warn('[NoiseDetection] MediaRecorder API not supported in this browser');
        return;
      }

      const metricsPayload = metricsSnapshot
        ? JSON.parse(JSON.stringify(metricsSnapshot))
        : undefined;

      try {
        const recorder = new MediaRecorder(streams.mic, {
          mimeType: 'audio/webm;codecs=opus',
        });
        const chunks = [];
        noiseRecordingChunksRef.current = chunks;

        recorder.addEventListener('dataavailable', (event) => {
          if (event.data && event.data.size > 0) {
            chunks.push(event.data);
          }
        });

        recorder.addEventListener('stop', () => {
          noiseRecorderRef.current = null;
          const recordedChunks = noiseRecordingChunksRef.current;
          noiseRecordingChunksRef.current = [];

          if (!recordedChunks.length) {
            return;
          }

          const mimeType = recordedChunks[0]?.type || 'audio/webm';
          const blob = new Blob(recordedChunks, { type: mimeType });

          uploadNoiseEvidence({
            blob,
            timestamp: Date.now(),
            metrics: metricsPayload,
          }).catch((error) => {
            console.error('[NoiseDetection] Noise evidence upload rejected', error);
          });
        });

        recorder.start();
        noiseRecorderRef.current = recorder;
        noiseRecordingTimeoutRef.current = setTimeout(() => {
          noiseRecordingTimeoutRef.current = null;
          stopNoiseRecording();
        }, NOISE_RECORDING_DURATION_MS);
      } catch (error) {
        noiseRecorderRef.current = null;
        noiseRecordingChunksRef.current = [];
        console.error('[NoiseDetection] Unable to start MediaRecorder', error);
      }
    },
    [streams.mic, stopNoiseRecording, uploadNoiseEvidence]
  );

  const captureAnomalySnapshot = useCallback(
    async (type, meta = {}) => {
      const video = webcamVideoRef.current;

      if (!video) {
        console.warn('[Snapshot] Webcam video element is not available.');
        return;
      }

      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        console.warn('[Snapshot] Skipping capture, video not ready.', {
          readyState: video.readyState,
          type,
        });
        return;
      }

      const canvas = snapshotCanvasRef.current ?? document.createElement('canvas');
      snapshotCanvasRef.current = canvas;

      const width = video.videoWidth || video.clientWidth || 640;
      const height = video.videoHeight || video.clientHeight || 480;

      if (!width || !height) {
        console.warn('[Snapshot] Unable to capture frame, missing dimensions.', { width, height });
        return;
      }

      canvas.width = width;
      canvas.height = height;

      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) {
        console.warn('[Snapshot] Unable to obtain canvas context.');
        return;
      }

      context.drawImage(video, 0, 0, width, height);

      const blob = await new Promise((resolve) => {
        canvas.toBlob(resolve, 'image/webp', 0.85);
      });

      let imageUrl;
      if (blob) {
        imageUrl = URL.createObjectURL(blob);
      } else {
        imageUrl = canvas.toDataURL('image/jpeg', 0.85);
      }

      const eventRecord = {
        id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        type,
        timestamp: Date.now(),
        imageUrl,
        isBlob: imageUrl.startsWith('blob:'),
        meta,
      };

      console.log('[Snapshot] Captured anomaly', {
        type,
        meta,
        width,
        height,
        url: eventRecord.imageUrl,
      });

      addAlertEvent(eventRecord);

      if (blob && FACE_EVIDENCE_TYPES.has(type)) {
        uploadFaceEvidence({
          blob,
          type,
          timestamp: eventRecord.timestamp,
          meta,
        }).catch((error) => {
          console.error('[Snapshot] Face evidence upload rejected', error);
        });
      }
    },
    [addAlertEvent, uploadFaceEvidence]
  );

  const attachStreamToVideo = useCallback((videoElement, stream, label) => {
    if (!videoElement) {
      return;
    }

    if (!stream) {
      if (videoElement.srcObject) {
        try {
          videoElement.pause();
        } catch (error) {
          console.warn(`[Video] Unable to pause ${label} video`, error);
        }
        videoElement.srcObject = null;
        console.log(`[Video] Cleared ${label} stream`);
      }
      return;
    }

    if (videoElement.srcObject !== stream) {
      videoElement.srcObject = stream;
      console.log(`[Video] Attached ${label} stream`, {
        tracks: stream.getTracks().map((track) => ({
          id: track.id,
          kind: track.kind,
          label: track.label,
          enabled: track.enabled,
          muted: track.muted,
        })),
      });
    }

    const attemptPlay = () => {
      if (!videoElement.paused && !videoElement.ended) {
        return;
      }

      const playPromise = videoElement.play();

      if (playPromise && typeof playPromise.then === 'function') {
        playPromisesRef.current[label] = playPromise.catch((error) => {
          if (error?.name !== 'AbortError') {
            console.warn(`[Video] Failed to play ${label} stream`, error);
          }
        });
      }
    };

    if (videoElement.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) {
      attemptPlay();
    } else {
      videoElement.addEventListener('loadeddata', attemptPlay, { once: true });
    }
  }, []);

  useEffect(() => {
    alertEventsRef.current = alertEvents;
  }, [alertEvents]);

  useEffect(() => () => {
    alertEventsRef.current.forEach((event) => releaseEventResources(event));
  }, [releaseEventResources]);

  useEffect(() => {
    attachStreamToVideo(webcamVideoRef.current, streams.webcam, 'webcam');
  }, [attachStreamToVideo, streams.webcam, currentStep]);

  useEffect(() => {
    attachStreamToVideo(screenVideoRef.current, streams.screen, 'screen');
  }, [attachStreamToVideo, streams.screen, currentStep]);
  // Debug streams state changes
  useEffect(() => {
    console.log('Streams state changed:', {
      screen: streams.screen ? { id: streams.screen.id, tracks: streams.screen.getTracks().length } : null,
      webcam: streams.webcam ? { id: streams.webcam.id, tracks: streams.webcam.getTracks().length } : null,
      mic: streams.mic ? { id: streams.mic.id, tracks: streams.mic.getTracks().length } : null
    });
  }, [streams]);
  const [connectionStatus, setConnectionStatus] = useState('disconnected');

  useEffect(() => {
    // Check if socket already exists and is connected
    if (socketRef.current && socketRef.current.connected) {
      console.log('Socket already exists and connected, skipping initialization');
      setSocket(socketRef.current);
      return;
    }
    
    // Check if we're already in the process of initializing
    if (socketInitializedRef.current) {
      console.log('Socket initialization already in progress, skipping...');
      return;
    }
    
    console.log('Candidate component mounted, initializing socket...');
    socketInitializedRef.current = true;
    
    console.log('Initializing socket with user:', user);
    console.log('Connecting to server URL:', config.serverUrl);
    try {
      const newSocket = io(config.serverUrl, {
        auth: {
          token: user.token
        },
        forceNew: true, // Force new connection
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: 5
      });

      // Store socket in ref immediately for cleanup and checks
      socketRef.current = newSocket;
      console.log('Socket.IO instance created, waiting for connection...');
      
      newSocket.on('connect', () => {
        console.log('Connected to server with socket ID:', newSocket.id);
        setSocket(newSocket);
        setConnectionStatus('connected');
        
        // Join room immediately after connection
        console.log('Socket connected, joining room...');
        newSocket.emit('join-room', {
          roomId: user.examRoomId,
          role: 'student'
        });
        console.log('Join room event emitted for room:', user.examRoomId);
      });
      
      // Log connection attempts
      newSocket.on('connect_attempt', () => {
        console.log('Attempting to connect to server...');
      });

      newSocket.on('disconnect', () => {
        console.log('Disconnected from server');
        setConnectionStatus('disconnected');
      });

      newSocket.on('router-rtp-capabilities', async (rtpCapabilities) => {
        console.log('Received router RTP capabilities from server');
        console.log('RTP Capabilities:', {
          codecs: rtpCapabilities.codecs?.length,
          headerExtensions: rtpCapabilities.headerExtensions?.length
        });
        await initializeMediasoup(rtpCapabilities);
      });

      newSocket.on('existing-producers', (producers) => {
        console.log('Received existing producers:', producers);
        console.log('Producer count:', producers.length);
      });

      newSocket.on('connect_error', (error) => {
        console.error('Connection error:', error.message || error);
        console.error('Connection error details:', {
          message: error.message,
          type: error.type,
          description: error.description
        });
        setConnectionStatus('disconnected');
      });

      // Set socket in state immediately (even if not connected yet)
      setSocket(newSocket);
    } catch (error) {
      console.error('Failed to initialize socket:', error);
      socketInitializedRef.current = false; // Reset on error to allow retry
      setConnectionStatus('disconnected');
    }
    
    // Cleanup function
    return () => {
      console.log('Cleaning up socket connection...');
      // Use ref for reliable cleanup
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
        console.log('Socket disconnected');
      }
      // Clean up transport ref
      if (sendTransportRef.current) {
        sendTransportRef.current.close();
        sendTransportRef.current = null;
      }
      // Reset streams started flag
      streamsStartedRef.current = false;
      socketInitializedRef.current = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  // Socket initialization is now handled in the useEffect above

  const initializeMediasoup = async (rtpCapabilities) => {
    try {
      console.log('Initializing MediaSoup device...');
      const newDevice = new mediasoupClient.Device();
      console.log('MediaSoup device created');
      
      await newDevice.load({ routerRtpCapabilities: rtpCapabilities });
      console.log('MediaSoup device loaded successfully');
      
      setDevice(newDevice);
      console.log('MediaSoup device initialized and set in state');
      
      // Room is already joined when socket connected, no need to join again
    } catch (error) {
      console.error('Failed to initialize mediasoup device:', error);
      console.error('Error details:', {
        message: error.message,
        stack: error.stack
      });
    }
  };

  const requestPermissions = async () => {
    console.log('Requesting microphone and camera permissions...');
    
    try {
      // Request microphone permission
      console.log('Requesting microphone access...');
      const micStream = await navigator.mediaDevices.getUserMedia({ 
        audio: true, 
        video: false 
      });
      console.log('Microphone access granted');
      console.log('Mic stream tracks:', micStream.getTracks().map(t => ({ kind: t.kind, enabled: t.enabled, readyState: t.readyState })));
      setStreams(prev => {
        console.log('Setting mic stream in state:', { streamId: micStream.id, tracks: micStream.getTracks().length });
        return { ...prev, mic: micStream };
      });
      setPermissions(prev => ({ ...prev, mic: true }));
      
      // Request webcam permission
      console.log('Requesting webcam access...');
      const webcamStream = await navigator.mediaDevices.getUserMedia({ 
        audio: false, 
        video: true 
      });
      console.log('Webcam access granted');
      console.log('Webcam stream tracks:', webcamStream.getTracks().map(t => ({ kind: t.kind, enabled: t.enabled, readyState: t.readyState })));
      setStreams(prev => {
        console.log('Setting webcam stream in state:', { streamId: webcamStream.id, tracks: webcamStream.getTracks().length });
        return { ...prev, webcam: webcamStream };
      });
      setPermissions(prev => ({ ...prev, webcam: true }));
      console.log('Webcam stream stored in state');
      
      // Webcam preview will be set by useEffect
      
      setCurrentStep('screen');
    } catch (error) {
      console.error('Permission request failed:', error);
      alert('Permission denied. Please allow microphone and camera access.');
    }
  };

  const requestScreenShare = async () => {
    console.log('Requesting screen share access...');
    
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false
      });
      
      console.log('Screen share access granted');
      console.log('Screen stream tracks:', screenStream.getTracks().map(t => ({ kind: t.kind, enabled: t.enabled, readyState: t.readyState })));
      setStreams(prev => {
        console.log('Setting screen stream in state:', { streamId: screenStream.id, tracks: screenStream.getTracks().length });
        return { ...prev, screen: screenStream };
      });
      setPermissions(prev => ({ ...prev, screen: true }));
      
      // Screen preview will be set by useEffect
      
      setCurrentStep('ready');
      console.log('All permissions granted, starting streams...');
      console.log('Current streams state:', { 
        webcam: !!streams.webcam, 
        screen: !!streams.screen, 
        mic: !!streams.mic 
      });
      // Don't join room again, just start producing streams
    } catch (error) {
      console.error('Screen share request failed:', error);
      alert('Screen sharing was denied or cancelled.');
    }
  };

  // joinRoom function removed - room is joined immediately on socket connect

  const createSendTransport = async () => {
    if (!socket || !device) {
      console.error('Cannot create transport:', { socket: !!socket, device: !!device });
      return;
    }

    console.log('Creating send transport...');
    return new Promise((resolve, reject) => {
      socket.emit('create-transport', { direction: 'send' }, async (data) => {
        try {
          console.log('Received transport data from server:', data);
          const transport = device.createSendTransport(data);
          console.log('Send transport created with ID:', transport.id);
          
          transport.on('connect', ({ dtlsParameters }, callback) => {
            console.log('Transport connect event triggered, dtlsParameters:', dtlsParameters);
            socket.emit('connect-transport', {
              transportId: transport.id,
              dtlsParameters
            }, (response) => {
              console.log('Transport connect response:', response);
              callback();
            });
          });

          transport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
            try {
              console.log('Transport produce event triggered:', {
                kind,
                appData,
                rtpParameters: {
                  codecs: rtpParameters.codecs?.length,
                  headerExtensions: rtpParameters.headerExtensions?.length,
                  encodings: rtpParameters.encodings?.length
                }
              });
              
              socket.emit('produce', {
                transportId: transport.id,
                kind,
                rtpParameters,
                appData
              }, ({ id, error }) => {
                if (error) {
                  console.error('Produce error from server:', error);
                  if (errback) {
                    errback(new Error(error));
                  }
                } else {
                  console.log('Producer created successfully with ID:', id);
                  callback({ id });
                }
              });
            } catch (error) {
              console.error('Error in transport produce handler:', error);
              if (errback) {
                errback(error);
              }
            }
          });

          transport.on('connecterror', (error) => {
            console.error('Transport connect error:', error);
          });

          resolve(transport);
        } catch (error) {
          console.error('Error creating send transport:', error);
          reject(error);
        }
      });
    });
  };

  const startProducing = async (stream, kind, type, transport = null) => {
    const currentTransport = transport || sendTransportRef.current || sendTransport;
    if (!device || !currentTransport) {
      console.error(`Cannot produce ${type} stream:`, { device: !!device, sendTransport: !!currentTransport });
      return;
    }

    console.log(`Starting to produce ${type} stream (${kind})`);
    
    try {
      console.log(`Stream details for ${type}:`, {
        streamId: stream.id,
        active: stream.active,
        tracks: stream.getTracks().length
      });

      const track = stream.getTracks().find(t => t.kind === kind);
      if (!track) {
        console.error(`No ${kind} track found in stream`);
        console.log(`Available tracks:`, stream.getTracks().map(t => t.kind));
        return;
      }

      console.log(`Found ${kind} track, creating producer...`);
      console.log(`Track details for ${type}:`, {
        kind: track.kind,
        enabled: track.enabled,
        readyState: track.readyState,
        muted: track.muted,
        label: track.label,
        id: track.id
      });

      // Ensure the track is enabled before producing
      if (!track.enabled) {
        console.log(`Enabling track for ${type}...`);
        track.enabled = true;
      }

      console.log(`Creating producer for ${type} with appData:`, { type, source: type });
      
      const producer = await currentTransport.produce({
        track,
        appData: { type, source: type }
      });

      console.log(`Producer created successfully for ${type}:`, {
        producerId: producer.id,
        kind: producer.kind,
        paused: producer.paused,
        closed: producer.closed
      });

      setProducers(prev => ({
        ...prev,
        [type]: producer
      }));

      console.log(`Successfully started producing ${type} stream with producer ID: ${producer.id}`);
      
      // Add producer event listeners for debugging
      producer.on('trackended', () => {
        console.log(`Track ended for ${type} producer`);
      });
      
      producer.on('transportclose', () => {
        console.log(`Transport closed for ${type} producer`);
      });

      producer.on('@close', () => {
        console.log(`Producer closed for ${type}`);
      });
      
    } catch (error) {
      console.error(`Failed to produce ${type} stream:`, error);
      console.error(`Error details:`, {
        message: error.message,
        stack: error.stack,
        type,
        kind
      });
    }
  };

  const startAllStreams = async (transport = null) => {
    console.log('Starting all streams...');
    
    // Use provided transport or ref, fallback to state
    const currentTransport = transport || sendTransportRef.current || sendTransport;
    
    if (!currentTransport) {
      console.error('No send transport available, waiting for transport to be created...');
      // Wait a bit and try again
      setTimeout(() => {
        const retryTransport = sendTransportRef.current || sendTransport;
        if (retryTransport) {
          console.log('Retrying startAllStreams...');
          startAllStreams(retryTransport);
        } else {
          console.error('Send transport still not available after timeout');
        }
      }, 500);
      return;
    }

    console.log('Current streams state:', {
      screen: !!streams.screen,
      webcam: !!streams.webcam,
      mic: !!streams.mic,
      sendTransport: !!currentTransport
    });

    // Start screen share
    if (streams.screen) {
      console.log('Starting screen share production...');
      await startProducing(streams.screen, 'video', 'screen', currentTransport);
    } else {
      console.log('No screen stream available');
    }

    // Start webcam
    if (streams.webcam) {
      console.log('Starting webcam production...');
      await startProducing(streams.webcam, 'video', 'webcam', currentTransport);
    } else {
      console.log('No webcam stream available');
    }

    // Start microphone
    if (streams.mic) {
      console.log('Starting microphone production...');
      await startProducing(streams.mic, 'audio', 'mic', currentTransport);
    } else {
      console.log('No microphone stream available');
    }

    console.log('All streams production attempted');
    
    // Log final state
    setTimeout(() => {
      console.log('Final State Summary:', {
        device: !!device,
        socket: !!socket,
        sendTransport: !!sendTransport,
        producers: {
          screen: !!producers.screen,
          webcam: !!producers.webcam,
          mic: !!producers.mic
        },
        streams: {
          screen: !!streams.screen,
          webcam: !!streams.webcam,
          mic: !!streams.mic
        }
      });
    }, 2000);
  };

  useEffect(() => {
    console.log('useEffect triggered for stream creation:', {
      currentStep,
      device: !!device,
      socket: !!socket,
      streams: {
        webcam: !!streams.webcam,
        screen: !!streams.screen,
        mic: !!streams.mic
      }
    });

    if (currentStep === 'ready' && device && socket && !sendTransportRef.current && !streamsStartedRef.current) {
      console.log('Ready to start streams, creating transport...');
      console.log('Current streams available:', { 
        webcam: !!streams.webcam, 
        screen: !!streams.screen, 
        mic: !!streams.mic 
      });
      streamsStartedRef.current = true; // Mark as started to prevent duplicate calls
      createSendTransport().then(transport => {
        console.log('🚀 Transport created, setting sendTransport and starting streams...');
        // Store in both ref and state
        sendTransportRef.current = transport;
        setSendTransport(transport);
        // Start streams immediately with the transport object
        startAllStreams(transport);
      }).catch(error => {
        console.error('Failed to create transport:', error);
        streamsStartedRef.current = false; // Reset on error to allow retry
      });
    } else if (currentStep === 'ready' && device && socket && sendTransportRef.current && !streamsStartedRef.current) {
      // If transport exists but streams haven't started, start them
      console.log('Transport exists but streams not started, starting streams...');
      streamsStartedRef.current = true;
      startAllStreams(sendTransportRef.current);
    } else {
      console.log('Not ready to start streams:', { 
        currentStep, 
        device: !!device, 
        socket: !!socket,
        transport: !!sendTransportRef.current,
        streamsStarted: streamsStartedRef.current
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep, device, socket, streams.webcam, streams.screen, streams.mic]);

  // Debug: Log when currentStep changes
  useEffect(() => {
    console.log('Current step changed to:', currentStep);
    console.log('Streams state:', { 
      webcam: !!streams.webcam, 
      screen: !!streams.screen, 
      mic: !!streams.mic 
    });
  }, [currentStep, streams]);

  useEffect(() => {
    if (!streams.webcam) {
      previousFaceStatusRef.current = faceStatus;
      return;
    }

    const previousStatus = previousFaceStatusRef.current || {};
    const anomalies = [];

    if (previousStatus.facePresent && !faceStatus.facePresent) {
      anomalies.push({ type: 'face_missing' });
    }

    if (!previousStatus.eyesClosed && faceStatus.eyesClosed) {
      anomalies.push({ type: 'eyes_closed' });
    }

    if (!previousStatus.lookingAway && faceStatus.lookingAway) {
      anomalies.push({
        type: 'looking_away',
        meta: { currentStep },
      });
    }

    if (!previousStatus.multipleFaces && faceStatus.multipleFaces) {
      anomalies.push({
        type: 'multiple_faces',
        meta: { facesDetected: faceStatus.facesDetected },
      });
    }

    anomalies.forEach(({ type, meta }) => {
      captureAnomalySnapshot(type, meta).catch((error) => {
        console.error('[Snapshot] Capture error', { type, error });
      });
    });

    previousFaceStatusRef.current = faceStatus;
  }, [captureAnomalySnapshot, currentStep, faceStatus, streams.webcam]);

  useEffect(() => {
    if (!streams.webcam) {
      previousMobileDetectionRef.current = mobileDetection;
      return;
    }

    if (!previousMobileDetectionRef.current?.detected && mobileDetection.detected) {
      captureAnomalySnapshot('mobile_detected', {
        label: mobileDetection.label,
        score: mobileDetection.score,
      }).catch((error) => {
        console.error('[Snapshot] Capture error (mobile)', error);
      });
    }

    previousMobileDetectionRef.current = mobileDetection;
  }, [captureAnomalySnapshot, mobileDetection, streams.webcam]);

  useEffect(() => {
    if (!streams.mic) {
      stopNoiseRecording();
      previousNoiseDetectedRef.current = false;
      return;
    }

    if (!previousNoiseDetectedRef.current && noiseDetected) {
      const now = Date.now();
      if (now - lastNoiseCaptureRef.current >= NOISE_CAPTURE_COOLDOWN_MS) {
        lastNoiseCaptureRef.current = now;
        startNoiseRecording(noiseMetrics);
      }
    }

    previousNoiseDetectedRef.current = noiseDetected;
  }, [noiseDetected, noiseMetrics, startNoiseRecording, stopNoiseRecording, streams.mic]);

  useEffect(
    () => () => {
      stopNoiseRecording();
    },
    [stopNoiseRecording]
  );

  const handleLogout = () => {
    // Clean up streams
    Object.values(streams).forEach(stream => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
    });

    // Clean up producers
    Object.values(producers).forEach(producer => {
      if (producer) {
        producer.close();
      }
    });

    alertEventsRef.current.forEach(releaseEventResources);
    alertEventsRef.current = [];
    setAlertEvents([]);

    // Clean up transport
    if (sendTransportRef.current) {
      sendTransportRef.current.close();
      sendTransportRef.current = null;
    }

    // Clean up socket
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    onLogout();
  };

  return (
    <div className="candidate-container">
      <div className="candidate-header">
        <h1 className="candidate-title">Student Dashboard</h1>
        <div className="connection-status">
          <span className={`status-indicator ${connectionStatus === 'connected' ? 'active' : 'inactive'}`}></span>
          <span className={`status-text ${connectionStatus}`}>
            {connectionStatus === 'connected' ? 'Connected' : 'Disconnected'}
          </span>
        </div>
        <button className="logout-button" onClick={handleLogout}>
          Logout
        </button>
      </div>

      {currentStep === 'permissions' && (
        <div className="permission-section">
          <h2 className="permission-title">Permission Setup</h2>
          <p className="permission-description">
            We need access to your microphone and camera to monitor your exam session.
            Please click the button below to grant permissions.
          </p>
          <button
            className="permission-button"
            onClick={requestPermissions}
          >
            Grant Permissions
          </button>
        </div>
      )}

      {currentStep === 'screen' && (
        <div className="permission-section">
          <h2 className="permission-title">Screen Sharing</h2>
          <p className="permission-description">
            Please select the screen or application window you want to share for monitoring.
          </p>
          <button
            className="permission-button"
            onClick={requestScreenShare}
          >
            Share Screen
          </button>
        </div>
      )}

      {currentStep === 'ready' && (
        <div className="permission-section">
          <h2 className="permission-title">Ready to Start</h2>
          <p className="permission-description">
            All permissions granted! Your streams are now being monitored.
            You can see your previews below.
          </p>
          
          
          <div className="preview-container">
            <div className="preview-video">
              <div className="preview-video-inner">
                <video
                  ref={screenVideoRef}
                  autoPlay
                  muted
                  playsInline
                  controls={false}
                  style={{ 
                    width: '100%', 
                    height: '300px', 
                    backgroundColor: '#000',
                    objectFit: 'cover'
                  }}
                />
              </div>
              <div className="video-label">
                <span className={`status-indicator ${permissions.screen ? 'active' : 'inactive'}`}></span>
                Screen Share
              </div>
            </div>
            
            <div className="preview-video">
              <div className="preview-video-inner">
                <video
                  ref={webcamVideoRef}
                  autoPlay
                  muted
                  playsInline
                  controls={false}
                  style={{ 
                    width: '100%', 
                    height: '300px', 
                    backgroundColor: '#000',
                    objectFit: 'cover'
                  }}
                />
                <div className="detection-overlay">
                  {faceBoundingBox && (
                    <div
                      className={`overlay-box face ${
                        !gazeInfo?.calibrated
                          ? 'calibrating'
                          : faceStatus.lookingAway
                            ? 'alert'
                            : ''
                      } ${faceStatus.eyesClosed ? 'drowsy' : ''}`}
                      style={{
                        left: `${faceBoundingBox.x * 100}%`,
                        top: `${faceBoundingBox.y * 100}%`,
                        width: `${faceBoundingBox.width * 100}%`,
                        height: `${faceBoundingBox.height * 100}%`,
                      }}
                    >
                      <span className="overlay-chip">
                        {!gazeInfo?.calibrated
                          ? 'Calibrating gaze…'
                          : faceStatus.lookingAway
                            ? 'Gaze Off-Screen'
                            : 'Face Tracking'}
                      </span>
                    </div>
                  )}

                  {mobileDetection.detected && mobileBoundingBox && (
                    <div
                      className={`overlay-box mobile ${mobileDetection.detected ? 'alert' : ''}`}
                      style={{
                        left: `${mobileBoundingBox.x * 100}%`,
                        top: `${mobileBoundingBox.y * 100}%`,
                        width: `${mobileBoundingBox.width * 100}%`,
                        height: `${mobileBoundingBox.height * 100}%`,
                      }}
                    >
                      <span className="overlay-chip">
                        Mobile {mobileConfidenceDisplay}
                      </span>
                    </div>
                  )}

                  {(gazeInfo && (faceKeypoints?.eyeMidpoint || faceBoundingBox)) && (
                    <svg className="gaze-overlay" viewBox="0 0 1000 1000" preserveAspectRatio="none">
                      {(() => {
                        const baseX = ((faceKeypoints?.eyeMidpoint?.x ?? (faceBoundingBox
                          ? faceBoundingBox.x + faceBoundingBox.width / 2
                          : 0.5)) * 1000);
                        const baseY = ((faceKeypoints?.eyeMidpoint?.y ?? (faceBoundingBox
                          ? faceBoundingBox.y + faceBoundingBox.height / 3
                          : 0.4)) * 1000);
                        const targetX = baseX - (gazeInfo.yaw ?? 0) * 260;
                        const targetY = baseY + (gazeInfo.pitch ?? 0) * 260;
                        const clampedTargetX = Math.max(0, Math.min(1000, targetX));
                        const clampedTargetY = Math.max(0, Math.min(1000, targetY));
                        const arrowColor = !gazeInfo.calibrated
                          ? 'var(--gray-400)'
                          : faceStatus.lookingAway
                            ? 'var(--error-color)'
                            : gazeMagnitude > 0.15
                              ? 'var(--warning-color)'
                              : 'var(--success-color)';

                        return (
                          <>
                            <defs>
                              <marker
                                id="gaze-arrow-head"
                                markerWidth="12"
                                markerHeight="12"
                                refX="6"
                                refY="6"
                                orient="auto"
                              >
                                <polygon points="0 0, 12 6, 0 12" fill={arrowColor} />
                              </marker>
                            </defs>
                            <line
                              x1={baseX}
                              y1={baseY}
                              x2={clampedTargetX}
                              y2={clampedTargetY}
                              stroke={arrowColor}
                              strokeWidth="18"
                              strokeLinecap="round"
                              markerEnd="url(#gaze-arrow-head)"
                              className={`gaze-line ${faceStatus.lookingAway ? 'alert' : ''}`}
                            />
                            <circle
                              cx={baseX}
                              cy={baseY}
                              r="26"
                              fill="rgba(17, 24, 39, 0.9)"
                              stroke={arrowColor}
                              strokeWidth="10"
                            />
                          </>
                        );
                      })()}
                    </svg>
                  )}
                </div>
              </div>
              <div className="video-label">
                <span className={`status-indicator ${permissions.webcam ? 'active' : 'inactive'}`}></span>
                Webcam
              </div>
            </div>
          </div>

          <div className="monitoring-status">
            <h3 className="monitoring-title">Live Proctoring Alerts</h3>
            <div className="monitoring-grid">
              <div className="monitoring-card">
                <h4>Face Presence</h4>
                <div className="monitoring-value">
                  <span className={`status-indicator ${faceStatus.facePresent ? 'active' : 'inactive'}`} />
                  {faceStatus.facePresent ? 'Face found' : 'Face not found'}
                </div>
                <p className="monitoring-hint">
                  {faceStatus.facePresent
                    ? latestFaceMissingTime
                      ? `Last absence logged at ${latestFaceMissingTime}.`
                      : `Faces detected: ${faceStatus.facesDetected}`
                    : 'Align yourself with the webcam so your face stays visible.'}
                </p>
              </div>

              <div className="monitoring-card">
                <h4>Identity Match</h4>
                <div className={`monitoring-value ${faceIdentityValueClass}`}>
                  <span className={`status-indicator ${faceIdentityIndicatorClass}`} />
                  {faceIdentityLabel}
                </div>
                <p className="monitoring-hint">{faceIdentityHint}</p>
              </div>

              <div className="monitoring-card">
                <h4>Eye Activity</h4>
                <div className={`monitoring-value ${faceStatus.eyesClosed ? 'alert' : ''}`}>
                  <span className={`status-indicator ${!faceStatus.eyesClosed ? 'active' : 'inactive'}`} />
                  {faceStatus.eyesClosed ? 'Eyes closed detected' : 'Eyes open'}
                </div>
                <p className="monitoring-hint">
                  {faceStatus.eyesClosed
                    ? 'Please keep your eyes on the screen during the exam.'
                    : latestEyesClosedTime
                      ? `Last eyes-closed capture at ${latestEyesClosedTime}.`
                      : 'We are tracking eye activity for attentiveness.'}
                </p>
              </div>

              <div className="monitoring-card">
                <h4>Gaze Direction</h4>
                <div className={`monitoring-value ${faceStatus.lookingAway ? 'alert' : ''}`}>
                  <span className={`status-indicator ${!faceStatus.lookingAway ? 'active' : 'inactive'}`} />
                  {faceStatus.lookingAway ? 'Looking away detected' : 'On-screen focus'}
                </div>
                <p className="monitoring-hint">
                  {!gazeInfo?.calibrated
                    ? `Hold steady while we calibrate your gaze (${calibrationDisplay}).`
                    : faceStatus.lookingAway
                    ? 'Please keep your attention on the exam window.'
                    : latestLookingAwayTime
                      ? `Last gaze alert at ${latestLookingAwayTime}.`
                      : 'Maintaining attention on the exam content.'}
                </p>
              </div>

              <div className="monitoring-card">
                <h4>Head Movement</h4>
                <div className={`monitoring-value ${headTurnFlag ? 'alert' : ''}`}>
                  <span className={`status-indicator ${!headTurnFlag ? 'active' : 'inactive'}`} />
                  {headTurnFlag ? 'Frequent head turns detected' : 'Head movement normal'}
                </div>
                <p className="monitoring-hint">
                  Turns this window: {headTurnCount} • Rate: {headTurnRate.toFixed(1)} / min • Last turn: {recentHeadTurnDisplay}
                </p>
              </div>

              <div className="monitoring-card">
                <h4>Multiple Faces</h4>
                <div className={`monitoring-value ${faceStatus.multipleFaces ? 'alert' : ''}`}>
                  <span className={`status-indicator ${!faceStatus.multipleFaces ? 'active' : 'inactive'}`} />
                  {faceStatus.multipleFaces ? 'Multiple faces detected' : 'Single participant'}
                </div>
                <p className="monitoring-hint">
                  {faceStatus.multipleFaces
                    ? 'Only the registered participant should be visible.'
                    : latestMultipleFacesTime
                      ? `Last multiple-face capture at ${latestMultipleFacesTime}.`
                      : 'No additional faces detected in the frame.'}
                </p>
              </div>

              <div className="monitoring-card">
                <h4>Mobile Device</h4>
                <div className={`monitoring-value ${mobileDetection.detected ? 'alert' : ''}`}>
                  <span className={`status-indicator ${!mobileDetection.detected ? 'active' : 'inactive'}`} />
                  {mobileDetection.detected ? 'Mobile device detected' : 'No mobile device visible'}
                </div>
                <p className="monitoring-hint">
                  {mobileDetection.detected
                    ? `Confidence: ${mobileConfidenceDisplay}${
                        mobileDetection.label ? ` (${mobileDetection.label})` : ''
                      }.`
                    : latestMobileDetectedTime
                      ? `Last detection at ${latestMobileDetectedTime}.`
                      : 'Ensure no phones or portable devices are visible.'}
                </p>
              </div>

              <div className="monitoring-card">
                <h4>Ambient Noise</h4>
                <div className={`monitoring-value ${noiseDetected ? 'alert' : ''}`}>
                  <span className={`status-indicator ${!noiseDetected ? 'active' : 'inactive'}`} />
                  {noiseDetected ? 'Background noise detected' : 'Quiet environment'}
                </div>
                <div className="audio-meter">
                  <div
                    className={`audio-meter-fill ${noiseDetected ? 'alert' : ''}`}
                    style={{ width: audioMeterWidth }}
                  />
                </div>
                <div className="audio-meter-stats">
                  <span>Level: {noiseDbDisplay} dB</span>
                  <span>Baseline: {baselineDbDisplay} dB</span>
                  <span>Threshold: {thresholdDbDisplay} dB</span>
                </div>
                <p className="monitoring-hint">
                  RMS {noiseRmsDisplay} • Threshold RMS {thresholdRmsDisplay} • Ratio {audioRatioDisplay}×
                </p>
              </div>
            </div>

            <div className="monitoring-evidence">
              <h3 className="monitoring-title">Recent Captures</h3>
              {alertEvents.length === 0 ? (
                <p className="monitoring-description">
                  No anomalies captured yet. We will store snapshots whenever something unusual occurs.
                </p>
              ) : (
                <>
                  <p className="monitoring-description">
                    Snapshots taken when we detected potential issues. Share these with support if you need assistance.
                  </p>
                  <div className="evidence-grid">
                    {alertEvents.map((event) => (
                      <div className="evidence-card" key={event.id}>
                        <div className="evidence-image">
                          <img src={event.imageUrl} alt={ALERT_EVENT_LABELS[event.type] || event.type} />
                        </div>
                        <div className="evidence-meta">
                          <span className="evidence-type">{ALERT_EVENT_LABELS[event.type] || event.type}</span>
                          <span className="evidence-time">{formatTimestamp(event.timestamp)}</span>
                          <span className="evidence-description">{getEventDescription(event)}</span>
                          <a
                            className="evidence-download"
                            href={event.imageUrl}
                            download={`${event.type}-${event.timestamp}.jpg`}
                          >
                            Download
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Candidate;
