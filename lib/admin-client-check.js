'use strict';

// Admin page and job runner for lib/client-check.js. One check runs at a time;
// the last few reports are kept next to the availability database so they
// survive a restart.

const fs = require('fs');
const path = require('path');
const config = require('../config');
const clientCheck = require('./client-check');

const KEEP = 5;
let job = null;

function reportsFile() {
  return path.join(path.dirname(config.availabilityDbFile || './data/availability.sqlite'), 'client-check.json');
}
function loadReports() {
  try { return JSON.parse(fs.readFileSync(reportsFile(), 'utf8')).reports || []; } catch (_) { return []; }
}
function saveReport(report) {
  try {
    const reports = [report].concat(loadReports()).slice(0, KEEP);
    fs.mkdirSync(path.dirname(reportsFile()), { recursive: true });
    fs.writeFileSync(reportsFile(), JSON.stringify({ reports }, null, 1), { mode: 0o600 });
  } catch (error) { console.error('[client-check] could not save report: ' + error.message); }
}

function status() {
  return { running: Boolean(job && job.running), progress: job ? job.progress : '', startedAt: job ? job.startedAt : null,
    error: job && job.error || null, reports: loadReports() };
}

// Start a check for one account. Returns false when one is already running.
function start({ user, origin, host, pageProtocol, only, eventId }) {
  if (job && job.running) return false;
  const promotions = require('./promotions');
  const deps = {
    availabilityIndex: () => require('./availability-index').getDefault(),
    sportVideo: () => require('./sources/sport-video'),
    prowlarrQueue: () => require('./prowlarr-discovery').getDefault(),
  };
  job = { running: true, progress: 'Starting', startedAt: new Date().toISOString(), error: null };
  const account = '/u/' + user.id + '/' + user.apiToken + '/';
  clientCheck.run({
    base: 'http://127.0.0.1:' + config.port + account,
    host,
    installUrl: (origin || '') + account + 'manifest.json',
    pageProtocol,
    username: user.username,
    promotions: promotions.all,
    events: require('./store').getEvents(),
    known: clientCheck.knownReleaseEvents(deps),
    only: only && only.length ? only : null,
    eventId: eventId || null,
    onProgress: (text) => { if (job) job.progress = text; },
  }).then((report) => {
    report.scope = eventId ? 'event ' + eventId : (only && only.length ? only.join(', ') : 'all promotions');
    saveReport(report);
    job = { running: false, progress: 'Finished', startedAt: job.startedAt, error: null };
    console.log('[client-check] finished for ' + user.username, report.summary || {});
  }).catch((error) => {
    job = { running: false, progress: 'Failed', startedAt: job.startedAt, error: error.message };
    console.error('[client-check] failed: ' + error.message);
  });
  return true;
}

const esc = (value) => String(value === undefined || value === null ? '' : value)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BADGE = { pass: 'bg-green-lt', warn: 'bg-yellow-lt', info: 'bg-azure-lt', fail: 'bg-red-lt' };
const badge = (verdict) => '<span class="badge ' + (BADGE[verdict] || 'bg-secondary-lt') + '">' + esc(verdict || '?') + '</span>';
const secs = (ms) => (Number(ms) / 1000).toFixed(1) + 's';
const notes = (item) => [].concat((item.problems || []).map((p) => '<div class="text-danger">' + esc(p) + '</div>'),
  (item.warnings || []).map((w) => '<div class="text-secondary">' + esc(w) + '</div>')).join('');

function pipelineCell(entry) {
  const p = entry.pipelines || {};
  const label = { torbox: 'TorBox', 'diy-usenet': 'Usenet', easynews: 'Easynews', uu: 'UU' };
  return Object.entries(p).filter(([, info]) => info.status !== 'skipped').map(([name, info]) =>
    '<div class="small">' + esc(label[name] || name) + ': ' + esc(info.rows) + ' · ' + secs(info.durationMs)
    + (info.status !== 'ok' ? ' <span class="text-danger">' + esc(info.status) + '</span>' : '') + '</div>').join('')
    || '<span class="text-secondary small">—</span>';
}

function renderReport(report) {
  if (!report) return '<p class="text-secondary">No checks yet.</p>';
  const s = report.summary || {};
  const events = (report.events || []).slice().sort((a, b) =>
    ['fail', 'warn', 'info', 'pass'].indexOf(a.verdict) - ['fail', 'warn', 'info', 'pass'].indexOf(b.verdict));
  const catalogs = (report.catalogs || []).slice().sort((a, b) =>
    ['fail', 'warn', 'info', 'pass'].indexOf(a.verdict) - ['fail', 'warn', 'info', 'pass'].indexOf(b.verdict));
  const m = report.manifest || {};
  return '<div class="mb-3"><strong>' + esc(report.account) + '</strong> · ' + esc(report.scope || '') + ' · started '
    + esc(String(report.startedAt || '').replace('T', ' ').slice(0, 19)) + ' UTC · '
    + ['fail', 'warn', 'info', 'pass'].map((v) => badge(v) + ' ' + esc(s[v] || 0)).join(' ') + '</div>'
    + '<h3>Manifest</h3><p>' + badge(m.verdict) + ' version ' + esc(m.version || '?') + ' · ' + esc(m.catalogs || 0)
    + ' catalogs · ' + secs(m.ms || 0) + notes(m) + '</p>'
    + '<h3>Events</h3><p class="text-secondary small">One recently finished event per promotion. <strong>Known release</strong> events hold a saved release, so no rows there is a failure; exploratory events have none on record yet.</p>'
    + '<div class="table-responsive"><table class="table table-sm"><thead><tr><th>Result</th><th>Promotion</th><th>Event</th><th>Rows</th><th>Pipelines</th><th>Time</th><th>Notes</th></tr></thead><tbody>'
    + events.map((e) => '<tr><td>' + badge(e.verdict) + '</td><td>' + esc(e.promotionName) + '</td><td>'
      + (e.eventId ? esc(e.eventName) + '<div class="small text-secondary">' + esc(e.date) + ' · ' + (e.expected ? 'known release' : 'exploratory')
        + (e.requestId ? ' · <a href="/admin/logs?substring=' + encodeURIComponent(e.requestId) + '">log</a>' : '') + '</div>' : '—')
      + '</td><td>' + esc(e.rows === undefined ? '—' : e.rows) + '</td><td>' + pipelineCell(e) + '</td><td>'
      + (e.ms ? secs(e.ms) : '—') + '</td><td>' + notes(e) + '</td></tr>').join('')
    + '</tbody></table></div>'
    + '<h3>Catalogs</h3><div class="table-responsive"><table class="table table-sm"><thead><tr><th>Result</th><th>Catalog</th><th>Items</th><th>Time</th><th>Notes</th></tr></thead><tbody>'
    + catalogs.map((c) => '<tr><td>' + badge(c.verdict) + '</td><td>' + esc(c.name) + '<div class="small text-secondary">' + esc(c.id)
      + '</div></td><td>' + esc(c.items) + '</td><td>' + secs(c.ms) + '</td><td>' + notes(c) + '</td></tr>').join('')
    + '</tbody></table></div>';
}

function render(data) {
  const st = data.status || status();
  const users = data.users || [];
  const promotions = (data.promotions || []).filter((p) => p.enabled !== false && !p.autoTeam);
  const running = st.running
    ? '<div class="alert alert-info">Running: ' + esc(st.progress) + '. This page refreshes itself.</div>'
      + '<script>setTimeout(function(){location.reload();},4000);</script>'
    : (st.error ? '<div class="alert alert-danger">Last check failed: ' + esc(st.error) + '</div>' : '');
  const latest = (st.reports || [])[0];
  const history = (st.reports || []).slice(1).map((r, i) => '<details class="mt-2"><summary>'
    + esc(String(r.startedAt || '').replace('T', ' ').slice(0, 19)) + ' UTC · ' + esc(r.account) + ' · ' + esc(r.scope || '') + '</summary>'
    + renderReport(r) + '</details>').join('');
  return '<div class="page-header"><h2 class="page-title">Client check</h2></div>'
    + '<div class="card mb-3"><div class="card-body">'
    + '<p>Walks an account\'s addon the way Nuvio does — manifest, every catalog, then event details and the stream list — against this server, and reports what a client would see. Nothing is played or sent to TorBox, but stream requests search live like an opened event.</p>'
    + running
    + '<form method="POST" action="/admin/client-check/run" class="row g-2 align-items-end">'
    + '<input type="hidden" name="pageProtocol" id="cc-proto"><script>document.getElementById("cc-proto").value=location.protocol;</script>'
    + '<div class="col-md-3"><label class="form-label">Account</label><select class="form-select" name="userId">'
    + users.map((u) => '<option value="' + esc(u.id) + '"' + (u.id === data.currentUserId ? ' selected' : '') + '>' + esc(u.username) + '</option>').join('')
    + '</select></div>'
    + '<div class="col-md-3"><label class="form-label">Promotion</label><select class="form-select" name="promotion"><option value="">All in the account</option>'
    + promotions.map((p) => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('') + '</select></div>'
    + '<div class="col-md-3"><label class="form-label">Or one event ID</label><input class="form-control" name="eventId" placeholder="e.g. motogp:2368493"></div>'
    + '<div class="col-md-3"><button class="btn btn-primary w-100"' + (st.running ? ' disabled' : '') + '>Run check</button></div>'
    + '</form></div></div>'
    + '<div class="card"><div class="card-body">' + renderReport(latest) + history + '</div></div>';
}

module.exports = { start, status, render, renderReport, reportsFile };
