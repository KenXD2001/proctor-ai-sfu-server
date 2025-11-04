/**
 * Client Application Configuration
 * Reads from environment variables (Vite uses import.meta.env)
 * Create a .env file in client-application/ with VITE_ prefix
 */

const config = {
  // Server URL - Update this in .env file
  serverUrl: import.meta.env.VITE_SERVER_URL || 'http://10.5.49.227:3000',
  
  // JWT Secret - Must match server secret
  jwtSecret: import.meta.env.VITE_JWT_SECRET || 'supersecret',
};

export default config;

