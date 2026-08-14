
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
      out.add('ONE Fight Night ' + fn[1]);
      out.add('ONE FN ' + fn[1]);
    }
    // Friday Fights
    const ff = name.match(/^ONE\s+Friday\s+Fights\s+(\d{1,4})\b/i);
    if (ff) {
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
    .replace(/\b(sprint\s*race|sprint|qualifying|qualification|qualif|practice|warm[\s.\-_]*up|gp|grand\s*prix)\b.*$/i, '')
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
  if (/\bpractice\b|warm[\s.\-_]*up/.test(n)) return 'practice';
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
    if (/\bmoto[23]\b/i.test(title)) return { ok: false, reason: 'moto2-or-moto3' };
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
// Template placeholders: {name} {year} {date}.
function applyTitleTemplate(template, ctx) {
  return String(template || '')
    .replace(/\{name\}/g, ctx.name || '')
    .replace(/\{year\}/g, ctx.year || '')
    .replace(/\{date\}/g, ctx.date || '');
}

// 0.40.0 — football matchup splitter.
//
// football-data.org returns event names like "Manchester United FC vs
// Nottingham Forest FC" (canonical, includes FC). Release groups use every
// abbreviation imaginable: "Man United v Nottm Forest", "MUFC vs NFFC",
// "United vs Forest". splitMatchup / expandTeamAliases handle both search
// generation and the relevance check.
const MATCHUP_SEPARATOR_RE = /\s+(vs\.?|v\.?|@|-)\s+/i;
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
  return list
    .filter((s) => s && s.length >= 4)   // drop 3-char TLAs entirely from search
    .slice()
    .sort((a, b) => {
      // Prefer forms with more words, then by length within same word count
      const wa = a.split(/\s+/).length;
      const wb = b.split(/\s+/).length;
      if (wa !== wb) return wb - wa;
      return b.length - a.length;
    });
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

function plainTeamMatch(title, teamName) {
  const normalise = (value) => String(value || '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  const haystack = ' ' + normalise(title) + ' ';
  const needle = normalise(teamName);
  return needle.length >= 3 && haystack.includes(' ' + needle + ' ');
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
  const sourceKind = String(spec.source || 'tsdb');
  let sourceObj;
  if (sourceKind === 'football-data') {
    sourceObj = { type: 'football-data', competitionId: String(spec.competitionId || '') };
  } else if (sourceKind === 'tmdb') {
    // 0.42.13 - TMDB TV show (Match of the Day, ITV highlights, etc.).
    // scripts/refresh.js dispatches to lib/sources/tmdb.js which returns one
    // record per episode with air_date. transform.fromTmdb converts each to
    // an event whose date drives DARKSPORT-style search title generation.
    sourceObj = { type: 'tmdb', tvId: String(spec.tvId || '') };
  } else {
    sourceObj = { type: 'thesportsdb', leagueId: String(spec.leagueId || '') };
  }
  const templates = Array.isArray(spec.searchTitleTemplates) && spec.searchTitleTemplates.length
    ? spec.searchTitleTemplates : ['{name}', '{name} {year}'];
  const keywords = (Array.isArray(spec.relevanceKeywords) ? spec.relevanceKeywords : [])
    .map((k) => String(k || '').toLowerCase().trim()).filter(Boolean);

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

  // 0.42.0 — per-promotion pipeline toggles ('torbox' | 'newsnab' | 'easynews').
  // Consumed in lib/streams.js handleStream to skip specific pipelines for
  // events from this promotion. Especially useful for football where the
  // TorBox/Prowlarr pipeline is slow-and-mostly-empty and just blocks the
  // fast newsnab pipeline.
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
    disabledPipelines,
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
      if (teamAliasLookup) {
        const split = plainSplit;
        if (split) {
          // 0.41.1 — filter to search-worthy forms only. FC/CF-suffixed and
          // fan-nickname forms are relevance-match-only (used later in
          // isRelevantStreamTitle) but never as search queries.
          const homes = expandTeamAliases(split.home, teamAliasLookup).filter(isSearchWorthyForm);
          const aways = expandTeamAliases(split.away, teamAliasLookup).filter(isSearchWorthyForm);
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
        const ctx = { name: nameVariant, year, date };
        for (const tpl of templates) {
          const filled = applyTitleTemplate(tpl, ctx).trim().replace(/\s+/g, ' ');
          if (filled) out.add(filled);
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

      // Hard cap so an operator with a giant alias table doesn't fan out
      // 200 queries per event.
      return Array.from(out).slice(0, 60);
    },
    isRelevantStreamTitle(title, event) {
      if (!title) return { ok: false, reason: 'no-title' };
      const t = title.toLowerCase();

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
      if (teamAliasLookup && event && event.name) {
        const split = splitMatchup(event.name);
        if (split) {
          teamAliasApplicable = true;
          const homes = expandTeamAliases(split.home, teamAliasLookup);
          const aways = expandTeamAliases(split.away, teamAliasLookup);
          const homeHit = homes.some((h) => aliasBoundaryMatch(t, h));
          const awayHit = aways.some((a) => aliasBoundaryMatch(t, a));
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
          teamAliasPassed = plainTeamMatch(title, split.home)
            && plainTeamMatch(title, split.away);
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
      if (!teamAliasPassed && keywords.length > 0) {
        const kwHit = keywords.some((kw) => t.includes(kw));
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
    includeEvent(_ev)    { return true; },
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

const HARDCODED = [ufc, one, wwe, aew, f1, boxing, motogp];
const all = [];
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
    if (hardcodedIds.has(s.id)) {
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

function reload() {
  const custom = loadCustomPromotions();
  all.length = 0;
  for (const p of HARDCODED) all.push(p);
  for (const p of custom) all.push(p);
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

module.exports = { all, enabled, byPrefix, getByEventId, reload, createGenericPromotion };
