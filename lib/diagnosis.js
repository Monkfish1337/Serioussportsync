'use strict';

// Diagnosis: one place that looks across everything SSS already records and
// says what is wrong, why, and which page fixes it.
//
// Every signal here existed before, spread over a dozen admin pages: an
// indexer whose login had expired showed only as a cooldown on the Prowlarr
// tab; a learned alias built from one release title hid in Improve matching; a
// team catalog's searches were filed where no page showed them; a missing key
// that stopped a promotion refreshing scrolled out of the log. Each check below
// reads one of those sources and turns it into a finding with a plain-language
// title, the evidence, and a link to the fix.
//
// Checks are independent. One that cannot read its source reports that as a
// notice rather than breaking the page. Nothing here searches a provider or
// changes state.

const DAY = 24 * 60 * 60 * 1000;
const SEVERITY = { critical: 0, warning: 1, notice: 2 };

function defaultSources() {
  return {
    config: () => require('../config'),
    settings: () => require('./settings'),
    promotions: () => require('./promotions').all,
    events: () => require('./store').getEvents(),
    refreshStatus: () => require('./refresh-status').load(),
    queueStatus: () => require('./prowlarr-discovery').getDefault().status(),
    overrides: () => require('./promotion-overrides').list(),
    reviewRows: (id, related) => require('./query-review').getDefault().rows(id, related),
    clientReports: () => require('./admin-client-check').status().reports || [],
    sportVideoStatus: () => require('./sources/sport-video').status(),
    sportVideoReleases: () => require('./sources/sport-video').load().releases || [],
    users: () => require('./users').listUsers().map((u) => require('./users').findById(u.id)).filter(Boolean),
    usenetStatus: (cfg) => require('./diy-usenet-status').status(cfg),
    logs: (opts) => require('./log-buffer').filtered(opts),
    availabilityIndex: () => require('./availability-index').getDefault(),
    coverage: (data, now) => require('./discovery-coverage').coverage(data, now),
  };
}

function finding(severity, area, title, detail, fix, evidence) {
  return { severity, area, title, detail: detail || '', fix: fix || null, evidence: evidence || [] };
}

const today = (now) => new Date(now).toISOString().slice(0, 10);
const plusDays = (now, days) => new Date(now + days * DAY).toISOString().slice(0, 10);
const releaseDerived = (p) => p && p.source && p.source.type === 'sport-video' && String(p.id).startsWith('discovered-');

// ---------------------------------------------------------------- checks

const CHECKS = {
  // Links and bundled artwork are built from the public address.
  publicUrl(src) {
    if (src.config().publicUrl) return [];
    return [finding('warning', 'Setup', 'PUBLIC_URL is not set',
      'SSS builds install and playback links from the address each request arrives on. Behind an HTTPS proxy or tunnel those links come out as http://, and bundled artwork (Discovered catalogs, collection art) has no address at all, so those tiles are blank.',
      { label: 'Reverse proxy setup', href: 'https://github.com/Monkfish1337/Serioussportsync/blob/main/docs/INSTALLATION.md#reverse-proxy-or-tunnel' })];
  },

  // A promotion whose metadata source needs a key it does not have.
  metadataKeys(src) {
    const settings = src.settings();
    const has = {
      tmdb: () => Boolean((settings.getTmdb().apiKey) || (src.config().tmdb && src.config().tmdb.apiKey) || process.env.TMDB_API_KEY),
      'football-data': () => Boolean(settings.getFootballData().apiKey),
      'api-football': () => Boolean(settings.getApiFootball().apiKey),
    };
    const label = { tmdb: 'TMDB', 'football-data': 'football-data.org', 'api-football': 'API-Football' };
    const out = [];
    for (const p of src.promotions()) {
      const type = p.enabled !== false && p.source && p.source.type;
      if (!type || !has[type] || has[type]()) continue;
      out.push(finding('critical', 'Metadata', p.name + ' cannot refresh: no ' + label[type] + ' key',
        'Its schedule comes from ' + label[type] + ', which needs an API key. Until one is saved the catalog keeps whatever it had and gets no new events.',
        { label: 'Add the key on Metadata', href: '/admin/metadata' }));
    }
    return out;
  },

  // The last metadata refresh, from lib/refresh-status.js.
  refresh(src, now) {
    const status = src.refreshStatus();
    const hours = Number(src.config().refreshIntervalHours) || 6;
    if (!status) {
      return [finding('notice', 'Metadata', 'No metadata refresh recorded yet',
        'Refresh outcomes are recorded from this version on. The next scheduled refresh (every ' + hours + 'h) will fill this in.',
        { label: 'Promotions', href: '/admin/promotions' })];
    }
    const out = [];
    const last = Date.parse(status.lastFullRefreshAt || status.finishedAt || 0);
    if (hours > 0 && Number.isFinite(last) && now - last > 2 * hours * 3600000 + 30 * 60000) {
      out.push(finding('warning', 'Metadata', 'The last full refresh was ' + Math.round((now - last) / 3600000) + ' hours ago',
        'Refreshes are scheduled every ' + hours + 'h. A long gap usually means the server restarted repeatedly or a refresh is hanging; check Logs for "[refresh]".',
        { label: 'Refresh logs', href: '/admin/logs?substring=%5Brefresh%5D' }));
    }
    const names = new Map(src.promotions().map((p) => [p.id, p.name]));
    for (const entry of status.promotions || []) {
      if (entry.status === 'ok') continue;
      out.push(finding(entry.status === 'failed' ? 'critical' : 'warning', 'Metadata',
        (names.get(entry.id) || entry.id) + (entry.status === 'failed' ? ' failed to refresh' : ' was skipped in the last refresh'),
        entry.reason || '', { label: 'Promotions', href: '/admin/promotions' },
        [entry.at ? 'At ' + String(entry.at).replace('T', ' ').slice(0, 16) + ' UTC' : ''].filter(Boolean)));
    }
    return out;
  },

  // Catalogs with nothing in them, and weekly shows with no upcoming episode.
  catalogs(src, now) {
    const events = src.events();
    const byPromotion = new Map();
    for (const e of events) {
      const id = String(e.id || '').split(':')[0];
      if (!byPromotion.has(id)) byPromotion.set(id, []);
      byPromotion.get(id).push(e);
    }
    const out = [];
    for (const p of src.promotions()) {
      if (p.enabled === false || p.autoTeam || releaseDerived(p)) continue;
      const list = byPromotion.get(p.id) || [];
      if (!list.length) {
        out.push(finding('warning', 'Metadata', p.name + ' has no events',
          'Its catalogs are empty. Either it has not refreshed since it was added, or its source returns nothing; the refresh finding above, if any, says which.',
          { label: 'Refresh it on Promotions', href: '/admin/promotions' }));
        continue;
      }
      if (p.weeklyShow) {
        const soon = list.some((e) => e.date >= today(now) && e.date <= plusDays(now, 10));
        const recent = list.some((e) => e.date < today(now) && e.date >= plusDays(now, -10));
        if (!soon && recent) {
          out.push(finding('warning', 'Metadata', p.name + ' has no upcoming episodes',
            'The show aired in the last ten days but nothing is listed for the next ten, so its Upcoming row is empty. TheSportsDB\'s free key often lists weekly episodes only once they air.',
            { label: 'Event Editor', href: '/admin/events' }));
        }
      }
    }
    return out;
  },

  // Seven-day torrent coverage, as Discovery → Overview computes it.
  coverage(src, now) {
    const queue = src.queueStatus();
    const promotions = src.promotions();
    const data = {
      promotions: promotions.map((p) => ({ id: p.id, name: p.name, enabled: p.enabled, autoTeam: p.autoTeam, releaseDerived: releaseDerived(p) })),
      events: src.events(), queue, releases: src.sportVideoReleases(),
      relevant: (title, event) => {
        const p = promotions.find((x) => x.id === String(event.id).split(':')[0]);
        return Boolean(p && p.isRelevantStreamTitle(title, event).ok);
      },
    };
    try {
      data.indexTitles = src.availabilityIndex().eventReleaseTitles(
        require('./discovery-coverage').recentEvents(data.events, now, data.promotions).map((e) => e.id),
        { providers: ['torrent'], identityKinds: ['torrent'] });
    } catch (_) { data.indexTitles = []; }
    const result = src.coverage(data, now);
    const out = [];
    for (const group of result.promotions || []) {
      if (group.missing < 3 || group.missing / Math.max(1, group.total) < 0.25) continue;
      const reasons = Object.entries(group.reasons || {}).sort((a, b) => b[1] - a[1]).map(([r, n]) => n + ' · ' + r);
      const name = (promotions.find((p) => p.id === group.id) || {}).name || group.id;
      out.push(finding(group.missing / group.total >= 0.5 ? 'critical' : 'warning', 'Discovery',
        name + ': ' + group.missing + ' of ' + group.total + ' recent events have no saved torrent',
        '"Awaiting retry" on most of them usually means an indexer stopped returning downloads (see the indexer findings); "not selected" means no background source covers this promotion.',
        { label: 'Missing events', href: '/admin/discovery?tab=overview&promotion=' + encodeURIComponent(group.id) }, reasons.slice(0, 3)));
    }
    return out;
  },

  // Prowlarr indexers failing in a row. The most productive one failing is how
  // an expired 720pier login looked: nothing in Prowlarr's health, only here.
  indexers(src, now) {
    const status = src.queueStatus();
    const indexers = status.indexers || [];
    const best = Math.max(0, ...indexers.map((i) => Number(i.successes) || 0));
    const out = [];
    for (const i of indexers) {
      if ((Number(i.failures) || 0) < 3) continue;
      const top = best > 0 && Number(i.successes) === best;
      const until = Number(i.next_at) > now ? ' Paused until ' + new Date(Number(i.next_at)).toISOString().slice(11, 16) + ' UTC.' : '';
      out.push(finding(top ? 'critical' : 'warning', 'Indexers',
        i.name + ' has failed ' + i.failures + ' times in a row' + (top ? ' (your most productive indexer)' : ''),
        'Searches keep failing or return results whose torrents cannot be downloaded. For a login-based tracker the usual cause is an expired cookie or session in Prowlarr: refresh it there, then reset the cooldown.' + until,
        { label: 'Indexer budgets', href: '/admin/discovery?tab=prowlarr' },
        [i.successes + ' successful searches so far']));
    }
    return out;
  },

  // Learned matching rules that name one event. A saved alias of
  // "MotoGP 2026x14 San Marino Qualifying" prefixed every MotoGP search.
  learnedRules(src) {
    const suspicious = /\b(?:19|20)\d{2}x\d+\b|\bround\s*\d+|\br\d{2}\b|\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b|\b(?:19|20)\d{2}[.-]\d{2}[.-]\d{2}\b|\bs\d{2}e\d{2}\b|#\d+|\b(?:practice|qualifying|sprint|week)\s*\d+\b/i;
    const names = new Map(src.promotions().map((p) => [p.id, p.name]));
    const out = [];
    for (const o of src.overrides()) {
      const hits = [].concat(o.promotionAliases || [], o.relevanceKeywords || [], o.searchTitleTemplates || [])
        .filter((v) => suspicious.test(String(v).replace(/\{[a-z_]+\}/g, '')));
      if (!hits.length) continue;
      out.push(finding('warning', 'Matching', (names.get(o.promotionId) || o.promotionId) + ' has learned rules that name a single event',
        'Aliases and keywords are added to every search for the promotion. One copied from a single release title (a round, date or session number) searches for that release on every event and finds nothing.',
        { label: 'Improve matching', href: '/admin/promotions/' + encodeURIComponent(o.promotionId) + '/research' },
        hits.slice(0, 4).map((h) => '"' + h + '"')));
    }
    return out;
  },

  // Query patterns with repeated zero hits, per promotion.
  zeroPatterns(src) {
    const promotions = src.promotions();
    const out = [];
    for (const p of promotions) {
      if (p.enabled === false || p.autoTeam) continue;
      const related = promotions.filter((x) => x.reviewParent === p.id).map((x) => x.id);
      let rows = [];
      try { rows = src.reviewRows(p.id, related); } catch (_) { continue; }
      const flagged = rows.filter((r) => r.flag === 'Repeated zero hits' && r.action === 'active');
      if (!flagged.length) continue;
      out.push(finding('notice', 'Matching', p.name + ': ' + flagged.length + ' search pattern' + (flagged.length === 1 ? '' : 's') + ' never find anything',
        'Each has had at least 10 searches across 5 past events with no results. Demoting or disabling them makes searches for this promotion faster.',
        { label: 'Review aliases', href: '/admin/promotions/' + encodeURIComponent(p.id) + '/aliases' },
        flagged.slice(0, 3).map((r) => r.pattern + ' (' + r.source + ')')));
    }
    return out;
  },

  // The last Client check.
  clientCheck(src, now) {
    const latest = src.clientReports()[0];
    if (!latest) {
      return [finding('notice', 'Clients', 'No Client check has been run',
        'Client check walks an account\'s addon the way Nuvio does and reports empty catalogs, failing pipelines and slow events.',
        { label: 'Run Client check', href: '/admin/client-check' })];
    }
    const out = [];
    const age = now - Date.parse(latest.startedAt);
    if (age > 7 * DAY) {
      out.push(finding('notice', 'Clients', 'The last Client check is ' + Math.floor(age / DAY) + ' days old',
        'Run it again after changes to see what a client sees now.', { label: 'Run Client check', href: '/admin/client-check' }));
    }
    const failed = (latest.events || []).filter((e) => e.verdict === 'fail');
    if (failed.length) {
      out.push(finding('critical', 'Clients', failed.length + ' event' + (failed.length === 1 ? '' : 's') + ' failed the last Client check',
        'These events have a release on record but gave a client no rows, or broken rows.',
        { label: 'Client check report', href: '/admin/client-check' },
        failed.slice(0, 5).map((e) => e.promotionName + ': ' + (e.eventName || '') + ' (' + (e.problems || [])[0] + ')')));
    }
    const slow = (latest.events || []).filter((e) => (e.warnings || []).some((w) => /^slow/.test(w)));
    if (slow.length >= 3) {
      out.push(finding('notice', 'Clients', slow.length + ' events took over 15 seconds in the last Client check',
        'First opens are slow when a live search (usually built-in Usenet) runs to the discovery budget. Background Usenet preparation on the Database page answers them from the database instead.',
        { label: 'Database preparation', href: '/admin/database' },
        slow.slice(0, 5).map((e) => e.promotionName + ' · ' + (e.ms / 1000).toFixed(1) + 's')));
    }
    return out;
  },

  sportVideo(src) {
    const settings = src.settings().getSportVideo();
    if (!settings.enabled) return [];
    const status = src.sportVideoStatus();
    if (!status.lastError) return [];
    return [finding('warning', 'Discovery', 'Sport-Video\'s last run reported an error', status.lastError,
      { label: 'Sport-Video', href: '/admin/discovery?tab=sport-video' })];
  },

  // Administrators with built-in Usenet switched on but not usable.
  usenet(src) {
    const out = [];
    for (const user of src.users()) {
      if (!user || user.role !== 'admin') continue;
      const status = src.usenetStatus(user.config || {});
      if (!status.enabled || status.ready) continue;
      const missing = [!status.discovery ? 'an indexer' : '', !status.playback ? 'an NNTP provider' : ''].filter(Boolean).join(' and ');
      out.push(finding('warning', 'Playback', 'Built-in Usenet is on for ' + user.username + ' but is missing ' + missing,
        'No Usenet rows are produced until both are configured.', { label: 'Usenet settings', href: '/admin/usenet' }));
    }
    return out;
  },

  // Errors in the last 24 hours of the log buffer, grouped by area.
  logErrors(src, now) {
    const rows = src.logs({ level: 'error', since: now - DAY, limit: 5000 });
    if (!rows.length) return [];
    const byCategory = new Map();
    for (const r of rows) {
      const key = r.category || 'other';
      if (!byCategory.has(key)) byCategory.set(key, []);
      byCategory.get(key).push(r);
    }
    return Array.from(byCategory.entries()).sort((a, b) => b[1].length - a[1].length).map(([category, list]) =>
      finding('notice', 'Logs', list.length + ' error' + (list.length === 1 ? '' : 's') + ' in "' + category + '" in the last 24 hours',
        'The most recent is shown below. Recurring errors usually point at a connection or credential problem in that area.',
        { label: 'Filtered logs', href: '/admin/logs?level=error&category=' + encodeURIComponent(category) },
        Array.from(new Set(list.slice(-3).reverse().map((r) => String(r.line || '').replace(/^(\[[^\]]*\]\s*)+/, '').slice(0, 160))))));
  },
};

// Run every check. `only` limits to named checks; a check that throws becomes
// a notice, never a broken page.
function collect(opts) {
  const o = opts || {};
  const src = Object.assign(defaultSources(), o.sources || {});
  // Two checks read the Prowlarr queue status; it is not cheap, so once.
  const queueStatus = src.queueStatus;
  let queueCache;
  src.queueStatus = () => (queueCache || (queueCache = queueStatus()));
  const now = o.now || Date.now();
  const findings = [];
  const checked = [];
  for (const [name, check] of Object.entries(CHECKS)) {
    if (o.only && !o.only.includes(name)) continue;
    try {
      findings.push(...check(src, now));
      checked.push(name);
    } catch (error) {
      findings.push(finding('notice', 'Diagnosis', 'The "' + name + '" check could not run', String(error && error.message || error).slice(0, 200)));
    }
  }
  // "X has no events" is only the consequence when X is already reported as
  // unable to refresh for a missing key; keep the cause.
  const keyless = new Set(findings.filter((f) => / cannot refresh: no .* key$/.test(f.title))
    .map((f) => f.title.replace(/ cannot refresh: no .* key$/, '')));
  for (let i = findings.length - 1; i >= 0; i--) {
    const m = / has no events$/.exec(findings[i].title);
    if (m && keyless.has(findings[i].title.slice(0, m.index))) findings.splice(i, 1);
  }
  findings.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || a.area.localeCompare(b.area));
  const summary = { critical: 0, warning: 0, notice: 0 };
  for (const f of findings) summary[f.severity] += 1;
  return { at: new Date(now).toISOString(), findings, summary, checked };
}

// ---------------------------------------------------------------- one event

// Everything SSS knows about one event, for "why does this event have no or
// wrong links?".
function investigate(query, opts) {
  const o = opts || {};
  const src = Object.assign(defaultSources(), o.sources || {});
  const q = String(query || '').trim();
  const events = src.events();
  if (!q) return { query: q, matches: [], event: null };
  const exact = events.find((e) => e.id === q);
  const lower = q.toLowerCase();
  const matches = exact ? [exact] : events.filter((e) => String(e.name || '').toLowerCase().includes(lower))
    .sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 25);
  if (!exact && matches.length !== 1) return { query: q, matches, event: null };
  const event = exact || matches[0];
  const promotions = src.promotions();
  const promotion = promotions.find((p) => p.id === String(event.id).split(':')[0]) || null;
  const parent = promotion && promotion.reviewParent ? promotion.reviewParent : promotion && promotion.id;

  const stored = {};
  try {
    const index = src.availabilityIndex();
    for (const provider of ['torrent', 'native-indexer', 'easynews']) {
      stored[provider] = (index.storedForEvent({ eventId: event.id, provider, limit: 50 }) || [])
        .map((c) => ({ title: c.title, indexer: c.indexer || '', hash: c.infoHash ? String(c.infoHash).slice(0, 8) : '' }));
    }
  } catch (_) { /* availability database unavailable */ }
  const sportVideo = src.sportVideoReleases().filter((r) => (r.matches || []).some((m) => m.eventId === event.id))
    .map((r) => ({ title: r.title, prepared: Boolean(r.infoHash) }));
  let queue = null;
  try {
    const status = src.queueStatus();
    const state = (status.eventStates || []).find((s) => s.id === event.id);
    queue = state ? { state: state.state, nextAt: state.nextAt } : null;
  } catch (_) { /* no queue */ }

  const lines = src.logs({ substring: event.id, limit: 5000 });
  const requests = lines.filter((r) => /stream request complete/.test(r.line || '')).slice(-10).reverse().map((r) => ({
    at: new Date(r.ts).toISOString(), user: r.user || '', requestId: r.requestId || '',
    durationMs: r.fields && r.fields.durationMs, rows: r.fields && r.fields.rows, pipelineRows: r.fields && r.fields.pipelineRows,
  }));
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
  let queries = [];
  const started = lines.filter((r) => /stream request started/.test(r.line || '')).pop();
  if (started && started.fields) queries = started.fields.queryVariants || [];

  return {
    query: q, matches: [event], event, promotion: promotion && {
      id: promotion.id, name: promotion.name, source: promotion.source && promotion.source.type,
      disabledPipelines: promotion.disabledPipelines || [], reviewParent: parent,
    },
    stored, sportVideo, queue, requests,
    rejections: Array.from(reasons.values()).sort((a, b) => b.count - a.count).slice(0, 12),
    queries,
  };
}

module.exports = { collect, investigate, CHECKS, SEVERITY };
