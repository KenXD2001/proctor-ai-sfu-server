# AI Audio Analysis App

A FastAPI-based application for real-time audio analysis and monitoring, designed for proctoring and surveillance scenarios.

## Features

### Phase 1: Calibration
- **Endpoint**: `POST /calibrate`
- **Purpose**: Analyze 10-second audio clip to establish baseline noise thresholds
- **Output**: Noise thresholds (low, medium, high) for volume classification

### Phase 2: Real-Time Monitoring
- **Endpoint**: `POST /analyze`
- **Purpose**: Analyze 5-second audio clips for suspicious activity
- **Analysis**:
  - Volume level classification (low/medium/high)
  - Human speech detection
  - Background sound detection (typing, phone, door, etc.)

### Smart File Saving
Audio clips are only saved when:
- Volume level is "high"
- Human speech is detected
- Suspicious background sounds are detected

## Installation

1. **Create virtual environment**:
```bash
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

2. **Install dependencies**:
```bash
pip install -r requirements.txt
```

3. **Run the application**:
```bash
python main.py
```

The server will start on `http://localhost:8080`

## API Endpoints

### Health Check
- **GET** `/` - Returns application status

### Calibration
- **POST** `/calibrate`
  - **Input**: Audio file (10-second clip)
  - **Output**: Calibration thresholds and analysis

### Analysis
- **POST** `/analyze`
  - **Input**: Audio file (5-second clip)
  - **Output**: Analysis results and saved file path (if applicable)

### Status
- **GET** `/status` - Returns calibration status and current thresholds

## Usage Example

### 1. Calibration (First Time Setup)
```bash
curl -X POST "http://localhost:8080/calibrate" \
     -H "Content-Type: multipart/form-data" \
     -F "audio_file=@calibration_audio.wav"
```

### 2. Analysis
```bash
curl -X POST "http://localhost:8080/analyze" \
     -H "Content-Type: multipart/form-data" \
     -F "audio_file=@test_audio.wav"
```

### 3. Check Status
```bash
curl -X GET "http://localhost:8080/status"
```

## Technical Details

### Audio Processing Libraries
- **librosa**: Audio analysis and feature extraction
- **soundfile**: Audio file I/O
- **pydub**: Audio format conversion and manipulation

### Speech Detection
- **webrtcvad**: Voice Activity Detection for human speech identification

### Sound Classification
- Custom algorithms for detecting:
  - Typing sounds (high zero-crossing rate, mid-range frequencies)
  - Phone sounds (specific frequency patterns)
  - Door sounds (low frequency, sudden onset)
  - Mechanical sounds (high spectral rolloff)

### File Formats Supported
- WAV, MP3, FLAC, M4A, and other common audio formats
- Automatic conversion to 16kHz mono for analysis

## Directory Structure

```
python-application/
├── main.py                 # FastAPI application
├── audio_analyzer.py       # Core audio analysis logic
├── calibration_service.py  # Calibration functionality
├── requirements.txt        # Python dependencies
├── README.md              # This file
└── uploads/               # Saved audio files (created automatically)
    └── saved_audio/       # Audio clips saved based on analysis rules
```

## Configuration

The application uses the following default settings:
- **Sample Rate**: 16kHz (optimized for WebRTC VAD)
- **VAD Aggressiveness**: Level 2 (0-3 scale)
- **Speech Detection Threshold**: 30% of frames must contain speech
- **File Saving**: Only when high volume, speech, or suspicious sounds detected

## Error Handling

The application includes comprehensive error handling for:
- Invalid audio file formats
- Corrupted audio data
- Missing calibration data
- Audio processing failures

## Performance Notes

- Designed for real-time processing of 5-second audio clips
- Calibration should be performed once per session/environment
- File saving is conditional to minimize storage usage
- Optimized for low-latency analysis suitable for live monitoring

## Dependencies

See `requirements.txt` for complete list of required packages. Key dependencies include:
- FastAPI for web framework
- librosa for audio processing
- webrtcvad for speech detection
- pydub for audio format handling
