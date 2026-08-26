'use strict';

// Native text-only Usenet discovery for sports/events. Supports a direct
// Newznab-compatible endpoint (including NZBHydra) or Prowlarr's aggregate
// JSON search endpoint. SSS owns title generation and relevance filtering.

const fetchDefault = require('node-fetch');
const httpAgent = require('../http-agent');
const { PlaybackProviderError } = require('../playback-provider');

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_RESULTS = 100;

function cleanConfig(input) {
  const cfg = input || {};
  const kind = String(cfg.kind || 'newznab').toLowerCase() === 'prowlarr'
    ? 'prowlarr' : 'newznab';
  const raw = String(cfg.url || '').trim().replace(/\/+$/, '');
  let parsed;
  try { parsed = new URL(raw); }
  catch (_) {
    throw new PlaybackProviderError('invalid-config', 'Usenet search URL is invalid', {
      provider: 'usenet-indexer', retryable: false, httpStatus: 400,
    });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new PlaybackProviderError('invalid-config',
      'Usenet search URL must use HTTP(S) and must not contain credentials', {
        provider: 'usenet-indexer', retryable: false, httpStatus: 400,
      });
  }
  const apiKey = String(cfg.apiKey || '').trim();
  if (!apiKey) {
    throw new PlaybackProviderError('invalid-config', 'Usenet search API key is required', {
      provider: 'usenet-indexer', retryable: false, httpStatus: 400,
    });
  }
  return {
    enabled: cfg.enabled === true,
    kind,
    url: raw,
    apiKey,
    name: String(cfg.name || (kind === 'prowlarr' ? 'Prowlarr' : 'Newznab')).trim().slice(0, 80),
  };
}

function providerConfig(userConfig) {
  const cfg = userConfig || {};
  return {
    enabled: cfg.diyNativeSearchEnabled === true,
    kind: cfg.diySearchKind || 'newznab',
    url: cfg.diySearchUrl || '',
    apiKey: cfg.diySearchApiKey || '',
    name: cfg.diySearchName || '',
  };
}

function isConfigured(config) {
  try {
    const cfg = cleanConfig(config);
    return cfg.enabled && Boolean(cfg.url && cfg.apiKey);
  } catch (_) { return false; }
}

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tagValue(xml, name) {
  const match = String(xml).match(new RegExp(
    '<(?:[A-Za-z_][\\w.-]*:)?' + name + '\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?' + name + '>',
    'i'));
  if (!match) return '';
  const value = match[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim();
  return decodeXml(value);
}

function absoluteDownloadUrl(value, endpoint, apiKey) {
  let parsed;
  try { parsed = new URL(String(value || ''), endpoint); }
  catch (_) { return ''; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return '';
  const endpointOrigin = new URL(endpoint).origin;
  if (parsed.origin === endpointOrigin && !parsed.searchParams.has('apikey')) {
    parsed.searchParams.set('apikey', apiKey);
  }
  return parsed.toString();
}

function parseNewznabXml(xml, endpoint, apiKey, indexerName) {
  const results = [];
  const itemPattern = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemPattern.exec(String(xml || ''))) && results.length < MAX_RESULTS) {
    const block = match[1];
    const attrs = {};
    const attrPattern = /<(?:[A-Za-z_][\w.-]*:)?attr\b[^>]*\bname=["']([^"']+)["'][^>]*\bvalue=["']([^"']*)["'][^>]*\/?\s*>/gi;
    let attr;
    while ((attr = attrPattern.exec(block))) attrs[String(attr[1]).toLowerCase()] = decodeXml(attr[2]);
    const enclosure = block.match(/<enclosure\b([^>]*)>/i);
    const enclosureAttrs = enclosure ? enclosure[1] : '';
    const enclosureUrl = (enclosureAttrs.match(/\burl=["']([^"']+)["']/i) || [])[1] || '';
    const enclosureLength = (enclosureAttrs.match(/\blength=["']([^"']+)["']/i) || [])[1] || '';
    const title = tagValue(block, 'title');
    const rawLink = tagValue(block, 'link') || enclosureUrl || tagValue(block, 'guid');
    const nzbUrl = absoluteDownloadUrl(decodeXml(rawLink), endpoint, apiKey);
    if (!title || !nzbUrl) continue;
    results.push({
      title,
      nzbUrl,
      size: Number(attrs.size || enclosureLength) || 0,
      publishedAt: tagValue(block, 'pubDate') || null,
      indexer: attrs.indexer || indexerName || 'Newznab',
      attrs,
    });
  }
  return results;
}

async function responseText(response) {
  const declared = Number(response.headers && response.headers.get
    ? response.headers.get('content-length') : 0) || 0;
  if (declared > MAX_RESPONSE_BYTES) throw new PlaybackProviderError(
    'response-too-large', 'Usenet search response exceeded its size limit', {
      provider: 'usenet-indexer', retryable: false, httpStatus: 422,
    });
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_RESPONSE_BYTES) {
      if (response.body.destroy) response.body.destroy();
      throw new PlaybackProviderError('response-too-large',
        'Usenet search response exceeded its size limit', {
          provider: 'usenet-indexer', retryable: false, httpStatus: 422,
        });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function searchOne(query, config, options) {
  const cfg = cleanConfig(config);
  const opts = options || {};
  const controller = new AbortController();
  const timeoutMs = Math.max(500, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let endpoint;
  const headers = { Accept: cfg.kind === 'prowlarr' ? 'application/json' : 'application/rss+xml, application/xml, text/xml' };
  if (cfg.kind === 'prowlarr') {
    endpoint = cfg.url + '/api/v1/search';
    const url = new URL(endpoint);
    url.searchParams.set('query', query);
    url.searchParams.set('type', 'search');
    url.searchParams.set('limit', String(MAX_RESULTS));
    endpoint = url.toString();
    headers['X-Api-Key'] = cfg.apiKey;
  } else {
    endpoint = /\/api$/i.test(new URL(cfg.url).pathname) ? cfg.url : cfg.url + '/api';
    const url = new URL(endpoint);
    url.searchParams.set('t', 'search');
    url.searchParams.set('q', query);
    url.searchParams.set('extended', '1');
    url.searchParams.set('limit', String(MAX_RESULTS));
    url.searchParams.set('apikey', cfg.apiKey);
    endpoint = url.toString();
  }
  try {
    const response = await (opts.fetchImpl || fetchDefault)(endpoint,
      httpAgent.fetchOpts({ method: 'GET', headers, signal: controller.signal }, endpoint));
    const body = await responseText(response);
    if (!response.ok) throw new PlaybackProviderError(
      response.status === 401 || response.status === 403 ? 'auth-failed' : 'http-error',
      'Usenet search returned HTTP ' + response.status, {
        provider: 'usenet-indexer', retryable: response.status >= 500, httpStatus: response.status,
      });
    if (cfg.kind === 'prowlarr') {
      let payload;
      try { payload = JSON.parse(body); }
      catch (_) { throw new PlaybackProviderError('invalid-response', 'Prowlarr returned invalid JSON', { provider: 'usenet-indexer', retryable: true }); }
      return (Array.isArray(payload) ? payload : []).filter((item) =>
        !item.protocol || String(item.protocol).toLowerCase() === 'usenet').slice(0, MAX_RESULTS)
        .map((item) => ({
          title: String(item.title || '').trim(),
          nzbUrl: absoluteDownloadUrl(item.downloadUrl || item.guid, cfg.url, cfg.apiKey),
          size: Number(item.size) || 0,
          publishedAt: item.publishDate || null,
          indexer: item.indexer || cfg.name,
          attrs: {},
        })).filter((item) => item.title && item.nzbUrl);
    }
    return parseNewznabXml(body, endpoint, cfg.apiKey, cfg.name);
  } catch (error) {
    if (error instanceof PlaybackProviderError) throw error;
    throw new PlaybackProviderError(controller.signal.aborted ? 'timeout' : 'network',
      controller.signal.aborted ? 'Usenet search timed out' : 'Usenet search request failed', {
        provider: 'usenet-indexer', retryable: true, cause: error,
      });
  } finally {
    clearTimeout(timer);
  }
}

async function search(queries, config, options) {
  const cfg = cleanConfig(config);
  if (!cfg.enabled) return { ok: false, error: 'disabled', results: [] };
  const opts = options || {};
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const unique = Array.from(new Set((queries || []).map((q) => String(q || '').trim())
    .filter(Boolean))).slice(0, Math.max(1, Number(opts.maxQueries) || 12));
  if (!unique.length) return { ok: true, results: [] };
  log('native usenet: searching ' + unique.length + ' title variant(s) via ' + cfg.name);
  try {
    const sets = await Promise.all(unique.map((query) => searchOne(query, cfg, opts)));
    const seen = new Set();
    const merged = [];
    for (const item of sets.flat()) {
      const key = item.nzbUrl + '|' + item.title.toLowerCase() + '|' + item.size;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
    log('  native usenet: ' + merged.length + ' unique candidate(s)');
    return { ok: true, results: merged };
  } catch (error) {
    log('  native usenet: ' + (error.code || 'failed') + ' — ' + error.message);
    return { ok: false, error: error.code || 'failed', results: [] };
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES, MAX_RESULTS,
  cleanConfig, providerConfig, isConfigured, parseNewznabXml, searchOne, search,
};
