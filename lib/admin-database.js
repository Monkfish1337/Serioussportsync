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
  return Number.isFinite(date.getTime()) ? date.toLocaleString('en-GB',{timeZone:require('./settings').getDisplayTimeZone()}) : 'Unknown';
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatDuration(value) {
  const milliseconds = Math.max(0, Number(value) || 0);
  if (milliseconds < 1000) return milliseconds + ' ms';
  return (milliseconds / 1000).toFixed(milliseconds < 10000 ? 1 : 0) + ' s';
}

function providerLabel(value) {
  return ({
    torrent: 'Torrent / TorBox',
    'native-indexer': 'Native Usenet search',
    easynews: 'Easynews',
  })[value] || value;
}

function renderWarmProviders(providerStatus) {
  const entries = Object.entries(providerStatus || {});
  if (!entries.length) {
    return '<tr><td colspan="7">No provider attempts in this run yet.</td></tr>';
  }
  return entries.map(([provider, row]) => {
    const attempts = Number(row.attempts) || 0;
    const average = attempts ? (Number(row.totalDurationMs) || 0) / attempts : 0;
    const state = row.suppressed
      ? '<span class="chip" data-tone="warn">Suppressed</span>'
      : row.failures && !row.successes
        ? '<span class="chip" data-tone="bad">Failing</span>'
        : '<span class="chip" data-tone="ok">Available</span>';
    return '<tr><td><b>' + escapeHtml(providerLabel(provider)) + '</b></td>'
      + '<td class="tabular">' + attempts + '</td>'
      + '<td class="tabular">' + (Number(row.successes) || 0) + '</td>'
      + '<td class="tabular">' + (Number(row.failures) || 0) + '</td>'
      + '<td class="tabular">' + (Number(row.skipped) || 0) + '</td>'
      + '<td class="tabular">' + escapeHtml(formatDuration(average)) + ' avg · '
      + escapeHtml(formatDuration(row.lastDurationMs)) + ' last</td>'
      + '<td>' + state + '<span class="row-sub">Last success: '
      + escapeHtml(formatTime(row.lastSuccessAt)) + '</span>'
      + (row.lastError ? '<span class="row-sub">' + escapeHtml(row.lastError) + '</span>' : '')
      + '</td></tr>';
  }).join('');
}

function table(head, body, scroll) {
  return '<div class="tbl-wrap' + (scroll ? ' tbl-scroll' : '') + '"><table class="tbl"><thead><tr>'
    + head.map((h) => '<th>' + h + '</th>').join('') + '</tr></thead>' + body + '</table></div>';
}

function fold(title, sub, body, open) {
  return '<details class="fold"' + (open ? ' open' : '') + '><summary><div><h3>' + escapeHtml(title) + '</h3>'
    + (sub ? '<p>' + escapeHtml(sub) + '</p>' : '') + '</div></summary><div class="fold-body">' + body + '</div></details>';
}

// The catalog availability gate, shown with the coverage it would produce.
// Flipping this changes what every client sees, so the numbers come first.
function renderCatalogGate(gate, coverage) {
  const state = gate || {};
  const cover = coverage || {};
  const total = Number(cover.total) || 0;
  const covered = Number(cover.covered) || 0;
  const percent = total ? Math.round((covered / total) * 100) : 0;
  const rows = (Array.isArray(cover.promotions) ? cover.promotions : []).map((row) => {
    const rowTotal = Number(row.total) || 0;
    const rowCovered = Number(row.covered) || 0;
    const shown = rowCovered + (state.keepUpcoming ? (Number(row.upcoming) || 0) : 0);
    const share = rowTotal ? Math.round((rowCovered / rowTotal) * 100) : 0;
    return '<tr><td>' + escapeHtml(row.promotion || 'unassigned') + '</td>'
      + '<td class="tabular">' + rowTotal + '</td>'
      + '<td class="tabular">' + rowCovered + '</td>'
      + '<td class="tabular">' + (Number(row.upcoming) || 0) + '</td>'
      + '<td><span class="chip" data-tone="' + (share >= 50 ? 'ok' : share > 0 ? 'warn' : 'bad') + '">' + shown + ' shown</span></td></tr>';
  }).join('') || '<tr><td colspan="5">No events stored yet.</td></tr>';

  const unavailable = cover.available === null || cover.available === undefined;
  const warning = unavailable
    ? '<div class="note" data-tone="warn"><div><b>Availability data could not be read</b><span>The gate would fail open and hide nothing.</span></div></div>'
    : '';

  // Folded: it is set once, but its summary carries the state and the share
  // of events it would show, so nothing is hidden while closed.
  return '<details class="fold"' + (state.enabled ? ' open' : '') + '><summary><div><h3>Catalog availability gate</h3>'
    + '<p>' + (state.enabled ? 'On' : 'Off') + ' · catalogs would list ' + covered + ' of ' + total + ' events (' + percent + '%) with something found</p></div>'
    + '<span class="chip" data-tone="' + (state.enabled ? 'ok' : 'off') + '">' + (state.enabled ? 'On' : 'Off') + '</span></summary>'
    + '<div class="fold-body bm-form">' + warning
    + '<form method="POST" action="/admin/database/catalog-gate" class="bm-form">'
    + '<label class="sw"><input type="checkbox" name="enabled" value="on"' + (state.enabled ? ' checked' : '') + '><i></i><b>Only show events with known content<small>Curated events are always shown.</small></b></label>'
    + '<label class="sw"><input type="checkbox" name="keepUpcoming" value="on"' + (state.keepUpcoming ? ' checked' : '') + '><i></i><b>Keep future fixtures visible</b></label>'
    + '<div><button class="btn primary" type="submit">Save gate</button></div>'
    + '</form>'
    + table(['Promotion', 'Events', 'With content', 'Future, none found', 'Gate result'], '<tbody>' + rows + '</tbody>', true)
    + '</div></details>';
}

const STYLE = '<style>'
  + '.bm-stack>*+*{margin-top:14px}.bm-stack .panel,.bm-stack .fold{margin:0}'
  + '.bm-stack .panel-head>div:first-child,.bm-stack .fold>summary>div{flex:1;min-width:0}'
  + '.bm-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}'
  + '.bm-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px 20px;font-size:13px}'
  + '.bm-facts span{display:block;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);margin-bottom:2px}'
  + '.bm-form>*+*{margin-top:14px}.bm-actions{display:flex;gap:8px;flex-wrap:wrap}.bm-actions form{margin:0}'
  + '.bm-funnel{display:flex;gap:4px;align-items:center;flex-wrap:wrap}'
  + '.panel>.tbl-wrap .tbl th:first-child,.panel>.tbl-wrap .tbl td:first-child{padding-left:18px}'
  + '</style>';

function renderBody(input) {
  const data = input || {};
  if (data.maintenance) return STYLE + '<div class="lede"><h2>Database</h2><p>Search and availability memory. Discovery controls are in <a href="/admin/discovery?tab=preparation">Discovery → Bitmagnet</a>.</p></div>' + (data.flash ? '<div class="note" data-tone="info"><div><b>' + escapeHtml(data.flash) + '</b></div></div>' : '') + '<div class="bm-stack">' + renderMaintenance() + '</div>';
  const stats = data.stats || {};
  const warm = data.warm || {};
  const scheduler = data.scheduler || {};
  const cfg = scheduler.settings || {};
  const searches = Array.isArray(data.searches) ? data.searches : [];
  const providerRows = Object.entries(stats.byProvider || {}).map(([provider, count]) =>
    '<tr><td>' + escapeHtml(provider) + '</td><td class="tabular">' + Number(count || 0) + '</td></tr>'
  ).join('') || '<tr><td colspan="2">No fresh observations yet.</td></tr>';
  const searchRows = searches.map((row) => {
    const fresh = Number(row.expiresAt) > Date.now();
    const hasOutcome = row.matchedCount !== null && row.matchedCount !== undefined;
    const explanation = !hasOutcome ? 'Outcome not recorded yet.'
      : Number(row.readyCount) > 0 ? 'Ready links found for this account.'
      : Number(row.matchedCount) > 0 ? 'Matched, but nothing ready. Check credentials, cache and Logs.'
      : Number(row.resultCount) > 0 ? 'Found releases, none for this event. Check matching rules and aliases.'
      : 'Nothing found. Check queries and provider errors in Logs.';
    const funnel = '<div class="bm-funnel">'
      + '<span class="chip plain" data-tone="off">' + Number(row.resultCount || 0) + ' discovered</span>'
      + (hasOutcome
        ? '›<span class="chip plain" data-tone="info">' + Number(row.matchedCount || 0) + ' matched</span>'
          + '›<span class="chip plain" data-tone="ok">' + Number(row.readyCount || 0) + ' ready</span>'
        : '<span class="chip plain" data-tone="off">outcome pending</span>')
      + '</div><span class="row-sub">' + escapeHtml(explanation) + '</span>';
    return '<tr><td>' + escapeHtml(row.eventTitle || row.eventId)
      + (row.eventTitle ? '<span class="row-sub mono">' + escapeHtml(row.eventId) + '</span>' : '')
      + '</td><td>' + escapeHtml(row.provider) + '</td>'
      + '<td>' + funnel + '</td>'
      + '<td>' + escapeHtml(formatTime(row.searchedAt)) + '</td>'
      + '<td><span class="chip" data-tone="' + (fresh ? 'ok' : 'off') + '">' + (fresh ? 'fresh' : 'expired') + '</span></td></tr>';
  }).join('') || '<tr><td colspan="5">No searches recorded yet.</td></tr>';
  const progress = warm.totalProfiles
    ? Math.min(100, Math.round((Number(warm.completedProfiles) || 0) / warm.totalProfiles * 100)) : 0;
  const flash = data.flash ? '<div class="note" data-tone="info"><div><b>' + escapeHtml(data.flash) + '</b></div></div>' : '';
  const warmTone = warm.running ? 'info' : cfg.enabled ? 'ok' : 'off';

  const head = data.discovery ? '' : '<div class="lede"><h2>Database</h2><p>Search and availability memory, so links appear faster.</p></div>';
  const overview = '<section class="panel"><div class="panel-head"><div><h3>Search memory</h3><p>Past searches and availability, reused so links appear faster.</p></div>'
    + '<span id="database-live" class="chip" data-tone="ok">Live</span></div><div class="panel-body"><div class="bm-stats">'
    + [['Known releases', stats.releases || 0, (stats.eventMatches || 0) + ' event matches'],
      ['Fresh searches', stats.freshSearches || 0, (stats.freshObservations || 0) + ' observations'],
      ['Search reuse', Math.round((stats.hitRate || 0) * 100) + '%', (stats.searchHits || 0) + ' hits · ' + (stats.searchMisses || 0) + ' misses'],
      ['Database', formatBytes(data.fileSize), 'Schema v' + (stats.schemaVersion || '?') + ' · ' + path.basename(stats.file || 'availability.sqlite')]]
      .map(([label, value, detail]) => '<div class="stat"><b>' + escapeHtml(value) + '</b><span>' + escapeHtml(label) + '</span><em>' + escapeHtml(detail) + '</em></div>').join('')
    + '</div></div></section>';

  const preparation = '<section class="panel"><div class="panel-head"><div><h3>Bitmagnet preparation</h3><p>Searches recent events in advance and checks what TorBox can play now.</p></div>'
    + '<span id="warm-state" class="chip" data-tone="' + warmTone + '">' + (warm.running ? 'Running' : cfg.enabled ? 'Scheduled' : 'Disabled') + '</span></div>'
    + '<div class="panel-body"><div class="bm-facts">'
    + '<div><span>Now</span><div id="warm-current">' + escapeHtml(warm.currentEvent || (warm.running ? 'Starting…' : 'Idle')) + '</div><div id="warm-profile" class="row-sub">' + escapeHtml(warm.currentProfile || '') + '</div></div>'
    + '<div><span>Next run</span><div id="warm-next">' + escapeHtml(cfg.enabled ? formatTime(scheduler.nextRunAt) : 'Disabled') + '</div></div>'
    + '<div><span>Last completed</span><div id="warm-last">' + escapeHtml(formatTime(warm.lastCompletedAt)) + '</div></div>'
    + '<div><span>Last run</span><div id="warm-counts">' + (warm.attemptedEvents || 0) + ' / ' + (warm.eligibleEvents || 0) + ' events</div></div>'
    + '<div><span>Errors</span><div id="warm-errors">' + (warm.errors || 0) + '</div><div id="warm-error" class="row-sub">' + escapeHtml(warm.lastError || 'None') + '</div></div>'
    + '<div><span>Cleanup</span><div>' + Number(warm.prunedRows || 0) + ' old rows removed</div></div>'
    + '</div><div><div class="meter"><i id="warm-progress" style="width:' + progress + '%"></i></div>'
    + '<div id="warm-progress-label" class="hint">' + (warm.completedProfiles || 0) + ' / ' + (warm.totalProfiles || 0) + ' event preparations</div></div></div>'
    + '<div class="panel-foot"><form method="POST" action="/admin/database/warm"><button class="btn primary" type="submit">Prepare recent events now</button></form></div></section>';

  const settingsForm = '<form method="POST" action="/admin/database/settings" class="bm-form">'
    + '<label class="sw"><input type="checkbox" name="enabled" value="on"' + (cfg.enabled ? ' checked' : '') + '><i></i><b>Prepare recent events automatically<small>Only events in each user\'s selected catalogs.</small></b></label>'
    + '<label class="sw"><input type="checkbox" name="prepareTorrent" value="on"' + (cfg.prepareTorrent !== false ? ' checked' : '') + '><i></i><b>Bitmagnet and TorBox<small>Finds releases and checks which play now.</small></b></label>'
    + '<label class="sw"><input type="checkbox" name="serveConfirmed" value="on"' + (cfg.serveConfirmed !== false ? ' checked' : '') + '><i></i><b>Use previously confirmed playable results first<small>Checked again when playback starts.</small></b></label>'
    + '<div class="grid-2">'
    + '<label class="f"><span>Recent event window (days)</span><input class="t" type="number" min="1" max="90" name="windowDays" value="' + escapeHtml(cfg.windowDays || 3) + '"></label>'
    + '<label class="f"><span>Interval (hours)</span><input class="t" type="number" min="0.25" max="168" step="0.25" name="intervalHours" value="' + escapeHtml(cfg.intervalHours || 6) + '"></label>'
    + '<label class="f"><span>Events per run</span><input class="t" type="number" min="1" max="500" name="maxEventsPerRun" value="' + escapeHtml(cfg.maxEventsPerRun || 25) + '"></label>'
    + '<label class="f"><span>Startup delay (seconds)</span><input class="t" type="number" min="5" max="3600" name="startDelaySeconds" value="' + escapeHtml(cfg.startDelaySeconds || 60) + '"></label></div>'
    + '<p class="hint">On-demand searches are remembered even when this is off.</p>'
    + '<div class="bm-actions"><button class="btn primary" type="submit">Save settings</button></form>'
    + '<form method="POST" action="/admin/database/settings/reset"><button class="btn ghost" type="submit">Use environment defaults</button></form></div>';
  const settings = fold('Bitmagnet preparation settings', (cfg.enabled ? 'On' : 'Off') + ' · every ' + (cfg.intervalHours || 6) + ' h · last ' + (cfg.windowDays || 3) + ' days · ' + (cfg.maxEventsPerRun || 25) + ' events per run', settingsForm);

  const recent = '<section class="panel"><div class="panel-head"><div><h3>Recent searches</h3><p>Newest 25. Found, then matched to the event, then checked for ready links.</p></div></div>'
    + table(['Event', 'Provider', 'Discovery funnel', 'Searched', 'State'], '<tbody>' + searchRows + '</tbody>', true) + '</section>';
  const diagnostics = fold('Preparation diagnostics', 'What the latest run contacted. Repeated failures pause until the next run.',
    table(['Provider', 'Attempts', 'OK', 'Failed', 'Skipped', 'Latency', 'Status'], '<tbody id="warm-provider-rows">' + renderWarmProviders(warm.providerStatus) + '</tbody>'));
  const observations = fold('Fresh provider observations', Object.keys(stats.byProvider || {}).length + ' providers',
    table(['Provider', 'Rows'], '<tbody id="provider-rows">' + providerRows + '</tbody>'));

  return STYLE + head + flash + '<div class="bm-stack">' + overview + preparation + recent + settings + diagnostics + observations
    + renderCatalogGate(data.catalogGate, data.coverage)
    + (data.discovery ? '' : renderMaintenance()) + '</div>'
    + '<script>(function(){function t(v){if(!v)return "Not yet";var d=new Date(v);return isNaN(d.getTime())?"Unknown":d.toLocaleString("en-GB",{timeZone:document.documentElement.dataset.timeZone});}function set(id,value){var e=document.getElementById(id);if(e)e.textContent=value;}function chip(id,value,tone){var e=document.getElementById(id);if(e){e.textContent=value;e.setAttribute("data-tone",tone);}}function esc(v){var e=document.createElement("span");e.textContent=String(v==null?"":v);return e.innerHTML;}function dur(v){v=Math.max(0,Number(v)||0);return v<1000?v+" ms":(v/1000).toFixed(v<10000?1:0)+" s";}function label(n){return({torrent:"Torrent / TorBox","native-indexer":"Native Usenet search",easynews:"Easynews"})[n]||n;}function providers(rows){var body=document.getElementById("warm-provider-rows"),entries=Object.entries(rows||{});if(!body)return;if(!entries.length){body.innerHTML="<tr><td colspan=7>No provider attempts in this run yet.</td></tr>";return;}body.innerHTML=entries.map(function(entry){var n=entry[0],x=entry[1]||{},a=Number(x.attempts)||0,avg=a?(Number(x.totalDurationMs)||0)/a:0,status=x.suppressed?"<span class=chip data-tone=warn>Suppressed</span>":x.failures&&!x.successes?"<span class=chip data-tone=bad>Failing</span>":"<span class=chip data-tone=ok>Available</span>";return "<tr><td><b>"+esc(label(n))+"</b></td><td class=tabular>"+a+"</td><td class=tabular>"+(Number(x.successes)||0)+"</td><td class=tabular>"+(Number(x.failures)||0)+"</td><td class=tabular>"+(Number(x.skipped)||0)+"</td><td class=tabular>"+esc(dur(avg))+" avg · "+esc(dur(x.lastDurationMs))+" last</td><td>"+status+"<span class=row-sub>Last success: "+esc(t(x.lastSuccessAt))+"</span>"+(x.lastError?"<span class=row-sub>"+esc(x.lastError)+"</span>":"")+"</td></tr>";}).join("");}async function refresh(){try{var r=await fetch("/admin/database/status.json",{credentials:"same-origin",cache:"no-store"});if(!r.ok)throw new Error("status "+r.status);var d=await r.json(),w=d.warm||{},s=d.scheduler||{},c=s.settings||{};chip("database-live","Live","ok");chip("warm-state",w.running?"Running":c.enabled?"Scheduled":"Disabled",w.running?"info":c.enabled?"ok":"off");set("warm-current",w.currentEvent||(w.running?"Starting…":"Idle"));set("warm-profile",w.currentProfile||"");set("warm-next",c.enabled?t(s.nextRunAt):"Disabled");set("warm-last",t(w.lastCompletedAt));set("warm-counts",(w.attemptedEvents||0)+" / "+(w.eligibleEvents||0)+" events");set("warm-errors",w.errors||0);set("warm-error",w.lastError||"None");providers(w.providerStatus);var total=w.totalProfiles||0,done=w.completedProfiles||0,p=total?Math.min(100,Math.round(done/total*100)):0,e=document.getElementById("warm-progress");if(e)e.style.width=p+"%";set("warm-progress-label",done+" / "+total+" event preparations");}catch(e){chip("database-live","Disconnected","bad");}}setInterval(refresh,3000);})();</script>';
}

module.exports = { renderBody, renderCatalogGate, formatBytes, formatTime, formatDuration };

function renderMaintenance() { return '<section class="panel"><div class="panel-head"><div><h3>Database maintenance</h3><p>Old rows are pruned before each preparation run. Wiping clears search and availability memory only; accounts, promotions and metadata stay.</p></div></div>'
    + '<div class="panel-foot"><form method="POST" action="/admin/database/prune"><button class="btn ghost" type="submit">Prune expired rows</button></form>'
    + '<form method="POST" action="/admin/database/wipe" onsubmit="return confirm(\'Wipe the Smart Availability database? Provider searches will need to run again.\');"><button class="btn danger" type="submit">Wipe database</button></form>'
    + '</div></section>'; }
