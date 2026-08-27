'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
const indexer = require('../lib/sources/usenet-indexer');

function response(body, status, headers) {
  const code = status || 200;
  return {
    ok: code >= 200 && code < 300,
    status: code,
    headers: { get: (name) => (headers || {})[String(name).toLowerCase()] || null },
    body: Readable.from([body]),
  };
}

function rss(items) {
  return '<?xml version="1.0"?><rss xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/"><channel>'
    + items.join('') + '</channel></rss>';
}

test('searches a Newznab endpoint and normalizes encrypted-candidate fields', async () => {
  let captured;
  const out = await indexer.searchOne('UFC Fight Night 285', {
    enabled: true,
    kind: 'newznab',
    url: 'https://hydra.example',
    apiKey: 'secret',
    name: 'Hydra',
  }, {
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return response(rss([
        '<item><title><![CDATA[UFC.Fight.Night.285.1080p]]></title>'
          + '<link>https://hydra.example/api?t=get&amp;id=123</link>'
          + '<pubDate>Wed, 26 Aug 2026 12:00:00 GMT</pubDate>'
          + '<newznab:attr name="size" value="123456789"/>'
          + '<newznab:attr name="indexer" value="NZBGeek"/></item>',
      ]));
    },
  });
  const requestUrl = new URL(captured.url);
  assert.equal(requestUrl.pathname, '/api');
  assert.equal(requestUrl.searchParams.get('t'), 'search');
  assert.equal(requestUrl.searchParams.get('q'), 'UFC Fight Night 285');
  assert.equal(requestUrl.searchParams.get('apikey'), 'secret');
  assert.equal(out.length, 1);
  assert.equal(out[0].size, 123456789);
  assert.equal(out[0].indexer, 'NZBGeek');
  assert.equal(new URL(out[0].nzbUrl).searchParams.get('apikey'), 'secret');
});

test('searches Prowlarr with header auth and keeps only Usenet results', async () => {
  let captured;
  const out = await indexer.searchOne('WWE Raw', {
    enabled: true,
    kind: 'prowlarr',
    url: 'http://prowlarr:9696',
    apiKey: 'prowlarr-key',
    name: 'Prowlarr',
  }, {
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return response(JSON.stringify([
        { protocol: 'usenet', title: 'WWE.Raw.1080p', downloadUrl: '/download/1', size: 99, indexer: 'Geek' },
        { protocol: 'torrent', title: 'WWE.Raw.Torrent', downloadUrl: '/download/2', size: 100 },
      ]));
    },
  });
  assert.equal(captured.options.headers['X-Api-Key'], 'prowlarr-key');
  assert.equal(new URL(captured.url).pathname, '/api/v1/search');
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'WWE.Raw.1080p');
  assert.equal(new URL(out[0].nzbUrl).searchParams.get('apikey'), 'prowlarr-key');
});

test('deduplicates results returned by multiple title variants', async () => {
  const xml = rss(['<item><title>UFC.300.1080p</title><link>https://indexer.example/get/1</link></item>']);
  const out = await indexer.search(['UFC 300', 'UFC 300 alternate'], {
    enabled: true,
    kind: 'newznab',
    url: 'https://indexer.example/api',
    apiKey: 'key',
  }, { fetchImpl: async () => response(xml) });
  assert.equal(out.ok, true);
  assert.equal(out.results.length, 1);
});

test('keeps successful variants when another variant fails', async () => {
  const xml = rss(['<item><title>Formula.1.2026.Dutch.GP.1080p</title>'
    + '<link>https://indexer.example/get/dutch-gp</link></item>']);
  const out = await indexer.search(['Dutch GP', 'Dutch Grand Prix'], {
    enabled: true,
    kind: 'newznab',
    url: 'https://indexer.example/api',
    apiKey: 'key',
  }, {
    fetchImpl: async (url) => {
      if (new URL(url).searchParams.get('q') === 'Dutch Grand Prix') {
        throw new Error('simulated slow indexer failure');
      }
      return response(xml);
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].title, 'Formula.1.2026.Dutch.GP.1080p');
});

test('reports all-failed only when no title variant completes', async () => {
  const out = await indexer.search(['Dutch GP'], {
    enabled: true,
    kind: 'newznab',
    url: 'https://indexer.example/api',
    apiKey: 'key',
  }, { fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'all-failed');
  assert.deepEqual(out.results, []);
});

test('rejects oversized search responses before buffering', async () => {
  await assert.rejects(indexer.searchOne('UFC', {
    enabled: true,
    kind: 'newznab',
    url: 'https://indexer.example',
    apiKey: 'key',
  }, {
    fetchImpl: async () => response('', 200, {
      'content-length': String(indexer.MAX_RESPONSE_BYTES + 1),
    }),
  }), (error) => {
    assert.equal(error.code, 'response-too-large');
    return true;
  });
});
