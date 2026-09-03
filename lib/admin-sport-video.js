'use strict';

const { escapeHtml } = require('./tabler-chrome');

const CATEGORY_LABELS = Object.freeze({
  americanfootball: 'American football', basketball: 'Basketball', baseball: 'Baseball',
  football: 'Football', hockey: 'Hockey', rugby: 'Rugby / AFL / GAA', other: 'Other sport',
});

function formatTime(value) {
  if (!value) return 'Not yet';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString('en-GB');
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (!bytes) return 'Unknown size';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return (bytes / Math.pow(1024, power)).toFixed(power > 2 ? 2 : 1) + ' ' + units[power];
}

function statCard(label, value, detail, color) {
  return '<div class="col-sm-6 col-lg-3"><div class="card"><div class="card-body">'
    + '<div class="text-secondary text-uppercase small fw-bold">' + escapeHtml(label) + '</div>'
    + '<div class="display-6 mt-1 text-' + escapeHtml(color || 'primary') + '">' + escapeHtml(value) + '</div>'
    + '<div class="text-secondary small mt-1">' + escapeHtml(detail || '') + '</div>'
    + '</div></div></div>';
}

function badge(state) {
  const map = {
    cached: ['Ready', 'green'], warmable: ['Warmable', 'orange'],
    prepare: ['Needs preparation', 'azure'], unmatched: ['Unmatched', 'secondary'], error: ['Prepare failed', 'red'],
  };
  const value = map[state] || [state, 'secondary'];
  return '<span class="badge bg-' + value[1] + '-lt">' + escapeHtml(value[0]) + '</span>';
}

function row(record, cached, torboxConfigured) {
  const matches = Array.isArray(record.matches) ? record.matches : [];
  const match = matches[0];
  let state = 'unmatched';
  if (match && record.prepareError) state = 'error';
  else if (match && !record.infoHash) state = 'prepare';
  else if (match && cached) state = 'cached';
  else if (match && record.infoHash) state = 'warmable';
  const matchHtml = match
    ? '<div class="fw-medium">' + escapeHtml(match.eventTitle) + '</div><div class="text-secondary small">'
      + escapeHtml(match.promotion) + (matches.length > 1 ? ' · +' + (matches.length - 1) + ' match' : '') + '</div>'
    : '<span class="text-secondary">No current SSS event</span>';
  let action = '';
  if (match && !record.infoHash) {
    action = '<form method="POST" action="/admin/sport-video/prepare/' + encodeURIComponent(record.id) + '">'
      + '<button class="btn btn-sm btn-outline-primary" type="submit">Prepare</button></form>';
  } else if (match && record.infoHash && !cached) {
    action = torboxConfigured
      ? '<form method="POST" action="/admin/sport-video/warm/' + encodeURIComponent(record.id) + '">'
        + '<button class="btn btn-sm btn-warning" type="submit">Warm to TorBox</button></form>'
      : '<span class="text-secondary small">Configure TorBox in Account</span>';
  } else if (cached) {
    action = '<span class="text-success small fw-medium">Available on the matched event</span>';
  }
  return '<tr data-search="' + escapeHtml([record.title, record.category, match && match.eventTitle, state].join(' ').toLowerCase())
    + '" data-state="' + escapeHtml(state) + '" data-category="' + escapeHtml(record.category) + '">'
    + '<td class="text-nowrap">' + escapeHtml(record.date || 'Unknown') + '</td>'
    + '<td><div class="fw-medium">' + escapeHtml(record.title) + '</div><div class="text-secondary small">'
      + escapeHtml(record.resolution || record.video || '') + (record.language ? ' · ' + escapeHtml(record.language) : '')
      + (record.infoHash ? ' · ' + escapeHtml(formatBytes(record.size)) : '') + '</div></td>'
    + '<td>' + escapeHtml(CATEGORY_LABELS[record.category] || record.category) + '</td>'
    + '<td>' + matchHtml + '</td><td>' + badge(state)
      + (record.prepareError ? '<div class="text-danger small mt-1">' + escapeHtml(record.prepareError) + '</div>' : '')
      + '</td><td class="text-end">' + action + '</td></tr>';
}

function renderBody(data) {
  const cfg = data.config || {};
  const status = data.status || {};
  const releases = data.releases || [];
  const cached = data.cached || new Set();
  const checkboxes = Object.entries(CATEGORY_LABELS).map(([value, label]) =>
    '<label class="form-check form-check-inline"><input class="form-check-input" type="checkbox" name="categories" value="'
      + escapeHtml(value) + '"' + ((cfg.categories || []).includes(value) ? ' checked' : '') + '><span class="form-check-label">'
      + escapeHtml(label) + '</span></label>').join('');
  const rows = releases.map((record) => row(record, cached.has(String(record.infoHash || '').toLowerCase()), data.torboxConfigured)).join('');
  const flash = data.flash ? '<div class="alert alert-info" role="alert">' + escapeHtml(data.flash) + '</div>' : '';
  return flash
    + '<div class="page-header d-print-none"><div class="row align-items-center"><div class="col">'
    + '<div class="page-pretitle">Direct release discovery</div><h2 class="page-title">Sport-Video</h2>'
    + '<div class="text-secondary mt-1">A curated event source that complements Companion and Prowlarr. Discovery and cache checks are read-only; warming is always your choice.</div>'
    + '</div><div class="col-auto"><span class="badge ' + (status.running ? 'bg-blue-lt' : cfg.enabled ? 'bg-green-lt' : 'bg-secondary-lt') + '">'
    + (status.running ? 'Scanning' : cfg.enabled ? 'Enabled' : 'Disabled') + '</span></div></div></div>'
    + '<div class="row row-cards mt-1">'
    + statCard('Discovered', status.releases || 0, (status.rssCount || 0) + ' current RSS titles', 'azure')
    + statCard('Matched', status.matched || 0, 'Connected to current SSS events', 'blue')
    + statCard('Prepared', status.prepared || 0, 'Validated torrent identities', 'purple')
    + statCard('Ready on TorBox', cached.size || 0, data.torboxConfigured ? 'Checked with this admin account' : 'TorBox key not configured', 'green')
    + '</div>'
    + '<div class="row row-cards mt-1"><div class="col-lg-7"><div class="card"><div class="card-header">'
    + '<div><h3 class="card-title">Source controls</h3><div class="text-secondary small">Fixed to sport-video.org.ua; external URLs and redirects are rejected.</div></div></div>'
    + '<form method="POST" action="/admin/sport-video/settings"><div class="card-body">'
    + '<label class="form-check form-switch"><input class="form-check-input" type="checkbox" name="enabled" value="on"'
      + (cfg.enabled ? ' checked' : '') + '><span class="form-check-label"><strong>Enable Sport-Video results</strong></span><span class="form-check-description">Adds matched releases to event TorBox results alongside existing pipelines.</span></label>'
    + '<label class="form-check form-switch mt-3"><input class="form-check-input" type="checkbox" name="autoScan" value="on"'
      + (cfg.autoScan ? ' checked' : '') + '><span class="form-check-label"><strong>Scan automatically</strong></span><span class="form-check-description">Checks category indexes periodically without automatically adding torrents to TorBox.</span></label>'
    + '<div class="mt-3"><label class="form-label">Included sports</label><div>' + checkboxes + '</div></div>'
    + '<div class="row mt-3"><div class="col-sm-4"><label class="form-label">Every (hours)</label><input class="form-control" type="number" min="1" max="168" step="1" name="intervalHours" value="'
      + escapeHtml(cfg.intervalHours || 6) + '"></div><div class="col-sm-4"><label class="form-label">Startup delay (seconds)</label><input class="form-control" type="number" min="10" max="3600" name="startDelaySeconds" value="'
      + escapeHtml(cfg.startDelaySeconds || 90) + '"></div><div class="col-sm-4"><label class="form-label">Prepare per scan</label><input class="form-control" type="number" min="1" max="200" name="maxDetailsPerScan" value="'
      + escapeHtml(cfg.maxDetailsPerScan || 50) + '"></div></div></div>'
    + '<div class="card-footer d-flex gap-2"><button class="btn btn-primary" type="submit">Save settings</button></form>'
    + '<form method="POST" action="/admin/sport-video/scan"><button class="btn btn-outline-primary" type="submit"'
      + (status.running ? ' disabled' : '') + '>' + (status.running ? 'Scan running…' : 'Scan now') + '</button></form></div></div></div>'
    + '<div class="col-lg-5"><div class="card"><div class="card-header"><h3 class="card-title">Latest scan</h3></div><div class="card-body">'
    + '<div class="datagrid"><div class="datagrid-item"><div class="datagrid-title">Last completed</div><div class="datagrid-content">' + escapeHtml(formatTime(status.completedAt)) + '</div></div>'
    + '<div class="datagrid-item"><div class="datagrid-title">Current work</div><div class="datagrid-content">' + escapeHtml(status.current || 'Idle') + '</div></div>'
    + '<div class="datagrid-item"><div class="datagrid-title">Unmatched</div><div class="datagrid-content">' + escapeHtml(status.unmatched || 0) + '</div></div>'
    + '<div class="datagrid-item"><div class="datagrid-title">Last error</div><div class="datagrid-content ' + (status.lastError ? 'text-danger' : 'text-success') + '">' + escapeHtml(status.lastError || 'None') + '</div></div></div>'
    + '<div class="alert alert-warning mt-3 mb-0"><strong>Operator-controlled source.</strong> Availability and rights vary by release and jurisdiction. SSS does not bulk-submit or automatically warm this catalogue.</div>'
    + '</div></div></div></div>'
    + '<div class="card mt-3"><div class="card-header"><div><h3 class="card-title">Discovered releases</h3><div class="text-secondary small">Newest 200 retained rows · exact event matching before TorBox checks</div></div></div>'
    + '<div class="card-body border-bottom"><div class="row g-2"><div class="col-md-5"><input id="sv-search" class="form-control" type="search" placeholder="Filter by release, event or promotion"></div>'
    + '<div class="col-md-3"><select id="sv-state" class="form-select"><option value="">All states</option><option value="cached">Ready</option><option value="warmable">Warmable</option><option value="prepare">Needs preparation</option><option value="unmatched">Unmatched</option><option value="error">Errors</option></select></div>'
    + '<div class="col-md-2"><select id="sv-category" class="form-select"><option value="">All sports</option>'
    + Object.entries(CATEGORY_LABELS).map(function categoryOption(entry) { return '<option value="' + escapeHtml(entry[0]) + '">' + escapeHtml(entry[1]) + '</option>'; }).join('') + '</select></div>'
    + '<div class="col-md-2"><span id="sv-count" class="form-control text-secondary">' + releases.length + ' shown</span></div></div></div>'
    + '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th>Date</th><th>Source release</th><th>Sport</th><th>Matched SSS event</th><th>State</th><th></th></tr></thead><tbody id="sv-rows">'
    + (rows || '<tr><td colspan="6" class="text-secondary py-5 text-center">No discoveries yet. Enable the source and run the first scan.</td></tr>')
    + '</tbody></table></div></div>'
    + '<script>(function(){var q=document.getElementById("sv-search"),s=document.getElementById("sv-state"),g=document.getElementById("sv-category"),c=document.getElementById("sv-count");function f(){var text=(q.value||"").toLowerCase(),state=s.value,category=g.value,n=0;document.querySelectorAll("#sv-rows tr[data-search]").forEach(function(r){var show=(!text||r.dataset.search.indexOf(text)>=0)&&(!state||r.dataset.state===state)&&(!category||r.dataset.category===category);r.hidden=!show;if(show)n++;});c.textContent=n+" shown";}q.addEventListener("input",f);s.addEventListener("change",f);g.addEventListener("change",f);}());</script>';
}

module.exports = { renderBody, CATEGORY_LABELS };
