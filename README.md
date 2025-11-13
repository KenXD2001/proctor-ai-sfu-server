# proctor-ai-sfu-server

## Live Proctoring Features

The client application now performs on-device proctoring checks powered by MediaPipe and the Web Audio API:

- **Face Presence** – Validates that exactly one face remains in view and flags when the candidate leaves the frame.
- **Eye Activity Monitoring** – Detects sustained eye closure to highlight potential inattentiveness.
- **Multiple Face Detection** – Alerts if additional faces appear in the webcam feed.
- **Ambient Noise Detection** – Measures live microphone input to raise alerts when background noise exceeds a safe threshold.

Visual alerts are rendered directly in the student dashboard once permissions are granted, allowing candidates to self-correct before the proctor intervenes.

## Getting Started

1. Configure the shared `.env` file at the repository root with your deployment values (server host, WebRTC IPs, secrets).
2. Install dependencies for both applications:
   ```bash
   cd node-application && npm install
   cd ../client-application && npm install
   ```
3. Start the backend and frontend servers in separate terminals:
   ```bash
   cd node-application && npm start
   cd ../client-application && npm run dev
   ```

The frontend will automatically load the MediaPipe models from the official CDN. Make sure the client is served over HTTPS in production to allow webcam and microphone access.
