// Wikipedia source adapter — currently used by ONE Championship.
//
// Strategy: pull the wikitext for each "<year> in ONE Championship" page via
// the MediaWiki action=parse API, then parse the "Past events" and
// "Scheduled events" wikitables. We deliberately work off raw wikitext (not
// rendered HTML) because:
//   1. No HTML/DOM dependency to add to the project.
//   2. Wikitext templates like {{dts|2025|12|19}} give us machine-readable
//      dates regardless of the user's locale.
//   3. Wikipedia's table HTML output changes more often than its wikitext
//      conventions.
//
// The adapter emits raw records in the shape lib/transform.js#fromWiki
// expects: { sourceId, name, date, venue, city, country, ... }. The
// promotion.shortHandle helper supplies a stable sourceId so events can be
// deduped if Wikipedia later moves them between year pages.

const fetch = require('node-fetch');

// Generic UA — keep no personal/GitHub info here so a public release doesn't
// leak deployer identity to upstream services. The package version is
// available via require('../../package.json').version if a future caller
// wants to be more specific.
const UA = 'serioussportsync';

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// -------------------------------------------------------------------------
// HTTP
// -------------------------------------------------------------------------

async function fetchWikitext(pageTitle, log) {
  const url = 'https://en.wikipedia.org/w/api.php?action=parse&format=json&prop=wikitext&page=' +
    encodeURIComponent(pageTitle);
  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    } catch (err) {
      if (attempt < maxRetries) {
        const wait = 3000 * (attempt + 1);
        log('    network error fetching ' + pageTitle + ', retry in ' + wait + 'ms: ' + err.message);
        await delay(wait); continue;
      }
      throw err;
    }
    if (res.status === 429) {
      const wait = 30000 * (attempt + 1);
      log('    429 from Wikipedia, sleeping ' + (wait / 1000) + 's');
      await delay(wait); continue;
    }
    if (!res.ok) {
      // Pages that don't exist yet (e.g. future years) come back as 404.
      if (res.status === 404) return null;
      throw new Error('HTTP ' + res.status + ' for ' + pageTitle);
    }
    const json = await res.json();
    if (json.error) {
      // missingtitle is the API's "page does not exist" — treat as no data.
      if (json.error.code === 'missingtitle') return null;
      throw new Error('Wikipedia API error for ' + pageTitle + ': ' + json.error.info);
    }
    return json.parse && json.parse.wikitext && json.parse.wikitext['*'];
  }
  return null;
}

// -------------------------------------------------------------------------
// Wikitext parsing helpers
// -------------------------------------------------------------------------

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
  oct: 10, nov: 11, dec: 12,
};

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

// Extract a date in YYYY-MM-DD form from a wikitext cell. Handles the common
// {{dts|YYYY|MM|DD}} / {{dts|YYYY|Month|D}} forms used on these pages, and
// falls back to a plain "Month D, YYYY" string.
function extractDate(cell, defaultYear) {
  if (!cell) return null;
  // {{dts|YYYY|M|D}} or {{dts|YYYY|Month|D}}
  const dts = cell.match(/\{\{\s*dts\s*\|\s*(\d{4})\s*\|\s*([^|}]+?)\s*\|\s*(\d{1,2})\s*[|}]/i);
  if (dts) {
    const y = parseInt(dts[1], 10);
    const monthRaw = dts[2].trim().toLowerCase();
    let m = parseInt(monthRaw, 10);
    if (Number.isNaN(m)) m = MONTHS[monthRaw];
    const d = parseInt(dts[3], 10);
    if (y && m && d) return y + '-' + pad2(m) + '-' + pad2(d);
  }
  // {{Start date|YYYY|M|D}}
  const sd = cell.match(/\{\{\s*Start date\s*\|\s*(\d{4})\s*\|\s*(\d{1,2})\s*\|\s*(\d{1,2})/i);
  if (sd) return sd[1] + '-' + pad2(+sd[2]) + '-' + pad2(+sd[3]);
  // "December 19, 2025" / "19 December 2025"
  const longA = cell.match(/([A-Z][a-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (longA && MONTHS[longA[1].toLowerCase()]) {
    return longA[3] + '-' + pad2(MONTHS[longA[1].toLowerCase()]) + '-' + pad2(+longA[2]);
  }
  const longB = cell.match(/(\d{1,2})\s+([A-Z][a-z]+)\s+(\d{4})/);
  if (longB && MONTHS[longB[2].toLowerCase()]) {
    return longB[3] + '-' + pad2(MONTHS[longB[2].toLowerCase()]) + '-' + pad2(+longB[1]);
  }
  // Month + day only — use the year supplied via defaultYear from a section heading.
  if (defaultYear) {
    const md = cell.match(/([A-Z][a-z]+)\s+(\d{1,2})\b/);
    if (md && MONTHS[md[1].toLowerCase()]) {
      return defaultYear + '-' + pad2(MONTHS[md[1].toLowerCase()]) + '-' + pad2(+md[2]);
    }
  }
  return null;
}

// Extract a display name + link target for an event from a wikitext cell.
// Handles:
//   [[Page|Display]]    -> { name: Display,  linkTarget: Page }
//   [[#Anchor|Display]] -> { name: Display,  linkTarget: null }   (anchor only)
//   [[Page]]            -> { name: Page,     linkTarget: Page }
//   Plain text          -> { name: text,     linkTarget: null }
function extractEventLink(cell) {
  if (!cell) return { name: null, linkTarget: null };
  let s = cell.trim();
  s = s.replace(/<ref[\s\S]*?<\/ref>/gi, '').replace(/<ref[^/]*\/>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  const linked = s.match(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/);
  if (linked) {
    const target = linked[1].trim();
    const display = (linked[2] || linked[1]).trim();
    const isAnchor = target.startsWith('#');
    return {
      name: display.replace(/^#/, ''),
      linkTarget: isAnchor ? null : target,
    };
  }
  s = s.replace(/\{\{[^}]+\}\}/g, '').replace(/'''?/g, '').trim();
  return { name: s || null, linkTarget: null };
}

// Backward-compat shim — callers that only want the name still work.
function extractEventName(cell) {
  return extractEventLink(cell).name;
}

// Strip wikitext markup down to a plain string (used for venue/city/country).
function plainText(cell) {
  if (!cell) return null;
  let s = cell;
  s = s.replace(/<ref[\s\S]*?<\/ref>/gi, '').replace(/<ref[^/]*\/>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/\[\[([^\]|]+?)\|([^\]]+?)\]\]/g, '$2'); // [[A|B]] -> B
  s = s.replace(/\[\[([^\]]+?)\]\]/g, '$1');             // [[A]] -> A
  s = s.replace(/\{\{n\/a\}\}/gi, '').replace(/\{\{[^}]+\}\}/g, '');
  s = s.replace(/'''?/g, '').replace(/<[^>]+>/g, '').trim();
  return s || null;
}

function slugify(s) {
  return (s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// -------------------------------------------------------------------------
// Table extraction
// -------------------------------------------------------------------------

// Pull every wikitable that follows a section heading whose text matches
// `headingPattern`. Returns an array of raw table strings (without the {| /
// |} delimiters).
function extractTablesUnderHeading(wikitext, headingPattern) {
  const tables = [];
  const headingRe = new RegExp('={2,}\\s*' + headingPattern + '\\s*={2,}', 'gi');
  let m;
  while ((m = headingRe.exec(wikitext)) !== null) {
    const start = m.index + m[0].length;
    // Find the start of the next heading of equal-or-higher level so we
    // don't accidentally span into the next section.
    const nextHeading = wikitext.slice(start).search(/\n={2,}[^=\n]+={2,}/);
    const sectionEnd = nextHeading === -1 ? wikitext.length : start + nextHeading;
    const section = wikitext.slice(start, sectionEnd);

    // Find each {| ... |} block in the section.
    const tableRe = /\{\|[\s\S]*?\n\|\}/g;
    let t;
    while ((t = tableRe.exec(section)) !== null) {
      // Only keep tables that look like an events table (header has Date col).
      if (/wikitable/i.test(t[0]) && /\bDate\b/.test(t[0])) {
        tables.push(t[0]);
      }
    }
  }
  return tables;
}

// Split a table into row groups separated by "|-" markers. Returns an
// array of cell-arrays, where each row's cells have been re-aligned to
// account for the rowspan'd cells inherited from the previous row(s).
//
// The key trick: a "spanning" cell stays in column N for `rowspan` rows.
// We track these and when we visit a sub-row that has fewer cells than the
// header, we splice the inherited cells back in at their original column
// indices. That way every row's cells line up with the same columns.
function parseTableRows(tableSrc) {
  // Strip multi-line <ref>...</ref> blocks first. The wikitext citations
  // inside refs (e.g. {{cite web | url=... | title=...}}) contain literal
  // `|` characters and span multiple lines, which would otherwise confuse
  // the row tokenizer into thinking they're new cells. Refs are pure
  // metadata for our purposes — drop them.
  tableSrc = tableSrc.replace(/<ref[\s\S]*?<\/ref>/gi, '');
  tableSrc = tableSrc.replace(/<ref[^/]*\/>/gi, '');
  // Also strip HTML comments and {{efn|...}} footnotes for the same reason.
  tableSrc = tableSrc.replace(/<!--[\s\S]*?-->/g, '');

  const lines = tableSrc.split('\n');
  // The header section spans all `! ...` lines at the top of the table
  // (some authors put a decorative `|-` before the header). We count
  // header cells until we hit the first actual `|` data line. After that,
  // any `! ...` is a row-header data cell (e.g. AEW's `! scope="row"|...`).
  let headerCols = 0;
  let inHeader = true;
  for (const ln of lines) {
    const t = ln.trim();
    if (/^\{\|/.test(t) || /^\|\}/.test(t) || /^\|-/.test(t)) continue;
    if (/^!/.test(t)) {
      if (!inHeader) continue;
      const inner = t.replace(/^!+/, '');
      const parts = inner.split(/!!/);
      headerCols += parts.length;
    } else if (/^\|/.test(t)) {
      // First data cell — header section is done.
      inHeader = false;
    }
  }

  // Now collect rows separated by |- markers.
  //
  // Header detection: lines starting with `!` are header cells UNTIL we've
  // seen the first `|-` separator that follows at least one header line.
  // After that first separator, any `!` line is a row-header data cell
  // (like AEW's `! scope="row"|[[Event]]`).
  //
  // Tables that put a decorative `|-` BEFORE the header block (like WWE's)
  // are also handled: we keep counting header lines as long as we haven't
  // seen any data `|` yet, and any subsequent `|-` flips us into row mode
  // once header lines have been observed.
  const rawRows = [];
  let cur = null;
  let pastHeader = false;
  let sawHeaderLine = false;
  for (const ln of lines) {
    const t = ln.trim();
    if (/^\{\|/.test(t) || /^\|\}/.test(t)) continue;
    if (/^\|-/.test(t)) {
      // Closing the current row group (push if accumulated).
      if (cur) rawRows.push(cur);
      cur = [];
      // First `|-` after we've started seeing headers ends the header section.
      if (sawHeaderLine) pastHeader = true;
      continue;
    }
    if (!pastHeader && /^!/.test(t)) {
      sawHeaderLine = true;
      continue; // header line, already counted above
    }
    if (/^\|/.test(t)) pastHeader = true;
    if (cur === null) cur = [];
    if (/^\|/.test(t)) {
      const inner = t.replace(/^\|/, '');
      const parts = inner.split(/\|\|/);
      for (const p of parts) cur.push(p);
    } else if (/^!/.test(t)) {
      // Past-header `!` is a row-header data cell.
      const inner = t.replace(/^!+/, '');
      const parts = inner.split(/!!/);
      for (const p of parts) cur.push(p);
    } else {
      if (cur.length === 0) cur.push('');
      cur[cur.length - 1] += '\n' + ln;
    }
  }
  if (cur) rawRows.push(cur);

  // Now align with rowspan inheritance.
  const aligned = [];
  // inherited[colIdx] = { value, remaining }
  const inherited = [];
  for (const row of rawRows) {
    if (row.length === 0) continue;
    const final = [];
    let cellIdx = 0;
    let colIdx = 0;
    while (colIdx < headerCols) {
      // Slot in any inherited rowspan cell.
      if (inherited[colIdx] && inherited[colIdx].remaining > 0) {
        final.push(inherited[colIdx].value);
        inherited[colIdx].remaining -= 1;
        colIdx++;
        continue;
      }
      if (cellIdx >= row.length) break;
      const raw = row[cellIdx++];
      // Detect rowspan="N" or rowspan=N at the head of the cell, before the
      // attribute terminator `|`. Only consider attribute prefixes — tokens
      // like "rowspan" embedded in prose shouldn't trigger.
      let rowspan = 1;
      let value = raw;
      const attrMatch = raw.match(/^\s*([a-zA-Z][^=|]*=\s*("[^"]*"|[^|\s]+)\s*)+\|/);
      if (attrMatch) {
        const attrs = attrMatch[0];
        const rs = attrs.match(/rowspan\s*=\s*"?(\d+)"?/i);
        if (rs) rowspan = parseInt(rs[1], 10);
        value = raw.slice(attrs.length);
      }
      // Detect colspan to advance multiple columns in one go.
      let colspan = 1;
      if (attrMatch) {
        const cs = attrMatch[0].match(/colspan\s*=\s*"?(\d+)"?/i);
        if (cs) colspan = parseInt(cs[1], 10);
      }

      for (let c = 0; c < colspan && colIdx < headerCols; c++) {
        if (rowspan > 1) {
          inherited[colIdx] = { value, remaining: rowspan - 1 };
        }
        final.push(value);
        colIdx++;
      }
    }
    aligned.push(final);
  }
  return { headerCols, rows: aligned };
}

// Header signatures we recognize. We match by inspecting the *header line
// text* the table starts with. Each signature returns a function that
// extracts {name, date, venue, city, country} from an aligned row.
function detectColumnLayout(tableSrc) {
  // Read header tokens. They appear as `! scope="col" | <Name>` lines or
  // `! Name` lines. Strip everything before the last `|` on each header line.
  const headerLines = [];
  for (const ln of tableSrc.split('\n')) {
    const t = ln.trim();
    if (/^\{\|/.test(t) || /^\|-/.test(t)) {
      if (headerLines.length) break;
      continue;
    }
    if (/^!/.test(t)) {
      const piece = t.replace(/^!/, '').trim();
      // Split by `!!` for inline header blocks
      for (const part of piece.split(/!!/)) {
        const after = part.split('|').pop().trim();
        // strip wiki/HTML noise
        headerLines.push(after.replace(/<[^>]+>/g, '').trim());
      }
    } else if (headerLines.length) {
      // first non-header, non-{|, non-|- line means the header block ended
      break;
    }
  }
  const lower = headerLines.map((h) => h.toLowerCase());
  // Past events: # | Event | Date | Venue | City | Country | (Performance×2) | Bonus | Ref
  // Scheduled  : Event | Date | Venue | City | Country | Ref
  const idxEvent = lower.indexOf('event');
  const idxDate = lower.indexOf('date');
  const idxVenue = lower.indexOf('venue');
  const idxCity = lower.indexOf('city');
  const idxCountry = lower.indexOf('country');
  if (idxEvent < 0 || idxDate < 0) return null;
  return {
    headers: headerLines,
    map: (cells, defaultYear) => {
      const ev = extractEventLink(cells[idxEvent]);
      return {
        name: ev.name,
        linkTarget: ev.linkTarget,
        date: extractDate(cells[idxDate], defaultYear),
        venue: idxVenue >= 0 ? plainText(cells[idxVenue]) : null,
        city: idxCity >= 0 ? plainText(cells[idxCity]) : null,
        country: idxCountry >= 0 ? plainText(cells[idxCountry]) : null,
      };
    },
  };
}

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

// Parse one wikitext document into raw events. Exported for unit-testing.
function parseYearWikitext(wikitext, promotion) {
  if (!wikitext) return [];
  const sections = ['Past events', 'Scheduled events'];
  const seenKey = new Set();
  const out = [];

  for (const heading of sections) {
    const tables = extractTablesUnderHeading(wikitext, heading);
    for (const table of tables) {
      const layout = detectColumnLayout(table);
      if (!layout) continue;
      const { rows } = parseTableRows(table);
      for (const row of rows) {
        if (row.length === 0) continue;
        const r = layout.map(row);
        if (!r.name || !r.date) continue;

        // Source ID: prefer promotion.shortHandle for stable dedup across
        // year-page moves; fall back to date+slug for un-numbered events
        // like "ONE: Denver".
        let stableId = promotion.shortHandle ? promotion.shortHandle(r.name) : null;
        const sourceId = stableId
          ? slugify(stableId)
          : (r.date + '-' + slugify(r.name));
        if (seenKey.has(sourceId)) continue;
        seenKey.add(sourceId);

        out.push({
          sourceId,
          name: r.name,
          date: r.date,
          venue: r.venue,
          city: r.city,
          country: r.country,
          linkTarget: r.linkTarget || null,
          source: { type: 'wikipedia', section: heading },
        });
      }
    }
  }
  return out;
}

// Years to fetch: derived from the same TSDB_SEASONS env list so all
// promotions stay in sync, with a sensible default. Caller can override
// via opts.seasons.
function defaultYears() {
  const cfg = require('../../config');
  return cfg.tsdb.seasons.slice();
}

async function fetchPageSummary(title, log) {
  const url = 'https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title);
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  } catch (err) {
    log('    summary fetch failed for ' + title + ': ' + err.message);
    return null;
  }
  if (!res.ok) {
    if (res.status !== 404) log('    summary HTTP ' + res.status + ' for ' + title);
    return null;
  }
  let json;
  try { json = await res.json(); } catch (e) { return null; }
  if (json.type === 'disambiguation') return null;
  return {
    image: (json.originalimage && json.originalimage.source) || null,
    thumb: (json.thumbnail && json.thumbnail.source) || null,
    extract: json.extract || null,
  };
}

async function enrichWithSummaries(events, log) {
  const PARALLEL = 4;
  const targets = [];
  for (const ev of events) {
    if (ev.linkTarget) targets.push(ev);
  }
  if (targets.length === 0) {
    log('  (no events with own Wikipedia page - skipping image enrichment)');
    return;
  }
  log('  enriching ' + targets.length + ' events with poster/description');
  let done = 0, withImage = 0;
  for (let i = 0; i < targets.length; i += PARALLEL) {
    const batch = targets.slice(i, i + PARALLEL);
    const summaries = await Promise.all(batch.map((ev) => fetchPageSummary(ev.linkTarget, log)));
    for (let j = 0; j < batch.length; j++) {
      const ev = batch[j];
      const s = summaries[j];
      if (s) {
        if (s.image) { ev.poster = s.image; withImage++; }
        if (s.thumb) ev.thumb = s.thumb;
        if (s.extract) ev.description = s.extract;
      }
      done++;
    }
    await delay(150);
  }
  log('  enriched ' + done + ' events (' + withImage + ' got posters)');
}

async function fetchAll(opts) {
  opts = opts || {};
  const log = opts.log || (() => {});
  const pattern = opts.pattern || 'https://en.wikipedia.org/wiki/{year}_in_ONE_Championship';
  const years = opts.years || opts.seasons || defaultYears();
  const promotion = opts.promotion;
  const enrichImages = opts.enrichImages !== false;

  const all = [];
  const seen = new Set();
  for (const y of years) {
    const url = pattern.replace('{year}', y);
    const title = decodeURIComponent(url.replace(/^https?:\/\/en\.wikipedia\.org\/wiki\//, ''));
    log('-> wikipedia: ' + title);
    let wt;
    try { wt = await fetchWikitext(title, log); }
    catch (err) { log('  ' + title + ' failed: ' + err.message); continue; }
    if (!wt) { log('  ' + title + ' has no content (404 / missing)'); continue; }

    const parsed = parseYearWikitext(wt, promotion || { shortHandle: () => null });
    log('  ' + title + ': ' + parsed.length + ' events parsed');
    for (const ev of parsed) {
      if (seen.has(ev.sourceId)) continue;
      seen.add(ev.sourceId);
      all.push(ev);
    }
    await delay(500);
  }

  if (enrichImages) {
    try { await enrichWithSummaries(all, log); }
    catch (err) { log('  image enrichment failed (continuing without): ' + err.message); }
  }
  return all;
}

module.exports = {
  fetchAll,
  parseYearWikitext,
  extractDate,
  extractEventName,
  extractEventLink,
  parseTableRows,
  detectColumnLayout,
  extractTablesUnderHeading,
  fetchPageSummary,
  enrichWithSummaries,
};
