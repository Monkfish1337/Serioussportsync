'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const nntp = require('../lib/sources/nntp-client');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) { return new Promise((resolve) => server.close(resolve)); }

function fakeProvider(password) {
  return net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('200 test provider ready\r\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let split;
      while ((split = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, split); buffer = buffer.slice(split + 2);
        if (line === 'AUTHINFO USER alice') socket.write('381 password required\r\n');
        else if (line === 'AUTHINFO PASS ' + password) socket.write('281 authentication accepted\r\n');
        else if (line.startsWith('AUTHINFO PASS ')) socket.write('481 authentication rejected\r\n');
        else if (line === 'DATE') socket.write('111 20260827120000\r\n');
        else if (line === 'QUIT') { socket.write('205 closing\r\n'); socket.end(); }
      }
    });
  });
}

test('connects, authenticates, and checks an NNTP provider', async () => {
  const server = fakeProvider('secret');
  const port = await listen(server);
  try {
    const result = await nntp.testConnection({
      host: '127.0.0.1', port, tls: false, username: 'alice', password: 'secret',
    }, { proxyUrl: '', timeoutMs: 1000 });
    assert.deepEqual(result, { ok: true, greetingCode: 200, proxied: false });
  } finally { await close(server); }
});

test('rejects invalid credentials without echoing the password', async () => {
  const server = fakeProvider('secret');
  const port = await listen(server);
  try {
    await assert.rejects(nntp.testConnection({
      host: '127.0.0.1', port, tls: false, username: 'alice', password: 'wrong-secret',
    }, { proxyUrl: '', timeoutMs: 1000 }), (error) => {
      assert.match(error.message, /authentication failed \(481\)/);
      assert.doesNotMatch(error.message, /wrong-secret/);
      return true;
    });
  } finally { await close(server); }
});

test('rejects command injection in NNTP credentials', () => {
  assert.throws(() => nntp.normalizeConfig({
    host: 'news.example', username: 'alice\r\nDATE', password: 'x',
  }), /invalid characters/);
});

test('uses an HTTP CONNECT proxy without losing an immediate NNTP greeting', async () => {
  let connectTarget = '';
  const proxy = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let tunnel = false;
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!tunnel) {
        const split = buffer.indexOf('\r\n\r\n');
        if (split < 0) return;
        connectTarget = buffer.split('\r\n', 1)[0];
        buffer = buffer.slice(split + 4);
        tunnel = true;
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n200 proxied provider ready\r\n');
      }
      let lineEnd;
      while (tunnel && (lineEnd = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, lineEnd); buffer = buffer.slice(lineEnd + 2);
        if (line === 'AUTHINFO USER alice') socket.write('381 password required\r\n');
        else if (line === 'AUTHINFO PASS secret') socket.write('281 authentication accepted\r\n');
        else if (line === 'DATE') socket.write('111 20260827120000\r\n');
        else if (line === 'QUIT') socket.end();
      }
    });
  });
  const proxyPort = await listen(proxy);
  try {
    const result = await nntp.testConnection({
      host: 'news.example', port: 119, tls: false, username: 'alice', password: 'secret',
    }, { proxyUrl: 'http://127.0.0.1:' + proxyPort, timeoutMs: 1000 });
    assert.equal(result.proxied, true);
    assert.equal(connectTarget, 'CONNECT news.example:119 HTTP/1.1');
  } finally { await close(proxy); }
});

test('fetches a dot-terminated BODY without corrupting binary yEnc bytes', async () => {
  const server = net.createServer((socket) => {
    socket.setEncoding('latin1');
    socket.write('200 ready\r\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let split;
      while ((split = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, split); buffer = buffer.slice(split + 2);
        if (line === 'BODY <article@id>') {
          socket.write(Buffer.concat([
            Buffer.from('222 0 article follows\r\n=ypart begin=1 end=3\r\n', 'latin1'),
            Buffer.from([0x80, 0xff, 0x2a]), Buffer.from('\r\n..dot-line\r\n.\r\n', 'latin1'),
          ]));
        } else if (line === 'QUIT') socket.end();
      }
    });
  });
  const port = await listen(server);
  let session;
  try {
    session = await nntp.connectAuthenticated({ host: '127.0.0.1', port, tls: false }, {
      proxyUrl: '', timeoutMs: 1000,
    });
    const body = await session.body('article@id');
    assert.ok(body.includes(Buffer.from([0x80, 0xff, 0x2a])));
    assert.match(body.toString('latin1'), /\.dot-line/);
  } finally {
    if (session) session.close();
    await close(server);
  }
});
