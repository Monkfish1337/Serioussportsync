'use strict';

const fetchDefault = require('node-fetch');
const nzbdav = require('./nzbdav');
const webdav = require('./nzbdav-webdav');
const { PlaybackProviderError } = require('../playback-provider');

const DEFAULT_NZB_FETCH_TIMEOUT_MS = 15000;

function providerConfig(userConfig) {
  const cfg = userConfig || {};
  return {
    enabled: cfg.diyUsenetEnabled === true,
    api: {
      url: String(cfg.nzbdavUrl || '').trim(),
      apiKey: String(cfg.nzbdavApiKey || '').trim(),
    },
    webdav: {
      url: String(cfg.nzbdavWebdavUrl || cfg.nzbdavUrl || '').trim(),
      username: String(cfg.nzbdavWebdavUsername || ''),
      password: String(cfg.nzbdavWebdavPassword || ''),
    },
    category: 'sports',
  };
}

function isConfigured(config) {
  const cfg = config || {};
  return cfg.enabled === true && Boolean(
    cfg.api && cfg.api.url && cfg.api.apiKey && cfg.webdav && cfg.webdav.url
  );
}

async function downloadNzb(url, options) {
  const opts = options || {};
  let parsed;
  try { parsed = new URL(String(url || '')); }
  catch (_) {
    throw new PlaybackProviderError('invalid-nzb-url', 'Indexer returned an invalid NZB URL', {
      provider: 'nzbdav', retryable: false, httpStatus: 422,
    });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new PlaybackProviderError('invalid-nzb-url', 'NZB URL must use HTTP or HTTPS', {
      provider: 'nzbdav', retryable: false, httpStatus: 422,
    });
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  const timeoutMs = Math.max(250,
    Number(opts.timeoutMs) || DEFAULT_NZB_FETCH_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (timer.unref) timer.unref();
  try {
    const response = await (opts.fetchImpl || fetchDefault)(parsed.toString(), {
      method: 'GET', redirect: 'follow', signal: controller.signal,
      headers: { Accept: 'application/x-nzb, application/xml, text/xml' },
    });
    if (!response.ok) {
      throw new PlaybackProviderError('nzb-download-failed',
        'Indexer returned HTTP ' + response.status + ' for the selected NZB', {
          provider: 'nzbdav', retryable: response.status >= 500,
          httpStatus: response.status,
        });
    }
    const declared = Number(response.headers && response.headers.get
      ? response.headers.get('content-length') : 0) || 0;
    if (declared > nzbdav.MAX_NZB_BYTES) {
      throw new PlaybackProviderError('invalid-nzb', 'NZB exceeds the size limit', {
        provider: 'nzbdav', retryable: false, httpStatus: 422,
      });
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > nzbdav.MAX_NZB_BYTES) {
        if (response.body.destroy) response.body.destroy();
        throw new PlaybackProviderError('invalid-nzb', 'NZB exceeds the size limit', {
          provider: 'nzbdav', retryable: false, httpStatus: 422,
        });
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof PlaybackProviderError) throw error;
    throw new PlaybackProviderError('nzb-download-failed',
      controller.signal.aborted ? 'NZB download timed out or was cancelled' : 'NZB download failed', {
        provider: 'nzbdav', retryable: true, cause: error,
      });
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
  }
}

function playableResult(video, cfg, jobId) {
  const base = new URL(cfg.webdav.url.replace(/\/+$/, '') + '/');
  const target = new URL(video.url);
  if (target.origin !== base.origin) {
    throw new PlaybackProviderError('invalid-playback-url',
      'Discovered WebDAV video escaped the configured service', {
        provider: 'nzbdav', retryable: false, httpStatus: 422,
      });
  }
  const authorization = webdav.authorizationHeader(cfg.webdav);
  return {
    url: target.toString(),
    size: Number(video.size) || 0,
    jobId: String(jobId || ''),
    headers: authorization ? { Authorization: authorization } : {},
  };
}

async function resolveCandidate(config, candidate, options) {
  const cfg = config || {};
  const item = candidate || {};
  const opts = options || {};
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  if (!isConfigured(cfg)) {
    throw new PlaybackProviderError('not-configured', 'DIY NZB DAV is not fully configured', {
      provider: 'nzbdav', retryable: false, httpStatus: 400,
    });
  }
  if (item.playback && item.playback.url) {
    return playableResult(item.playback, cfg, item.playback.jobId);
  }
  const title = nzbdav.safeJobName(item.title);
  const category = String(cfg.category || item.category || 'sports');
  log('nzbdav: downloading selected NZB');
  const nzb = await (opts.downloadNzb || downloadNzb)(item.nzbUrl, opts);
  log('nzbdav: downloaded NZB (' + nzb.length + ' bytes)');
  const submitted = await (opts.submitNzb || nzbdav.submitNzb)(cfg.api, nzb,
    Object.assign({}, opts, { title, category }));
  log('nzbdav: submitted job ' + submitted.jobId);
  const completed = await (opts.waitForJob || nzbdav.waitForJob)(
    cfg.api, submitted.jobId, opts);
  const slot = completed && completed.slot || {};
  const storage = String(slot.storage || '').replace(/[\\/]+$/, '');
  const storageParts = storage.split(/[\\/]/).filter(Boolean);
  const contentIndex = storageParts.findIndex((part) => part.toLowerCase() === 'content');
  const historyName = storageParts[storageParts.length - 1]
    || slot.name || slot.nzb_name || slot.nzbName;
  const folder = String(historyName || title).split(/[\\/]/).filter(Boolean).pop();
  const historyCategory = String(slot.category
    || (contentIndex >= 0 && storageParts[contentIndex + 1]) || category);
  const rootPath = '/content/' + encodeURIComponent(historyCategory)
    + '/' + encodeURIComponent(folder) + '/';
  log('nzbdav: job completed; discovering WebDAV media in ' + historyCategory);
  const video = await (opts.discoverVideo || webdav.discoverVideo)(
    cfg.webdav, rootPath, opts);
  log('nzbdav: discovered playable WebDAV media (' + (Number(video.size) || 0) + ' bytes)');
  return playableResult(video, cfg, submitted.jobId);
}

module.exports = {
  DEFAULT_NZB_FETCH_TIMEOUT_MS,
  providerConfig,
  isConfigured,
  downloadNzb,
  resolveCandidate,
  playableResult,
};
