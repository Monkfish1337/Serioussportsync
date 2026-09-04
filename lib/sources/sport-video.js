'use strict';

// Curated Sport-Video discovery source.
//
// The public RSS feed is useful as a change signal but every item links to the
// homepage and carries no GUID, publication date, enclosure, or torrent URL.
// Consequently discovery reads the bounded category indexes, matches their
// visible event titles to the existing SSS catalog, and only then hydrates a
// small number of detail/torrent records. Nothing is submitted to TorBox here.
//
// 0.81.2: discovery is driven by the site's own search index. The search box
// is client-side and loads one static file listing every page on the site, so
// a single request yields the whole catalogue — about 1,860 dated releases,
// against roughly 300 reachable from the seven per-sport pages and ~700 from
// a bounded archive crawl. Matching then runs event-first: each release is
// only ever compared against fixtures within a day of it. The listing crawl
// is retained as a fallback for the day the site changes its search.

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
// The site's own search box is client-side: it loads one static index listing
// every page on the site. Reading that file is a single request that covers
// the whole catalogue, so discovery no longer depends on how many listing
// pages a scan can afford to walk.
const SEARCH_INDEX_URL = ORIGIN + '/searchindex.js';
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
// The full index is ~1,860 dated releases today. Retention has to sit clear of
// that or a scan would start evicting what it just discovered.
const MAX_RELEASES = 6000;
const USER_AGENT = 'SeriousSportSync/' + (require('../../package.json').version || 'unknown')
  + ' (+https://github.com/Monkfish1337/Serioussportsync)';

let running = null;
let schedulerTimer = null;
let startupTimer = null;
let runtime = {
  running: false, current: '', startedAt: null, completedAt: null,
  lastError: '', scannedPages: 0, discovered: 0, matched: 0, prepared: 0,
};

// Stored-state schema version. Fields have been added to release records in
// almost every release since 0.81.0 — indexTitle, matchExclusion, matchedAt,
// fromIndex, autoWarmedAt, eventDate — and each was previously absorbed by an
// ad-hoc fallback at the point of use. Those fallbacks accumulate and can
// disagree. Migrations run once on load and normalise the shape instead.
const STATE_VERSION = 2;

function emptyState() {
  return {
    version: STATE_VERSION, releases: [],
    lastScanAt: null, lastSuccessAt: null, lastError: '',
  };
}

// Numbered, forward-only, each step taking the state from version N to N+1.
// A step must be safe to apply to a partially-populated store: these files are
// written by whatever version happened to be running last.
const MIGRATIONS = [
  {
    to: 2,
    describe: 'carry the fixture date on each match and normalise release shape',
    apply(state) {
      for (const record of (state.releases || [])) {
        if (!Array.isArray(record.matches)) record.matches = [];
        for (const match of record.matches) {
          // Pre-0.81.4 matches have no eventDate. Matching guarantees the
          // release date is within a day of the fixture, so it is the correct
          // stand-in and lets matchAgeDays() stop special-casing its absence.
          if (match && !match.eventDate) match.eventDate = record.date || '';
        }
        if (record.indexTitle === undefined) record.indexTitle = '';
        if (record.fromIndex === undefined) record.fromIndex = false;
      }
      return state;
    },
  },
];

function migrateState(state) {
  const from = Number(state && state.version) || 1;
  if (from >= STATE_VERSION) return state;
  let next = state;
  for (const migration of MIGRATIONS) {
    if (migration.to <= from) continue;
    try {
      next = migration.apply(next) || next;
      next.version = migration.to;
    } catch (error) {
      console.error('[sport-video] migration to v' + migration.to + ' failed: ' + error.message);
      return next;
    }
  }
  console.log('[sport-video] migrated stored state v' + from + ' -> v' + next.version
    + ' (' + (next.releases || []).length + ' releases)');
  return next;
}

// The store is read on the request path — candidatesForEvent() when an event is
// opened and findCandidate() again when a row is played. Once discovery moved to
// the full search index the file reached ~1.5 MB / 1,860 releases, making an
// uncached read a ~11ms synchronous parse that blocks the event loop on every
// stream request. Cache on mtime, exactly as lib/store.js already does, so a
// repeat read costs a stat() and an external edit is still picked up.
let cached = null;
let cachedMtimeMs = 0;
let cachedSize = -1;

function load() {
  try {
    if (!fs.existsSync(STORE_FILE)) {
      cached = null; cachedMtimeMs = 0; cachedSize = -1;
      return emptyState();
    }
    const stat = fs.statSync(STORE_FILE);
    // Size is compared alongside mtime because some filesystems report a
    // coarse mtime, and two writes inside the same tick are plausible here.
    if (cached && stat.mtimeMs === cachedMtimeMs && stat.size === cachedSize) return cached;
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (!parsed || !Array.isArray(parsed.releases)) return emptyState();
    cached = migrateState(Object.assign(emptyState(), parsed));
    cachedMtimeMs = stat.mtimeMs;
    cachedSize = stat.size;
    return cached;
  } catch (error) {
    console.error('[sport-video] state read failed: ' + error.message);
    cached = null; cachedMtimeMs = 0; cachedSize = -1;
    return emptyState();
  }
}

// Callers mutate the objects they get back from load() (scan builds its next
// state from them), so anything that writes must drop the cache rather than
// hand the same instance to the next reader.
function invalidate() {
  cached = null; cachedMtimeMs = 0; cachedSize = -1;
}

function save(state) {
  const dir = path.dirname(STORE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = STORE_FILE + '.tmp';
  const payload = Object.assign({}, state, { version: STATE_VERSION });
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_FILE);
  invalidate();
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

// Index titles append the competition and a marketing tail:
//   "AEK Athens vs Levski Sofia 26.08.2026 UEFA Champions League Football
//    torrent download free"
// The event identity ends at the date, so the display title is everything up
// to and including it. The untruncated string is kept for matching, because
// the competition name it carries ("UEFA Champions League") is exactly the
// keyword evidence a non-matchup promotion looks for and the listing cards
// never provide.
const INDEX_DATE_RE = /\b\d{2}[.\-/]\d{2}[.\-/](?:19|20)\d{2}\b/;

function cleanIndexTitle(title) {
  const text = String(title || '');
  const match = text.match(INDEX_DATE_RE);
  if (!match) return text.slice(0, 500);
  return text.slice(0, match.index + match[0].length).trim().slice(0, 500);
}

// Sport labels are recoverable from the index title's own wording, so records
// discovered this way are filterable in the console like crawled ones.
const INDEX_CATEGORY_RULES = Object.freeze([
  ['americanfootball', /\bamerican football\b|\bNFL\b|\bNCAA Football\b/i],
  ['baseball', /\bbaseball\b|\bMLB\b/i],
  ['basketball', /\bbasketball\b|\bNBA\b|\bEuroleague\b/i],
  ['hockey', /\bhockey\b|\bNHL\b/i],
  ['rugby', /\brugby\b|\bAFL\b|\bGAA\b|\bNRL\b/i],
  ['football', /\bfootball\b|\bsoccer\b|\bpremier league\b|\bchampions league\b/i],
]);

function categoryFromIndexTitle(title) {
  for (const [category, pattern] of INDEX_CATEGORY_RULES) {
    if (pattern.test(String(title || ''))) return category;
  }
  return 'other';
}

// The index is a generated script of SearchPage(url, title, keywords,
// description) constructor calls. Only the url and title are read; keywords
// and descriptions are site-wide marketing boilerplate.
function parseSearchIndex(text) {
  const entries = [];
  const seen = new Set();
  const re = /new\s+SearchPage\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"/g;
  const unescape = (value) => String(value || '').replace(/\\(["'\\])/g, '$1');
  let match;
  while ((match = re.exec(String(text || '')))) {
    const file = unescape(match[1]).trim();
    const indexTitle = stripTags(unescape(match[2]));
    if (!file || !/^[^/?#]+\.html$/i.test(file)) continue;
    if (/^(?:index|start|schedule|oldergames|DMCA|TOP10)\.html$/i.test(file)) continue;
    if (/^[a-z]+\d{4}(?:-\d{1,3})?\.html$/i.test(file)) continue;
    const title = cleanIndexTitle(indexTitle);
    const date = extractDate(title);
    if (!date || seen.has(file.toLowerCase())) continue;
    seen.add(file.toLowerCase());
    let detailUrl;
    try { detailUrl = sourceUrl('/' + file, '.html'); }
    catch (_) { continue; }
    entries.push({
      id: crypto.createHash('sha256').update(detailUrl).digest('hex').slice(0, 24),
      title,
      indexTitle: indexTitle.slice(0, 700),
      date,
      category: categoryFromIndexTitle(indexTitle),
      detailUrl,
    });
  }
  return entries;
}

// Conditional GET so a scan that finds nothing new costs one 304 rather than
// a megabyte. The file is Windows-1251; every event title is ASCII, and
// latin1 preserves those bytes exactly without pulling in a codec.
async function fetchSearchIndex(previous) {
  const headers = {
    Accept: 'application/javascript,text/javascript,*/*',
    'User-Agent': USER_AGENT,
  };
  if (previous && previous.etag) headers['If-None-Match'] = previous.etag;
  const response = await fetch(sourceUrl(SEARCH_INDEX_URL), httpAgent.fetchOpts({
    headers, timeout: 20000, redirect: 'manual',
  }, SEARCH_INDEX_URL));
  if (response.status === 304) return { notModified: true, etag: previous && previous.etag };
  if (!response.ok) throw new Error('Sport-Video search index returned HTTP ' + response.status);
  const body = await boundedBody.readBuffer(response, 8 * 1024 * 1024, 'Sport-Video search index');
  return {
    entries: parseSearchIndex(body.toString('latin1')),
    etag: response.headers.get('etag') || '',
  };
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
  // The clean title is the event identity; the full index title additionally
  // carries the competition name ("… 03.09.2026 Spain La Liga Football torrent
  // download free"), which is what lets a bare "AEK Athens vs Levski Sofia
  // 26.08.2026" satisfy a keyword-gated promotion.
  //
  // 0.86.2 — but that tail is the site's category blurb, not a description of
  // this release: every American-football entry carries "NFL CFL UFL NCAAFB",
  // every baseball entry "MLB … Major League Baseball". Accepting either form
  // outright let the blurb satisfy relevance on its own, so a college or CFL
  // game matched an NFL fixture purely because both sit in the same section of
  // the site — 234 of 252 NFL matches in a real export were exactly this.
  //
  // The index title is therefore a supplement, never a substitute: it is
  // retried only when the release's own name already identified the fixture and
  // the single objection was a missing competition keyword. Any other
  // rejection — wrong teams, wrong date, an exclusion — stands.
  const cardTitle = String(record.title || '').trim();
  const indexTitle = String(record.indexTitle || '').trim();
  const competitionForm = indexTitle && indexTitle !== cardTitle ? indexTitle : '';
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
    const verdictFor = (form) => {
      try { return promotion.isRelevantStreamTitle(form, event) || { ok: false, reason: 'no-verdict' }; }
      catch (_) { return { ok: false, reason: 'threw' }; }
    };
    const cardVerdict = verdictFor(cardTitle);
    let relevant = !!cardVerdict.ok;
    if (!relevant && competitionForm && cardVerdict.reason === 'no-keyword-match') {
      relevant = !!verdictFor(competitionForm).ok;
    }
    if (relevant) {
      matches.push({
        eventId: event.id, eventTitle: event.name || '',
        eventDate: event.date || '', promotion: promotion.id,
        // Carried so the team filter can be applied without a catalog lookup,
        // the same reason eventDate is carried for the age window.
        eventTeams: participantsOf(event),
      });
      if (matches.length >= 8) break;
    }
  }
  if (report) report.exclusions = excluded;
  return matches;
}

// Age of the fixture a record is matched to, in days. Pre-0.81.4 records have
// no eventDate, so the release date stands in — matching guarantees the two are
// within a day of each other. Future fixtures return a negative age and are
// always inside the window.
// Two sides of a fixture, from the structured provider names when there are
// any and otherwise from the fixture title. Kept here rather than imported so
// discovery does not depend on the diagnostics module.
const MATCHUP_SPLIT = /\s+(?:vs\.?|v|versus|at|@)\s+/i;

function participantsOf(event) {
  const names = event && event.teamNames;
  const structured = []
    .concat(Array.isArray(names && names.home) ? names.home.slice(0, 1) : [])
    .concat(Array.isArray(names && names.away) ? names.away.slice(0, 1) : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (structured.length === 2) return structured;
  const parts = String(event && event.name || '').split(MATCHUP_SPLIT);
  if (parts.length !== 2) return [];
  return parts.map((value) => String(value || '').trim()).filter(Boolean);
}

// Does any match on this record belong to a side the operator asked for?
//
// Fails open in three cases, each deliberate: a promotion with no selection is
// unfiltered (which is how boxing and other one-off line-ups keep working); a
// record whose matches predate this feature carries no eventTeams and is not
// silently dropped; and a fixture whose name does not split into two sides is
// never filtered out by a rule that could not have applied to it.
function matchesSelectedTeams(record, filters) {
  const wanted = filters || {};
  if (!Object.keys(wanted).length) return true;
  for (const match of (Array.isArray(record.matches) ? record.matches : [])) {
    const selected = wanted[match && match.promotion];
    if (!selected || !selected.length) return true;
    const teams = Array.isArray(match.eventTeams) ? match.eventTeams : null;
    if (!teams || !teams.length) return true;
    if (teams.some((team) => selected.includes(team))) return true;
  }
  return false;
}

function matchAgeDays(record, now) {
  const today = Number.isFinite(now) ? now : Date.now();
  const match = Array.isArray(record.matches) ? record.matches[0] : null;
  const date = (match && match.eventDate) || record.date || '';
  const stamp = Date.parse(String(date) + 'T00:00:00Z');
  if (!Number.isFinite(stamp)) return Infinity;
  return Math.floor((today - stamp) / 86400000);
}

// Events indexed by day, so a release only ever compares against the handful
// of fixtures within its ±1 day window instead of the entire catalog. With a
// full site index this is the difference between thousands of comparisons and
// millions.
function eventsByDay(events) {
  const buckets = new Map();
  for (const event of (events || [])) {
    const key = String(event && event.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(event);
  }
  return buckets;
}

function eventsNear(buckets, date) {
  const day = Date.parse(String(date || '') + 'T00:00:00Z');
  if (!Number.isFinite(day)) return [];
  const out = [];
  for (let offset = -1; offset <= 1; offset += 1) {
    const key = new Date(day + offset * 86400000).toISOString().slice(0, 10);
    const bucket = buckets.get(key);
    if (bucket) out.push(...bucket);
  }
  return out;
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
  const buckets = eventsByDay(events);
  let matched = 0;
  for (const record of releases) {
    const report = {};
    record.matches = matchRelease(record, eventsNear(buckets, record.date), promotions, report);
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

      // Primary path: the site's own search index. One request covers every
      // page on the site, so coverage stops being a function of how many
      // listing pages the scan budget allows.
      const discovered = new Map();
      let indexEntries = null;
      let indexEtag = currentState.searchIndexEtag || '';
      let indexSource = 'crawl';
      runtime.current = 'Reading search index';
      try {
        const result = await fetchSearchIndex({ etag: indexEtag });
        if (result.notModified) {
          // Unchanged upstream: reuse what the store already holds rather than
          // re-downloading, but still fall through to a full re-match below.
          indexEntries = (currentState.releases || []).filter((record) => record.fromIndex);
          indexSource = 'search-index (unchanged)';
        } else {
          indexEntries = result.entries;
          indexEtag = result.etag || '';
          indexSource = 'search-index';
        }
        runtime.scannedPages += 1;
      } catch (error) {
        console.warn('[sport-video] search index unavailable: ' + error.message);
        runtime.indexError = String(error.message || error).slice(0, 300);
      }
      // A parse that yields implausibly little means the generated format
      // changed. Treat that as a failure and let the crawl cover the scan
      // instead of silently shrinking the catalogue.
      const MIN_PLAUSIBLE_INDEX = 50;
      if (indexEntries && indexEntries.length < MIN_PLAUSIBLE_INDEX) {
        console.warn('[sport-video] search index returned only ' + indexEntries.length
          + ' usable entries; falling back to catalogue pages');
        runtime.indexError = 'search index returned ' + indexEntries.length + ' entries';
        indexEntries = null;
      }
      if (indexEntries) {
        for (const entry of indexEntries) {
          discovered.set(entry.id, Object.assign({}, entry, { fromIndex: true }));
        }
      }
      runtime.indexEntries = indexEntries ? indexEntries.length : 0;
      runtime.indexSource = indexSource;

      // Fallback path only. The listing crawl stays in place so a change to
      // the site's search implementation degrades coverage instead of ending
      // discovery outright.
      const useCrawl = !indexEntries || opts.forceCrawl === true;
      runtime.current = useCrawl ? 'Reading sport catalogues' : 'Matching against current events';
      // Catalogue pages run 130–340 KB today. The old 1 MB ceiling is a hard
      // throw, not a truncation, so one page growing past it would fail the
      // whole scan; 3 MB keeps the bound meaningful with real headroom.
      const pages = useCrawl ? await mapLimit(categories, 3, async (category) => {
        const pathName = CATEGORY_PATHS[category];
        if (!pathName) return [];
        const response = await fetchBounded(ORIGIN + pathName, {
          suffix: '.html', maxBytes: 3 * 1024 * 1024, label: 'Sport-Video ' + category + ' catalogue',
        });
        runtime.scannedPages += 1;
        return parseCatalog(response.body.toString('utf8'), category);
      }) : [];
      // Category records carry a confirmed sport label, so they win over the
      // archive placeholder for any release listed in both places.
      for (const record of pages.flat()) if (!discovered.has(record.id)) discovered.set(record.id, record);
      runtime.categoryDiscovered = discovered.size;

      let archives = [];
      if (useCrawl && cfg.archivePages > 0) {
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
        // A release seen this scan only on an archive page, or labelled by the
        // search index's own wording, keeps a sport a category page confirmed
        // earlier — a confirmed label never degrades to a guessed one.
        const weak = record.category === UNCATEGORISED || record.fromIndex === true;
        if (weak && previous.category && previous.category !== UNCATEGORISED && !previous.fromIndex) {
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
      // Automatic hydration is bounded by the same age window as warming. An
      // old fixture is either still cached at TorBox and needs nothing, or has
      // aged out and nobody is asking for it — fetching its torrent either way
      // spends the per-scan budget that a current fixture should get. The
      // manual Prepare button ignores this.
      const windowDays = cfg.autoWarmWindowDays;
      const teamFilters = cfg.teamFilters || {};
      const prepare = retained.filter((record) => record.matches && record.matches.length
        && !record.infoHash && matchAgeDays(record) <= windowDays
        && matchesSelectedTeams(record, teamFilters))
        .slice(0, opts.maxDetails || cfg.maxDetailsPerScan);
      runtime.outsideWindow = retained.filter((record) => record.matches && record.matches.length
        && matchAgeDays(record) > windowDays).length;
      runtime.outsideTeamFilter = retained.filter((record) => record.matches && record.matches.length
        && !matchesSelectedTeams(record, teamFilters)).length;
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
      runtime.current = 'Warming selected promotions';
      try {
        runtime.autoWarm = await autoWarmMatched(retained, {});
      } catch (error) {
        console.warn('[sport-video] auto-warm step failed: ' + error.message);
      }
      const state = {
        version: 1, releases: retained, lastScanAt: nowIso, lastSuccessAt: new Date().toISOString(), lastError: '',
        rssCount: rssTitles.length, scannedCategories: categories,
        lastRematchAt: nowIso, archivePagesRead: archives.length,
        searchIndexEtag: indexEtag, searchIndexEntries: runtime.indexEntries,
        discoverySource: indexSource,
      };
      save(state);
      runtime.completedAt = state.lastSuccessAt;
      console.log('[sport-video] scan complete', {
        module: 'sport-video', source: indexSource, discovered: runtime.discovered,
        indexEntries: runtime.indexEntries, fromCategories: runtime.categoryDiscovered,
        archivePages: archives.length, matched: runtime.matched,
        prepared: runtime.prepared, pages: runtime.scannedPages,
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

// Opt-in automatic warming, per promotion.
//
// Deliberately narrow: only releases matched to a promotion the operator named,
// only when a torrent identity is already prepared, only for accounts that
// selected that promotion's catalog, and capped per scan. Everything else stays
// a manual click, preserving the rule that SSS never bulk-submits a catalogue.
async function autoWarmMatched(releases, options) {
  const cfg = settings.getSportVideo();
  const wanted = new Set(cfg.autoWarmPromotions || []);
  if (!wanted.size) return { attempted: 0, warmed: 0, ready: 0 };
  const streams = require('../streams');
  const users = require('../users');
  const promotions = require('../promotions');
  const { effectiveCatalogSelection } = require('../catalog-selection');
  const log = (options && options.log) || ((message) => console.log('[sport-video] ' + message));

  const profiles = users.listUsers().map((user) => users.findById(user.id)).filter(Boolean)
    .filter((user) => String((user.config || {}).torboxApiKey || '').trim());
  if (!profiles.length) return { attempted: 0, warmed: 0, ready: 0 };

  const eligible = releases.filter((record) => record.infoHash
    && !record.autoWarmedAt
    && matchAgeDays(record) <= cfg.autoWarmWindowDays
    && matchesSelectedTeams(record, cfg.teamFilters || {})
    && Array.isArray(record.matches)
    && record.matches.some((match) => wanted.has(match.promotion)))
    .slice(0, cfg.autoWarmPerScan);
  let warmed = 0; let ready = 0; let attempted = 0;
  for (const record of eligible) {
    const match = record.matches.find((entry) => wanted.has(entry.promotion));
    if (!match) continue;
    const promotion = promotions.getByEventId(match.eventId);
    for (const profile of profiles) {
      // Respect the account's own catalog selection — never warm a promotion
      // the user has switched off.
      const selected = effectiveCatalogSelection(profile.config || {});
      if (selected && promotion && Array.isArray(promotion.catalogs)
        && !promotion.catalogs.some((catalog) => selected.has(catalog.id))) continue;
      attempted += 1;
      try {
        const result = await streams.warmTorbox({
          eventId: match.eventId, infoHash: record.infoHash,
          creds: profile.config || {}, username: profile.username,
        });
        if (result && (result.ready || result.url)) ready += 1;
        else if (result && result.queued) warmed += 1;
        else if (result && result.error) log('auto-warm refused for ' + record.title + ': ' + result.error);
      } catch (error) {
        log('auto-warm failed for ' + record.title + ': ' + error.message);
      }
    }
    record.autoWarmedAt = new Date().toISOString();
  }
  if (attempted) {
    log('auto-warm: ' + warmed + ' queued, ' + ready + ' already ready, '
      + attempted + ' submission(s) across ' + profiles.length + ' account(s)');
  }
  return { attempted, warmed, ready };
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
    discoverySource: state.discoverySource || '',
    searchIndexEntries: state.searchIndexEntries || 0,
    autoWarm: runtime.autoWarm || null,
    outsideWindow: runtime.outsideWindow || 0,
    outsideTeamFilter: runtime.outsideTeamFilter || 0,
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
  parseSearchIndex, cleanIndexTitle, categoryFromIndexTitle, fetchSearchIndex,
  migrateState, invalidate, STATE_VERSION,
  matchRelease, rematchReleases, rematch, autoWarmMatched, matchAgeDays,
  matchesSelectedTeams, participantsOf,
  SEARCH_INDEX_URL,
  scan, prepare, candidatesForEvent, findCandidate, load, status,
  startScheduler, stopScheduler,
  _fetchBounded: fetchBounded,
};
