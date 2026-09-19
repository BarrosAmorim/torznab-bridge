import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeProxyTarget,
  encodeProxyTarget,
  getManifestResourceUrls,
  rewriteHlsManifest,
} from './hls.js';

test('rewrites relative HLS resources to direct absolute URLs', () => {
  const manifest = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin"\nseg-1.ts\n';
  const resources = getManifestResourceUrls(manifest, 'https://cdn.example/live/index.m3u8');
  assert.deepEqual(resources, [
    'https://cdn.example/live/keys/key.bin',
    'https://cdn.example/live/seg-1.ts',
  ]);
  const rewritten = rewriteHlsManifest(manifest, 'https://cdn.example/live/index.m3u8');
  assert.match(rewritten, /URI="https:\/\/cdn\.example\/live\/keys\/key\.bin"/);
  assert.match(rewritten, /https:\/\/cdn\.example\/live\/seg-1\.ts/);
});

test('rewrites every HLS URI through an opaque local proxy target', () => {
  const manifest = '#EXTM3U\nvariant/index.m3u8\n';
  const rewritten = rewriteHlsManifest(manifest, 'https://cdn.example/master.m3u8', {
    mode: 'proxy',
    proxyUrl: value => `/iptv/embedtv/channel/espn/hls?u=${encodeProxyTarget(value)}`,
  });
  const encoded = rewritten.match(/u=([^\s]+)/)?.[1];
  assert.ok(encoded);
  assert.equal(decodeProxyTarget(encoded), 'https://cdn.example/variant/index.m3u8');
});
