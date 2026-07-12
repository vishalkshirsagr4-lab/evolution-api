/**
 * config.js
 *
 * Single source of truth for all environment-driven configuration.
 * Everything else in this project imports from here instead of reading
 * process.env directly, so there's exactly one place to look when
 * something's misconfigured.
 */
require('dotenv').config();

function toInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

const config = {
  // --- Required: where your existing FastAPI backend lives ---
  fastapiUrl: process.env.FASTAPI_URL || 'http://localhost:8000',
  fastapiApiKey: process.env.FASTAPI_API_KEY || '',

  // The path on your FastAPI backend that receives incoming WhatsApp
  // messages and returns { "reply": "..." }. Defaults to a sensible path
  // but is overridable since your existing backend may already use a
  // different route (e.g. the /webhook/message endpoint from an earlier
  // integration attempt).
  fastapiWebhookPath: process.env.FASTAPI_WEBHOOK_PATH || '/webhook/whatsapp',

  // --- Bridge's own HTTP server (health check + optional outbound-send API) ---
  port: toInt(process.env.PORT, 3000),

  // Optional: protects the bridge's own /send-message endpoint (used if
  // your FastAPI backend wants to proactively push a message, e.g. a
  // reminder, through the bridge rather than only replying to inbound
  // messages). Leave unset to disable that endpoint entirely.
  bridgeApiKey: process.env.BRIDGE_API_KEY || '',

  // --- HTTP request tuning (calls FROM this bridge TO FastAPI) ---
  requestTimeoutMs: toInt(process.env.REQUEST_TIMEOUT_MS, 30000),
  maxRetries: toInt(process.env.MAX_RETRIES, 3),
  retryBaseDelayMs: toInt(process.env.RETRY_BASE_DELAY_MS, 1000),

  // --- WhatsApp session persistence ---
  // whatsapp-web.js's LocalAuth writes the logged-in session here so you
  // don't have to re-scan the QR code every restart. Safe to .gitignore.
  sessionPath: process.env.SESSION_PATH || '.wwebjs_auth',
  clientId: process.env.CLIENT_ID || 'nezuko-bridge',

  // --- Reconnect tuning ---
  reconnectBaseDelayMs: toInt(process.env.RECONNECT_BASE_DELAY_MS, 5000),
  reconnectMaxDelayMs: toInt(process.env.RECONNECT_MAX_DELAY_MS, 60000),

  // --- Conversation mode ---
  conversationTimeoutMs: toInt(process.env.CONVERSATION_TIMEOUT_MS, 300000),

  // --- Logging ---
  logLevel: process.env.LOG_LEVEL || 'info',
  logDir: process.env.LOG_DIR || 'logs',
};

module.exports = config;
