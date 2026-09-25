'use strict';

// Diagnosis page: Findings, Investigate an event, Tools. Client check keeps its
// own page and appears here as a tab.

const esc = (value) => String(value === undefined || value === null ? '' : value)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TABS = [
  { id: 'findings', label: 'Findings', href: '/admin/diagnosis' },
  { id: 'event', label: 'Investigate an event', href: '/admin/diagnosis?tab=event' },
  { id: 'client-check', label: 'Client check', href: '/admin/client-check' },
  { id: 'tools', label: 'All tools', href: '/admin/diagnosis?tab=tools' },
];

function tabs(active) {
  return '<ul class="nav nav-tabs mb-3">' + TABS.map((t) => '<li class="nav-item"><a class="nav-link'
    + (t.id === active ? ' active' : '') + '" href="' + t.href + '">' + esc(t.label) + '</a></li>').join('') + '</ul>';
}

const TONE = { critical: 'danger', warning: 'warning', notice: 'info' };
const LABEL = { critical: 'Needs attention', warning: 'Worth fixing', notice: 'For information' };

function renderFindings(result) {
  const s = result.summary || {};
  const head = '<div class="row row-cards mb-3">' + ['critical', 'warning', 'notice'].map((sev) =>
    '<div class="col-md-4"><div class="card card-sm"><div class="card-body"><div class="h1 m-0 text-' + TONE[sev] + '">'
    + esc(s[sev] || 0) + '</div><div class="text-secondary">' + LABEL[sev] + '</div></div></div></div>').join('') + '</div>';
  if (!result.findings.length) {
    return head + '<div class="alert alert-success">No problems found. ' + esc(result.checked.length) + ' checks ran.</div>';
  }
  return head + result.findings.map((f) => '<div class="card mb-2 border-' + TONE[f.severity] + '"><div class="card-body">'
    + '<div class="d-flex justify-content-between gap-3 flex-wrap"><div>'
    + '<span class="badge bg-' + TONE[f.severity] + '-lt me-2">' + esc(LABEL[f.severity]) + '</span>'
    + '<span class="badge bg-secondary-lt me-2">' + esc(f.area) + '</span><strong>' + esc(f.title) + '</strong></div>'
    + (f.fix ? '<a class="btn btn-sm btn-primary" href="' + esc(f.fix.href) + '"' + (/^https?:/.test(f.fix.href) ? ' target="_blank" rel="noreferrer noopener"' : '') + '>' + esc(f.fix.label) + ' →</a>' : '')
    + '</div>'
    + (f.detail ? '<p class="text-secondary mb-1 mt-2">' + esc(f.detail) + '</p>' : '')
    + (f.evidence && f.evidence.length ? '<ul class="small mb-0">' + f.evidence.map((e) => '<li>' + esc(e) + '</li>').join('') + '</ul>' : '')
    + '</div></div>').join('')
    + '<p class="text-secondary small mt-3">Checked at ' + esc(result.at.replace('T', ' ').slice(0, 19)) + ' UTC · '
    + esc(result.checked.length) + ' checks. Findings read what SSS already records; nothing is searched or changed.</p>';
}

function renderEvent(result) {
  const form = '<form method="GET" action="/admin/diagnosis" class="row g-2 mb-3"><input type="hidden" name="tab" value="event">'
    + '<div class="col-md-9"><input class="form-control" name="q" value="' + esc(result.query) + '" placeholder="Event name or ID, e.g. Fulham, Austria GP, mlb:824784" autofocus></div>'
    + '<div class="col-md-3"><button class="btn btn-primary w-100">Investigate</button></div></form>';
  if (!result.query) {
    return form + '<p class="text-secondary">Everything SSS knows about one event in one place: its metadata, the releases already saved for it, the recent requests for it and why releases were rejected. Use it when an event has no links, the wrong links, or is slow.</p>';
  }
  if (!result.event) {
    if (!result.matches.length) return form + '<div class="alert alert-warning">No event matches "' + esc(result.query) + '".</div>';
    return form + '<div class="list-group">' + result.matches.map((e) => '<a class="list-group-item list-group-item-action" href="/admin/diagnosis?tab=event&q='
      + encodeURIComponent(e.id) + '">' + esc(e.name) + ' <span class="text-secondary small">· ' + esc(e.date) + ' · ' + esc(e.id) + '</span></a>').join('') + '</div>';
  }
  const e = result.event;
  const p = result.promotion || {};
  const id = encodeURIComponent(e.id);
  const actions = [
    ['Run Client check on this event', '/admin/client-check?eventId=' + id],
    ['Match a torrent by hand', '/admin/discovery/manual?eventId=' + id],
    p.reviewParent ? ['Review aliases', '/admin/promotions/' + encodeURIComponent(p.reviewParent) + '/aliases'] : null,
    p.reviewParent ? ['Improve matching', '/admin/promotions/' + encodeURIComponent(p.reviewParent) + '/research'] : null,
    ['Correct the date', '/admin/events?q=' + id],
    ['Requests in Logs', '/admin/logs?substring=' + id],
  ].filter(Boolean);
  const section = (title, body) => '<div class="card mb-3"><div class="card-header"><h3 class="card-title">' + esc(title) + '</h3></div><div class="card-body">' + body + '</div></div>';
  const releaseList = (rows) => rows && rows.length ? '<ul class="small mb-0">' + rows.slice(0, 12).map((r) => '<li class="text-break">'
    + esc(r.title) + (r.indexer ? ' <span class="text-secondary">· ' + esc(r.indexer) + '</span>' : '') + '</li>').join('')
    + (rows.length > 12 ? '<li class="text-secondary">and ' + (rows.length - 12) + ' more</li>' : '') + '</ul>' : '<span class="text-secondary small">None</span>';
  const saved = result.stored || {};
  return form
    + '<div class="mb-3"><h2 class="mb-1">' + esc(e.name) + '</h2><div class="text-secondary">' + esc(p.name || '') + ' · ' + esc(e.date)
    + (e.timestamp ? ' · starts ' + esc(String(e.timestamp).replace('T', ' ').slice(0, 16)) + ' UTC' : '') + ' · <code>' + esc(e.id) + '</code>'
    + (e.status ? ' · ' + esc(e.status) : '') + '</div>'
    + '<div class="mt-2 d-flex flex-wrap gap-2">' + actions.map(([label, href]) => '<a class="btn btn-sm btn-outline-primary" href="' + esc(href) + '">' + esc(label) + '</a>').join('') + '</div></div>'
    + '<div class="row"><div class="col-lg-6">'
    + section('Releases SSS already holds', '<div class="mb-2"><strong>Torrents</strong>' + releaseList(saved.torrent) + '</div>'
      + '<div class="mb-2"><strong>Built-in Usenet</strong>' + releaseList(saved['native-indexer']) + '</div>'
      + '<div class="mb-2"><strong>Easynews</strong>' + releaseList(saved.easynews) + '</div>'
      + '<div class="mb-2"><strong>Sport-Video matches</strong>' + releaseList((result.sportVideo || []).map((r) => ({ title: r.title + (r.prepared ? '' : ' (not prepared)') }))) + '</div>'
      + '<div><strong>Prowlarr queue</strong><div class="small">' + (result.queue ? esc(result.queue.state) + (result.queue.nextAt ? ' · next try ' + esc(new Date(result.queue.nextAt).toISOString().replace('T', ' ').slice(0, 16)) + ' UTC' : '') : '<span class="text-secondary">Not in the queue</span>') + '</div></div>')
    + section('Promotion setup', '<div class="small">Source: ' + esc(p.source || '?') + '</div><div class="small">Pipelines switched off: '
      + esc((p.disabledPipelines || []).join(', ') || 'none') + '</div>'
      + (result.queries && result.queries.length ? '<div class="small mt-2"><strong>Last searched with</strong><ul class="mb-0">' + result.queries.slice(0, 10).map((q) => '<li>' + esc(q) + '</li>').join('') + '</ul></div>' : ''))
    + '</div><div class="col-lg-6">'
    + section('Recent requests', result.requests.length ? '<div class="table-responsive"><table class="table table-sm"><thead><tr><th>When (UTC)</th><th>User</th><th>Rows</th><th>Time</th><th></th></tr></thead><tbody>'
      + result.requests.map((r) => '<tr><td>' + esc(r.at.replace('T', ' ').slice(5, 19)) + '</td><td>' + esc(r.user) + '</td><td>' + esc(r.rows)
        + (r.pipelineRows ? '<div class="small text-secondary">' + esc(Object.entries(r.pipelineRows).filter(([, n]) => n).map(([k, n]) => k + ' ' + n).join(' · ')) + '</div>' : '')
        + '</td><td>' + esc(r.durationMs ? (r.durationMs / 1000).toFixed(1) + 's' : '') + '</td><td>'
        + (r.requestId ? '<a href="/admin/logs?substring=' + encodeURIComponent(r.requestId) + '">log</a>' : '') + '</td></tr>').join('')
      + '</tbody></table></div>' : '<span class="text-secondary small">None in the current log buffer. Open the event in a client, or run Client check on it.</span>')
    + section('Why releases were turned down', result.rejections.length ? '<ul class="small mb-0">' + result.rejections.map((r) => '<li><strong>'
      + esc(r.reason) + '</strong> × ' + esc(r.count) + (r.examples.length ? '<div class="text-secondary text-break">' + r.examples.map(esc).join('<br>') + '</div>' : '') + '</li>').join('') + '</ul>'
      : '<span class="text-secondary small">No rejections in the current log buffer.</span>')
    + '</div></div>';
}

// Every tool, by the question it answers.
const TOOLS = [
  ['Is everything working?', [
    ['Findings', '/admin/diagnosis', 'Problems found across the whole server, each with the page that fixes it.'],
    ['Client check', '/admin/client-check', 'Walks an account\'s addon the way Nuvio does and reports what a client sees.'],
    ['Discovery overview', '/admin/discovery?tab=overview', 'Seven-day torrent coverage per promotion and every missing event with its reason.'],
    ['Logs', '/admin/logs', 'Live structured log; filter by area, level, user or request.'],
  ]],
  ['Why does an event have no, wrong or slow links?', [
    ['Investigate an event', '/admin/diagnosis?tab=event', 'Saved releases, recent requests and rejection reasons for one event.'],
    ['Manual resource matching', '/admin/discovery/manual', 'Attach a torrent to an event by hand.'],
    ['Event Editor', '/admin/events', 'Correct an event\'s date without changing its source.'],
  ]],
  ['Are searches finding the right releases?', [
    ['Review aliases', '/admin/promotions', 'Per promotion (and its team catalogs): which search patterns find releases, which never do, and how long they take. Open a promotion, then Review aliases.'],
    ['Improve matching', '/admin/promotions', 'Per promotion: learned aliases, keywords and search patterns, tested against real release titles. Open a promotion, then Improve matching.'],
    ['Sport-Video match diagnostics', '/admin/discovery?tab=sport-video', 'Every Sport-Video release near an event and why it matched or not (CSV or JSON).'],
  ]],
  ['Are the sources healthy?', [
    ['Prowlarr queue and indexer budgets', '/admin/discovery?tab=prowlarr', 'Background search progress, per-indexer successes, failures and cooldowns.'],
    ['Sport-Video', '/admin/discovery?tab=sport-video', 'Scan status, errors, preparation and the several-torrents count.'],
    ['Bitmagnet preparation', '/admin/discovery?tab=preparation', 'Background torrent preparation and recent searches.'],
    ['Built-in Usenet', '/admin/usenet', 'Indexer and NNTP connection state, first-byte timing and playback results.'],
    ['Server → Discovery pipelines', '/admin', 'Connections and timing budgets for every discovery source.'],
  ]],
  ['Is the metadata right?', [
    ['Promotions', '/admin/promotions', 'Event counts, refresh, metadata start dates and source previews per promotion.'],
    ['Metadata', '/admin/metadata', 'Metadata providers and API keys.'],
  ]],
  ['Stored data', [
    ['Database', '/admin/database', 'Availability database status, preparation settings and maintenance.'],
    ['Backup', '/admin/backup', 'Download a consistent backup of the data directory.'],
  ]],
];

function renderTools() {
  return TOOLS.map(([question, items]) => '<h3 class="mt-3">' + esc(question) + '</h3><div class="row row-cards">'
    + items.map(([name, href, what]) => '<div class="col-md-6 col-xl-4"><a class="card card-link h-100" href="' + esc(href) + '"><div class="card-body">'
      + '<div class="fw-bold">' + esc(name) + '</div><div class="text-secondary small">' + esc(what) + '</div></div></a></div>').join('')
    + '</div>').join('');
}

function render(data) {
  const tab = ['findings', 'event', 'tools'].includes(data.tab) ? data.tab : 'findings';
  const body = tab === 'event' ? renderEvent(data.investigation || { query: '', matches: [], event: null })
    : tab === 'tools' ? renderTools()
      : renderFindings(data.findings);
  return '<div class="page-header mb-3"><h2 class="page-title">Diagnosis</h2></div>' + tabs(tab) + body;
}

module.exports = { render, renderFindings, renderEvent, renderTools, tabs, TOOLS };
