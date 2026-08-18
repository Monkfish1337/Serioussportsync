// Per-user Comet manifest forwarding.
//
// SeriousSportSync remains the installed catalog/meta addon. When an event is
// opened, SSS asks the configured Comet manifest's matching stream endpoint
// for that SSS event ID and returns the resulting rows unchanged. Playback
// therefore stays on Comet and the user's configured debrid service.

const fetch = require('node-fetch');
const httpAgent = require('../http-agent');

function allowedHosts() {
  return new Set(String(process.env.COMET_ALLOWED_HOSTS || '')
    .split(',').map((host) => host.trim().toLowerCase()).filter(Boolean));
}

function parseManifestUrl(manifestUrl) {
  if (!manifestUrl || typeof manifestUrl !== 'string') return null;
  let parsed;
  try { parsed = new URL(manifestUrl.trim()); } catch (_) { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  if (parsed.username || parsed.password) return null;
  if (!parsed.pathname.endsWith('/manifest.json')) return null;
  parsed.hash = '';
  parsed.search = '';

  const allowlist = allowedHosts();
  const host = parsed.host.toLowerCase();
  if (allowlist.size === 0 || !allowlist.has(host)) return null;

  return {
    manifestUrl: parsed.toString(),
    streamBase: parsed.toString().slice(0, -'manifest.json'.length),
  };
}

function buildStreamUrl(comet, mediaType, mediaId) {
  if (!comet || !comet.streamBase || !mediaType || !mediaId) return null;
  return comet.streamBase + 'stream/' + encodeURIComponent(mediaType)
    + '/' + encodeURIComponent(mediaId) + '.json';
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, httpAgent.fetchOpts({
    headers: { Accept: 'application/json' },
    timeout: timeoutMs || 15000,
    redirect: 'manual',
  }, url));
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const payload = await response.json();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('invalid JSON response');
  }
  return payload;
}

async function getStreams(mediaType, mediaId, comet, options) {
  const opts = options || {};
  const log = opts.log || (() => {});
  if (!comet) return [];
  const url = buildStreamUrl(comet, mediaType, mediaId);
  if (!url) return [];
  log('comet: requesting event streams');
  try {
    const payload = await fetchJson(url, opts.timeoutMs);
    const rows = Array.isArray(payload.streams)
      ? payload.streams.filter((row) => row && typeof row === 'object')
      : [];
    log('comet: received ' + rows.length + ' stream row(s)');
    return rows;
  } catch (err) {
    log('comet: request failed: ' + err.message);
    return [];
  }
}

function decodeConfiguredManifest(manifestUrl) {
  try {
    const parsed = new URL(manifestUrl);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2 || parts[parts.length - 1] !== 'manifest.json') return null;
    const encoded = decodeURIComponent(parts[parts.length - 2]);
    const json = Buffer.from(encoded, 'base64').toString('utf8');
    const config = JSON.parse(json);
    return config && typeof config === 'object' ? config : null;
  } catch (_) {
    return null;
  }
}

function sameManifestAccount(first, second) {
  try {
    const a = new URL(first);
    const b = new URL(second);
    return a.pathname === b.pathname;
  } catch (_) {
    return false;
  }
}

async function testManifest(manifestUrl, options) {
  const opts = options || {};
  const comet = parseManifestUrl(manifestUrl);
  if (!comet) {
    return { ok: false, error: 'Invalid or untrusted Comet manifest URL' };
  }
  try {
    const payload = await fetchJson(comet.manifestUrl, opts.timeoutMs || 10000);
    const resources = Array.isArray(payload.resources) ? payload.resources : [];
    const hasStreams = resources.some((resource) => resource === 'stream'
      || (resource && resource.name === 'stream'));
    if (!hasStreams) return { ok: false, error: 'Manifest does not provide streams' };
    const embedded = decodeConfiguredManifest(comet.manifestUrl);
    const configuredSss = embedded && typeof embedded.seriousSportsSyncManifestUrl === 'string'
      ? embedded.seriousSportsSyncManifestUrl.trim() : '';
    const supportsSss = !!configuredSss;
    const expectedSss = String(opts.expectedSssManifestUrl || '').trim();
    const matchesSss = !expectedSss || sameManifestAccount(configuredSss, expectedSss);
    return {
      ok: true,
      name: String(payload.name || 'Comet'),
      supportsSss,
      matchesSss,
      warning: !supportsSss
        ? 'Comet is reachable but its configuration does not include a SeriousSportSync manifest URL.'
        : (!matchesSss ? 'Comet is configured with a different SeriousSportSync account manifest.' : ''),
    };
  } catch (err) {
    return { ok: false, error: err.message || 'Connection failed' };
  }
}

module.exports = {
  parseManifestUrl,
  buildStreamUrl,
  getStreams,
  decodeConfiguredManifest,
  testManifest,
};
