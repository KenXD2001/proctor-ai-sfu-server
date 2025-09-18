const minPort = 40000;
const maxPort = 49999;
let currentPort = minPort;

function getPort() {
  if (currentPort > maxPort) currentPort = minPort;
  return currentPort++;
}

function releasePort(port) {
  // In production, track free ports; for now, no-op
}

module.exports = { getPort, releasePort };
