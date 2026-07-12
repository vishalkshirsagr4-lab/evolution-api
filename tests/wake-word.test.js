const assert = require('assert/strict');
const { detectWakeWord, hasActiveConversation, setConversationState, clearConversationState } = require('../whatsapp');

function run() {
  const direct = detectWakeWord('Nezuko tell me a joke');
  assert.equal(direct.isWakeWord, true);
  assert.equal(direct.prompt, 'tell me a joke');

  const greeting = detectWakeWord('Hey Nezuko');
  assert.equal(greeting.isWakeWord, true);
  assert.equal(greeting.prompt, '');

  const ignored = detectWakeWord('Hello there');
  assert.equal(ignored.isWakeWord, false);
  assert.equal(ignored.prompt, 'Hello there');

  const chatId = '120363123456789012@g.us';
  const senderId = '1234567890@c.us';

  assert.equal(hasActiveConversation(chatId, senderId), false);
  setConversationState(chatId, senderId);
  assert.equal(hasActiveConversation(chatId, senderId), true);
  clearConversationState(chatId, senderId);
  assert.equal(hasActiveConversation(chatId, senderId), false);

  console.log('wake-word tests passed');
}

run();
