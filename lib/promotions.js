
// Shared event-scope window. All four promotions use 2026-01-01 as the start
// of the indexed window. End is today+180d so we keep showing 6 months of
// upcoming events. Configurable via the EVENT_WINDOW_START_DATE env if you
// ever want to roll the window forward.
const EVENT_WINDOW_START = process.env.EVENT_WINDOW_START_DATE || '2026-01-01';
function defaultEventScope(ev) {
  if (!ev || !ev.date) return false;
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const ahead = new Date(today); ahead.setUTCDate(ahead.getUTCDate() + 180);
  const aheadIso = ahead.toISOString().slice(0, 10);
  return ev.date >= EVENT_WINDOW_START && ev.date <= aheadIso;
}

// Branded fallback artwork for events without per-event posters (typically
// upcoming events). When PUBLIC_URL is set we serve a clean, centered
// company-logo card from the addon's own /assets path (crops correctly in
// Stremio's landscape tiles). Without PUBLIC_URL we fall back to the
// TheSportsDB league banner, so there's no regression on instances that
// haven't configured a public origin.
const ASSET_BASE = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
function brandedPoster(file, fallbackUrl) {
  return ASSET_BASE ? (ASSET_BASE + '/assets/' + file) : fallbackUrl;
}

// Promotion registry. Each promotion is a self-contained config bundle
// describing how to fetch its events, classify them, build search aliases,
// filter stream candidates, and present catalogs in Stremio.

function isoToday() { return new Date().toISOString().slice(0, 10); }

function genericVsHandle(name) {
  if (!name) return null;
  const m = name.match(
    /([A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+)*)\s+vs\.?\s+([A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+)*)/
  );
  return m ? m[1] + ' vs ' + m[2] : null;
}

// Reject candidate titles whose 4-digit year tokens (1990–2039, avoiding
// hits on 1080/2160 resolution markers) don't match the event's year.
// Used by WWE/AEW where PPV names repeat annually (Backlash 2023 vs 2026).
// Titles without any year token pass — release groups sometimes omit it.
function yearMatchesEvent(title, event) {
  if (!event || !event.date) return true;
  const eventYear = parseInt(event.date.slice(0, 4), 10);
  if (!Number.isFinite(eventYear)) return true;
  const years = title.match(/\b(?:199\d|20[0-3]\d)\b/g);
  if (!years || years.length === 0) return true;
  return years.some((y) => parseInt(y, 10) === eventYear);
}

// ===== UFC =====
const UFC_PPV_RE = /^UFC\s*\d{1,4}(?:[:.\s]|$)/i;
const UFC_FN_RE = /UFC\s*Fight\s*Night/i;
const UFC_ON_RE = /^UFC\s+on\s+(ABC|ESPN|FOX|FX)/i;
const UFC_CONTENDER_RE = /Contender\s*Series/i;

// Same idea as the event classifier above, but applied to a torrent TITLE
// (which has scene-style separators . _ - and may not start with "UFC").
// Used to reject "UFC 276" (numbered PPV) candidates from being matched to
// "UFC Fight Night 276" (different event sharing only the number 276), and
// vice versa. Order matters: check Fight Night before PPV because a fight-
// night title also contains "UFC <digits>".
function ufcTitleType(title) {
  const t = title || '';
  if (/\bUFC[\s._-]*Fight[\s._-]*Night\b/i.test(t)) return 'fight-night';
  if (/\bUFC[\s._-]+on[\s._-]+(?:ABC|ESPN|FOX|FX)\b/i.test(t)) return 'ufc-on-network';
  if (/\bContender[\s._-]*Series\b/i.test(t)) return 'contender-series';
  if (/\bUFC[\s._-]*\d{1,4}\b/i.test(t)) return 'ppv';
  return 'other';
}

const ufc = {
  id: 'ufc',
  name: 'UFC',
  idPrefix: 'ufc',
  enabled: true,
  source: { type: 'thesportsdb', leagueId: '4443' },

  // Stremio's posterShape — landscape for TSDB-sourced (we prefer strThumb).
  posterShape: 'landscape',

  // Static fallback artwork. TSDB often hasn't populated posters for
  // upcoming events; this guarantees Stremio renders a UFC-branded tile
  // rather than a blank.
  defaults: {
    // TSDB-hosted UFC league banner (landscape, UFC-branded) — distinct
    // from the octagon photo used as fanart so the catalog tile doesn't
    // look identical to the meta-page backdrop. WWE/ONE/AEW use the same
    // TSDB-league pattern; this brings UFC in line with them.
    poster: brandedPoster('ufc-upcoming.jpg', 'https://r2.thesportsdb.com/images/media/league/banner/rwyuqv1463908317.jpg'),
    // TSDB CDN art (NOT upload.wikimedia.org — Wikimedia 403s some clients,
    // e.g. Android-TV Nuvio, so its images render broken there).
    fanart: 'https://r2.thesportsdb.com/images/media/league/fanart/vrutwv1463859748.jpg',
    logo:   'https://r2.thesportsdb.com/images/media/league/logo/1gp4vo1722604906.png',
  },

  // Wikipedia page title derived from the event short handle. Used by the
  // post-refresh enrichment pass to pull a poster + summary from Wikipedia
  // when TSDB hasn't populated those fields yet.
  wikipediaTitle(name) {
    const sh = ufc.shortHandle(name);
    return sh ? sh.replace(/\s+/g, '_') : null;
  },

  classify(name) {
    if (!name) return 'other';
    if (UFC_CONTENDER_RE.test(name)) return 'contender-series';
    if (UFC_PPV_RE.test(name)) return 'ppv';
    if (UFC_FN_RE.test(name)) return 'fight-night';
    if (UFC_ON_RE.test(name)) return 'ufc-on-network';
    return 'other';
  },

  shortHandle(name) {
    if (!name) return null;
    let m;
    if ((m = name.match(/^(UFC\s*\d{1,4})\b/i))) return m[1].replace(/\s+/g, ' ').trim();
    if ((m = name.match(/^(UFC\s+Fight\s+Night\s*\d{0,4})\b/i))) return m[1].replace(/\s+/g, ' ').trim();
    if ((m = name.match(/^(UFC\s+on\s+(?:ABC|ESPN|FOX|FX)\s*\d{0,3})\b/i))) return m[1].replace(/\s+/g, ' ').trim();
    return null;
  },

  buildAliases(name) {
    const out = new Set();
    if (!name) return [];
    const t = name.trim();
    out.add(t);
    const sh = ufc.shortHandle(t); if (sh) out.add(sh);
    const vs = genericVsHandle(t); if (vs) out.add(vs);
    out.add(t.replace(/\s+/g, '.'));
    out.add(t.replace(/:/g, ''));
    if (sh && vs) out.add(sh + ' ' + vs);
    return Array.from(out).filter(Boolean);
  },

  isRelevantStreamTitle(title, event) {
    if (!title) return { ok: false, reason: 'no-title' };
    const t = title.toLowerCase();
    if (!t.includes('ufc')) return { ok: false, reason: 'no-ufc' };
    // Disambiguate event type so e.g. "UFC 276" (a 2022 numbered PPV) doesn't
    // match "UFC Fight Night 276" — they happen to share the number "276" but
    // are different events. Both event sides must be a known type for the
    // check to bite (lenient on 'other').
    const eventType = ufc.classify(event.name || '');
    const titleType = ufcTitleType(title);
    const known = new Set(['ppv', 'fight-night', 'ufc-on-network', 'contender-series']);
    if (known.has(eventType) && known.has(titleType) && eventType !== titleType) {
      return { ok: false, reason: 'wrong-event-type(' + titleType + '≠' + eventType + ')' };
    }
    const m = (event.name || '').toLowerCase().match(/ufc\s*(?:fight\s*night\s*)?(\d{1,4})/);
    if (m && !t.includes(m[1])) return { ok: false, reason: 'wrong-event-number' };
    return { ok: true };
  },

  catalogs: [
    { id: 'ufc-upcoming', name: 'UFC Upcoming',
      filter: (ev) => ev.date && ev.date > isoToday(),
      sort: (a, b) => (a.date || '').localeCompare(b.date || '') },
    { id: 'ufc-recent', name: 'UFC Recent',
      filter: (ev) => ev.date && ev.date <= isoToday(),
      sort: (a, b) => (b.date || '').localeCompare(a.date || '') },
  ],

  eventScope: defaultEventScope,

  includeEvent(ev, config) {
    if (!config.includeContenderSeries && ev.kind === 'contender-series') return false;
    // Road to UFC is a regional developmental series, not a main-roster UFC
    // event — keep it out of the UFC catalog.
    if (/road\s*to\s*ufc/i.test(ev.name || '')) return false;
    return true;
  },

  genres(ev) {
    const g = ['Sports', 'MMA', 'UFC'];
    if (ev.kind === 'ppv') g.push('PPV');
    if (ev.kind === 'fight-night') g.push('Fight Night');
    return g;
  },
};

// ===== ONE Championship =====
const one = {
  id: 'one',
  name: 'ONE Championship',
  idPrefix: 'one',
  enabled: true,
  source: {
    // Authoritative feed: watch.onefc.com (Next.js SSR data endpoint).
    // The Wikipedia year-page parser is still available as a fallback —
    // promotion.wikipediaTitle drives the post-refresh description
    // enrichment, so per-event Wikipedia summaries are still pulled.
    type: 'onefc',
  },

  // ONE FC banners are landscape (Cloudinary 16:9-ish).
  posterShape: 'landscape',

  defaults: {
    poster: 'https://r2.thesportsdb.com/images/media/league/banner/wsvtvu1422290020.jpg',
    fanart: 'https://r2.thesportsdb.com/images/media/league/fanart/m4f49k1622281416.jpg',
    logo:   'https://r2.thesportsdb.com/images/media/league/badge/4cem2k1619616539.png',
  },

  wikipediaTitle(name) {
    const sh = one.shortHandle(name);
    return sh ? sh.replace(/\s+/g, '_') : null;
  },

  classify(name) {
    if (!name) return 'other';
    if (/Friday\s*Fights/i.test(name)) return 'friday-fights';
    if (/Fight\s*Night/i.test(name)) return 'fight-night';
    if (/^ONE\s*(Championship\s*)?\d{1,4}\b/i.test(name)) return 'numbered';
    return 'other';
  },

  shortHandle(name) {
    if (!name) return null;
    let m;
    if ((m = name.match(/^(ONE\s*(?:Championship\s*)?\d{1,4})\b/i))) return m[1].replace(/\s+/g, ' ').trim();
    if ((m = name.match(/^(ONE\s+Fight\s+Night\s*\d{0,4})\b/i))) return m[1].replace(/\s+/g, ' ').trim();
    if ((m = name.match(/^(ONE\s+Friday\s+Fights\s*\d{0,4})\b/i))) return m[1].replace(/\s+/g, ' ').trim();
    return null;
  },

  buildAliases(name) {
    const out = new Set();
    if (!name) return [];
    const t = name.trim();
    // Drop any "& The Inner Circle" sub-card label that ONE FC appends to
    // some Friday Fights — release groups don't include it.
    const tClean = t.replace(/\s*&\s*The\s+Inner\s+Circle\s*$/i, '').trim();
    out.add(tClean);
    const sh = one.shortHandle(tClean); if (sh) out.add(sh);
    const vs = genericVsHandle(tClean); if (vs) out.add(vs);
    out.add(tClean.replace(/\s+/g, '.'));
    out.add(tClean.replace(/:/g, ''));

    // Numbered events (ONE 173, ONE Championship 173)
    const numbered = tClean.match(/^ONE\s+(?:Championship\s+)?(\d{1,4})\b/i);
    if (numbered) {
      out.add('ONE FC ' + numbered[1]);
      out.add('ONE.FC.' + numbered[1]);
      out.add('ONE Championship ' + numbered[1]);
    }

    // Fight Night — release groups commonly use ONE.FN.43 / ONE.FightNight.43
    const fn = tClean.match(/^ONE\s+Fight\s+Night\s+(\d{1,4})\b/i);
    if (fn) {
      out.add('ONE FN ' + fn[1]);
      out.add('ONE.FN.' + fn[1]);
      out.add('ONE.FightNight.' + fn[1]);
      out.add('ONE FightNight ' + fn[1]);
    }

    // Friday Fights — release groups use ONE.FF.137 / ONE.FridayFights.137
    const ff = tClean.match(/^ONE\s+Friday\s+Fights\s+(\d{1,4})\b/i);
    if (ff) {
      out.add('ONE FF ' + ff[1]);
      out.add('ONE.FF.' + ff[1]);
      out.add('ONE.FridayFights.' + ff[1]);
      out.add('ONE FridayFights ' + ff[1]);
      // Some release groups prefix the full promotion name, e.g.
      // "One Championship ONE Friday Fights 155 ...".
      out.add('ONE Championship Friday Fights ' + ff[1]);
    }

    if (sh && vs) out.add(sh + ' ' + vs);
    return Array.from(out).filter(Boolean);
  },

  isRelevantStreamTitle(title, event) {
    if (!title) return { ok: false, reason: 'no-title' };
    const t = title.toLowerCase();
    // Accept ONE context including scene abbreviations (FN, FF, FC) and
    // ONE sub-brands: Samurai, Lumpinee, Hero. Numeric suffixes
    // (`ONE 173`, `ONE.Samurai.1`) also count as context. The event-number
    // check below filters out any false positives that slip through.
    if (!/\bone[\s.\-_]+(fc|championship|fight[\s.\-_]*night|friday[\s.\-_]*fights|fn|ff|fightnight|fridayfights|samurai|lumpinee|hero|warrior|\d)/i.test(title)) {
      return { ok: false, reason: 'no-one-context' };
    }
    // Event number is a strong signal — accept 1+ digits since some series
    // (ONE Samurai 1) start at 1.
    const m = (event.name || '').match(/\b(\d{1,4})\b/);
    if (m && !t.includes(m[1])) return { ok: false, reason: 'wrong-event-number' };
    return { ok: true };
  },

  catalogs: [
    { id: 'one-upcoming', name: 'ONE Upcoming',
      filter: (ev) => ev.date && ev.date > isoToday(),
      sort: (a, b) => (a.date || '').localeCompare(b.date || '') },
    { id: 'one-recent', name: 'ONE Recent',
      filter: (ev) => ev.date && ev.date <= isoToday(),
      sort: (a, b) => (b.date || '').localeCompare(a.date || '') },
  ],

  eventScope: defaultEventScope,

  includeEvent(ev) { return true; },
  genres(ev) {
    const g = ['Sports', 'MMA', 'ONE'];
    if (ev.kind === 'numbered') g.push('Numbered');
    if (ev.kind === 'fight-night') g.push('Fight Night');
    if (ev.kind === 'friday-fights') g.push('Friday Fights');
    return g;
  },
};

// ===== WWE (PPVs / Premium Live Events, including NXT-branded) =====
const wwe = {
  id: 'wwe',
  name: 'WWE',
  idPrefix: 'wwe',
  enabled: true,
  source: { type: 'thesportsdb', leagueId: '4444' },

  // TSDB strThumb is landscape; we prefer it for the poster field.
  posterShape: 'landscape',

  // TSDB-hosted WWE league art (verified reachable). Landscape banner +
  // fanart used as default poster/fanart so blank events fall back to art
  // that matches the catalog's landscape shape.
  defaults: {
    poster: brandedPoster('wwe-upcoming.jpg', 'https://r2.thesportsdb.com/images/media/league/banner/ie9cfu1485811161.jpg'),
    fanart: 'https://r2.thesportsdb.com/images/media/league/fanart/rpvvrr1448285329.jpg',
    logo:   'https://r2.thesportsdb.com/images/media/league/badge/ywtxyv1453504109.png',
  },

  wikipediaTitle(name) { return null; },

  classify(name) {
    if (!name) return 'other';
    if (/^WrestleMania\b/i.test(name)) return 'mania';
    if (/^Royal\s*Rumble\b/i.test(name)) return 'royal-rumble';
    if (/^SummerSlam\b/i.test(name)) return 'summerslam';
    if (/^Survivor\s*Series\b/i.test(name)) return 'survivor-series';
    if (/Vengeance\s*Day|Stand\s*&\s*Deliver|Battleground|Halloween\s*Havoc|Heatwave|No\s*Mercy|Roadblock|Spring\s*Breakin|TakeOver/i.test(name)) return 'nxt';
    return 'ple';
  },

  shortHandle(name) { return name ? name.trim().replace(/\s+/g, ' ') : null; },

  buildAliases(name) {
    if (!name) return [];
    const out = new Set();
    const t = name.trim();
    out.add(t);
    out.add(t.replace(/\s+/g, '.'));
    out.add('WWE ' + t);
    out.add('WWE.' + t.replace(/\s+/g, '.'));
    return Array.from(out).filter(Boolean);
  },

  isRelevantStreamTitle(title, event) {
    if (!title) return { ok: false, reason: 'no-title' };
    const t = title.toLowerCase();
    if (!/\b(wwe|nxt)\b/i.test(title)) return { ok: false, reason: 'no-wwe-context' };
    const eventName = (event.name || '').toLowerCase();
    const tokens = eventName.split(/\s+/).filter((x) => x.length >= 4);
    if (tokens.length === 0) return { ok: true };
    const hits = tokens.filter((tok) => t.includes(tok));
    if (hits.length === 0) return { ok: false, reason: 'no-event-name-overlap' };
    // Edition number: "WrestleMania 42" must NOT match WrestleMania 40 / 35 /
    // Anthology, all of which contain the word "wrestlemania". Require the
    // event's edition number as a standalone token in the title. Only a 1–3
    // digit number counts as an edition (4-digit numbers are years, handled
    // below). Skip Saturday Night's Main Event — those rips are titled by air
    // date, not by the event number, so a number check would wrongly reject
    // them (their date-based queries handle matching instead).
    const isSNME = /saturday\s*night.?s?\s*main\s*event/i.test(event.name || '');
    if (!isSNME) {
      const editionMatch = (event.name || '').match(/\b(\d{1,3})\b/);
      if (editionMatch) {
        const n = editionMatch[1];
        if (!new RegExp('\\b' + n + '\\b').test(title)) {
          return { ok: false, reason: 'wrong-event-number' };
        }
      }
    }
    // WWE PPV names repeat annually (Backlash 2023 vs 2026 etc.) — reject
    // candidates whose year token doesn't match the event's year.
    if (!yearMatchesEvent(title, event)) return { ok: false, reason: 'wrong-year' };
    return { ok: true };
  },

  catalogs: [
    { id: 'wwe-upcoming', name: 'WWE Upcoming',
      filter: (ev) => ev.date && ev.date > isoToday(),
      sort: (a, b) => (a.date || '').localeCompare(b.date || '') },
    { id: 'wwe-recent', name: 'WWE Recent',
      filter: (ev) => ev.date && ev.date <= isoToday(),
      sort: (a, b) => (b.date || '').localeCompare(a.date || '') },
  ],

  eventScope: defaultEventScope,

  // TSDB league 4444 mixes WWE PPVs with weekly TV. Drop names that look
  // like a weekly episode of RAW/SmackDown/Main Event/EVOLVE/LFG, and
  // numbered NXT episodes — but KEEP named NXT events (Vengeance Day,
  // Stand & Deliver, etc.) and Saturday Night's Main Event PLEs.
  includeEvent(ev) {
    const n = (ev.name || '').trim();
    if (/^Saturday\s*Night/i.test(n)) return true;          // PLE, keep
    if (/^NXT\s*#\d/i.test(n)) return false;                // numbered NXT = weekly
    if (/^(RAW|SmackDown|Main\s*Event|EVOLVE|LFG)\b/i.test(n)) return false;
    if (/^World\s*At\s*WrestleMania/i.test(n)) return false; // panel/recap show
    if (/^(NXT\s*)?Countdown\s*To\b/i.test(n)) return false; // pre-show countdown
    return true;
  },
  genres(ev) {
    const g = ['Sports', 'Wrestling', 'WWE'];
    if (ev.kind === 'nxt') g.push('NXT');
    if (ev.kind === 'mania') g.push('WrestleMania');
    return g;
  },
};

const aew = {
  id: 'aew',
  name: 'AEW',
  idPrefix: 'aew',
  enabled: true,
  source: { type: 'thesportsdb', leagueId: '4563' },

  // TSDB strThumb is landscape; we prefer it for the poster field.
  posterShape: 'landscape',

  // TSDB-hosted AEW league art (verified reachable). The previous Wikipedia
  // SVG-derived URL returned 404, leaving Upcoming tiles blank.
  defaults: {
    poster: 'https://r2.thesportsdb.com/images/media/league/banner/brkflv1574635493.jpg',
    fanart: 'https://r2.thesportsdb.com/images/media/league/fanart/sw5kmu1582130686.jpg',
    logo:   'https://r2.thesportsdb.com/images/media/league/badge/zb3zn01708517335.png',
  },

  wikipediaTitle(name) { return null; },
  classify(name) { return 'ppv'; },
  shortHandle(name) { return name ? name.trim().replace(/\s+/g, ' ') : null; },

  buildAliases(name) {
    if (!name) return [];
    const out = new Set();
    const t = name.trim();
    out.add(t);
    out.add(t.replace(/\s+/g, '.'));
    out.add('AEW ' + t);
    out.add('AEW.' + t.replace(/\s+/g, '.'));
    return Array.from(out).filter(Boolean);
  },

  isRelevantStreamTitle(title, event) {
    if (!title) return { ok: false, reason: 'no-title' };
    const t = title.toLowerCase();
    if (!/\baew\b/i.test(title)) return { ok: false, reason: 'no-aew-context' };
    const eventName = (event.name || '').toLowerCase();
    const tokens = eventName.split(/\s+/).filter((x) => x.length >= 4);
    if (tokens.length === 0) return { ok: true };
    const hits = tokens.filter((tok) => t.includes(tok));
    if (hits.length === 0) return { ok: false, reason: 'no-event-name-overlap' };
    // AEW PPV names repeat annually (Revolution, Double or Nothing, etc.).
    // Reject candidates whose year token doesn't match the event's year.
    if (!yearMatchesEvent(title, event)) return { ok: false, reason: 'wrong-year' };
    return { ok: true };
  },

  catalogs: [
    { id: 'aew-upcoming', name: 'AEW Upcoming',
      filter: (ev) => ev.date && ev.date > isoToday(),
      sort: (a, b) => (a.date || '').localeCompare(b.date || '') },
    { id: 'aew-recent', name: 'AEW Recent',
      filter: (ev) => ev.date && ev.date <= isoToday(),
      sort: (a, b) => (b.date || '').localeCompare(a.date || '') },
  ],

  eventScope: defaultEventScope,

  // TSDB league 4563 mixes AEW PPVs with weekly TV (Dynamite, Collision,
  // Rampage). Drop those — keep PPVs (Revolution, Dynasty, Double or
  // Nothing, Forbidden Door, All In, etc.) and specials.
  includeEvent(ev) {
    const n = (ev.name || '').trim();
    if (/^(Dynamite|Collision|Rampage|Battle\s+of\s+the\s+Belts)\b/i.test(n)) return false;
    return true;
  },
  genres(ev) { return ['Sports', 'Wrestling', 'AEW']; },
};

// ===== Formula 1 =====
// TheSportsDB splits a Grand Prix weekend into separate events: Practice 1/2/3,
// Qualifying, Sprint Qualifying, Sprint, and the Race (plus pre-season Testing).
// We surface EACH session as its own catalog item and match the corresponding
// release — scene F1 rips are per-session, e.g.
//   Formula.1.2026x34.R05.CanadianGP.Race.MULTi.1080p
//   Formula.1.2026x33.R05.CanadianGP.Qualifying.F1TV.1080p
//   Formula.1.2026x32.R05.CanadianGP.Sprint.MULTi.1080p
//   Formula.1.2026x31.R05.CanadianGP.Sprint.Qualification.F1TV.1080p

function f1Location(name) {
  // GP name minus "Grand Prix" and any trailing session words.
  return (name || '')
    .replace(/\bgrand\s*prix\b.*$/i, '')
    .replace(/\bf1\b|\bformula\s*1\b/i, '')
    .trim();
}

// Which session a TSDB event represents (from its name).
function f1Session(name) {
  const n = (name || '').toLowerCase();
  if (/testing|pre[\s-]*season/.test(n)) return 'testing';
  if (/sprint[\s.\-_]*(qualifying|qualification|shootout)/.test(n)) return 'sprint-qualifying';
  if (/\bsprint\b/.test(n)) return 'sprint';
  if (/qualifying|qualification|\bquali\b/.test(n)) return 'qualifying';
  if (/practice|free[\s.\-_]*practice|\bfp[1-3]\b/.test(n)) return 'practice';
  return 'race';
}

// Which session a candidate release title represents.
function f1TitleSession(title) {
  const t = (title || '').toLowerCase();
  const sprint = /\bsprint\b/.test(t);
  const quali = /qualif/.test(t);
  if (sprint && quali) return 'sprint-qualifying';
  if (sprint) return 'sprint';
  if (quali) return 'qualifying';
  if (/\bpractice\b|free[\s.\-_]*practice|\bfp[1-3]\b/.test(t)) return 'practice';
  if (/\brace\b/.test(t)) return 'race';
  return 'unlabelled';
}

const F1_SESSION_LABEL = {
  race: 'Race', qualifying: 'Qualifying', sprint: 'Sprint',
  'sprint-qualifying': 'Sprint Qualifying', practice: 'Practice',
};

const f1 = {
  id: 'f1',
  name: 'Formula 1',
  idPrefix: 'f1',
  enabled: true,
  source: { type: 'thesportsdb', leagueId: '4370' },
  posterShape: 'landscape',
  // F1 ships a clean 16:9 per-session thumb (labelled circuit card: round,
  // country, session, date, circuit) — use it. Fall back to the branded F1
  // card for events with no thumb yet. (The wide GP-name banners that crop are
  // strFanart/strBanner, which preferThumb skips.)
  preferThumb: true,

  defaults: {
    poster: brandedPoster('f1-upcoming.jpg', 'https://r2.thesportsdb.com/images/media/league/banner/srsuyy1421852767.jpg'),
    fanart: 'https://r2.thesportsdb.com/images/media/league/fanart/hreocd1620552411.jpg',
    logo:   'https://r2.thesportsdb.com/images/media/league/logo/jiqa741556460666.png',
  },

  wikipediaTitle(name) { return null; },

  classify(name) { return f1Session(name); },

  shortHandle(name) { return name ? name.trim().replace(/\s+/g, ' ') : null; },

  buildAliases(name) {
    if (!name) return [];
    const out = new Set();
    const t = name.trim();
    const loc = f1Location(t);
    const after = t.replace(/^.*\bgrand\s*prix\b/i, '').replace(/\s+/g, ' ').trim();
    out.add(t);
    out.add('F1 ' + t);
    out.add('Formula 1 ' + t);
    if (loc) {
      out.add(('F1 ' + loc + ' GP ' + after).trim());
      out.add(('Formula 1 ' + loc + ' Grand Prix ' + after).trim());
      out.add((loc.replace(/\s+/g, '') + 'GP ' + after).trim());
    }
    return Array.from(out).filter(Boolean);
  },

  isRelevantStreamTitle(title, event) {
    if (!title) return { ok: false, reason: 'no-title' };
    if (!/\b(f1|formula\s*1|formula1|formula\.1)\b/i.test(title)) {
      return { ok: false, reason: 'no-f1-context' };
    }
    const t = title.toLowerCase();
    // Event match: round (R05 / Round 5) or location stem.
    const round = event.round ? String(parseInt(event.round, 10)) : '';
    const roundOk = !!round && new RegExp('(?:\\br|round)[\\s._-]*0*' + round + '\\b', 'i').test(title);
    const loc = f1Location(event.name || '').toLowerCase().replace(/\s+/g, '');
    const locStem = loc.replace(/(ese|ian|ish|an|n)$/, '').slice(0, 6);
    const locOk = locStem.length >= 4 && t.replace(/\s+/g, '').includes(locStem);
    if (!roundOk && !locOk) return { ok: false, reason: 'no-event-match' };
    if (!yearMatchesEvent(title, event)) return { ok: false, reason: 'wrong-year' };
    // Session must match the specific session this catalog item represents.
    const want = f1Session(event.name);
    const got = f1TitleSession(title);
    if (want === 'race') {
      if (got !== 'race' && got !== 'unlabelled') return { ok: false, reason: 'session(' + got + '≠race)' };
    } else if (got !== want) {
      return { ok: false, reason: 'session(' + got + '≠' + want + ')' };
    }
    return { ok: true };
  },

  catalogs: [
    // Upcoming = the main Race only, so the "what's next" view isn't cluttered
    // with every practice/qualifying session of future weekends.
    { id: 'f1-upcoming', name: 'F1 Upcoming',
      filter: (ev) => f1Session(ev.name) === 'race' && ev.date && ev.date > isoToday(),
      sort: (a, b) => (a.date || '').localeCompare(b.date || '') },
    // One catalog per session stage — completed sessions (today or earlier),
    // newest first.
    { id: 'f1-race', name: 'F1 Race',
      filter: (ev) => f1Session(ev.name) === 'race' && ev.date && ev.date <= isoToday(),
      sort: (a, b) => (b.date || '').localeCompare(a.date || '') },
    { id: 'f1-qualifying', name: 'F1 Qualifying',
      filter: (ev) => f1Session(ev.name) === 'qualifying' && ev.date && ev.date <= isoToday(),
      sort: (a, b) => (b.date || '').localeCompare(a.date || '') },
    { id: 'f1-sprint', name: 'F1 Sprint',
      filter: (ev) => f1Session(ev.name) === 'sprint' && ev.date && ev.date <= isoToday(),
      sort: (a, b) => (b.date || '').localeCompare(a.date || '') },
    { id: 'f1-sprint-qualifying', name: 'F1 Sprint Qualifying',
      filter: (ev) => f1Session(ev.name) === 'sprint-qualifying' && ev.date && ev.date <= isoToday(),
      sort: (a, b) => (b.date || '').localeCompare(a.date || '') },
    { id: 'f1-practice', name: 'F1 Practice',
      filter: (ev) => f1Session(ev.name) === 'practice' && ev.date && ev.date <= isoToday(),
      sort: (a, b) => (b.date || '').localeCompare(a.date || '') },
  ],

  eventScope: defaultEventScope,

  // Keep every session of a race weekend (Practice/Qualifying/Sprint/Race);
  // drop only pre-season Testing.
  includeEvent(ev) {
    return !/testing|pre[\s-]*season/i.test((ev.name || '').trim());
  },

  genres(ev) {
    const g = ['Sports', 'Motorsport', 'Formula 1'];
    const label = F1_SESSION_LABEL[f1Session(ev.name)];
    if (label) g.push(label);
    return g;
  },
};

// ===== Boxing (0.23.0) =====
// TheSportsDB league 4445 — sport "Fighting", league "Boxing". A single
// catch-all bucket for big PPV cards from all promoters (Top Rank, PBC,
// Matchroom, MVPW, etc). Event names are typically "Promoter NN Fighter vs
// Fighter" or just "Fighter vs Fighter". Release titles are fighter-name-
// based and rarely contain the word "boxing", so relevance keys off the
// surnames extracted from the matchup rather than a "boxing" keyword.

// Extract the "Fighter vs Fighter" core of a boxing event name. Handles
// "MVPW 03 Han vs Holm 2" → { left: 'Han', right: 'Holm' }, and plain
// "Crawford vs Spence" → { left: 'Crawford', right: 'Spence' }. Returns null
// if no matchup pattern is found.
function boxingMatchup(name) {
  if (!name) return null;
  const m = String(name).match(/([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’-]{1,})\s+(?:vs?\.?|v)\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’-]{1,})/i);
  if (!m) return null;
  return { left: m[1], right: m[2] };
}

const boxing = {
  id: 'boxing',
  name: 'Boxing',
  idPrefix: 'boxing',
  enabled: true,
  source: { type: 'thesportsdb', leagueId: '4445' },

  // TSDB-hosted Boxing league art (verified via lookupleague.php?id=4445).
  posterShape: 'landscape',
  // Boxing per-event TSDB posters/thumbs are fighter portraits cropped to
  // various aspect ratios — they tile badly in Nuvio. Use the promotion's
  // branded default for every event instead (same approach as F1 in 0.20.3).
  // The TSDB league banner is clean landscape art that works for every card.
  useDefaultArt: true,
  defaults: {
    poster: 'https://r2.thesportsdb.com/images/media/league/banner/elgm6k1529663063.jpg',
    fanart: 'https://r2.thesportsdb.com/images/media/league/fanart/xcz8th1503953153.jpg',
    logo:   'https://r2.thesportsdb.com/images/media/league/badge/6enin21740228549.png',
  },

  wikipediaTitle(name) { return null; },
  classify(name) { return 'fight-card'; },
  shortHandle(name) { return name ? name.trim().replace(/\s+/g, ' ') : null; },

  buildAliases(name) {
    if (!name) return [];
    const out = new Set();
    const t = name.trim();
    out.add(t);
    out.add(t.replace(/\s+/g, '.'));
    // Just the matchup, stripping any promoter prefix ("MVPW 03 Han vs Holm 2"
    // → "Han vs Holm 2"). Release groups usually drop the promoter tag.
    const m = boxingMatchup(t);
    if (m) {
      // Capture the matchup and any trailing "2" / "II" sequel marker.
      const after = t.match(/[A-Za-z][A-Za-z'’-]+\s+(?:vs?\.?|v)\s+[A-Za-z][A-Za-z'’-]+(?:\s+\S+)?/i);
      if (after) {
        out.add(after[0]);
        out.add(after[0].replace(/\s+/g, '.'));
      }
      out.add(m.left + ' vs ' + m.right);
      out.add(m.left + '.vs.' + m.right);
      out.add(m.left + ' v ' + m.right);
    }
    return Array.from(out).filter(Boolean);
  },

  isRelevantStreamTitle(title, event) {
    if (!title) return { ok: false, reason: 'no-title' };
    const t = title.toLowerCase();
    // Require BOTH fighter surnames (when extractable) — the strongest signal
    // for a boxing release. Without a parseable matchup, fall back to a
    // generic event-name-overlap check.
    const m = boxingMatchup(event.name || '');
    if (m) {
      const left = m.left.toLowerCase(), right = m.right.toLowerCase();
      if (!t.includes(left) || !t.includes(right)) {
        return { ok: false, reason: 'missing-fighter-name' };
      }
    } else {
      const tokens = (event.name || '').toLowerCase().split(/\s+/).filter((x) => x.length >= 4);
      const hits = tokens.filter((tok) => t.includes(tok));
      if (tokens.length > 0 && hits.length === 0) {
        return { ok: false, reason: 'no-event-name-overlap' };
      }
    }
    // Boxing matchups recur (rematches, anniversary fights). Reject candidates
    // whose year token doesn't match the event's year.
    if (!yearMatchesEvent(title, event)) return { ok: false, reason: 'wrong-year' };
    return { ok: true };
  },

  catalogs: [
    { id: 'boxing-upcoming', name: 'Boxing Upcoming',
      filter: (ev) => ev.date && ev.date > isoToday(),
      sort: (a, b) => (a.date || '').localeCompare(b.date || '') },
    { id: 'boxing-recent', name: 'Boxing Recent',
      filter: (ev) => ev.date && ev.date <= isoToday(),
      sort: (a, b) => (b.date || '').localeCompare(a.date || '') },
  ],

  eventScope: defaultEventScope,

  // TSDB's Boxing league includes amateur / undercard events alongside the
  // headline cards. Drop anything explicitly tagged as undercard/prelim or
  // press-conference; keep everything else and let relevance filter further.
  includeEvent(ev) {
    const n = (ev.name || '').trim();
    if (/\b(undercard|press[\s-]*conf|weigh[\s-]*in|workout)\b/i.test(n)) return false;
    return true;
  },

  genres(ev) { return ['Sports', 'Boxing']; },
};

const all = [ufc, one, wwe, aew, f1, boxing];
const enabled = all.filter((p) => p.enabled);
const byPrefix = Object.fromEntries(enabled.map((p) => [p.idPrefix, p]));

function getByEventId(eventId) {
  if (!eventId || typeof eventId !== 'string') return null;
  const idx = eventId.indexOf(':');
  if (idx === -1) return null;
  return byPrefix[eventId.slice(0, idx)] || null;
}

module.exports = { all, enabled, byPrefix, getByEventId };
