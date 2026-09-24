#!/usr/bin/env node
'use strict';

// Disposable application restore drill. Also runs inside the release container.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const source = path.resolve(__dirname, '..');
const password = 'disposable-recovery-test-password';
const secret = 'disposable-recovery-secret-00000000000000000000000000000000';
const eventId = 'mlb:recovery-fixture';

// Extract from inside the target folder with a relative, forward-slash path:
// GNU tar on Windows reads an absolute C:\... archive path as a remote host.
function extract(archive, target) {
  execFileSync('tar', ['-xzf', path.relative(target, archive).split(path.sep).join('/')], { cwd: target });
}

function environment(dir) {
  const data = path.join(dir, 'data');
  const env = { ...process.env, SESSION_SECRET: secret, ADMIN_USER: '', HOST: '127.0.0.1',
    PORT: '0', PUBLIC_URL: '', REFRESH_ON_EMPTY_CACHE: 'false', REFRESH_INTERVAL_HOURS: '0',
    PROWLARR_DISCOVERY_ENABLED: '0', SPORT_VIDEO_ENABLED: '0' };
  for (const [key, file] of Object.entries({ DATA_FILE: 'events.json', USERS_FILE: 'users.json',
    SETTINGS_FILE: 'settings.json', AVAILABILITY_DB_FILE: 'availability.sqlite',
    CUSTOM_PROMOTIONS_FILE: 'custom-promotions.json', CONTENT_STUDIO_FILE: 'content-studio.json',
    METADATA_SOURCES_FILE: 'metadata-sources.json', NUVIO_COLLECTIONS_FILE: 'nuvio-collections.json',
    SPORT_VIDEO_FILE: 'sport-video.json', POSITIVE_CACHE_FILE: 'positive-cache.json',
    RD_DENYLIST_FILE: 'rd-denylist.json', TB_DENYLIST_FILE: 'tb-denylist.json', PM_DENYLIST_FILE: 'pm-denylist.json' })) {
    env[key] = path.join(data, file);
  }
  return env;
}

async function fixture(mode, dir) {
  assert.ok(path.basename(dir).startsWith('sss-recovery-'), 'Only disposable recovery fixtures are allowed');
  Object.assign(process.env, environment(dir));
  const users = require('../lib/users');
  const settings = require('../lib/settings');
  const store = require('../lib/store');
  const availability = require('../lib/availability-index');
  const queueModule = require('../lib/prowlarr-discovery');
  const Database = require('better-sqlite3');
  const data = path.join(dir, 'data');
  const queueFile = path.join(data, 'prowlarr-discovery.sqlite');
  if (mode === 'seed') {
    const admin = await users.createUser({ username: 'recovery-admin', password, role: 'admin' });
    await users.createUser({ username: 'recovery-user', password, role: 'user' });
    await users.requestAccess({ username: 'recovery-pending', password });
    users.updateUserConfig(admin.id, { torboxApiKey: 'recovery-provider-secret' });
    settings.setProwlarr({ url: 'http://127.0.0.1:9696', apiKey: 'recovery-indexer-secret', enabled: true, liveSearchEnabled: false });
    settings.setProwlarrDiscovery({ enabled: false, lookbackDays: 7, dailyRequests: 100, intervalSeconds: 120 });
    const date = new Date(Date.now() - 48 * 3600000).toISOString().slice(0, 10);
    const event = { id: eventId, promotion: 'mlb', name: 'New York Mets vs New York Yankees', date,
      aliases: ['New York Mets vs New York Yankees'], posterShape: 'square', kind: 'match' };
    store.saveToDisk({ updatedAt: new Date().toISOString(), events: [event] });
    const candidate = { title: 'MLB ' + date.replace(/-/g, '.') + ' New York Mets vs New York Yankees 1080p',
      infoHash: 'a'.repeat(40), seeders: 2, indexer: 'Recovery indexer' };
    const index = availability.getDefault();
    index.recordEventCandidates({ provider: 'torrent', scope: 'recovery', eventId, results: [candidate] });
    index.close();
    const queue = queueModule.createQueue(queueFile); queue.close();
    const db = new Database(queueFile);
    const scope = crypto.createHash('sha256').update(JSON.stringify(['http://127.0.0.1:9696', 'recovery-indexer-secret'])).digest('hex');
    db.prepare('INSERT INTO limits VALUES(?,?,?,?,?,?,?)').run(scope, 1, date, 17, 2, Date.now() + 3600000, 'Recovery indexer');
    db.prepare('INSERT INTO matches VALUES(?,?,?,?,?)').run(scope, eventId, candidate.infoHash,
      require('../lib/crypto-keys').encrypt(JSON.stringify(candidate)), Date.now());
    db.close();
    require('../lib/custom-promotions').add({ id: 'recovery-team', name: 'Recovery team', source: 'espn',
      league: 'mlb', teamFilter: { id: '21', names: ['New York Mets'] }, promotionAliases: ['Mets', 'NYM'],
      searchTitleTemplates: ['{name} {date_dotted}'], relevanceKeywords: ['Mets'],
      exclusionKeywords: ['preview'], requireDateInTitle: true });
  } else {
    const admin = users.findByUsername('recovery-admin');
    assert.equal(admin.role, 'admin');
    assert.ok(await users.verifyPassword(password, admin.passwordHash));
    assert.equal(admin.config.torboxApiKey, 'recovery-provider-secret');
    assert.equal(users.findByUsername('recovery-user').role, 'user');
    assert.equal(users.findByUsername('recovery-pending'), null);
    assert.ok(users.listAccessRequests().some(item => item.username === 'recovery-pending'));
    assert.equal(settings.getProwlarr().apiKey, 'recovery-indexer-secret');
    assert.equal(settings.getProwlarr().liveSearchEnabled, false);
    assert.equal(settings.getProwlarrDiscovery().lookbackDays, 7);
    const team = require('../lib/custom-promotions').findById('recovery-team');
    assert.deepEqual(team.promotionAliases, ['Mets', 'NYM']);
    assert.deepEqual(team.exclusionKeywords, ['preview']);
    assert.equal(team.posterShape, 'square');
    const event = store.getEvent(eventId); assert.ok(event);
    const index = availability.getDefault();
    assert.ok(index.eventReleaseTitles([eventId]).some(row => row.usable)); index.close();
    const queue = queueModule.createQueue(queueFile);
    assert.equal(queue.candidates(event)[0].infoHash, 'a'.repeat(40)); queue.close();
    const db = new Database(queueFile, { readonly: true });
    const limit = db.prepare('SELECT * FROM limits').get();
    assert.equal(limit.requests, 17); assert.equal(limit.failures, 2); assert.ok(limit.next_at > Date.now());
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok'); db.close();
    const raw = fs.readFileSync(path.join(data, 'users.json'), 'utf8');
    assert.ok(!raw.includes('recovery-provider-secret') && !raw.includes(password));
  }
}

async function startServer(dir, code = source) {
  // Production treats PORT=0 as the default port. Find a spare test port so
  // the drill can run beside the already-started Compose release candidate.
  const port = await new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const chosen = listener.address().port;
      listener.close(error => error ? reject(error) : resolve(chosen));
    });
  });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(code, 'server.js')], {
      cwd: dir, env: { ...environment(dir), PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Recovery server startup timed out: ' + output)); }, 20000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', exit => { clearTimeout(timeout); if (exit !== 0) reject(new Error('Recovery server exited: ' + output)); });
    child.stderr.on('data', bytes => { output = (output + bytes).slice(-4000); });
    child.stdout.on('data', bytes => {
      output = (output + bytes).slice(-4000);
      const match = output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timeout); resolve({ child, base: 'http://127.0.0.1:' + match[1] }); }
    });
  });
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return;
  await new Promise(resolve => {
    const timeout = setTimeout(() => server.child.kill('SIGKILL'), 5000);
    server.child.once('exit', () => { clearTimeout(timeout); resolve(); });
    server.child.kill();
  });
}

async function checkHttp(server) {
  assert.equal((await fetch(server.base + '/health')).status, 200);
  const login = await fetch(server.base + '/login', { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'recovery-admin', password }) });
  assert.equal(login.status, 302);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  for (const page of ['/account', '/admin/user-management', '/admin/discovery?tab=overview']) {
    assert.equal((await fetch(server.base + page, { headers: { Cookie: cookie } })).status, 200, page);
  }
  return cookie;
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-recovery-'));
  const restored = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-recovery-'));
  let server;
  try {
    fs.mkdirSync(path.join(root, 'data')); fs.mkdirSync(path.join(restored, 'data'));
    const helper = (mode, dir) => execFileSync(process.execPath, [__filename, mode, dir], { env: process.env, windowsHide: true });
    helper('seed', root);
    server = await startServer(root);
    const cookie = await checkHttp(server);
    const response = await fetch(server.base + '/admin/backup', { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const archive = path.join(root, 'recovery.tar.gz');
    fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    await stopServer(server); server = null;
    extract(archive, path.join(restored, 'data'));
    helper('verify', restored);
    server = await startServer(restored); await checkHttp(server);
    await stopServer(server); server = null; helper('verify', restored);
    server = await startServer(restored); await checkHttp(server);
    await stopServer(server); server = null; helper('verify', restored);
    if (process.env.SSS_ROLLBACK_SOURCE) {
      // Rollback uses a fresh extraction of the pre-upgrade backup.
      assert.equal(path.dirname(restored), os.tmpdir());
      assert.ok(path.basename(restored).startsWith('sss-recovery-'));
      fs.rmSync(path.join(restored, 'data'), { recursive: true, force: true }); fs.mkdirSync(path.join(restored, 'data'));
      extract(archive, path.join(restored, 'data'));
      server = await startServer(restored, path.resolve(process.env.SSS_ROLLBACK_SOURCE)); await checkHttp(server);
      await stopServer(server); server = null; helper('verify', restored);
    }
    console.log('OK — application backup, restore, login, roles, pending requests, encrypted keys, events, matching rules, saved releases, queue budgets and restart' + (process.env.SSS_ROLLBACK_SOURCE ? ', plus rollback' : '') + ' verified.');
  } finally {
    await stopServer(server);
    for (const dir of [root, restored]) {
      assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith('sss-recovery-'));
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
}

(process.argv[2] === 'seed' || process.argv[2] === 'verify'
  ? fixture(process.argv[2], path.resolve(process.argv[3])) : run())
  .catch(error => { console.error(error); process.exitCode = 1; });
