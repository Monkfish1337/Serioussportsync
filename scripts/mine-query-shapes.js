'use strict';

// Measure which SEARCH QUERY SHAPES actually reach releases in a Bitmagnet index.
//
// Why this exists
// ---------------
// scripts/mine-bitmagnet.js asks "of the releases we found, which does the
// matcher wrongly reject?". This asks the question before that one: "of the
// queries we send, which ever find anything at all?".
//
// A discovery log of 832 queries answered it uncomfortably — 78 were
// productive, 9.4%. Two shapes accounted for most of the waste, and one
// combination (league name AND date) never returned a single result in 169
// attempts. That is not a tuning detail: the search budget is spent on queries
// before anything can be matched, so a shape that never hits is pure cost.
//
// The mechanism is simple once measured. Bitmagnet ANDs every term, so any term
// absent from a release name takes the result set to zero:
//
//     MCI COV                    -> 2      Premier League MCI COV   -> 0
//     MCI COV 20260905           -> 2      MCI COV 2026-09-05       -> 0
//
// The dominant football family is named `20260905_EPL_26.27_R.03_MCI_vs_COV`.
// The league token is `EPL`; "Premier League" appears nowhere, and the date is
// compact. Every query carrying the human league name, or a hyphenated date,
// is guaranteed to return nothing.
//
// What it does NOT do
// -------------------
// It changes nothing and proposes no code. It reports two things per promotion:
// which emitted shapes earn their place, and what three specific mechanical
// transformations of the existing queries WOULD have found. Whether to adopt
// them is a judgement about that promotion's release families, which differs
// per promotion — La Liga releases really do contain "LaLiga", so the rule that
// helps EPL would cost La Liga recall.
//
// Usage
// -----
//   node scripts/mine-query-shapes.js --url http://bitmagnet:3333 --promotion epl
//   node scripts/mine-query-shapes.js --url ... --all --events 3 --json report.json
//
//   --url         Bitmagnet base URL (or BITMAGNET_URL). /graphql is appended.
//   --promotion   Promotion id, repeatable. Default: every promotion with events.
//   --days        How far back to consider events. Default 30.
//   --events      Max events sampled per promotion. Default 4.
//   --concurrency Parallel queries. Default 4.
//   --max-queries Hard ceiling on queries issued. Default 4000.
//   --candidates  Also test transformed variants of each query. Default on;
//                 --no-candidates measures only what is emitted today.
//   --json        Also write the full machine-readable report here.

const fs = require('fs');
const path = require('path');
const promotions = require('../lib/promotions');
const store = require('../lib/store');

function parseArgs(argv) {
  const out = { promotion: [], days: 30, events: 4, concurrency: 4, maxQueries: 4000,
    all: false, url: '', json: '', candidates: true, help: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--url') out.url = next();
    else if (arg === '--promotion') out.promotion.push(String(next() || '').trim());
    else if (arg === '--days') out.days = parseInt(next(), 10) || 30;
    else if (arg === '--events') out.events = parseInt(next(), 10) || 4;
    else if (arg === '--concurrency') out.concurrency = parseInt(next(), 10) || 4;
    else if (arg === '--max-queries') out.maxQueries = parseInt(next(), 10) || 4000;
    else if (arg === '--json') out.json = next();
    else if (arg === '--candidates') out.candidates = true;
    else if (arg === '--no-candidates') out.candidates = false;
    else if (arg === '--all') out.all = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error('unknown argument: ' + arg);
  }
  out.url = out.url || process.env.BITMAGNET_URL || '';
  return out;
}

// Only totalCount and the hashes are needed. Hashes are what make "this query
// found something" distinguishable from "this query found something no other
// query had already found" — the second is the number that decides whether a
// shape can be dropped.
const SEARCH = `query Shapes($input: TorrentContentSearchQueryInput!) {
  torrentContent { search(input: $input) {
    totalCount
    items { infoHash torrent { name seeders } }
  } }
}`;

function endpoint(baseUrl) {
  return String(baseUrl).replace(/\/+$/, '').replace(/\/graphql$/i, '') + '/graphql';
}

async function search(url, queryString, limit) {
  const res = await fetch(endpoint(url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: SEARCH, variables: { input: {
      queryString, limit: limit || 20, totalCount: true, cached: false,
      orderBy: [{ field: 'seeders', descending: true }],
    } } }),
  });
  if (!res.ok) throw new Error('bitmagnet HTTP ' + res.status);
  const payload = await res.json();
  // GraphQL reports errors with HTTP 200; treating that as an empty result is
  // how a broken query becomes indistinguishable from an empty index.
  if (payload.errors && payload.errors.length) {
    throw new Error(payload.errors.map((e) => e.message).join('; '));
  }
  const result = payload.data && payload.data.torrentContent && payload.data.torrentContent.search;
  return { totalCount: (result && result.totalCount) || 0, items: (result && result.items) || [] };
}

// ---------------------------------------------------------------------------
// Shape classification
//
// A shape is the structural description of a query, with the specifics removed.
// Two queries for different fixtures share a shape when they would succeed or
// fail for the same reason.
// ---------------------------------------------------------------------------

const DATE_FORMS = [
  { key: 'compact', re: /(?<![\d])(20\d{2})(\d{2})(\d{2})(?![\d])/ },
  { key: 'iso', re: /(?<![\d])(20\d{2})-(\d{2})-(\d{2})(?![\d])/ },
  { key: 'dotted', re: /(?<![\d])(20\d{2})\.(\d{2})\.(\d{2})(?![\d])/ },
  { key: 'spaced', re: /(?<![\d])(20\d{2}) (\d{2}) (\d{2})(?![\d])/ },
  { key: 'short', re: /(?<![\d])(\d{2})\.(\d{2})\.(\d{2})(?![\d])/ },
];

function dateForm(query) {
  for (const form of DATE_FORMS) if (form.re.test(query)) return form.key;
  return 'none';
}

function separator(query) {
  if (/ @ /.test(query)) return '@';
  if (/\bvs\b/i.test(query)) return 'vs';
  if (/\b[A-Z]{2,4}-[A-Z]{2,4}\b/.test(query)) return 'code-pair';
  return 'none';
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A query opening with two short uppercase runs joined by a separator is a code
// PAIR, not a league token followed by a team — "MCI vs COV" must not be read as
// prefixed by "MCI".
const CODE_PAIR_HEAD = /^\s*[A-Z]{2,4}\s*(?:-|_|vs\.?|@|v)\s*[A-Z]{2,4}\b/i;

// Prefix candidates for a promotion: its full name, the name with spaces
// removed (releases write "LaLiga" as one word), and its longer words. Matching
// only on individual words misses "La Liga", whose only long word is "Liga".
function prefixCandidates(promotion) {
  const name = String(promotion.name || '').trim();
  const out = new Set();
  if (name) {
    out.add(name);
    out.add(name.replace(/\s+/g, ''));
    for (const word of name.split(/\s+/)) if (word.length >= 4) out.add(word);
  }
  return Array.from(out).sort((a, b) => b.length - a.length);
}

// Does the query open with the promotion's own name? That is the form that
// fails when releases use a scene token instead — and the one that works when,
// like La Liga, the releases really do carry the name.
function leaguePrefix(promotion, query) {
  for (const candidate of prefixCandidates(promotion)) {
    if (new RegExp('^\\s*' + escapeRe(candidate) + '\\b', 'i').test(query)) return 'league';
  }
  if (CODE_PAIR_HEAD.test(query)) return 'none';
  if (/^\s*[A-Z]{2,5}\b/.test(query)) return 'token';   // EPL, UCL, ERE...
  return 'none';
}

function usesCodes(query) {
  return /\b[A-Z]{3}\b/.test(query.replace(/^[A-Z]{2,5}\b/, ''));
}

function shapeOf(promotion, query) {
  return [
    'prefix:' + leaguePrefix(promotion, query),
    'sep:' + separator(query),
    'date:' + dateForm(query),
    usesCodes(query) ? 'names:codes' : 'names:full',
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Candidate transformations
//
// Mechanical rewrites of an emitted query, so the report can say what a change
// would have found without anyone hand-writing new queries. Deriving them from
// the real queries keeps this honest: no team lists, no invented aliases.
// ---------------------------------------------------------------------------

function toCompactDate(query) {
  for (const form of DATE_FORMS) {
    if (form.key === 'compact') continue;
    const m = query.match(form.re);
    if (!m) continue;
    const [, a, b, c] = m;
    const compact = form.key === 'short' ? '20' + c + b + a : a + b + c;
    return query.replace(form.re, compact);
  }
  return null;
}

function stripLeaguePrefix(promotion, query) {
  let out = query;
  for (const candidate of prefixCandidates(promotion)) {
    const stripped = out.replace(new RegExp('^\\s*' + escapeRe(candidate) + '\\b\\s*', 'i'), '');
    if (stripped !== out) { out = stripped; break; }
  }
  out = out.trim();
  return out && out !== query.trim() ? out : null;
}

function stripDate(query) {
  let out = query;
  for (const form of DATE_FORMS) out = out.replace(form.re, '');
  out = out.replace(/\s+/g, ' ').trim();
  return out && out !== query.trim() ? out : null;
}

function candidatesFor(promotion, query) {
  const out = [];
  const compact = toCompactDate(query);
  if (compact) out.push({ transform: 'date -> compact', query: compact });
  const noPrefix = stripLeaguePrefix(promotion, query);
  if (noPrefix) out.push({ transform: 'drop league prefix', query: noPrefix });
  const noDate = stripDate(query);
  if (noDate) out.push({ transform: 'drop date', query: noDate });
  if (noPrefix) {
    const both = stripDate(noPrefix);
    if (both) out.push({ transform: 'drop prefix + date', query: both });
  }
  return out;
}

// ---------------------------------------------------------------------------

function withinWindow(event, days) {
  if (!event || !event.date) return false;
  const ms = Date.parse(event.date + 'T00:00:00Z');
  if (!Number.isFinite(ms)) return false;
  const ageDays = (Date.now() - ms) / 86400000;
  return ageDays >= -14 && ageDays <= days;
}

async function pool(items, concurrency, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function emptyStat() {
  return { queries: 0, hits: 0, results: 0, unique: 0, examples: [] };
}

async function analyse(promotion, events, options, budget) {
  const shapes = new Map();
  const transforms = new Map();
  let issued = 0;

  for (const event of events) {
    if (budget.spent >= options.maxQueries) break;
    let titles = [];
    try {
      titles = Array.from(new Set([].concat(
        promotion.searchTitles ? promotion.searchTitles(event) || [] : [],
        event.searchAliases || [],
      ).filter(Boolean)));
    } catch (error) {
      console.error('  ' + promotion.id + ' ' + event.id + ': searchTitles threw: ' + error.message);
      continue;
    }
    if (!titles.length) continue;

    // Baseline: what the emitted queries find, and which query found what.
    const perQuery = new Map();
    await pool(titles, options.concurrency, async (title) => {
      if (budget.spent >= options.maxQueries) return;
      budget.spent += 1; issued += 1;
      try {
        const page = await search(options.url, title, 20);
        perQuery.set(title, page.items.map((i) => i.infoHash));
      } catch (error) {
        console.error('  ' + promotion.id + ' "' + title + '": ' + error.message);
        perQuery.set(title, []);
      }
    });

    // A hash found by several queries is only evidence for the first of them.
    // Counting it against each is what makes a redundant shape look productive.
    const seenElsewhere = new Map();
    for (const [, hashes] of perQuery) {
      for (const h of hashes) seenElsewhere.set(h, (seenElsewhere.get(h) || 0) + 1);
    }

    const baseline = new Set();
    for (const [title, hashes] of perQuery) {
      const key = shapeOf(promotion, title);
      if (!shapes.has(key)) shapes.set(key, emptyStat());
      const stat = shapes.get(key);
      stat.queries += 1;
      stat.results += hashes.length;
      if (hashes.length) stat.hits += 1;
      for (const h of hashes) {
        baseline.add(h);
        if (seenElsewhere.get(h) === 1) stat.unique += 1;
      }
      if (hashes.length && stat.examples.length < 3) stat.examples.push(title);
    }

    if (!options.candidates) continue;

    // What would the transformed queries have added, over everything the
    // emitted set already found for this event?
    const proposed = [];
    for (const title of titles) {
      for (const candidate of candidatesFor(promotion, title)) proposed.push(candidate);
    }
    const deduped = [];
    const seenQuery = new Set(titles.map((t) => t.toLowerCase()));
    for (const c of proposed) {
      const key = c.transform + '\n' + c.query.toLowerCase();
      if (seenQuery.has(c.query.toLowerCase()) || seenQuery.has(key)) continue;
      seenQuery.add(key);
      deduped.push(c);
    }

    await pool(deduped, options.concurrency, async (candidate) => {
      if (budget.spent >= options.maxQueries) return;
      budget.spent += 1; issued += 1;
      if (!transforms.has(candidate.transform)) transforms.set(candidate.transform, emptyStat());
      const stat = transforms.get(candidate.transform);
      stat.queries += 1;
      try {
        const page = await search(options.url, candidate.query, 20);
        if (page.items.length) stat.hits += 1;
        stat.results += page.items.length;
        for (const item of page.items) if (!baseline.has(item.infoHash)) stat.unique += 1;
        if (page.items.length && stat.examples.length < 3) stat.examples.push(candidate.query);
      } catch (error) {
        console.error('  ' + promotion.id + ' candidate "' + candidate.query + '": ' + error.message);
      }
    });
  }

  const rank = (map) => Array.from(map.entries())
    .map(([key, s]) => Object.assign({ key }, s,
      { hitRate: s.queries ? Math.round((s.hits / s.queries) * 100) : 0 }))
    .sort((a, b) => b.unique - a.unique || b.results - a.results);

  return {
    promotion: promotion.id,
    name: promotion.name,
    events: events.length,
    issued,
    shapes: rank(shapes),
    transforms: rank(transforms),
  };
}

function renderReport(reports, options) {
  const lines = [];
  lines.push('# Query shape report');
  lines.push('');
  lines.push('Every query a promotion emits for a sampled event, run against the live');
  lines.push('index. `unique` counts hashes no OTHER query for that event found — a shape');
  lines.push('with hits but no unique contribution is duplicating work, and is the safe');
  lines.push('thing to drop. `hit%` alone would call it productive.');
  lines.push('');
  lines.push('| Promotion | Events | Queries | Shapes |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const r of reports) {
    lines.push('| ' + r.name + ' | ' + r.events + ' | ' + r.issued + ' | ' + r.shapes.length + ' |');
  }
  lines.push('');

  for (const r of reports) {
    lines.push('## ' + r.name + ' (' + r.promotion + ')');
    lines.push('');
    if (!r.shapes.length) { lines.push('_No queries emitted._'); lines.push(''); continue; }
    lines.push('### Emitted shapes');
    lines.push('');
    lines.push('| Shape | Queries | Hits | hit% | Results | Unique |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const s of r.shapes) {
      lines.push('| `' + s.key + '` | ' + s.queries + ' | ' + s.hits + ' | ' + s.hitRate
        + '% | ' + s.results + ' | ' + s.unique + ' |');
    }
    lines.push('');
    const dead = r.shapes.filter((s) => s.queries >= 5 && s.hits === 0);
    if (dead.length) {
      lines.push('Never productive in this sample:');
      lines.push('');
      for (const s of dead) lines.push('- `' + s.key + '` — ' + s.queries + ' queries, 0 hits');
      lines.push('');
    }
    if (options.candidates && r.transforms.length) {
      lines.push('### What transformed queries would have added');
      lines.push('');
      lines.push('`unique` here means hashes the emitted queries did NOT find.');
      lines.push('');
      lines.push('| Transform | Queries | Hits | hit% | New hashes |');
      lines.push('| --- | ---: | ---: | ---: | ---: |');
      for (const t of r.transforms) {
        lines.push('| ' + t.key + ' | ' + t.queries + ' | ' + t.hits + ' | ' + t.hitRate
          + '% | ' + t.unique + ' |');
      }
      lines.push('');
      for (const t of r.transforms.filter((x) => x.examples.length)) {
        lines.push('- **' + t.key + '** e.g. `' + t.examples[0] + '`');
      }
      lines.push('');
    }
  }
  lines.push('---');
  lines.push('');
  lines.push('A shape that is dead for one promotion may be essential to another:');
  lines.push('La Liga releases really do contain "LaLiga", so dropping league prefixes');
  lines.push('globally would cost recall there while gaining it for EPL. Read this per');
  lines.push('promotion, not as a single rule.');
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

  const eventsByPromotion = new Map();
  for (const event of store.getEvents()) {
    if (!withinWindow(event, options.days)) continue;
    if (!eventsByPromotion.has(event.promotion)) eventsByPromotion.set(event.promotion, []);
    eventsByPromotion.get(event.promotion).push(event);
  }

  let targets = promotions.all;
  if (options.promotion.length) {
    targets = promotions.all.filter((p) => options.promotion.includes(p.id));
    const missing = options.promotion.filter((id) => !promotions.all.some((p) => p.id === id));
    if (missing.length) throw new Error('unknown promotion(s): ' + missing.join(', '));
  } else if (!options.all) {
    targets = promotions.all.filter((p) => (eventsByPromotion.get(p.id) || []).length);
  }

  const budget = { spent: 0 };
  const reports = [];
  for (const promotion of targets) {
    const events = (eventsByPromotion.get(promotion.id) || []).slice(0, options.events);
    if (!events.length) {
      console.error('skip ' + promotion.id + ': no events in the last ' + options.days + ' days');
      continue;
    }
    console.error('mining ' + promotion.id + ' (' + events.length + ' event(s))...');
    reports.push(await analyse(promotion, events, options, budget));
    if (budget.spent >= options.maxQueries) {
      console.error('query budget of ' + options.maxQueries + ' reached; stopping');
      break;
    }
  }

  if (!reports.length) throw new Error('nothing to report — no promotion had events in the window');

  console.log(renderReport(reports, options));
  console.error('\n' + budget.spent + ' queries issued');
  if (options.json) {
    fs.writeFileSync(path.resolve(options.json), JSON.stringify(reports, null, 2));
    console.error('wrote ' + options.json);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
