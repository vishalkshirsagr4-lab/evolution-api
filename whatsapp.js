/**
 * whatsapp.js
 *
 * Owns the whatsapp-web.js Client instance and every WhatsApp-side
 * behavior: QR login, persistent session, auto-reconnect, group/private
 * chat handling, media/quote handling, typing indicator, read receipts,
 * and forwarding messages to the FastAPI backend via api.js.
 *
 * This module does NOT contain any AI logic — it only ever calls
 * `sendMessageToBackend()` from api.js and relays whatever text comes back.
 */
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const config = require('./config');
const logger = require('./logger');
const { sendMessageToBackend } = require('./api');

let client = null;
let isReady = false;
let reconnectAttempts = 0;
let reconnecting = false;

// Active conversations are tracked per chat, with a nested map of sender IDs.
// This keeps group sessions isolated to the specific user in that group.
const activeConversations = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Puppeteer launch args tuned to run headless Chromium reliably in the
 * widest range of environments (Windows without Docker included) without
 * requiring a sandboxed root user setup.
 */
const PUPPETEER_LAUNCH_OPTIONS = {
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
  ],
};

function buildClient() {
  return new Client({
    authStrategy: new LocalAuth({
      clientId: config.clientId,
      dataPath: config.sessionPath,
    }),
    puppeteer: PUPPETEER_LAUNCH_OPTIONS,
  });
}

function detectWakeWord(text) {
  if (typeof text !== 'string') {
    return { isWakeWord: false, prompt: '' };
  }

  const trimmedText = text.trim();
  if (!trimmedText) {
    return { isWakeWord: false, prompt: '' };
  }

  const wakeWordPattern = /(?:^|\s|@)(?:hey|hi)?\s*nezuko(?=\b|[^\w])/gi;
  const hasWakeWord = wakeWordPattern.test(trimmedText);
  if (!hasWakeWord) {
    return { isWakeWord: false, prompt: trimmedText };
  }

  wakeWordPattern.lastIndex = 0;
  const cleanedText = trimmedText
    .replace(wakeWordPattern, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,.;:!?-]+|[\s,.;:!?-]+$/g, '')
    .trim();

  return {
    isWakeWord: true,
    prompt: cleanedText,
  };
}

function getConversationMap(chatId) {
  if (!activeConversations.has(chatId)) {
    activeConversations.set(chatId, new Map());
  }
  return activeConversations.get(chatId);
}

function pruneExpiredConversations(chatId) {
  const chatSessions = activeConversations.get(chatId);
  if (!chatSessions) {
    return;
  }

  for (const [senderId, expiresAt] of chatSessions.entries()) {
    if (Date.now() >= expiresAt) {
      chatSessions.delete(senderId);
    }
  }

  if (chatSessions.size === 0) {
    activeConversations.delete(chatId);
  }
}

function hasActiveConversation(chatId, senderId) {
  if (!chatId || !senderId) {
    return false;
  }

  pruneExpiredConversations(chatId);
  const chatSessions = activeConversations.get(chatId);
  if (!chatSessions || !chatSessions.has(senderId)) {
    return false;
  }

  const expiresAt = chatSessions.get(senderId);
  if (Date.now() >= expiresAt) {
    chatSessions.delete(senderId);
    if (chatSessions.size === 0) {
      activeConversations.delete(chatId);
    }
    return false;
  }

  return true;
}

function setConversationState(chatId, senderId) {
  if (!chatId || !senderId) {
    return;
  }

  const chatSessions = getConversationMap(chatId);
  chatSessions.set(senderId, Date.now() + config.conversationTimeoutMs);
}

function clearConversationState(chatId, senderId) {
  if (!chatId || !senderId) {
    return;
  }

  const chatSessions = activeConversations.get(chatId);
  if (!chatSessions) {
    return;
  }

  chatSessions.delete(senderId);
  if (chatSessions.size === 0) {
    activeConversations.delete(chatId);
  }
}

function registerEventHandlers(activeClient) {
  activeClient.on('qr', (qr) => {
    isReady = false;
    logger.info('Scan this QR code with WhatsApp (Linked Devices) to log in:');
    qrcode.generate(qr, { small: true });
  });

  activeClient.on('loading_screen', (percent, message) => {
    logger.info(`WhatsApp loading: ${percent}% - ${message}`);
  });

  activeClient.on('authenticated', () => {
    logger.info('WhatsApp session authenticated.');
  });

  activeClient.on('auth_failure', (message) => {
    isReady = false;
    logger.error(`WhatsApp authentication failed: ${message}`);
  });

  activeClient.on('ready', () => {
    isReady = true;
    reconnectAttempts = 0;
    reconnecting = false;
    logger.info('WhatsApp client is ready and connected.');
  });

  activeClient.on('disconnected', (reason) => {
    isReady = false;
    logger.warn(`WhatsApp disconnected (reason: ${reason}). Scheduling reconnect...`);
    scheduleReconnect();
  });

  // 'message' fires for messages sent TO us (excludes our own outgoing
  // messages already, but we double-check message.fromMe defensively).
  activeClient.on('message', async (message) => {
    try {
      await handleIncomingMessage(message);
    } catch (err) {
      logger.error(`Unhandled error processing message: ${err.message}`, { stack: err.stack });
    }
  });
}

/**
 * Auto-reconnect with exponential backoff, capped at reconnectMaxDelayMs.
 * Handles both "WhatsApp itself disconnected us" (auth expired, phone
 * unlinked, etc.) and covers internet-loss recovery, since a dropped
 * connection surfaces through the same 'disconnected' event.
 */
async function scheduleReconnect() {
  if (reconnecting) return; // avoid overlapping reconnect loops
  reconnecting = true;

  reconnectAttempts += 1;
  const delay = Math.min(
    config.reconnectBaseDelayMs * 2 ** (reconnectAttempts - 1),
    config.reconnectMaxDelayMs,
  );

  logger.info(`Reconnect attempt ${reconnectAttempts} in ${delay / 1000}s...`);
  await sleep(delay);

  try {
    if (client) {
      await client.destroy().catch((err) => logger.warn(`Error destroying old client: ${err.message}`));
    }
    client = buildClient();
    registerEventHandlers(client);
    await client.initialize();
  } catch (err) {
    logger.error(`Reconnect attempt ${reconnectAttempts} failed: ${err.message}`);
    reconnecting = false;
    scheduleReconnect(); // keep trying, backoff keeps growing
  }
}

/**
 * Extracts a clean, backend-friendly payload from a whatsapp-web.js
 * Message object, resolving chat/contact/media/quoted-message details.
 */
async function buildMessagePayload(message) {
  const chat = await message.getChat();
  const contact = await message.getContact();

  let media = null;
  if (message.hasMedia) {
    try {
      const downloaded = await message.downloadMedia();
      if (downloaded) {
        media = {
          mimetype: downloaded.mimetype,
          filename: downloaded.filename || null,
          data: downloaded.data, // base64-encoded
        };
      }
    } catch (err) {
      logger.warn(`Failed to download media for message ${message.id._serialized}: ${err.message}`);
    }
  }

  let quotedMessage = null;
  if (message.hasQuotedMsg) {
    try {
      const quoted = await message.getQuotedMessage();
      quotedMessage = {
        body: quoted.body || null,
        from: quoted.from,
        type: quoted.type,
      };
    } catch (err) {
      logger.warn(`Failed to fetch quoted message: ${err.message}`);
    }
  }

  return {
    message_id: message.id._serialized,
    chat_id: message.from,
    is_group: chat.isGroup,
    group_name: chat.isGroup ? chat.name : null,
    sender_number: contact.number || null,
    sender_name: contact.pushname || contact.name || null,
    text: message.body || '',
    type: message.type, // e.g. "chat", "image", "ptt" (voice note), "video", "document"
    has_media: message.hasMedia,
    media,
    quoted_message: quotedMessage,
    timestamp: message.timestamp,
  };
}

async function handleIncomingMessage(message) {
  if (message.fromMe) return; // safety net, 'message' event already excludes these

  const chat = await message.getChat();
  const chatId = chat.id._serialized;
  const senderId = message.author || message.from;
  const rawText = typeof message.body === 'string' ? message.body : '';

  if (!rawText.trim()) {
    logger.info('Ignoring empty message', { chatId, senderId });
    return;
  }

  const isBroadcastMessage = Boolean(chat.isBroadcast || message.isBroadcast);
  const isStatusUpdate = Boolean(message.isStatus || message.type === 'status');
  if (isBroadcastMessage || isStatusUpdate) {
    logger.info('Ignoring broadcast/status message', { chatId, senderId, type: message.type });
    return;
  }

  const { isWakeWord, prompt } = detectWakeWord(rawText);
  const hasSession = hasActiveConversation(chatId, senderId);

  if (!isWakeWord && !hasSession) {
    logger.info('Ignoring message because the wake word was not detected and no active session exists', {
      chatId,
      senderId,
      text: rawText,
    });
    return;
  }

  setConversationState(chatId, senderId);

  const payload = await buildMessagePayload(message);
  payload.text = prompt;
  payload.raw_text = rawText;
  payload.is_wake_word = isWakeWord;

  logger.info(
    `Incoming ${payload.is_group ? 'group' : 'private'} message from ${payload.sender_number || payload.chat_id}`,
    { type: payload.type, hasMedia: payload.has_media, wakeWordDetected: isWakeWord },
  );

  let replyText;
  if (!isWakeWord && prompt === '') {
    replyText = 'Hi! I\'m Nezuko 🌸 How can I help you?';
  } else if (!prompt && isWakeWord) {
    replyText = 'Hi! I\'m Nezuko 🌸 How can I help you?';
  } else {
    // Read receipt — mark the chat as seen.
    await chat.sendSeen().catch((err) => logger.warn(`sendSeen() failed: ${err.message}`));

    // Typing indicator while we wait on the AI reply.
    await chat.sendStateTyping().catch((err) => logger.warn(`sendStateTyping() failed: ${err.message}`));

    try {
      replyText = await sendMessageToBackend(payload);
    } catch (err) {
      logger.error(`FastAPI backend did not return a reply: ${err.message}`);
      replyText = "Sorry, I'm having trouble responding right now. Please try again in a moment.";
    } finally {
      await chat.clearState().catch(() => {});
    }
  }

  // message.reply() sends the response quoting the original message.
  await message.reply(replyText);
  logger.info(`Replied to ${payload.sender_number || payload.chat_id}`);
}

/**
 * Starts the WhatsApp client. Call once at process startup (see index.js).
 */
async function start() {
  client = buildClient();
  registerEventHandlers(client);
  await client.initialize();
}

/**
 * Send an arbitrary outbound message to a chat/number, independent of the
 * inbound message flow. Used by the optional /send-message HTTP endpoint
 * (see index.js) so your FastAPI backend can push proactive messages
 * (e.g. reminders) through this bridge.
 *
 * @param {string} chatId - e.g. "919876543210@c.us" or a group id "...@g.us"
 * @param {string} text
 */
async function sendMessageTo(chatId, text) {
  if (!client || !isReady) {
    throw new Error('WhatsApp client is not ready yet');
  }
  return client.sendMessage(chatId, text);
}

function getStatus() {
  return { ready: isReady, reconnectAttempts };
}

module.exports = {
  start,
  sendMessageTo,
  getStatus,
  detectWakeWord,
  hasActiveConversation,
  setConversationState,
  clearConversationState,
};
