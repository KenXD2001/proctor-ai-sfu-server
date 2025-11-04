import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';
import config from '../config';

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

  // Debug streams state changes
  useEffect(() => {
    console.log('Streams state changed:', {
      screen: streams.screen ? { id: streams.screen.id, tracks: streams.screen.getTracks().length } : null,
      webcam: streams.webcam ? { id: streams.webcam.id, tracks: streams.webcam.getTracks().length } : null,
      mic: streams.mic ? { id: streams.mic.id, tracks: streams.mic.getTracks().length } : null
    });
  }, [streams]);
  const [currentStep, setCurrentStep] = useState('permissions'); // permissions, screen, ready
  const [connectionStatus, setConnectionStatus] = useState('disconnected');

  const screenVideoRef = useRef(null);
  const webcamVideoRef = useRef(null);
  const socketInitializedRef = useRef(false);
  const sendTransportRef = useRef(null);
  const socketRef = useRef(null);
  const streamsStartedRef = useRef(false);

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

  // Set video elements when streams are available
  useEffect(() => {
    console.log('Webcam useEffect triggered, streams.webcam:', !!streams.webcam, 'webcamVideoRef.current:', !!webcamVideoRef.current);
    if (streams.webcam && webcamVideoRef.current) {
      webcamVideoRef.current.srcObject = streams.webcam;
      console.log('Webcam stream set to video element, tracks:', streams.webcam.getTracks().length);
      // Force play the video
      webcamVideoRef.current.play().catch(console.error);
    }
  }, [streams.webcam]);

  useEffect(() => {
    if (streams.screen && screenVideoRef.current) {
      screenVideoRef.current.srcObject = streams.screen;
      console.log('Screen stream set to video element, tracks:', streams.screen.getTracks().length);
      // Force play the video
      screenVideoRef.current.play().catch(console.error);
    }
  }, [streams.screen]);

  // Force update video elements when currentStep changes to ready
  useEffect(() => {
    if (currentStep === 'ready') {
      console.log('Force updating video elements...');
      
      // Force update webcam video
      if (streams.webcam && webcamVideoRef.current) {
        webcamVideoRef.current.srcObject = streams.webcam;
        webcamVideoRef.current.play().catch(console.error);
        console.log('Force updated webcam video element');
      }
      
      // Force update screen video
      if (streams.screen && screenVideoRef.current) {
        screenVideoRef.current.srcObject = streams.screen;
        screenVideoRef.current.play().catch(console.error);
        console.log('Force updated screen video element');
      }
    }
  }, [currentStep, streams.webcam, streams.screen]);

  // Debug: Log when currentStep changes
  useEffect(() => {
    console.log('Current step changed to:', currentStep);
    console.log('Streams state:', { 
      webcam: !!streams.webcam, 
      screen: !!streams.screen, 
      mic: !!streams.mic 
    });
  }, [currentStep, streams]);

  // Force set video elements when ready
  useEffect(() => {
    if (currentStep === 'ready') {
      console.log('Ready step reached, manually setting video elements...');
      if (streams.webcam && webcamVideoRef.current) {
        webcamVideoRef.current.srcObject = streams.webcam;
        console.log('Manually set webcam stream to video element, tracks:', streams.webcam.getTracks().length);
        console.log('Webcam video element srcObject set:', !!webcamVideoRef.current.srcObject);
        // Check if video is playing
        setTimeout(() => {
          if (webcamVideoRef.current) {
            console.log('Webcam video readyState:', webcamVideoRef.current.readyState);
            console.log('Webcam video paused:', webcamVideoRef.current.paused);
            console.log('Webcam video videoWidth:', webcamVideoRef.current.videoWidth);
            console.log('Webcam video videoHeight:', webcamVideoRef.current.videoHeight);
            // Force play if paused
            if (webcamVideoRef.current.paused) {
              webcamVideoRef.current.play().catch(console.error);
            }
          }
        }, 100);
      }
      if (streams.screen && screenVideoRef.current) {
        screenVideoRef.current.srcObject = streams.screen;
        console.log('Manually set screen stream to video element, tracks:', streams.screen.getTracks().length);
        console.log('Screen video element srcObject set:', !!screenVideoRef.current.srcObject);
        // Check if video is playing
        setTimeout(() => {
          if (screenVideoRef.current) {
            console.log('Screen video readyState:', screenVideoRef.current.readyState);
            console.log('Screen video paused:', screenVideoRef.current.paused);
            console.log('Screen video videoWidth:', screenVideoRef.current.videoWidth);
            console.log('Screen video videoHeight:', screenVideoRef.current.videoHeight);
            // Force play if paused
            if (screenVideoRef.current.paused) {
              screenVideoRef.current.play().catch(console.error);
            }
          }
        }, 100);
      }
    }
  }, [currentStep, streams.webcam, streams.screen]);

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
              <div className="video-label">
                <span className={`status-indicator ${permissions.screen ? 'active' : 'inactive'}`}></span>
                Screen Share
              </div>
            </div>
            
            <div className="preview-video">
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
              <div className="video-label">
                <span className={`status-indicator ${permissions.webcam ? 'active' : 'inactive'}`}></span>
                Webcam
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Candidate;
