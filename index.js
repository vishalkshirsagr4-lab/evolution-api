/**
 * index.js
 *
 * Entrypoint. Starts the whatsapp-web.js client and a small Express server
 * exposing:
 *   GET  /health         - liveness/readiness check
 *   POST /send-message   - optional: lets your FastAPI backend push a
 *                           proactive WhatsApp message (e.g. a reminder)
 *                           through this bridge. Protected by BRIDGE_API_KEY
 *                           if set; otherwise disabled-by-obscurity is NOT
 *                           relied upon — set BRIDGE_API_KEY before exposing
 *                           this port beyond localhost.
 *
 * This file contains NO AI logic and NO WhatsApp-protocol logic — those
 * live in api.js and whatsapp.js respectively. It only wires things
 * together and keeps the process alive.
 */
const express = require('express');

const config = require('./config');
const logger = require('./logger');
const whatsapp = require('./whatsapp');

const app = express();
app.use(express.json({ limit: '10mb' })); // headroom for any future media in requests

app.get('/health', (req, res) => {
  const status = whatsapp.getStatus();
  res.status(status.ready ? 200 : 503).json({
    status: status.ready ? 'ready' : 'starting',
    whatsapp: status,
  });
});

app.post('/send-message', async (req, res) => {
  if (!config.bridgeApiKey) {
    return res.status(404).json({ error: 'Not found' }); // endpoint disabled if no key configured
  }

  const providedKey = req.header('x-api-key');
  if (providedKey !== config.bridgeApiKey) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  const { chat_id: chatId, text } = req.body || {};
  if (!chatId || !text) {
    return res.status(400).json({ error: '"chat_id" and "text" are required' });
  }

  try {
    await whatsapp.sendMessageTo(chatId, text);
    return res.json({ status: 'sent' });
  } catch (err) {
    logger.error(`/send-message failed: ${err.message}`);
    return res.status(503).json({ error: err.message });
  }
});

// Catch-all error handler for anything that slips through route handlers.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error(`Unhandled Express error: ${err.message}`, { stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

const WHATSAPP_STARTUP_RETRY_DELAY_MS = 10000;

async function startWhatsAppWithRetry() {
  try {
    await whatsapp.start();
  } catch (err) {
    logger.error(`WhatsApp client startup failed: ${err.message}`, { stack: err.stack });
    logger.info(`Retrying WhatsApp client startup in ${WHATSAPP_STARTUP_RETRY_DELAY_MS / 1000}s...`);
    setTimeout(startWhatsAppWithRetry, WHATSAPP_STARTUP_RETRY_DELAY_MS);
  }
}

async function main() {
  logger.info('Starting Nezuko WhatsApp Bridge...');

  app.listen(config.port, () => {
    logger.info(`HTTP server listening on port ${config.port}`);
    logger.info(`Health check:  http://localhost:${config.port}/health`);
  });

  await startWhatsAppWithRetry();
}

// Keep the process alive on unexpected errors instead of crashing outright.
// This is a safety net, not a substitute for the reconnect logic in
// whatsapp.js, which handles the normal disconnect/reconnect cases.
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled promise rejection: ${reason instanceof Error ? reason.stack : reason}`);
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.stack || err.message}`);
});

process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

main();
