import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';

const Proctor = ({ user, onLogout }) => {
  const [socket, setSocket] = useState(null);
  const [device, setDevice] = useState(null);
  const [_recvTransport, setRecvTransport] = useState(null);
  const recvTransportRef = useRef(null);
  const [consumers, setConsumers] = useState({
    screen: null,
    webcam: null,
    mic: null
  });
  const [streams, setStreams] = useState({
    screen: null,
    webcam: null,
    mic: null
  });
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('disconnected');

  const screenVideoRef = useRef(null);
  const webcamVideoRef = useRef(null);
  const micAudioRef = useRef(null);
  const socketInitializedRef = useRef(false);

  useEffect(() => {
    if (socketInitializedRef.current) {
      console.log('Proctor socket already initialized, skipping...');
      return;
    }
    
    console.log('Proctor component mounted, initializing socket...');
    socketInitializedRef.current = true;
    initializeSocket();
    
    // Cleanup function
    return () => {
      console.log('Cleaning up proctor socket connection...');
      if (socket) {
        socket.disconnect();
        console.log('Proctor socket disconnected');
      }
      socketInitializedRef.current = false;
    };
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (socket) {
        socket.disconnect();
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [socket]);

  // Handle existing producers when device becomes ready
  useEffect(() => {
    if (device && socket) {
      console.log('Device ready, requesting existing producers...');
      socket.emit('get-producers');
    }
  }, [device, socket]);

  // Store producers when received before device is ready
  const [pendingProducers, setPendingProducers] = useState([]);

  useEffect(() => {
    if (device && pendingProducers.length > 0) {
      console.log('Device now ready, processing pending producers:', pendingProducers);
      handleExistingProducers(pendingProducers);
      setPendingProducers([]);
    }
  }, [device, pendingProducers]);

  // Set video elements when streams are available
  useEffect(() => {
    if (streams.screen && screenVideoRef.current) {
      screenVideoRef.current.srcObject = streams.screen;
      console.log('Screen stream set to video element via useEffect, tracks:', streams.screen.getTracks().length);
      // Force play and check video properties
      setTimeout(() => {
        if (screenVideoRef.current) {
          console.log('Screen video element state:', {
            readyState: screenVideoRef.current.readyState,
            paused: screenVideoRef.current.paused,
            videoWidth: screenVideoRef.current.videoWidth,
            videoHeight: screenVideoRef.current.videoHeight,
            srcObject: !!screenVideoRef.current.srcObject
          });
          if (screenVideoRef.current.paused) {
            screenVideoRef.current.play().catch(console.error);
          }
        }
      }, 200);
    }
  }, [streams.screen]);

  useEffect(() => {
    if (streams.webcam && webcamVideoRef.current) {
      webcamVideoRef.current.srcObject = streams.webcam;
      console.log('Webcam stream set to video element via useEffect, tracks:', streams.webcam.getTracks().length);
      // Force play and check video properties
      setTimeout(() => {
        if (webcamVideoRef.current) {
          console.log('Webcam video element state:', {
            readyState: webcamVideoRef.current.readyState,
            paused: webcamVideoRef.current.paused,
            videoWidth: webcamVideoRef.current.videoWidth,
            videoHeight: webcamVideoRef.current.videoHeight,
            srcObject: !!webcamVideoRef.current.srcObject
          });
          if (webcamVideoRef.current.paused) {
            webcamVideoRef.current.play().catch(console.error);
          }
        }
      }, 200);
    }
  }, [streams.webcam]);

  useEffect(() => {
    if (streams.mic && micAudioRef.current) {
      console.log('🎵 Audio stream useEffect triggered:', {
        streamId: streams.mic.id,
        active: streams.mic.active,
        tracks: streams.mic.getTracks().length,
        trackDetails: streams.mic.getTracks().map(t => ({
          kind: t.kind,
          enabled: t.enabled,
          readyState: t.readyState,
          muted: t.muted,
          label: t.label
        }))
      });

      micAudioRef.current.srcObject = streams.mic;
      console.log('🎵 Audio stream set to audio element via useEffect, tracks:', streams.mic.getTracks().length);
      
      // Force play audio with better debugging
      setTimeout(() => {
        if (micAudioRef.current) {
          console.log('🔊 useEffect: Attempting to play audio element...');
          micAudioRef.current.play()
            .then(() => {
              console.log('✅ useEffect: Audio element playing successfully');
            })
            .catch((error) => {
              console.error('❌ useEffect: Failed to play audio element:', error);
            });
        }
      }, 200);
    } else if (streams.mic && !micAudioRef.current) {
      console.error('❌ Audio stream available but audio element reference not available');
    } else {
      console.log('ℹ️ No audio stream available for useEffect');
    }
  }, [streams.mic]);

  const initializeSocket = () => {
    if (socket) {
      console.log('Proctor socket already exists, not creating new one');
      return;
    }
    
    try {
      const newSocket = io('http://192.168.1.3:3000', {
        auth: {
          token: user.token
        },
        forceNew: true // Force new connection
      });

      newSocket.on('connect', () => {
        console.log('Connected to server with socket ID:', newSocket.id);
        setSocket(newSocket);
        setConnectionStatus('connected');
        
        // Join room immediately after connection
        console.log('Invigilator socket connected, joining room...');
        newSocket.emit('join-room', {
          roomId: user.examRoomId,
          role: 'invigilator'
        });
        console.log('Proctor join room event emitted');
      });

      newSocket.on('disconnect', () => {
        console.log('Disconnected from server');
        setConnectionStatus('disconnected');
      });

      newSocket.on('router-rtp-capabilities', async (rtpCapabilities) => {
        console.log('Received router RTP capabilities');
        await initializeMediasoup(rtpCapabilities);
      });

      newSocket.on('existing-producers', (producers) => {
        console.log('Received existing producers:', producers);
        handleExistingProducers(producers);
      });

      newSocket.on('new-producer', ({ producerId, userId, type }) => {
        console.log('New producer:', { producerId, userId, type });
        handleNewProducer(producerId, userId, type);
      });

      newSocket.on('connect_error', (error) => {
        console.log('Connection error:', error);
        setConnectionStatus('disconnected');
        // Continue with local functionality even if server is not available
      });

      setSocket(newSocket);
    } catch (error) {
      console.error('Failed to initialize socket:', error);
      setConnectionStatus('disconnected');
      // Continue with local functionality
    }
  };

  const initializeMediasoup = async (rtpCapabilities) => {
    try {
      console.log('Initializing mediasoup device with RTP capabilities...');
      const newDevice = new mediasoupClient.Device();
      await newDevice.load({ routerRtpCapabilities: rtpCapabilities });
      setDevice(newDevice);
      console.log('Mediasoup device initialized successfully');
      
      // Join room after device is ready
      joinRoom();
    } catch (error) {
      console.error('Failed to initialize mediasoup device:', error);
    }
  };

  const joinRoom = () => {
    if (!socket) return;

    console.log('Joining room:', user.examRoomId, 'as invigilator');
    socket.emit('join-room', {
      roomId: user.examRoomId,
      role: 'invigilator'
    });
  };

  const createRecvTransport = async () => {
    if (!socket || !device) return;

    return new Promise((resolve, reject) => {
      socket.emit('create-transport', { direction: 'recv' }, async (data) => {
        try {
          const transport = device.createRecvTransport(data);

          transport.on('connect', ({ dtlsParameters }, callback, _errback) => {
            socket.emit('connect-transport', {
              transportId: transport.id,
              dtlsParameters
            }, callback);
          });

          // Store in both state and ref
          setRecvTransport(transport);
          recvTransportRef.current = transport;
          resolve(transport);
        } catch (error) {
          reject(error);
        }
      });
    });
  };

  const handleExistingProducers = async (producers) => {
    console.log('Handling existing producers:', producers);
    console.log('Device status:', { device: !!device, socket: !!socket });
    
    if (!device) {
      console.log('Device not ready yet, storing producers for later processing');
      setPendingProducers(producers);
      return;
    }

    console.log('Device ready, processing producers immediately');
    for (const producer of producers) {
      console.log(`Consuming producer: ${producer.type} from ${producer.userId}`, producer);
      await consumeProducer(producer.producerId, producer.userId, producer.type);
    }
  };

  const handleNewProducer = async (producerId, userId, type) => {
    await consumeProducer(producerId, userId, type);
  };

  const consumeProducer = async (producerId, userId, type) => {
    if (!device || !socket) {
      console.error(`Cannot consume ${type}: device=${!!device}, socket=${!!socket}`);
      return;
    }

    console.log(`Attempting to consume ${type} stream from ${userId}, producerId: ${producerId}`);
    
    try {
      // Create recv transport if not exists
      if (!recvTransportRef.current) {
        console.log('Creating receive transport...');
        const transport = await createRecvTransport();
        console.log('Receive transport created:', transport.id);
      }

      // Use the ref to get the current transport
      const currentTransport = recvTransportRef.current;
      if (!currentTransport) {
        console.error('No receive transport available');
        return;
      }

      console.log('Creating consumer for:', { producerId, type });
      
      // Emit consume event to server first
      socket.emit(
        'consume',
        { producerId, rtpCapabilities: device.rtpCapabilities },
        async ({ id, kind, rtpParameters }) => {
          console.log(`🛒 Creating consumer for ${type}:`, {
            id,
            kind,
            producerId,
            type,
            rtpParameters: {
              codecs: rtpParameters.codecs?.length,
              headerExtensions: rtpParameters.headerExtensions?.length
            }
          });

          const consumer = await currentTransport.consume({
            id,
            producerId,
            kind,
            rtpParameters,
          });

          console.log(`✅ Consumer created for ${type}:`, { 
            id: consumer.id, 
            kind: consumer.kind, 
            paused: consumer.paused,
            closed: consumer.closed,
            track: consumer.track ? {
              kind: consumer.track.kind,
              enabled: consumer.track.enabled,
              readyState: consumer.track.readyState,
              muted: consumer.track.muted,
              label: consumer.track.label
            } : 'No track'
          });

          setConsumers(prev => ({
            ...prev,
            [type]: consumer
          }));

          // Handle the stream based on type
          if (type === 'screen' || type === 'webcam') {
            const stream = new MediaStream([consumer.track]);
            setStreams(prev => ({ ...prev, [type]: stream }));
            
            if (type === 'screen' && screenVideoRef.current) {
              screenVideoRef.current.srcObject = stream;
              console.log('Screen stream set to video element, tracks:', stream.getTracks().length);
              // Force play immediately
              setTimeout(() => {
                if (screenVideoRef.current) {
                  screenVideoRef.current.play().catch(console.error);
                }
              }, 100);
            } else if (type === 'webcam' && webcamVideoRef.current) {
              webcamVideoRef.current.srcObject = stream;
              console.log('Webcam stream set to video element, tracks:', stream.getTracks().length);
              // Force play immediately
              setTimeout(() => {
                if (webcamVideoRef.current) {
                  webcamVideoRef.current.play().catch(console.error);
                }
              }, 100);
            }
          } else if (type === 'mic') {
            const stream = new MediaStream([consumer.track]);
            setStreams(prev => ({ ...prev, mic: stream }));
            
            console.log('🎤 Audio stream created for mic:', {
              streamId: stream.id,
              active: stream.active,
              tracks: stream.getTracks().length,
              trackDetails: stream.getTracks().map(t => ({
                kind: t.kind,
                enabled: t.enabled,
                readyState: t.readyState,
                muted: t.muted,
                label: t.label
              }))
            });
            
            if (micAudioRef.current) {
              micAudioRef.current.srcObject = stream;
              console.log('🎵 Audio stream set to audio element, tracks:', stream.getTracks().length);
              
              // Force play immediately with better error handling
              setTimeout(() => {
                if (micAudioRef.current) {
                  console.log('🔊 Attempting to play audio element...');
                  micAudioRef.current.play()
                    .then(() => {
                      console.log('✅ Audio element playing successfully');
                    })
                    .catch((error) => {
                      console.error('❌ Failed to play audio element:', error);
                      console.error('Audio element state:', {
                        readyState: micAudioRef.current.readyState,
                        paused: micAudioRef.current.paused,
                        muted: micAudioRef.current.muted,
                        volume: micAudioRef.current.volume,
                        srcObject: !!micAudioRef.current.srcObject
                      });
                    });
                }
              }, 100);
            } else {
              console.error('❌ Audio element reference not available');
            }
          }

          console.log(`Successfully started consuming ${type} stream from ${userId}`);
        }
      );
    } catch (error) {
      console.error(`Failed to consume ${type} stream:`, error);
    }
  };

  const toggleMicMute = () => {
    if (streams.mic) {
      const audioElement = micAudioRef.current;
      if (audioElement) {
        audioElement.muted = !audioElement.muted;
        setIsMicMuted(audioElement.muted);
      }
    }
  };

  const handleLogout = () => {
    // Clean up consumers
    Object.values(consumers).forEach(consumer => {
      if (consumer) {
        consumer.close();
      }
    });

    // Clean up streams
    Object.values(streams).forEach(stream => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
    });

    // Clean up transport
    if (recvTransportRef.current) {
      recvTransportRef.current.close();
      recvTransportRef.current = null;
    }

    if (socket) {
      socket.disconnect();
    }

    onLogout();
  };

  return (
    <div className="proctor-container">
      <div className="proctor-header">
        <h1 className="proctor-title">Invigilator Dashboard</h1>
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

      <div className="monitoring-container">
        <div className="monitor-window">
          <h3 className="monitor-title">
            <span className={`status-indicator ${streams.screen ? 'active' : 'inactive'}`}></span>
            Student Screen
          </h3>
          <div className="monitor-video">
            {streams.screen ? (
              <video
                ref={screenVideoRef}
                autoPlay
                playsInline
                muted
                controls={false}
                style={{ 
                  width: '100%', 
                  height: '100%', 
                  backgroundColor: '#000',
                  objectFit: 'cover'
                }}
              />
            ) : (
              <div className="no-video">No screen share available</div>
            )}
          </div>
        </div>

        <div className="monitor-window">
          <h3 className="monitor-title">
            <span className={`status-indicator ${streams.webcam ? 'active' : 'inactive'}`}></span>
            Student Webcam
          </h3>
          <div className="monitor-video">
            {streams.webcam ? (
              <video
                ref={webcamVideoRef}
                autoPlay
                playsInline
                muted
                controls={false}
                style={{ 
                  width: '100%', 
                  height: '100%', 
                  backgroundColor: '#000',
                  objectFit: 'cover'
                }}
              />
            ) : (
              <div className="no-video">No webcam feed available</div>
            )}
          </div>
        </div>
      </div>

      <div className="audio-controls">
        <h3>Audio Controls</h3>
        <button
          className={`audio-button ${isMicMuted ? 'muted' : ''}`}
          onClick={toggleMicMute}
          disabled={!streams.mic}
        >
          {isMicMuted ? '🔇 Unmute Audio' : '🔊 Mute Audio'}
        </button>
        
        <audio
          ref={micAudioRef}
          autoPlay
          playsInline
          controls={false}
          muted={false}
          volume={1.0}
          style={{ 
            width: '100%', 
            height: '40px',
            opacity: 0.1
          }}
        />
        
        <div className="connection-status">
          <span className={`status-indicator ${streams.mic ? 'active' : 'inactive'}`}></span>
          <span className={`status-text ${streams.mic ? 'connected' : 'disconnected'}`}>
            {streams.mic ? 'Audio Connected' : 'No Audio Stream'}
          </span>
        </div>
      </div>
    </div>
  );
};

export default Proctor;
