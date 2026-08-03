import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

test('fails immediately on HTTP 500 and opens the circuit for following requests', async () => {
  let requestCount = 0;
  const server = await startServer((_req, res) => {
    requestCount += 1;
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream failed' }));
  });

  try {
    configureStremio(server, {
      TORZNAB_STREMIO_TIMEOUT_MS: '1000',
      TORZNAB_STREMIO_CIRCUIT_OPEN_MS: '60000',
    });
    const adapter = await importStremio('http-500');
    const options = { type: 'movie', imdbId: 'tt0133093', query: 'The Matrix' };
    const startedAt = Date.now();

    await assert.rejects(adapter.searchStremioReleaseRows(options), error => {
      assert.equal(error.response.status, 500);
      assert.equal(adapter.isTemporaryStremioError(error), true);
      return true;
    });
    assert.ok(Date.now() - startedAt < 500, 'HTTP 500 should not wait for the request timeout');

    await assert.rejects(adapter.searchStremioReleaseRows(options), error => {
      assert.equal(error.code, 'circuit_open');
      return true;
    });
    assert.equal(requestCount, 1);
    assert.equal(adapter.getStremioRuntimeStatus().circuitBreaker.state, 'open');
  } finally {
    await closeServer(server);
  }
});

test('does not repeat a request that already consumed its timeout', async () => {
  let requestCount = 0;
  const server = await startServer((_req, res) => {
    requestCount += 1;
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ streams: [] }));
    }, 250);
  });

  try {
    configureStremio(server, {
      TORZNAB_STREMIO_TIMEOUT_MS: '50',
      TORZNAB_STREMIO_RETRY_MAX_ATTEMPTS: '2',
      TORZNAB_STREMIO_CIRCUIT_OPEN_MS: '1000',
    });
    const adapter = await importStremio('timeout');
    const options = { type: 'movie', imdbId: 'tt0133093', query: 'The Matrix' };

    await assert.rejects(adapter.searchStremioReleaseRows(options), error => {
      assert.equal(error.code, 'ECONNABORTED');
      return true;
    });
    assert.equal(requestCount, 1);
    assert.ok(adapter.getStremioRuntimeStatus().timing.lastFailureDurationMs < 200);
  } finally {
    await closeServer(server);
  }
});

test('serves stale stream data when a temporary upstream error follows a success', async () => {
  let requestCount = 0;
  let fail = false;
  const server = await startServer((_req, res) => {
    requestCount += 1;
    if (fail) {
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '2' });
      res.end(JSON.stringify({ error: 'temporarily unavailable' }));
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      streams: [{
        infoHash: '1111111111111111111111111111111111111111',
        title: 'The.Matrix.1999.1080p\nThe.Matrix.1999.1080p.mkv\n👤 10 💾 1.4 GB ⚙️ Comando\n🇧🇷',
      }],
    }));
  });

  try {
    configureStremio(server, {
      TORZNAB_STREMIO_STREAM_CACHE_TTL_MS: '5',
      TORZNAB_STREMIO_STREAM_CACHE_STALE_MS: '60000',
      TORZNAB_STREMIO_CIRCUIT_OPEN_MS: '1000',
    });
    const adapter = await importStremio('stale-cache');
    const options = { type: 'movie', imdbId: 'tt0133093', query: 'The Matrix' };

    const freshRows = await adapter.searchStremioReleaseRows(options);
    assert.equal(freshRows.length, 1);
    await new Promise(resolve => setTimeout(resolve, 10));
    fail = true;

    const staleRows = await adapter.searchStremioReleaseRows(options);
    assert.equal(staleRows.length, 1);
    assert.equal(staleRows[0].infoHash, freshRows[0].infoHash);
    assert.equal(requestCount, 2);
    assert.ok(adapter.getStremioRuntimeStatus().circuitBreaker.openRemainingMs >= 1500);
  } finally {
    await closeServer(server);
  }
});

test('allows a half-open probe after the cooldown and closes the circuit on recovery', async () => {
  let requestCount = 0;
  const server = await startServer((_req, res) => {
    requestCount += 1;
    if (requestCount === 1) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'temporary failure' }));
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ streams: [] }));
  });

  try {
    configureStremio(server, {
      TORZNAB_STREMIO_CIRCUIT_OPEN_MS: '30',
    });
    const adapter = await importStremio('half-open-recovery');
    const options = { type: 'movie', imdbId: 'tt0133093', query: 'The Matrix' };

    await assert.rejects(adapter.searchStremioReleaseRows(options));
    await assert.rejects(adapter.searchStremioReleaseRows(options), error => error.code === 'circuit_open');
    assert.equal(requestCount, 1);

    await new Promise(resolve => setTimeout(resolve, 40));
    const recoveredRows = await adapter.searchStremioReleaseRows(options);

    assert.deepEqual(recoveredRows, []);
    assert.equal(requestCount, 2);
    assert.equal(adapter.getStremioRuntimeStatus().circuitBreaker.state, 'closed');
  } finally {
    await closeServer(server);
  }
});

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function configureStremio(server, overrides = {}) {
  const address = server.address();
  Object.assign(process.env, {
    TORZNAB_STREMIO_URL: `http://127.0.0.1:${address.port}`,
    TORZNAB_STREMIO_TIMEOUT_MS: '500',
    TORZNAB_STREMIO_RETRY_MAX_ATTEMPTS: '1',
    TORZNAB_STREMIO_RETRY_BASE_DELAY_MS: '5',
    TORZNAB_STREMIO_CIRCUIT_OPEN_MS: '1000',
    TORZNAB_STREMIO_STREAM_CACHE_TTL_MS: '60000',
    TORZNAB_STREMIO_STREAM_CACHE_STALE_MS: '60000',
    ...overrides,
  });
}

function importStremio(testName) {
  return import(`./stremio.js?test=${testName}-${Date.now()}-${Math.random()}`);
}
