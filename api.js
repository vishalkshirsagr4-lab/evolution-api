/**
 * api.js
 *
 * The ONLY module that talks to your existing FastAPI backend. It knows
 * nothing about WhatsApp — it just POSTs a message payload and expects
 * back { "reply": "..." }. This keeps the WhatsApp-specific code
 * (whatsapp.js) and the backend-specific code (this file) cleanly
 * separated, so either side can change independently.
 */
const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

const httpClient = axios.create({
  baseURL: config.fastapiUrl,
  timeout: config.requestTimeoutMs,
  headers: {
    'Content-Type': 'application/json',
    ...(config.fastapiApiKey ? { 'x-api-key': config.fastapiApiKey } : {}),
  },
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends an incoming WhatsApp message payload to the FastAPI backend and
 * returns the reply text. Retries on network errors and 5xx responses
 * with exponential backoff; does NOT retry on 4xx (those are
 * configuration/request errors that won't fix themselves).
 *
 * @param {object} payload - see whatsapp.js for the exact shape sent
 * @returns {Promise<string>} the reply text from FastAPI
 * @throws if the backend is unreachable or errors after all retries
 */
async function sendMessageToBackend(payload) {
  let lastError;

  for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
    try {
      const response = await httpClient.post(config.fastapiWebhookPath, payload);

      if (!response.data || typeof response.data.reply !== 'string') {
        throw new Error(
          `FastAPI response missing a string "reply" field (got: ${JSON.stringify(response.data)})`,
        );
      }

      return response.data.reply;
    } catch (err) {
      lastError = err;
      const status = err.response ? err.response.status : null;

      // 4xx errors are our fault (bad payload, wrong auth, wrong path) —
      // retrying won't help, so fail fast with a clear message.
      if (status && status >= 400 && status < 500) {
        logger.error(
          `FastAPI rejected the request (${status}): ${JSON.stringify(err.response.data)}. Not retrying.`,
        );
        throw err;
      }

      logger.warn(
        `FastAPI request failed (attempt ${attempt}/${config.maxRetries}): ${err.message}`,
      );

      if (attempt < config.maxRetries) {
        const delay = config.retryBaseDelayMs * 2 ** (attempt - 1);
        await sleep(delay);
      }
    }
  }

  logger.error(`FastAPI request failed after ${config.maxRetries} attempts: ${lastError.message}`);
  throw lastError;
}

module.exports = { sendMessageToBackend, httpClient };
