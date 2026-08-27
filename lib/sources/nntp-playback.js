'use strict';

const crypto = require('crypto');
const nzbdavPlayback = require('./nzbdav-playback');
const nntpClient = require('./nntp-client');
const { parseNzb, selectDirectVideo } = require('./nntp-nzb');
const { decodeArticle } = require('./nntp-yenc');
const { PlaybackProviderError } = require('../playback-provider');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
const resolvedCache = new Map();
const pendingCache = new Map();

function providerConfig(userConfig) {
  const cfg = userConfig || {};
  return {
    enabled: cfg.nativeNntpEnabled === true,
    host: String(cfg.nntpHost || '').trim(),
    port: Number(cfg.nntpPort) || (cfg.nntpTls === false ? 119 : 563),
    tls: cfg.nntpTls !== false,
    username: String(cfg.nntpUsername || ''),
    password: String(cfg.nntpPassword || ''),
    maxConnections: Math.min(50, Math.max(1, Number(cfg.nntpConnections) || 8)),
  };
}

function isConfigured(config) {
  const cfg = config || {};
  return cfg.enabled === true && Boolean(cfg.host && cfg.port);
}

function cacheGet(key) {
  const found = resolvedCache.get(key);
  if (!found || found.expiresAt <= Date.now()) {
    if (found) resolvedCache.delete(key);
    return null;
  }
  return found.value;
}

function cachePut(key, value) {
  resolvedCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  if (resolvedCache.size > MAX_CACHE_ENTRIES) {
    const oldest = resolvedCache.keys().next().value;
    if (oldest) resolvedCache.delete(oldest);
  }
}

async function resolveCandidate(config, candidate, options) {
  const cfg = config || {};
  const item = candidate || {};
  const opts = options || {};
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  if (!isConfigured(cfg)) throw new PlaybackProviderError(
    'not-configured', 'Native NNTP is not fully configured', {
      provider: 'nntp', retryable: false, httpStatus: 400,
    });
  const cacheKey = String(opts.cacheKey || '');
  if (cacheKey) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
    if (pendingCache.has(cacheKey)) return pendingCache.get(cacheKey);
    const nestedOptions = Object.assign({}, opts, { cacheKey: '' });
    const pending = resolveCandidate(cfg, item, nestedOptions).then((value) => {
      cachePut(cacheKey, value);
      return value;
    }).finally(() => pendingCache.delete(cacheKey));
    pendingCache.set(cacheKey, pending);
    return pending;
  }
  log('nntp: downloading selected NZB');
  const xml = await (opts.downloadNzb || nzbdavPlayback.downloadNzb)(item.nzbUrl, opts);
  const parsed = parseNzb(xml);
  const file = selectDirectVideo(parsed);
  if (!file) throw new PlaybackProviderError(
    'archive-required', 'This NZB contains no direct video file; use the NZB DAV row until native archive streaming is added', {
      provider: 'nntp', retryable: false, httpStatus: 422,
    });
  log('nntp: selected direct video ' + file.filename + ' (' + file.segments.length + ' segment(s))');
  let session;
  try {
    session = await (opts.connect || nntpClient.connectAuthenticated)(cfg, opts);
    const article = await session.body(file.segments[0].messageId);
    const firstPart = decodeArticle(article);
    if (!firstPart.totalSize || firstPart.begin !== 0) throw new Error('First yEnc segment has invalid file boundaries');
    const descriptor = {
      id: crypto.createHash('sha1').update(parsed.hash + '|' + file.filename).digest('hex'),
      filename: firstPart.filename || file.filename,
      size: firstPart.totalSize,
      chunkSize: firstPart.endExclusive,
      segments: file.segments.map((segment) => ({ messageId: segment.messageId })),
      firstPart,
    };
    log('nntp: native direct video ready (' + descriptor.size + ' bytes)');
    return descriptor;
  } catch (error) {
    if (error instanceof PlaybackProviderError) throw error;
    throw new PlaybackProviderError('native-resolve-failed', error.message || 'Native NNTP resolve failed', {
      provider: 'nntp', retryable: true, cause: error,
    });
  } finally {
    if (session) session.close();
  }
}

function parseRange(header, size) {
  if (!header) return { start: 0, endExclusive: size, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start;
  let endExclusive;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    endExclusive = size;
  } else {
    start = Number(match[1]);
    endExclusive = match[2] ? Math.min(size, Number(match[2]) + 1) : size;
  }
  if (!Number.isInteger(start) || !Number.isInteger(endExclusive)
      || start < 0 || start >= size || endExclusive <= start) return null;
  return { start, endExclusive, partial: true };
}

function mimeFor(filename) {
  const ext = String(filename || '').split('.').pop().toLowerCase();
  return {
    mkv: 'video/x-matroska', mp4: 'video/mp4', m4v: 'video/mp4',
    avi: 'video/x-msvideo', mov: 'video/quicktime', webm: 'video/webm',
    ts: 'video/mp2t', m2ts: 'video/mp2t',
  }[ext] || 'application/octet-stream';
}

async function serve(req, res, descriptor, config, options) {
  const opts = options || {};
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const range = parseRange(req.headers.range, descriptor.size);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('ETag', '"' + descriptor.id + '"');
  if (!range) {
    res.statusCode = 416;
    res.setHeader('Content-Range', 'bytes */' + descriptor.size);
    res.end();
    return;
  }
  res.statusCode = range.partial ? 206 : 200;
  res.setHeader('Content-Type', mimeFor(descriptor.filename));
  res.setHeader('Content-Disposition', 'inline; filename*=UTF-8\'\'' + encodeURIComponent(descriptor.filename));
  res.setHeader('Content-Length', String(range.endExclusive - range.start));
  if (range.partial) res.setHeader('Content-Range',
    'bytes ' + range.start + '-' + (range.endExclusive - 1) + '/' + descriptor.size);
  if (req.method === 'HEAD') { res.end(); return; }

  let session;
  let cancelled = false;
  const onClose = () => {
    if (!res.writableEnded) {
      cancelled = true;
      if (session) session.destroy();
    }
  };
  res.once('close', onClose);
  try {
    session = await (opts.connect || nntpClient.connectAuthenticated)(config, opts);
    let position = range.start;
    let segmentIndex = Math.floor(position / descriptor.chunkSize);
    while (position < range.endExclusive) {
      if (segmentIndex >= descriptor.segments.length) throw new Error('NZB ended before the requested byte range');
      const decoded = segmentIndex === 0 && descriptor.firstPart
        ? descriptor.firstPart
        : decodeArticle(await session.body(descriptor.segments[segmentIndex].messageId));
      if (decoded.totalSize !== descriptor.size || decoded.begin > position
          || decoded.endExclusive <= position) throw new Error('Unexpected yEnc segment boundaries');
      const takeEnd = Math.min(decoded.endExclusive, range.endExclusive);
      const chunk = decoded.data.subarray(position - decoded.begin, takeEnd - decoded.begin);
      if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
      position = takeEnd;
      segmentIndex++;
    }
    res.end();
    log('nntp: served bytes ' + range.start + '-' + (range.endExclusive - 1));
  } catch (error) {
    if (!cancelled) throw error;
  } finally {
    res.removeListener('close', onClose);
    if (session) session.close();
  }
}

module.exports = {
  providerConfig, isConfigured, resolveCandidate, parseRange, mimeFor, serve,
  _resolvedCache: resolvedCache,
  _pendingCache: pendingCache,
};
