'use strict';

const net = require('net');
const tls = require('tls');
const httpAgent = require('../http-agent');

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_LINE_BYTES = 64 * 1024;

function normalizeConfig(input) {
  const cfg = input || {};
  const host = String(cfg.host || '').trim();
  if (!host || /[\s\r\n]/.test(host)) throw new Error('NNTP host is required');
  const secure = cfg.tls !== false;
  const port = Number(cfg.port || (secure ? 563 : 119));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('NNTP port is invalid');
  const username = String(cfg.username || '');
  const password = String(cfg.password || '');
  if (/[\r\n]/.test(username) || /[\r\n]/.test(password)) {
    throw new Error('NNTP credentials contain invalid characters');
  }
  return { host, port, tls: secure, username, password };
}

function statusCode(line) {
  const match = /^(\d{3})(?:\s|$)/.exec(String(line || ''));
  return match ? Number(match[1]) : 0;
}

function lineReader(socket) {
  let buffered = Buffer.alloc(0);
  const lines = [];
  const waiting = [];
  let failed = null;
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
    if (buffered.length > MAX_LINE_BYTES) {
      socket.destroy(new Error('NNTP response line exceeded limit'));
      return;
    }
    let split;
    while ((split = buffered.indexOf('\r\n')) >= 0) {
      const line = buffered.subarray(0, split).toString('utf8');
      buffered = buffered.subarray(split + 2);
      const waiter = waiting.shift();
      if (waiter) waiter.resolve(line); else lines.push(line);
    }
  });
  const rejectAll = (error) => {
    failed = error instanceof Error ? error : new Error('NNTP connection closed');
    while (waiting.length) waiting.shift().reject(failed);
  };
  socket.once('error', rejectAll);
  socket.once('close', () => rejectAll(new Error('NNTP connection closed')));
  return function readLine(timeoutMs) {
    if (lines.length) return Promise.resolve(lines.shift());
    if (failed) return Promise.reject(failed);
    return new Promise((resolve, reject) => {
      const waiter = { resolve: null, reject: null };
      const timer = setTimeout(() => {
        const index = waiting.indexOf(waiter);
        if (index >= 0) waiting.splice(index, 1);
        reject(new Error('NNTP response timed out'));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      waiter.resolve = (value) => { clearTimeout(timer); resolve(value); };
      waiter.reject = (error) => { clearTimeout(timer); reject(error); };
      waiting.push(waiter);
    });
  };
}

function waitConnected(socket, event, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup(); socket.destroy(); reject(new Error(label + ' timed out'));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    const onReady = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    function cleanup() {
      clearTimeout(timer); socket.removeListener(event, onReady); socket.removeListener('error', onError);
    }
    socket.once(event, onReady);
    socket.once('error', onError);
  });
}

async function proxyTunnel(proxyValue, host, port, timeoutMs) {
  const proxy = new URL(proxyValue);
  if (!['http:', 'https:'].includes(proxy.protocol)) throw new Error('NNTP proxy must use HTTP or HTTPS');
  const proxyPort = Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80));
  const socket = proxy.protocol === 'https:'
    ? tls.connect({ host: proxy.hostname, port: proxyPort, servername: proxy.hostname })
    : net.connect({ host: proxy.hostname, port: proxyPort });
  await waitConnected(socket, proxy.protocol === 'https:' ? 'secureConnect' : 'connect', timeoutMs, 'Proxy connection');
  const authority = host.includes(':') ? '[' + host + ']:' + port : host + ':' + port;
  let request = 'CONNECT ' + authority + ' HTTP/1.1\r\nHost: ' + authority + '\r\n';
  if (proxy.username || proxy.password) {
    request += 'Proxy-Authorization: Basic ' + Buffer.from(
      decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64') + '\r\n';
  }
  request += 'Connection: keep-alive\r\n\r\n';
  socket.write(request);
  const header = await new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => { cleanup(); reject(new Error('NNTP proxy CONNECT timed out')); }, timeoutMs);
    if (timer.unref) timer.unref();
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
      if (buffered.length > MAX_LINE_BYTES) {
        cleanup(); reject(new Error('NNTP proxy response exceeded limit')); return;
      }
      const split = buffered.indexOf('\r\n\r\n');
      if (split < 0) return;
      const head = buffered.subarray(0, split).toString('utf8');
      const rest = buffered.subarray(split + 4);
      cleanup();
      socket.pause();
      if (rest.length) socket.unshift(rest);
      resolve(head);
    };
    const onError = (error) => { cleanup(); reject(error); };
    function cleanup() {
      clearTimeout(timer); socket.removeListener('data', onData); socket.removeListener('error', onError);
    }
    socket.on('data', onData); socket.once('error', onError);
  });
  const first = String(header).split('\r\n', 1)[0];
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(first);
  if (!match || Number(match[1]) !== 200) {
    socket.destroy();
    throw new Error('NNTP proxy CONNECT failed' + (match ? ' with HTTP ' + match[1] : ''));
  }
  return socket;
}

async function openSocket(config, options) {
  const opts = options || {};
  const timeoutMs = Math.max(500, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const targetUrl = 'nntp://' + config.host + ':' + config.port;
  const proxy = opts.proxyUrl === undefined ? httpAgent.proxyUrl : opts.proxyUrl;
  const bypass = opts.proxyUrl === undefined ? httpAgent.shouldBypass(targetUrl) : false;
  const useProxy = Boolean(proxy) && !bypass;
  let socket;
  if (useProxy) socket = await proxyTunnel(proxy, config.host, config.port, timeoutMs);
  else {
    socket = net.connect({ host: config.host, port: config.port });
    await waitConnected(socket, 'connect', timeoutMs, 'NNTP connection');
  }
  if (config.tls) {
    socket = tls.connect({
      socket, servername: net.isIP(config.host) ? undefined : config.host,
      rejectUnauthorized: opts.rejectUnauthorized !== false,
    });
    await waitConnected(socket, 'secureConnect', timeoutMs, 'NNTP TLS handshake');
  }
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30000);
  return { socket, timeoutMs, proxied: useProxy };
}

async function testConnection(input, options) {
  const config = normalizeConfig(input);
  const opened = await openSocket(config, options);
  const { socket, timeoutMs } = opened;
  const read = lineReader(socket);
  socket.resume();
  const command = async (value) => { socket.write(value + '\r\n'); return read(timeoutMs); };
  try {
    const greeting = await read(timeoutMs);
    const greetingCode = statusCode(greeting);
    if (greetingCode !== 200 && greetingCode !== 201) throw new Error('NNTP server rejected the connection (' + greetingCode + ')');
    if (config.username) {
      const userCode = statusCode(await command('AUTHINFO USER ' + config.username));
      if (userCode !== 281 && userCode !== 381) throw new Error('NNTP username was rejected (' + userCode + ')');
      if (userCode === 381) {
        const passCode = statusCode(await command('AUTHINFO PASS ' + config.password));
        if (passCode !== 281) throw new Error('NNTP authentication failed (' + passCode + ')');
      }
    }
    const dateLine = await command('DATE');
    const dateCode = statusCode(dateLine);
    if (dateCode !== 111) throw new Error('NNTP capability check failed (' + dateCode + ')');
    return { ok: true, greetingCode, proxied: opened.proxied };
  } finally {
    if (!socket.destroyed) { socket.write('QUIT\r\n'); socket.end(); }
  }
}

module.exports = { DEFAULT_TIMEOUT_MS, normalizeConfig, statusCode, testConnection };
