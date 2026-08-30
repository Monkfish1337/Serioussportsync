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

function formatDuration(value) {
  const milliseconds = Math.max(0, Number(value) || 0);
  if (milliseconds < 1000) return milliseconds + ' ms';
  return (milliseconds / 1000).toFixed(milliseconds < 10000 ? 1 : 0) + ' s';
}

function renderWarmProviders(providerStatus) {
  const entries = Object.entries(providerStatus || {});
  if (!entries.length) {
    return '<tr><td colspan="7" class="text-secondary">No provider attempts recorded in this run yet.</td></tr>';
  }
  return entries.map(([provider, row]) => {
    const attempts = Number(row.attempts) || 0;
    const average = attempts ? (Number(row.totalDurationMs) || 0) / attempts : 0;
    const state = row.suppressed
      ? '<span class="badge bg-orange-lt">Suppressed</span>'
      : row.failures && !row.successes
        ? '<span class="badge bg-red-lt">Failing</span>'
        : '<span class="badge bg-green-lt">Available</span>';
    return '<tr><td class="fw-medium">' + escapeHtml(provider) + '</td>'
      + '<td class="text-end">' + attempts + '</td>'
      + '<td class="text-end text-success">' + (Number(row.successes) || 0) + '</td>'
      + '<td class="text-end text-danger">' + (Number(row.failures) || 0) + '</td>'
      + '<td class="text-end">' + (Number(row.skipped) || 0) + '</td>'
      + '<td>' + escapeHtml(formatDuration(average)) + ' avg · '
      + escapeHtml(formatDuration(row.lastDurationMs)) + ' last</td>'
      + '<td>' + state + '<div class="text-secondary small mt-1">Last success: '
      + escapeHtml(formatTime(row.lastSuccessAt)) + '</div>'
      + (row.lastError ? '<div class="text-danger small">' + escapeHtml(row.lastError) + '</div>' : '')
      + '</td></tr>';
  }).join('');
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
    return '<tr><td><div class="fw-medium">' + escapeHtml(row.eventTitle || row.eventId) + '</div>'
      + (row.eventTitle ? '<div class="text-secondary small text-mono">' + escapeHtml(row.eventId) + '</div>' : '')
      + '</td><td>' + escapeHtml(row.provider) + '</td>'
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
      (stats.searchHits || 0) + ' hits / ' + (stats.searchMisses || 0) + ' misses · '
      + (stats.confirmedHits || 0) + ' confirmed serves')
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
    + '<label class="form-check form-switch mb-3"><input class="form-check-input" type="checkbox" name="serveConfirmed" value="on"' + (cfg.serveConfirmed !== false ? ' checked' : '') + '><span class="form-check-label">Serve fresh confirmed results when discovery is unavailable</span><span class="form-check-description">Results remain account-scoped and are revalidated by the provider when playback starts.</span></label>'
    + '<div class="row g-3"><div class="col-6"><label class="form-label">Rolling window (days)</label><input class="form-control" type="number" min="1" max="90" name="windowDays" value="' + escapeHtml(cfg.windowDays || 7) + '"></div>'
    + '<div class="col-6"><label class="form-label">Interval (hours)</label><input class="form-control" type="number" min="0.25" max="168" step="0.25" name="intervalHours" value="' + escapeHtml(cfg.intervalHours || 6) + '"></div>'
    + '<div class="col-6"><label class="form-label">Events per run</label><input class="form-control" type="number" min="1" max="500" name="maxEventsPerRun" value="' + escapeHtml(cfg.maxEventsPerRun || 25) + '"></div>'
    + '<div class="col-6"><label class="form-label">Startup delay (seconds)</label><input class="form-control" type="number" min="5" max="3600" name="startDelaySeconds" value="' + escapeHtml(cfg.startDelaySeconds || 60) + '"></div></div>'
    + '<p class="text-secondary small mt-3 mb-0">Saved values override environment defaults and apply to the running scheduler immediately.</p>'
    + '</div><div class="card-footer d-flex gap-2"><button class="btn btn-primary" type="submit">Save settings</button></form>'
    + '<form method="POST" action="/admin/database/settings/reset"><button class="btn btn-outline-secondary" type="submit">Use environment defaults</button></form></div></div></div>'
    + '</div>'
    + '<div class="card mb-3"><div class="card-header"><div><h3 class="card-title">Warmer provider diagnostics</h3>'
    + '<div class="text-secondary small">Per-run response time and circuit-breaker activity. Suppression resets automatically at the next run.</div></div></div>'
    + '<div class="table-responsive"><table class="table card-table table-vcenter"><thead><tr><th>Provider</th><th class="text-end">Attempts</th><th class="text-end">OK</th><th class="text-end">Failed</th><th class="text-end">Skipped</th><th>Latency</th><th>Status</th></tr></thead>'
    + '<tbody id="warm-provider-rows">' + renderWarmProviders(warm.providerStatus) + '</tbody></table></div></div>'
    + '<div class="row row-cards mb-3"><div class="col-lg-4"><div class="card h-100"><div class="card-header"><h3 class="card-title">Fresh provider observations</h3></div>'
    + '<div class="table-responsive"><table class="table card-table table-vcenter"><thead><tr><th>Provider</th><th class="text-end">Rows</th></tr></thead><tbody id="provider-rows">' + providerRows + '</tbody></table></div></div></div>'
    + '<div class="col-lg-8"><div class="card"><div class="card-header"><h3 class="card-title">Recent searches</h3><div class="card-actions text-secondary small">Newest 25</div></div>'
    + '<div class="table-responsive"><table class="table card-table table-vcenter"><thead><tr><th>Event</th><th>Provider</th><th class="text-end">Results</th><th>Searched</th><th>State</th></tr></thead><tbody>' + searchRows + '</tbody></table></div></div></div></div>'
    + '<div class="card border-warning"><div class="card-header"><h3 class="card-title">Database maintenance</h3></div><div class="card-body">'
    + '<p class="text-secondary">Pruning removes expired rows. Wiping removes reusable search and availability knowledge only; accounts, promotions and metadata remain untouched.</p>'
    + '<form method="POST" action="/admin/database/prune" class="d-inline me-2"><button class="btn btn-outline-primary" type="submit">Prune expired rows</button></form>'
    + '<form method="POST" action="/admin/database/wipe" class="d-inline" onsubmit="return confirm(\'Wipe the Smart Availability database? Provider searches will need to run again.\');"><button class="btn btn-outline-danger" type="submit">Wipe database</button></form>'
    + '</div></div>'
    + '<script>(function(){function t(v){if(!v)return "Not yet";var d=new Date(v);return isNaN(d.getTime())?"Unknown":d.toLocaleString("en-GB");}function set(id,value){var e=document.getElementById(id);if(e)e.textContent=value;}function badge(id,value,klass){var e=document.getElementById(id);if(e){e.textContent=value;e.className="badge "+klass;}}function esc(v){var e=document.createElement("span");e.textContent=String(v==null?"":v);return e.innerHTML;}function dur(v){v=Math.max(0,Number(v)||0);return v<1000?v+" ms":(v/1000).toFixed(v<10000?1:0)+" s";}function providers(rows){var body=document.getElementById("warm-provider-rows"),entries=Object.entries(rows||{});if(!body)return;if(!entries.length){body.innerHTML="<tr><td colspan=7 class=text-secondary>No provider attempts recorded in this run yet.</td></tr>";return;}body.innerHTML=entries.map(function(entry){var n=entry[0],x=entry[1]||{},a=Number(x.attempts)||0,avg=a?(Number(x.totalDurationMs)||0)/a:0,status=x.suppressed?"<span class=&quot;badge bg-orange-lt&quot;>Suppressed</span>":x.failures&&!x.successes?"<span class=&quot;badge bg-red-lt&quot;>Failing</span>":"<span class=&quot;badge bg-green-lt&quot;>Available</span>";return "<tr><td class=fw-medium>"+esc(n)+"</td><td class=text-end>"+a+"</td><td class=&quot;text-end text-success&quot;>"+(Number(x.successes)||0)+"</td><td class=&quot;text-end text-danger&quot;>"+(Number(x.failures)||0)+"</td><td class=text-end>"+(Number(x.skipped)||0)+"</td><td>"+esc(dur(avg))+" avg · "+esc(dur(x.lastDurationMs))+" last</td><td>"+status+"<div class=&quot;text-secondary small mt-1&quot;>Last success: "+esc(t(x.lastSuccessAt))+"</div>"+(x.lastError?"<div class=&quot;text-danger small&quot;>"+esc(x.lastError)+"</div>":"")+"</td></tr>";}).join("");}async function refresh(){try{var r=await fetch("/admin/database/status.json",{credentials:"same-origin",cache:"no-store"});if(!r.ok)throw new Error("status "+r.status);var d=await r.json(),w=d.warm||{},s=d.scheduler||{},c=s.settings||{};badge("database-live","Live","bg-green-lt");badge("warm-state",w.running?"Running":c.enabled?"Scheduled":"Disabled",w.running?"bg-blue-lt":c.enabled?"bg-green-lt":"bg-secondary-lt");set("warm-current",w.currentEvent||(w.running?"Starting…":"Idle"));set("warm-profile",w.currentProfile||"");set("warm-next",c.enabled?t(s.nextRunAt):"Disabled");set("warm-last",t(w.lastCompletedAt));set("warm-counts",(w.attemptedEvents||0)+" / "+(w.eligibleEvents||0)+" events");set("warm-errors",w.errors||0);set("warm-error",w.lastError||"None");providers(w.providerStatus);var total=w.totalProfiles||0,done=w.completedProfiles||0,p=total?Math.min(100,Math.round(done/total*100)):0,e=document.getElementById("warm-progress");if(e)e.style.width=p+"%";set("warm-progress-label",done+" / "+total+" account-event checks");}catch(e){badge("database-live","Disconnected","bg-red-lt");}}setInterval(refresh,3000);})();</script>';
}

module.exports = { renderBody, formatBytes, formatTime, formatDuration };
