'use strict';
process.env.SESSION_SECRET ||= 'discovery-improvements-test-secret-00000000000000000000';
const test = require('node:test');
const assert = require('node:assert/strict');
const {Response} = require('node-fetch');
const {selectTorrentQueries, collectPipelineRows} = require('../lib/discovery-plan');
const bitmagnet = require('../lib/sources/bitmagnet');
const easynews = require('../lib/sources/easynews');
const availability = require('../lib/availability-index');
const {_test: streams} = require('../lib/streams');
const wait = (ms, value) => new Promise(resolve => setTimeout(() => resolve(value), ms));

test('bounded MLB queries cover nicknames, full names and @ without losing team direction', () => {
  const selected = selectTorrentQueries(['Yankees Mets 2026.09.11', 'Yankees Mets 10.09.2026', 'Yankees Mets 2026.09.10'],
    {name: 'New York Mets vs New York Yankees', date: '2026-09-11'}, {id: 'mlb'}, 6);
  assert.equal(selected[0], 'Yankees Mets 2026.09.11');
  assert.ok(selected.includes('New York Mets @ New York Yankees 11.09.2026'));
  assert.ok(selected.includes('New York Mets vs New York Yankees 2026.09.11'));
  assert.ok(selected.length <= 6);
  assert.equal(new Set(selected).size, selected.length);
});
test('NFL week searches get a slot while UCL retains specialist ordering', () => {
  assert.ok(selectTorrentQueries(['Packers Cardinals 2026.09.13'],
    {name: 'Packers at Cardinals', date: '2026-09-13', week: 1, seasonSpan: '2026-2027'}, {id: 'nfl'}, 6)
    .some(q => q.includes('NFL 2026-2027 W01')));
  assert.deepEqual(selectTorrentQueries(['UEFA specialist', 'second'], {name: 'Liverpool vs Atletico'}, {id: 'ucl'}, 1), ['UEFA specialist']);
});
test('fast responses return completed results while thorough responses wait for coverage', async () => {
  const promises = [wait(1, ['ready']), wait(250, ['later'])];
  const fast = await collectPipelineRows(promises, 10);
  assert.deepEqual(fast, [['ready'], []]);
  assert.deepEqual(await collectPipelineRows(promises, 0), [['ready'], ['later']]);
  assert.deepEqual(fast, [['ready'], []], 'Late completion must not mutate an already returned response');
});
test('fast responses do not return empty when useful results are still pending', async () => {
  assert.deepEqual(await collectPipelineRows([wait(1, []), wait(50, ['useful'])], 5), [[], ['useful']]);
  assert.deepEqual(await collectPipelineRows([Promise.reject(Error('failed')), Promise.resolve([])], 5), [[], []]);
});
test('partial Bitmagnet and Easynews answers cannot freeze complete-search caches', async () => {
  let calls = 0;
  const result = await bitmagnet.multiSearch(['empty', 'failed'], {detailed: true,
    config: {url: 'http://example.invalid', concurrency: 1}, fetchImpl: async () => {
      if (++calls === 2) throw Error('fixture failure');
      return new Response(JSON.stringify({data: {torrentContent: {search: {items: [], totalCount: 0}}}}));
    }});
  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  let easyCalls = 0;
  const easyResult = await easynews.multiSearch(['failed', 'empty'], {username: 'fixture', password: 'fixture', queryDelayMs: 1,
    fetchImpl: async () => { if (++easyCalls === 1) throw Error('fixture failure'); return new Response(JSON.stringify({data: []})); }});
  assert.equal(easyResult.ok, true);
  assert.equal(easyResult.partial, true);
  const index = availability.createAvailabilityIndex({file: ':memory:', secret: process.env.SESSION_SECRET});
  try {
    let attempts = 0;
    const input = {index, event: {id: 'mlb:review'}, promo: {id: 'mlb'}, provider: 'torrent', scope: 'fixture', queries: ['fixture'], log: () => {},
      producer: async () => {attempts++; return result;}};
    await streams.cachedProviderSearch(input);
    await streams.cachedProviderSearch(input);
    assert.equal(attempts, 2);
    assert.equal(index.recentSearches(10).length, 0);
  } finally {index.close();}
});
test('Bitmagnet and Easynews stop waiting and starting work at a shared deadline', async () => {
  let bitCalls = 0;
  const started = Date.now();
  const answer = await bitmagnet.multiSearch(['stalled', 'never-started'], {detailed: true, deadlineMs: 300,
    config: {url: 'http://example.invalid', concurrency: 1}, fetchImpl: async () => {bitCalls++; return new Promise(() => {});}});
  assert.equal(bitCalls, 1);
  assert.equal(answer.partial, true);
  assert.ok(Date.now() - started < 1000);
  let easyCalls = 0;
  const easy = await easynews.multiSearch(['empty', 'stalled', 'never-started'], {username: 'fixture', password: 'fixture', queryDelayMs: 1, totalTimeoutMs: 300,
    fetchImpl: async () => {if (++easyCalls === 1) return new Response(JSON.stringify({data: []})); return new Promise(() => {});}});
  assert.equal(easyCalls, 2);
  assert.equal(easy.ok, true);
  assert.equal(easy.partial, true);
});
test('recent-event negative cache expiry is shorter than historical-event expiry', () => {
  const index = availability.createAvailabilityIndex({file: ':memory:', secret: process.env.SESSION_SECRET});
  try {
    const base = {provider: 'torrent', scope: 'fixture', queries: ['fixture'], results: []};
    const recent = index.recordSearch({...base, eventId: 'recent', eventDate: new Date().toISOString().slice(0, 10)});
    const historical = index.recordSearch({...base, eventId: 'old', eventDate: '2020-01-01'});
    assert.ok(historical.expiresAt - recent.expiresAt > 20 * 60000);
  } finally {index.close();}
});
