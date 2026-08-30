'use strict';

const path = require('path');

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function formatTime(value) {
  if (!value) return 'Not yet';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('en-GB') : 'Unknown';
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function statCard(label, value, detail) {
  return '<div class="col-sm-6 col-xl-3"><div class="card"><div class="card-body">'
    + '<div class="subheader">' + escapeHtml(label) + '</div>'
    + '<div class="h1 mb-1">' + escapeHtml(value) + '</div>'
    + '<div class="text-secondary small">' + escapeHtml(detail) + '</div>'
    + '</div></div></div>';
}

function renderBody(input) {
  const data = input || {};
  const stats = data.stats || {};
  const warm = data.warm || {};
  const scheduler = data.scheduler || {};
  const cfg = scheduler.settings || {};
  const searches = Array.isArray(data.searches) ? data.searches : [];
  const providerRows = Object.entries(stats.byProvider || {}).map(([provider, count]) =>
    '<tr><td>' + escapeHtml(provider) + '</td><td class="text-end">' + Number(count || 0) + '</td></tr>'
  ).join('') || '<tr><td colspan="2" class="text-secondary">No fresh observations yet.</td></tr>';
  const searchRows = searches.map((row) => {
    const fresh = Number(row.expiresAt) > Date.now();
    return '<tr><td>' + escapeHtml(row.eventId) + '</td><td>' + escapeHtml(row.provider) + '</td>'
      + '<td class="text-end">' + Number(row.resultCount || 0) + '</td>'
      + '<td>' + escapeHtml(formatTime(row.searchedAt)) + '</td>'
      + '<td><span class="badge ' + (fresh ? 'bg-green-lt' : 'bg-secondary-lt') + '">'
      + (fresh ? 'fresh' : 'expired') + '</span></td></tr>';
  }).join('') || '<tr><td colspan="5" class="text-secondary">No searches recorded yet.</td></tr>';
  const progress = warm.totalProfiles
    ? Math.min(100, Math.round((Number(warm.completedProfiles) || 0) / warm.totalProfiles * 100)) : 0;
  const flash = data.flash ? '<div class="alert alert-info alert-dismissible" role="alert"><div>'
    + escapeHtml(data.flash) + '</div><a class="btn-close" data-bs-dismiss="alert"></a></div>' : '';

  return '<div class="page-header"><div class="row align-items-center"><div class="col">'
    + '<h2 class="page-title">Database</h2>'
    + '<div class="text-secondary mt-1">Smart Availability storage, search reuse and background warming.</div>'
    + '</div><div class="col-auto"><span id="database-live" class="badge bg-green-lt">Live</span></div></div></div>'
    + flash
    + '<div class="row row-cards mb-3">'
    + statCard('Known releases', stats.releases || 0, (stats.eventMatches || 0) + ' event matches')
    + statCard('Fresh searches', stats.freshSearches || 0, (stats.freshObservations || 0) + ' availability observations')
    + statCard('Search reuse', Math.round((stats.hitRate || 0) * 100) + '%',
      (stats.searchHits || 0) + ' hits / ' + (stats.searchMisses || 0) + ' misses')
    + statCard('Database', formatBytes(data.fileSize), 'Schema v' + (stats.schemaVersion || '?') + ' · ' + path.basename(stats.file || 'availability.sqlite'))
    + '</div>'
    + '<div class="row row-cards mb-3">'
    + '<div class="col-lg-7"><div class="card h-100"><div class="card-header"><h3 class="card-title">Background warming</h3>'
    + '<div class="card-actions"><span id="warm-state" class="badge '
    + (warm.running ? 'bg-blue-lt' : cfg.enabled ? 'bg-green-lt' : 'bg-secondary-lt') + '">'
    + (warm.running ? 'Running' : cfg.enabled ? 'Scheduled' : 'Disabled') + '</span></div></div>'
    + '<div class="card-body"><div class="row g-3">'
    + '<div class="col-sm-6"><div class="text-secondary small">Current work</div><div id="warm-current" class="fw-medium">'
    + escapeHtml(warm.currentEvent || (warm.running ? 'Starting…' : 'Idle')) + '</div>'
    + '<div id="warm-profile" class="text-secondary small">' + escapeHtml(warm.currentProfile || '') + '</div></div>'
    + '<div class="col-sm-6"><div class="text-secondary small">Next scheduled run</div><div id="warm-next" class="fw-medium">'
    + escapeHtml(cfg.enabled ? formatTime(scheduler.nextRunAt) : 'Disabled') + '</div></div>'
    + '<div class="col-12"><div class="progress progress-sm"><div id="warm-progress" class="progress-bar" style="width:' + progress + '%"></div></div>'
    + '<div id="warm-progress-label" class="text-secondary small mt-1">' + (warm.completedProfiles || 0) + ' / ' + (warm.totalProfiles || 0) + ' account-event checks</div></div>'
    + '<div class="col-sm-4"><div class="text-secondary small">Last completed</div><div id="warm-last">' + escapeHtml(formatTime(warm.lastCompletedAt)) + '</div></div>'
    + '<div class="col-sm-4"><div class="text-secondary small">Last run</div><div id="warm-counts">' + (warm.attemptedEvents || 0) + ' / ' + (warm.eligibleEvents || 0) + ' events</div></div>'
    + '<div class="col-sm-4"><div class="text-secondary small">Errors</div><div id="warm-errors">' + (warm.errors || 0) + '</div></div>'
    + '<div class="col-12"><div class="text-secondary small">Latest error</div><div id="warm-error" class="text-danger">' + escapeHtml(warm.lastError || 'None') + '</div></div>'
    + '</div></div><div class="card-footer"><form method="POST" action="/admin/database/warm" class="d-inline">'
    + '<button class="btn btn-primary" type="submit">Run warmer now</button></form></div></div></div>'
    + '<div class="col-lg-5"><div class="card h-100"><div class="card-header"><h3 class="card-title">Warmer settings</h3></div>'
    + '<form method="POST" action="/admin/database/settings"><div class="card-body">'
    + '<label class="form-check form-switch mb-3"><input class="form-check-input" type="checkbox" name="enabled" value="on"' + (cfg.enabled ? ' checked' : '') + '><span class="form-check-label">Enable scheduled warming</span></label>'
    + '<div class="row g-3"><div class="col-6"><label class="form-label">Rolling window (days)</label><input class="form-control" type="number" min="1" max="90" name="windowDays" value="' + escapeHtml(cfg.windowDays || 7) + '"></div>'
    + '<div class="col-6"><label class="form-label">Interval (hours)</label><input class="form-control" type="number" min="0.25" max="168" step="0.25" name="intervalHours" value="' + escapeHtml(cfg.intervalHours || 6) + '"></div>'
    + '<div class="col-6"><label class="form-label">Events per run</label><input class="form-control" type="number" min="1" max="500" name="maxEventsPerRun" value="' + escapeHtml(cfg.maxEventsPerRun || 25) + '"></div>'
    + '<div class="col-6"><label class="form-label">Startup delay (seconds)</label><input class="form-control" type="number" min="5" max="3600" name="startDelaySeconds" value="' + escapeHtml(cfg.startDelaySeconds || 60) + '"></div></div>'
    + '<p class="text-secondary small mt-3 mb-0">Saved values override environment defaults and apply to the running scheduler immediately.</p>'
    + '</div><div class="card-footer d-flex gap-2"><button class="btn btn-primary" type="submit">Save settings</button></form>'
    + '<form method="POST" action="/admin/database/settings/reset"><button class="btn btn-outline-secondary" type="submit">Use environment defaults</button></form></div></div></div>'
    + '</div>'
    + '<div class="row row-cards mb-3"><div class="col-lg-4"><div class="card h-100"><div class="card-header"><h3 class="card-title">Fresh provider observations</h3></div>'
    + '<div class="table-responsive"><table class="table card-table table-vcenter"><thead><tr><th>Provider</th><th class="text-end">Rows</th></tr></thead><tbody id="provider-rows">' + providerRows + '</tbody></table></div></div></div>'
    + '<div class="col-lg-8"><div class="card"><div class="card-header"><h3 class="card-title">Recent searches</h3><div class="card-actions text-secondary small">Newest 25</div></div>'
    + '<div class="table-responsive"><table class="table card-table table-vcenter"><thead><tr><th>Event</th><th>Provider</th><th class="text-end">Results</th><th>Searched</th><th>State</th></tr></thead><tbody>' + searchRows + '</tbody></table></div></div></div></div>'
    + '<div class="card border-warning"><div class="card-header"><h3 class="card-title">Database maintenance</h3></div><div class="card-body">'
    + '<p class="text-secondary">Pruning removes expired rows. Wiping removes reusable search and availability knowledge only; accounts, promotions and metadata remain untouched.</p>'
    + '<form method="POST" action="/admin/database/prune" class="d-inline me-2"><button class="btn btn-outline-primary" type="submit">Prune expired rows</button></form>'
    + '<form method="POST" action="/admin/database/wipe" class="d-inline" onsubmit="return confirm(\'Wipe the Smart Availability database? Provider searches will need to run again.\');"><button class="btn btn-outline-danger" type="submit">Wipe database</button></form>'
    + '</div></div>'
    + '<script>(function(){function t(v){if(!v)return "Not yet";var d=new Date(v);return isNaN(d.getTime())?"Unknown":d.toLocaleString("en-GB");}function set(id,value){var e=document.getElementById(id);if(e)e.textContent=value;}function badge(id,value,klass){var e=document.getElementById(id);if(e){e.textContent=value;e.className="badge "+klass;}}async function refresh(){try{var r=await fetch("/admin/database/status.json",{credentials:"same-origin",cache:"no-store"});if(!r.ok)throw new Error("status "+r.status);var d=await r.json(),w=d.warm||{},s=d.scheduler||{},c=s.settings||{};badge("database-live","Live","bg-green-lt");badge("warm-state",w.running?"Running":c.enabled?"Scheduled":"Disabled",w.running?"bg-blue-lt":c.enabled?"bg-green-lt":"bg-secondary-lt");set("warm-current",w.currentEvent||(w.running?"Starting…":"Idle"));set("warm-profile",w.currentProfile||"");set("warm-next",c.enabled?t(s.nextRunAt):"Disabled");set("warm-last",t(w.lastCompletedAt));set("warm-counts",(w.attemptedEvents||0)+" / "+(w.eligibleEvents||0)+" events");set("warm-errors",w.errors||0);set("warm-error",w.lastError||"None");var total=w.totalProfiles||0,done=w.completedProfiles||0,p=total?Math.min(100,Math.round(done/total*100)):0,e=document.getElementById("warm-progress");if(e)e.style.width=p+"%";set("warm-progress-label",done+" / "+total+" account-event checks");}catch(e){badge("database-live","Disconnected","bg-red-lt");}}setInterval(refresh,3000);})();</script>';
}

module.exports = { renderBody, formatBytes, formatTime };
