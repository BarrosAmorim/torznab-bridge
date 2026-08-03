import axios from 'axios';
import nameToImdb from 'name-to-imdb';
import titleParser from 'parse-torrent-title';
import { buildMagnetUrlFromParts, getAdapterConfiguration, parseSizeToBytes } from './release.js';
import { SOURCE_STREMIO } from './source.js';

const DEFAULT_STREMIO_BASE_URL = 'https://torrentio.strem.fun/providers=comando,bludv,micoleaodublado|language=portuguese|qualityfilter=cam,scr';
const STREMIO_BASE_URL = (process.env.TORZNAB_STREMIO_URL || DEFAULT_STREMIO_BASE_URL).replace(/\/$/, '');
const STREMIO_TIMEOUT = parseInt(process.env.TORZNAB_STREMIO_TIMEOUT_MS || '12000', 10);
const STREMIO_RETRY_MAX_ATTEMPTS = parseInt(process.env.TORZNAB_STREMIO_RETRY_MAX_ATTEMPTS || '2', 10);
const STREMIO_RETRY_BASE_DELAY_MS = parseInt(process.env.TORZNAB_STREMIO_RETRY_BASE_DELAY_MS || '500', 10);
const STREMIO_CIRCUIT_OPEN_MS = parseInt(process.env.TORZNAB_STREMIO_CIRCUIT_OPEN_MS || `${60 * 1000}`, 10);
const STREMIO_STREAM_CACHE_TTL_MS = parseInt(process.env.TORZNAB_STREMIO_STREAM_CACHE_TTL_MS || `${5 * 60 * 1000}`, 10);
const STREMIO_STREAM_CACHE_STALE_MS = parseInt(process.env.TORZNAB_STREMIO_STREAM_CACHE_STALE_MS || `${6 * 60 * 60 * 1000}`, 10);
const RELEASE_CACHE_TTL_MS = parseInt(process.env.TORZNAB_RELEASE_CACHE_TTL_MS || `${60 * 60 * 1000}`, 10);
const releaseCache = new Map();
const metaTitleCache = new Map();
const streamCache = new Map();
const inflightRequests = new Map();
const circuitBreaker = {
  state: 'closed',
  openedAt: undefined,
  openUntilMs: undefined,
  lastFailureAt: undefined,
  lastFailureReason: undefined,
  halfOpenProbeInFlight: false,
};
const requestMetrics = {
  lastRequestAt: undefined,
  lastRequestDurationMs: undefined,
  lastSuccessAt: undefined,
  lastSuccessDurationMs: undefined,
  lastFailureAt: undefined,
  lastFailureDurationMs: undefined,
};

export function isTemporaryStremioError(error) {
  return Boolean(error?.temporary && error?.source === SOURCE_STREMIO);
}

export function getStremioRuntimeStatus() {
  pruneStreamCache();
  const cachedStreams = Array.from(streamCache.values());
  const now = Date.now();

  return {
    circuitBreaker: {
      state: circuitBreaker.state,
      openedAt: circuitBreaker.openedAt,
      lastFailureAt: circuitBreaker.lastFailureAt,
      lastFailureReason: circuitBreaker.lastFailureReason,
      halfOpenProbeInFlight: circuitBreaker.halfOpenProbeInFlight,
      openRemainingMs: getCircuitOpenRemainingMs(now),
    },
    timing: {
      timeoutMs: STREMIO_TIMEOUT,
      ...requestMetrics,
    },
    cache: {
      streamEntries: streamCache.size,
      freshStreamEntries: cachedStreams.filter(entry => entry.expiresAt > now).length,
      staleStreamEntries: cachedStreams.filter(entry => entry.expiresAt <= now && entry.staleUntil > now).length,
      inflightRequests: inflightRequests.size,
    },
  };
}

export async function checkStremioHealth() {
  await fetchStremioJson(`${STREMIO_BASE_URL}/manifest.json`, {
    allowCache: false,
    allowStale: false,
    logKey: 'health',
  });
}

export async function searchStremioReleaseRows(options = {}) {
  const {
    type,
    types = [],
    imdbId,
    query,
    season,
    episode,
    limit = 100,
  } = options;
  const queryMetadata = parseQueryMetadata(query);
  const inferredSeason = season ?? queryMetadata.season;
  const inferredEpisode = episode ?? queryMetadata.episode;
  const cleanedQuery = cleanQueryForLookup(query);

  if (type === 'movie') {
    const resolvedImdbId = imdbId || await resolveImdbId(query, 'movie');
    if (!resolvedImdbId) {
      return [];
    }
    const canonicalTitle = await resolveCanonicalTitle({
      imdbId: resolvedImdbId,
      type: 'movie',
      query,
      cleanedQuery,
    });
    const streams = await fetchStreams('movie', resolvedImdbId);
    const rows = streams
        .slice(0, limit)
        .map(stream => mapStreamToReleaseRow(stream, {
          imdbId: resolvedImdbId,
          type: 'movie',
          canonicalTitle,
        }))
        .filter(row => matchesConfiguredLanguages(row));
    return cacheRows(rows);
  }

  if (types.includes('series') || types.includes('anime') || Number.isInteger(inferredSeason) || Number.isInteger(inferredEpisode)) {
    const resolvedImdbId = imdbId || await resolveImdbId(cleanedQuery, 'series');
    if (!resolvedImdbId || !Number.isInteger(inferredSeason)) {
      return [];
    }
    const canonicalTitle = await resolveCanonicalTitle({
      imdbId: resolvedImdbId,
      type: 'series',
      query,
      cleanedQuery,
    });
    if (Number.isInteger(inferredEpisode)) {
      const streams = await fetchStreams('series', `${resolvedImdbId}:${inferredSeason}:${inferredEpisode}`);
      const rows = streams
          .slice(0, limit)
          .map(stream => mapStreamToReleaseRow(stream, {
            imdbId: resolvedImdbId,
            season: inferredSeason,
            episode: inferredEpisode,
            type: 'series',
            canonicalTitle,
          }))
          .filter(row => !isSeasonPackForEpisode(row))
          .filter(row => matchesConfiguredLanguages(row));
      if (rows.length) {
        return cacheRows(rows);
      }

      const fallbackRows = await fetchEpisodeFallbackRows({
        imdbId: resolvedImdbId,
        season: inferredSeason,
        episode: inferredEpisode,
        limit,
        canonicalTitle,
      });
      return cacheRows(fallbackRows.filter(row => matchesConfiguredLanguages(row)));
    }

    const seasonRows = await fetchSeasonRows({
      imdbId: resolvedImdbId,
      season: inferredSeason,
      limit,
      canonicalTitle,
    });
    return cacheRows(collapseSeasonPackRows(
        seasonRows.filter(row => matchesConfiguredLanguages(row)),
        inferredSeason,
    ));
  }

  if (!imdbId && !`${query || ''}`.trim()) {
    const wantsTv = Array.isArray(options.categories) && options.categories.some(category => `${category}`.startsWith('5'));
    const wantsMovie = !Array.isArray(options.categories)
        || !options.categories.length
        || options.categories.some(category => `${category}`.startsWith('2'));

    const rows = [];

    if (wantsTv) {
      const sampleSeriesStreams = await fetchStreams('series', 'tt2861424:8:1');
      rows.push(...sampleSeriesStreams.slice(0, limit).map(stream => mapStreamToReleaseRow(stream, {
        imdbId: 'tt2861424',
        season: 8,
        episode: 1,
        type: 'series',
        canonicalTitle: 'Rick and Morty',
      })));
    }

    if (wantsMovie && rows.length < limit) {
      const sampleMovieStreams = await fetchStreams('movie', 'tt0133093');
      rows.push(...sampleMovieStreams.slice(0, limit - rows.length).map(stream => mapStreamToReleaseRow(stream, {
        imdbId: 'tt0133093',
        type: 'movie',
        canonicalTitle: 'The Matrix',
      })));
    }

    return cacheRows(rows.filter(row => matchesConfiguredLanguages(row)));
  }

  const resolvedImdbId = imdbId || await resolveImdbId(query, 'movie');
  if (!resolvedImdbId) {
    return [];
  }
  const canonicalTitle = await resolveCanonicalTitle({
    imdbId: resolvedImdbId,
    type: 'movie',
    query,
    cleanedQuery,
  });
  const streams = await fetchStreams('movie', resolvedImdbId);
  const rows = streams
      .slice(0, limit)
      .map(stream => mapStreamToReleaseRow(stream, {
        imdbId: resolvedImdbId,
        type: 'movie',
        canonicalTitle,
      }))
      .filter(row => matchesConfiguredLanguages(row));
  return cacheRows(rows);
}

export async function getStremioReleaseRowByGuid(guid) {
  const [infoHash, fileIndexRaw] = decodeURIComponent(guid).split(':');
  const fileIndex = parseInt(fileIndexRaw || '0', 10) || 0;
  pruneCache();
  return releaseCache.get(cacheKey(infoHash.toLowerCase(), fileIndex))?.row;
}

async function fetchStreams(type, id) {
  const url = `${STREMIO_BASE_URL}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
  const data = await fetchStremioJson(url, {
    allowCache: true,
    allowStale: true,
    logKey: `${type}:${id}`,
  });
  return data?.streams || [];
}

async function fetchStremioJson(url, { allowCache, allowStale, logKey }) {
  pruneStreamCache();
  const cacheEntry = allowCache ? getStreamCacheEntry(url) : undefined;
  if (cacheEntry?.freshData !== undefined) {
    console.log(`[stremio:cache] Respondendo ${logKey} pelo cache fresco.`);
    return cacheEntry.freshData;
  }

  const inflightRequest = inflightRequests.get(url);
  if (inflightRequest) {
    console.log(`[stremio:group] Agrupando consulta em andamento para ${logKey}.`);
    return inflightRequest;
  }

  const requestPromise = runStremioRequest(url, logKey)
      .then(data => {
        if (allowCache) {
          cacheStreamResponse(url, data);
        }
        return data;
      })
      .catch(error => {
        if (allowStale && cacheEntry?.staleData !== undefined && isTemporaryStremioError(error)) {
          console.warn(`[stremio:cache] Usando cache antigo para ${logKey} apos falha temporaria.`);
          return cacheEntry.staleData;
        }
        throw error;
      })
      .finally(() => {
        inflightRequests.delete(url);
      });

  inflightRequests.set(url, requestPromise);
  return requestPromise;
}

async function runStremioRequest(url, logKey) {
  const circuitContext = beginCircuitRequest();
  const startedAt = Date.now();
  let lastError;

  requestMetrics.lastRequestAt = new Date(startedAt).toISOString();

  try {
    for (let attempt = 1; attempt <= STREMIO_RETRY_MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await axios.get(url, { timeout: STREMIO_TIMEOUT });
        const durationMs = Date.now() - startedAt;
        markCircuitSuccess(circuitContext, durationMs);
        return response.data;
      } catch (rawError) {
        const error = normalizeStremioError(rawError);
        lastError = error;

        if (!shouldRetryImmediately(error) || attempt >= STREMIO_RETRY_MAX_ATTEMPTS) {
          break;
        }

        const delayMs = computeRetryDelayMs(attempt);
        console.warn(`[stremio:retry] Retry ${attempt}/${STREMIO_RETRY_MAX_ATTEMPTS - 1} para ${logKey} em ${delayMs}ms.`, {
          code: error.code,
        });
        await sleep(delayMs);
      }
    }

    throw lastError || createTemporaryStremioError(undefined, 'retry_exhausted');
  } catch (error) {
    const normalizedError = isTemporaryStremioError(error) ? error : normalizeStremioError(error);
    markCircuitFailure(normalizedError, circuitContext, Date.now() - startedAt);
    throw normalizedError;
  }
}

function beginCircuitRequest() {
  const now = Date.now();
  if (circuitBreaker.state === 'open') {
    const remainingMs = getCircuitOpenRemainingMs(now);
    if (remainingMs > 0) {
      throw createTemporaryStremioError(503, 'circuit_open', { retryAfterMs: remainingMs });
    }

    circuitBreaker.state = 'half-open';
    circuitBreaker.halfOpenProbeInFlight = false;
    console.log('[stremio:circuit] Cooldown encerrado; executando probe half-open.');
  }

  if (circuitBreaker.state === 'half-open') {
    if (circuitBreaker.halfOpenProbeInFlight) {
      throw createTemporaryStremioError(503, 'circuit_half_open_busy', { retryAfterMs: 1000 });
    }
    circuitBreaker.halfOpenProbeInFlight = true;
    return { halfOpenProbe: true };
  }

  return { halfOpenProbe: false };
}

function markCircuitSuccess(_context, durationMs) {
  const now = new Date().toISOString();
  circuitBreaker.state = 'closed';
  circuitBreaker.openedAt = undefined;
  circuitBreaker.openUntilMs = undefined;
  circuitBreaker.lastFailureReason = undefined;
  circuitBreaker.halfOpenProbeInFlight = false;
  requestMetrics.lastRequestDurationMs = durationMs;
  requestMetrics.lastSuccessAt = now;
  requestMetrics.lastSuccessDurationMs = durationMs;
}

function markCircuitFailure(error, _context, durationMs) {
  const nowMs = Date.now();
  const retryAfterMs = Math.max(error.retryAfterMs || 0, STREMIO_CIRCUIT_OPEN_MS);
  const now = new Date(nowMs).toISOString();

  requestMetrics.lastRequestDurationMs = durationMs;
  requestMetrics.lastFailureAt = now;
  requestMetrics.lastFailureDurationMs = durationMs;
  circuitBreaker.halfOpenProbeInFlight = false;

  if (!isTemporaryStremioError(error)) {
    return;
  }

  circuitBreaker.state = 'open';
  circuitBreaker.openedAt = now;
  circuitBreaker.openUntilMs = nowMs + retryAfterMs;
  circuitBreaker.lastFailureAt = now;
  circuitBreaker.lastFailureReason = error.message;
  error.retryAfterMs = retryAfterMs;
  console.warn(`[stremio:circuit] Circuito aberto por ${retryAfterMs}ms apos ${error.code || error.statusCode || 'falha temporaria'}.`);
}

function getCircuitOpenRemainingMs(now = Date.now()) {
  if (circuitBreaker.state !== 'open' || !circuitBreaker.openUntilMs) {
    return 0;
  }
  return Math.max(0, circuitBreaker.openUntilMs - now);
}

function normalizeStremioError(error) {
  const statusCode = error?.response?.status || error?.statusCode;
  const code = error?.code || error?.cause?.code;
  const temporary = isTemporaryStatus(statusCode) || isTemporaryNetworkCode(code);

  if (!temporary) {
    return error;
  }

  error.temporary = true;
  error.source = SOURCE_STREMIO;
  error.statusCode = statusCode;
  error.retryAfterMs = parseRetryAfterMs(error?.response?.headers?.['retry-after']);
  return error;
}

function createTemporaryStremioError(statusCode, reason, details = {}) {
  const error = new Error(reason);
  error.temporary = true;
  error.source = SOURCE_STREMIO;
  error.statusCode = statusCode;
  error.code = reason;
  Object.assign(error, details);
  return error;
}

function isTemporaryStatus(statusCode) {
  return statusCode === 429 || (statusCode >= 500 && statusCode < 600);
}

function isTemporaryNetworkCode(code) {
  return ['ECONNABORTED', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EAI_AGAIN'].includes(code);
}

function shouldRetryImmediately(error) {
  if (error.statusCode || ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code)) {
    return false;
  }
  return ['ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EAI_AGAIN'].includes(error.code);
}

function parseRetryAfterMs(rawValue) {
  if (rawValue == null || `${rawValue}`.trim() === '') {
    return undefined;
  }

  const seconds = Number(rawValue);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds * 1000));
  }

  const timestamp = Date.parse(`${rawValue}`);
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - Date.now());
}

function computeRetryDelayMs(attempt) {
  return STREMIO_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1));
}

function sleep(delayMs) {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

function cacheStreamResponse(key, data) {
  const now = Date.now();
  streamCache.set(key, {
    data,
    expiresAt: now + STREMIO_STREAM_CACHE_TTL_MS,
    staleUntil: now + STREMIO_STREAM_CACHE_STALE_MS,
  });
}

function getStreamCacheEntry(key) {
  const entry = streamCache.get(key);
  if (!entry) {
    return undefined;
  }

  const now = Date.now();
  return {
    freshData: entry.expiresAt > now ? entry.data : undefined,
    staleData: entry.staleUntil > now ? entry.data : undefined,
  };
}

function pruneStreamCache() {
  const now = Date.now();
  for (const [key, entry] of streamCache.entries()) {
    if (entry.staleUntil <= now) {
      streamCache.delete(key);
    }
  }
}

async function resolveImdbId(query, type) {
  const normalizedQuery = `${query || ''}`.trim();
  if (!normalizedQuery) {
    return undefined;
  }

  return new Promise(resolve => {
    nameToImdb({ name: normalizedQuery, type }, (error, result) => {
      if (error) {
        console.error('Failed to resolve IMDb id', { normalizedQuery, type, error: error.message });
        resolve(undefined);
        return;
      }

      if (typeof result === 'string' && /^tt\d+$/.test(result)) {
        resolve(result);
        return;
      }

      if (result?.imdb) {
        resolve(result.imdb);
        return;
      }

      resolve(undefined);
    });
  });
}

function cleanQueryForLookup(query) {
  return `${query || ''}`
      .replace(/\bS\d{1,2}E\d{1,2}\b/ig, '')
      .replace(/\bSeason\s+\d{1,2}\b/ig, '')
      .replace(/\bS\d{1,2}\b/ig, '')
      .trim();
}

async function resolveCanonicalTitle({ imdbId, type, query, cleanedQuery }) {
  const normalizedCleanedQuery = `${cleanedQuery || ''}`.trim();
  if (/[a-z]/i.test(normalizedCleanedQuery)) {
    return normalizedCleanedQuery;
  }

  const normalizedQuery = `${query || ''}`.trim();
  if (/[a-z]/i.test(normalizedQuery) && !/^s\d{1,2}(e\d{1,3})?$/i.test(normalizedQuery)) {
    return normalizedQuery;
  }

  if (!imdbId) {
    return undefined;
  }

  const cacheEntry = metaTitleCache.get(`${type}:${imdbId}`);
  if (cacheEntry) {
    return cacheEntry;
  }

  try {
    const metaType = type === 'movie' ? 'movie' : 'series';
    const response = await axios.get(`https://v3-cinemeta.strem.io/meta/${metaType}/${encodeURIComponent(imdbId)}.json`, {
      timeout: STREMIO_TIMEOUT,
    });
    const title = `${response.data?.meta?.name || ''}`.trim() || undefined;
    if (title) {
      metaTitleCache.set(`${type}:${imdbId}`, title);
    }
    return title;
  } catch (error) {
    console.error('Failed to resolve canonical title', { imdbId, type, error: error.message });
    return undefined;
  }
}

function parseQueryMetadata(query) {
  const rawQuery = `${query || ''}`;
  const episodeMatch = rawQuery.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
  if (episodeMatch) {
    return {
      season: parseInt(episodeMatch[1], 10),
      episode: parseInt(episodeMatch[2], 10),
    };
  }

  const seasonMatch = rawQuery.match(/\bSeason\s+(\d{1,2})\b/i) || rawQuery.match(/\bS(\d{1,2})\b/i);
  if (seasonMatch) {
    return {
      season: parseInt(seasonMatch[1], 10),
      episode: undefined,
    };
  }

  return {
    season: undefined,
    episode: undefined,
  };
}

async function fetchSeasonRows({ imdbId, season, limit, canonicalTitle }) {
  const rows = [];
  let consecutiveMisses = 0;

  for (let episode = 1; episode <= 40 && rows.length < limit; episode += 1) {
    const streams = await fetchStreams('series', `${imdbId}:${season}:${episode}`);
    if (!streams.length) {
      consecutiveMisses += 1;
      if (consecutiveMisses >= 3 && episode > 10) {
        break;
      }
      continue;
    }

    consecutiveMisses = 0;
    rows.push(...streams.map(stream => mapStreamToReleaseRow(stream, {
      imdbId,
      season,
      episode,
      type: 'series',
      canonicalTitle,
    })));
  }

  return rows.slice(0, limit);
}

async function fetchEpisodeFallbackRows({ imdbId, season, episode, limit, canonicalTitle }) {
  const seasonRows = collapseSeasonPackRows(await fetchSeasonRows({
    imdbId,
    season,
    limit: Math.max(limit * 3, limit),
    canonicalTitle,
  }), season);

  const exactRows = seasonRows.filter(row => hasExplicitEpisodeMatch(row, season, episode));
  if (exactRows.length) {
    return exactRows.slice(0, limit);
  }

  const rangedRows = seasonRows.filter(row => hasEpisodeRangeMatch(row, season, episode));
  if (rangedRows.length) {
    return rangedRows.slice(0, limit);
  }

  const seasonPackRows = seasonRows.filter(row => looksLikeSeasonPack(row, season));
  return seasonPackRows.slice(0, limit);
}

function mapStreamToReleaseRow(stream, context) {
  const details = parseStreamTitle(stream.title || '');
  const parsedTorrent = titleParser.parse(details.torrentTitle || details.fileTitle || '');
  const parsedFile = titleParser.parse(details.fileTitle || details.torrentTitle || '');
  const filename = stream.behaviorHints?.filename || details.fileTitle || details.torrentTitle || `${stream.infoHash}.torrent`;
  const provider = details.provider || 'torrentio';
  const size = parseSizeToBytes(details.sizeText);

  return {
    _source: SOURCE_STREMIO,
    infoHash: stream.infoHash?.toLowerCase(),
    provider,
    torrentId: stream.infoHash?.toLowerCase(),
    torrentTitle: details.torrentTitle || filename,
    torrentSize: size,
    type: context.type,
    uploadDate: new Date().toISOString(),
    seeders: details.seeders,
    trackers: process.env.TORZNAB_TRACKERS || '',
    languages: JSON.stringify(details.languages),
    resolution: parsedFile.resolution || parsedTorrent.resolution || parseResolutionFromName(stream.name),
    fileId: stream.infoHash?.toLowerCase(),
    fileIndex: Number.isInteger(stream.fileIdx) ? stream.fileIdx : 0,
    fileTitle: filename,
    fileSize: size,
    imdbId: context.imdbId,
    imdbSeason: context.season,
    imdbEpisode: context.episode,
    canonicalTitle: context.canonicalTitle,
    kitsuId: undefined,
    kitsuEpisode: undefined,
    magnetUrl: buildMagnetUrlFromParts(stream.infoHash?.toLowerCase(), filename, process.env.TORZNAB_TRACKERS || ''),
  };
}

function isSeasonPackForEpisode(row) {
  if (!row || row.type !== 'series' || !Number.isInteger(row.imdbEpisode)) {
    return false;
  }

  const torrentTitle = `${row.torrentTitle || ''}`;
  const fileTitle = `${row.fileTitle || ''}`;
  const expectedEpisodePattern = new RegExp(`\\bS0?${row.imdbSeason}E0?${row.imdbEpisode}\\b`, 'i');
  const torrentHasPackMarker = /\b(complete|season[\s._-]*\d{1,2}|s\d{1,2}\s*complete|全集|pack)\b/i.test(torrentTitle);
  const torrentHasEpisodeRange = /\bS\d{1,2}E\d{1,3}([.\s_-]*[E-][.\s_-]*\d{1,3})+\b/i.test(torrentTitle)
      || /\bS\d{1,2}E\d{1,3}\s*-\s*E?\d{1,3}\b/i.test(torrentTitle);
  const fileLooksSingleEpisode = /\bS\d{1,2}E\d{1,3}\b/i.test(fileTitle);
  const torrentHasExactEpisode = expectedEpisodePattern.test(torrentTitle);
  const torrentDiffersFromFile = normalizeEpisodeHint(torrentTitle) !== normalizeEpisodeHint(fileTitle);
  const suspiciousParentTorrent = fileLooksSingleEpisode && !torrentHasExactEpisode && torrentDiffersFromFile;

  return ((torrentHasPackMarker || torrentHasEpisodeRange) && fileLooksSingleEpisode) || suspiciousParentTorrent;
}

function hasExplicitEpisodeMatch(row, season, episode) {
  const blob = `${row.torrentTitle || ''} ${row.fileTitle || ''}`;
  const pattern = new RegExp(`\\bS0?${season}E0?${episode}\\b`, 'i');
  return pattern.test(blob);
}

function hasEpisodeRangeMatch(row, season, episode) {
  const blob = `${row.torrentTitle || ''} ${row.fileTitle || ''}`;
  const rangePatterns = [
    new RegExp(`\\bS0?${season}E(\\d{1,3})\\s*[-–]\\s*E?(\\d{1,3})\\b`, 'ig'),
    new RegExp(`\\bS0?${season}E(\\d{1,3})E(\\d{1,3})\\b`, 'ig'),
  ];

  for (const pattern of rangePatterns) {
    let match;
    while ((match = pattern.exec(blob)) !== null) {
      const start = parseInt(match[1], 10);
      const end = parseInt(match[2], 10);
      if (Number.isInteger(start) && Number.isInteger(end) && episode >= start && episode <= end) {
        return true;
      }
    }
  }

  return false;
}

function looksLikeSeasonPack(row, season) {
  const blob = `${row.torrentTitle || ''} ${row.fileTitle || ''}`;
  const seasonMarkers = [
    new RegExp(`\\bS0?${season}\\b`, 'i'),
    new RegExp(`\\bSeason[ ._-]*0?${season}\\b`, 'i'),
  ];
  const packMarkers = /\b(complete|pack|temporada|全集)\b/i;
  return seasonMarkers.some(pattern => pattern.test(blob)) && packMarkers.test(blob);
}

function collapseSeasonPackRows(rows, season) {
  if (!Array.isArray(rows) || rows.length <= 1) {
    return rows;
  }

  const groups = new Map();
  for (const row of rows) {
    const key = `${row.infoHash || ''}:${row.provider || ''}`;
    const group = groups.get(key);
    if (group) {
      group.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  const collapsedRows = [];
  for (const group of groups.values()) {
    const distinctEpisodes = new Set(group.map(row => row.imdbEpisode).filter(Number.isInteger));
    const packDetected = distinctEpisodes.size > 1 || group.some(row => looksLikeSeasonPack(row, season));

    if (!packDetected) {
      collapsedRows.push(...group);
      continue;
    }

    const representative = group
        .slice()
        .sort((left, right) => {
          const leftEpisode = Number.isInteger(left.imdbEpisode) ? left.imdbEpisode : Number.MAX_SAFE_INTEGER;
          const rightEpisode = Number.isInteger(right.imdbEpisode) ? right.imdbEpisode : Number.MAX_SAFE_INTEGER;
          if (leftEpisode !== rightEpisode) {
            return leftEpisode - rightEpisode;
          }
          return (left.fileIndex || 0) - (right.fileIndex || 0);
        })[0];

    collapsedRows.push({
      ...representative,
      fileTitle: representative.torrentTitle || representative.fileTitle,
      imdbEpisode: undefined,
      isSeasonPack: true,
      packFileCount: Math.max(distinctEpisodes.size, group.length),
    });
  }

  return collapsedRows;
}

function normalizeEpisodeHint(value) {
  return `${value || ''}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .trim();
}

function cacheRows(rows) {
  pruneCache();
  const expiresAt = Date.now() + RELEASE_CACHE_TTL_MS;
  rows.forEach(row => {
    releaseCache.set(cacheKey(row.infoHash, row.fileIndex || 0), { row, expiresAt });
  });
  return rows;
}

function pruneCache() {
  const now = Date.now();
  for (const [key, value] of releaseCache.entries()) {
    if (value.expiresAt <= now) {
      releaseCache.delete(key);
    }
  }
}

function cacheKey(infoHash, fileIndex) {
  return `${infoHash}:${fileIndex}`;
}

function parseStreamTitle(rawTitle) {
  const lines = `${rawTitle || ''}`
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);

  const statsIndex = lines.findIndex(line => line.includes('👤') || line.includes('⚙️'));
  const headerLines = statsIndex >= 0 ? lines.slice(0, statsIndex) : lines;
  const statsLine = statsIndex >= 0 ? lines[statsIndex] : '';
  const languageLines = statsIndex >= 0 ? lines.slice(statsIndex + 1) : [];
  const seedersMatch = statsLine.match(/👤\s*(\d+)/u);
  const sizeMatch = statsLine.match(/💾\s*([0-9.,]+\s*[KMGTP]?B)/iu);
  const providerMatch = statsLine.match(/⚙️\s*(.+)$/u);

  return {
    torrentTitle: headerLines[0] || '',
    fileTitle: headerLines[1] || '',
    seeders: seedersMatch ? parseInt(seedersMatch[1], 10) : 0,
    sizeText: sizeMatch ? sizeMatch[1] : '',
    provider: providerMatch ? providerMatch[1].trim() : '',
    languages: parseLanguages(languageLines.join(' ')),
  };
}

function parseLanguages(rawText) {
  const mappings = [
    ['🇵🇹', 'portuguese'],
    ['🇧🇷', 'portuguese'],
    ['🇬🇧', 'english'],
    ['🇺🇸', 'english'],
    ['🇪🇸', 'spanish'],
    ['🇲🇽', 'spanish'],
    ['🇫🇷', 'french'],
    ['🇮🇹', 'italian'],
    ['🇩🇪', 'german'],
    ['🇯🇵', 'japanese'],
    ['🇮🇳', 'hindi'],
  ];

  const languages = mappings
      .filter(([flag]) => rawText.includes(flag))
      .map(([, language]) => language);

  if (/dual audio/i.test(rawText)) {
    languages.push('dual-audio');
  }
  if (/multi audio/i.test(rawText)) {
    languages.push('multi-audio');
  }
  if (/\bdublad[oa]\b/i.test(rawText) || /\bportugu[eê]s\b/i.test(rawText) || /\bpt-br\b/i.test(rawText)) {
    languages.push('portuguese');
  }

  return Array.from(new Set(languages));
}

function matchesConfiguredLanguages(row) {
  const config = getAdapterConfiguration();
  const requestedLanguages = Array.isArray(config?.language) ? config.language.map(value => `${value}`.toLowerCase()) : [];
  if (!requestedLanguages.length) {
    return true;
  }

  const parsedLanguages = parseRowLanguages(row);
  const titleBlob = `${row.torrentTitle || ''} ${row.fileTitle || ''}`.toLowerCase();

  if (requestedLanguages.includes('portuguese')) {
    return parsedLanguages.includes('portuguese')
        || parsedLanguages.includes('dual-audio')
        || /\b(dual|dual[ ._-]?audio|dublado|pt-br|portugu[eê]s)\b/i.test(titleBlob);
  }

  return true;
}

function parseRowLanguages(row) {
  try {
    const parsed = JSON.parse(row.languages || '[]');
    return Array.isArray(parsed) ? parsed.map(value => `${value}`.toLowerCase()) : [];
  } catch {
    return [];
  }
}

function parseResolutionFromName(rawName) {
  const line = `${rawName || ''}`.split('\n').pop()?.toLowerCase() || '';
  if (line.includes('4k')) {
    return '2160p';
  }
  if (line.includes('1080')) {
    return '1080p';
  }
  if (line.includes('720')) {
    return '720p';
  }
  if (line.includes('480')) {
    return '480p';
  }
  return undefined;
}
