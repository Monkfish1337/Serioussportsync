'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config');

const originalFile = config.metadataSourcesFile;
const testFile = path.join(os.tmpdir(), 'sss-metadata-sources-' + process.pid + '.json');
config.metadataSourcesFile = testFile;
const sources = require('../lib/metadata-sources');
const promotions = require('../lib/promotions');
const chrome = require('../lib/tabler-chrome');

test.after(() => {
  config.metadataSourcesFile = originalFile;
  try { fs.unlinkSync(testFile); } catch (_) {}
});

test('seeds all current built-in metadata source assignments', () => {
  assert.equal(sources.list().length, 9);
  assert.deepEqual(sources.resolve('one', {}).source, { type: 'onefc' });
  assert.deepEqual(sources.resolve('f1', {}).source, { type: 'thesportsdb', leagueId: '4370' });
});

test('creates a reusable source and assigns it to a promotion', () => {
  const created = sources.add({
    id: 'tsdb-nfl', name: 'TheSportsDB · NFL', type: 'thesportsdb', leagueId: '4391',
  });
  assert.equal(created.source.leagueId, '4391');
  sources.assign('f1', created.id);
  assert.equal(sources.assignmentFor('f1'), 'tsdb-nfl');
  assert.deepEqual(sources.resolve('f1', {}).source, { type: 'thesportsdb', leagueId: '4391' });
  promotions.reload();
  assert.deepEqual(promotions.all.find((p) => p.id === 'f1').source, { type: 'thesportsdb', leagueId: '4391' });
  sources.assign('f1', '');
  promotions.reload();
  assert.equal(sources.assignmentFor('f1'), 'tsdb-f1');
});

test('retired expert tools are absent from the admin sidebar', () => {
  const labels = chrome.ADMIN_SECTIONS.map((item) => item.label);
  assert.ok(labels.includes('Promotions'));
  for (const retired of ['Power Tool', 'Search', 'Match Editor', 'Content Studio']) {
    assert.ok(!labels.includes(retired));
  }
});

test('rejects incomplete or duplicate source definitions', () => {
  assert.throws(() => sources.add({ id: 'bad-source', name: 'Bad', type: 'tmdb', tvIds: 'abc' }), /numeric/);
  assert.throws(() => sources.add({ id: 'tsdb-nfl', name: 'Duplicate', type: 'onefc' }), /already exists/);
});
