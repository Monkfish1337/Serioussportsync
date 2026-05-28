// Stateless session cookies. Format: <userId>.<expiryMs>.<hmac-sha256-hex>.
// Signed with SESSION_SECRET — leaked cookies on one server are useless on
// another. No server-side session store; verification is purely the HMAC.

const crypto = require('crypto');
const config = require('../config');

const COOKIE_NAME = 'sss_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getSecret() {
  // Fall back to a derived secret if SESSION_SECRET isn't set. Not ideal
  // (server restarts will invalidate existing sessions if the fallback
  // input changes), but at least functional out-of-the-box.
  const fromEnv = config.sessionSecret;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  // Derive from a stable-ish per-install value so sessions persist
  // across container restarts as long as ADMIN_PASSWORD + admin user
  // are unchanged. Users should override with a real SESSION_SECRET.
  const seed = (config.admin && config.admin.password) || 'serioussportsync-default-seed';
  return crypto.createHash('sha256').update('sss-session-secret:' + seed).digest('hex');
}

function sign(data) {
  return crypto.createHmac('sha256', getSecret()).update(data).digest('hex');
}

function createToken(userId) {
  const exp = Date.now() + SESSION_TTL_MS;
  const data = userId + '.' + exp;
  return data + '.' + sign(data);
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, expStr, sig] = parts;
  const data = userId + '.' + expStr;
  const expected = sign(data);
  // Constant-time compare
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  return { userId, exp };
}

function readSession(req) {
  const cookie = req.headers.cookie || '';
  const re = new RegExp('(^|;\\s*)' + COOKIE_NAME + '=([^;]+)');
  const m = cookie.match(re);
  if (!m) return null;
  return verifyToken(decodeURIComponent(m[2]));
}

// True when the request came in over HTTPS. We trust X-Forwarded-Proto from
// reverse proxies / Cloudflare Tunnel because the addon is intended to sit
// behind one in production. Falls back to req.secure (Express, only true if
// trust proxy is enabled) and the connection-level encrypted flag.
function isHttps(req) {
  if (!req) return false;
  const xfp = (req.headers && req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (xfp === 'https') return true;
  if (req.secure === true) return true;
  if (req.connection && req.connection.encrypted) return true;
  return false;
}

function setCookie(res, userId, req) {
  const token = createToken(userId);
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
