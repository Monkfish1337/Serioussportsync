// Wikipedia "list page" adapter — for pages that aggregate events in tables
// nested under year subsections, e.g.:
//   List_of_WWE_premium_live_events  -> ==Past events== / ===2026=== / table
//   AEW_pay-per-view_events           -> ==Past events== / ===2026=== / table
//
// Builds on lib/sources/wikipedia.js for HTTP, table parsing, and image
// enrichment; adds the year-from-heading logic those promotions need.

const wiki = require('./wikipedia');

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function slugify(s) {
  return (s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function parseSectionedListPage(wikitext, promotion, opts) {
  if (!wikitext) return [];
  opts = opts || {};
  // Default to common heading variants. WWE uses "Upcoming event schedule"
  // while AEW/most pages use "Upcoming events".
  const sections = opts.sections || [
    'Past events',
    'Upcoming events',
    'Upcoming event schedule',
  ];
  const eventStartIso = opts.eventStartIso || null;
  const seen = new Set();
  const out = [];

  for (const sectionName of sections) {
    const sectionRe = new RegExp('={2,}\\s*' + escapeRe(sectionName) + '\\s*={2,}', 'i');
    const m = wikitext.match(sectionRe);
    if (!m) continue;

    const headingMarks = m[0].match(/^=+/)[0].length;
    const start = m.index + m[0].length;

    // Stop at next heading of equal-or-fewer = signs.
    const stopRe = new RegExp('\\n={1,' + headingMarks + '}[^=\\n]+={1,' + headingMarks + '}\\n', 'g');
    stopRe.lastIndex = start;
    const stop = stopRe.exec(wikitext);
    const sectionEnd = stop ? stop.index : wikitext.length;
    const sectionBody = wikitext.slice(start, sectionEnd);

    // Year subsections (=== 2026 === / ==== 2026 ====).
    const yearRe = /\n(={3,})\s*(\d{4})\s*\1\s*\n/g;
    const years = [];
    let ym;
    while ((ym = yearRe.exec(sectionBody)) !== null) {
      years.push({ year: ym[2], offset: ym.index + ym[0].length });
    }

    for (let i = 0; i < years.length; i++) {
      const { year, offset } = years[i];
      const next = (i + 1 < years.length) ? years[i + 1].offset : sectionBody.length;
      const yearBody = sectionBody.slice(offset, next);

      if (eventStartIso && (year + '-12-31') < eventStartIso) continue;

      const tableRe = /\{\|[\s\S]*?\n\|\}/g;
      let tm;
      while ((tm = tableRe.exec(yearBody)) !== null) {
        if (!/wikitable/i.test(tm[0])) continue;
        if (!/\bDate\b/.test(tm[0])) continue;
        const layout = wiki.detectColumnLayout(tm[0]);
        if (!layout) continue;
        const { rows } = wiki.parseTableRows(tm[0]);
        for (const row of rows) {
          if (row.length === 0) continue;
          const r = layout.map(row, year);
          if (!r.name || !r.date) continue;
          if (eventStartIso && r.date < eventStartIso) continue;

          const stableBase = r.linkTarget
            ? r.linkTarget
            : ((promotion && promotion.shortHandle && promotion.shortHandle(r.name)) || null);
          const sourceId = stableBase
            ? slugify(stableBase)
            : (r.date + '-' + slugify(r.name));
          if (seen.has(sourceId)) continue;
          seen.add(sourceId);

          out.push({
            sourceId,
            name: r.name,
            date: r.date,
            venue: r.venue,
            city: r.city,
            country: r.country,
            linkTarget: r.linkTarget || null,
            source: { type: 'wikipedia-list', section: sectionName, year },
          });
        }
      }
    }
  }
  return out;
}

async function fetchAll(opts) {
  opts = opts || {};
  const log = opts.log || (() => {});
  if (!opts.pageTitle) throw new Error('wikipedia-list: opts.pageTitle required');
  log('-> wikipedia-list: ' + opts.pageTitle);

  // Reuse the HTTP fetch + retry logic from wikipedia.js. We need to call
  // its private fetchWikitext via the module's MediaWiki API.
  const url = 'https://en.wikipedia.org/w/api.php?action=parse&format=json&prop=wikitext&redirects=1&page=' +
    encodeURIComponent(opts.pageTitle);
  const fetch = require('node-fetch');
  const UA = 'serioussportsync';
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!res.ok) {
    log('  ' + opts.pageTitle + ' HTTP ' + res.status);
    return [];
  }
  const json = await res.json();
  if (json.error) {
    if (json.error.code === 'missingtitle') return [];
    log('  ' + opts.pageTitle + ' API error: ' + json.error.info);
    return [];
  }
  const wt = json.parse && json.parse.wikitext && json.parse.wikitext['*'];
  if (!wt) { log('  ' + opts.pageTitle + ' empty wikitext'); return []; }

  const events = parseSectionedListPage(wt, opts.promotion || { shortHandle: () => null }, {
    sections: opts.sections,
    eventStartIso: opts.eventStartIso || null,
  });
  log('  ' + opts.pageTitle + ': ' + events.length + ' events parsed');

  if (opts.enrichImages !== false) {
    try { await wiki.enrichWithSummaries(events, log); }
    catch (err) { log('  enrichment failed: ' + err.message); }
  }
  return events;
}

module.exports = { fetchAll, parseSectionedListPage };
