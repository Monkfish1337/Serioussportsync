// 0.33.0 — SeriousSportScraper companion client.
//
// The metadata addon delegates all indexer-side scraping to a separately
// deployed companion service (SeriousSportScraper) which the operator
// configures via the admin "Companion Scraper URL" field. This keeps the
// public metadata addon free of any content-providing code paths.
//
// Protocol:
//   POST <companion-url>/scrape
//   Body: { promotion, event, searchTitles, budgetMs, requestId }
//   Response: { candidates: [{ infoHash, title, size, seeders, indexer,
//                              magnetTrackers? }] }
//
// The companion is utterly stateless from the addon's perspective: send
// titles, receive hash candidates. Noise + relevance filtering, sorting,
// TorBox resolution, and stream-row construction all happen on the
// metadata-addon side.
//
// Authentication: optional shared `COMPANION_AUTH_TOKEN` env on both
// sides, passed via `Authorization: Bearer <token>`. Used only to stop
// random callers hitting an operator's companion endpoint if it's
// internet-exposed.

const fetch = require('node-fetch');
const settings = require('../settings');
const httpAgent = require('../http-agent');
const boundedBody = require('../bounded-body');

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

async function scrape({ promotion, event, searchTitles, log, budgetMs, throwOnFailure, fetchImpl }) {
  log = log || (() => {});
  const cfg = settings.getCompanion();
  if (!cfg.url) { log('  companion: not configured'); return []; }
  if (!Array.isArray(searchTitles) || searchTitles.length === 0) {
    log('  companion: no searchTitles supplied');
    return [];
  }

  const url = cfg.url.replace(/\/+$/, '') + '/scrape';
  const requestedBudgetMs = Number(budgetMs)
    || Number(process.env.COMPANION_SEARCH_BUDGET_MS) || 0;
  const request = {
    promotion: promotion ? promotion.id : null,
    event: event ? {
      id: event.id, name: event.name, date: event.date,
      round: event.round || null, kind: event.kind || null,
    } : null,
    searchTitles,
  };
  // Manual/admin callers keep the companion's normal timeout. Stream calls
  // explicitly pass the shorter discovery budget.
  if (requestedBudgetMs > 0) request.budgetMs = Math.max(1000, requestedBudgetMs);
  const body = JSON.stringify(request);

  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (cfg.authToken) headers.Authorization = 'Bearer ' + cfg.authToken;

  // Allow a small transport margin after the companion's own response budget.
  const configuredTimeoutMs = parseInt(process.env.COMPANION_TIMEOUT_MS || '30000', 10);
  const timeoutMs = requestedBudgetMs > 0
    ? Math.min(configuredTimeoutMs, Math.max(1000, requestedBudgetMs) + 1000)
    : configuredTimeoutMs;
  let res;
  try {
    res = await (fetchImpl || fetch)(url, httpAgent.fetchOpts({
      method: 'POST', headers, body, timeout: timeoutMs,
    }, url));
  } catch (err) {
    log('  companion: network error: ' + err.message);
    if (throwOnFailure) throw err;
    return [];
  }
  if (!res.ok) {
    log('  companion: HTTP ' + res.status + ' ' + res.statusText);
    if (throwOnFailure) throw new Error('companion HTTP ' + res.status);
    return [];
  }
  let payload;
  try { payload = await boundedBody.readJson(res, MAX_RESPONSE_BYTES, 'Companion response'); }
  catch (err) {
    log('  companion: bad JSON: ' + err.message);
    if (throwOnFailure) throw err;
    return [];
  }
  const candidates = Array.isArray(payload && payload.candidates) ? payload.candidates : [];
  log('  companion: ' + candidates.length + ' candidate(s) returned');
  // Defensive normalisation. Drop anything missing the two fields we need.
  const out = [];
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const hash = (c.infoHash || c.info_hash || '').toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(hash)) continue;
    if (!c.title || typeof c.title !== 'string') continue;
    out.push({
      infoHash: hash,
      title: c.title,
      size: Number(c.size) || 0,
      seeders: Number(c.seeders) || 0,
      // Source attribution is intentionally NOT propagated from the
      // companion scraper into the metadata addon — keeps the public
      // addon source-agnostic regardless of which scraper version is
      // upstream. Stream rows label themselves "TorBox" generically.
      magnetTrackers: Array.isArray(c.magnetTrackers) ? c.magnetTrackers : [],
      publishDate: c.publishDate || null,
    });
  }
  return out;
}

module.exports = { scrape };
