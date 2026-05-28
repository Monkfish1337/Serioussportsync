// Direct Zilean client.
//
// Zilean indexes the DebridMediaManager community hashlists (Postgres/Lucene)
// and exposes a keyword search that returns release filenames + infohashes —
// no seeders, no magnet, just the hash (which is all we need: streams.js
// builds the magnet and the debrid layer checks whether it's cached).
//
// Especially valuable for a debrid setup: a hit here is content someone has
// already added to a debrid service, so it is very likely already cached on
// RD/TorBox/Premiumize.
//
// Zilean is an INTERNAL stack service (e.g. http://zilean:8181), so we hit it
// directly with a plain fetch — NOT through the gluetun VPN proxy that the
// public indexers use.

const fetch = require('node-fetch');
const config = require('../../config');
const settings = require('../settings');

const TIMEOUT_MS = 12000;
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function normHash(h) {
  if (!h || typeof h !== 'string') return '';
  return /^[A-Fa-f0-9]{40}$/.test(h) ? h.toLowerCase() : '';
}

async function search(query, options) {
  const opts = options || {};
  const log = opts.log || (() => {});
  const base = settings.getZilean().url;
  if (!base || !query) return [];

  const url = base.replace(/\/+$/, '') + '/dmm/search';
  let res = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ queryText: query }),
        timeout: TIMEOUT_MS,
      });
    } catch (err) {
      if (attempt === 0) { log('  zilean: ' + err.message + ' — retrying'); await delay(1200); continue; }
      log('  zilean: network error: ' + err.message);
      return [];
    }
    if (res.ok) break;
    if ((res.status === 429 || res.status === 503) && attempt === 0) {
      log('  zilean: HTTP ' + res.status + ' — retrying'); await delay(1200); res = null; continue;
    }
    log('  zilean: HTTP ' + res.status);
    return [];
  }
  if (!res) return [];

  let body;
  try { body = await res.json(); }
  catch (err) { log('  zilean: bad JSON: ' + err.message); return []; }

  const items = Array.isArray(body) ? body
    : (body && Array.isArray(body.results) ? body.results : []);

  const out = [];
  const seen = new Set();
  for (const it of items) {
    const hash = normHash(it.infoHash || it.InfoHash || it.info_hash || it.hash);
    if (!hash || seen.has(hash)) continue;
    seen.add(hash);
    const title = it.filename || it.raw_title || it.rawTitle || it.title || it.Filename || '';
    out.push({
      title: String(title),
      infoHash: hash,
      size: Number(it.filesize || it.fileSize || it.size || 0) || 0,
      seeders: 0,        // Zilean has no seeder data; runFilter no longer drops these
      leechers: 0,
      magnetUrl: null,   // streams.js builds the magnet from infoHash
      downloadUrl: null,
      indexer: 'Zilean',
      publishDate: null,
    });
  }
  return out;
}

async function multiSearch(queries, options) {
  const opts = options || {};
  const log = opts.log || (() => {});
  if (!settings.getZilean().url) return []; // disabled — no-op, no log spam
  const seen = new Set();
  const out = [];
  for (const q of queries) {
    log('  zilean: query "' + q + '"');
    const results = await search(q, { log });
    log('    -> ' + results.length + ' hits');
    for (const r of results) {
      if (seen.has(r.infoHash)) continue;
      seen.add(r.infoHash);
      out.push(r);
    }
  }
  return out;
}

module.exports = { search, multiSearch };
