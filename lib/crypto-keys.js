// Encryption-at-rest for sensitive per-user values (0.25.0).
//
// Used by lib/users.js to keep Real-Debrid / TorBox / Premiumize API keys
// encrypted inside data/users.json. Decryption happens only in memory on
// each load. Stolen volume backups no longer leak the keys in plaintext.
//
// Algorithm: AES-256-GCM (authenticated). Key derived from SESSION_SECRET
// via scrypt (deterministic, no extra moving parts). Layout per value:
//   "enc:" + base64( iv[12] | ciphertext | tag[16] )
//
// Backward-compat: decrypt() returns the input unchanged if it doesn't
// carry the "enc:" prefix, so pre-0.25.0 plaintext keys keep working until
// the next save naturally re-encrypts them. encrypt() is a no-op on values
// already prefixed with "enc:" — safe to call repeatedly.
//
// Rotating SESSION_SECRET invalidates every encrypted value (and all
// sessions) — users would need to re-paste their debrid keys. That's a
// tolerable consequence: a SESSION_SECRET rotation is itself a security
// event, treating any in-memory secret as compromised is the right move.

const crypto = require('crypto');

const ALGO    = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN  = 12;
const TAG_LEN = 16;
const PREFIX  = 'enc:';

let _keyCache = null;
function getKey() {
  if (_keyCache) return _keyCache;
  // server.js hard-fails boot if SESSION_SECRET is missing or weak (0.22.2),
  // so in production this is always strong. ALLOW_INSECURE_SECRET dev mode
  // still gets a valid (if weaker) key from whatever is set.
  const secret = process.env.SESSION_SECRET
    || 'serioussportsync-fallback-only-for-dev-' + (process.env.ADMIN_USER || 'unknown');
  _keyCache = crypto.scryptSync(secret, 'sss-keys-salt-v1', KEY_LEN);
  return _keyCache;
}

function encrypt(plain) {
  if (plain == null || plain === '') return plain;
  if (typeof plain !== 'string') return plain;
  if (plain.startsWith(PREFIX)) return plain; // already encrypted
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, ct, tag]).toString('base64');
}

function decrypt(maybeCipher) {
  if (maybeCipher == null || maybeCipher === '') return maybeCipher;
  if (typeof maybeCipher !== 'string') return maybeCipher;
  if (!maybeCipher.startsWith(PREFIX)) return maybeCipher; // plaintext / legacy
  let buf;
  try { buf = Buffer.from(maybeCipher.slice(PREFIX.length), 'base64'); }
  catch { return ''; }
  if (buf.length < IV_LEN + TAG_LEN) return '';
  const iv  = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct  = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const key = getKey();
  try {
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch (err) {
    console.error('[crypto-keys] decrypt failed:', err.message);
    return ''; // surface as "no key" rather than crashing
  }
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

module.exports = { encrypt, decrypt, isEncrypted, PREFIX };
