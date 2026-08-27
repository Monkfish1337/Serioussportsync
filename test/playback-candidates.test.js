'use strict';

process.env.SESSION_SECRET = process.env.SESSION_SECRET
  || 'candidate-test-secret-00000000000000000000000000000000';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCandidateStore } = require('../lib/playback-candidates');

function temporaryStore(options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-candidates-'));
  const file = path.join(dir, 'candidates.json');
  const store = createCandidateStore(Object.assign({ file }, options || {}));
  return { dir, file, store };
}

test('stores sensitive candidate data encrypted and enforces binding', () => {
  const { file, store } = temporaryStore();
  const saved = store.put({
    userId: 'user-1',
    eventId: 'ufc:300',
    provider: 'nzbdav',
    payload: {
      title: 'UFC 300 1080p',
      nzbUrl: 'https://indexer.example/get/1?apikey=never-plaintext',
    },
  });

  const disk = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(disk, /never-plaintext/);
  assert.match(disk, /enc:/);
  assert.equal(store.get({
    id: saved.id, userId: 'other', eventId: 'ufc:300', provider: 'nzbdav',
  }).reason, 'wrong-user');
  assert.equal(store.get({
    id: saved.id, userId: 'user-1', eventId: 'other', provider: 'nzbdav',
  }).reason, 'wrong-event');
  const found = store.get({
    id: saved.id, userId: 'user-1', eventId: 'ufc:300', provider: 'nzbdav',
  });
  assert.equal(found.ok, true);
  assert.equal(found.candidate.payload.title, 'UFC 300 1080p');
});
test('expires candidates and caps retained entries', async () => {
  const { store } = temporaryStore({ ttlMs: 20, maxEntries: 2 });
  const first = store.put({ userId: 'u', eventId: 'e', provider: 'p', payload: { n: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(store.get({ id: first.id, userId: 'u', eventId: 'e', provider: 'p' }).reason, 'expired');

  const a = store.put({ userId: 'u', eventId: 'e', provider: 'p', payload: { n: 2 } });
  const b = store.put({ userId: 'u', eventId: 'e', provider: 'p', payload: { n: 3 } });
  const c = store.put({ userId: 'u', eventId: 'e', provider: 'p', payload: { n: 4 } });
  assert.equal(store.get({ id: a.id, userId: 'u', eventId: 'e', provider: 'p' }).ok, false);
  assert.equal(store.get({ id: b.id, userId: 'u', eventId: 'e', provider: 'p' }).ok, true);
  assert.equal(store.get({ id: c.id, userId: 'u', eventId: 'e', provider: 'p' }).ok, true);
});
test('updates encrypted payloads without changing candidate bindings', () => {
  const { file, store } = temporaryStore();
  const saved = store.put({
    userId: 'u1', eventId: 'ufc:1', provider: 'nzbdav',
    payload: { nzbUrl: 'https://indexer.example/get/1?apikey=secret' },
  });
  const updated = store.updatePayload({
    id: saved.id, userId: 'u1', eventId: 'ufc:1', provider: 'nzbdav',
    update: (payload) => Object.assign({}, payload, {
      playback: { url: 'https://dav.example/content/event/main.mkv' },
    }),
  });
  assert.equal(updated.ok, true);
  assert.match(updated.candidate.payload.playback.url, /main\.mkv$/);
  assert.equal(store.get({
    id: saved.id, userId: 'other', eventId: 'ufc:1', provider: 'nzbdav',
  }).reason, 'wrong-user');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /apikey=secret|main\.mkv/);
});
