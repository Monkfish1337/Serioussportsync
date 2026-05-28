// Official ONE Championship source — pulls from watch.onefc.com.
//
// Strategy: scrape the buildId from /upcoming-events HTML, then hit the
// Next.js SSR data endpoints at /_next/data/<buildId>/upcoming-events.json
// and /past-events.json. These return JSON identical to what the React
// hydration uses, so we get authoritative scheduling, real Cloudinary
// posters, and precise start timestamps without any HTML scraping.
//
// Each endpoint returns only the first page (10 events). That's enough to
// cover ±60 days at ONE's weekly cadence, well inside the addon's default
// asymmetric window (-30 / +90).

const fetch = require('node-fetch');

const BASE = 'https://watch.onefc.com';
// Pretend to be a browser — watch.onefc.com is a public site behind
// Cloudfront and serves a 403 to obviously-bot UAs.
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function httpGet(url, log, opts) {
  const max = (opts && opts.maxRetries) || 3;
  for (let attempt = 0; attempt <= max; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json,text/html' } });
    } catch (err) {
      if (attempt < max) {
        log('    network error fetching ' + url + ', retry: ' + err.message);
        await delay(2000 * (attempt + 1));
        continue;
      }
      throw err;
    }
    if (res.status === 429 || res.status === 503) {
      const wait = 5000 * (attempt + 1);
      log('    onefc HTTP ' + res.status + ', backing off ' + wait + 'ms');
      await delay(wait);
      continue;
    }
    if (!res.ok) throw new Error('onefc HTTP ' + res.status + ' for ' + url);
    return res;
  }
  throw new Error('onefc: exhausted retries for ' + url);
}

// Parse the Next.js buildId out of the upcoming-events HTML. The buildId
// changes every time ONE deploys their site, so we discover it on every
// refresh rather than hard-coding.
async function discoverBuildId(log) {
  const res = await httpGet(BASE + '/upcoming-events', log);
  const html = await res.text();
  const m = html.match(/"buildId":"([^"]+)"/);
  if (!m) throw new Error('onefc: buildId not found in /upcoming-events HTML');
  return m[1];
}

async function fetchTypedEvents(buildId, type, log) {
  // type: 'upcoming-events' or 'past-events'
  const url = BASE + '/_next/data/' + buildId + '/' + type + '.json';
  const res = await httpGet(url, log);
  const json = await res.json();
  const props = (json && json.pageProps) || {};
  const key = type === 'upcoming-events' ? 'upcomingEvents' : 'pastEvents';
  return Array.isArray(props[key]) ? props[key] : [];
}

// Extract YYYY-MM-DD and HH:MM:SS from an ISO timestamp.
function splitIso(iso) {
  if (!iso || typeof iso !== 'string') return { date: null, time: null };
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
  return m ? { date: m[1], time: m[2] } : { date: null, time: null };
}

// Take a watch.onefc.com event and produce our generic source record.
// Fields match what lib/transform.js#fromWiki expects, so we can reuse the
// transform with no changes.
function normalize(raw) {
  if (!raw || !raw.title || !raw.slug) return null;
  const start = raw.schedule && raw.schedule.start_time;
  const { date, time } = splitIso(start);
  if (!date) return null;

  const creatives = raw.creatives || {};
  const banner = (creatives.banner_listing && creatives.banner_listing.url) ||
                 (creatives.banner_upcoming && creatives.banner_upcoming.url) || null;
  const wide = (creatives.banner_upcoming && creatives.banner_upcoming.url) ||
               (creatives.banner_listing && creatives.banner_listing.url) || null;

  return {
    sourceId: raw.slug,
    name: raw.title,
    date,
    time,
    timestamp: start,
    venue: null, // not exposed by the listing endpoint
    city: raw.city || null,
    country: null,
    poster: banner,
    thumb: banner,
    fanart: wide,
    banner: wide,
    description: null, // SSR endpoint doesn't carry it
    source: { type: 'onefc', uid: raw.uid || null, slug: raw.slug },
  };
}

async function fetchAll(opts) {
  opts = opts || {};
  const log = opts.log || (() => {});

  log('-> onefc: discovering buildId from ' + BASE + '/upcoming-events');
  const buildId = await discoverBuildId(log);
  log('  buildId: ' + buildId);

  let upcoming = [], past = [];
  try {
    upcoming = await fetchTypedEvents(buildId, 'upcoming-events', log);
    log('  upcoming-events: ' + upcoming.length);
  } catch (err) {
    log('  upcoming-events FAILED: ' + err.message);
  }
  try {
    past = await fetchTypedEvents(buildId, 'past-events', log);
    log('  past-events: ' + past.length);
  } catch (err) {
    log('  past-events FAILED: ' + err.message);
  }

  const seen = new Set();
  const out = [];
  for (const raw of [...upcoming, ...past]) {
    const norm = normalize(raw);
    if (!norm || seen.has(norm.sourceId)) continue;
    seen.add(norm.sourceId);
    out.push(norm);
  }
  return out;
}

module.exports = { fetchAll, discoverBuildId, normalize };
