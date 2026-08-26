'use strict';

const fetchDefault = require('node-fetch');
const path = require('path');
const { pipeline } = require('stream');

const DEFAULT_HEADER_TIMEOUT_MS = Math.max(1000,
  parseInt(process.env.NZBDAV_HEADER_TIMEOUT_MS || '15000', 10));

async function proxyWebdav(req, res, upstream, options) {
  const opts = options || {};
  const controller = new AbortController();
  let response;
  let clientCancelled = false;
  let headerTimedOut = false;
  const onAborted = () => {
    clientCancelled = true;
    controller.abort();
    if (response && response.body && response.body.destroy) response.body.destroy();
  };
  const onClosed = () => {
    if (!res.writableEnded) onAborted();
  };
  req.once('aborted', onAborted);
  res.once('close', onClosed);
  const timer = setTimeout(() => {
    headerTimedOut = true;
    controller.abort();
  }, Math.max(250, Number(opts.headerTimeoutMs) || DEFAULT_HEADER_TIMEOUT_MS));
  if (timer.unref) timer.unref();
  const headers = Object.assign({ Accept: '*/*' }, upstream.headers || {});
  if (req.headers.range) headers.Range = String(req.headers.range);
  if (req.headers['if-range']) headers['If-Range'] = String(req.headers['if-range']);
  try {
    response = await (opts.fetchImpl || fetchDefault)(upstream.url, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers, signal: controller.signal, redirect: 'manual',
    });
  } catch (error) {
    if (clientCancelled && !headerTimedOut) return { cancelled: true };
    throw error;
  } finally {
    clearTimeout(timer);
    if (!response) cleanup();
  }
  if (response.status >= 300 && response.status < 400) {
    if (response.body && response.body.destroy) response.body.destroy();
    cleanup();
    throw new Error('WebDAV redirects are not allowed for authenticated playback');
  }
  const forwarded = [
    'accept-ranges', 'content-length', 'content-range', 'content-type',
    'content-disposition', 'etag', 'last-modified',
  ];
  for (const name of forwarded) {
    const value = response.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  if (!res.hasHeader('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
  const filename = filenameFromUrl(upstream.url);
  const currentType = String(res.getHeader('content-type') || '').toLowerCase();
  if (!currentType || currentType === 'application/octet-stream') {
    const inferredType = mediaType(filename);
    if (inferredType) res.setHeader('Content-Type', inferredType);
  }
  if (filename && !res.hasHeader('content-disposition')) {
    res.setHeader('Content-Disposition', 'inline; filename*=UTF-8\'\'' + encodeURIComponent(filename));
  }
  res.setHeader('Cache-Control', 'private, no-store');
  res.statusCode = response.status;

  // Players commonly issue HEAD probes and immediately cancel speculative GET
  // ranges. A HEAD response has no body in node-fetch and must be ended here;
  // trying to pipe it used to turn a valid playback probe into a 502.
  if (req.method === 'HEAD' || !response.body) {
    res.end();
    cleanup();
    return { cancelled: false };
  }

  try {
    await new Promise((resolve, reject) => {
      pipeline(response.body, res, (error) => error ? reject(error) : resolve());
    });
  } catch (error) {
    if (!clientCancelled) throw error;
    return { cancelled: true };
  } finally {
    cleanup();
  }
  return { cancelled: false };

  function cleanup() {
    req.removeListener('aborted', onAborted);
    res.removeListener('close', onClosed);
  }
}

function filenameFromUrl(value) {
  try {
    const name = path.posix.basename(new URL(value).pathname);
    return decodeURIComponent(name);
  } catch (_) { return ''; }
}

function mediaType(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return {
    '.mkv': 'video/x-matroska', '.mp4': 'video/mp4', '.m4v': 'video/mp4',
    '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime',
    '.ts': 'video/mp2t', '.m2ts': 'video/mp2t',
  }[ext] || '';
}

module.exports = { proxyWebdav, filenameFromUrl, mediaType, DEFAULT_HEADER_TIMEOUT_MS };
