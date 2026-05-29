// Multi-user account store. Backed by a single JSON file (data/users.json)
// — same on-disk pattern as events.json. No external DB.
//
// Each user record:
//   {
//     id, username, passwordHash, apiToken, role: 'admin'|'user',
//     createdAt, lastSeen, config: { rd, tb, pm, catalogs }
//   }

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const cryptoKeys = require('./crypto-keys');

const USERS_FILE = config.usersFile || './data/users.json';

// 0.25.0: encryption-at-rest for debrid keys. We never store rd/tb/pm in
// plaintext anymore. Conversions are kept tightly scoped: saveAll() encrypts
// before write; the helpers below decrypt on the way out. Existing plaintext
// values from pre-0.25.0 installs are read transparently (crypto-keys.decrypt
// no-ops on non-prefixed input) and re-encrypted on the next save.
const SECRET_FIELDS = ['rd', 'tb', 'pm'];

function encryptUserKeysInPlace(user) {
  if (!user || !user.config) return;
  for (const k of SECRET_FIELDS) {
    if (user.config[k]) user.config[k] = cryptoKeys.encrypt(user.config[k]);
  }
}

// Returns a SHALLOW clone with rd/tb/pm decrypted. Never mutate the original.
function decryptedUser(user) {
  if (!user) return user;
  const cfg = user.config || {};
  const cloneCfg = Object.assign({}, cfg);
  for (const k of SECRET_FIELDS) {
    if (cloneCfg[k]) cloneCfg[k] = cryptoKeys.decrypt(cloneCfg[k]);
  }
  return Object.assign({}, user, { config: cloneCfg });
}

function loadAll() {
  try {
    if (!fs.existsSync(USERS_FILE)) return { users: [], updatedAt: null };
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch (err) {
    console.error('[users] failed to load:', err.message);
    return { users: [], updatedAt: null };
  }
}

function saveAll(state) {
  const dir = path.dirname(USERS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  state.updatedAt = new Date().toISOString();
  // Deep-clone before encrypting so in-memory references (the state object
  // used by the live request) don't end up holding encrypted blobs.
  const toWrite = JSON.parse(JSON.stringify(state));
  for (const u of (toWrite.users || [])) encryptUserKeysInPlace(u);
  // Atomic write — write to .tmp then rename.
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(toWrite, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);
}

function genUserId(username) {
  const slug = (username || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'user';
  return slug + '-' + crypto.randomBytes(2).toString('hex');
}

function genApiToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function hashPassword(plain) {
  return bcrypt.hash(String(plain), 10);
}

async function verifyPassword(plain, hash) {
  if (!plain || !hash) return false;
  try { return await bcrypt.compare(String(plain), hash); }
  catch { return false; }
}

// Precomputed bcrypt hash used to absorb the same ~80–150ms when /login is
// called with an unknown username. Without this, response time leaks whether
// a username exists (no bcrypt = ~1ms; real user = ~100ms). The actual plain-
// text doesn't matter and the result is always discarded.
const DUMMY_HASH = bcrypt.hashSync('serioussportsync-timing-mask', 10);
async function verifyDummy(plain) {
  try { await bcrypt.compare(String(plain || ''), DUMMY_HASH); } catch {}
  return false;
}

function findByUsername(username) {
  if (!username) return null;
  const u = (username || '').toLowerCase();
  const raw = loadAll().users.find((x) => (x.username || '').toLowerCase() === u) || null;
  return decryptedUser(raw);
}

function findById(id) {
  if (!id) return null;
  const raw = loadAll().users.find((x) => x.id === id) || null;
  return decryptedUser(raw);
}

// Constant-time comparison to avoid token-timing leaks.
function findByApiToken(userId, apiToken) {
  if (!userId || !apiToken) return null;
  const u = findById(userId);
  if (!u || !u.apiToken) return null;
  const a = Buffer.from(u.apiToken);
  const b = Buffer.from(String(apiToken));
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? u : null;
}

async function createUser({ username, password, role }) {
  if (!username || !password) throw new Error('username and password required');
  if (String(password).length < 8) throw new Error('password must be at least 8 characters');
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    throw new Error('username must be 3-32 chars, [A-Za-z0-9_.-]');
  }
  const state = loadAll();
  if (state.users.find((u) => (u.username || '').toLowerCase() === username.toLowerCase())) {
    throw new Error('username already taken');
  }
  // Bootstrap rule: username matching ADMIN_USER env auto-promotes to admin.
  const matchesAdminEnv = config.admin && config.admin.user &&
    username.toLowerCase() === config.admin.user.toLowerCase();
  const finalRole = (role === 'admin' || matchesAdminEnv) ? 'admin' : 'user';

  const user = {
    id: genUserId(username),
    username,
    passwordHash: await hashPassword(password),
    apiToken: genApiToken(),
    role: finalRole,
    createdAt: new Date().toISOString(),
    lastSeen: null,
    config: { rd: '', tb: '', pm: '', catalogs: [], autoCache: { rd: false, tb: false, pm: false }, maxStreams: 0 },
  };
  state.users.push(user);
  saveAll(state);
  return user;
}

function updateUser(id, patch) {
  const state = loadAll();
  const u = state.users.find((x) => x.id === id);
  if (!u) throw new Error('user not found');
  Object.assign(u, patch || {});
  saveAll(state);
  return u;
}

function updateUserConfig(id, patch) {
  const state = loadAll();
  const u = state.users.find((x) => x.id === id);
  if (!u) throw new Error('user not found');
  u.config = Object.assign({}, u.config || {}, patch || {});
  saveAll(state);
  return u;
}

function deleteUser(id) {
  const state = loadAll();
  const idx = state.users.findIndex((u) => u.id === id);
  if (idx === -1) return false;
  state.users.splice(idx, 1);
  saveAll(state);
  return true;
}

function regenerateApiToken(id) {
  return updateUser(id, { apiToken: genApiToken() });
}

function listUsers() {
  return loadAll().users.slice();
}

function userCount() {
  return loadAll().users.length;
}

function touchLastSeen(id) {
  try { updateUser(id, { lastSeen: new Date().toISOString() }); } catch {}
}

// Public-safe view (no passwordHash, truncated apiToken).
function sanitize(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    lastSeen: user.lastSeen,
    apiTokenPreview: user.apiToken ? user.apiToken.slice(0, 8) + '…' : null,
    config: user.config || {},
  };
}


async function setPassword(id, newPlain) {
  if (!newPlain || String(newPlain).length < 8) {
    throw new Error('password must be at least 8 characters');
  }
  const hash = await hashPassword(newPlain);
  return updateUser(id, { passwordHash: hash });
}

function setRole(id, newRole) {
  if (newRole !== 'admin' && newRole !== 'user') throw new Error('role must be admin or user');
  return updateUser(id, { role: newRole });
}

function countAdmins() {
  return loadAll().users.filter((u) => u.role === 'admin').length;
}

// Invite tokens: server-generated random strings stored in users.json.
// Admin creates -> shares URL -> recipient sets their password -> account
// created and invite is consumed (deleted) atomically.
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function listInvites() {
  const st = loadAll();
  return (st.invites || []).slice();
}

function cleanExpiredInvites() {
  const st = loadAll();
  const before = (st.invites || []).length;
  st.invites = (st.invites || []).filter((i) => new Date(i.expiresAt).getTime() > Date.now());
  if (st.invites.length !== before) saveAll(st);
}

function findInvite(token) {
  if (!token) return null;
  cleanExpiredInvites();
  return (loadAll().invites || []).find((i) => i.token === token) || null;
}

function createInvite({ username, role }) {
  if (!username || !/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    throw new Error('username must be 3-32 chars, [A-Za-z0-9_.-]');
  }
  const st = loadAll();
  if ((st.users || []).find((u) => (u.username || '').toLowerCase() === username.toLowerCase())) {
    throw new Error('a user with that username already exists');
  }
  if ((st.invites || []).find((i) => (i.username || '').toLowerCase() === username.toLowerCase())) {
    throw new Error('an invite for that username is already outstanding');
  }
  const token = crypto.randomBytes(24).toString('hex');
  const inv = {
    token,
    username,
    role: role === 'admin' ? 'admin' : 'user',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
  };
  st.invites = (st.invites || []).concat([inv]);
  saveAll(st);
  return inv;
}

function revokeInvite(token) {
  const st = loadAll();
  const before = (st.invites || []).length;
  st.invites = (st.invites || []).filter((i) => i.token !== token);
  const removed = st.invites.length !== before;
  if (removed) saveAll(st);
  return removed;
}

// Atomic: validate the invite, create the user with the chosen password,
// and remove the invite. Returns the created user record.
async function consumeInvite(token, password) {
  const inv = findInvite(token);
  if (!inv) throw new Error('invite not found or expired');
  // Atomic by load-mutate-save through createUser + revokeInvite. There's a
  // tiny TOCTOU window between createUser and revokeInvite, but the username
  // uniqueness check inside createUser prevents duplicate use.
  const user = await createUser({ username: inv.username, password, role: inv.role });
  revokeInvite(token);
  return user;
}

module.exports = {
  createUser, updateUser, updateUserConfig, deleteUser, regenerateApiToken,
  findByUsername, findById, findByApiToken,
  listUsers, userCount, touchLastSeen,
  verifyPassword, verifyDummy, sanitize,
  setPassword, setRole, countAdmins,
  createInvite, findInvite, consumeInvite, revokeInvite, listInvites, cleanExpiredInvites,
};
