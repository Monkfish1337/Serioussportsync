'use strict';

// Native NZB DAV compatibility client. This module talks only to the documented
// SABnzbd-compatible API; WebDAV discovery and SSS play-token persistence live
// in separate layers so API credentials never need to enter stream rows.

const crypto = require('crypto');
const fetchDefault = require('node-fetch');
const { PlaybackProviderError } = require('../playback-provider');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_JOB_TIMEOUT_MS = 120000;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const MAX_NZB_BYTES = 16 * 1024 * 1024;

function cleanConfig(config) {
  const input = config || {};
  const raw = String(input.url || '').trim().replace(/\/+$/, '');
  let parsed;
  try { parsed = new URL(raw); }
  catch (_) {
    throw new PlaybackProviderError('invalid-config', 'NZB DAV URL is invalid', {
      provider: 'nzbdav', retryable: false, httpStatus: 400,
    });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new PlaybackProviderError('invalid-config', 'NZB DAV URL must use HTTP or HTTPS', {
      provider: 'nzbdav', retryable: false, httpStatus: 400,
    });
  }
  const apiKey = String(input.apiKey || '').trim();
  if (!apiKey) {
    throw new PlaybackProviderError('invalid-config', 'NZB DAV API key is required', {
      provider: 'nzbdav', retryable: false, httpStatus: 400,
    });
  }
  return { url: raw, apiKey };
}

function requestSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (timer.unref) timer.unref();
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', onAbort);
    },
  };
}

async function apiRequest(config, params, options) {
  const cfg = cleanConfig(config);
  const opts = options || {};
  const query = new URLSearchParams(Object.assign({}, params, {
    apikey: cfg.apiKey,
    output: 'json',
  }));
  const url = cfg.url + '/api?' + query.toString();
  const timeoutMs = Math.max(250, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const abort = requestSignal(opts.signal, timeoutMs);
  const fetchImpl = opts.fetchImpl || fetchDefault;
  let response;
  let body;
  try {
    response = await fetchImpl(url, Object.assign({}, opts.request || {}, {
      signal: abort.signal,
      headers: Object.assign({ Accept: 'application/json' },
        (opts.request && opts.request.headers) || {}),
    }));
    // Keep the same deadline active while consuming the body. A peer that
    // sends headers and then stalls must not escape the request budget.
    body = await response.text();
  } catch (error) {
    const timedOut = abort.timedOut();
    throw new PlaybackProviderError(timedOut ? 'timeout' : 'network',
      timedOut ? 'NZB DAV request timed out' : 'NZB DAV request failed', {
        provider: 'nzbdav', retryable: true, cause: error,
      });
  } finally {
    abort.cleanup();
  }

  let payload = null;
  if (body) {
    try { payload = JSON.parse(body); }
    catch (_) { /* handled below */ }
  }
  if (!response.ok) {
    throw new PlaybackProviderError(response.status === 401 ? 'auth-failed' : 'http-error',
      'NZB DAV returned HTTP ' + response.status, {
        provider: 'nzbdav', retryable: response.status >= 500,
        httpStatus: response.status,
      });
  }
  if (!payload) {
    throw new PlaybackProviderError('invalid-response', 'NZB DAV returned invalid JSON', {
      provider: 'nzbdav', retryable: true,
    });
  }
  if (payload.status === false) {
    throw new PlaybackProviderError('rejected',
      String(payload.error || 'NZB DAV rejected the request'), {
        provider: 'nzbdav', retryable: false, httpStatus: 422,
      });
  }
  return payload;
}

function nzbBuffer(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input || ''), 'utf8');
  if (buffer.length === 0 || buffer.length > MAX_NZB_BYTES) {
    throw new PlaybackProviderError('invalid-nzb', 'NZB is empty or exceeds the size limit', {
      provider: 'nzbdav', retryable: false, httpStatus: 400,
    });
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf8');
  if (!/<nzb(?:\s|>)/i.test(sample)) {
    throw new PlaybackProviderError('invalid-nzb', 'Payload is not an NZB document', {
      provider: 'nzbdav', retryable: false, httpStatus: 400,
    });
  }
  return buffer;
}

function safeJobName(title) {
  return String(title || 'sss-usenet')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'sss-usenet';
}

async function submitNzb(config, input, options) {
  const opts = options || {};
  const nzb = nzbBuffer(input);
  const name = safeJobName(opts.title);
  const boundary = 'sss-' + crypto.randomBytes(12).toString('hex');
  const head = Buffer.from('--' + boundary + '\r\n'
    + 'Content-Disposition: form-data; name="nzbFile"; filename="' + name + '.nzb"\r\n'
    + 'Content-Type: application/x-nzb\r\n\r\n', 'utf8');
  const tail = Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8');
  const body = Buffer.concat([head, nzb, tail]);
  const payload = await apiRequest(config, {
    mode: 'addfile',
    cat: String(opts.category || 'sports'),
    nzbname: name,
  }, Object.assign({}, opts, {
    request: {
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': String(body.length),
      },
      body,
    },
  }));
  const ids = Array.isArray(payload.nzo_ids) ? payload.nzo_ids.map(String) : [];
  if (ids.length === 0) {
    throw new PlaybackProviderError('invalid-response', 'NZB DAV returned no job id', {
      provider: 'nzbdav', retryable: true,
    });
  }
  return { jobId: ids[0], jobIds: ids, raw: payload };
}

function getQueue(config, options) {
  return apiRequest(config, { mode: 'queue' }, options);
}

function getHistory(config, options) {
  const opts = options || {};
  return apiRequest(config, {
    mode: 'history',
    start: String(Number(opts.start) || 0),
    limit: String(Number(opts.limit) || 50),
  }, opts);
}

function slotsFrom(payload, section) {
  const container = payload && payload[section];
  return container && Array.isArray(container.slots) ? container.slots : [];
}

function slotId(slot) {
  return String((slot && (slot.nzo_id || slot.nzoId || slot.id)) || '');
}

function delay(ms, signal) {
  if (signal && signal.aborted) return Promise.reject(new PlaybackProviderError(
    'cancelled', 'NZB DAV job wait was cancelled', {
      provider: 'nzbdav', retryable: true, httpStatus: 499,
    }
  ));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (timer.unref) timer.unref();
    if (!signal) return;
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new PlaybackProviderError('cancelled', 'NZB DAV job wait was cancelled', {
        provider: 'nzbdav', retryable: true, httpStatus: 499,
      }));
    }, { once: true });
  });
}

async function waitForJob(config, jobId, options) {
  if (!jobId) throw new TypeError('jobId is required');
  const opts = options || {};
  const timeoutMs = Math.max(250, Number(opts.jobTimeoutMs) || DEFAULT_JOB_TIMEOUT_MS);
  const pollIntervalMs = Math.max(1,
    Number(opts.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (opts.signal && opts.signal.aborted) {
      throw new PlaybackProviderError('cancelled', 'NZB DAV job wait was cancelled', {
        provider: 'nzbdav', retryable: true, httpStatus: 499,
      });
    }
    const remaining = deadline - Date.now();
    const requestOptions = Object.assign({}, opts, {
      timeoutMs: Math.min(Number(opts.requestTimeoutMs) || DEFAULT_TIMEOUT_MS,
        Math.max(250, remaining)),
    });
    const [history, queue] = await Promise.all([
      getHistory(config, requestOptions),
      getQueue(config, requestOptions),
    ]);
    const completed = slotsFrom(history, 'history')
      .find((slot) => slotId(slot) === String(jobId));
    if (completed) {
      const status = String(completed.status || '').toLowerCase();
      if (['failed', 'failure', 'deleted'].includes(status)) {
        throw new PlaybackProviderError('job-failed',
          String(completed.fail_message || completed.error || 'NZB DAV job failed'), {
            provider: 'nzbdav', retryable: false, httpStatus: 422,
          });
      }
      if (['completed', 'complete', 'finished', 'success'].includes(status)) {
        return { jobId: String(jobId), status: 'completed', slot: completed };
      }
    }

    const queued = slotsFrom(queue, 'queue')
      .find((slot) => slotId(slot) === String(jobId));
    if (queued) {
      const status = String(queued.status || '').toLowerCase();
      if (['failed', 'failure'].includes(status)) {
        throw new PlaybackProviderError('job-failed',
          String(queued.fail_message || queued.error || 'NZB DAV job failed'), {
            provider: 'nzbdav', retryable: false, httpStatus: 422,
          });
      }
    }

    const waitMs = Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()));
    if (waitMs > 0) await (opts.sleep || delay)(waitMs, opts.signal);
  }

  throw new PlaybackProviderError('job-timeout', 'NZB DAV job did not become playable in time', {
    provider: 'nzbdav', retryable: true, httpStatus: 504,
  });
}

function removeFromQueue(config, jobId, options) {
  if (!jobId) throw new TypeError('jobId is required');
  return apiRequest(config, {
    mode: 'queue', name: 'delete', value: String(jobId),
  }, options);
}

async function testConnection(config, options) {
  try {
    const payload = await apiRequest(config, { mode: 'version' }, options);
    return { ok: true, version: payload.version || null };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof PlaybackProviderError ? error.code : 'provider-failed',
    };
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  MAX_NZB_BYTES,
  cleanConfig,
  safeJobName,
  submitNzb,
  getQueue,
  getHistory,
  waitForJob,
  removeFromQueue,
  testConnection,
  _apiRequest: apiRequest,
};
