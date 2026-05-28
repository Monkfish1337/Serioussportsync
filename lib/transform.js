const promotions = require('./promotions');
const config = require('../config');

// Nuvio stamps the meta title text over the poster when a meta has no `logo`,
// which defaces our branded poster cards / labelled F1 thumbs. Supplying a
// transparent logo image suppresses that overlay (per Nuvio dev guidance).
// Served from /assets, so it needs PUBLIC_URL; undefined when unset, leaving
// other clients unchanged.
const _ASSET_BASE = (config.publicUrl || '').replace(/\/+$/, '');
const BLANK_LOGO = _ASSET_BASE ? (_ASSET_BASE + '/assets/blank.png') : undefined;

// Generic Stremio meta builders. Promotion-specific logic (classify,
// buildAliases, genres) lives in lib/promotions.js — this file just
// dispatches to whichever promotion the event belongs to.

// upload.wikimedia.org images 403 on some clients (Android-TV Nuvio), rendering
// broken. Prefer any non-Wikimedia source; fall back to the promotion's branded
// default. Handles both per-event Wikipedia-backfilled art and legacy defaults.
function nonWiki(url) {
  return (url && !/upload\.wikimedia\.org/i.test(url)) ? url : null;
}
function safePoster(ev) {
  const p = promotions.getByEventId(ev.id);
  const def = p && p.defaults ? p.defaults.poster : null;
  return nonWiki(ev.poster) || nonWiki(ev.thumb) || nonWiki(ev.fanart) || nonWiki(def) || undefined;
}
function safeBackground(ev) {
  const p = promotions.getByEventId(ev.id);
  const def = p && p.defaults ? p.defaults.fanart : null;
  return nonWiki(ev.fanart) || nonWiki(ev.banner) || nonWiki(def) || nonWiki(ev.poster) || undefined;
}

function toCatalogMeta(ev) {
  return {
    id: ev.id,
    type: config.addonType,
    name: ev.name,
    poster: safePoster(ev),
    posterShape: ev.posterShape || 'regular',
    background: safeBackground(ev),
    logo: BLANK_LOGO,
    description: ev.shortDescription || undefined,
    releaseInfo: ev.dateLocal || ev.date || undefined,
    genres: ev.genres,
  };
}

function toDetailMeta(ev) {
  return {
    id: ev.id,
    type: config.addonType,
    name: ev.name,
    poster: safePoster(ev),
    posterShape: ev.posterShape || 'regular',
    background: safeBackground(ev),
    logo: BLANK_LOGO,
    description: ev.description || ev.shortDescription || undefined,
    releaseInfo: ev.dateLocal || ev.date || undefined,
    runtime: ev.kind === 'ppv' || ev.kind === 'numbered' ? '5h' : '4h',
    genres: ev.genres,
    country: ev.country || undefined,
    searchHints: ev.aliases,
    released: ev.date
      ? new Date(ev.date + 'T' + (ev.time || '00:00:00') + 'Z').toISOString()
      : undefined,
  };
}

// Convert a raw TheSportsDB event to our normalized internal form. Per-event
// imagery is preferred; falls back to promotion.defaults so events TSDB
// hasn't postered yet (typically upcoming events) still render with a
// branded placeholder. The post-refresh enrichment in scripts/refresh.js can
// later replace the fallback with a Wikipedia poster.
function fromTsdb(raw, promotion) {
  const name = (raw.strEvent || '').trim();
  if (!name) return null;
  const kind = promotion.classify(name);
  const aliases = promotion.buildAliases(name);
  const defaults = promotion.defaults || {};
  const description = raw.strDescriptionEN || null;
  const shortDescription = description ? description.slice(0, 280).trim() : null;

  const ev = {
    id: promotion.idPrefix + ':' + raw.idEvent,
    sourceId: raw.idEvent,
    promotion: promotion.id,
    name,
    kind,
    date: raw.dateEvent || null,
    dateLocal: raw.dateEventLocal || raw.dateEvent || null,
    time: raw.strTime || null,
    timestamp: raw.strTimestamp || null,
    season: raw.strSeason || null,
    round: raw.intRound || null,
    venue: raw.strVenue || null,
    city: raw.strCity || null,
    country: raw.strCountry || null,
    // Artwork. Three modes:
    //  - preferThumb: use TSDB's per-event strThumb (a clean 16:9 session card,
    //    e.g. F1's labelled circuit graphics) and fall back to the promotion's
    //    branded default when an event has no thumb yet. strFanart/strBanner are
    //    deliberately NOT used — for F1 those are wide name-banners that crop.
    //  - useDefaultArt: always the promotion's branded default.
    //  - default chain: landscape prefers strFanart/strBanner over strThumb
    //    (often a portrait poster Stremio would crop into a wide tile).
    poster: promotion.preferThumb
      ? (raw.strThumb || defaults.poster || null)
      : promotion.useDefaultArt
        ? (defaults.poster || null)
        : ((promotion.posterShape === 'landscape')
            ? (raw.strFanart || raw.strBanner || raw.strThumb || raw.strPoster || defaults.poster || null)
            : (raw.strPoster || raw.strThumb || defaults.poster || null)),
    thumb: promotion.preferThumb
      ? (raw.strThumb || defaults.poster || null)
      : promotion.useDefaultArt
        ? (defaults.poster || null)
        : (raw.strThumb || raw.strPoster || defaults.poster || null),
    // Backdrop (background). Not falling back to strBanner — TSDB banners are
    // wide strips with the logo pinned to one side (off-center backdrop).
    fanart: promotion.preferThumb
      ? (raw.strThumb || defaults.fanart || null)
      : promotion.useDefaultArt
        ? (defaults.fanart || null)
        : (raw.strFanart || defaults.fanart || null),
    banner: promotion.preferThumb
      ? (raw.strThumb || defaults.fanart || null)
      : promotion.useDefaultArt
        ? (defaults.fanart || null)
        : (raw.strBanner || raw.strFanart || defaults.fanart || null),
    square: raw.strSquare || null,
    leagueBadge: raw.strLeagueBadge || null,
    description,
    shortDescription,
    aliases,
    posterShape: promotion.posterShape || 'regular',
    hasSourceImage: !!(raw.strPoster || raw.strThumb),
    hasSourceDescription: !!description,
    linkTarget: promotion.wikipediaTitle ? promotion.wikipediaTitle(name) : null,
    // Source provenance — used by the refresh prune step to detect events
    // left over from a previous source (Wikipedia, onefc, etc.) when a
    // promotion migrates between sources.
    source: { type: 'thesportsdb', idEvent: raw.idEvent || null },
  };
  ev.genres = promotion.genres(ev);
  return ev;
}

// Convert a raw event from a Wikipedia source to our normalized form.
// Per-event imagery is preferred; falls back to promotion.defaults when
// absent (e.g. ONE Friday Fights, which don't get individual articles).
function fromWiki(raw, promotion) {
  const name = (raw.name || '').trim();
  if (!name || !raw.sourceId) return null;
  const kind = promotion.classify(name);
  const aliases = promotion.buildAliases(name);
  const defaults = promotion.defaults || {};

  const ev = {
    id: promotion.idPrefix + ':' + raw.sourceId,
    sourceId: raw.sourceId,
    promotion: promotion.id,
    name,
    kind,
    date: raw.date || null,
    dateLocal: raw.dateLocal || raw.date || null,
    time: raw.time || null,
    timestamp: raw.timestamp || null,
    venue: raw.venue || null,
    city: raw.city || null,
    country: raw.country || null,
    poster: raw.poster || defaults.poster || null,
    thumb: raw.thumb || raw.poster || defaults.poster || null,
    fanart: raw.fanart || defaults.fanart || null,
    banner: raw.banner || defaults.fanart || null,
    description: raw.description || null,
    shortDescription: raw.description ? raw.description.slice(0, 280).trim() : null,
    aliases,
    posterShape: promotion.posterShape || 'regular',
    hasSourceImage: !!raw.poster,
    hasSourceDescription: !!raw.description,
    linkTarget: raw.linkTarget || (promotion.wikipediaTitle ? promotion.wikipediaTitle(name) : null),
    // Source provenance preserved from the raw record (set by the wikipedia,
    // wikipedia-list, or onefc adapter). Used by the refresh prune step.
    source: raw.source || null,
  };
  ev.genres = promotion.genres(ev);
  return ev;
}

module.exports = { toCatalogMeta, toDetailMeta, fromTsdb, fromWiki };
