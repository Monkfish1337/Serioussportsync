
const teamIdentities = require('./team-identities');

// Shared event-scope window. All promotions use 2025-01-01 as the start
// of the indexed window. End is today+180d so we keep showing 6 months of
// upcoming events. 2025 is chosen because Usenet retention is multi-year —
// older PPV / Fight Night / WrestleMania / boxing / F1 / ONE rips remain
// accessible through indexers long after broadcast. Configurable via the
// EVENT_WINDOW_START_DATE env if you want to roll the window forward.
const EVENT_WINDOW_START = process.env.EVENT_WINDOW_START_DATE || '2025-01-01';
function defaultEventScope(ev) {
  if (!ev || !ev.date) return false;
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const ahead = new Date(today); ahead.setUTCDate(ahead.getUTCDate() + 180);
  const aheadIso = ahead.toISOString().slice(0, 10);
  return ev.date >= EVENT_WINDOW_START && ev.date <= aheadIso;
}

// Branded fallback artwork for events without per-event posters (typically
// upcoming events). When PUBLIC_URL is set AND the named file actually
// exists in public/, we serve a clean, centered company-logo card from the
// addon's own /assets path (crops correctly in landscape tiles). Otherwise
// — no PUBLIC_URL, or no asset file present — we fall back to whatever URL
// the promotion supplied. 0.25.0: added the file-exists check; before, the
// addon would point at /assets/<missing>.jpg and the client would 404,
// leaving the tile blank or rendering the wide TSDB banner from elsewhere
// and cropping it badly (boxing was hit by this).
const fsCheck = require('fs');
const pathCheck = require('path');
// 0.35.0: admin-editable matching overrides. Hot-reloaded on save by the
// /admin/match-editor route; consumed wherever per-promotion alias/noise
// tables are looked up (currently MotoGP location aliases; more to follow).
const matchOverrides = require('./match-overrides');
const promotionRuleTools = require('./promotion-aliases');
const promotionOverrides = require('./promotion-overrides');
const PUBLIC_DIR = pathCheck.join(__dirname, '..', 'public');
const ASSET_BASE = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
function brandedPoster(file, fallbackUrl) {
  if (!ASSET_BASE) return fallbackUrl;
  try {
    if (fsCheck.existsSync(pathCheck.join(PUBLIC_DIR, file))) {
      return ASSET_BASE + '/assets/' + file;
    }
  } catch (e) { /* fall through */ }
  return fallbackUrl;
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
//
// 0.42.3 — TIGHTENED. Removed the "year - 1" leniency that was letting
// wrong-year football matches through (2025-05-24 Man City vs Villa release
// masquerading as 2026 fixture). Season notation (2025-26) still matches
// via the fullSeasonRe branch. For football events specifically, use
// `dateMatchesEvent` on top of this — the year check is a fallback for
// non-dated titles.
function yearMatchesEvent(title, event) {
  if (!event || !event.date) return true;
  const eventYear = parseInt(event.date.slice(0, 4), 10);
  if (!Number.isFinite(eventYear)) return true;

  // Season notation: YYYY-YY, YYYY/YYYY or YYYY-YYYY. Range brackets the
  // event year. Basketball releases commonly use the full `2025-2026` form.
  const fullSeasonRe = /\b(19|20)(\d{2})[-/](?:(19|20))?(\d{2})\b/g;
  let m;
  while ((m = fullSeasonRe.exec(title)) !== null) {
    const startYear = parseInt(m[1] + m[2], 10);
    const endYearShort = parseInt(m[4], 10);
    const endCentury = m[3] ? parseInt(m[3], 10) : parseInt(m[1], 10);
    const endYear = endCentury * 100 + endYearShort;
    if (eventYear === startYear || eventYear === endYear) return true;
  }

  // Short-form YY-YY (e.g. "24-25")
  const shortSeasonRe = /\b(\d{2})[-/](\d{2})\b/g;
  const eventYearShort = eventYear % 100;
  while ((m = shortSeasonRe.exec(title)) !== null) {
    const startShort = parseInt(m[1], 10);
    const endShort = parseInt(m[2], 10);
    if (eventYearShort === startShort || eventYearShort === endShort) return true;
  }

  const years = title.match(/\b(?:199\d|20[0-3]\d)\b/g);
  if (!years || years.length === 0) return true;
  return years.some((y) => parseInt(y, 10) === eventYear);
}

// 0.42.3 — Date-based match for football promotions.
//
// Football releases essentially always include YYYY.MM.DD (or a permutation)
// in the title — that's the canonical way scene groups identify a specific
// fixture:
//   EPL.2026.05.24.Manchester.City.vs.Aston.Villa.1080p
//   BWSL.2024.05.18.Aston.Villa.vs.Manchester.City
//   UEFA.Champions.League.2022.09.06.Group.Stage.Sevilla.Vs.Man.City
//
// This helper extracts the date and compares it to event.date. Returns:
//   'match'      — the title's date is within ±1 day of the event date
//   'wrong-date' — the title has a date but it's not the fixture date
//   'none'       — no date found in the title (caller decides fallback)
//
// Both YYYY-MM-DD (ISO) and DD-MM-YYYY (European scene style) are recognised.
// Separator can be ".", "-", "_", or " ".
const DATE_YMD_RE = /(?<![0-9])(20\d{2})[.\-_ ](\d{1,2})[.\-_ ](\d{1,2})(?![0-9])/g;
const DATE_DMY_RE = /(?<![0-9])(\d{1,2})[.\-_ ](\d{1,2})[.\-_ ](20\d{2})(?![0-9])/g;
const DATE_DMY_SHORT_RE = /(?<![0-9])(\d{1,2})[.\-_](\d{1,2})[.\-_](\d{2})(?![0-9])/g;

function extractReleaseDates(title) {
  const found = [];
  let m;

  // YMD form (most common in scene releases)
  DATE_YMD_RE.lastIndex = 0;
  while ((m = DATE_YMD_RE.exec(title)) !== null) {
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const d = parseInt(m[3], 10);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      found.push({ y, mo, d });
    }
  }

  // DMY form — European scene sometimes uses "18.05.2024" style
  DATE_DMY_RE.lastIndex = 0;
  while ((m = DATE_DMY_RE.exec(title)) !== null) {
    const d = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const y = parseInt(m[3], 10);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      found.push({ y, mo, d });
    }
  }
  // Older sports releases commonly use DD.MM.YY (for example 21.07.18).
  // Requiring punctuation separators avoids interpreting scores as dates.
  DATE_DMY_SHORT_RE.lastIndex = 0;
  while ((m = DATE_DMY_SHORT_RE.exec(title)) !== null) {
    const d = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const shortYear = parseInt(m[3], 10);
    const y = shortYear <= 39 ? 2000 + shortYear : 1900 + shortYear;
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) found.push({ y, mo, d });
  }

  return found;
}

function dateMatchesEvent(title, event) {
  if (!event || !event.date) return 'none';
  const [ey, em, ed] = event.date.split('-').map((s) => parseInt(s, 10));
  if (!Number.isFinite(ey) || !Number.isFinite(em) || !Number.isFinite(ed)) return 'none';
  const eventDay = Date.UTC(ey, em - 1, ed);
  const dates = extractReleaseDates(title);
  if (dates.length === 0) return 'none';
  for (const dt of dates) {
    const day = Date.UTC(dt.y, dt.mo - 1, dt.d);
    const diffDays = Math.abs((day - eventDay) / (1000 * 60 * 60 * 24));
    if (diffDays <= 1) return 'match';   // ±1 day tolerance for TZ / kickoff-crossing-midnight
  }
  return 'wrong-date';
}

// ===== UFC =====
const UFC_PPV_RE = /^UFC\s*\d{1,4}(?:[:.\s]|$)/i;
const UFC_FN_RE = /UFC\s*Fight\s*Night/i;
const UFC_ON_RE = /^UFC\s+on\s+(ABC|ESPN|FOX|FX)/i;
const UFC_CONTENDER_RE = /Contender\s*Series/i;
// 0.33.6: branded numbered PPV pattern — "UFC Freedom 250 Topuria vs Gaethje".
// UFC has started using a subtitle word between "UFC" and the event number on
// some PPVs (TSDB now lists "UFC Freedom 250 …" rather than "UFC 250: …"), and
// release groups follow suit ("UFC.Freedom.250.Topuria.vs.Gaethje.PPV…"). The
// negative lookahead skips known prefixes (Fight, on, Contender) so those keep
// being handled by their own classifiers below.
const UFC_BRANDED_PPV_RE = /^UFC\s+(?!(?:Fight|on|Contender)\b)[A-Za-z][A-Za-z']*\s+\d{1,4}\b/i;

// Extract the event number from a UFC event name across all supported formats.
// Used by isRelevantStreamTitle to reject candidate titles that don't include
// the right number. Returns null when the event name has no recognisable
// number (rare; some unnumbered specials slip through). 0.33.6 added the
// branded-PPV branch to cover "UFC Freedom 250 …" — the older inline regex
// `ufc\s*(?:fight\s*night\s*)?(\d+)` couldn't extract 250 because "Freedom"
// sits between "UFC" and the digits.
function ufcEventNumber(name) {
  if (!name) return null;
  let m;
  if ((m = name.match(/^UFC\s+Fight\s+Night\s+(\d{1,4})\b/i))) return m[1];
  if ((m = name.match(/^UFC\s+on\s+(?:ABC|ESPN|FOX|FX)\s+(\d{1,4})\b/i))) return m[1];
  if ((m = name.match(/^UFC\s+(?!(?:Fight|on|Contender)\b)[A-Za-z][A-Za-z']*\s+(\d{1,4})\b/i))) return m[1];
  if ((m = name.match(/^UFC\s*(\d{1,4})\b/i))) return m[1];
  return null;
}

// Same idea as the event classifier above, but applied to a torrent TITLE
// (which has scene-style separators . _ - and may not start with "UFC").
// Used to reject "UFC 276" (numbered PPV) candidates from being matched to
// "UFC Fight Night 276" (different event sharing only the number 276), and
// vice versa. Order matters: check Fight Night before PPV because a fight-
// night title also contains "UFC <digits>". 0.33.6 adds an explicit branded
// check so "UFC.Freedom.250" / "UFC Freedom 250" classifies as 'ppv' too.
function ufcTitleType(title) {
  const t = title || '';
  if (/\bUFC[\s._-]*Fight[\s._-]*Night\b/i.test(t)) return 'fight-night';
  if (/\bUFC[\s._-]+on[\s._-]+(?:ABC|ESPN|FOX|FX)\b/i.test(t)) return 'ufc-on-network';
  if (/\bContender[\s._-]*Series\b/i.test(t)) return 'contender-series';
  // Branded numbered: "UFC Freedom 250" / "UFC.Freedom.250"
  if (/\bUFC[\s._-]+(?!(?:Fight|on|Contender)\b)[A-Za-z]+[\s._-]+\d{1,4}\b/i.test(t)) return 'ppv';
  // Plain numbered: "UFC 250" / "UFC.250"
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
    // 0.33.6: branded numbered PPV ("UFC Freedom 250 Topuria vs Gaethje").
    // Checked after plain PPV; the negative lookahead inside the regex skips
    // events that should be handled by the Fight Night / UFC-on-network /
    // Contender Series classifiers immediately below.
    if (UFC_BRANDED_PPV_RE.test(name)) return 'ppv';
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
    // 0.33.6: branded numbered PPV — return "UFC Freedom 250" so Wikipedia
    // lookups and alias-building have a clean handle for these events.
    if ((m = name.match(/^(UFC\s+(?!(?:Fight|on|Contender)\b)[A-Za-z][A-Za-z']*\s+\d{1,4})\b/i))) {
      return m[1].replace(/\s+/g, ' ').trim();
    }
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

  // 0.30.0: short scene-style queries for Newsnab / Usenet Ultimate text search.
  // The full event name ("UFC 291: Poirier vs. Gaethje 2") returns 0 hits on
  // NZB indexers because Usenet uploaders never include the matchup in titles.
  // The short form ("UFC 291") returns dozens. Each entry here is a complete,
  // standalone query we fire at the indexer; they're deduped + merged downstream.
  // 0.33.6: branded numbered PPVs ("UFC Freedom 250 Topuria vs Gaethje") now
  // emit both the full branded handle ("UFC Freedom 250") AND the plain
  // numbered form ("UFC 250"). Release groups overwhelmingly use the branded
  // form, but the plain form is a cheap fallback against groups that drop the
  // subtitle.
  searchTitles(event) {
    const name = event && event.name;
    if (!name) return [];
    const out = new Set();
    // Branded numbered PPV: "UFC Freedom 250 Topuria vs Gaethje" → both
    // "UFC Freedom 250" and "UFC 250". Checked first so plain-PPV logic
    // below doesn't fire on the same event (the plain regex requires digits
    // immediately after "UFC", which branded names don't satisfy, but the
    // explicit ordering documents intent).
    const branded = name.match(/^(UFC\s+(?!(?:Fight|on|Contender)\b)([A-Za-z][A-Za-z']*)\s+(\d{1,4}))\b/i);
    if (branded) {
      out.add(branded[1].replace(/\s+/g, ' ').trim());      // "UFC Freedom 250"
      out.add('UFC ' + branded[3]);                          // "UFC 250" fallback
    }
    // Numbered PPV: "UFC 291: Poirier vs. Gaethje 2" → "UFC 291"
    const ppv = name.match(/^(UFC\s*\d{1,4})\b/i);
    if (ppv) out.add(ppv[1].replace(/\s+/g, ' ').trim());
    // Numbered Fight Night: "UFC Fight Night 277: Song vs. Figueiredo"
    const fn = name.match(/^UFC\s+Fight\s+Night\s+(\d{1,4})\b/i);
    if (fn) {
      out.add('UFC Fight Night ' + fn[1]);
      out.add('UFC FN ' + fn[1]);
    } else if (/^UFC\s+Fight\s+Night/i.test(name) && event.date) {
      // Unnumbered FN: fall back to date-form (rare nowadays)
      out.add('UFC Fight Night ' + event.date);
    }
    // UFC on ABC/ESPN/FOX/FX (numbered)
    const onNet = name.match(/^(UFC\s+on\s+(?:ABC|ESPN|FOX|FX)\s*\d{0,3})\b/i);
    if (onNet) out.add(onNet[1].replace(/\s+/g, ' ').trim());
    // Contender Series — scene tag is "DWCS" or "Dana Whites Contender Series"
    if (UFC_CONTENDER_RE.test(name)) {
      const week = name.match(/\bweek\s*(\d{1,2})\b/i);
      const year = event.date ? event.date.slice(0, 4) : '';
      if (week && year) {
        out.add('DWCS ' + year + ' Week ' + week[1]);
        out.add('Contender Series ' + year + ' Week ' + week[1]);
      } else if (year) {
        out.add('DWCS ' + year);
      }
    }
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
    // 0.33.6: use ufcEventNumber() which understands branded numbered PPVs
    // ("UFC Freedom 250" etc). The old inline regex
    // `/ufc\s*(?:fight\s*night\s*)?(\d{1,4})/` couldn't extract the number
    // when a subtitle word sat between "UFC" and the digits, so the event-
    // number guard silently disabled itself and let unrelated releases match.
    const num = ufcEventNumber(event.name || '');
    if (num && !t.includes(num)) return { ok: false, reason: 'wrong-event-number' };
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

  // 0.30.0: short queries for Usenet/Newsnab. ONE FC release naming is
  // consistently number-based across all three series (numbered cards, FN, FF),
  // so we emit ONLY the short forms — no event-name suffix.
  searchTitles(event) {
    const name = event && event.name;
    if (!name) return [];
    const out = new Set();
    // Numbered: "ONE 173" / "ONE Championship 173"
    const numbered = name.match(/^ONE\s+(?:Championship\s+)?(\d{1,4})\b/i);
    if (numbered) {
      out.add('ONE ' + numbered[1]);
      out.add('ONE FC ' + numbered[1]);
      out.add('ONE Championship ' + numbered[1]);
    }
    // Fight Night
    const fn = name.match(/^ONE\s+Fight\s+Night\s+(\d{1,4})\b/i);
    if (fn) {
      out.add('ONE Championship ONE Fight Night ' + fn[1]);
      out.add('ONE Fight Night ' + fn[1]);
      out.add('ONE FN ' + fn[1]);
    }
    // Friday Fights
    const ff = name.match(/^ONE\s+Friday\s+Fights\s+(\d{1,4})\b/i);
    if (ff) {
      out.add('ONE Championship ONE Friday Fights ' + ff[1]);
      out.add('ONE Friday Fights ' + ff[1]);
      out.add('ONE FF ' + ff[1]);
    }
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

  // 0.38.1: TSDB stores Main Event episodes inconsistently — newer entries
  // include the "WWE " prefix ("WWE Main Event #713"), while a batch added
  // earlier omits it ("Main Event #710", "#711", etc.). The catalog ends
  // up showing two visually-distinct entries that look like duplicates.
  // Force the prefix on the way in so naming is uniform regardless of
  // which TSDB batch the episode came from.
  normaliseName(rawName) {
    if (!rawName) return rawName;
    if (/^Main\s+Event\b/i.test(rawName)) return 'WWE ' + rawName;
    return rawName;
  },

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

  // 0.30.0: short queries for Usenet/Newsnab. WWE PLEs use scene-style naming
  // already (WrestleMania 42, SummerSlam 2026, Royal Rumble 2026 etc.) — we
  // mostly just strip colon-prefixed subtitles and append the year for
  // annually-repeating events. Saturday Night's Main Event uses a broad name
  // query because scene rips use Roman-numeral editions OR broadcast-date in
  // dot-format (YYYY.MM.DD), which doesn't reliably match the TSDB UTC date.
  // The relevance filter's year check narrows the broad results.
  searchTitles(event) {
    const name = event && event.name;
    if (!name) return [];
    const out = new Set();
    // Strip any colon subtitle then strip a leading "WWE " so we don't
    // double-prefix events that TSDB already labels "WWE …" (e.g. "WWE
    // Main Event #713"). Also drop "#" — scene rips never use it.
    const colonStripped = name.split(':')[0].trim();
    const wweStripped = colonStripped.replace(/^WWE\s+/i, '').trim();
    const bare = wweStripped.replace(/#/g, '').replace(/\s+/g, ' ').trim();
    const year = event.date ? event.date.slice(0, 4) : '';

    // Saturday Night's Main Event — broad name + year, no date.
    if (/saturday\s*night.?s?\s*main\s*event/i.test(bare)) {
      out.add('WWE Saturday Nights Main Event');
      if (year) out.add('WWE Saturday Nights Main Event ' + year);
      return Array.from(out).filter(Boolean);
    }

    // Bare event name as-is (already scene-style)
    out.add(bare);
    out.add('WWE ' + bare);
    // If the name doesn't already carry a year/edition number, append the year
    // — disambiguates annually-recurring PLEs (Royal Rumble, SummerSlam, etc).
    if (year && !/\b(?:19|20)\d{2}\b|\b\d{1,3}\b/.test(bare)) {
      out.add(bare + ' ' + year);
      out.add('WWE ' + bare + ' ' + year);
    }
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
  // like a weekly episode of RAW/SmackDown/EVOLVE/LFG, and numbered NXT
  // episodes — but KEEP named NXT events (Vengeance Day, Stand & Deliver,
  // etc.), Saturday Night's Main Event PLEs, and WWE Main Event mini-PLEs
  // (intermittent 5-event series, not the weekly Tuesday Night Main Event).
  includeEvent(ev) {
    const n = (ev.name || '').trim();
    if (/^Saturday\s*Night/i.test(n)) return true;          // PLE, keep
    if (/^NXT\s*#\d/i.test(n)) return false;                // numbered NXT = weekly
    if (/^(RAW|SmackDown|EVOLVE|LFG)\b/i.test(n)) return false;
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

  // 0.30.0: short queries for Usenet/Newsnab. AEW PPV names recur annually
  // (Revolution 2026 vs 2025) so we always pin the year. The promotion's
  // weekly-TV slip-through (Dynamite/Collision/Rampage) is already filtered
  // by includeEvent, but if any escape we date-key them.
  searchTitles(event) {
    const name = event && event.name;
    if (!name) return [];
    const out = new Set();
    // Strip any "AEW " prefix already on the event name so we don't double it
    // (TSDB sometimes returns "AEW Revolution", sometimes just "Revolution").
    const bareRaw = name.split(':')[0].trim();
    const bare = bareRaw.replace(/^AEW\s+/i, '').trim();
    const year = event.date ? event.date.slice(0, 4) : '';
    // Already-year-tagged ("All In London 2026") — don't append another year.
    const hasYearAlready = /\b(?:19|20)\d{2}\b/.test(bare);
    // Weekly TV (shouldn't normally reach here, but safe fallback)
    if (/^(Dynamite|Collision|Rampage)\b/i.test(bare)) {
      const which = bare.match(/^(Dynamite|Collision|Rampage)/i)[1];
      if (event.date) {
        out.add('AEW ' + which + ' ' + event.date);
        out.add('AEW ' + which + ' ' + event.date.replace(/-/g, '.'));
      }
      return Array.from(out).filter(Boolean);
    }
    // PPVs — "Revolution", "Dynasty", "Double or Nothing", "Forbidden Door", "All In"
    out.add('AEW ' + bare);
    if (year && !hasYearAlready) {
      out.add('AEW ' + bare + ' ' + year);
    }
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
  if (/full[\s._-]*weekend|полный\s+уикэнд|(?:практики.*квалификация.*гонка)/i.test(t)) return 'full-weekend';
  const sprint = /\bsprint\b|спринт/.test(t);
  const quali = /qualif|квалификац/.test(t);
  if (sprint && quali) return 'sprint-qualifying';
  if (sprint) return 'sprint';
  if (quali) return 'qualifying';
  if (/\bpractice\b|free[\s.\-_]*practice|\bfp[1-3]\b|практик/.test(t)) return 'practice';
  if (/\brace\b|гонка/.test(t)) return 'race';
  return 'unlabelled';
}

const F1_SESSION_LABEL = {
  race: 'Race', qualifying: 'Qualifying', sprint: 'Sprint',
  'sprint-qualifying': 'Sprint Qualifying', practice: 'Practice',
};

// Adjective -> country/city noun mapping for F1 GPs. TSDB uses the adjective
// form ("Canadian Grand Prix"); a meaningful chunk of scene rips use the
// noun form ("Canada") instead, and our queries need to fire both shapes to
// catch all the releases. Lower-case keys, matched case-insensitively.
const F1_LOCATION_NOUN = {
  'canadian': 'Canada',
  'chinese': 'China',
  'italian': 'Italy',
  'spanish': 'Spain',
  'british': 'Britain',        // also 'UK', 'Silverstone' — try main one first
  'french': 'France',
  'german': 'Germany',
  'belgian': 'Belgium',
  'hungarian': 'Hungary',
  'austrian': 'Austria',
  'dutch': 'Netherlands',
  'japanese': 'Japan',
  'brazilian': 'Brazil',
  'australian': 'Australia',
  'mexican': 'Mexico',
  'qatari': 'Qatar',
  'bahraini': 'Bahrain',
  'azerbaijani': 'Azerbaijan',
  'american': 'USA',
  'saudi arabian': 'SaudiArabia',
  'abu dhabi': 'AbuDhabi',
};

function f1LocationNoun(loc) {
  if (!loc) return null;
  const lower = loc.toLowerCase().trim();
  return F1_LOCATION_NOUN[lower] || null;
}

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

  // 0.30.0: short queries for Usenet/Newsnab. F1 scene naming is consistent
  // ("Formula.1.YYYY.<location>.GP.<session>") so we generate that shape plus
  // a couple of equally-valid common variants.
  searchTitles(event) {
    const name = event && event.name;
    if (!name) return [];
    const out = new Set();
    const loc = f1Location(name).trim();
    if (!loc) return [];
    const session = f1Session(name);
    const year = event.date ? event.date.slice(0, 4) : '';
    const sessionLabel = F1_SESSION_LABEL[session] || '';
    // Race: scene rips for F1 races use multiple naming conventions:
    //   Formula.1.2026.Canadian.Grand.Prix.Race.WEB        (adjective)
    //   F1.2026.R05.Canadian.Grand.Prix                    (round + adjective)
    //   F1.2026.Round.5.Canada.Race                        (round + noun + Race)
    //   F1.2026.Round05.Canada                             (compact)
    // We fire enough variants to cover both adjective and country-noun
    // forms, with a round-prefixed variant when TSDB gives us the round.
    if (session === 'race') {
      if (year) {
        out.add(('Formula 1 ' + year + ' ' + loc + ' GP').trim());
        out.add(('F1 ' + year + ' ' + loc + ' GP').trim());
        out.add(('Formula 1 ' + year + ' ' + loc + ' Grand Prix').trim());
        out.add(('F1 ' + year + ' ' + loc + ' Race').trim());

        // Country-noun variants (Canadian -> Canada). Many groups label
        // race-specific rips with the country noun.
        const noun = f1LocationNoun(loc);
        if (noun && noun.toLowerCase() !== loc.toLowerCase()) {
          out.add(('F1 ' + year + ' ' + noun).trim());
          out.add(('F1 ' + year + ' ' + noun + ' Race').trim());
          out.add(('Formula 1 ' + year + ' ' + noun + ' Race').trim());
        }

        // Round-prefixed variants when TSDB ships a round number. Format
        // 'R05' is the dominant scene convention.
        if (event.round) {
          const r = String(event.round).padStart(2, '0');
          out.add(('F1 ' + year + ' R' + r + ' ' + loc + ' GP').trim());
          if (noun && noun.toLowerCase() !== loc.toLowerCase()) {
            out.add(('F1 ' + year + ' R' + r + ' ' + noun).trim());
          }
        }
      }
    } else if (sessionLabel) {
      // Per-session: "Formula 1 2026 Monaco GP Qualifying"
      if (year) {
        out.add(('Formula 1 ' + year + ' ' + loc + ' GP ' + sessionLabel).trim());
        out.add(('F1 ' + year + ' ' + loc + ' GP ' + sessionLabel).trim());
        // F1 scene rips also use the compact location token without GP suffix
        out.add(('Formula 1 ' + year + ' ' + loc + ' ' + sessionLabel).trim());
      }
    }
    // Round-only variants recover international indexers whose translated
    // location names do not match the English schedule. Keep them after the
    // precise location/session forms so mainstream indexers see those first.
    if (year && event.round) {
      const round = String(parseInt(event.round, 10));
      out.add(('Formula 1 ' + year + ' Round ' + round).trim());
      out.add(('Formula 1 ' + year + ' Этап ' + round).trim());
    }
    return Array.from(out).filter(Boolean);
  },

  isRelevantStreamTitle(title, event) {
    if (!title) return { ok: false, reason: 'no-title' };
    if (/\b(?:formula|f)[\s._-]*[23]\b/i.test(title)) {
      return { ok: false, reason: 'formula-2-or-3' };
    }
    if (!/\b(f1|formula\s*1|formula1|formula\.1)\b/i.test(title)
        && !/формула\s*1/i.test(title)) {
      return { ok: false, reason: 'no-f1-context' };
    }
    const t = title.toLowerCase();
    // Event match: round (R05 / Round 5) or location stem.
    const round = event.round ? String(parseInt(event.round, 10)) : '';
    const roundOk = !!round && new RegExp('(?:\\br|round|этап)[\\s._-]*0*' + round + '\\b', 'i').test(title);
    const loc = f1Location(event.name || '').toLowerCase().replace(/\s+/g, '');
    const locStem = loc.replace(/(ese|ian|ish|an|n)$/, '').slice(0, 6);
    const locOk = locStem.length >= 4 && t.replace(/\s+/g, '').includes(locStem);
    if (!roundOk && !locOk) return { ok: false, reason: 'no-event-match' };
    if (!yearMatchesEvent(title, event)) return { ok: false, reason: 'wrong-year' };
    // Session must match the specific session this catalog item represents.
    const want = f1Session(event.name);
    const got = f1TitleSession(title);
    if (want === 'race') {
      if (got !== 'race' && got !== 'unlabelled' && got !== 'full-weekend') {
        return { ok: false, reason: 'session(' + got + '≠race)' };
      }
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

// Extract the surnames of the two fighters in a boxing event name. The old
// (0.23.0) version used a single greedy regex and grabbed whatever word came
// next to "vs", which produced wrong results like:
//   "Foster v Ray Ford"          → { left: 'Foster', right: 'Ray' }   ❌
//   "Azim v Steve Claggett"      → { left: 'Azim',   right: 'Steve' } ❌
// The corrected version (0.23.2) splits on the "vs" separator, then on each
// side takes the LAST name-like word — i.e. the surname — skipping trailing
// numbers / Roman-numeral sequel markers (II, III, 2).
//   "MVPW 03 Han vs Holm 2"         → { left: 'Han',     right: 'Holm' }
//   "Foster v Ray Ford"             → { left: 'Foster',  right: 'Ford' }
//   "Tyson Fury vs Arslanbek Makh." → { left: 'Fury',    right: 'Makh' }
//   "Crawford vs Spence"            → { left: 'Crawford',right: 'Spence' }
function boxingMatchup(name) {
  if (!name) return null;
  const parts = String(name).split(/\s+(?:vs\.?|v)\s+/i);
  if (parts.length < 2) return null;
  const leftSide  = parts[0].trim();
  const rightSide = parts.slice(1).join(' v ').trim();
  function lastName(s) {
    const words = s.split(/\s+/).filter((w) =>
      /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’-]*$/.test(w));
    // Drop trailing single-letter / Roman / number sequel markers, but keep
    // the last actual name. "Holm 2" → "Holm". "Fury II" → "Fury".
    while (words.length > 1 && /^(?:I{1,3}V?|IV|V|VI{1,3}|\d+)$/.test(words[words.length - 1])) {
      words.pop();
    }
    return words[words.length - 1] || null;
  }
  const left = lastName(leftSide);
  const right = lastName(rightSide);
  if (!left || !right) return null;
  return { left, right };
}

const boxing = {
  id: 'boxing',
  name: 'Boxing',
  idPrefix: 'boxing',
  enabled: true,
  source: { type: 'thesportsdb', leagueId: '4445' },

  // 0.25.1: poster shape is portrait ('poster' = Stremio's 2:3 default).
  // TSDB's per-event strPoster for boxing IS portrait fight-card art (the
  // actual matchup poster) — perfect for a portrait tile. Switching from
  // landscape avoids the BOXING-wordmark badge getting center-cropped to
  // "VG"/"NG" in a landscape tile, AND lets per-event TSDB art show
  // through. useDefaultArt was wrong — it forced every event onto the
  // generic fallback badge instead of the per-event fight poster. Removed.
  // The badge in defaults below stays as the FALLBACK for events without
  // their own poster.
  posterShape: 'poster',
  defaults: {
    poster: brandedPoster('boxing-upcoming.jpg', 'https://r2.thesportsdb.com/images/media/league/badge/6enin21740228549.png'),
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

  // 0.30.0: short queries for Usenet/Newsnab. Boxing release titles almost
  // always use just surnames (no promoter, no "BOXING" keyword). The 0.23.2
  // surname extractor already produces the right tokens; we just emit them
  // in scene-style "vs" forms.
  searchTitles(event) {
    const name = event && event.name;
    if (!name) return [];
    const out = new Set();
    const m = boxingMatchup(name);
    if (!m) return [];
    // Detect a trailing sequel marker (2 / II / 3 / III)
    const seqMatch = name.match(/\b([2-9]|II|III|IV|V)\s*$/);
    const seq = seqMatch ? seqMatch[1] : '';
    out.add(m.left + ' vs ' + m.right);
    out.add(m.left + ' ' + m.right);
    if (seq) {
      out.add(m.left + ' vs ' + m.right + ' ' + seq);
      out.add(m.left + ' ' + m.right + ' ' + seq);
    }
    // Append year for rematch disambiguation
    const year = event.date ? event.date.slice(0, 4) : '';
    if (year) {
      out.add(m.left + ' vs ' + m.right + ' ' + year);
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

// ===== MotoGP =====
// TheSportsDB league 4407. TSDB only catalogues two event types per round:
// the Sunday Race ("<Country> GP") and the Saturday Sprint Race ("<Country>
// Sprint Race"). Qualifying / Practice / Warm Up sessions are not on TSDB,
// so we don't expose catalogs for them. Country names appear as nouns in
// both TSDB events and scene rips ("Italy" not "Italian"), so location
// extraction is a simple suffix strip rather than the adjectival mapping
// F1 uses.

function motogpLocation(name) {
  return (name || '')
    .replace(/\bmotogp\b/i, '')
    // Strip the complete session suffix before shorter alternatives. Matching
    // `practice` first would leave "Free" attached to the venue and create
    // aliases such as "Aragón Free". This also handles common FP labels from
    // configurable metadata sources without venue-specific exceptions.
    .replace(/\b(sprint\s*race|sprint|qualifying|qualification|qualif|free[\s.\-_]*practice|practice|fp[1-4]|warm[\s.\-_]*up|gp|grand\s*prix)\b.*$/i, '')
    .trim();
}

// 0.34.0: MotoGP release-naming aliases. Country/round names from TSDB don't
// match the actual scene release tokens, which vary wildly by group:
//   - Dorna-rip pattern: "MotoGP 2026 - Round06 - CatalanGP - Full Weekend"
//   - MWR pattern:       "MotoGP 2026 Round06 Spain Catalunya Race WEB-DL"
//   - Polsat HDTV:       "Moto Grand Prix ... 2026 Этап 06 Spain (Barcelona)"
//   - Bare scene:        "MotoGP.2026.Italy.1080p.WEB.h264-VERUM"
//
// Each TSDB location expands to multiple aliases — adjective forms, compact
// "<adj>GP" forms, circuit names, country+region combos. searchTitles emits
// queries for each; isRelevantStreamTitle accepts ANY alias in the title.
//
// Keys lowercased. Add new rounds here as the 2026/2027 calendar evolves.
const MOTOGP_LOCATION_ALIASES = {
  'spain':         ['spain', 'spanish', 'spanishgp', 'jerez'],
  'france':        ['france', 'french', 'frenchgp', 'le mans', 'lemans'],
  'italy':         ['italy', 'italian', 'italiangp', 'mugello'],
  'germany':       ['germany', 'german', 'germangp', 'sachsenring'],
  'netherlands':   ['netherlands', 'dutch', 'dutchgp', 'assen'],
  'great britain': ['great britain', 'british', 'britishgp', 'uk', 'silverstone'],
  'britain':       ['britain', 'british', 'britishgp', 'uk', 'silverstone'],
  'czechia':       ['czechia', 'czech', 'czechgp', 'brno'],
  'czech republic':['czechia', 'czech', 'czechgp', 'brno'],
  'hungary':       ['hungary', 'hungarian', 'hungariangp', 'balaton'],
  'austria':       ['austria', 'austrian', 'austriangp', 'red bull ring', 'redbull ring'],
  'catalonia':     ['catalonia', 'catalunya', 'catalan', 'catalangp', 'spain catalunya', 'spain barcelona'],
  'catalunya':     ['catalonia', 'catalunya', 'catalan', 'catalangp', 'spain catalunya', 'spain barcelona'],
  'aragon':        ['aragon', 'aragón', 'aragongp', 'motorland'],
  'aragón':        ['aragon', 'aragón', 'aragongp', 'motorland'],
  'san marino':    ['san marino', 'sanmarino', 'sanmarinogp', 'misano'],
  'usa':           ['usa', 'americas', 'american', 'americasgp', 'cota'],
  'united states': ['usa', 'americas', 'american', 'americasgp', 'cota'],
  'argentina':     ['argentina', 'argentine', 'argentinegp', 'termas'],
  'qatar':         ['qatar', 'qatari', 'qatargp', 'losail', 'lusail'],
  'portugal':      ['portugal', 'portuguese', 'portuguesegp', 'portimao'],
  'malaysia':      ['malaysia', 'malaysian', 'malaysiangp', 'sepang'],
  'thailand':      ['thailand', 'thai', 'thaigp', 'buriram', 'chang'],
  'japan':         ['japan', 'japanese', 'japanesegp', 'motegi'],
  'indonesia':     ['indonesia', 'indonesian', 'indonesiangp', 'mandalika'],
  'india':         ['india', 'indian', 'indiangp', 'buddh'],
  'brazil':        ['brazil', 'brazilian', 'braziliangp'],
  'finland':       ['finland', 'finnish', 'finnishgp', 'kymiring'],
};

// Return the list of search/match aliases for a TSDB location string.
// Falls back to [loc] verbatim for unknown locations (new venues etc.).
//
// 0.35.0: pulls admin-added aliases from lib/match-overrides on every call so
// the /admin/match-editor changes take effect WITHOUT a container restart.
// The merged-with-defaults map gets recomputed each call; overhead is
// negligible (file is < 1KB and only 7 hardcoded promos to scan).
function motogpLocationAliases(loc) {
  if (!loc) return [];
  const lc = loc.toLowerCase().trim();
  const merged = matchOverrides.getMergedAliases('motogp', MOTOGP_LOCATION_ALIASES);
  const direct = merged[lc];
  if (direct && direct.length) return direct;
  // No mapping (hardcoded or override) — fall back to verbatim so the
  // location at least matches itself.
  return [lc];
}

function motogpSession(name) {
  const n = (name || '').toLowerCase();
  if (/testing|pre[\s-]*season/.test(n)) return 'testing';
  if (/\bsprint\b/.test(n)) return 'sprint';
  // 'qualifying' is only ever set on synthesised events (TSDB doesn't track
  // qualifying separately for MotoGP). See `expandEvents` below.
  if (/qualif/.test(n)) return 'qualifying';
  if (/\bpractice\b|\bfp[1-4]\b|warm[\s.\-_]*up/.test(n)) return 'practice';
  return 'race';
}

function motogpTitleSession(title) {
  const t = (title || '').toLowerCase();
  if (/\bsprint\b/.test(t)) return 'sprint';
  if (/qualif/.test(t)) return 'qualifying';
  if (/\bpractice\b|free[\s.\-_]*practice|\bfp[1-3]\b|warm[\s.\-_]*up/.test(t)) return 'practice';
  if (/\brace\b/.test(t)) return 'race';
  return 'unlabelled';
}

const MOTOGP_SESSION_LABEL = {
  race: 'Race', sprint: 'Sprint', qualifying: 'Qualifying',
};

// Add days to an ISO date (YYYY-MM-DD), return the result in the same format.
function shiftIsoDate(iso, days) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const motogp = {
  id: 'motogp',
  name: 'MotoGP',
  idPrefix: 'motogp',
  enabled: true,
  source: { type: 'thesportsdb', leagueId: '4407' },
  posterShape: 'landscape',
  preferThumb: true,

  // Real TSDB URLs scraped from thesportsdb.com/league/4407-motogp.
  defaults: {
    poster: brandedPoster('motogp-upcoming.jpg', 'https://r2.thesportsdb.com/images/media/league/banner/qrxpqu1441138872.jpg'),
    fanart: 'https://r2.thesportsdb.com/images/media/league/banner/qrxpqu1441138872.jpg',
    logo:   'https://r2.thesportsdb.com/images/media/league/logo/tkd2rt1733231583.png',
  },

  wikipediaTitle(name) { return null; },

  classify(name) { return motogpSession(name); },

  shortHandle(name) { return name ? name.trim().replace(/\s+/g, ' ') : null; },

  buildAliases(name) {
    if (!name) return [];
    const out = new Set();
    const t = name.trim();
    const loc = motogpLocation(t);
    out.add(t);
    out.add('MotoGP ' + t);
    if (loc) {
      out.add(('MotoGP ' + loc).trim());
      out.add(('MotoGP ' + loc + ' GP').trim());
    }
    return Array.from(out).filter(Boolean);
  },

  // Scene rips drop the "GP" / "Grand Prix" word entirely and tag the
  // session inline:
  //   MotoGP.2026.Italy.1080p.WEB.h264-VERUM            (Sunday race)
  //   MotoGP.2026.Italy.Sprint.Race.1080p.WEB.h264-VERUM
  //   MotoGP.2026.Italy.Sprint.1080p.WEB.h264-BILLIE     (same event, different group)
  //
  // 0.34.0: also generate adjective + circuit aliases for each location
  // (FrenchGP / SpanishGP / CatalanGP / Spain Catalunya / Mugello / etc.)
  // and round-number variants if event.round is present (DornaRip uses
  // "Round04" / "Round 04" interchangeably).
  searchTitles(event) {
    const name = event && event.name;
    if (!name) return [];
    const out = new Set();
    const loc = motogpLocation(name).trim();
    if (!loc) return [];
    const session = motogpSession(name);
    const year = event.date ? event.date.slice(0, 4) : '';
    if (!year) return [];
    const aliases = motogpLocationAliases(loc);
    // Round number, if TSDB provided it (otherwise '' — skip round variants).
    const roundNum = event.round ? String(event.round).padStart(2, '0') : '';

    // Per-session variants for each alias.
    for (const alias of aliases) {
      if (session === 'race') {
        out.add(('MotoGP ' + year + ' ' + alias).trim());
        if (roundNum) {
          out.add(('MotoGP ' + year + ' Round' + roundNum + ' ' + alias).trim());
          out.add(('MotoGP ' + year + ' Round ' + roundNum + ' ' + alias).trim());
        }
      } else if (session === 'sprint') {
        out.add(('MotoGP ' + year + ' ' + alias + ' Sprint').trim());
        out.add(('MotoGP ' + year + ' ' + alias + ' Sprint Race').trim());
        if (roundNum) {
          out.add(('MotoGP ' + year + ' Round' + roundNum + ' ' + alias + ' Sprint').trim());
        }
      } else if (session === 'qualifying') {
        out.add(('MotoGP ' + year + ' ' + alias + ' Qualifying').trim());
        if (roundNum) {
          out.add(('MotoGP ' + year + ' Round' + roundNum + ' ' + alias + ' Qualifying').trim());
        }
      } else if (session === 'practice') {
        out.add(('MotoGP ' + year + ' ' + alias + ' Practice').trim());
        out.add(('MotoGP ' + year + ' ' + alias + ' Free Practice').trim());
        out.add(('MotoGP ' + year + ' ' + alias + ' FP1').trim());
        out.add(('MotoGP ' + year + ' ' + alias + ' FP2').trim());
      }
      // Broad fallback for non-race sessions — see comment block above.
      if (session && session !== 'race') {
        out.add(('MotoGP ' + year + ' ' + alias).trim());
      }
    }
    return Array.from(out).filter(Boolean);
  },

  isRelevantStreamTitle(title, event) {
    if (!title) return { ok: false, reason: 'no-title' };
    if (!/\bmotogp\b/i.test(title)) return { ok: false, reason: 'no-motogp-context' };
    const t = title.toLowerCase().replace(/[._-]/g, ' ');
    const loc = motogpLocation(event.name || '').toLowerCase().trim();
    if (!loc) return { ok: false, reason: 'no-event-location' };
    // 0.34.0: accept ANY alias for this location (adjective forms, compact
    // "<adj>GP", circuit names, country+region combos). Old code only
    // accepted the bare location string, which missed DornaRip's "CatalanGP",
    // MWR's "Spain Catalunya", Polsat's "Spain (Barcelona)" etc.
    const aliases = motogpLocationAliases(loc);
    const aliasMatch = aliases.some((a) => t.includes(a.toLowerCase()));
    if (!aliasMatch) return { ok: false, reason: 'no-location-match(' + loc + ')' };
    if (!yearMatchesEvent(title, event)) return { ok: false, reason: 'wrong-year' };
    // Reject Moto2 / Moto3 rips that share the year+location with MotoGP.
    const hasJuniorClass = /\bmoto[23]\b/i.test(title);
    const isCombinedWeekend = /\bmotogp\b/i.test(title) && /\bmoto2\b/i.test(title) && /\bmoto3\b/i.test(title);
    if (hasJuniorClass && !isCombinedWeekend) return { ok: false, reason: 'moto2-or-moto3' };
    // 0.34.0: round-number cross-check disambiguates same-country events
    // (e.g. Spain GP at Jerez vs. Catalonia GP at Barcelona — both contain
    // "spain" in scene titles). If the title carries a "Round XX" / "RoundXX"
    // token AND we know event.round, they must match.
    if (event.round) {
      const tRound = title.match(/\bround\s*[._-]?\s*(\d{1,2})\b/i);
      if (tRound) {
        const titleRound = parseInt(tRound[1], 10);
        if (titleRound !== Number(event.round)) {
          return { ok: false, reason: 'wrong-round(' + titleRound + '≠' + event.round + ')' };
        }
      }
    }
    const want = motogpSession(event.name);
    const got = motogpTitleSession(title);
    if (want === 'race') {
      // Race events: reject sprint/qualifying/practice rips. Accept 'race'
      // OR 'unlabelled' (the bare scene format `MotoGP.YYYY.Italy.1080p`
      // has no session tag and is the race).
      if (got !== 'race' && got !== 'unlabelled') {
        return { ok: false, reason: 'session(' + got + '≠race)' };
      }
    } else if (want === 'sprint') {
      // Sprint events: must have 'sprint' in the title.
      if (got !== 'sprint') return { ok: false, reason: 'session(' + got + '≠sprint)' };
    } else if (want === 'qualifying') {
      // Qualifying events: must have 'qualif' (matches Qualifying One/Two).
      if (got !== 'qualifying') return { ok: false, reason: 'session(' + got + '≠qualifying)' };
    }
    return { ok: true };
  },

  catalogs: [
    { id: 'motogp-upcoming', name: 'MotoGP Upcoming',
      filter: (ev) => motogpSession(ev.name) === 'race' && ev.date && ev.date > isoToday(),
      sort: (a, b) => (a.date || '').localeCompare(b.date || '') },
    { id: 'motogp-race', name: 'MotoGP Race',
      filter: (ev) => motogpSession(ev.name) === 'race' && ev.date && ev.date <= isoToday(),
      sort: (a, b) => (b.date || '').localeCompare(a.date || '') },
    { id: 'motogp-qualifying', name: 'MotoGP Qualifying',
      filter: (ev) => motogpSession(ev.name) === 'qualifying' && ev.date && ev.date <= isoToday(),
      sort: (a, b) => (b.date || '').localeCompare(a.date || '') },
    { id: 'motogp-sprint', name: 'MotoGP Sprint',
      filter: (ev) => motogpSession(ev.name) === 'sprint' && ev.date && ev.date <= isoToday(),
      sort: (a, b) => (b.date || '').localeCompare(a.date || '') },
  ],

  eventScope: defaultEventScope,

  includeEvent(ev) {
    return !/testing|pre[\s-]*season/i.test((ev.name || '').trim());
  },

  // 0.31.1: TSDB only catalogues the Sunday Race and the Saturday Sprint
  // Race for MotoGP — no separate Qualifying entries. Synthesise a
  // Qualifying event for each Race event (Q1+Q2 happen Saturday morning,
  // day before the Sunday race). Sprint Race events are NOT cloned because
  // their corresponding Sprint Qualifying is rare to find as a standalone
  // scene release.
  expandEvents(events) {
    const out = [];
    for (const ev of events) {
      if (!ev || motogpSession(ev.name || '') !== 'race') continue;
      const loc = motogpLocation(ev.name || '').trim();
      if (!loc) continue;
      const qualDate = shiftIsoDate(ev.date, -1);
      if (!qualDate) continue;
      out.push(Object.assign({}, ev, {
        id: ev.id + '-qualifying',
        sourceId: (ev.sourceId || '') + '-qualifying',
        name: loc + ' Qualifying',
        kind: 'qualifying',
        date: qualDate,
        dateLocal: qualDate,
        timestamp: qualDate + 'T' + (ev.time || '00:00:00'),
        genres: ['Sports', 'Motorsport', 'MotoGP', 'Qualifying'],
        aliases: motogp.buildAliases(loc + ' Qualifying'),
      }));
    }
    return out;
  },

  genres(ev) {
    const g = ['Sports', 'Motorsport', 'MotoGP'];
    const label = MOTOGP_SESSION_LABEL[motogpSession(ev.name)];
    if (label) g.push(label);
    return g;
  },
};

// 0.35.0: Generic TSDB-backed promotion factory.
//
// Turns a user-supplied spec (data/custom-promotions.json) into a promotion
// object conforming to the same interface as the hardcoded promotions above.
// Intentionally limited to TSDB sources with name + year + keyword matching —
// works for NFL, NBA, MLB, NHL, soccer leagues, MMA promotions without
// complex numbering. Bespoke promotions stay hand-written in this file.
//
// Spec shape (validated upstream in lib/custom-promotions.js):
//   { id, name, idPrefix, leagueId, poster, fanart, logo, posterShape,
//     searchTitleTemplates: ['{name}', '{name} {year}'],
//     relevanceKeywords:    ['nfl', 'football'] }
//
// Template placeholders: {name} {promotion} {year} {date}, plus scene-style
// date layouts learned from real release examples.
function applyTitleTemplate(template, ctx) {
  return String(template || '')
    .replace(/\{name\}/g, ctx.name || '')
    .replace(/\{promotion\}/g, ctx.promotion || '')
    .replace(/\{year\}/g, ctx.year || '')
    .replace(/\{date_spaced\}/g, String(ctx.date || '').replace(/-/g, ' '))
    .replace(/\{date_dotted\}/g, String(ctx.date || '').replace(/-/g, '.'))
    .replace(/\{date\}/g, ctx.date || '');
}

// Release titles commonly replace spaces with dots, underscores, or hyphens.
// Normalise only for phrase recognition; date parsing and the original title
// remain untouched. This lets "match of the day" recognise
// "Match.Of.The.Day" consistently across torrent and Usenet sources.
function normaliseSceneText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 0.40.0 — football matchup splitter.
//
// football-data.org returns event names like "Manchester United FC vs
// Nottingham Forest FC" (canonical, includes FC). Release groups use every
// abbreviation imaginable: "Man United v Nottm Forest", "MUFC vs NFFC",
// "United vs Forest". splitMatchup / expandTeamAliases handle both search
// generation and the relevance check.
// "at" is how North American fixtures are written ("Bears at Seahawks") and is
// what the ESPN adapter produces. Leaving it out meant those names never split,
// so every consumer that reaches a team list by splitting quietly did nothing.
const MATCHUP_SEPARATOR_RE = /\s+(vs\.?|v\.?|at|@|-)\s+/i;
function splitMatchup(eventName) {
  if (!eventName) return null;
  const parts = String(eventName).split(MATCHUP_SEPARATOR_RE);
  // split with capture gives [home, separator, away]; anything else and it
  // wasn't a matchup format.
  if (parts.length < 3) return null;
  return { home: parts[0].trim(), away: parts.slice(2).join(' ').trim() };
}

// 0.40.1 — Build a bidirectional lookup from the canonical → aliases table.
//
// Every form (canonical + every alias + optional FC-trimmed variant) becomes
// a KEY pointing at the same full alias list. Lets us resolve regardless of
// which form the source data returns:
//   football-data.org returns "Man United" (shortName)
//   TheSportsDB returns "Manchester United" (name)
//   Wikipedia might return "Manchester United F.C."
// All three lookups return the same list, so search-title generation and
// relevance-check both work.
//
// Keys are lower-cased for case-insensitive matching.
function buildAliasLookup(aliasMap) {
  const lookup = Object.create(null);
  if (!aliasMap || typeof aliasMap !== 'object') return lookup;

  for (const canonical of Object.keys(aliasMap)) {
    const aliases = Array.isArray(aliasMap[canonical]) ? aliasMap[canonical] : [];
    const forms = new Set([canonical, ...aliases]);
    // Also add an FC-trimmed variant so "Manchester United FC" → "Manchester United"
    // works even if the alias list didn't include it explicitly.
    const trimmedFc = canonical.replace(/\s+(F\.?C\.?|C\.?F\.?|A\.?F\.?C\.?|SC|BC|AC|SS|SSC|VfB)$/i, '').trim();
    if (trimmedFc && trimmedFc !== canonical) forms.add(trimmedFc);
    const fullList = Array.from(forms);
    for (const form of fullList) {
      const key = String(form).toLowerCase().trim();
      if (!key) continue;
      // If two teams share a form (e.g. "United" for both Man United and Newcastle),
      // the last-registered wins — accept this rare collision cost for the
      // massive UX win of "any form works". Users can override via teamAliases.
      lookup[key] = fullList;
    }
  }
  return lookup;
}

// Return every known form for `teamName` given a pre-built lookup.
// Falls through with just [teamName] if we don't recognise it.
function expandTeamAliases(teamName, aliasLookup) {
  if (!teamName) return [];
  const canonical = String(teamName).trim();
  if (!aliasLookup) return [canonical];
  const key = canonical.toLowerCase();
  if (aliasLookup[key]) return aliasLookup[key];
  // FC-trimmed retry
  const trimmedFc = canonical.replace(/\s+(F\.?C\.?|C\.?F\.?|A\.?F\.?C\.?|SC|BC|AC|SS|SSC|VfB)$/i, '').trim();
  if (trimmedFc && trimmedFc !== canonical) {
    const trimmedKey = trimmedFc.toLowerCase();
    if (aliasLookup[trimmedKey]) return aliasLookup[trimmedKey];
  }
  return [canonical];
}

function eventTeamAliases(event, side, fallbackName, aliasLookup) {
  const sourceKey = side === 'home' ? 'homeTeamNames' : 'awayTeamNames';
  const suppliedFromEvent = (event && event.teamNames && Array.isArray(event.teamNames[side]))
    ? event.teamNames[side]
    : (event && event.source && Array.isArray(event.source[sourceKey]) ? event.source[sourceKey] : []);
  const supplied = suppliedFromEvent.length ? suppliedFromEvent : [
    teamIdentities.sceneForm(fallbackName),
    teamIdentities.stripLegalAffixes(fallbackName),
    fallbackName,
  ];
  const curated = expandTeamAliases(fallbackName, aliasLookup);
  // A recognized preset normally expands to several forms. Keep its curated
  // canonical identity first; otherwise prefer provider-derived mechanical
  // names so an unknown qualifier searches "Celje" before "NK Celje".
  const seeds = curated.length > 1 ? curated.concat(supplied) : supplied.concat(curated);
  const output = [];
  const seen = new Set();
  for (const seed of seeds) {
    for (const form of expandTeamAliases(seed, aliasLookup)) {
      const value = String(form || '').trim();
      const key = value.toLowerCase();
      if (value && !seen.has(key)) { seen.add(key); output.push(value); }
    }
  }
  return output.length ? output : [fallbackName];
}

// 0.42.3 — Rank alias forms by search-worthiness and take the top N per team
// for cross-product. Longer forms are more specific (less noise) and generally
// what release groups use. TLAs and short abbreviations are match-only —
// useful for the relevance regex but poor as search terms.
//
// Ranking (highest first):
//   - 3+ words (e.g. "Manchester United") — always ranked highest
//   - 2 words (e.g. "Man United") — canonical short form
//   - Single word with 5+ chars (e.g. "Villa", "Spurs") — medium confidence
//   - 3-4 char abbreviations (MCFC, MUN) — lowest, drop from search
const TOP_FORMS_PER_TEAM_FOR_SEARCH = 2;
function rankForSearch(list) {
  const eligible = list.filter((s) => s && s.length >= 4); // drop 3-char TLAs
  if (!eligible.length) return [];
  // Alias presets deliberately put the release-friendly canonical identity
  // first. Preserve it before ranking the remaining variants by specificity;
  // otherwise a longer formal provider name can crowd the canonical query
  // out of a bounded search set (Atletico Madrid vs Atlético de Madrid).
  const canonical = eligible[0];
  const remaining = eligible.slice(1).sort((a, b) => {
      // Prefer forms with more words, then by length within same word count
      const wa = a.split(/\s+/).length;
      const wb = b.split(/\s+/).length;
      if (wa !== wb) return wb - wa;
      return b.length - a.length;
    });
  return [canonical].concat(remaining);
}
function crossProductMatchups(homes, aways) {
  const topHomes = rankForSearch(homes).slice(0, TOP_FORMS_PER_TEAM_FOR_SEARCH);
  const topAways = rankForSearch(aways).slice(0, TOP_FORMS_PER_TEAM_FOR_SEARCH);
  const src = topHomes.length && topAways.length ? [topHomes, topAways] : [homes, aways];
  const out = [];
  for (const h of src[0]) {
    for (const a of src[1]) {
      out.push(h + ' vs ' + a);
    }
  }
  return out;
}

// 0.41.1 — Some alias forms are useful for RELEVANCE MATCHING but useless
// as SEARCH QUERIES because no release group uses them in titles. Drop them
// from the search-variant fan-out so we don't waste queries.
//
// Rules:
//   1. Forms ending in " FC" / " CF" / " AFC" / " SC" / " BC" / " AC" / " SS" /
//      " SSC" / " VfB" — release groups always drop the suffix.
//   2. Fan-nickname forms — a curated list. These are noisy and rarely used
//      in scene/p2p naming (release groups use short names, not nicknames).
const NON_SEARCH_SUFFIX_RE = /\s+(F\.?C\.?|C\.?F\.?|A\.?F\.?C\.?|SC|BC|AC|SS|SSC|VfB)$/i;
const NON_SEARCH_NICKNAMES = new Set([
  'gunners', 'cottagers', 'seagulls', 'eagles', 'toffees', 'tractor boys',
  'foxes', 'reds', 'citizens', 'red devils', 'magpies', 'tricky trees',
  'saints', 'hammers', 'irons', 'blues', 'cherries', 'bees', 'la real',
  'yellow submarine', 'los blancos', 'blaugrana', 'la dea', 'la vecchia signora',
  'bhoys',
  'tigers',
].map((s) => s.toLowerCase()));

function isSearchWorthyForm(form) {
  if (!form) return false;
  if (NON_SEARCH_SUFFIX_RE.test(form)) return false;
  if (NON_SEARCH_NICKNAMES.has(form.toLowerCase())) return false;
  return true;
}

// 0.42.1 — word-boundary match test for team-alias hits.
//
// The naive substring check (title.includes(alias)) false-positives on
// short aliases that are substrings of other words. Concrete disasters
// observed in production:
//   CHE (Chelsea TLA)     → hits "manCHEster"          → Chelsea events pick up Man United fixtures
//   MUN (Man United TLA)  → hits "aMUNition" (unlikely but possible)
//   ARS (Arsenal TLA)     → hits "parseley" or "wARShip"
//   ATM (Atletico TLA)    → hits "atmosphere"
//   CFC (Chelsea abbrev)  → hits any release with "cfc." accidentally
// Fix: precompile a case-insensitive word-boundary regex per alias and
// test() it against the (lowercased) title. \b is the boundary between a
// word char (A-Za-z0-9_) and a non-word char, so "che" surrounded by "." /
// " " / "_" / "-" matches, but "che" between letters (as in "manchester")
// does not.
//
// Regex objects are cached on the alias string itself via a WeakMap-like
// pattern (plain object; aliases are short so memory is fine) so we don't
// rebuild the regex for every candidate title.
const ALIAS_REGEX_CACHE = Object.create(null);
function aliasBoundaryMatch(lcTitle, alias) {
  if (!alias) return false;
  const key = alias.toLowerCase();
  let re = ALIAS_REGEX_CACHE[key];
  if (!re) {
    // Two-pass build:
    //   1. escape all regex metacharacters (dot, star, etc.)
    //   2. replace any run of whitespace inside the alias with a flexible
    //      separator class [\s._-]+ so multi-word aliases match releases
    //      that use dot/underscore/dash separators — the standard scene &
    //      p2p convention.
    // Concrete: "manchester city" → /manchester[\s._-]+city/ matches
    //   "manchester city", "manchester.city", "manchester_city",
    //   "manchester-city", and even "manchester . city".
    const escaped = key
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '[\\s._-]+');
    // Note: boundary class deliberately EXCLUDES underscore — scene naming
    // treats "_" as a separator (EPL_2026_Manchester_City), not as an
    // internal word character. JS \b would say no boundary between
    // "_" and "m" — we override that here.
    re = new RegExp('(?:^|[^A-Za-z0-9])' + escaped + '(?:$|[^A-Za-z0-9])', 'i');
    ALIAS_REGEX_CACHE[key] = re;
  }
  return re.test(lcTitle);
}

// Connector words that one feed keeps and another drops: "Celta de Vigo" and
// "Celta Vigo" are the same club. Removed from BOTH sides, so the match stays
// contiguous — dropping that would let "Real Madrid" match a title reading
// "Real Sociedad vs Atletico Madrid".
const TEAM_CONNECTOR_RE = /\b(?:de|del|da|do|dos|du|di|of|the|und|and)\b/g;

function plainTeamMatch(title, teamName) {
  // foldAscii first: the old normaliser stripped every non-ASCII character, so
  // "München" became "m nchen" and could never match "Munchen" in a release.
  const normalise = (value) => teamIdentities.foldAscii(String(value || ''))
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  const condense = (value) => value.replace(TEAM_CONNECTOR_RE, ' ').replace(/\s+/g, ' ').trim();
  const haystackFull = normalise(title);
  const needleFull = normalise(teamName);
  if (needleFull.length < 3) return false;
  // sceneForm additionally strips the legal affixes providers carry and
  // releases omit — "Manchester City FC" against a "Manchester City" release.
  const needleScene = normalise(teamIdentities.sceneForm(teamName));
  const forms = [
    [haystackFull, needleFull],
    [condense(haystackFull), condense(needleFull)],
    [haystackFull, needleScene],
    [condense(haystackFull), condense(needleScene)],
  ];
  return forms.some(([hay, needle]) =>
    needle.length >= 3 && (' ' + hay + ' ').includes(' ' + needle + ' '));
}

// Words that legitimately sit in front of a club name in a release title.
const TEAM_LEADING_TOKENS = new Set(['vs', 'v', 'at', 'versus', 'and']);

// A club name can be a whole word inside a DIFFERENT club's name: AC Milan's
// short name is "Milan", which is present in "Inter Milan". Both the boundary
// regex and the contiguous matcher say yes, and Serie A would then attach an
// Inter fixture to a Milan one.
//
// The rule that separates them: whatever word precedes the match must belong to
// this same club. "Borussia Dortmund" is fine for a club named "Dortmund"
// because "Borussia" appears in one of its own naming forms; "Inter Milan" is
// not, because "Inter" appears in none of Milan's.
function teamPresent(title, forms) {
  const normalise = (value) => teamIdentities.foldAscii(String(value || ''))
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  const condense = (value) => value.replace(TEAM_CONNECTOR_RE, ' ').replace(/\s+/g, ' ').trim();
  const list = (Array.isArray(forms) ? forms : [forms]).filter(Boolean);
  if (!list.length) return false;

  // Every word this club is known by, in any supplied or derived form.
  const owned = new Set();
  // Letters of any initialism the provider uses in place of a spelled-out
  // prefix. football-data registers Atlético Mineiro as "CA Mineiro", and the
  // release writes "Atletico Mineiro" — so the leading word the release adds is
  // the expansion of a letter the provider abbreviated. Without this the rule
  // below rejects a club's own fuller name.
  const initials = new Set();
  for (const form of list) {
    for (const variant of [normalise(form), normalise(teamIdentities.sceneForm(form))]) {
      for (const token of variant.split(' ')) {
        if (!token) continue;
        owned.add(token);
      }
    }
  }
  // Only the short prefix of a MULTI-WORD form counts as an abbreviation the
  // release might spell out. A standalone three-letter code must not: MIL is
  // AC Milan's tla, and letting its letters license a leading word would put
  // "Inter" (i, from MIL) straight back through the gap this rule closes.
  for (const form of list) {
    const tokens = normalise(form).split(' ');
    if (tokens.length < 2) continue;
    for (const token of tokens.slice(0, -1)) {
      if (token.length <= 3) for (const letter of token) initials.add(letter);
    }
  }

  const haystacks = [normalise(title)];
  haystacks.push(condense(haystacks[0]));
  for (const form of list) {
    const variants = new Set();
    for (const base of [normalise(form), normalise(teamIdentities.sceneForm(form))]) {
      if (base) { variants.add(base); variants.add(condense(base)); }
    }
    for (const needle of variants) {
      if (needle.length < 3) continue;
      const needleTokens = needle.split(' ');
      for (const hay of haystacks) {
        const tokens = hay.split(' ');
        for (let i = 0; i + needleTokens.length <= tokens.length; i += 1) {
          if (needleTokens.some((token, offset) => tokens[i + offset] !== token)) continue;
          const before = i > 0 ? tokens[i - 1] : null;
          if (before === null) return true;
          if (owned.has(before)) return true;
          if (TEAM_LEADING_TOKENS.has(before)) return true;
          // A number is a date fragment or a seeding, never another club.
          if (/^\d+$/.test(before)) return true;
          // A spelled-out word standing in for a letter the provider
          // abbreviated: "Atletico" for the A of "CA Mineiro". Deliberately
          // narrow — "Inter" before "Milan" starts with I, which is in none of
          // AC Milan's initials, so that collision stays rejected.
          if (before.length >= 4 && initials.has(before[0])) return true;
        }
      }
    }
  }
  return false;
}

function createGenericPromotion(spec) {
  if (!spec || !spec.id) return null;
  const id = String(spec.id);
  const name = String(spec.name || id);
  const idPrefix = String(spec.idPrefix || id);
  const posterShape = spec.posterShape || 'landscape';

  // 0.38.0: source dispatch. Backward compat: specs without `source` are
  // treated as TSDB (the only source pre-0.38.0). For football-data,
  // competitionId replaces leagueId as the per-source identifier.
  // Per-team scoping. A league feed is fetched whole (one call either way) and
  // then narrowed to one club's fixtures, which is what lets the Configure-page
  // wizard turn "my team" into a catalog without a per-team endpoint existing
  // for every sport. football-data is the exception: its team feed is already
  // scoped, so a teamId there needs no filter.
  const teamFilter = (spec.teamFilter && (spec.teamFilter.id || (spec.teamFilter.names || []).length))
    ? {
      id: String(spec.teamFilter.id || '').trim(),
      names: (Array.isArray(spec.teamFilter.names) ? spec.teamFilter.names : [])
        .map((value) => String(value || '').trim()).filter(Boolean),
    }
    : null;

  const sourceKind = String(spec.source || 'tsdb');
  let sourceObj;
  if (sourceKind === 'football-data') {
    sourceObj = spec.teamId
      ? { type: 'football-data', teamId: String(spec.teamId) }
      : { type: 'football-data', competitionId: String(spec.competitionId || '') };
  } else if (sourceKind === 'sport-video') {
    // Release-first ingestion: the "source" is SSS's own record of what the
    // discovery index published and no fixture feed claimed.
    sourceObj = { type: 'sport-video', sport: String(spec.sport || '') };
  } else if (sourceKind === 'api-football') {
    sourceObj = { type: 'api-football', leagueId: String(spec.leagueId || '') };
  } else if (sourceKind === 'uefa') {
    sourceObj = { type: 'uefa', competitionId: String(spec.competitionId || '') };
  } else if (sourceKind === 'tmdb') {
    // 0.42.13 - TMDB TV show (Match of the Day, ITV highlights, etc.).
    // scripts/refresh.js dispatches to lib/sources/tmdb.js which returns one
    // record per episode with air_date. transform.fromTmdb converts each to
    // an event whose date drives DARKSPORT-style search title generation.
    sourceObj = Array.isArray(spec.tvIds) && spec.tvIds.length
      ? { type: 'tmdb', tvIds: spec.tvIds.map(String) }
      : { type: 'tmdb', tvId: String(spec.tvId || '') };
  } else if (sourceKind === 'onefc') {
    sourceObj = { type: 'onefc' };
  } else if (sourceKind === 'mlb') {
    sourceObj = { type: 'mlb' };
  } else if (sourceKind === 'espn') {
    // ESPN's scoreboard serves several leagues from one adapter, so the
    // league identifier travels with the source rather than the type.
    sourceObj = { type: 'espn', league: String(spec.league || '').trim().toLowerCase() };
  } else {
    sourceObj = { type: 'thesportsdb', leagueId: String(spec.leagueId || '') };
  }
  const templates = Array.isArray(spec.searchTitleTemplates) && spec.searchTitleTemplates.length
    ? spec.searchTitleTemplates : ['{name}', '{name} {year}'];
  const keywords = (Array.isArray(spec.relevanceKeywords) ? spec.relevanceKeywords : [])
    .map((k) => String(k || '').toLowerCase().trim()).filter(Boolean);
  const promotionAliases = (Array.isArray(spec.promotionAliases) ? spec.promotionAliases : [])
    .map((alias) => promotionRuleTools.stripEventStageSuffix(String(alias || '').trim()))
    .filter(Boolean)
    .filter((alias, index, allAliases) => allAliases.findIndex((value) =>
      value.toLowerCase() === alias.toLowerCase()) === index)
    .slice(0, 20);
  const matchKeywords = Array.from(new Set(keywords.concat(
    promotionAliases.map((alias) => alias.toLowerCase())
  )));
  const rawExclusionKeywords = (Array.isArray(spec.exclusionKeywords) ? spec.exclusionKeywords : [])
    .map((term) => String(term || '').toLowerCase().trim()).filter(Boolean).slice(0, 20);
  const sanitizedRules = promotionRuleTools.sanitizeMatchingRules(
    name, promotionAliases, matchKeywords, rawExclusionKeywords
  );
  const exclusionKeywords = sanitizedRules.exclusions;

  // 0.40.0 — resolve team + league aliases.
  //   - `teamAliasPreset` pulls a baked-in table (e.g. all 20 EPL clubs).
  //   - `teamAliases` object overrides / extends the preset entry-by-entry.
  //   - `leagueAliases` array supplies league-prefix variants for search.
  // Preset gives users comprehensive coverage without hand-typing 40+ clubs;
  // overrides let them fix any single-entry issue without editing the preset.
  const aliasPresets = require('./team-alias-presets');
  const presetName = spec.teamAliasPreset ? String(spec.teamAliasPreset) : null;
  const presetTable = presetName ? aliasPresets.getPreset(presetName) : null;
  const overrideTable = (spec.teamAliases && typeof spec.teamAliases === 'object')
    ? spec.teamAliases : null;
  let teamAliasLookup = null;
  if (presetTable || overrideTable) {
    const teamAliasMap = Object.assign({}, presetTable || {}, overrideTable || {});
    // 0.40.1 — pre-build the bidirectional lookup once per promotion load.
    // Every form (canonical, alias, FC-trimmed) becomes a key so we can match
    // shortName from football-data OR long-form from TSDB with one code path.
    teamAliasLookup = buildAliasLookup(teamAliasMap);
  }
  const explicitLeagueAliases = Array.isArray(spec.leagueAliases) ? spec.leagueAliases : null;
  const presetLeagueAliases = presetName ? aliasPresets.getLeagueAliasDefaults(presetName) : [];
  const leagueAliasList = (explicitLeagueAliases && explicitLeagueAliases.length)
    ? explicitLeagueAliases.map((s) => String(s || '').trim()).filter(Boolean)
    : presetLeagueAliases;

  // 0.42.3 — Football-specific "require a date in the release title" strictness.
  // Football scene releases almost universally include YYYY.MM.DD; anything
  // without one is highlights, season review, documentary, or noise. Auto-on
  // when a team-alias preset is chosen; the operator can override via spec.
  const requireDateInTitle = (spec.requireDateInTitle !== undefined)
    ? !!spec.requireDateInTitle
    : !!presetName;      // default: football promotions on, others off

  // Per-promotion provider toggles ('torbox' | 'uu' | 'easynews').
  // Consumed in lib/streams.js handleStream to skip specific pipelines for
  // events from this promotion. Especially useful for football where the
  // TorBox/Prowlarr pipeline is slow-and-mostly-empty and just blocks the
  // faster provider pipelines.
  const disabledPipelines = Array.isArray(spec.disabledPipelines)
    ? spec.disabledPipelines.map((s) => String(s || '').toLowerCase().trim()).filter(Boolean)
    : [];

  return {
    id,
    name,
    idPrefix,
    enabled: true,
    isCustom: true,                                     // admin-UI provenance marker
    source: sourceObj,
    posterShape,
    ignoredExclusionKeywords: sanitizedRules.removedExclusions,
    disabledPipelines,
    allowForeignLanguage: !!spec.allowForeignLanguage,
    // UU fans a single request out across its configured indexers. Keep the
    // default compact so a generated promotion cannot overload that stack.
    uuMaxQueries: Math.max(1, Math.min(12, Number(spec.uuMaxQueries) || 6)),
    defaults: {
      poster: String(spec.poster || ''),
      fanart: String(spec.fanart || ''),
      logo:   String(spec.logo   || ''),
    },
    wikipediaTitle(_n)   { return null; },
    classify(_n)         { return 'event'; },
    shortHandle(eventName) {
      return eventName ? String(eventName).trim().replace(/\s+/g, ' ') : null;
    },
    buildAliases(eventName) {
      if (!eventName) return [];
      const t = String(eventName).trim();
      return [t, t.replace(/\s+/g, '.')];
    },
    searchTitles(event) {
      const eventName = event && event.name;
      if (!eventName) return [];
      const date = event.date || '';
      const year = date ? date.slice(0, 4) : '';

      // 0.40.0 — if this is a matchup event AND we have a team alias map,
      // expand into every home×away variant + apply templates over each.
      // Also emit league-prefixed variants ("EPL Man United vs Forest") to
      // catch releases whose league prefix comes before the teams.
      let nameVariants = [eventName];
      const plainSplit = splitMatchup(eventName);
      if (teamAliasLookup || (event && event.teamNames)) {
        const split = plainSplit;
        if (split) {
          // 0.41.1 — filter to search-worthy forms only. FC/CF-suffixed and
          // fan-nickname forms are relevance-match-only (used later in
          // isRelevantStreamTitle) but never as search queries.
          const homes = eventTeamAliases(event, 'home', split.home, teamAliasLookup).filter(isSearchWorthyForm);
          const aways = eventTeamAliases(event, 'away', split.away, teamAliasLookup).filter(isSearchWorthyForm);
          if (homes.length && aways.length) {
            nameVariants = crossProductMatchups(homes, aways);
          }
          if (nameVariants.length === 0) nameVariants = [eventName];
        }
      }

      // Generic matchup coverage without a curated alias preset. Metadata
      // normally uses home vs away; releases often reverse it or use `@`.
      if (plainSplit) {
        nameVariants.push(plainSplit.away + ' vs ' + plainSplit.home);
        nameVariants.push(plainSplit.home + ' @ ' + plainSplit.away);
        nameVariants.push(plainSplit.away + ' @ ' + plainSplit.home);
        nameVariants = Array.from(new Set(nameVariants));
      }

      const out = new Set();
      for (const nameVariant of nameVariants) {
        for (const tpl of templates) {
          const usesPromotion = tpl.includes('{promotion}');
          const promotionVariants = usesPromotion
            ? (promotionAliases.length ? promotionAliases.slice(0, 8) : [name])
            : [''];
          const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const canonicalPrefix = new RegExp('^' + escapedName + '(?:[\\s._-]+|$)', 'i');
          const templateName = usesPromotion
            ? (nameVariant.replace(canonicalPrefix, '').trim() || nameVariant)
            : nameVariant;
          for (const promotionVariant of promotionVariants) {
            const ctx = { name: templateName, promotion: promotionVariant, year, date };
            const filled = applyTitleTemplate(tpl, ctx).trim().replace(/\s+/g, ' ');
            if (filled) out.add(filled);
          }
        }
      }
      if (plainSplit && date) {
        const parts = date.split('-');
        const dmy = parts.length === 3 ? parts[2] + '.' + parts[1] + '.' + parts[0] : '';
        out.add(eventName + ' ' + date);
        if (dmy) out.add(plainSplit.away + ' @ ' + plainSplit.home + ' ' + dmy);
      }
      // League-prefix variants for the shortest matchup variant only — this
      // keeps the query count bounded while still covering "EPL team-a vs team-b".
      if (leagueAliasList.length && nameVariants.length) {
        const shortest = nameVariants
          .slice()
          .sort((a, b) => a.length - b.length)[0];
        for (const prefix of leagueAliasList.slice(0, 4)) {
          out.add((prefix + ' ' + shortest).replace(/\s+/g, ' ').trim());
        }
      }


      // Promotion aliases learned from real releases. Replace a canonical
      // promotion prefix where possible; otherwise prefix the shortest event
      // variant. Capped to avoid multiplying provider calls unexpectedly.
      if (promotionAliases.length && nameVariants.length) {
        const shortest = nameVariants.slice().sort((a, b) => a.length - b.length)[0];
        const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const canonicalPrefix = new RegExp('^' + escapedName + '(?:[\\s._-]+|$)', 'i');
        for (const alias of promotionAliases.slice(0, 8)) {
          const aliasVariant = canonicalPrefix.test(shortest)
            ? shortest.replace(canonicalPrefix, alias + ' ')
            : alias + ' ' + shortest;
          out.add(aliasVariant.replace(/\s+/g, ' ').trim());
        }
      }

      // Hard cap so an operator with a giant alias table doesn't fan out
      // 200 queries per event.
      return Array.from(out).slice(0, 60);
    },
    isRelevantStreamTitle(title, event) {
      if (!title) return { ok: false, reason: 'no-title' };
      const t = title.toLowerCase();
      const sceneText = normaliseSceneText(title);
      const excluded = exclusionKeywords.find((term) =>
        t.includes(term) || sceneText.includes(normaliseSceneText(term))
      );
      if (excluded) return { ok: false, reason: 'excluded:' + excluded };

      // 0.41.1 — check team-alias match FIRST. If both home AND away team
      // aliases hit, we're highly confident this is the right event — so
      // the keyword check becomes redundant (a title like "Man United vs
      // Nottingham Forest 1080p WEB-DL" is unambiguous even without "EPL"
      // in it). Skip keyword check in that case.
      //
      // 0.42.1 — use word-boundary regex, NOT substring includes(). The old
      // check treated "CHE" (Chelsea TLA) as a hit inside "manCHEster",
      // which caused Chelsea streams to include Manchester United fixtures.
      // \bche\b won't match "manchester" because c is preceded by n (both
      // word chars, no boundary). Precompiled per-alias so we amortise the
      // regex construction cost across all candidate titles.
      let teamAliasPassed = false;
      let teamAliasApplicable = false;

      // 0.86.2 — structured names from the adapter are authoritative, and are
      // used WITHOUT parsing the fixture title.
      //
      // Every branch below reaches its team lists by splitting event.name on a
      // separator, which silently does nothing when the name uses a separator
      // the splitter does not know. ESPN names a fixture "Away at Home", and
      // " at " was not in the list, so for NFL and NBA no team check ran at
      // all: relevance fell through to the keyword check, the keyword was
      // satisfied by Sport-Video's category blurb, and every NFL fixture
      // matched every American-football release on its date. Reading the
      // supplied names directly removes the dependency on title formatting —
      // and on getting home and away the right way round, which splitting
      // "Away at Home" as home-first also got wrong.
      const suppliedNames = (event && event.teamNames) || null;
      const suppliedHome = suppliedNames && Array.isArray(suppliedNames.home) ? suppliedNames.home : [];
      const suppliedAway = suppliedNames && Array.isArray(suppliedNames.away) ? suppliedNames.away : [];
      if (suppliedHome.length && suppliedAway.length) {
        teamAliasApplicable = true;
        const homes = eventTeamAliases(event, 'home', suppliedHome[0], teamAliasLookup);
        const aways = eventTeamAliases(event, 'away', suppliedAway[0], teamAliasLookup);
        // plainTeamMatch is the second chance: aliasBoundaryMatch compares the
        // alias literally, so it misses the accents and legal affixes that one
        // feed keeps and another drops.
        if (!teamPresent(title, homes)) return { ok: false, reason: 'no-home-team-alias' };
        if (!teamPresent(title, aways)) return { ok: false, reason: 'no-away-team-alias' };
        teamAliasPassed = true;
      } else if ((teamAliasLookup || (event && event.teamNames)) && event && event.name) {
        const split = splitMatchup(event.name);
        if (split) {
          teamAliasApplicable = true;
          const homes = eventTeamAliases(event, 'home', split.home, teamAliasLookup);
          const aways = eventTeamAliases(event, 'away', split.away, teamAliasLookup);
          const homeHit = teamPresent(title, homes) || homes.some((h) => aliasBoundaryMatch(t, h));
          const awayHit = teamPresent(title, aways) || aways.some((a) => aliasBoundaryMatch(t, a));
          if (!homeHit) return { ok: false, reason: 'no-home-team-alias' };
          if (!awayHit) return { ok: false, reason: 'no-away-team-alias' };
          teamAliasPassed = true;
        }
      }

      // Canonical team names are still strong evidence when no alias preset
      // exists. Team order is deliberately irrelevant.
      if (!teamAliasApplicable && event && event.name) {
        const split = splitMatchup(event.name);
        if (split) {
          teamAliasApplicable = true;
          const homeHit = plainTeamMatch(title, split.home);
          const awayHit = plainTeamMatch(title, split.away);
          // Tournament aliases (for example "UCL") identify a competition,
          // not a fixture. Missing either selected team is a hard rejection.
          if (!homeHit) return { ok: false, reason: 'no-home-team' };
          if (!awayHit) return { ok: false, reason: 'no-away-team' };
          teamAliasPassed = true;
        }
      }

      const dateVerdict = dateMatchesEvent(title, event);
      // Both teams plus the exact fixture date outrank generated promotion
      // keywords, which may be overly narrow in quick-created promotions.
      if (teamAliasPassed && dateVerdict === 'match') return { ok: true };
      if (teamAliasPassed && dateVerdict === 'wrong-date') return { ok: false, reason: 'wrong-date' };

      // Keyword check — enforced UNLESS both team aliases matched above.
      // For non-matchup promotions (UFC PPV, WWE, F1) team-alias is not
      // applicable and the keyword check remains the primary filter.
      if (!teamAliasPassed && matchKeywords.length > 0) {
        const kwHit = matchKeywords.some((kw) =>
          t.includes(kw) || sceneText.includes(normaliseSceneText(kw))
        );
        if (!kwHit) return { ok: false, reason: 'no-keyword-match' };
      }

      // 0.42.3 — Date-precise match. For football (and any promotion where
      // requireDateInTitle is set), the release title MUST contain a date
      // matching the fixture within ±1 day. This is what distinguishes
      // "EPL.2026.05.24.Man.City.vs.Villa" from an old
      // "EPL.2025.05.24.Man.City.vs.Villa" — same teams, different year, both
      // pass a naive team+year check but only one is the fixture we want.
      if (dateVerdict === 'match') return { ok: true };   // date match is stronger than any other check
      if (dateVerdict === 'wrong-date') return { ok: false, reason: 'wrong-date' };
      // dateVerdict === 'none' — no date detected
      if (requireDateInTitle) {
        return { ok: false, reason: 'no-date-in-title' };
      }

      // Fallback: year check (only for promotions where date isn't required —
      // UFC PPV, WWE, F1, MotoGP, boxing all have their own numbering-based
      // isRelevantStreamTitle and don't reach this codepath).
      if (!yearMatchesEvent(title, event)) return { ok: false, reason: 'wrong-year' };
      return { ok: true };
    },
    catalogs: [
      { id: id + '-upcoming', name: name + ' Upcoming',
        filter: (ev) => ev.date && ev.date > isoToday(),
        sort: (a, b) => (a.date || '').localeCompare(b.date || '') },
      { id: id + '-recent', name: name + ' Recent',
        filter: (ev) => ev.date && ev.date <= isoToday(),
        sort: (a, b) => (b.date || '').localeCompare(a.date || '') },
    ],
    eventScope: defaultEventScope,
    includeEvent(event) {
      if (!teamFilter) return true;
      if (!event) return false;
      const source = event.source || {};
      if (teamFilter.id
        && (String(source.homeTeamId || '') === teamFilter.id
          || String(source.awayTeamId || '') === teamFilter.id)) return true;
      const sides = event.teamNames || {};
      for (const side of [sides.home, sides.away]) {
        if (!Array.isArray(side)) continue;
        for (const supplied of side) {
          for (const wanted of teamFilter.names) {
            if (String(supplied).toLowerCase() === String(wanted).toLowerCase()) return true;
          }
        }
      }
      // Last resort for a feed that supplies neither ids nor structured sides.
      return teamFilter.names.some((wanted) => plainTeamMatch(event.name || '', wanted));
    },
    genres(_ev)          { return ['Sports']; },
  };
}

// 0.35.0: hot-reloadable promotion registry.
//
// Hardcoded promotions are stable across the process lifetime. Custom
// promotions (from data/custom-promotions.json) get rebuilt when the
// admin saves an edit — `reload()` is called by the /admin/promotions
// save route. We mutate the existing `all` / `enabled` / `byPrefix`
// containers in-place rather than reassigning so existing `const promotions
// = require('./promotions')` references stay valid.

// Match of the Day and Match of the Day 2 are separate TMDB shows, but their
// releases belong together in one SSS catalog. Both are normalised to the
// indexer naming convention "Match of the Day DD MM YYYY".
const matchOfTheDay = createGenericPromotion({
  id: 'motd',
  name: 'Match of the Day',
  idPrefix: 'motd',
  source: 'tmdb',
  tvId: '224',
  posterShape: 'landscape',
  poster: brandedPoster(
    'motd-placeholder.png',
    'https://raw.githubusercontent.com/Monkfish1337/Serioussportsync/main/public/motd-placeholder.png'
  ),
  fanart: brandedPoster(
    'motd-placeholder.png',
    'https://raw.githubusercontent.com/Monkfish1337/Serioussportsync/main/public/motd-placeholder.png'
  ),
  searchTitleTemplates: ['{name}'],
  relevanceKeywords: ['match of the day'],
  requireDateInTitle: true,
});
matchOfTheDay.isCustom = false;
matchOfTheDay.source = { type: 'tmdb', tvIds: ['224', '3231'] };
matchOfTheDay.formatEventName = function formatMatchOfTheDayName(_sourceName, raw) {
  const parts = String((raw && raw.air_date) || '').split('-');
  if (parts.length !== 3) return 'Match of the Day';
  return 'Match of the Day ' + parts[2] + ' ' + parts[1] + ' ' + parts[0];
};

// The football season runs July-June. Keeping MOTD to the active season
// prevents the broad global archive window from filling this weekly-show
// catalog with stale episodes. The same predicate is used by refresh pruning
// and both catalogs, so events naturally move from Upcoming to Recent after
// their air date without duplication.
function matchOfTheDaySeasonBounds() {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const currentYear = today.getUTCFullYear();
  const startYear = today.getUTCMonth() >= 6 ? currentYear : currentYear - 1;
  return { dateFrom: startYear + '-07-01', dateTo: (startYear + 1) + '-06-30' };
}
function matchOfTheDayInCurrentSeason(ev) {
  if (!ev || !ev.date) return false;
  const bounds = matchOfTheDaySeasonBounds();
  return ev.date >= bounds.dateFrom && ev.date <= bounds.dateTo;
}
matchOfTheDay.sourceDateRange = matchOfTheDaySeasonBounds;
matchOfTheDay.eventScope = matchOfTheDayInCurrentSeason;
matchOfTheDay.catalogs = [
  { id: 'motd-upcoming', name: 'Match of the Day Upcoming',
    filter: (ev) => matchOfTheDayInCurrentSeason(ev) && ev.date > isoToday(),
    sort: (a, b) => (a.date || '').localeCompare(b.date || '') },
  // Keep the original id so existing user catalog selections continue to
  // resolve; only its label becomes explicit now that Upcoming also exists.
  { id: 'motd', name: 'Match of the Day Recent',
    filter: (ev) => matchOfTheDayInCurrentSeason(ev) && ev.date <= isoToday(),
    sort: (a, b) => (b.date || '').localeCompare(a.date || '') },
];

// A team-scoped football-data feed combines Manchester United fixtures from
// every competition available to the configured API key. Team ID 66 is the
// stable football-data.org identifier for Manchester United FC.
const manUnited = createGenericPromotion({
  id: 'manutd',
  name: 'Man United',
  idPrefix: 'manutd',
  source: 'football-data',
  teamId: '66',
  posterShape: 'landscape',
  poster: 'https://crests.football-data.org/66.png',
  fanart: 'https://crests.football-data.org/66.png',
  teamAliasPreset: 'man-united',
  leagueAliases: [
    'EPL', 'Premier League', 'FA Cup', 'EFL Cup',
    'Carabao Cup', 'UCL', 'Champions League', 'Europa League',
  ],
  searchTitleTemplates: ['{name} {date}', '{name}'],
  relevanceKeywords: ['manchester united', 'man united', 'man utd', 'mufc'],
  requireDateInTitle: true,
});
manUnited.isCustom = false;
// Four precise UU requests are enough for team fixtures. The direct-search
// endpoint fans every query out in parallel across its configured indexers;
// sending the generic default of twelve can overload a local UU/Prowlarr
// stack and time out before any otherwise-valid release is returned.
manUnited.uuMaxQueries = 4;
const manUnitedBaseSearchTitles = manUnited.searchTitles.bind(manUnited);
manUnited.searchTitles = function manUnitedSearchTitles(event) {
  const base = manUnitedBaseSearchTitles(event);
  if (!event || !event.date) return base;

  const dateParts = String(event.date).split('-');
  if (dateParts.length !== 3) return base;
  const sceneDate = dateParts.join(' ');
  const competitionCode = String(event.competitionCode || '').toUpperCase();
  const prefixByCode = {
    PL: 'EPL', FAC: 'FA Cup', ELC: 'EFL Cup', CL: 'UCL',
    EL: 'Europa League', ECL: 'Conference League',
  };
  const prefixes = Array.from(new Set([
    prefixByCode[competitionCode],
    event.competition,
    competitionCode,
  ].filter(Boolean)));
  const matchupNames = base
    .filter((title) => splitMatchup(title) && extractReleaseDates(title).length === 0)
    .filter((title) => !/^(?:EPL|Premier League|FA Cup|EFL Cup|Carabao Cup|UCL|Champions League|Europa League)\b/i.test(title))
    .slice(0, 8);
  const sceneFirst = [];
  for (const prefix of prefixes) {
    for (const matchupName of matchupNames) {
      sceneFirst.push(prefix + ' ' + sceneDate + ' ' + matchupName);
    }
  }
  const datedWithoutPrefix = base
    .filter((title) => splitMatchup(title) && extractReleaseDates(title).length > 0)
    .slice(0, 2);
  // Put the form actually used by football release groups first so bounded
  // provider clients do not spend their query budget on broad fallbacks. Keep
  // two date+teams variants without a competition prefix in the first four as
  // a fallback for friendlies and indexers that omit the league label.
  return Array.from(new Set([
    ...sceneFirst.slice(0, 2),
    ...datedWithoutPrefix,
    ...sceneFirst.slice(2),
    ...base,
  ])).slice(0, 60);
};
manUnited.torrentSearchTitles = function manUnitedTorrentSearchTitles(event) {
  const primary = manUnited.searchTitles(event)[0];
  if (!primary) return [];
  // Prowlarr/indexers already return all release encodes for this precise
  // fixture query. Do not fan out HCAFC, nickname, @, date-last, or undated
  // variants: they create noisy searches and can hide the useful result
  // behind the companion's own query cap.
  return [primary.replace(/\s+vs\s+/i, ' Vs ')];
};
manUnited.includeEvent = function includeManchesterUnitedFixture(ev) {
  const matchup = splitMatchup(ev && ev.name);
  if (!matchup) return false;
  const unitedNames = new Set([
    'manchester united', 'manchester united fc', 'man united', 'man utd',
    'mun', 'mufc', 'red devils',
  ]);
  const normaliseTeam = (name) => String(name || '').toLowerCase()
    .replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const isUnited = (name) => unitedNames.has(normaliseTeam(name));
  return isUnited(matchup.home) || isUnited(matchup.away);
};
manUnited.genres = function manUnitedGenres() {
  return ['Sports', 'Football', 'Manchester United'];
};

// MLB ships with the public official schedule and the release layout observed
// across sports indexers: "MLB YEAR / RS / DD.MM.YYYY / Away @ Home".
// Keep the punctuation out of the actual queries because indexers tokenize it,
// but preserve the field order and @ variant that uploaders consistently use.
const mlb = createGenericPromotion({
  id: 'mlb',
  name: 'MLB',
  idPrefix: 'mlb',
  source: 'mlb',
  posterShape: 'landscape',
  promotionAliases: ['MLB', 'Major League Baseball'],
  searchTitleTemplates: [
    '{promotion} {date_dotted} {name}',
    '{promotion} {date_spaced} {name}',
    '{promotion} {year} {name}',
    '{name} {date_dotted}',
  ],
  relevanceKeywords: ['mlb', 'major league baseball'],
  exclusionKeywords: ['mlb network', 'highlights'],
  requireDateInTitle: true,
});
mlb.isCustom = false;
mlb.uuMaxQueries = 6;
const mlbBaseSearchTitles = mlb.searchTitles.bind(mlb);
mlb.searchTitles = function mlbSearchTitles(event) {
  if (!event || !event.name) return [];
  const matchup = splitMatchup(event.name);
  const date = String(event.date || '');
  const parts = date.split('-');
  const year = parts.length === 3 ? parts[0] : '';
  const dotted = date.replace(/-/g, '.');
  const dmy = parts.length === 3 ? parts[2] + '.' + parts[1] + '.' + parts[0] : '';
  const observed = matchup && year && dmy ? [
    'MLB ' + year + ' RS ' + dmy + ' ' + matchup.home + ' @ ' + matchup.away,
    'MLB ' + year + ' ' + dmy + ' ' + matchup.home + ' @ ' + matchup.away,
    'MLB ' + dotted + ' ' + matchup.home + ' vs ' + matchup.away,
    'MLB ' + matchup.home + ' @ ' + matchup.away + ' ' + dmy,
  ] : [];
  return Array.from(new Set(observed.concat(mlbBaseSearchTitles(event)))).slice(0, 40);
};
mlb.torrentSearchTitles = function mlbTorrentSearchTitles(event) {
  return mlb.searchTitles(event).slice(0, 4);
};
mlb.genres = function mlbGenres() {
  return ['Sports', 'Baseball', 'MLB'];
};

// Champions League ships ready to use with UEFA's official public match feed.
// It needs no provider account or key and can still be reassigned in Metadata.
const championsLeague = createGenericPromotion({
  id: 'ucl',
  name: 'UEFA Champions League',
  idPrefix: 'ucl',
  source: 'uefa',
  competitionId: '1',
  posterShape: 'landscape',
  teamAliasPreset: 'ucl',
  promotionAliases: ['UEFA Champions League', 'Champions League', 'UCL'],
  leagueAliases: ['UEFA Champions League', 'Champions League', 'UCL', 'UEFA CL'],
  searchTitleTemplates: [
    '{promotion} {date_dotted} {name}',
    '{promotion} {name} {date_dotted}',
    '{name} {date_dotted}',
  ],
  relevanceKeywords: ['uefa champions league', 'champions league', 'ucl'],
  exclusionKeywords: ['women', 'womens', 'u19', 'youth', 'highlights'],
  requireDateInTitle: true,
});
championsLeague.isCustom = false;
// UU waits for its complete Prowlarr fan-out before responding. Three focused
// variants keep the request inside SSS's stream deadline even when Prowlarr
// serialises indexer responses, while the curated exact scene form stays first.
championsLeague.uuMaxQueries = 3;
const championsLeagueBaseSearchTitles = championsLeague.searchTitles.bind(championsLeague);
championsLeague.searchTitles = function championsLeagueSearchTitles(event) {
  if (!event || !event.name) return [];
  const date = String(event.date || '');
  const dotted = date.replace(/-/g, '.');
  const generated = championsLeagueBaseSearchTitles(event);
  // Put the curated, release-friendly identity first while retaining UEFA's
  // formal full identity immediately behind it. This lets the source preserve
  // "Atlético de Madrid" while searches start with "Atletico Madrid" and does
  // the same generically for FC suffixes and every club in the UCL alias set.
  const preferred = dotted && generated.find((title) =>
    title.startsWith('UEFA Champions League ' + dotted + ' '));
  const preferredMatchup = preferred
    ? preferred.slice(('UEFA Champions League ' + dotted + ' ').length)
    : event.name;
  const dateParts = date.split('-');
  const dmy = dateParts.length === 3 ? dateParts[2] + '.' + dateParts[1] + '.' + dateParts[0] : '';
  const dmyHyphen = dateParts.length === 3 ? dateParts[2] + '-' + dateParts[1] + '-' + dateParts[0] : '';
  const readableLeg = String(event.leg || '').replace(/^1st\s+leg$/i, 'First Leg')
    .replace(/^2nd\s+leg$/i, 'Second Leg');
  const stage = [event.round, readableLeg].map((value) => String(value || '').trim()).filter(Boolean).join(' ');
  const observedVariants = [];
  if (dotted && stage) observedVariants.push(
    'UEFA Champions League ' + dotted + ' ' + stage + ' ' + preferredMatchup
  );
  if (dmy) observedVariants.push('UEFA Champions League ' + dmy + ' ' + preferredMatchup);
  if (dmyHyphen && /final/i.test(String(event.round || ''))) observedVariants.push(
    'UEFA Champions League FINAL ' + dmyHyphen + ' ' + preferredMatchup
  );
  const precise = dotted ? [
    'UEFA Champions League ' + dotted + ' ' + event.name,
    'Champions League ' + dotted + ' ' + event.name,
    'UCL ' + dotted + ' ' + event.name,
    event.name + ' ' + dotted,
  ] : [event.name];
  return Array.from(new Set((preferred ? [preferred] : []).concat(observedVariants, precise, generated))).slice(0, 60);
};
championsLeague.torrentSearchTitles = function championsLeagueTorrentSearchTitles(event) {
  const queries = championsLeague.searchTitles(event);
  if (!queries.length) return [];
  const focused = [queries[0],
    queries.find((query) => /^Champions League\b/i.test(query)),
    queries.find((query) => /^UCL\b/i.test(query)),
  ].filter(Boolean).map((query) => query.replace(/\s+vs\s+/i, ' Vs '));
  return Array.from(new Set(focused)).slice(0, 3);
};
championsLeague.genres = function championsLeagueGenres() {
  return ['Sports', 'Football', 'UEFA Champions League'];
};

// NFL and NBA ride the ESPN adapter for the reason documented in
// lib/sources/espn.js: TheSportsDB's shared key caps a season at ~15 events.
// Both are matchup leagues with the same "Away at Home" naming MLB uses, so
// they reuse its query shape rather than inventing another.
const nfl = createGenericPromotion({
  id: 'nfl',
  name: 'NFL',
  idPrefix: 'nfl',
  source: 'espn',
  league: 'nfl',
  posterShape: 'landscape',
  promotionAliases: ['NFL', 'National Football League'],
  searchTitleTemplates: [
    '{promotion} {date_dotted} {name}',
    '{promotion} {year} {name}',
    '{name} {date_dotted}',
  ],
  relevanceKeywords: ['nfl', 'national football league'],
  // "RedZone" and the weekly studio shows carry team names and would otherwise
  // match a fixture on the same day.
  exclusionKeywords: ['redzone', 'red zone', 'nfl network', 'hard knocks',
    'total access', 'highlights', 'all 22', 'condensed'],
  requireDateInTitle: true,
});
nfl.isCustom = false;
nfl.uuMaxQueries = 6;

const nba = createGenericPromotion({
  id: 'nba',
  name: 'NBA',
  idPrefix: 'nba',
  source: 'espn',
  league: 'nba',
  posterShape: 'landscape',
  promotionAliases: ['NBA', 'National Basketball Association'],
  searchTitleTemplates: [
    '{promotion} {date_dotted} {name}',
    '{promotion} {year} {name}',
    '{name} {date_dotted}',
  ],
  relevanceKeywords: ['nba', 'national basketball association'],
  exclusionKeywords: ['nba tv', 'summer league', 'g league', 'highlights',
    'condensed', 'all access'],
  requireDateInTitle: true,
});
nba.isCustom = false;
nba.uuMaxQueries = 6;

const wnba = createGenericPromotion({
  id: 'wnba',
  name: 'WNBA',
  idPrefix: 'wnba',
  source: 'espn',
  league: 'wnba',
  posterShape: 'landscape',
  promotionAliases: ['WNBA', "Women's National Basketball Association"],
  searchTitleTemplates: [
    '{promotion} {date_dotted} {name}',
    '{promotion} {year} {name}',
    '{name} {date_dotted}',
  ],
  relevanceKeywords: ['wnba'],
  exclusionKeywords: ['highlights', 'condensed', 'all access'],
  requireDateInTitle: true,
});
wnba.isCustom = false;
wnba.uuMaxQueries = 6;

const collegeFootball = createGenericPromotion({
  id: 'ncaaf',
  name: 'College Football',
  idPrefix: 'ncaaf',
  source: 'espn',
  league: 'ncaaf',
  posterShape: 'landscape',
  promotionAliases: ['NCAAF', 'NCAA Football', 'College Football'],
  searchTitleTemplates: [
    '{promotion} {date_dotted} {name}',
    '{promotion} {year} {name}',
    '{name} {date_dotted}',
  ],
  relevanceKeywords: ['ncaaf', 'ncaa football', 'college football'],
  exclusionKeywords: ['highlights', 'condensed', 'all access', 'gameday'],
  requireDateInTitle: true,
});
collegeFootball.isCustom = false;
collegeFootball.uuMaxQueries = 6;

// Domestic leagues on football-data.org, chosen from a real Sport-Video scan:
// these are the competitions whose releases the site actually carries and that
// no promotion claimed, so every fixture here was being discovered and thrown
// away. Codes are football-data's own; a key without access to one fails that
// promotion's refresh with a clear message and leaves the rest working.
//
// Matching needs no league keyword: Sport-Video names these bare ("Toulouse vs
// Lille 03.09.2026"), and both team names plus the fixture date already
// outrank keywords in isRelevantStreamTitle. The aliases below are for search
// title generation against indexers, which do prefix the competition.
const FOOTBALL_LEAGUES = [
  { id: 'laliga', name: 'La Liga', code: 'PD',
    aliases: ['La Liga', 'LaLiga', 'Spanish La Liga', 'Primera Division'],
    keywords: ['la liga', 'laliga', 'primera division'] },
  { id: 'epl', name: 'Premier League', code: 'PL',
    aliases: ['EPL', 'Premier League', 'English Premier League'],
    keywords: ['epl', 'premier league'] },
  { id: 'efl-championship', name: 'EFL Championship', code: 'ELC',
    aliases: ['EFL Championship', 'Championship', 'English Championship'],
    keywords: ['efl championship', 'english championship'] },
  { id: 'seriea', name: 'Serie A', code: 'SA',
    aliases: ['Serie A', 'Italy Serie A', 'Italian Serie A'],
    keywords: ['serie a'] },
  { id: 'brasileirao', name: 'Brasileirão', code: 'BSA',
    aliases: ['Brasileirao', 'Brasileirão', 'Serie A Brazil', 'Campeonato Brasileiro'],
    keywords: ['brasileirao', 'campeonato brasileiro'] },
  { id: 'ligue1', name: 'Ligue 1', code: 'FL1',
    aliases: ['Ligue 1', 'France Ligue 1', 'French Ligue 1'],
    keywords: ['ligue 1'] },
  { id: 'bundesliga', name: 'Bundesliga', code: 'BL1',
    aliases: ['Bundesliga', 'German Bundesliga', '1. Bundesliga'],
    keywords: ['bundesliga'] },
  { id: 'eredivisie', name: 'Eredivisie', code: 'DED',
    aliases: ['Eredivisie', 'Dutch Eredivisie', 'Netherlands Eredivisie'],
    keywords: ['eredivisie'] },
];

const footballLeagues = FOOTBALL_LEAGUES.map((league) => {
  const promotion = createGenericPromotion({
    id: league.id,
    name: league.name,
    idPrefix: league.id,
    source: 'football-data',
    competitionId: league.code,
    posterShape: 'landscape',
    promotionAliases: league.aliases,
    searchTitleTemplates: [
      '{promotion} {date_dotted} {name}',
      '{promotion} {date_spaced} {name}',
      '{name} {date_dotted}',
      '{name}',
    ],
    relevanceKeywords: league.keywords,
    exclusionKeywords: ['highlights', 'review', 'preview', 'match of the day'],
    requireDateInTitle: true,
  });
  promotion.isCustom = false;
  // Same reasoning as Man United: fixture queries are precise, and fanning
  // twelve of them across a local indexer stack times out before any of them
  // returns.
  promotion.uuMaxQueries = 4;
  return promotion;
});

// Release-first ingestion. One promotion per sport the discovery index labels,
// owning the releases no fixture feed claimed — rugby, tennis, the South
// American cups. See lib/sources/release-ingest.js for why this direction
// exists at all; in short, no feed covers everything the site carries, and a
// release nobody claims is content that would otherwise be discovered and
// discarded.
//
// Matching is trivial here because the event name IS the release name: the
// promotion has to accept the title it was built from, and reject the other
// fixtures sharing its date. Both teams plus the date already decide that.
const releaseIngest = require('./sources/release-ingest');

const discoveredPromotions = Object.keys(releaseIngest.SPORTS).map((sport) => {
  const label = releaseIngest.SPORTS[sport];
  const promotion = createGenericPromotion({
    id: releaseIngest.promotionIdFor(sport),
    name: 'Discovered ' + label,
    idPrefix: releaseIngest.promotionIdFor(sport),
    source: 'sport-video',
    sport,
    posterShape: 'landscape',
    // Bundled artwork only — a generic mark is the whole point, and inventing
    // a per-sport image file is not something a code change can do.
    poster: '/assets/logo-banner.png',
    fanart: '/assets/logo-banner.png',
    promotionAliases: [label],
    searchTitleTemplates: ['{name} {date_dotted}', '{name}'],
    // No competition keyword exists for these — the release title is all there
    // is, so the team names and the date carry the whole decision.
    relevanceKeywords: [],
    exclusionKeywords: ['highlights', 'preview', 'recap'],
    requireDateInTitle: true,
  });
  promotion.isCustom = false;
  promotion.uuMaxQueries = 2;
  // These events exist because a torrent already exists for them. Fanning out
  // to the wider indexer pipelines would spend budget re-finding what
  // Sport-Video handed over.
  promotion.disabledPipelines = ['uu', 'easynews'];
  promotion.genres = function discoveredGenres() { return ['Sports', label]; };

  // Relevance is replaced rather than wrapped, because the generic matcher
  // asks the wrong question here. It decides a non-matchup event on promotion
  // keywords, and a discovered promotion has none worth the name — which would
  // either accept every release on the right date (the NFL false-positive
  // shape) or reject the event's own release for lacking a keyword nobody
  // writes.
  //
  // The right question is exact and simple: this event was built FROM a release
  // title, so a relevant release still has to carry that title, on that date.
  const DISCOVERED_NOISE = /\b(?:highlights?|preview|recap|review|magazine)\b/i;
  promotion.isRelevantStreamTitle = function discoveredRelevance(title, event) {
    const text = String(title || '');
    if (!text || !event || !event.name) return { ok: false, reason: 'no-title' };
    if (DISCOVERED_NOISE.test(text)) return { ok: false, reason: 'excluded:noise' };
    if (!teamPresent(text, [event.name])) {
      return { ok: false, reason: 'release-does-not-name-this-event' };
    }
    const dateVerdict = dateMatchesEvent(text, event);
    if (dateVerdict === 'wrong-date') return { ok: false, reason: 'wrong-date' };
    // A dateless release is accepted: the record it came from is already keyed
    // to the day the site published it against, which is where the event's own
    // date came from.
    return { ok: true };
  };
  return promotion;
});

const HARDCODED = [ufc, one, wwe, aew, f1, boxing, motogp, matchOfTheDay, manUnited, championsLeague, mlb, nfl, nba, wnba, collegeFootball]
  .concat(footballLeagues).concat(discoveredPromotions);
const HARDCODED_DEFAULT_SOURCES = Object.fromEntries(
  HARDCODED.map((promotion) => [promotion.id, JSON.parse(JSON.stringify(promotion.source))])
);
const all = [];
const BUILTIN_BASE = new WeakMap();
const enabled = [];
const byPrefix = {};

function loadCustomPromotions() {
  // Lazy require — custom-promotions.js doesn't depend back on us, but
  // delaying the require keeps cold-start order forgiving.
  let cp;
  try { cp = require('./custom-promotions'); }
  catch (err) {
    console.error('[promotions] custom-promotions module load failed: ' + err.message);
    return [];
  }
  const specs = cp.list();
  const out = [];
  const hardcodedIds = new Set(HARDCODED.map((p) => p.id));
  for (const s of specs) {
    // A user-created UCL promotion may predate the shipped default introduced
    // in 0.76. Preserve that configuration instead of silently replacing it.
    if (hardcodedIds.has(s.id) && s.id !== 'ucl') {
      console.warn('[promotions] custom promotion "' + s.id + '" collides with hardcoded id — skipping');
      continue;
    }
    try {
      const p = createGenericPromotion(s);
      if (p) out.push(p);
    } catch (err) {
      console.error('[promotions] failed to build custom "' + s.id + '": ' + err.message);
    }
  }
  return out;
}

function rebuildIndexes() {
  enabled.length = 0;
  for (const p of all) if (p.enabled) enabled.push(p);
  for (const k of Object.keys(byPrefix)) delete byPrefix[k];
  for (const p of enabled) byPrefix[p.idPrefix] = p;
}

function applySourceAssignments(items) {
  let registry;
  try { registry = require('./metadata-sources'); }
  catch (err) {
    console.error('[promotions] metadata source registry unavailable: ' + err.message);
    return;
  }
  for (const promotion of items) {
    const fallback = promotion.isCustom
      ? promotion.source
      : HARDCODED_DEFAULT_SOURCES[promotion.id];
    let resolved;
    if (promotion.isCustom) {
      // System defaults with a coincidentally equal promotion ID must not
      // override a pre-existing custom promotion. Only an explicit saved
      // assignment applies to custom entries.
      const state = registry.load();
      const sourceRef = state.assignments && state.assignments[promotion.id];
      const definition = sourceRef ? registry.find(sourceRef) : null;
      resolved = {
        sourceRef: definition ? sourceRef : null,
        source: JSON.parse(JSON.stringify(definition ? definition.source : fallback)),
      };
    } else {
      resolved = registry.resolve(promotion.id, fallback);
    }
    promotion.source = resolved.source;
    promotion.sourceRef = resolved.sourceRef;
  }
}

function applyPromotionMatchingOverrides(items) {
  for (const promotion of items) {
    if (promotion.isCustom) continue;
    let base = BUILTIN_BASE.get(promotion);
    if (!base) {
      base = {
        searchTitles: promotion.searchTitles,
        isRelevantStreamTitle: promotion.isRelevantStreamTitle,
        uuMaxQueries: promotion.uuMaxQueries,
      };
      BUILTIN_BASE.set(promotion, base);
    }
    promotion.searchTitles = base.searchTitles;
    promotion.isRelevantStreamTitle = base.isRelevantStreamTitle;
    promotion.uuMaxQueries = base.uuMaxQueries;
    delete promotion.matchingOverride;
    delete promotion.matchingOverrideUpdatedAt;
    const saved = promotionOverrides.find(promotion.id);
    if (!saved) continue;
    const overlay = createGenericPromotion({
      id: promotion.id, name: promotion.name, source: 'tsdb', leagueId: '1',
      promotionAliases: saved.promotionAliases,
      relevanceKeywords: saved.relevanceKeywords,
      exclusionKeywords: saved.exclusionKeywords,
      searchTitleTemplates: saved.searchTitleTemplates,
      requireDateInTitle: saved.requireDateInTitle,
      allowForeignLanguage: saved.allowForeignLanguage,
    });
    const baseSearch = base.searchTitles.bind(promotion);
    const baseRelevant = base.isRelevantStreamTitle.bind(promotion);
    promotion.searchTitles = function overriddenSearchTitles(event) {
      const output = [], seen = new Set();
      for (const value of baseSearch(event).concat(overlay.searchTitles(event))) {
        const clean = String(value || '').trim();
        const key = clean.toLowerCase();
        if (clean && !seen.has(key)) { seen.add(key); output.push(clean); }
      }
      return output.slice(0, 60);
    };
    promotion.isRelevantStreamTitle = function overriddenRelevance(title, event) {
      const learned = overlay.isRelevantStreamTitle(title, event);
      if (learned.ok) return learned;
      if (/^(?:excluded:|wrong-date|no-date-in-title|foreign-language)/.test(String(learned.reason || ''))) {
        return learned;
      }
      return baseRelevant(title, event);
    };
    // Preserve curated built-in queries while leaving room for confirmed
    // user aliases in providers that enforce a per-promotion cap.
    promotion.uuMaxQueries = Math.max(Number(base.uuMaxQueries) || 0, 6);
    promotion.matchingOverride = true;
    promotion.matchingOverrideUpdatedAt = saved.updatedAt;
  }
}

function reload() {
  const custom = loadCustomPromotions();
  const customIds = new Set(custom.map((promotion) => promotion.id));
  all.length = 0;
  for (const p of HARDCODED) {
    if ((p.id === 'ucl' || p.id === 'mlb') && customIds.has(p.id)) continue;
    all.push(p);
  }
  for (const p of custom) {
    // Legacy wizard-created UCL/MLB promotions keep their metadata and art,
    // but receive the same corpus-backed provider searches and acceptance
    // rules as new installs. Without this upgrade path an existing custom
    // promotion would keep its older broad aliases and miss the very releases
    // the shipped defaults now understand.
    if (p.id === 'ucl') {
      p.searchTitles = championsLeague.searchTitles.bind(championsLeague);
      p.torrentSearchTitles = championsLeague.torrentSearchTitles.bind(championsLeague);
      p.isRelevantStreamTitle = championsLeague.isRelevantStreamTitle.bind(championsLeague);
      p.uuMaxQueries = championsLeague.uuMaxQueries;
    } else if (p.id === 'mlb') {
      p.searchTitles = mlb.searchTitles.bind(mlb);
      p.torrentSearchTitles = mlb.torrentSearchTitles.bind(mlb);
      p.isRelevantStreamTitle = mlb.isRelevantStreamTitle.bind(mlb);
      p.uuMaxQueries = mlb.uuMaxQueries;
    }
    all.push(p);
  }
  applySourceAssignments(all);
  applyPromotionMatchingOverrides(all);
  rebuildIndexes();
}

// Initial populate at module load.
reload();

function getByEventId(eventId) {
  if (!eventId || typeof eventId !== 'string') return null;
  const idx = eventId.indexOf(':');
  if (idx === -1) return null;
  return byPrefix[eventId.slice(0, idx)] || null;
}

module.exports = { all, enabled, byPrefix, getByEventId, reload, createGenericPromotion,
  _applyPromotionMatchingOverrides: applyPromotionMatchingOverrides };
