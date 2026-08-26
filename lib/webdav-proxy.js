'use strict';

const fetchDefault = require('node-fetch');

const DEFAULT_HEADER_TIMEOUT_MS = Math.max(1000,
  parseInt(process.env.NZBDAV_HEADER_TIMEOUT_MS || '15000', 10));

async function proxyWebdav(req, res, upstream, options) {
  const opts = options || {};
  const controller = new AbortController();
  const onAborted = () => controller.abort();
  req.once('aborted', onAborted);
  const timer = setTimeout(() => controller.abort(),
    Math.max(250, Number(opts.headerTimeoutMs) || DEFAULT_HEADER_TIMEOUT_MS));
  if (timer.unref) timer.unref();
  const headers = Object.assign({ Accept: '*/*' }, upstream.headers || {});
  if (req.headers.range) headers.Range = String(req.headers.range);
  if (req.headers['if-range']) headers['If-Range'] = String(req.headers['if-range']);
  let response;
  try {
    response = await (opts.fetchImpl || fetchDefault)(upstream.url, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers, signal: controller.signal, redirect: 'manual',
    });
  } finally {
    clearTimeout(timer);
    if (!response) req.removeListener('aborted', onAborted);
  }
  if (response.status >= 300 && response.status < 400) {
    if (response.body && response.body.destroy) response.body.destroy();
    req.removeListener('aborted', onAborted);
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
  res.setHeader('Cache-Control', 'private, no-store');
  res.statusCode = response.status;
  await new Promise((resolve, reject) => {
    response.body.once('error', reject);
    response.body.once('end', resolve);
    response.body.pipe(res);
  }).finally(() => {
    req.removeListener('aborted', onAborted);
  });
}

module.exports = { proxyWebdav, DEFAULT_HEADER_TIMEOUT_MS };
