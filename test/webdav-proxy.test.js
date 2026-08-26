'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fetch = require('node-fetch');
const { proxyWebdav } = require('../lib/webdav-proxy');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('proxies WebDAV authentication and byte ranges without credential redirects', async () => {
  let upstreamHeaders;
  const upstream = http.createServer((req, res) => {
    upstreamHeaders = req.headers;
    res.writeHead(206, {
      'Content-Type': 'video/x-matroska',
      'Content-Range': 'bytes 2-5/10',
      'Content-Length': '4',
      'Accept-Ranges': 'bytes',
    });
    res.end('2345');
  });
  const upstreamPort = await listen(upstream);
  const proxy = http.createServer((req, res) => {
    proxyWebdav(req, res, {
      url: 'http://127.0.0.1:' + upstreamPort + '/main.mkv',
      headers: { Authorization: 'Basic hidden' },
    }).catch((error) => {
      if (!res.headersSent) res.writeHead(502);
      res.end(error.message);
    });
  });
  const proxyPort = await listen(proxy);
  try {
    const response = await fetch('http://127.0.0.1:' + proxyPort + '/play', {
      headers: { Range: 'bytes=2-5' }, redirect: 'manual',
    });
    assert.equal(response.status, 206);
    assert.equal(await response.text(), '2345');
    assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(upstreamHeaders.authorization, 'Basic hidden');
    assert.equal(upstreamHeaders.range, 'bytes=2-5');
    assert.equal(response.headers.get('location'), null);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});
