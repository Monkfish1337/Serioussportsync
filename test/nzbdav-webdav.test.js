'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const webdav = require('../lib/sources/nzbdav-webdav');

function multiStatus(entries) {
  return '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">'
    + entries.map((entry) => '<d:response><d:href>' + entry.href + '</d:href>'
      + '<d:propstat><d:prop><d:resourcetype>'
      + (entry.directory ? '<d:collection/>' : '')
      + '</d:resourcetype><d:getcontentlength>' + (entry.size || 0)
      + '</d:getcontentlength></d:prop></d:propstat></d:response>').join('')
    + '</d:multistatus>';
}

function response(body, status) {
  return { ok: (status || 207) < 300, status: status || 207, text: async () => body };
}

test('discovers the largest plausible video using bounded WebDAV traversal', async () => {
  const requests = [];
  const selected = await webdav.discoverVideo(
    { url: 'https://dav.example', username: 'alice', password: 'secret' },
    '/content/sports/event/',
    {
      minVideoBytes: 1,
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        const path = new URL(url).pathname;
        if (path.endsWith('/event/')) return response(multiStatus([
          { href: '/content/sports/event/', directory: true },
          { href: '/content/sports/event/UFC.main.mkv', size: 900 },
          { href: '/content/sports/event/sample.mkv', size: 1200 },
          { href: '/content/sports/event/disc2/', directory: true },
        ]));
        return response(multiStatus([
          { href: '/content/sports/event/disc2/', directory: true },
          { href: '/content/sports/event/disc2/UFC.main.4k.mkv', size: 1800 },
        ]));
      },
    }
  );
  assert.equal(selected.size, 1800);
  assert.match(selected.url, /UFC\.main\.4k\.mkv$/);
  assert.equal(requests[0].options.method, 'PROPFIND');
  assert.equal(requests[0].options.headers.Authorization,
    'Basic ' + Buffer.from('alice:secret').toString('base64'));
});
test('does not allow discovery to leave the configured WebDAV origin', async () => {
  await assert.rejects(webdav.list(
    { url: 'https://dav.example' },
    'https://attacker.example/content',
    { fetchImpl: async () => { throw new Error('must not fetch'); } }
  ), (error) => {
    assert.equal(error.code, 'invalid-path');
    return true;
  });
});
test('rebases absolute WebDAV hrefs onto the configured origin', async () => {
  const requests = [];
  const selected = await webdav.discoverVideo(
    { url: 'https://dav.example', username: 'alice', password: 'secret' },
    '/content/sports/event/',
    {
      minVideoBytes: 1,
      fetchImpl: async (url) => {
        requests.push(url);
        const path = new URL(url).pathname;
        if (path.endsWith('/event/')) return response(multiStatus([
          { href: 'http://nzbdav:3000/content/sports/event/', directory: true },
          { href: 'http://nzbdav:3000/content/sports/event/disc/', directory: true },
        ]));
        return response(multiStatus([
          { href: 'http://nzbdav:3000/content/sports/event/disc/', directory: true },
          { href: 'http://nzbdav:3000/content/sports/event/disc/main.mkv', size: 1800 },
        ]));
      },
    }
  );
  assert.equal(requests.length, 2);
  assert.ok(requests.every((url) => new URL(url).origin === 'https://dav.example'));
  assert.equal(new URL(selected.url).origin, 'https://dav.example');
  assert.match(selected.url, /\/main\.mkv$/);
});
test('reports a completed job with no usable video', async () => {
  await assert.rejects(webdav.discoverVideo(
    { url: 'https://dav.example' }, '/content/sports/event/', {
      minVideoBytes: 1,
      fetchImpl: async () => response(multiStatus([
        { href: '/content/sports/event/', directory: true },
        { href: '/content/sports/event/subtitles.srt', size: 10 },
      ])),
    }
  ), (error) => {
    assert.equal(error.code, 'no-playable-file');
    return true;
  });
});
