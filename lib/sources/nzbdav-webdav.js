'use strict';

const fetchDefault = require('node-fetch');
const { PlaybackProviderError } = require('../playback-provider');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MIN_VIDEO_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_ITEMS = 1000;
const VIDEO_EXTENSIONS = new Set([
  '.mkv', '.mp4', '.m4v', '.avi', '.mov', '.wmv', '.ts', '.m2ts', '.webm', '.mpg', '.mpeg',
]);

function cleanConfig(config) {
  const input = config || {};
  const raw = String(input.url || '').trim().replace(/\/+$/, '');
  let parsed;
  try { parsed = new URL(raw); }
  catch (_) {
    throw new PlaybackProviderError('invalid-config', 'NZB DAV WebDAV URL is invalid', {
      provider: 'nzbdav', retryable: false, httpStatus: 400,
    });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new PlaybackProviderError('invalid-config',
      'NZB DAV WebDAV URL must use HTTP(S) and must not contain credentials', {
        provider: 'nzbdav', retryable: false, httpStatus: 400,
      });
  }
  return {
    url: raw,
    username: String(input.username || ''),
    password: String(input.password || ''),
  };
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tagValue(xml, name) {
  const match = String(xml).match(new RegExp(
    '<(?:[A-Za-z_][\\w.-]*:)?' + name + '\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?' + name + '>',
    'i'
  ));
  return match ? decodeXml(match[1].replace(/<[^>]+>/g, '').trim()) : '';
}

function parseMultiStatus(xml, requestUrl) {
  const entries = [];
  const responsePattern = /<(?:[A-Za-z_][\w.-]*:)?response\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?response>/gi;
  let match;
  while ((match = responsePattern.exec(String(xml || '')))) {
    const block = match[1];
    const href = tagValue(block, 'href');
    if (!href) continue;
    let url;
    try { url = new URL(href, requestUrl).toString(); }
    catch (_) { continue; }
    const length = Number(tagValue(block, 'getcontentlength')) || 0;
    const isDirectory = /<(?:[A-Za-z_][\w.-]*:)?collection\b/i.test(block);
    entries.push({ url, href, isDirectory, size: length });
  }
  return entries;
}

function authorizationHeader(config) {
  const cfg = cleanConfig(config);
  if (!cfg.username && !cfg.password) return null;
  return 'Basic ' + Buffer.from(cfg.username + ':' + cfg.password, 'utf8').toString('base64');
}

function abortFor(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  if (timer.unref) timer.unref();
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

async function list(config, pathOrUrl, options) {
  const cfg = cleanConfig(config);
  const opts = options || {};
  let target;
  try { target = new URL(String(pathOrUrl || '/'), cfg.url + '/').toString(); }
  catch (_) {
    throw new PlaybackProviderError('invalid-path', 'Invalid WebDAV discovery path', {
      provider: 'nzbdav', retryable: false, httpStatus: 400,
    });
  }
  const base = new URL(cfg.url + '/');
  const resolved = new URL(target);
  if (resolved.origin !== base.origin) {
    throw new PlaybackProviderError('invalid-path', 'WebDAV path escaped the configured service', {
      provider: 'nzbdav', retryable: false, httpStatus: 400,
    });
  }
  const abort = abortFor(opts.signal,
    Math.max(250, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const headers = {
    Accept: 'application/xml, text/xml',
    Depth: '1',
    'Content-Type': 'application/xml; charset=utf-8',
  };
  const auth = authorizationHeader(cfg);
  if (auth) headers.Authorization = auth;
  try {
    const response = await (opts.fetchImpl || fetchDefault)(target, {
      method: 'PROPFIND', headers, signal: abort.signal,
      body: '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/><getcontentlength/></prop></propfind>',
    });
    const body = await response.text();
    if (!response.ok && response.status !== 207) {
      throw new PlaybackProviderError(response.status === 401 ? 'auth-failed' : 'http-error',
        'NZB DAV WebDAV returned HTTP ' + response.status, {
          provider: 'nzbdav', retryable: response.status >= 500, httpStatus: response.status,
        });
    }
    return parseMultiStatus(body, target);
  } catch (error) {
    if (error instanceof PlaybackProviderError) throw error;
    throw new PlaybackProviderError(abort.timedOut() ? 'timeout' : 'network',
      abort.timedOut() ? 'NZB DAV WebDAV request timed out' : 'NZB DAV WebDAV request failed', {
        provider: 'nzbdav', retryable: true, cause: error,
      });
  } finally {
    abort.cleanup();
  }
}

function pathnameOf(url) {
  try { return decodeURIComponent(new URL(url).pathname).toLowerCase(); }
  catch (_) { return ''; }
}

function isRejectedPath(url) {
  const path = pathnameOf(url);
  return /(^|[\/._ -])(sample|trailer|extras?|featurettes?|subtitles?|subs)([\/._ -]|$)/i.test(path)
    || /(^|\/)\.[^/]+/.test(path);
}

function isVideo(url) {
  const path = pathnameOf(url);
  const dot = path.lastIndexOf('.');
  return dot >= 0 && VIDEO_EXTENSIONS.has(path.slice(dot));
}

async function discoverVideo(config, rootPath, options) {
  const opts = options || {};
  const maxDepth = Math.max(0, Number(opts.maxDepth) || DEFAULT_MAX_DEPTH);
  const maxItems = Math.max(1, Number(opts.maxItems) || DEFAULT_MAX_ITEMS);
  const minBytes = Math.max(0,
    opts.minVideoBytes == null ? DEFAULT_MIN_VIDEO_BYTES : Number(opts.minVideoBytes));
  const cfg = cleanConfig(config);
  const root = new URL(String(rootPath || '/content/'), cfg.url + '/').toString();
  const pending = [{ url: root, depth: 0 }];
  const visited = new Set();
  const videos = [];
  let seen = 0;

  while (pending.length) {
    const current = pending.shift();
    const key = current.url.replace(/\/+$/, '');
    if (visited.has(key)) continue;
    visited.add(key);
    const entries = await list(cfg, current.url, opts);
    for (const entry of entries) {
      const entryKey = entry.url.replace(/\/+$/, '');
      if (entryKey === key) continue;
      seen += 1;
      if (seen > maxItems) {
        throw new PlaybackProviderError('discovery-limit',
          'NZB DAV WebDAV discovery exceeded its item limit', {
            provider: 'nzbdav', retryable: false, httpStatus: 422,
          });
      }
      if (isRejectedPath(entry.url)) continue;
      if (entry.isDirectory) {
        if (current.depth < maxDepth) pending.push({ url: entry.url, depth: current.depth + 1 });
      } else if (entry.size >= minBytes && isVideo(entry.url)) {
        videos.push(entry);
      }
    }
  }

  videos.sort((a, b) => b.size - a.size || a.url.localeCompare(b.url));
  if (!videos.length) {
    throw new PlaybackProviderError('no-playable-file',
      'NZB DAV completed the job but no playable video was found', {
        provider: 'nzbdav', retryable: false, httpStatus: 404,
      });
  }
  return videos[0];
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MIN_VIDEO_BYTES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_ITEMS,
  VIDEO_EXTENSIONS,
  cleanConfig,
  authorizationHeader,
  parseMultiStatus,
  list,
  discoverVideo,
  isRejectedPath,
  isVideo,
};
