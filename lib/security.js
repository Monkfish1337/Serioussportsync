'use strict';

const net = require('net');
const config = require('../config');
const redact = require('./redact');

const CLOUD_METADATA_HOSTS = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
  'metadata.google.internal',
  'metadata.google',
  'fd00:ec2::254',
]);

function firstHeader(value) {
  return String(value || '').split(',')[0].trim();
}

function requestHost(req) {
  const forwarded = config.trustProxy ? firstHeader(req.headers['x-forwarded-host']) : '';
  return forwarded || firstHeader(req.headers.host);
}

function requestProto(req) {
  const forwarded = config.trustProxy ? firstHeader(req.headers['x-forwarded-proto']).toLowerCase() : '';
  if (forwarded === 'http' || forwarded === 'https') return forwarded;
  if (req.secure || (req.socket && req.socket.encrypted)) return 'https';
  return 'http';
}

function validHost(value) {
  if (!value || /[\\/\s@]/.test(value)) return '';
  try {
    const parsed = new URL('http://' + value);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return '';
    return parsed.host;
  } catch (_) { return ''; }
}

function publicOrigin(req) {
  if (config.publicUrl) {
    try {
      const parsed = new URL(config.publicUrl);
      if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) {
        return parsed.origin;
      }
    } catch (_) { /* fall through */ }
  }
  const host = validHost(requestHost(req));
  return host ? requestProto(req) + '://' + host : '';
}

function isCloudMetadataHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (CLOUD_METADATA_HOSTS.has(host)) return true;
  if (net.isIP(host) === 4) {
    const parts = host.split('.').map(Number);
    return parts[0] === 169 && parts[1] === 254;
  }
  return false;
}

function cleanHttpUrl(value, options) {
  const opts = options || {};
  const raw = String(value || '').trim();
  if (!raw && opts.allowEmpty !== false) return '';
  if (raw.length > (opts.maxLength || 2048)) throw new Error((opts.label || 'URL') + ' is too long');
  let parsed;
  try { parsed = new URL(raw); }
  catch (_) { throw new Error((opts.label || 'URL') + ' is invalid'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error((opts.label || 'URL') + ' must use HTTP or HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw new Error((opts.label || 'URL') + ' must not contain credentials');
  }
  if (!opts.allowSensitiveQuery) {
    for (const key of parsed.searchParams.keys()) {
      if (/^(?:api[_-]?key|apikey|token|access[_-]?token|passkey|password|secret)$/i.test(key)) {
        throw new Error((opts.label || 'URL') + ' must keep credentials in the separate secret field');
      }
    }
  }
  if (isCloudMetadataHost(parsed.hostname)) {
    throw new Error((opts.label || 'URL') + ' cannot target a cloud metadata address');
  }
  return raw.replace(/\/+$/, '');
}

function safeErrorMessage(error) {
  return redact.redact(error && error.message ? error.message : String(error || 'Unknown error')).slice(0, 500);
}

function assertRuntimeConfig() {
  const secret = String(config.sessionSecret || '');
  if (secret.length < 32 && process.env.ALLOW_INSECURE_SECRET !== '1') {
    throw new Error('SESSION_SECRET must be set to a random string of at least 32 characters');
  }
  if (config.publicUrl) cleanHttpUrl(config.publicUrl, { label: 'PUBLIC_URL', allowEmpty: false });
}

function isAddonApiPath(pathname) {
  const value = String(pathname || '');
  return value === '/manifest.json'
    || value.startsWith('/catalog/')
    || value.startsWith('/meta/')
    || value.startsWith('/stream/')
    || value.startsWith('/u/');
}

function headers(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    // 0.93.0 — jsdelivr is gone from all three of these. It was here for the
    // Tabler CDN build, which 0.90.0 vendored and 0.92.0 removed entirely; a
    // policy that still permits a script host nothing loads from is a standing
    // invitation with no benefit.
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    // api.nuvio.tv is the one cross-origin destination the browser is allowed
    // to reach: the Nuvio push signs in and writes collections FROM THE PAGE,
    // so that the account password and token never touch this server. Nothing
    // else is permitted, so a compromised page cannot exfiltrate anywhere.
    "connect-src 'self' https://api.nuvio.tv",
    "media-src 'self' http: https: blob:",
  ].join('; '));
  if (/^\/(?:admin(?:\/|$)|account(?:\/|$)|login$|setup$|invite\/)/.test(req.path || '')) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
}

function cors(req, res, next) {
  if (!isAddonApiPath(req.path)) return next();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

function csrf(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site === 'cross-site') return res.status(403).send('Cross-site request rejected.');
  const origin = firstHeader(req.headers.origin);
  if (!origin) return next();
  // Sandboxed/private browser contexts (including some installed-app webviews)
  // serialize a legitimate form origin as `null` and may omit Sec-Fetch-Site.
  // Explicit cross-site requests were rejected above; accepting `null` here is
  // equivalent to the already-supported no-Origin client path. The session
  // cookie remains SameSite=Lax, so a cross-site POST cannot carry login state.
  if (origin === 'null') return next();
  let originHost;
  try { originHost = new URL(origin).host; }
  catch (_) { return res.status(403).send('Invalid request origin.'); }
  const allowed = new Set([validHost(requestHost(req))].filter(Boolean));
  if (config.publicUrl) {
    try { allowed.add(new URL(config.publicUrl).host); } catch (_) { /* invalid value is ignored */ }
  }
  if (!allowed.has(originHost)) return res.status(403).send('Cross-site request rejected.');
  next();
}

module.exports = {
  assertRuntimeConfig,
  cleanHttpUrl,
  cors,
  csrf,
  headers,
  isAddonApiPath,
  isCloudMetadataHost,
  publicOrigin,
  requestHost,
  requestProto,
  safeErrorMessage,
  validHost,
};
