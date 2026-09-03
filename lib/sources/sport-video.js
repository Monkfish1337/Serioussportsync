'use strict';

// Curated Sport-Video discovery source.
//
// The public RSS feed is useful as a change signal but every item links to the
// homepage and carries no GUID, publication date, enclosure, or torrent URL.
// Consequently discovery reads the bounded category indexes, matches their
// visible event titles to the existing SSS catalog, and only then hydrates a
// small number of detail/torrent records. Nothing is submitted to TorBox here.
//
// 0.81.1: the seven per-sport catalogue pages only expose a short recent
// window — together they list roughly 300 releases, while a single month of
// the dated archive lists ~600 across ten paginated pages, most of which never
// appear on a category page at all. Discovery therefore also walks a bounded
// number of the newest archive pages, discovered from the site's own index
// rather than by guessing month filenames.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const config = require('../../config');
const httpAgent = require('../http-agent');
const boundedBody = require('../bounded-body');
const releaseFilter = require('./release-filter');
const settings = require('../settings');

const ORIGIN = 'https://sport-video.org.ua';
const RSS_URL = ORIGIN + '/rss.xml';
const INDEX_URL = ORIGIN + '/index.html';
// Archive filenames are "<month><year>.html" with an optional "-<page>" suffix
// once a month grows past one page (august2026-1.html … august2026-10.html).
const ARCHIVE_MONTHS = Object.freeze(['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december']);
const ARCHIVE_RE = new RegExp(
  '^(' + ARCHIVE_MONTHS.join('|') + ')((?:19|20)\\d{2})(?:-(\\d{1,3}))?\\.html$', 'i');
// Records first seen on an archive page carry no sport label. They keep this
// placeholder until a category page confirms one, which never downgrades a
// category that is already known.
const UNCATEGORISED = 'archive';
const CATEGORY_PATHS = Object.freeze({
  americanfootball: '/americanfootball.html',
  basketball: '/basketball.html',
  baseball: '/baseball.html',
  football: '/football.html',
  hockey: '/hockey.html',
  rugby: '/rugby.html',
  other: '/other.html',
});
const STORE_FILE = config.sportVideoFile || './data/sport-video.json';
const MAX_RELEASES = 2000;
const USER_AGENT = 'SeriousSportSync/' + (require('../../package.json').version || 'unknown')
  + ' (+https://github.com/Monkfish1337/Serioussportsync)';

let running = null;
let schedulerTimer = null;
let startupTimer = null;
let runtime = {
  running: false, current: '', startedAt: null, completedAt: null,
  lastError: '', scannedPages: 0, discovered: 0, matched: 0, prepared: 0,
};

function emptyState() {
  return { version: 1, releases: [], lastScanAt: null, lastSuccessAt: null, lastError: '' };
}

function load() {
  try {
    if (!fs.existsSync(STORE_FILE)) return emptyState();
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (!parsed || !Array.isArray(parsed.releases)) return emptyState();
    return Object.assign(emptyState(), parsed);
  } catch (error) {
    console.error('[sport-video] state read failed: ' + error.message);
    return emptyState();
  }
}

function save(state) {
  const dir = path.dirname(STORE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = STORE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_FILE);
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n) || 0))
    .replace(/\s+/g, ' ').trim();
}

function stripTags(value) {
  return decodeHtml(String(value || '').replace(/<[^>]*>/g, ' '));
}

function sourceUrl(value, suffix) {
  let parsed;
  try { parsed = new URL(String(value || ''), ORIGIN); }
  catch (_) { throw new Error('Sport-Video returned an invalid URL'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== ORIGIN) {
    throw new Error('Sport-Video URL left the approved source origin');
  }
  if (suffix && !parsed.pathname.toLowerCase().endsWith(suffix)) {
    throw new Error('Sport-Video returned an unexpected resource type');
  }
  parsed.hash = '';
  return parsed.toString();
}

async function fetchBounded(url, options) {
  const opts = options || {};
  let current = sourceUrl(url, opts.suffix);
  for (let redirects = 0; redirects <= 2; redirects += 1) {
    const response = await fetch(current, httpAgent.fetchOpts({
      headers: { Accept: opts.accept || 'text/html,application/xhtml+xml', 'User-Agent': USER_AGENT },
      timeout: opts.timeoutMs || 12000,
      redirect: 'manual',
    }, current));
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === 2) throw new Error('Sport-Video redirected too many times');
      current = sourceUrl(new URL(response.headers.get('location') || '', current).toString(), opts.suffix);
      continue;
    }
    if (!response.ok) throw new Error('Sport-Video returned HTTP ' + response.status);
    return {
      url: current,
      response,
      body: await boundedBody.readBuffer(response, opts.maxBytes || 1024 * 1024, opts.label || 'Sport-Video response'),
    };
  }
  throw new Error('Sport-Video request failed');
}

function extractDate(title) {
  const match = String(title || '').match(/\b(\d{2})[.\-/](\d{2})[.\-/]((?:19|20)\d{2})\b/);
  if (!match) return '';
  return match[3] + '-' + match[2] + '-' + match[1];
}

function parseRss(xml) {
  const output = [];
  const re = /<item\b[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>[\s\S]*?<\/item>/gi;
  let match;
  while ((match = re.exec(String(xml || ''))) && output.length < 1000) {
    const title = stripTags(match[1]);
    if (title) output.push(title);
  }
  return Array.from(new Set(output));
}

// Collect the dated archive pages the site links from its own index, newest
// first. Ordering is derived from the filename (year, month, then page number)
// so a scan always spends its page budget on the most recent releases, which
// are the ones that can still match an upcoming or just-finished fixture.
function parseArchiveLinks(html) {
  const seen = new Map();
  const re = /<a\s+[^>]*href=["']\.?\/?([A-Za-z]+\d{4}(?:-\d{1,3})?\.html)["']/gi;
  let match;
  while ((match = re.exec(String(html || '')))) {
    const file = decodeHtml(match[1]);
    const parts = file.match(ARCHIVE_RE);
    if (!parts || seen.has(file.toLowerCase())) continue;
    seen.set(file.toLowerCase(), {
      file,
      year: Number(parts[2]),
      month: ARCHIVE_MONTHS.indexOf(parts[1].toLowerCase()) + 1,
      page: Number(parts[3] || 1),
    });
  }
  return Array.from(seen.values()).sort((a, b) =>
    b.year - a.year || b.month - a.month || a.page - b.page);
}

function parseCatalog(html, category) {
  const releases = [];
  // Each generated catalogue card places its visible <strong> title before a
  // same-card relative detail link. The small distance cap prevents a heading
  // or navigation label from attaching to an unrelated event.
  const re = /<strong>([\s\S]{1,400}?)<\/strong>[\s\S]{0,2600}?<a\s+[^>]*href=["']\.\/([^"'?#]+\.html)["']/gi;
  let match;
  while ((match = re.exec(String(html || ''))) && releases.length < 1000) {
    const title = stripTags(match[1]);
    const file = decodeHtml(match[2]);
    if (!title || !extractDate(title) || /^(?:index|schedule|oldergames)\.html$/i.test(file)) continue;
    let detailUrl;
    try { detailUrl = sourceUrl('/' + file.replace(/^\/+/, ''), '.html'); }
    catch (_) { continue; }
    releases.push({
      id: crypto.createHash('sha256').update(detailUrl).digest('hex').slice(0, 24),
      title: title.slice(0, 500),
      date: extractDate(title),
      category: String(category || 'other'),
      detailUrl,
    });
  }
  return releases;
}

function fieldFromDetail(html, label) {
  const wanted = String(label || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const rows = String(html || '').matchAll(/<tr\b[^>]*>([\s\S]{0,2000}?)<\/tr>/gi);
  for (const row of rows) {
    const cells = Array.from(row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]{0,800}?)<\/t[dh]>/gi));
    const actual = cells.length ? stripTags(cells[0][1]).toLowerCase().replace(/[^a-z0-9]/g, '') : '';
    if (cells.length >= 2 && actual === wanted) return stripTags(cells[1][1]);
  }
  return '';
}

function parseDetail(html, record) {
  const torrentMatch = String(html || '').match(/href=["']([^"']+\.torrent)["']/i);
  if (!torrentMatch) throw new Error('Sport-Video detail page has no torrent');
  const detailStem = path.basename(new URL(record.detailUrl).pathname, '.html').replace(/[^A-Za-z0-9_-]/g, '');
  const exactImage = detailStem
    ? new RegExp('(?:href|src)=["\']([^"\']*images/' + detailStem + '\\.(?:jpe?g|png|webp))["\']', 'i') : null;
  const imageMatch = (exactImage && String(html || '').match(exactImage))
    || String(html || '').match(/(?:href|src)=["']([^"']*\/images\/[^"']+\.(?:jpe?g|png|webp))["']/i)
    || String(html || '').match(/(?:href|src)=["'](images\/[^"']+\.(?:jpe?g|png|webp))["']/i);
  return Object.assign({}, record, {
    torrentUrl: sourceUrl(new URL(decodeHtml(torrentMatch[1]), record.detailUrl).toString(), '.torrent'),
    posterUrl: imageMatch ? sourceUrl(new URL(decodeHtml(imageMatch[1]), record.detailUrl).toString()) : '',
    video: fieldFromDetail(html, 'Video'),
    resolution: fieldFromDetail(html, 'Aspect Ratio'),
    language: fieldFromDetail(html, 'Language'),
    detailFetchedAt: new Date().toISOString(),
  });
}

function parseBencode(buffer) {
  let items = 0;
  function node(offset, depth) {
    if (depth > 32 || ++items > 20000 || offset >= buffer.length) throw new Error('Invalid torrent structure');
    const start = offset;
    const byte = buffer[offset];
    if (byte >= 48 && byte <= 57) {
      let colon = offset;
      while (colon < buffer.length && buffer[colon] !== 58) {
        if (buffer[colon] < 48 || buffer[colon] > 57 || colon - offset > 9) throw new Error('Invalid torrent string');
        colon += 1;
      }
      if (colon >= buffer.length) throw new Error('Invalid torrent string');
      const length = Number(buffer.toString('ascii', offset, colon));
      const valueStart = colon + 1;
      const end = valueStart + length;
      if (!Number.isSafeInteger(length) || length < 0 || end > buffer.length) throw new Error('Invalid torrent string length');
      return { start, end, value: buffer.subarray(valueStart, end) };
    }
    if (byte === 105) {
      const endMark = buffer.indexOf(101, offset + 1);
      if (endMark < 0) throw new Error('Invalid torrent integer');
      const raw = buffer.toString('ascii', offset + 1, endMark);
      if (!/^-?(?:0|[1-9]\d*)$/.test(raw)) throw new Error('Invalid torrent integer');
      return { start, end: endMark + 1, value: Number(raw) };
    }
    if (byte === 108) {
      const value = [];
      offset += 1;
      while (offset < buffer.length && buffer[offset] !== 101) {
        const child = node(offset, depth + 1);
        value.push(child.value); offset = child.end;
      }
      if (buffer[offset] !== 101) throw new Error('Invalid torrent list');
      return { start, end: offset + 1, value };
    }
    if (byte === 100) {
      const value = Object.create(null);
      const nodes = Object.create(null);
      offset += 1;
      while (offset < buffer.length && buffer[offset] !== 101) {
        const keyNode = node(offset, depth + 1);
        if (!Buffer.isBuffer(keyNode.value)) throw new Error('Invalid torrent dictionary key');
        const key = keyNode.value.toString('utf8');
        const valueNode = node(keyNode.end, depth + 1);
        value[key] = valueNode.value; nodes[key] = valueNode; offset = valueNode.end;
      }
      if (buffer[offset] !== 101) throw new Error('Invalid torrent dictionary');
      return { start, end: offset + 1, value, nodes };
    }
    throw new Error('Invalid torrent token');
  }
  const root = node(0, 0);
  if (root.end !== buffer.length || !root.nodes || !root.nodes.info) throw new Error('Torrent has no info dictionary');
  return root;
}

function bufferText(value) {
  return Buffer.isBuffer(value) ? value.toString('utf8').trim() : '';
}

function torrentMetadata(buffer) {
  const root = parseBencode(buffer);
  const info = root.value.info;
  if (!info || typeof info !== 'object' || Buffer.isBuffer(info)) throw new Error('Torrent info is invalid');
  const trackers = [];
  const addTracker = (value) => {
    const text = bufferText(value);
    if (/^https?:\/\//i.test(text) || /^udp:\/\//i.test(text)) trackers.push(text.slice(0, 1000));
  };
  addTracker(root.value.announce);
  for (const tier of (Array.isArray(root.value['announce-list']) ? root.value['announce-list'] : [])) {
    if (Array.isArray(tier)) tier.forEach(addTracker); else addTracker(tier);
  }
  let size = Number(info.length) || 0;
  if (Array.isArray(info.files)) size = info.files.reduce((sum, file) => sum + (Number(file && file.length) || 0), 0);
  return {
    infoHash: crypto.createHash('sha1').update(buffer.subarray(root.nodes.info.start, root.nodes.info.end)).digest('hex'),
    name: bufferText(info['name.utf-8'] || info.name),
    size: Math.max(0, size),
    trackers: Array.from(new Set(trackers)).slice(0, 50),
  };
}

function dateDistanceDays(a, b) {
  const left = Date.parse(String(a || '') + 'T00:00:00Z');
  const right = Date.parse(String(b || '') + 'T00:00:00Z');
  if (!Number.isFinite(left) || !Number.isFinite(right)) return Infinity;
  return Math.abs(left - right) / 86400000;
}

// A release the admin can see and warm must be a release the stream pipeline
// will actually serve. lib/streams.js runs the shared sports-noise and
// foreign-language filter plus the per-event exclusion patterns before it
// applies promotion relevance, and before 0.81.1 this function skipped both.
// That asymmetry let the console show "Warmable" for a title the event's own
// stream request would silently reject, so the warmed release never appeared
// in Nuvio. The reason is returned rather than swallowed so the console can
// explain the rejection instead of showing an unexplained empty match.
function matchRelease(record, events, promotions, report) {
  const matches = [];
  const excluded = [];
  for (const event of (events || [])) {
    if (!event || !event.id || dateDistanceDays(record.date, event.date) > 1) continue;
    const promotion = promotions.getByEventId(event.id);
    if (!promotion || typeof promotion.isRelevantStreamTitle !== 'function') continue;
    const noise = releaseFilter.filterSportsNoise([{ title: record.title }], null, promotion.id, {
      allowForeignLanguage: !!promotion.allowForeignLanguage,
    });
    if (!noise.results.length) {
      if (!excluded.includes('release filter')) excluded.push('release filter');
      continue;
    }
    const blockedByEvent = (event.excludePatterns || []).some((pattern) => {
      try { return new RegExp(pattern, 'i').test(record.title || ''); } catch (_) { return false; }
    });
    if (blockedByEvent) {
      if (!excluded.includes('event exclusion')) excluded.push('event exclusion');
      continue;
    }
    let verdict;
    try { verdict = promotion.isRelevantStreamTitle(record.title, event); }
    catch (_) { continue; }
    if (verdict && verdict.ok) {
      matches.push({ eventId: event.id, eventTitle: event.name || '', promotion: promotion.id });
      if (matches.length >= 8) break;
    }
  }
  if (report) report.exclusions = excluded;
  return matches;
}

// Recompute every stored release against the current event catalog.
//
// Matching used to happen once, at the moment a release was first discovered,
// and releases carried forward from a previous scan were copied verbatim. A
// release published before its fixture metadata landed was therefore stamped
// "No current SSS event" permanently — the common case, because Sport-Video
// posts well ahead of a refresh. Re-matching is pure CPU over local state, so
// it now runs for the whole retained set on every scan.
function rematchReleases(releases, events, promotions) {
  const stamp = new Date().toISOString();
  let matched = 0;
  for (const record of releases) {
    const report = {};
    record.matches = matchRelease(record, events, promotions, report);
    const exclusions = report.exclusions || [];
    if (record.matches.length) {
      matched += 1;
      delete record.matchExclusion;
    } else if (exclusions.length) {
      record.matchExclusion = exclusions.join(', ');
    } else {
      delete record.matchExclusion;
    }
    record.matchedAt = stamp;
  }
  return matched;
}

// Manual "re-match" action for the admin console: re-evaluates stored releases
// against the catalog as it stands right now, without touching the network.
function rematch() {
  const state = load();
  const events = require('../store').getEvents();
  const promotions = require('../promotions');
  const matched = rematchReleases(state.releases || [], events, promotions);
  state.lastRematchAt = new Date().toISOString();
  save(state);
  console.log('[sport-video] re-match complete', {
    module: 'sport-video', releases: (state.releases || []).length, matched,
  });
  return { releases: (state.releases || []).length, matched };
}

async function hydrateRecord(record) {
  if (record.infoHash && record.torrentUrl) return record;
  const detailResponse = await fetchBounded(record.detailUrl, {
    suffix: '.html', maxBytes: 768 * 1024, label: 'Sport-Video detail page',
  });
  const detailed = parseDetail(detailResponse.body.toString('utf8'), record);
  const torrentResponse = await fetchBounded(detailed.torrentUrl, {
    suffix: '.torrent', accept: 'application/x-bittorrent,application/octet-stream',
    maxBytes: 512 * 1024, label: 'Sport-Video torrent', timeoutMs: 15000,
  });
  const type = String(torrentResponse.response.headers.get('content-type') || '').toLowerCase();
  if (type && !/bittorrent|octet-stream/.test(type)) throw new Error('Sport-Video torrent returned an unexpected content type');
  return Object.assign(detailed, torrentMetadata(torrentResponse.body), {
    preparedAt: new Date().toISOString(),
  });
}

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor; cursor += 1;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return output;
}

async function scan(options) {
  if (running) return running;
  const opts = options || {};
  running = (async () => {
    runtime = Object.assign({}, runtime, {
      running: true, current: 'Reading feed', startedAt: new Date().toISOString(),
      lastError: '', scannedPages: 0, discovered: 0, matched: 0, prepared: 0,
    });
    const currentState = load();
    try {
      const cfg = settings.getSportVideo();
      const categories = opts.categories || cfg.categories;
      const rss = await fetchBounded(RSS_URL, {
        suffix: '.xml', accept: 'application/rss+xml,application/xml,text/xml',
        maxBytes: 256 * 1024, label: 'Sport-Video RSS feed',
      });
      const rssTitles = parseRss(rss.body.toString('utf8'));
      runtime.current = 'Reading sport catalogues';
      // Catalogue pages run 130–340 KB today. The old 1 MB ceiling is a hard
      // throw, not a truncation, so one page growing past it would fail the
      // whole scan; 3 MB keeps the bound meaningful with real headroom.
      const pages = await mapLimit(categories, 3, async (category) => {
        const pathName = CATEGORY_PATHS[category];
        if (!pathName) return [];
        const response = await fetchBounded(ORIGIN + pathName, {
          suffix: '.html', maxBytes: 3 * 1024 * 1024, label: 'Sport-Video ' + category + ' catalogue',
        });
        runtime.scannedPages += 1;
        return parseCatalog(response.body.toString('utf8'), category);
      });
      const discovered = new Map();
      // Category records are merged first so their sport label wins over the
      // archive placeholder for any release listed in both places.
      for (const record of pages.flat()) if (!discovered.has(record.id)) discovered.set(record.id, record);
      runtime.categoryDiscovered = discovered.size;

      let archives = [];
      if (cfg.archivePages > 0) {
        runtime.current = 'Reading dated archive';
        try {
          const index = await fetchBounded(INDEX_URL, {
            suffix: '.html', maxBytes: 3 * 1024 * 1024, label: 'Sport-Video index',
          });
          runtime.scannedPages += 1;
          archives = parseArchiveLinks(index.body.toString('utf8')).slice(0, cfg.archivePages);
        } catch (error) {
          // A missing archive index must not lose the category results that
          // already succeeded — the scan degrades to the pre-0.81.1 behaviour.
          console.warn('[sport-video] archive index unavailable: ' + error.message);
        }
      }
      if (archives.length) {
        const archivePages = await mapLimit(archives, 3, async (entry) => {
          try {
            const response = await fetchBounded(ORIGIN + '/' + entry.file, {
              suffix: '.html', maxBytes: 3 * 1024 * 1024, label: 'Sport-Video archive page',
            });
            runtime.scannedPages += 1;
            return parseCatalog(response.body.toString('utf8'), UNCATEGORISED);
          } catch (error) {
            console.warn('[sport-video] archive page ' + entry.file + ' failed: ' + error.message);
            return [];
          }
        });
        for (const record of archivePages.flat()) {
          if (!discovered.has(record.id)) discovered.set(record.id, record);
        }
      }
      runtime.archivePages = archives.length;
      runtime.discovered = discovered.size;

      const existing = new Map(currentState.releases.map((record) => [record.id, record]));
      const events = require('../store').getEvents();
      const promotions = require('../promotions');
      const nowIso = new Date().toISOString();
      const merged = [];
      for (const record of discovered.values()) {
        const previous = existing.get(record.id) || {};
        const next = Object.assign({}, previous, record, {
          firstSeenAt: previous.firstSeenAt || nowIso,
          lastSeenAt: nowIso,
          inRss: rssTitles.includes(record.title),
        });
        // A release seen this scan only on an archive page keeps whatever sport
        // label a category page gave it previously.
        if (record.category === UNCATEGORISED && previous.category && previous.category !== UNCATEGORISED) {
          next.category = previous.category;
        }
        merged.push(next);
      }
      for (const previous of currentState.releases) {
        if (!discovered.has(previous.id)) merged.push(previous);
      }
      merged.sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))
        || String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));
      const retained = merged.slice(0, MAX_RELEASES);
      // Re-match the whole retained set, not only what this scan rediscovered.
      // Events arrive after their releases far more often than the reverse.
      runtime.current = 'Matching against current events';
      runtime.matched = rematchReleases(retained, events, promotions);

      runtime.current = 'Preparing matched releases';
      const prepare = retained.filter((record) => record.matches && record.matches.length && !record.infoHash)
        .slice(0, opts.maxDetails || cfg.maxDetailsPerScan);
      await mapLimit(prepare, 3, async (record) => {
        try {
          const hydrated = await hydrateRecord(record);
          Object.assign(record, hydrated, { prepareError: '' });
          runtime.prepared += 1;
        } catch (error) {
          record.prepareError = String(error.message || error).slice(0, 300);
          record.prepareAttemptedAt = new Date().toISOString();
          console.warn('[sport-video] prepare failed for ' + record.title + ': ' + record.prepareError);
        }
      });
      const state = {
        version: 1, releases: retained, lastScanAt: nowIso, lastSuccessAt: new Date().toISOString(), lastError: '',
        rssCount: rssTitles.length, scannedCategories: categories,
        lastRematchAt: nowIso, archivePagesRead: archives.length,
      };
      save(state);
      runtime.completedAt = state.lastSuccessAt;
      console.log('[sport-video] scan complete', {
        module: 'sport-video', discovered: runtime.discovered,
        fromCategories: runtime.categoryDiscovered, archivePages: archives.length,
        matched: runtime.matched, prepared: runtime.prepared, pages: runtime.scannedPages,
      });
      return state;
    } catch (error) {
      currentState.lastScanAt = new Date().toISOString();
      currentState.lastError = String(error.message || error).slice(0, 500);
      save(currentState);
      runtime.lastError = currentState.lastError;
      console.error('[sport-video] scan failed: ' + currentState.lastError);
      throw error;
    } finally {
      runtime.running = false; runtime.current = '';
    }
  })();
  try { return await running; }
  finally { running = null; }
}

async function prepare(id) {
  const state = load();
  const record = state.releases.find((item) => item.id === id);
  if (!record) throw new Error('Sport-Video release not found');
  const hydrated = await hydrateRecord(record);
  Object.assign(record, hydrated, { prepareError: '' });
  save(state);
  return record;
}

async function candidatesForEvent(eventId, options) {
  const cfg = settings.getSportVideo();
  if (!cfg.enabled) return [];
  const state = load();
  const records = state.releases.filter((record) =>
    Array.isArray(record.matches) && record.matches.some((match) => match.eventId === eventId));
  // Already-prepared releases come first. The previous order was whatever the
  // store happened to hold, and the slice ran BEFORE the info-hash filter, so
  // an event with several matches could drop its one prepared (and possibly
  // already warmed) release in favour of five unprepared ones — and then
  // return nothing at all once the hash filter removed those.
  records.sort((a, b) => {
    const prepared = (/^[a-f0-9]{40}$/i.test(b.infoHash || '') ? 1 : 0)
      - (/^[a-f0-9]{40}$/i.test(a.infoHash || '') ? 1 : 0);
    if (prepared !== 0) return prepared;
    return (Number(b.size) || 0) - (Number(a.size) || 0);
  });
  const limit = Math.max(1, Math.min(10, Number(options && options.limit) || 5));
  const chosen = records.slice(0, limit);
  if (options && options.hydrate !== false) {
    for (let index = 0; index < chosen.length; index += 1) {
      if (chosen[index].infoHash) continue;
      try {
        chosen[index] = await prepare(chosen[index].id);
      } catch (error) {
        console.warn('[sport-video] on-demand prepare failed: ' + error.message);
      }
    }
  }
  return chosen.filter((record) => /^[a-f0-9]{40}$/i.test(record.infoHash || '')).map((record) => ({
    infoHash: record.infoHash.toLowerCase(), title: record.title,
    size: Number(record.size) || 0, publishDate: record.date || null,
    indexer: 'Sport-Video', seeders: 0, trackers: record.trackers || [],
    // Sport-Video titles never carry a scene resolution token — the detail page
    // holds it as "1280x720". Passing it through lets stream ranking and row
    // labelling treat these rows the same as any indexer result instead of
    // sinking them below every 1080p row and out of the row cap.
    resolution: record.resolution || '', video: record.video || '',
    source: 'sport-video', sourceId: record.id,
  }));
}

function findCandidate(eventId, infoHash) {
  const hash = String(infoHash || '').toLowerCase();
  const record = load().releases.find((item) => String(item.infoHash || '').toLowerCase() === hash
    && Array.isArray(item.matches) && item.matches.some((match) => match.eventId === eventId));
  if (!record) return null;
  return {
    infoHash: hash, title: record.title, size: record.size,
    resolution: record.resolution || '', video: record.video || '',
    trackers: record.trackers || [], source: 'sport-video', sourceId: record.id,
  };
}

function status() {
  const state = load();
  const releases = state.releases || [];
  return {
    running: runtime.running,
    current: runtime.current,
    startedAt: runtime.startedAt,
    completedAt: runtime.completedAt || state.lastSuccessAt,
    lastError: runtime.lastError || state.lastError || '',
    lastScanAt: state.lastScanAt,
    lastRematchAt: state.lastRematchAt || null,
    rssCount: state.rssCount || 0,
    releases: releases.length,
    matched: releases.filter((record) => record.matches && record.matches.length).length,
    prepared: releases.filter((record) => record.infoHash).length,
    unmatched: releases.filter((record) => !record.matches || !record.matches.length).length,
    filtered: releases.filter((record) => record.matchExclusion).length,
    fromArchive: releases.filter((record) => record.category === UNCATEGORISED).length,
    archivePagesRead: state.archivePagesRead || 0,
    scannedPages: runtime.scannedPages,
    scanDiscovered: runtime.discovered,
    scanMatched: runtime.matched,
    scanPrepared: runtime.prepared,
  };
}

function startScheduler() {
  stopScheduler();
  const cfg = settings.getSportVideo();
  if (!cfg.enabled || !cfg.autoScan) {
    console.log('[sport-video] automatic discovery disabled');
    return;
  }
  const run = () => scan().catch(() => {});
  startupTimer = setTimeout(run, cfg.startDelaySeconds * 1000);
  if (startupTimer.unref) startupTimer.unref();
  schedulerTimer = setInterval(run, cfg.intervalHours * 60 * 60 * 1000);
  if (schedulerTimer.unref) schedulerTimer.unref();
  console.log('[sport-video] discovery scheduled every ' + cfg.intervalHours + 'h');
}

function stopScheduler() {
  if (startupTimer) clearTimeout(startupTimer);
  if (schedulerTimer) clearInterval(schedulerTimer);
  startupTimer = null; schedulerTimer = null;
}

module.exports = {
  ORIGIN, RSS_URL, INDEX_URL, CATEGORY_PATHS, UNCATEGORISED,
  parseRss, parseCatalog, parseArchiveLinks, parseDetail, torrentMetadata,
  matchRelease, rematchReleases, rematch,
  scan, prepare, candidatesForEvent, findCandidate, load, status,
  startScheduler, stopScheduler,
  _fetchBounded: fetchBounded,
};
