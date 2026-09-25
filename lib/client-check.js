'use strict';

// Client check: walk an account's addon the way Nuvio does — manifest, then
// every catalog, then event details and the stream list — over HTTP against
// this server, and report what a client would have seen.
//
// It replaces "Check it works" (removed in 0.95.1), which chose the most recent
// fixture, found nothing on working installs (a Friday practice nobody had
// released yet) and told the user their setup was broken. Recency says nothing
// about availability. This check picks, per promotion, a recent event that SSS
// already holds a release for — saved in the availability database, matched
// by Sport-Video, or saved by the Prowlarr queue — and only an event like that
// can fail for having no rows. An event with no known release is still
// checked, but labelled exploratory, and no rows there is information, not an
// error.
//
// It is read-only in intent: nothing is resolved or played, so TorBox and the
// Usenet providers see searches but no downloads. Stream requests are real
// requests, though: they search live exactly as an opened event would.

const fetchDefault = require('node-fetch');

const DAY = 24 * 60 * 60 * 1000;
const SLOW_MS = 15000;
const LOOKBACK_DAYS = 14;

// Every release SSS already knows for an event, by source. Each lookup fails
// soft: a source that cannot be read simply contributes nothing.
function knownReleaseEvents(deps) {
  const known = new Set();
  const add = (id) => { if (id) known.add(String(id)); };
  try {
    const index = deps.availabilityIndex();
    if (index && typeof index.eventIdsWithReleases === 'function') index.eventIdsWithReleases().forEach(add);
  } catch (_) { /* no availability database */ }
  try {
    for (const record of (deps.sportVideo().load().releases || [])) {
      if (!record || !record.infoHash) continue;
      for (const match of record.matches || []) add(match && match.eventId);
    }
  } catch (_) { /* Sport-Video unavailable */ }
  try {
    for (const row of (deps.prowlarrQueue().status().matchedEvents || [])) add(row && (row.event || row.id));
  } catch (_) { /* Prowlarr queue unavailable */ }
  return known;
}

// One event per promotion: the most recent finished one with a known release,
// else the most recent finished one, marked exploratory.
function selectEvents(events, promotionIds, known, now) {
  const today = new Date(now).toISOString().slice(0, 10);
  const floor = new Date(now - LOOKBACK_DAYS * DAY).toISOString().slice(0, 10);
  const byPromotion = new Map();
  for (const event of events || []) {
    const promotion = String(event && event.id || '').split(':')[0];
    if (!promotionIds.has(promotion) || !event.date || event.date > today || event.date < floor) continue;
    if (/cancel|postpon/i.test(String(event.status || ''))) continue;
    if (!byPromotion.has(promotion)) byPromotion.set(promotion, []);
    byPromotion.get(promotion).push(event);
  }
  const picks = [];
  for (const promotion of promotionIds) {
    const list = (byPromotion.get(promotion) || []).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const withRelease = list.find((event) => known.has(event.id));
    if (withRelease) picks.push({ promotion, event: withRelease, expected: true });
    else if (list[0]) picks.push({ promotion, event: list[0], expected: false });
    else picks.push({ promotion, event: null, expected: false });
  }
  return picks;
}

function playableRow(row) {
  return row && (typeof row.url === 'string' || typeof row.infoHash === 'string' || typeof row.externalUrl === 'string');
}

// Judge one stream response. `expected` is whether SSS knows a release exists.
function judgeStreams(body, ms, expected, pageProtocol) {
  const rows = Array.isArray(body && body.streams) ? body.streams : [];
  const problems = [];
  const warnings = [];
  const unplayable = rows.filter((row) => !playableRow(row)).length;
  if (unplayable) problems.push(unplayable + ' row(s) with no playable link');
  const unnamed = rows.filter((row) => !row || !String(row.name || row.title || '').trim()).length;
  if (unnamed) problems.push(unnamed + ' row(s) with no name');
  const urls = rows.map((row) => row && row.url).filter(Boolean);
  if (new Set(urls).size !== urls.length) warnings.push('duplicate rows');
  if (pageProtocol === 'https:' && urls.some((url) => /^http:\/\//i.test(url) && !/^http:\/\/(?:127\.|10\.|192\.168\.|localhost)/i.test(url))) {
    warnings.push('playback links are http:// while the page is https — set PUBLIC_URL');
  }
  const pipelines = (body && body.diagnostics && body.diagnostics.pipelines) || {};
  for (const [name, info] of Object.entries(pipelines)) {
    if (info.status === 'timeout') warnings.push(name + ' timed out');
    if (info.status === 'failed') warnings.push(name + ' failed: ' + (info.error || 'error'));
  }
  if (ms > SLOW_MS) warnings.push('slow: ' + (ms / 1000).toFixed(1) + 's');
  let verdict;
  if (problems.length) verdict = 'fail';
  else if (!rows.length) verdict = expected ? 'fail' : 'info';
  else verdict = warnings.length ? 'warn' : 'pass';
  if (!rows.length) {
    (expected ? problems : warnings).push(expected
      ? 'no rows, although SSS holds a release for this event'
      : 'no rows; no release is known for this event yet');
  }
  return { verdict, rows: rows.length, problems, warnings, pipelines,
    pipelineRows: (body && body.pipelineRows) || null,
    requestId: body && body.diagnostics && body.diagnostics.requestId || null };
}

function judgeCatalog(body) {
  const metas = Array.isArray(body && body.metas) ? body.metas : [];
  const bad = metas.filter((meta) => !meta || !meta.id || !meta.name).length;
  const noPoster = metas.filter((meta) => meta && !meta.poster).length;
  const problems = bad ? [bad + ' item(s) missing an id or name'] : [];
  const warnings = [];
  if (!metas.length) warnings.push('empty');
  if (noPoster) warnings.push(noPoster + ' item(s) without a poster');
  return { verdict: problems.length ? 'fail' : warnings.length ? 'warn' : 'pass', items: metas.length, problems, warnings };
}

function judgeManifest(body, installUrl, pageProtocol) {
  const problems = [];
  const warnings = [];
  for (const key of ['id', 'version', 'name', 'resources', 'types', 'catalogs']) {
    if (!body || body[key] === undefined) problems.push('missing "' + key + '"');
  }
  const resources = ((body && body.resources) || []).map((r) => (typeof r === 'string' ? r : r && r.name));
  for (const needed of ['catalog', 'meta']) {
    if (body && body.resources && !resources.includes(needed)) problems.push('does not offer "' + needed + '"');
  }
  // Streams are offered only when the account has a playback service; a
  // metadata-only account is valid, and Nuvio then never asks for streams.
  const streamOffered = resources.includes('stream');
  if (body && body.resources && !streamOffered) warnings.push('no playback service configured, so no stream lists are offered');
  if (pageProtocol === 'https:' && /^http:\/\//i.test(String(installUrl || ''))) {
    warnings.push('install link is http:// while this page is https — set PUBLIC_URL');
  }
  return { verdict: problems.length ? 'fail' : warnings.length ? 'warn' : 'pass', problems, warnings, streamOffered,
    version: body && body.version, catalogs: Array.isArray(body && body.catalogs) ? body.catalogs.length : 0 };
}

async function timedJson(fetchImpl, url, headers, timeoutMs) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) { /* reported below */ }
    return { ok: response.ok && body !== null, status: response.status, body, ms: Date.now() - started,
      error: body === null ? 'not JSON (HTTP ' + response.status + ')' : (response.ok ? null : 'HTTP ' + response.status) };
  } catch (error) {
    return { ok: false, status: 0, body: null, ms: Date.now() - started,
      error: controller.signal.aborted ? 'timed out after ' + Math.round(timeoutMs / 1000) + 's' : error.message };
  } finally { clearTimeout(timer); }
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  async function run() { while (next < items.length) { const i = next++; out[i] = await worker(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

// Run the check. `base` is the account's addon root on this server, e.g.
// http://127.0.0.1:7000/u/<id>/<token>/ ; `host` is sent so generated links
// match what a client reaching the public address would get.
async function run(opts) {
  const o = opts || {};
  const fetchImpl = o.fetchImpl || fetchDefault;
  const headers = Object.assign({ Accept: 'application/json', 'User-Agent': 'SeriousSportSync-ClientCheck/1' },
    o.host ? { Host: o.host } : {});
  const progress = typeof o.onProgress === 'function' ? o.onProgress : () => {};
  const now = o.now || Date.now();
  const report = { startedAt: new Date(now).toISOString(), account: o.username || '', manifest: null, catalogs: [], events: [] };

  progress('Fetching the manifest');
  const manifest = await timedJson(fetchImpl, o.base + 'manifest.json', headers, 15000);
  report.manifest = manifest.ok
    ? Object.assign({ ms: manifest.ms }, judgeManifest(manifest.body, o.installUrl, o.pageProtocol))
    : { verdict: 'fail', ms: manifest.ms, problems: [manifest.error], warnings: [] };
  if (!manifest.ok) { report.finishedAt = new Date().toISOString(); return report; }

  const catalogs = (manifest.body.catalogs || []).filter((c) => c && c.id && c.type);
  let done = 0;
  report.catalogs = await mapLimit(catalogs, 4, async (catalog) => {
    const result = await timedJson(fetchImpl, o.base + 'catalog/' + encodeURIComponent(catalog.type) + '/'
      + encodeURIComponent(catalog.id) + '.json', headers, 20000);
    progress('Catalogs ' + (++done) + '/' + catalogs.length);
    return Object.assign({ id: catalog.id, name: catalog.name || catalog.id, type: catalog.type, ms: result.ms },
      result.ok ? judgeCatalog(result.body) : { verdict: 'fail', items: 0, problems: [result.error], warnings: [] });
  });

  // Promotions this account actually sees, from the catalogs it was served.
  const owner = new Map();
  for (const promotion of o.promotions || []) {
    for (const catalog of promotion.catalogs || []) owner.set(catalog.id, promotion);
  }
  const typeFor = new Map();
  const promotionIds = new Set();
  for (const catalog of catalogs) {
    const promotion = owner.get(catalog.id);
    if (!promotion) continue;
    if (o.only && !o.only.includes(promotion.id)) continue;
    promotionIds.add(promotion.id);
    if (!typeFor.has(promotion.id)) typeFor.set(promotion.id, catalog.type);
  }
  const names = new Map((o.promotions || []).map((p) => [p.id, p.name]));
  const picks = o.eventId
    ? [{ promotion: String(o.eventId).split(':')[0], event: (o.events || []).find((e) => e.id === o.eventId) || { id: o.eventId, name: o.eventId },
      expected: o.known ? o.known.has(o.eventId) : false }]
    : selectEvents(o.events || [], promotionIds, o.known || new Set(), now);

  done = 0;
  report.events = await mapLimit(picks, o.concurrency || 2, async (pick) => {
    const entry = { promotion: pick.promotion, promotionName: names.get(pick.promotion) || pick.promotion,
      expected: pick.expected };
    if (!pick.event) {
      progress('Events ' + (++done) + '/' + picks.length);
      return Object.assign(entry, { verdict: 'info', problems: [], warnings: ['no finished event in the last ' + LOOKBACK_DAYS + ' days'] });
    }
    const type = typeFor.get(pick.promotion) || 'movie';
    entry.eventId = pick.event.id;
    entry.eventName = pick.event.name;
    entry.date = pick.event.date;
    const meta = await timedJson(fetchImpl, o.base + 'meta/' + type + '/' + encodeURIComponent(pick.event.id) + '.json', headers, 15000);
    entry.meta = meta.ok && meta.body && meta.body.meta && meta.body.meta.id === pick.event.id
      ? { verdict: 'pass', ms: meta.ms } : { verdict: 'fail', ms: meta.ms, error: meta.error || 'meta did not describe this event' };
    if (report.manifest.streamOffered === false) {
      progress('Events ' + (++done) + '/' + picks.length);
      return Object.assign(entry, { verdict: entry.meta.verdict === 'fail' ? 'fail' : 'info', rows: undefined,
        problems: entry.meta.verdict === 'fail' ? ['event details: ' + entry.meta.error] : [],
        warnings: ['streams not offered: the account has no playback service'] });
    }
    const stream = await timedJson(fetchImpl, o.base + 'stream/' + type + '/' + encodeURIComponent(pick.event.id) + '.json?debug=1',
      headers, o.streamTimeoutMs || 60000);
    entry.ms = stream.ms;
    if (!stream.ok) Object.assign(entry, { verdict: 'fail', rows: 0, problems: [stream.error], warnings: [] });
    else Object.assign(entry, judgeStreams(stream.body, stream.ms, pick.expected, o.pageProtocol));
    if (entry.meta.verdict === 'fail') { entry.verdict = 'fail'; entry.problems.push('event details: ' + entry.meta.error); }
    progress('Events ' + (++done) + '/' + picks.length);
    return entry;
  });

  const all = [report.manifest, ...report.catalogs, ...report.events];
  report.summary = ['pass', 'warn', 'info', 'fail'].reduce((out, v) => { out[v] = all.filter((x) => x && x.verdict === v).length; return out; }, {});
  report.finishedAt = new Date().toISOString();
  return report;
}

module.exports = { run, selectEvents, knownReleaseEvents, judgeStreams, judgeCatalog, judgeManifest, SLOW_MS, LOOKBACK_DAYS };
