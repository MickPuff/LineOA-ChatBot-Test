import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryConversationStore,
  getConversationChannel,
  getConversationId,
  getWebsiteConversationId,
} from '../src/conversationStore.js';

test('stores full conversation history', async () => {
  const store = new MemoryConversationStore(2);

  await store.append('user:1', { role: 'user', text: 'one' });
  await store.append('user:1', { role: 'assistant', text: 'two' });
  await store.append('user:1', { role: 'user', text: 'three' });

  assert.deepEqual(await store.getHistory('user:1'), [
    { role: 'user', text: 'one' },
    { role: 'assistant', text: 'two' },
    { role: 'user', text: 'three' },
  ]);
});

test('returns only recent history for LLM context', async () => {
  const store = new MemoryConversationStore(2);

  await store.append('user:1', { role: 'user', text: 'one' });
  await store.append('user:1', { role: 'assistant', text: 'two' });
  await store.append('user:1', { role: 'user', text: 'three' });

  assert.deepEqual(await store.getRecentHistory('user:1'), [
    { role: 'assistant', text: 'two' },
    { role: 'user', text: 'three' },
  ]);
});

test('lists conversation summaries newest first', async () => {
  const store = new MemoryConversationStore(4);

  await store.append('user:old', {
    role: 'user',
    text: 'old chat',
    at: '2026-06-08T10:00:00.000Z',
  });
  await store.append('user:new', {
    role: 'user',
    text: 'new chat',
    at: '2026-06-08T11:00:00.000Z',
  });
  await store.append('user:new', {
    role: 'assistant',
    text: 'new reply',
    at: '2026-06-08T11:01:00.000Z',
  });

  assert.deepEqual(await store.listConversations(), [
    {
      conversationId: 'user:new',
      channel: 'line',
      messageCount: 2,
      userMessageCount: 1,
      assistantMessageCount: 1,
      firstAt: '2026-06-08T11:00:00.000Z',
      lastAt: '2026-06-08T11:01:00.000Z',
      lastRole: 'assistant',
      lastText: 'new reply',
      title: 'new chat',
      aiEnabled: true,
      tags: [],
    },
    {
      conversationId: 'user:old',
      channel: 'line',
      messageCount: 1,
      userMessageCount: 1,
      assistantMessageCount: 0,
      firstAt: '2026-06-08T10:00:00.000Z',
      lastAt: '2026-06-08T10:00:00.000Z',
      lastRole: 'user',
      lastText: 'old chat',
      title: 'old chat',
      aiEnabled: true,
      tags: [],
    },
  ]);
});

test('stores conversation AI settings and tags', async () => {
  const store = new MemoryConversationStore(4);

  assert.deepEqual(await store.getConversationSettings('user:1'), {
    aiEnabled: true,
    channel: '',
    displayName: '',
    tags: [],
  });

  await store.updateConversationSettings('user:1', {
    aiEnabled: false,
    channel: 'website',
    displayName: 'Mick',
    tags: ['espresso', 'espresso', 'gift buyer'],
  });

  assert.deepEqual(await store.getConversationSettings('user:1'), {
    aiEnabled: false,
    channel: 'website',
    displayName: 'Mick',
    tags: ['espresso', 'gift buyer'],
  });
});

test('stores bot settings', async () => {
  const store = new MemoryConversationStore(4);

  assert.deepEqual(await store.getBotSettings(), { systemInstruction: '' });

  await store.updateBotSettings({ systemInstruction: 'Sell coffee.' });

  assert.deepEqual(await store.getBotSettings(), { systemInstruction: 'Sell coffee.' });
});

test('clears a conversation', async () => {
  const store = new MemoryConversationStore(4);

  await store.append('user:1', { role: 'user', text: 'hello' });
  await store.clear('user:1');

  assert.deepEqual(await store.getHistory('user:1'), []);

});

test('claims webhook events once for duplicate detection', async () => {
  const store = new MemoryConversationStore(4);

  assert.equal(await store.claimWebhookEvent('event-1'), true);
  assert.equal(await store.claimWebhookEvent('event-1'), false);
  assert.equal(await store.claimWebhookEvent('event-2'), true);
  assert.equal(await store.claimWebhookEvent(), true);
});

test('builds stable LINE conversation ids', () => {
  assert.equal(getConversationId({ userId: 'U123' }), 'user:U123');
  assert.equal(getConversationId({ groupId: 'G123' }), 'group:G123');
  assert.equal(getConversationId({ roomId: 'R123' }), 'room:R123');
  assert.equal(getConversationId({}), 'unknown');
});

test('builds website conversation ids and channels', () => {
  assert.equal(getWebsiteConversationId('Mick Puff!'), 'website:Mick-Puff');
  assert.equal(getWebsiteConversationId(''), 'website:anonymous');
  assert.equal(getConversationChannel('website:Mick'), 'website');
  assert.equal(getConversationChannel('user:U123'), 'line');
  assert.equal(getConversationChannel('fb:123'), 'fb');
  assert.equal(getConversationChannel('unknown'), 'unknown');
});
