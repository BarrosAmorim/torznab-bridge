import { HLS_CONTENT_TYPES } from './constants.js';

export function isHlsContent(text, contentType = '') {
  const normalizedType = `${contentType}`.toLowerCase().split(';', 1)[0].trim();
  return HLS_CONTENT_TYPES.includes(normalizedType)
    || /^\s*#EXTM3U(?:\s|$)/i.test(`${text || ''}`)
    || /^\s*#EXT-X-/im.test(`${text || ''}`);
}

export function getManifestResourceUrls(manifest, manifestUrl) {
  const urls = new Set();
  for (const line of `${manifest || ''}`.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) {
      const matches = trimmed.matchAll(/URI\s*=\s*["']([^"']+)["']/gi);
      for (const match of matches) {
        addResolved(urls, match[1], manifestUrl);
      }
      continue;
    }
    addResolved(urls, trimmed, manifestUrl);
  }
  return [...urls];
}

export function rewriteHlsManifest(manifest, manifestUrl, { mode = 'direct', proxyUrl } = {}) {
  const lines = `${manifest || ''}`.split(/\r?\n/);
  const rewrite = value => {
    const absolute = toAbsoluteUrl(value, manifestUrl);
    if (!absolute) return value;
    return mode === 'proxy' && typeof proxyUrl === 'function' ? proxyUrl(absolute) : absolute;
  };
  return lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return line.replace(/(URI\s*=\s*["'])([^"']+)(["'])/gi, (_match, prefix, value, suffix) => (
        `${prefix}${rewrite(value)}${suffix}`
      ));
    }
    return rewrite(trimmed);
  }).join('\n');
}

export function encodeProxyTarget(url) {
  return Buffer.from(url, 'utf8').toString('base64url');
}

export function decodeProxyTarget(value) {
  try {
    return Buffer.from(`${value || ''}`, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
}

function addResolved(set, value, baseUrl) {
  const url = toAbsoluteUrl(value, baseUrl);
  if (url) set.add(url);
}

function toAbsoluteUrl(value, baseUrl) {
  try {
    const url = new URL(`${value || ''}`, baseUrl);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
