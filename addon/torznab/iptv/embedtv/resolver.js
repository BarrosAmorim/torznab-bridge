import { EmbedTvError, isSafeUpstreamUrl } from './client.js';

const GENERIC_FALLBACK_HOSTS = new Set(['live-chunks.mediacdn.net']);

export function extractStreamCandidates(html, { pageUrl } = {}) {
  const source = decodeHtml(`${html || ''}`)
      .replace(/\\u0026/gi, '&')
      .replace(/\\\//g, '/');
  const raw = [];
  const patterns = [
    /startPlayer\s*\(\s*["']([^"']+)["']/gi,
    /data-stream\s*=\s*["']([^"']+)["']/gi,
    /\bstream\s*:\s*["']([^"']+)["']/gi,
    /(?:src|file|url)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/gi,
    /https?:\/\/[^\s"'<>]+?\.(?:m3u8|txt)(?:\?[^\s"'<>]*)?/gi,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source))) {
      raw.push(match[1] || match[0]);
    }
  }

  const candidates = [];
  const seen = new Set();
  for (const value of raw) {
    const url = toAbsoluteUrl(cleanCandidate(value), pageUrl);
    if (!url || !isSafeUpstreamUrl(url) || seen.has(url)) continue;
    seen.add(url);
    candidates.push({ url, kind: classifyStreamUrl(url), genericFallback: isGenericFallback(url) });
  }

  const specific = candidates.filter(candidate => !candidate.genericFallback);
  return (specific.length ? specific : candidates).sort(compareCandidates);
}

export function selectStreamCandidate(candidates = []) {
  return [...candidates].sort(compareCandidates)[0];
}

export function classifyStreamUrl(url) {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith('.m3u8')) return 'm3u8';
  if (pathname.endsWith('.txt')) return 'txt';
  return 'unknown';
}

export async function resolveChannelPage(channel, client) {
  if (!channel?.pageUrl) {
    throw new EmbedTvError('Canal EmbedTV não possui página de origem', { code: 'missing_channel_url' });
  }
  const html = await client.fetchChannelPage(channel.pageUrl);
  const candidates = extractStreamCandidates(html, { pageUrl: channel.pageUrl });
  const selected = selectStreamCandidate(candidates);
  if (!selected) {
    throw new EmbedTvError('Nenhuma origem HLS encontrada na página do canal', {
      code: 'stream_not_found',
      url: channel.pageUrl,
    });
  }
  const page = new URL(channel.pageUrl);
  return {
    channelId: channel.id,
    pageUrl: channel.pageUrl,
    streamUrl: selected.url,
    streamKind: selected.kind,
    headers: {
      Referer: page.origin,
      Origin: page.origin,
      'User-Agent': client.userAgent,
    },
    candidates,
    resolvedAt: new Date().toISOString(),
  };
}

export function extractNestedManifestUrl(text, baseUrl) {
  const trimmed = `${text || ''}`.trim();
  if (!trimmed || trimmed.startsWith('#EXT')) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    const value = parsed?.url || parsed?.stream || parsed?.src;
    const url = value ? toAbsoluteUrl(value, baseUrl) : undefined;
    return url && isSafeUpstreamUrl(url) ? url : undefined;
  } catch {
    const line = trimmed.split(/\r?\n/).map(value => value.trim()).find(value => /^(?:https?:\/\/|\/).+\.(?:m3u8|txt)(?:\?.*)?$/i.test(value));
    const url = line ? toAbsoluteUrl(line, baseUrl) : undefined;
    return url && isSafeUpstreamUrl(url) ? url : undefined;
  }
}

export function isHlsBody(text, contentType = '') {
  const normalizedType = `${contentType}`.toLowerCase();
  return normalizedType.includes('mpegurl')
    || /^\s*#EXTM3U(?:\s|$)/i.test(`${text || ''}`)
    || /^\s*#EXT-X-/im.test(`${text || ''}`);
}

function compareCandidates(left, right) {
  const score = candidate => {
    let value = candidate.kind === 'm3u8' ? 40 : candidate.kind === 'txt' ? 30 : 10;
    if (candidate.genericFallback) value -= 100;
    return value;
  };
  return score(right) - score(left);
}

function isGenericFallback(url) {
  try {
    return GENERIC_FALLBACK_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function toAbsoluteUrl(value, pageUrl) {
  const normalized = `${value || ''}`.trim().replace(/[),;]+$/, '');
  if (!normalized) return undefined;
  try {
    return new URL(normalized, pageUrl).toString();
  } catch {
    return undefined;
  }
}

function cleanCandidate(value) {
  return `${value || ''}`
      .replace(/&amp;/gi, '&')
      .replace(/\\["']/g, match => match.slice(1));
}

function decodeHtml(value) {
  return value
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&');
}
