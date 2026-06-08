import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryConversationStore, getConversationId } from '../src/conversationStore.js';

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

test('clears a conversation', async () => {
  const store = new MemoryConversationStore(4);

  await store.append('user:1', { role: 'user', text: 'hello' });
  await store.clear('user:1');

  assert.deepEqual(await store.getHistory('user:1'), []);

});

test('builds stable LINE conversation ids', () => {
  assert.equal(getConversationId({ userId: 'U123' }), 'user:U123');
  assert.equal(getConversationId({ groupId: 'G123' }), 'group:G123');
  assert.equal(getConversationId({ roomId: 'R123' }), 'room:R123');
  assert.equal(getConversationId({}), 'unknown');
});
