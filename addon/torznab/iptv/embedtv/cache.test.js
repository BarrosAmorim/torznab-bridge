import assert from 'node:assert/strict';
import test from 'node:test';
import { TtlCache } from './cache.js';

test('deduplicates concurrent loads and serves fresh cache', async () => {
  let now = 0;
  let calls = 0;
  const cache = new TtlCache({ ttlMs: 100, staleMs: 500, clock: () => now });
  const loader = async () => {
    calls += 1;
    await Promise.resolve();
    return { value: calls };
  };

  const [one, two] = await Promise.all([
    cache.getOrLoad('catalog', loader),
    cache.getOrLoad('catalog', loader),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(one.value, { value: 1 });
  assert.deepEqual(two.value, { value: 1 });

  now = 50;
  const fresh = await cache.getOrLoad('catalog', loader);
  assert.equal(fresh.fromCache, true);
  assert.equal(calls, 1);
});

test('keeps stale data until the stale window ends after a failed refresh', async () => {
  let now = 0;
  const cache = new TtlCache({ ttlMs: 10, staleMs: 50, clock: () => now });
  cache.set('epg', ['old']);
  now = 20;

  const stale = await cache.getOrLoad('epg', async () => {
    throw new Error('upstream down');
  });
  assert.deepEqual(stale.value, ['old']);
  assert.equal(cache.peek('epg').state, 'stale');

  now = 51;
  await assert.rejects(cache.getOrLoad('epg', async () => {
    throw new Error('upstream down');
  }), /upstream down/);
  assert.equal(cache.peek('epg'), undefined);
});
