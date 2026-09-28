'use strict';

// The TorBox cache audit asks TorBox, read-only, about saved releases nobody
// has opened yet, so "Cached on TorBox" is measured. Found on v1.3.0: 140 of
// 167 saved events had never been checked.

process.env.SESSION_SECRET ||= 'torbox-audit-test-secret-00000000000000000000000000';
// Every file this test can touch lives in a temporary folder, set before any
// module reads its path (lib/users resolves USERS_FILE when first loaded).
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-audit-'));
process.env.USERS_FILE = path.join(dir, 'users.json');
process.env.AVAILABILITY_DB_FILE = path.join(dir, 'availability.sqlite');
const test = require('node:test');
const assert = require('node:assert/strict');
const audit = require('../lib/torbox-cache-audit');
const { createAvailabilityIndex } = require('../lib/availability-index');

const h = (c) => c.repeat(40);
const admin = [{ role: 'admin', username: 'monkeh', config: { torboxApiKey: 'TB-KEY' } }];
const rows = () => ({ rows: [
  { id: 'mlb:1', name: 'Twins vs Giants', torbox: 'unchecked', hashes: [h('a'), h('b')] },
  { id: 'mlb:2', name: 'Rockies vs Diamondbacks', torbox: 'cached', hashes: [h('c')] },
] });

test('unchecked saved releases are checked and the answers recorded', async () => {
  const index = createAvailabilityIndex({ file: ':memory:', secret: process.env.SESSION_SECRET });
  const asked = [];
  try {
    const out = await audit.runOnce({ users: () => admin, index: () => index, coverage: rows, log: () => {},
      checkCachedBatch: async (hashes, key) => { asked.push({ hashes, key }); return new Set([h('a')]); } });
    assert.deepEqual(out, { checked: 2, cached: 1 });
    assert.deepEqual(asked, [{ hashes: [h('a'), h('b')], key: 'TB-KEY' }], 'only unchecked events, with the admin key');
    const states = index.torboxStates([h('a'), h('b')]);
    assert.equal(states.get(h('a')), 'cached');
    assert.equal(states.get(h('b')), 'not-cached');
  } finally { index.close(); }
});

test('a failed batch records nothing, so an outage never reads as "not cached"', async () => {
  const index = createAvailabilityIndex({ file: ':memory:', secret: process.env.SESSION_SECRET });
  try {
    const out = await audit.runOnce({ users: () => admin, index: () => index, coverage: rows, log: () => {},
      checkCachedBatch: async (hashes, key, log) => { log('  torbox: checkcached HTTP 503'); return new Set(); } });
    assert.deepEqual(out, { checked: 0, cached: 0 });
    assert.equal(index.torboxStates([h('a'), h('b')]).size, 0);
  } finally { index.close(); }
});

test('without an admin TorBox key nothing is checked', async () => {
  let called = false;
  const out = await audit.runOnce({ users: () => [{ role: 'user', config: { torboxApiKey: 'k' } }, { role: 'admin', config: {} }],
    coverage: rows, log: () => {}, checkCachedBatch: async () => { called = true; return new Set(); } });
  assert.deepEqual(out, { skipped: 'no-admin-torbox-key' });
  assert.equal(called, false);
});

// Found on v1.3.1: the audit read accounts with listUsers(), which returns
// keys still encrypted, so TorBox refused every batch.
test('the audit uses the decrypted TorBox key, and says why a batch failed', async () => {
  const users = require('../lib/users');
  const created = await users.createUser({ username: 'admin', password: 'correct-horse-battery-staple', role: 'admin' });
  users.updateUserConfig(created.id, { torboxApiKey: 'REAL-TB-KEY' });
  assert.match(JSON.parse(fs.readFileSync(process.env.USERS_FILE, 'utf8')).users[0].config.torboxApiKey, /^enc:/, 'stored encrypted');
  const index = createAvailabilityIndex({ file: ':memory:', secret: process.env.SESSION_SECRET });
  const keys = [];
  const logs = [];
  try {
    await audit.runOnce({ index: () => index, coverage: rows, log: (m) => logs.push(m),
      checkCachedBatch: async (hashes, key, log) => { keys.push(key); log('  torbox: checkcached HTTP 401'); return new Set(); } });
    assert.deepEqual(keys, ['REAL-TB-KEY'], 'the decrypted key, not the stored ciphertext');
    assert.ok(logs.some((m) => /failed \(torbox: checkcached HTTP 401\)/.test(m)), 'the failure names the reason');
  } finally { index.close(); }
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
