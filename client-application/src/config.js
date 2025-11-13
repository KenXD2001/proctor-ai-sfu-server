/**
 * Client Application Configuration
 * Reads from environment variables (Vite uses import.meta.env)
 * Values are provided via the repository root .env file
 */

const config = {
  // Server URL - configured through root .env file (VITE_SERVER_URL)
  serverUrl: import.meta.env.VITE_SERVER_URL,

  // JWT Secret - Must match server secret
  jwtSecret: import.meta.env.VITE_JWT_SECRET,
};

export default config;

