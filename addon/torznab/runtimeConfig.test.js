import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'torznab-runtime-config-'));
process.env.TORZNAB_RUNTIME_CONFIG_PATH = path.join(configDirectory, 'torznab-ui.json');
process.env.TORZNAB_CONFIGURATION = 'brazuca';

const { getAdapterConfiguration, saveRuntimeConfig } = await import('./runtimeConfig.js');

test('preserves an explicitly empty provider and source selection', () => {
  saveRuntimeConfig({ providers: [], sources: [] });

  const configuration = getAdapterConfiguration();
  assert.deepEqual(configuration.providers, []);
  assert.deepEqual(configuration.sources, []);
});

test('normalizes and persists selected providers and sources', () => {
  saveRuntimeConfig({ providers: [' Comando ', 'COMANDO', 'unknown'], sources: ['STREMIO'] });

  const configuration = getAdapterConfiguration();
  assert.deepEqual(configuration.providers, ['comando']);
  assert.deepEqual(configuration.sources, ['stremio']);
});
