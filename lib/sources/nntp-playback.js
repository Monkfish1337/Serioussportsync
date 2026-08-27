'use strict';

const crypto = require('crypto');
const nzbdavPlayback = require('./nzbdav-playback');
const nntpPool = require('./nntp-pool');
const { parseNzb, selectDirectVideo } = require('./nntp-nzb');
const { groupRarVolumes, inspectRar } = require('./nntp-rar');
const { decodeArticle } = require('./nntp-yenc');
const { PlaybackProviderError } = require('../playback-provider');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
const MAX_MEDIA_BYTES = 128 * 1024 * 1024 * 1024 * 1024;
const resolvedCache = new Map();
const pendingCache = new Map();

async function withSession(config, options, task) {
  const opts = options || {};
  if (!opts.connect) return nntpPool.getPool(config).run(task);
  const session = await opts.connect(config, opts);
  try { return await task(session); }
  finally { session.close(); }
}

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

async function fetchPart(file, index, config, options, activeSessions) {
  if (index === 0 && file.firstPart) return file.firstPart;
  const opts = options || {};
  const run = async (session) => {
    if (activeSessions) activeSessions.add(session);
    try { return decodeArticle(await session.body(file.segments[index].messageId)); }
    finally { if (activeSessions) activeSessions.delete(session); }
  };
  if (!opts.connect) return nntpPool.getPool(config).run(run);
  return withSession(config, opts, run);
}

async function openNntpFile(file, config, options) {
  const firstPart = await fetchPart({
    segments: file.segments.map((segment) => ({ messageId: segment.messageId })),
  }, 0, config, options);
  if (!Number.isSafeInteger(firstPart.totalSize) || firstPart.totalSize <= 0
      || firstPart.totalSize > MAX_MEDIA_BYTES || firstPart.begin !== 0
      || !Number.isSafeInteger(firstPart.endExclusive) || firstPart.endExclusive <= 0) {
    throw new Error('First yEnc segment has invalid file boundaries');
  }
  const descriptor = {
    filename: firstPart.filename || file.filename,
    size: firstPart.totalSize,
    chunkSize: firstPart.endExclusive,
    segments: file.segments.map((segment) => ({ messageId: segment.messageId })),
    firstPart,
  };
  return {
    descriptor,
    size: descriptor.size,
    readAt: (offset, length) => readNntpFileRange(descriptor, offset, length, config, options),
  };
}

async function readNntpFileRange(file, offset, length, config, options, activeSessions) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
    throw new Error('Native byte range is invalid');
  }
  if (length <= 0 || offset >= file.size) return Buffer.alloc(0);
  const start = Math.max(0, offset);
  const endExclusive = Math.min(file.size, start + length);
  const firstIndex = Math.floor(start / file.chunkSize);
  const lastIndex = Math.floor((endExclusive - 1) / file.chunkSize);
  if (firstIndex < 0 || lastIndex >= file.segments.length) throw new Error('NZB ended before the requested byte range');
  const decoded = await Promise.all(Array.from({ length: lastIndex - firstIndex + 1 }, (_, part) =>
    fetchPart(file, firstIndex + part, config, options, activeSessions)));
  const output = Buffer.allocUnsafe(endExclusive - start);
  let written = 0;
  let position = start;
  for (const part of decoded) {
    if (part.totalSize !== file.size || part.begin > position || part.endExclusive <= position) {
      throw new Error('Unexpected yEnc segment boundaries');
    }
    const takeEnd = Math.min(part.endExclusive, endExclusive);
    part.data.copy(output, written, position - part.begin, takeEnd - part.begin);
    written += takeEnd - position;
    position = takeEnd;
  }
  if (position !== endExclusive) throw new Error('NZB ended before the requested byte range');
  return output.subarray(0, written);
}

async function readDescriptorRange(descriptor, offset, length, config, options, activeSessions) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
    throw new Error('Native byte range is invalid');
  }
  if (descriptor.kind !== 'rar') {
    return readNntpFileRange(descriptor, offset, length, config, options, activeSessions);
  }
  const endExclusive = Math.min(descriptor.size, offset + length);
  const output = Buffer.allocUnsafe(Math.max(0, endExclusive - offset));
  let logical = 0;
  let written = 0;
  for (const fragment of descriptor.fragments) {
    const fragmentEnd = logical + fragment.length;
    if (offset < fragmentEnd && offset + written < endExclusive) {
      const position = offset + written;
      const within = Math.max(0, position - logical);
      const want = Math.min(fragment.length - within, endExclusive - position);
      const chunk = await readNntpFileRange(descriptor.volumes[fragment.volumeIndex],
        fragment.offset + within, want, config, options, activeSessions);
      chunk.copy(output, written);
      written += chunk.length;
      if (chunk.length !== want) break;
    }
    logical = fragmentEnd;
  }
  if (written !== output.length) throw new Error('RAR fragments ended before the requested byte range');
  return output;
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
  try {
    if (file) {
      log('nntp: selected direct video ' + file.filename + ' (' + file.segments.length + ' segment(s))');
      const opened = await openNntpFile(file, cfg, opts);
      const descriptor = Object.assign(opened.descriptor, {
        id: crypto.createHash('sha1').update(parsed.hash + '|' + file.filename).digest('hex'),
      });
      log('nntp: native direct video ready (' + descriptor.size + ' bytes)');
      return descriptor;
    }
    for (const group of groupRarVolumes(parsed.files)) {
      const sources = await Promise.all(group.map((member) => openNntpFile(member.file, cfg, opts)));
      let inspected;
      try { inspected = await inspectRar(sources); }
      catch (error) {
        log('nntp: RAR inspection skipped (' + (error.message || 'invalid archive') + ')');
        continue;
      }
      if (!inspected.selected) continue;
      const selected = inspected.selected;
      const descriptor = {
        kind: 'rar',
        id: crypto.createHash('sha1').update(parsed.hash + '|rar|' + selected.name).digest('hex'),
        filename: selected.name,
        size: selected.size,
        fragments: selected.fragments,
        volumes: sources.map((source) => source.descriptor),
      };
      log('nntp: native stored RAR video ready ' + descriptor.filename + ' ('
        + descriptor.size + ' bytes across ' + sources.length + ' volume(s))');
      return descriptor;
    }
    throw new PlaybackProviderError(
      'archive-required', 'This archive is compressed, encrypted, damaged, or unsupported; use the NZB DAV row', {
        provider: 'nntp', retryable: false, httpStatus: 422,
      });
  } catch (error) {
    if (error instanceof PlaybackProviderError) throw error;
    throw new PlaybackProviderError('native-resolve-failed', error.message || 'Native NNTP resolve failed', {
      provider: 'nntp', retryable: true, cause: error,
    });
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

  let cancelled = false;
  const activeSessions = new Set();
  const onClose = () => {
    if (!res.writableEnded) {
      cancelled = true;
      for (const session of activeSessions) session.destroy();
    }
  };
  res.once('close', onClose);
  try {
    let position = range.start;
    const baseChunkSize = descriptor.kind === 'rar'
      ? Math.max(1, ...descriptor.volumes.map((volume) => volume.chunkSize || 1))
      : descriptor.chunkSize;
    const windowSize = Math.min(16 * 1024 * 1024,
      Math.max(1024 * 1024, baseChunkSize * Math.min(16, config.maxConnections || 8)));
    while (position < range.endExclusive) {
      const length = Math.min(windowSize, range.endExclusive - position);
      const chunk = await readDescriptorRange(descriptor, position, length,
        config, opts, activeSessions);
      if (cancelled) break;
      if (!chunk.length) throw new Error('Native stream returned no data');
      if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
      position += chunk.length;
      if (cancelled) break;
    }
    if (!cancelled) {
      res.end();
      log('nntp: served bytes ' + range.start + '-' + (range.endExclusive - 1)
        + ' (prefetch ' + Math.min(16, config.maxConnections || 8) + ')');
    }
  } catch (error) {
    if (!cancelled) throw error;
  } finally {
    res.removeListener('close', onClose);
  }
}

module.exports = {
  providerConfig, isConfigured, resolveCandidate, parseRange, mimeFor, serve,
  readNntpFileRange, readDescriptorRange,
  _resolvedCache: resolvedCache,
  _pendingCache: pendingCache,
};
