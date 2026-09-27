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

// Addresses an account without administrator rights may not make SSS reach:
// loopback, private LANs, link-local, carrier-grade NAT, unique-local IPv6 and
// the unspecified address. Once any account can add its own Usenet indexer,
// its URL (and every NZB link or redirect the indexer returns) is a request
// the server makes on that account's behalf; without this an account could
// point it at the router, Prowlarr or the Docker network.
function isPrivateAddress(address) {
  const value = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  // The URL parser rewrites ::ffff:192.168.1.1 as ::ffff:c0a8:101.
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
  const ip = mapped ? mapped[1] : hexMapped
    ? [parseInt(hexMapped[1], 16) >> 8, parseInt(hexMapped[1], 16) & 255, parseInt(hexMapped[2], 16) >> 8, parseInt(hexMapped[2], 16) & 255].join('.')
    : value;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    return ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || /^ff/.test(ip);
  }
  return false;
}

async function assertPublicUrl(url, options) {
  const opts = options || {};
  let parsed;
  try { parsed = new URL(String(url || '')); }
  catch (_) { throw new Error((opts.label || 'URL') + ' is invalid'); }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const blocked = () => new Error((opts.label || 'URL') + ' must be a public internet address; '
    + 'local and private network addresses are available to administrators only');
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host) || isCloudMetadataHost(host)) throw blocked();
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw blocked();
    return;
  }
  const lookup = opts.lookup || ((name) => require('dns').promises.lookup(name, { all: true, verbatim: true }));
  let addresses;
  try { addresses = await lookup(host); }
  catch (_) { throw new Error((opts.label || 'URL') + ' host could not be resolved'); }
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) throw blocked();
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
  if (/^\/(?:admin(?:\/|$)|account(?:\/|$)|login$|request-access$|setup$|invite\/)/.test(req.path || '')) {
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
  assertPublicUrl,
  assertRuntimeConfig,
  cleanHttpUrl,
  cors,
  csrf,
  headers,
  isAddonApiPath,
  isCloudMetadataHost,
  isPrivateAddress,
  publicOrigin,
  requestHost,
  requestProto,
  safeErrorMessage,
  validHost,
};
