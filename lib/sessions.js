// Stateless session cookies. Format:
// <userId>.<expiryMs>.<sessionVersion>.<hmac-sha256-hex>.
// Signed with SESSION_SECRET — leaked cookies on one server are useless on
// another. No server-side session store; verification is purely the HMAC.

const crypto = require('crypto');
const config = require('../config');

const COOKIE_NAME = 'sss_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getSecret() {
  const fromEnv = config.sessionSecret;
  if (fromEnv && fromEnv.length >= 32) return fromEnv;
  if (process.env.ALLOW_INSECURE_SECRET === '1') {
    return fromEnv || 'serioussportsync-explicit-insecure-dev-session-secret';
  }
  throw new Error('SESSION_SECRET must be at least 32 characters');
}

function sign(data) {
  return crypto.createHmac('sha256', getSecret()).update(data).digest('hex');
}

function createToken(userId, sessionVersion) {
  const exp = Date.now() + SESSION_TTL_MS;
  const version = Math.max(1, parseInt(sessionVersion, 10) || 1);
  const data = userId + '.' + exp + '.' + version;
  return data + '.' + sign(data);
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  // Accept pre-0.64 three-part cookies as sessionVersion 1 so upgrades do not
  // log everyone out; password/role changes bump the stored version and still
  // revoke those old cookies immediately.
  if (parts.length !== 3 && parts.length !== 4) return null;
  const legacy = parts.length === 3;
  const userId = parts[0];
  const expStr = parts[1];
  const versionStr = legacy ? '1' : parts[2];
  const sig = legacy ? parts[2] : parts[3];
  const data = legacy ? userId + '.' + expStr : userId + '.' + expStr + '.' + versionStr;
  const expected = sign(data);
  // Constant-time compare
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  const sessionVersion = parseInt(versionStr, 10);
  if (!Number.isFinite(sessionVersion) || sessionVersion < 1) return null;
  return { userId, exp, sessionVersion };
}

function readSession(req) {
  const cookie = req.headers.cookie || '';
  const re = new RegExp('(^|;\\s*)' + COOKIE_NAME + '=([^;]+)');
  const m = cookie.match(re);
  if (!m) return null;
  return verifyToken(decodeURIComponent(m[2]));
}

// True when the request came in over HTTPS. Forwarded protocol is considered
// only when the operator explicitly enables TRUST_PROXY; otherwise it is an
// attacker-controlled request header. Direct TLS still uses the connection flag.
function isHttps(req) {
  if (!req) return false;
  const xfp = config.trustProxy
    ? (req.headers && req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
    : '';
  if (xfp === 'https') return true;
  if (req.secure === true) return true;
  if (req.connection && req.connection.encrypted) return true;
  return false;
}

function setCookie(res, userOrId, req) {
  const userId = userOrId && typeof userOrId === 'object' ? userOrId.id : userOrId;
  const sessionVersion = userOrId && typeof userOrId === 'object' ? userOrId.sessionVersion : 1;
  const token = createToken(userId, sessionVersion);
  // SameSite=Lax so install link from same domain works; HttpOnly so JS can't
  // steal it; Secure added automatically when the request is HTTPS (0.22.2).
  // Plain-HTTP dev still works because Secure is only added when detected.
  const secure = isHttps(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    COOKIE_NAME + '=' + encodeURIComponent(token) +
    '; HttpOnly; Path=/; SameSite=Lax' + secure +
    '; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000)
  );
}

function clearCookie(res, req) {
  const secure = isHttps(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    COOKIE_NAME + '=; HttpOnly; Path=/; SameSite=Lax' + secure + '; Max-Age=0'
  );
}

module.exports = { createToken, verifyToken, readSession, setCookie, clearCookie, COOKIE_NAME };
