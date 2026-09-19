import assert from 'node:assert/strict';
import test from 'node:test';
import { EmbedTvClient } from './client.js';

test('times out while reading a stalled text response', async () => {
  const client = new EmbedTvClient({
    timeoutMs: 250,
    retryAttempts: 1,
    fetchFn: async () => ({
      ok: true,
      url: 'https://cdn.example/live.txt',
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: () => new Promise(() => {}),
      body: { cancel: async () => {} },
    }),
  });

  await assert.rejects(
    client.fetchText('https://cdn.example/live.txt'),
    error => error.code === 'timeout' && error.statusCode === 504,
  );
});
