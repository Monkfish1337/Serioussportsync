'use strict';

// Mine a self-hosted Bitmagnet for release-naming conventions SSS does not match.
//
// Why this exists
// ---------------
// 0.94.0 fixed three EPL bugs found by looking at a Bitmagnet listing by eye:
// code-pair naming (ARS-CHE), the opponent-token guard, and compact YYYYMMDD
// dates. Every one of those releases was in the index the whole time and was
// being discarded by the matcher, silently, with a reason nobody read.
//
// Eyeballing screenshots found one. It will not find the next twenty.
//
// Bitmagnet changes the economics: it is local, unmetered and holds the raw
// torrent names, so we can replay a whole corpus through the real matcher and
// let the rejection reasons cluster. "no-away-team-alias x 40" names the next
// bug in one line.
//
// What it deliberately does NOT do
// --------------------------------
// It proposes nothing and changes nothing. Auto-promoting mined patterns into
// the matcher is how the "Inter Milan matches AC Milan" class of false positive
// comes back — the guards this report probes exist because loosening them
// broke things before. Output is evidence for a human; each real finding then
// gets a fix and a pinning test, the way 0.94.0 did.
//
// Usage
// -----
//   node scripts/mine-bitmagnet.js --url http://bitmagnet:3333 --promotion epl
//   node scripts/mine-bitmagnet.js --url ... --all --days 180 --json report.json
//
//   --url         Bitmagnet base URL (or BITMAGNET_URL). /graphql is appended.
//   --promotion   Promotion id, repeatable. Default: every promotion with events.
//   --days        How far back to consider events. Default 120.
//   --limit       Max corpus titles to pull per search term. Default 500.
//   --examples    Example titles to print per rejection reason. Default 6.
//   --json        Also write the full machine-readable report here.
//
// Bitmagnet's GraphQL `title` is its own PARSED title; `torrent.name` is the
// raw release name. We mine the raw name, because that is what an indexer hands
// the matcher — the parsed form would hide the exact conventions we are after.

const fs = require('fs');
const path = require('path');
const promotions = require('../lib/promotions');
const store = require('../lib/store');
const aliasPresets = require('../lib/team-alias-presets');

function parseArgs(argv) {
  const out = { promotion: [], days: 120, limit: 500, examples: 6, all: false, url: '', json: '' };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--url') out.url = next();
    else if (arg === '--promotion') out.promotion.push(String(next() || '').trim());
    else if (arg === '--days') out.days = parseInt(next(), 10) || 120;
    else if (arg === '--limit') out.limit = parseInt(next(), 10) || 500;
    else if (arg === '--examples') out.examples = parseInt(next(), 10) || 6;
    else if (arg === '--json') out.json = next();
    else if (arg === '--all') out.all = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error('unknown argument: ' + arg);
  }
  out.url = out.url || process.env.BITMAGNET_URL || '';
  return out;
}

async function graphqlSearch(baseUrl, queryString, limit) {
  const endpoint = String(baseUrl).replace(/\/+$/, '').replace(/\/graphql$/i, '') + '/graphql';
  const query = `query Search($input: TorrentContentSearchQueryInput!) {
    torrentContent { search(input: $input) {
      totalCount
      items { infoHash publishedAt videoResolution torrent { name size seeders } }
    } }
  }`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      query,
      variables: { input: { queryString, limit, totalCount: true, cached: false } },
    }),
  });
  if (!res.ok) throw new Error('bitmagnet HTTP ' + res.status + ' at ' + endpoint);
  const payload = await res.json();
  if (payload.errors && payload.errors.length) {
    throw new Error('bitmagnet GraphQL error: ' + payload.errors.map((e) => e.message).join('; '));
  }
  const result = payload.data && payload.data.torrentContent && payload.data.torrentContent.search;
  return {
    totalCount: (result && result.totalCount) || 0,
    items: (result && result.items) || [],
  };
}

// Broad signature terms for a promotion: enough to sweep its corner of the
// index without naming individual fixtures. Per-event queries would be the
// thing we are trying to evaluate, so using them here would beg the question —
// we would only ever find releases our own queries already reach.
function corpusTerms(promotion, sampleEvent) {
  const terms = new Set();
  const add = (value) => {
    const text = String(value || '').trim().replace(/[.]+/g, ' ').replace(/\s+/g, ' ').trim();
    // Two characters is too loose for a full-text sweep ("PL" pulls the index).
    if (text.length >= 3) terms.add(text);
  };
  add(promotion.name);

  // Promotions do not expose their alias arrays as properties, so take the
  // league aliases from the preset table — the same list the matcher treats as
  // competition context ("EPL", "Premier League", "BPL").
  for (const alias of (aliasPresets.getLeagueAliasDefaults(promotion.id) || []).slice(0, 6)) add(alias);

  // For promotions with no league preset (F1, UFC, WWE), the event-name alias
  // builder yields the competition prefixes instead: "Formula 1 Italian Grand
  // Prix", "F1 Italian GP". Strip the event-specific tail and keep the prefix.
  if (terms.size < 3 && sampleEvent && sampleEvent.name && typeof promotion.buildAliases === 'function') {
    const eventWords = new Set(String(sampleEvent.name).toLowerCase().split(/\s+/));
    for (const alias of promotion.buildAliases(sampleEvent.name).slice(0, 8)) {
      const prefix = String(alias).replace(/[._]+/g, ' ').split(/\s+/)
        .filter((word) => {
          const lower = word.toLowerCase();
          if (!word || eventWords.has(lower)) return false;
          // "ItalianGP" survives the word filter because it is one token, but
          // it still names this fixture. Anything containing an event word is
          // event-specific, and a corpus term must not be.
          return !Array.from(eventWords).some((w) => w.length > 2 && lower.includes(w));
        })
        .join(' ');
      add(prefix);
    }
  }
  return Array.from(terms).slice(0, 8);
}

// Collapse a title to its shape so different fixtures with the same naming
// convention land in one bucket: digits become #, and the words we recognise
// as furniture stay put. This is what turns 40 individual rejections into one
// readable pattern.
function titleShape(title) {
  return String(title)
    .replace(/\.(mkv|mp4|ts|avi|m2ts)$/i, '')
    .replace(/[._\-\s]+/g, ' ')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .split(' ')
    .slice(0, 12)
    .join(' ');
}

function withinWindow(event, days) {
  if (!event || !event.date) return false;
  const eventMs = Date.parse(event.date + 'T00:00:00Z');
  if (!Number.isFinite(eventMs)) return false;
  const ageDays = (Date.now() - eventMs) / 86400000;
  return ageDays >= -14 && ageDays <= days;   // recent past, plus fixtures just ahead
}

function analysePromotion(promotion, events, corpus, options) {
  const matched = [];
  const rejected = new Map();       // reason -> { count, examples[] }
  const unattributed = [];

  for (const row of corpus) {
    const title = row.name;
    let hit = null;
    const reasons = new Set();

    for (const event of events) {
      let verdict;
      try { verdict = promotion.isRelevantStreamTitle(title, event); }
      catch (error) { verdict = { ok: false, reason: 'threw:' + error.message }; }
      if (verdict && verdict.ok) { hit = event; break; }
      if (verdict && verdict.reason) reasons.add(verdict.reason);
    }

    if (hit) { matched.push({ title, eventId: hit.id, eventName: hit.name, date: hit.date }); continue; }

    unattributed.push({ title, shape: titleShape(title), reasons: Array.from(reasons) });
    // A title is counted against every reason it produced. A release rejected
    // as no-date-in-title for one fixture and wrong-date for another is
    // evidence for both, and picking one would hide half the signal.
    for (const reason of reasons) {
      if (!rejected.has(reason)) rejected.set(reason, { count: 0, examples: [] });
      const bucket = rejected.get(reason);
      bucket.count += 1;
      if (bucket.examples.length < options.examples) bucket.examples.push(title);
    }
  }

  // Cluster the misses by shape — this is the part that names a convention
  // rather than an incident.
  const shapes = new Map();
  for (const row of unattributed) {
    if (!shapes.has(row.shape)) shapes.set(row.shape, { count: 0, example: row.title });
    shapes.get(row.shape).count += 1;
  }

  return {
    promotion: promotion.id,
    name: promotion.name,
    events: events.length,
    corpus: corpus.length,
    matched: matched.length,
    unmatched: unattributed.length,
    matchRate: corpus.length ? Math.round((matched.length / corpus.length) * 100) : 0,
    reasons: Array.from(rejected.entries())
      .map(([reason, data]) => ({ reason, count: data.count, examples: data.examples }))
      .sort((a, b) => b.count - a.count),
    shapes: Array.from(shapes.entries())
      .map(([shape, data]) => ({ shape, count: data.count, example: data.example }))
      .filter((row) => row.count > 1)
      .sort((a, b) => b.count - a.count)
      .slice(0, 15),
  };
}

function renderReport(reports) {
  const lines = [];
  lines.push('# Bitmagnet naming-convention report');
  lines.push('');
  lines.push('Corpus is raw torrent names from the local index, replayed through the');
  lines.push('real matcher against real events. A high unmatched count is not proof of');
  lines.push('a bug — most of it is other competitions, other seasons and junk — but a');
  lines.push('single rejection reason dominating a promotion usually is.');
  lines.push('');
  lines.push('| Promotion | Events | Corpus | Matched | Rate |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  for (const r of reports) {
    lines.push('| ' + r.name + ' | ' + r.events + ' | ' + r.corpus + ' | ' + r.matched + ' | ' + r.matchRate + '% |');
  }
  lines.push('');

  for (const r of reports) {
    lines.push('## ' + r.name + ' (' + r.promotion + ')');
    lines.push('');
    if (!r.corpus) { lines.push('_No corpus returned for this promotion._'); lines.push(''); continue; }
    lines.push('Matched ' + r.matched + ' of ' + r.corpus + ' (' + r.matchRate + '%).');
    lines.push('');
    if (r.reasons.length) {
      lines.push('### Why titles were rejected');
      lines.push('');
      for (const row of r.reasons.slice(0, 8)) {
        lines.push('- **' + row.reason + '** x' + row.count);
        for (const example of row.examples) lines.push('  - `' + example + '`');
      }
      lines.push('');
    }
    if (r.shapes.length) {
      lines.push('### Recurring shapes among unmatched titles');
      lines.push('');
      lines.push('Digits collapsed to `#`. A shape repeating many times is a naming');
      lines.push('convention, not a coincidence.');
      lines.push('');
      for (const row of r.shapes) {
        lines.push('- x' + row.count + ' `' + row.shape + '`');
        lines.push('  - e.g. `' + row.example + '`');
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n')
      .filter((line) => line.startsWith('//')).join('\n'));
    return;
  }
  if (!options.url) {
    throw new Error('Bitmagnet URL required: --url http://bitmagnet:3333 (or set BITMAGNET_URL)');
  }

  const allEvents = store.getEvents();
  const eventsByPromotion = new Map();
  for (const event of allEvents) {
    if (!withinWindow(event, options.days)) continue;
    const key = event.promotion;
    if (!eventsByPromotion.has(key)) eventsByPromotion.set(key, []);
    eventsByPromotion.get(key).push(event);
  }

  let targets = promotions.all;
  if (options.promotion.length) {
    targets = promotions.all.filter((p) => options.promotion.includes(p.id));
    const missing = options.promotion.filter((id) => !promotions.all.some((p) => p.id === id));
    if (missing.length) throw new Error('unknown promotion(s): ' + missing.join(', '));
  } else if (!options.all) {
    targets = promotions.all.filter((p) => (eventsByPromotion.get(p.id) || []).length);
  }

  const reports = [];
  for (const promotion of targets) {
    const events = eventsByPromotion.get(promotion.id) || [];
    if (!events.length) {
      console.error('skip ' + promotion.id + ': no events in the last ' + options.days + ' days');
      continue;
    }
    const terms = corpusTerms(promotion, events[0]);
    const seen = new Map();
    for (const term of terms) {
      let batch;
      try { batch = await graphqlSearch(options.url, term, options.limit); }
      catch (error) { console.error('  ' + promotion.id + ' "' + term + '": ' + error.message); continue; }
      for (const item of batch.items) {
        const name = item && item.torrent && item.torrent.name;
        if (name && !seen.has(name)) seen.set(name, { name, infoHash: item.infoHash });
      }
      console.error('  ' + promotion.id + ' "' + term + '": ' + batch.items.length
        + ' of ' + batch.totalCount + ' indexed');
    }
    reports.push(analysePromotion(promotion, events, Array.from(seen.values()), options));
  }

  if (!reports.length) throw new Error('nothing to report — no promotion had both events and a corpus');

  const markdown = renderReport(reports);
  console.log(markdown);
  if (options.json) {
    fs.writeFileSync(path.resolve(options.json), JSON.stringify(reports, null, 2));
    console.error('\nwrote ' + options.json);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
