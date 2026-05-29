// Time-limited HMAC signature for /resolve URLs (0.25.0).
//
// Background: the per-play /resolve URLs that streams.js advertises used to
// be permanent — once anyone learned one (proxy log, screenshot, shared in a
// support thread) it kept working forever using the URL owner's debrid quota
// until they manually rotated their API token. With this module, each URL
// carries ?exp=<unixMs>&sig=<hmac> and the /resolve route validates both —
// rejected on expiry or signature mismatch.
//
// The install URL itself (apiToken in the path) is NOT changed: it stays
// stable so clients don't need a re-install after every code update. Only
// the short, ephemeral play-click URLs rotate.
//
// Signature inputs: userId, provider (lowercase), eventId (raw), infoHash
// (lowercase), exp. Secret: SESSION_SECRET (0.22.2 hard-fails boot when
// missing, so we can rely on it being present and strong).

const crypto = require('crypto');

const TTL_MIN = Math.max(5, parseInt(process.env.RESOLVE_URL_TTL_MINUTES || '240', 10));
const DEFAULT_TTL_MS = TTL_MIN * 60 * 1000;

function getSecret() {
  return process.env.SESSION_SECRET || 'serioussportsync-fallback-only-for-dev';
}

function normProv(p) { return String(p || '').toLowerCase(); }
function normHash(h) { return String(h || '').toLowerCase(); }

function computeSig(userId, provider, eventId, infoHash, exp) {
  const data = [String(userId), normProv(provider), String(eventId), normHash(infoHash), String(exp)].join('|');
  return crypto.createHmac('sha256', getSecret()).update(data).digest('hex').slice(0, 32);
}

// Returns { exp, sig } for embedding into the resolve URL query string.
function signResolve(opts) {
  const exp = (opts && opts.exp) || (Date.now() + DEFAULT_TTL_MS);
  const sig = computeSig(opts.userId, opts.provider, opts.eventId, opts.infoHash, exp);
  return { exp, sig };
}

// Returns { ok, reason }. Reasons: missing-signature, invalid-exp, expired,
// bad-signature. Constant-time compare on the signature.
function verifyResolve(opts) {
  const exp = opts && opts.exp;
  const sig = opts && opts.sig;
  if (!exp || !sig) return { ok: false, reason: 'missing-signature' };
  const expNum = parseInt(String(exp), 10);
  if (!Number.isFinite(expNum)) return { ok: false, reason: 'invalid-exp' };
  if (Date.now() > expNum) return { ok: false, reason: 'expired' };
  const expected = computeSig(opts.userId, opts.provider, opts.eventId, opts.infoHash, expNum);
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return { ok: false, reason: 'bad-signature' };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad-signature' };
  return { ok: true };
}

module.exports = { signResolve, verifyResolve, DEFAULT_TTL_MS, TTL_MIN };
