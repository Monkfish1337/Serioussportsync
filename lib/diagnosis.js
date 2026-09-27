'use strict';

// Diagnosis: follows an event's journey from schedule to playback and says,
// at each stage, whether it works, what is wrong, and how to fix it.
//
//   Access    Can clients reach SSS?
//   Schedule  Are events listed, with the right dates?
//   Sources   Are the search sources answering?
//   Matching  Are the right releases accepted?
//   Coverage  Are releases saved before anyone asks?
//   Playback  Do links appear quickly, and do they play?
//
// Every check reads what SSS already records (settings, the refresh record,
// the Prowlarr queue, the availability database, the diagnosis journal, the
// log buffer). Nothing here searches a provider or changes state. A check that
// cannot read its source reports that as a notice instead of breaking the page.

const fs = require('fs');
const path = require('path');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const SEVERITY = { critical: 0, warning: 1, notice: 2 };

const STAGES = [
  { id: 'access', label: 'Access', question: 'Can clients reach SSS?' },
  { id: 'schedule', label: 'Schedule', question: 'Are events listed, with the right dates?' },
  { id: 'sources', label: 'Sources', question: 'Are the search sources answering?' },
  { id: 'matching', label: 'Matching', question: 'Are the right releases accepted?' },
  { id: 'coverage', label: 'Coverage', question: 'Are releases saved before anyone asks?' },
  { id: 'playback', label: 'Playback', question: 'Do links appear quickly, and do they play?' },
];

function defaultSources() {
  return {
    config: () => require('../config'),
    settings: () => require('./settings'),
    promotions: () => require('./promotions').all,
    events: () => require('./store').getEvents(),
    refreshStatus: () => require('./refresh-status').load(),
    queueStatus: () => require('./prowlarr-discovery').getDefault().status(),
    overrides: () => require('./promotion-overrides').list(),
    sanitizeWeekly: (o) => require('./promotion-overrides').sanitizeWeekly(o),
    reviewRows: (id, related) => require('./query-review').getDefault().rows(id, related),
    clientReports: () => require('./admin-client-check').status().reports || [],
    sportVideoStatus: () => require('./sources/sport-video').status(),
    sportVideoReleases: () => require('./sources/sport-video').load().releases || [],
    users: () => require('./users').listUsers().map((u) => require('./users').findById(u.id)).filter(Boolean),
    usenetStatus: (cfg) => require('./diy-usenet-status').status(cfg),
    logs: (opts) => require('./log-buffer').filtered(opts),
    availabilityIndex: () => require('./availability-index').getDefault(),
    coverage: (data, now) => require('./discovery-coverage').coverage(data, now),
    journal: () => require('./diagnosis-journal').snapshot(),
    startAt: (event) => require('./discovery-cadence').startAt(event),
    muted: () => loadMuted(),
  };
}

// A finding: what is wrong (title), why it matters (detail), how to fix it
// (steps, then the fix button), and what it is based on (evidence). The id is
// stable across runs so a finding can be hidden.
function finding(id, stage, severity, title, o) {
  const x = o || {};
  return { id, stage, severity, title, detail: x.detail || '', steps: x.steps || [], fix: x.fix || null,
    links: x.links || [], evidence: (x.evidence || []).filter(Boolean) };
}

const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const releaseDerived = (p) => p && p.source && p.source.type === 'sport-video' && String(p.id).startsWith('discovered-');
const promotionOf = (id) => String(id || '').split(':')[0];
const ago = (now, t) => {
  const ms = now - t;
  if (!Number.isFinite(ms)) return 'never';
  if (ms < HOUR) return Math.max(1, Math.round(ms / 60000)) + ' min ago';
  if (ms < 2 * DAY) return Math.round(ms / HOUR) + 'h ago';
  return Math.round(ms / DAY) + ' days ago';
};
const sorted = (list) => list.slice().sort((a, b) => a - b);
const median = (list) => (list.length ? sorted(list)[Math.floor(list.length / 2)] : 0);
const quantile = (list, q) => (list.length ? sorted(list)[Math.min(list.length - 1, Math.floor(list.length * q))] : 0);

const PROWLARR_TAB = { label: 'Discovery → Prowlarr', href: '/admin/discovery?tab=prowlarr' };
// Search now, sent as a form; `back` returns to where the button was.
const searchNow = (label, fields, back) => ({ label, post: { action: '/admin/prowlarr-discovery/search-now', fields: Object.assign({ back }, fields) } });
const queueSelects = (src, promotionId) => {
  try {
    const o = src.queueStatus().options || {};
    return Boolean(o.enabled && (o.promotions || []).includes(promotionId));
  } catch (_) { return false; }
};

// Downloads per indexer over today and yesterday (UTC), from the journal.
function recentDownloads(journal, now) {
  const days = [isoDay(now), isoDay(now - DAY)];
  const out = new Map();
  for (const [indexer, byDay] of Object.entries((journal && journal.downloads) || {})) {
    const row = { ok: 0, failed: 0, lastStatus: '', lastOkAt: 0, lastFailAt: 0 };
    for (const [day, d] of Object.entries(byDay)) {
      if (days.includes(day)) { row.ok += d.ok || 0; row.failed += d.failed || 0; }
      if ((d.lastFailAt || 0) > row.lastFailAt) { row.lastFailAt = d.lastFailAt; row.lastStatus = d.lastStatus || ''; }
      row.lastOkAt = Math.max(row.lastOkAt, d.lastOkAt || 0);
    }
    out.set(indexer, row);
  }
  return out;
}

// Opens in the last 24 hours of events that aired 12+ hours before: those
// should have links. Future and just-finished events legitimately have none.
function pastOpens(src, now) {
  const events = new Map(src.events().map((e) => [e.id, e]));
  return (src.journal().opens || []).filter((o) => o.at >= now - DAY).map((o) => Object.assign({}, o, { event: events.get(o.eventId) }))
    .filter((o) => {
      if (!o.event) return false;
      const start = src.startAt(o.event);
      const at = Number.isFinite(start) ? start : Date.parse(o.event.date + 'T23:59:59Z');
      return Number.isFinite(at) && o.at - at > 12 * HOUR;
    });
}

// ---------------------------------------------------------------- checks

const CHECKS = {
  // ------------------------------------------------ Access
  publicUrl(src) {
    if (src.config().publicUrl) return [];
    return [finding('public-url', 'access', 'warning', 'PUBLIC_URL is not set', {
      detail: 'Behind a proxy or tunnel, install and playback links come out as http:// and bundled artwork is blank.',
      steps: ['Set PUBLIC_URL to the address clients use, e.g. https://sss.example.com.', 'Restart the container.'],
      fix: { label: 'Reverse proxy setup', href: 'https://github.com/Monkfish1337/Serioussportsync/blob/main/docs/INSTALLATION.md#reverse-proxy-or-tunnel' },
    })];
  },

  manifest(src) {
    const latest = src.clientReports()[0];
    const m = latest && latest.manifest;
    if (!m || m.verdict !== 'fail') return [];
    return [finding('manifest', 'access', 'critical', 'Clients cannot load the addon', {
      detail: 'The last Client check could not read ' + (latest.account || 'the account') + '\'s manifest, so the client shows nothing.',
      steps: ['Open the install link from Configure in a browser.', 'If it fails, check PUBLIC_URL and the proxy.', 'Run Client check again.'],
      fix: { label: 'Client check', href: '/admin/client-check' }, evidence: m.problems || [],
    })];
  },

  // ------------------------------------------------ Schedule
  metadataKeys(src) {
    const settings = src.settings();
    const has = {
      tmdb: () => Boolean((settings.getTmdb().apiKey) || (src.config().tmdb && src.config().tmdb.apiKey) || process.env.TMDB_API_KEY),
      'football-data': () => Boolean(settings.getFootballData().apiKey),
      'api-football': () => Boolean(settings.getApiFootball().apiKey),
    };
    const label = { tmdb: 'TMDB', 'football-data': 'football-data.org', 'api-football': 'API-Football' };
    return src.promotions().filter((p) => p.enabled !== false && p.source && has[p.source.type] && !has[p.source.type]())
      .map((p) => finding('key:' + p.id, 'schedule', 'critical', p.name + ' cannot refresh: no ' + label[p.source.type] + ' key', {
        detail: 'Its schedule comes from ' + label[p.source.type] + ', which needs an API key. It gets no new events until one is saved.',
        steps: ['Get a free key from ' + label[p.source.type] + '.', 'Save it on Metadata.', 'Refresh ' + p.name + ' on Promotions.'],
        fix: { label: 'Metadata', href: '/admin/metadata' },
      }));
  },

  refresh(src, now) {
    const status = src.refreshStatus();
    const hours = Number(src.config().refreshIntervalHours) || 6;
    if (!status) {
      return [finding('refresh-none', 'schedule', 'notice', 'No metadata refresh recorded yet', {
        detail: 'The next scheduled refresh (every ' + hours + 'h) fills this in.',
      })];
    }
    const out = [];
    const last = Date.parse(status.lastFullRefreshAt || status.finishedAt || 0);
    if (Number.isFinite(last) && now - last > 2 * hours * HOUR + 30 * 60000) {
      out.push(finding('refresh-stale', 'schedule', 'warning', 'The last full refresh was ' + ago(now, last), {
        detail: 'Refreshes run every ' + hours + 'h, so new events and date changes are missing.',
        steps: ['Look for "[refresh]" errors in Logs.', 'Run a refresh from Promotions.'],
        fix: { label: 'Refresh logs', href: '/admin/logs?substring=%5Brefresh%5D' },
      }));
    }
    const names = new Map(src.promotions().map((p) => [p.id, p.name]));
    for (const entry of status.promotions || []) {
      if (entry.status === 'ok') continue;
      const failed = entry.status === 'failed';
      out.push(finding('refresh:' + entry.id, 'schedule', failed ? 'critical' : 'warning',
        (names.get(entry.id) || entry.id) + (failed ? ' failed to refresh' : ' was skipped in the last refresh'), {
          detail: entry.reason || 'No reason was recorded.',
          steps: ['Fix the cause above.', 'Refresh the promotion on Promotions.'],
          fix: { label: 'Promotions', href: '/admin/promotions' },
          evidence: [entry.at ? 'At ' + String(entry.at).replace('T', ' ').slice(0, 16) + ' UTC' : ''],
        }));
    }
    return out;
  },

  catalogs(src, now) {
    const byPromotion = new Map();
    for (const e of src.events()) {
      const id = promotionOf(e.id);
      if (!byPromotion.has(id)) byPromotion.set(id, []);
      byPromotion.get(id).push(e);
    }
    const today = isoDay(now);
    const out = [];
    for (const p of src.promotions()) {
      if (p.enabled === false || p.autoTeam || releaseDerived(p)) continue;
      const list = byPromotion.get(p.id) || [];
      if (!list.length) {
        out.push(finding('empty:' + p.id, 'schedule', 'warning', p.name + ' has no events', {
          detail: 'Its catalogs are empty in every client.',
          steps: ['Refresh it on Promotions.', 'If it is still empty, check its source on Metadata.'],
          fix: { label: 'Promotions', href: '/admin/promotions' },
        }));
      } else if (p.weeklyShow) {
        const soon = list.some((e) => e.date >= today && e.date <= isoDay(now + 10 * DAY));
        const recent = list.some((e) => e.date < today && e.date >= isoDay(now - 10 * DAY));
        if (!soon && recent) {
          out.push(finding('upcoming:' + p.id, 'schedule', 'warning', p.name + ' has no upcoming episodes', {
            detail: 'It aired in the last 10 days but nothing is listed for the next 10, so its Upcoming row is empty. TheSportsDB often lists weekly episodes only once they air.',
            steps: ['Add the next episode in Event Editor, or wait for the source to list it.'],
            fix: { label: 'Event Editor', href: '/admin/events' },
          }));
        }
      }
    }
    return out;
  },

  catalogCheck(src) {
    const latest = src.clientReports()[0];
    const failed = ((latest && latest.catalogs) || []).filter((c) => c.verdict === 'fail');
    if (!failed.length) return [];
    return [finding('client-catalogs', 'schedule', 'warning', plural(failed.length, 'catalog') + ' failed the last Client check', {
      detail: 'A client opening these rows gets an error or broken tiles.',
      fix: { label: 'Client check report', href: '/admin/client-check' },
      evidence: failed.slice(0, 5).map((c) => (c.name || c.id) + ': ' + ((c.problems || [])[0] || 'failed')),
    })];
  },

  // ------------------------------------------------ Sources
  torrentSources(src) {
    const s = src.settings();
    const prowlarr = s.getProwlarr() || {};
    const bitmagnet = s.getBitmagnet() || {};
    const configured = (prowlarr.enabled !== false && prowlarr.url && prowlarr.apiKey)
      || (bitmagnet.enabled !== false && bitmagnet.url) || s.getSportVideo().enabled;
    if (configured) return [];
    return [finding('no-torrent-source', 'sources', 'critical', 'No torrent source is set up', {
      detail: 'Without Prowlarr, Bitmagnet or Sport-Video, SSS finds no torrents; only Usenet and Easynews can produce links.',
      steps: ['Add Prowlarr (URL and API key) under Server → Discovery pipelines.'],
      fix: { label: 'Server', href: '/admin' },
    })];
  },

  // One finding per indexer at most, most specific cause first.
  indexers(src, now) {
    const status = src.queueStatus();
    const indexers = status.indexers || [];
    const downloads = recentDownloads(src.journal(), now);
    const best = Math.max(0, ...indexers.map((i) => Number(i.successes) || 0));
    const lastMatch = new Map();
    for (const e of status.matchedEvents || []) {
      for (const name of e.indexers || []) if (!lastMatch.has(name) || e.at > lastMatch.get(name)) lastMatch.set(name, e.at);
    }
    const steps = (name) => [
      'In Prowlarr, open System → Logs and look for "Release download failed" next to ' + name + '.',
      '"Invalid torrent file" means Prowlarr cannot read this tracker\'s files: go back to the previous Prowlarr version.',
      'A login page, 401 or 403 means the cookie or login has expired: refresh it in the indexer\'s settings.',
      'Reset the cooldown on Discovery → Prowlarr.',
    ];
    const names = new Set([...indexers.map((i) => i.name), ...downloads.keys()]);
    const out = [];
    for (const name of names) {
      const i = indexers.find((x) => x.name === name) || { name, successes: 0, failures: 0 };
      const top = best > 0 && Number(i.successes) === best;
      const tag = top ? ' (your most productive indexer)' : '';
      const d = downloads.get(name);
      if (d && d.failed >= 5 && d.failed >= d.ok) {
        out.push(finding('indexer:' + name, 'sources', top ? 'critical' : 'warning', name + ': torrent downloads are failing' + tag, {
          detail: plural(d.failed, 'download') + ' failed since yesterday (' + d.ok + ' worked). Searches still return results, but without the torrent SSS cannot get its hash, so they are dropped.',
          steps: steps(name), fix: PROWLARR_TAB,
          evidence: [d.lastStatus ? 'Last error: ' + d.lastStatus : '', d.lastOkAt ? 'Last worked ' + ago(now, d.lastOkAt) : 'No download worked in the last 7 days'],
        }));
        continue;
      }
      const last = lastMatch.get(name);
      if ((Number(i.successes) || 0) >= 10 && Number(i.requests) > 0 && i.day === isoDay(now) && last && now - last > 2 * DAY) {
        out.push(finding('indexer:' + name, 'sources', top ? 'critical' : 'warning', name + ' has saved nothing since ' + isoDay(last) + tag, {
          detail: 'It is still searched (' + i.requests + ' requests today) but nothing it returned has been usable for ' + Math.floor((now - last) / DAY) + ' days.',
          steps: steps(name), fix: PROWLARR_TAB, evidence: [i.successes + ' successful searches in total'],
        }));
        continue;
      }
      if ((Number(i.failures) || 0) >= 3) {
        const until = Number(i.next_at) > now ? 'Paused until ' + new Date(Number(i.next_at)).toISOString().slice(11, 16) + ' UTC' : '';
        out.push(finding('indexer:' + name, 'sources', top ? 'critical' : 'warning', name + ' has failed ' + i.failures + ' times in a row' + tag, {
          detail: 'SSS pauses an indexer after repeated failures, so it is not being searched.',
          steps: steps(name), fix: PROWLARR_TAB, evidence: [until, i.successes + ' successful searches so far'],
        }));
      }
    }
    return out;
  },

  sportVideo(src) {
    if (!src.settings().getSportVideo().enabled) return [];
    const status = src.sportVideoStatus();
    if (!status.lastError) return [];
    return [finding('sport-video', 'sources', 'warning', 'Sport-Video\'s last scan failed', {
      detail: status.lastError,
      steps: ['Check Sport-Video is reachable from the server (VPN or proxy).', 'Run a scan from Discovery → Sport-Video.'],
      fix: { label: 'Discovery → Sport-Video', href: '/admin/discovery?tab=sport-video' },
    })];
  },

  usenet(src) {
    const out = [];
    for (const user of src.users()) {
      if (!user || user.role !== 'admin') continue;
      const status = src.usenetStatus(user.config || {});
      if (!status.enabled || status.ready) continue;
      const missing = [!status.discovery ? 'an indexer' : '', !status.playback ? 'an NNTP provider' : ''].filter(Boolean).join(' and ');
      out.push(finding('usenet:' + user.username, 'sources', 'warning', 'Built-in Usenet for ' + user.username + ' is missing ' + missing, {
        detail: 'It is switched on but produces no links until both are set.',
        fix: { label: 'Usenet', href: '/admin/usenet' },
      }));
    }
    return out;
  },

  // ------------------------------------------------ Matching
  learnedRules(src) {
    const suspicious = /\b(?:19|20)\d{2}x\d+\b|\bround\s*\d+|\br\d{2}\b|\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b|\b(?:19|20)\d{2}[.-]\d{2}[.-]\d{2}\b|\bs\d{2}e\d{2}\b|#\d+|\b(?:practice|qualifying|sprint|week)\s*\d+\b/i;
    const promotions = new Map(src.promotions().map((p) => [p.id, p]));
    const out = [];
    for (const saved of src.overrides()) {
      // Judge rules as they are used: weekly shows drop episode numbers on load.
      const p = promotions.get(saved.promotionId);
      const o = p && p.weeklyShow && typeof src.sanitizeWeekly === 'function' ? src.sanitizeWeekly(saved) : saved;
      const hits = [].concat(o.promotionAliases || [], o.relevanceKeywords || [], o.searchTitleTemplates || [])
        .filter((v) => suspicious.test(String(v).replace(/\{[a-z_]+\}/g, '')));
      if (!hits.length) continue;
      out.push(finding('rules:' + o.promotionId, 'matching', 'warning', ((p && p.name) || o.promotionId) + ' has learned rules that name one event', {
        detail: 'These are added to every search for the promotion, so every other event searches for the wrong thing.',
        steps: ['Open Improve matching.', 'Remove the rules listed below.'],
        fix: { label: 'Improve matching', href: '/admin/promotions/' + encodeURIComponent(o.promotionId) + '/research' },
        evidence: hits.slice(0, 4).map((h) => '"' + h + '"'),
      }));
    }
    return out;
  },

  zeroPatterns(src) {
    const promotions = src.promotions();
    const out = [];
    for (const p of promotions) {
      if (p.enabled === false || p.autoTeam) continue;
      let rows = [];
      try { rows = src.reviewRows(p.id, promotions.filter((x) => x.reviewParent === p.id).map((x) => x.id)); } catch (_) { continue; }
      const flagged = rows.filter((r) => r.flag === 'Repeated zero hits' && r.action === 'active');
      if (!flagged.length) continue;
      out.push(finding('zero:' + p.id, 'matching', 'notice', p.name + ': ' + plural(flagged.length, 'search pattern') + ' never find anything', {
        detail: 'Each has run 10+ times across 5 events without a result. Disabling them makes searches faster.',
        fix: { label: 'Review aliases', href: '/admin/promotions/' + encodeURIComponent(p.id) + '/aliases' },
        evidence: flagged.slice(0, 3).map((r) => r.pattern + ' (' + r.source + ')'),
      }));
    }
    return out;
  },

  // ------------------------------------------------ Coverage
  coverage(src, now) {
    const result = coverageResult(src, now);
    const promotions = src.promotions();
    const out = [];
    for (const group of result.promotions || []) {
      if (group.missing < 3 || group.missing / Math.max(1, group.total) < 0.25) continue;
      const ranked = Object.entries(group.reasons || {}).sort((a, b) => b[1] - a[1]);
      const top = ranked.length ? ranked[0][0] : '';
      const name = (promotions.find((p) => p.id === group.id) || {}).name || group.id;
      const unselected = /Not selected for Prowlarr|Prowlarr queue disabled|outside Prowlarr window/i.test(top);
      const title = name + ': ' + group.missing + ' of ' + group.total + ' recent events have no saved release';
      const evidence = ranked.slice(0, 3).map(([r, n]) => n + ' × ' + r);
      if (unselected) {
        out.push(finding('coverage:' + group.id, 'coverage', 'warning', title, {
          detail: 'No background source searches it, so each event is searched only when someone opens it, which is slower.',
          steps: ['Add ' + name + ' to the Prowlarr queue on Discovery → Prowlarr.', 'Or hide this if live search is enough.'],
          fix: PROWLARR_TAB, evidence,
        }));
      } else {
        const missingEvents = { label: 'Missing events', href: '/admin/discovery?tab=overview&promotion=' + encodeURIComponent(group.id) };
        const selected = queueSelects(src, group.id);
        out.push(finding('coverage:' + group.id, 'coverage', group.missing / group.total >= 0.5 ? 'critical' : 'warning', title, {
          detail: 'The background search ran and found nothing usable. A sudden drop usually means an indexer stopped working; see Sources.',
          steps: ['Fix any Sources findings first.', selected ? 'Search now to retry the missing games straight away.' : 'Troubleshoot one of the missing events to see where it stops.'],
          fix: selected ? searchNow('Search ' + name + ' now', { promotion: group.id }, '/admin/diagnosis#stage-coverage') : missingEvents,
          links: selected ? [missingEvents] : [], evidence,
        }));
      }
    }
    return out;
  },

  // ------------------------------------------------ Playback
  accounts(src) {
    const stranded = src.users().filter((u) => {
      const c = (u && u.config) || {};
      if (String(c.torboxApiKey || '').trim() || String(c.uuManifestUrl || '').trim()) return false;
      if (String(c.easynewsUsername || '').trim() && c.easynewsPassword) return false;
      if (u.role === 'admin') { try { if (src.usenetStatus(c).ready) return false; } catch (_) { /* not ready */ } }
      return true;
    });
    if (!stranded.length) return [];
    return [finding('accounts', 'playback', 'warning', plural(stranded.length, 'account') + ' cannot play anything', {
      detail: 'They have no TorBox key, Easynews login or Usenet set up, so every event shows no links.',
      steps: ['Add a TorBox key or Easynews login to the account on Configure (or ask its owner to).'],
      fix: { label: 'User Management', href: '/admin/users' },
      evidence: stranded.slice(0, 6).map((u) => u.username),
    })];
  },

  opens(src, now) {
    const out = [];
    const past = pastOpens(src, now);
    const empty = past.filter((o) => !o.rows);
    if (past.length >= 5 && pct(empty.length, past.length) >= 30) {
      const names = new Map(empty.map((o) => [o.eventId, o.event.name]));
      out.push(finding('empty-opens', 'playback', pct(empty.length, past.length) >= 60 ? 'critical' : 'warning',
        pct(empty.length, past.length) + '% of past events opened today showed no links', {
          detail: empty.length + ' of ' + past.length + ' opens of events that had already aired returned nothing.',
          steps: ['Troubleshoot one of these events; it shows the step where it stops.'],
          fix: { label: 'Troubleshoot ' + empty[0].event.name, href: '/admin/diagnosis?tab=event&q=' + encodeURIComponent(empty[0].eventId) },
          evidence: Array.from(names.entries()).slice(0, 5).map(([id, name]) => name + ' (' + id + ')'),
        }));
    }
    const all = (src.journal().opens || []).filter((o) => o.at >= now - DAY);
    const p90 = quantile(all.map((o) => o.ms), 0.9);
    if (all.length >= 5 && p90 > 15000) {
      out.push(finding('slow-opens', 'playback', 'notice', 'One open in ten takes over ' + Math.floor(p90 / 1000) + ' seconds', {
        detail: 'Slow opens are live searches running to their time budget, usually built-in Usenet or Prowlarr.',
        steps: ['Turn on background preparation on Database so saved releases answer at once.', 'Or shorten the live budgets under Server → Discovery pipelines.'],
        fix: { label: 'Database', href: '/admin/database' },
        evidence: ['Median ' + (median(all.map((o) => o.ms)) / 1000).toFixed(1) + 's over ' + plural(all.length, 'open')],
      }));
    }
    return out;
  },

  plays(src, now) {
    const plays = (src.journal().plays || []).filter((p) => p.at >= now - DAY);
    const failed = plays.filter((p) => p.outcome !== 'ok');
    if (failed.length < 3 || pct(failed.length, plays.length) < 30) return [];
    const reasons = new Map();
    for (const p of failed) {
      const key = p.outcome === 'not-cached' ? 'not cached on ' + p.provider : (p.error || p.outcome);
      reasons.set(key, (reasons.get(key) || 0) + 1);
    }
    const mostlyUncached = failed.filter((p) => p.outcome === 'not-cached').length >= failed.length / 2;
    return [finding('plays', 'playback', 'warning', failed.length + ' of ' + plays.length + ' plays failed today', {
      detail: mostlyUncached
        ? 'Most were no longer cached: the debrid service dropped the file after the links were listed.'
        : 'Links were listed but did not start playing.',
      steps: mostlyUncached
        ? ['Re-open the event so links are checked again.', 'Use the warm option on an uncached row to cache it.']
        : ['Filter Logs to "resolve" for the error.', 'Check the account\'s debrid key on Configure.'],
      fix: { label: 'Resolve logs', href: '/admin/logs?substring=%5Bresolve' },
      evidence: Array.from(reasons.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([r, n]) => n + ' × ' + r),
    })];
  },

  clientCheck(src, now) {
    const latest = src.clientReports()[0];
    if (!latest) {
      return [finding('client-check-none', 'playback', 'notice', 'Client check has never run', {
        detail: 'It opens catalogs and events the way Nuvio does and reports what a client sees.',
        fix: { label: 'Run Client check', href: '/admin/client-check' },
      })];
    }
    const out = [];
    const age = now - Date.parse(latest.startedAt);
    if (age > 7 * DAY) {
      out.push(finding('client-check-old', 'playback', 'notice', 'The last Client check is ' + Math.floor(age / DAY) + ' days old', {
        fix: { label: 'Run Client check', href: '/admin/client-check' },
      }));
    }
    const failed = (latest.events || []).filter((e) => e.verdict === 'fail');
    if (failed.length) {
      out.push(finding('client-events', 'playback', 'critical', plural(failed.length, 'event') + ' failed the last Client check', {
        detail: 'SSS holds a release for them, but the client got no links or broken ones.',
        steps: ['Troubleshoot the first event to see which step fails.'],
        fix: { label: 'Client check report', href: '/admin/client-check' },
        evidence: failed.slice(0, 5).map((e) => e.promotionName + ': ' + (e.eventName || '') + ' (' + ((e.problems || [])[0] || 'failed') + ')'),
      }));
    }
    return out;
  },

  // ------------------------------------------------ Logs, under the stage they affect
  logErrors(src, now) {
    const rows = src.logs({ level: 'error', since: now - DAY, limit: 5000 });
    const stageOf = (c) => (/refresh|promotions|metadata/.test(c) ? 'schedule' : /stream|resolve|warm|nntp|usenet/.test(c) ? 'playback'
      : /prowlarr|sport-video|bitmagnet|http-agent|availability/.test(c) ? 'sources' : 'access');
    const byCategory = new Map();
    for (const r of rows) {
      const key = r.category || 'other';
      if (!byCategory.has(key)) byCategory.set(key, []);
      byCategory.get(key).push(r);
    }
    return Array.from(byCategory.entries()).map(([category, list]) =>
      finding('log:' + category, stageOf(category), 'notice', plural(list.length, 'error') + ' in "' + category + '" today', {
        detail: 'Repeated errors usually mean a connection or login problem in that area.',
        fix: { label: 'Logs', href: '/admin/logs?level=error&category=' + encodeURIComponent(category) },
        evidence: Array.from(new Set(list.slice(-3).reverse().map((r) => String(r.line || '').replace(/^(\[[^\]]*\]\s*)+/, '').slice(0, 160)))),
      }));
  },
};

// Seven-day coverage, as Discovery → Overview computes it. Shared by the
// coverage check and the Coverage vitals, so computed once per run.
function coverageResult(src, now) {
  if (src._coverage) return src._coverage;
  const promotions = src.promotions();
  const data = {
    promotions: promotions.map((p) => ({ id: p.id, name: p.name, enabled: p.enabled, autoTeam: p.autoTeam, releaseDerived: releaseDerived(p) })),
    events: src.events(), queue: src.queueStatus(), releases: src.sportVideoReleases(),
    relevant: (title, event) => {
      const p = promotions.find((x) => x.id === promotionOf(event.id));
      return Boolean(p && p.isRelevantStreamTitle(title, event).ok);
    },
  };
  try {
    data.indexTitles = src.availabilityIndex().eventReleaseTitles(
      require('./discovery-coverage').recentEvents(data.events, now, data.promotions).map((e) => e.id),
      { providers: ['torrent'], identityKinds: ['torrent'] });
  } catch (_) { data.indexTitles = []; }
  src._coverage = src.coverage(data, now);
  return src._coverage;
}

// ---------------------------------------------------------------- vitals

// The few numbers that say how a stage is doing, shown even when nothing is
// wrong. A vital that cannot be read is left out.
const VITALS = {
  access(src, now) {
    const latest = src.clientReports()[0];
    return [
      ['Public address', src.config().publicUrl ? 'Set' : 'Not set'],
      ['Accounts', String(src.users().length)],
      ['Last Client check', latest ? ago(now, Date.parse(latest.startedAt)) : 'Never'],
    ];
  },
  schedule(src, now) {
    const on = src.promotions().filter((p) => p.enabled !== false && !p.autoTeam);
    const today = isoDay(now);
    const week = src.events().filter((e) => e.date >= today && e.date <= isoDay(now + 7 * DAY)).length;
    const status = src.refreshStatus();
    const last = status && Date.parse(status.lastFullRefreshAt || status.finishedAt || 0);
    return [['Promotions on', String(on.length)], ['Events in the next 7 days', String(week)],
      ['Last full refresh', last ? ago(now, last) : 'Not recorded']];
  },
  sources(src, now) {
    const indexers = src.queueStatus().indexers || [];
    const failing = indexers.filter((i) => (Number(i.failures) || 0) >= 3).length;
    let ok = 0;
    let failed = 0;
    for (const d of recentDownloads(src.journal(), now).values()) { ok += d.ok; failed += d.failed; }
    return [
      ['Prowlarr indexers', indexers.length ? (indexers.length - failing) + ' of ' + indexers.length + ' working' : 'None'],
      ['Torrent downloads since yesterday', ok + failed ? pct(ok, ok + failed) + '% worked (' + (ok + failed) + ')' : 'None yet'],
      ['Sport-Video', src.settings().getSportVideo().enabled ? 'On' : 'Off'],
    ];
  },
  matching(src) {
    return [['Promotions with learned rules', String(src.overrides().length)]];
  },
  coverage(src, now) {
    const r = coverageResult(src, now);
    return [['Last 7 days with a saved release', r.total ? r.matched + ' of ' + r.total + ' (' + pct(r.matched, r.total) + '%)' : 'No events'],
      ['Still missing', String(r.missing || 0)]];
  },
  playback(src, now) {
    const opens = (src.journal().opens || []).filter((o) => o.at >= now - DAY);
    const plays = (src.journal().plays || []).filter((p) => p.at >= now - DAY);
    const past = pastOpens(src, now);
    return [
      ['Opens today', String(opens.length)],
      ['Past events with links', past.length ? pct(past.filter((o) => o.rows).length, past.length) + '%' : '—'],
      ['Median time to links', opens.length ? (median(opens.map((o) => o.ms)) / 1000).toFixed(1) + 's' : '—'],
      ['Plays that started', plays.length ? plays.filter((p) => p.outcome === 'ok').length + ' of ' + plays.length : '—'],
    ];
  },
};

// ---------------------------------------------------------------- hidden findings

function mutedFile() {
  const config = require('../config');
  return path.join(path.dirname(config.availabilityDbFile || './data/availability.sqlite'), 'diagnosis-hidden.json');
}
function loadMuted() {
  try { return JSON.parse(fs.readFileSync(mutedFile(), 'utf8')) || {}; } catch (_) { return {}; }
}
function saveMuted(list) {
  fs.mkdirSync(path.dirname(mutedFile()), { recursive: true });
  fs.writeFileSync(mutedFile(), JSON.stringify(list, null, 1), { mode: 0o600 });
}
// Hide a finding for `days`. It comes back early if it becomes more severe.
function mute(id, severity, days, now) {
  const list = loadMuted();
  list[String(id).slice(0, 200)] = { until: (now || Date.now()) + Math.max(1, Math.min(90, Number(days) || 30)) * DAY,
    severity: SEVERITY[severity] === undefined ? 'notice' : severity };
  saveMuted(list);
}
function unmute(id) {
  const list = loadMuted();
  delete list[String(id)];
  saveMuted(list);
}

// ---------------------------------------------------------------- run

function collect(opts) {
  const o = opts || {};
  const src = Object.assign(defaultSources(), o.sources || {});
  // Read the expensive sources once per run.
  for (const name of ['queueStatus', 'journal', 'events', 'clientReports', 'users']) {
    const read = src[name];
    let value;
    let done = false;
    src[name] = () => (done ? value : (done = true, value = read()));
  }
  const now = o.now || Date.now();
  const findings = [];
  const checked = [];
  for (const [name, check] of Object.entries(CHECKS)) {
    try { findings.push(...check(src, now)); checked.push(name); } catch (error) {
      findings.push(finding('check:' + name, 'access', 'notice', 'The "' + name + '" check could not run', {
        detail: String(error && error.message || error).slice(0, 200) }));
    }
  }
  // "X has no events" is the consequence of "X cannot refresh: no key".
  const keyless = new Set(findings.filter((f) => f.id.startsWith('key:')).map((f) => f.id.slice(4)));
  const kept = findings.filter((f) => !(f.id.startsWith('empty:') && keyless.has(f.id.slice(6))));
  let muted = {};
  try { muted = src.muted() || {}; } catch (_) { /* nothing hidden */ }
  const visible = [];
  const hidden = [];
  for (const f of kept) {
    const m = muted[f.id];
    if (m && m.until > now && SEVERITY[f.severity] >= SEVERITY[m.severity]) hidden.push(Object.assign(f, { hiddenUntil: m.until }));
    else visible.push(f);
  }
  visible.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]);
  const stages = STAGES.map((s) => {
    const list = visible.filter((f) => f.stage === s.id);
    let vitals = [];
    try { vitals = VITALS[s.id](src, now); } catch (_) { /* shown without vitals */ }
    const worst = list.length ? list[0].severity : null;
    return Object.assign({}, s, { findings: list, vitals,
      status: worst === 'critical' ? 'problem' : worst === 'warning' ? 'warning' : 'ok' });
  });
  const summary = { critical: 0, warning: 0, notice: 0 };
  for (const f of visible) summary[f.severity] += 1;
  return { at: new Date(now).toISOString(), stages, findings: visible, hidden, summary, checked };
}

// ---------------------------------------------------------------- one event

// Walks one event through the journey and stops at the first step that fails.
// Each step: { id, label, verdict: pass|warn|fail|wait|skip, summary, detail,
// detailLabel, rejections, fix, links }.
function investigate(query, opts) {
  const o = opts || {};
  const src = Object.assign(defaultSources(), o.sources || {});
  const now = o.now || Date.now();
  const q = String(query || '').trim();
  if (!q) return { query: q, matches: [], event: null };
  const events = src.events();
  const exact = events.find((e) => e.id === q);
  const lower = q.toLowerCase();
  const matches = exact ? [exact] : events.filter((e) => String(e.name || '').toLowerCase().includes(lower))
    .sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 25);
  if (!exact && matches.length !== 1) return { query: q, matches, event: null };
  const event = exact || matches[0];
  const promotion = src.promotions().find((p) => p.id === promotionOf(event.id)) || null;
  const review = promotion && (promotion.reviewParent || promotion.id);
  const id = encodeURIComponent(event.id);

  const stored = {};
  try {
    const index = src.availabilityIndex();
    for (const provider of ['torrent', 'native-indexer', 'easynews']) {
      stored[provider] = (index.storedForEvent({ eventId: event.id, provider, limit: 50 }) || [])
        .map((c) => ({ title: c.title, indexer: c.indexer || '' }));
    }
  } catch (_) { /* database unavailable */ }
  const sportVideo = src.sportVideoReleases().filter((r) => (r.matches || []).some((m) => m.eventId === event.id))
    .map((r) => ({ title: r.title, indexer: r.infoHash ? 'Sport-Video' : 'Sport-Video, not prepared' }));
  let queue = null;
  let queueSelected = false;
  try {
    const status = src.queueStatus();
    queue = (status.eventStates || []).find((s) => s.id === event.id) || null;
    queueSelected = Boolean(status.options && status.options.enabled && (status.options.promotions || []).includes(promotionOf(event.id)));
  } catch (_) { /* no queue */ }
  let journal = { opens: [], plays: [] };
  try { journal = src.journal(); } catch (_) { /* no journal */ }
  const opens = (journal.opens || []).filter((x) => x.eventId === event.id).sort((a, b) => b.at - a.at);
  const plays = (journal.plays || []).filter((x) => x.eventId === event.id).sort((a, b) => b.at - a.at);

  const lines = src.logs({ substring: event.id, limit: 5000 });
  const reasons = new Map();
  for (const r of lines) {
    const reason = r.fields && r.fields.reason;
    if (!reason) continue;
    if (!reasons.has(reason)) reasons.set(reason, { reason, count: 0, examples: [] });
    const entry = reasons.get(reason);
    entry.count += 1;
    const title = r.fields.releaseTitle;
    if (title && entry.examples.length < 3 && !entry.examples.includes(title)) entry.examples.push(title);
  }
  const rejections = Array.from(reasons.values()).sort((a, b) => b.count - a.count).slice(0, 8);
  const started = lines.filter((r) => /stream request started/.test(r.line || '')).pop();
  const queries = (started && started.fields && (started.fields.torrentQueryVariants || started.fields.queryVariants)) || [];

  const releases = [...(stored.torrent || []), ...sportVideo, ...(stored['native-indexer'] || []), ...(stored.easynews || [])];
  const start = src.startAt(event);
  const at = Number.isFinite(start) ? start : Date.parse(event.date + 'T12:00:00Z');
  const early = at > now || now - at < 12 * HOUR;
  const steps = [];

  // 1. Listed
  if (!promotion || promotion.enabled === false) {
    steps.push({ id: 'listed', label: 'Listed', verdict: 'fail', summary: (promotion ? promotion.name : 'Its promotion') + ' is switched off, so clients do not see this event.',
      fix: { label: 'Promotions', href: '/admin/promotions' } });
  } else if (/cancel|postpon/i.test(event.status || '')) {
    steps.push({ id: 'listed', label: 'Listed', verdict: 'warn', summary: 'The source marks it ' + event.status + '.',
      fix: { label: 'Event Editor', href: '/admin/events?q=' + id } });
  } else {
    steps.push({ id: 'listed', label: 'Listed', verdict: 'pass',
      summary: 'In ' + promotion.name + ', ' + (Number.isFinite(start) ? new Date(start).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : event.date) + '.',
      links: [{ label: 'Wrong date? Event Editor', href: '/admin/events?q=' + id }] });
  }

  // 2. Aired
  if (at > now) {
    const wait = at - now;
    steps.push({ id: 'aired', label: 'Aired', verdict: 'wait',
      summary: 'Starts in ' + (wait > DAY ? Math.round(wait / DAY) + ' days' : Math.max(1, Math.round(wait / HOUR)) + 'h') + '. Links appear after it airs.' });
  } else if (early && !releases.length) {
    steps.push({ id: 'aired', label: 'Aired', verdict: 'wait', summary: 'Started ' + ago(now, at) + '. Releases usually appear a few hours after the end.' });
  } else {
    steps.push({ id: 'aired', label: 'Aired', verdict: 'pass', summary: 'Started ' + ago(now, at) + '.' });
  }

  // 3. Searched
  const searchHere = searchNow('Search it now', { eventId: event.id }, '/admin/diagnosis?tab=event&q=' + id);
  const by = [];
  if (queue && queue.searched) by.push('the Prowlarr queue (' + queue.state + ')');
  if (opens.length) by.push('live search on ' + plural(opens.length, 'open'));
  if (sportVideo.length) by.push('Sport-Video');
  if (by.length || releases.length) {
    steps.push({ id: 'searched', label: 'Searched', verdict: 'pass', summary: by.length ? 'By ' + by.join(', ') + '.' : 'Releases are saved for it.',
      detail: queries.slice(0, 6), detailLabel: 'Last searched with' });
  } else if (at > now) {
    steps.push({ id: 'searched', label: 'Searched', verdict: 'skip', summary: 'Not yet: it has not aired.' });
  } else {
    steps.push({ id: 'searched', label: 'Searched', verdict: 'warn',
      summary: queueSelected ? 'Waiting for its turn in the Prowlarr queue, and nobody has opened it.'
        : 'Nobody has opened it, and no background source covers ' + (promotion ? promotion.name : 'it') + '.',
      fix: queueSelected ? searchHere : { label: 'Add it to the Prowlarr queue', href: '/admin/discovery?tab=prowlarr' } });
  }

  // 4. Found
  if (releases.length) {
    steps.push({ id: 'found', label: 'Release found', verdict: 'pass', summary: plural(releases.length, 'release') + ' saved.',
      detail: releases.slice(0, 8).map((r) => r.title + (r.indexer ? ' · ' + r.indexer : '')), detailLabel: 'Saved', rejections });
  } else if (early) {
    steps.push({ id: 'found', label: 'Release found', verdict: 'skip', summary: 'Nothing yet, which is expected this soon.' });
  } else if (rejections.length) {
    steps.push({ id: 'found', label: 'Release found', verdict: 'fail', summary: 'Releases were found, but all were turned down.', rejections,
      fix: review ? { label: 'Improve matching', href: '/admin/promotions/' + encodeURIComponent(review) + '/research' } : null,
      links: [{ label: 'Match one by hand', href: '/admin/discovery/manual?eventId=' + id }] });
  } else {
    const byHand = { label: 'Search by hand', href: '/admin/discovery/manual?eventId=' + id };
    steps.push({ id: 'found', label: 'Release found', verdict: 'fail', summary: 'No source returned a usable release.',
      detail: queries.slice(0, 6), detailLabel: 'Searched with',
      fix: queueSelected ? searchHere : byHand,
      links: [queueSelected ? byHand : null, { label: 'Check Sources', href: '/admin/diagnosis#stage-sources' }].filter(Boolean) });
  }

  // 5. Links shown
  const last = opens[0];
  const clientCheck = { label: 'Run Client check on it', href: '/admin/client-check?eventId=' + id };
  if (!last) {
    steps.push({ id: 'shown', label: 'Links shown', verdict: 'skip', summary: 'Not opened in the last 7 days.', fix: clientCheck });
  } else if (!last.rows && !releases.length) {
    // A consequence of the step above, not a second break.
    steps.push({ id: 'shown', label: 'Links shown', verdict: 'skip', summary: 'No links when opened ' + ago(now, last.at) + ', because no release was found.' });
  } else if (!last.rows) {
    steps.push({ id: 'shown', label: 'Links shown', verdict: 'fail',
      summary: 'SSS holds releases, but ' + (last.user || 'the client') + ' got no links ' + ago(now, last.at) + '. That account\'s debrid service may not have them.',
      fix: clientCheck });
  } else {
    const slow = last.ms > 15000;
    steps.push({ id: 'shown', label: 'Links shown', verdict: slow ? 'warn' : 'pass',
      summary: plural(last.rows, 'link') + ' in ' + (last.ms / 1000).toFixed(1) + 's for ' + (last.user || 'a client') + ', ' + ago(now, last.at) + '.'
        + (slow ? ' Slow: a live search ran to its budget.' : ''),
      detail: opens.slice(0, 5).map((x) => ago(now, x.at) + ' · ' + (x.user || '?') + ' · ' + plural(x.rows, 'link') + ' · ' + (x.ms / 1000).toFixed(1) + 's'),
      detailLabel: 'Recent opens' });
  }

  // 6. Played
  const lastPlay = plays[0];
  if (!lastPlay) {
    steps.push({ id: 'played', label: 'Played', verdict: 'skip', summary: 'Nobody pressed play in the last 7 days.' });
  } else if (lastPlay.outcome === 'ok') {
    steps.push({ id: 'played', label: 'Played', verdict: 'pass', summary: 'Started for ' + (lastPlay.user || 'a client') + ' via ' + lastPlay.provider + ', ' + ago(now, lastPlay.at) + '.' });
  } else {
    steps.push({ id: 'played', label: 'Played', verdict: 'fail',
      summary: (lastPlay.outcome === 'not-cached' ? 'No longer cached on ' + lastPlay.provider : 'Failed: ' + (lastPlay.error || lastPlay.outcome)) + ', ' + ago(now, lastPlay.at) + '.',
      fix: { label: 'Its log lines', href: '/admin/logs?substring=' + id } });
  }

  const broken = steps.find((s) => s.verdict === 'fail');
  const waiting = steps.find((s) => s.verdict === 'wait');
  const warned = steps.find((s) => s.verdict === 'warn');
  const verdict = broken ? { tone: 'fail', text: 'Stops at "' + broken.label + '"', step: broken.id }
    : waiting ? { tone: 'wait', text: 'Not ready yet', step: waiting.id }
      : warned ? { tone: 'warn', text: 'Works, with a warning at "' + warned.label + '"', step: warned.id }
        : { tone: 'pass', text: 'Working', step: null };

  return {
    query: q, matches: [event], event, verdict, steps,
    promotion: promotion && { id: promotion.id, name: promotion.name, source: promotion.source && promotion.source.type, reviewParent: review },
    stored, sportVideo, queue, opens, plays, rejections, queries,
  };
}

module.exports = { collect, investigate, mute, unmute, CHECKS, VITALS, STAGES, SEVERITY };
