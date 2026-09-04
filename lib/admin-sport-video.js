'use strict';

const { escapeHtml } = require('./tabler-chrome');

const CATEGORY_LABELS = Object.freeze({
  americanfootball: 'American football', basketball: 'Basketball', baseball: 'Baseball',
  football: 'Football', hockey: 'Hockey', rugby: 'Rugby / AFL / GAA', other: 'Other sport',
});

// Releases found only on a dated archive page have no sport label of their own.
// They are listed and filterable like any other row rather than hidden.
const ARCHIVE_LABEL = 'From archive';

function categoryLabel(value) {
  if (value === 'archive') return ARCHIVE_LABEL;
  return CATEGORY_LABELS[value] || value || 'Unknown';
}

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
    prepare: ['Needs preparation', 'azure'], unmatched: ['Unmatched', 'secondary'],
    filtered: ['Filtered out', 'yellow'], error: ['Prepare failed', 'red'],
  };
  const value = map[state] || [state, 'secondary'];
  return '<span class="badge bg-' + value[1] + '-lt">' + escapeHtml(value[0]) + '</span>';
}

function row(record, cached, torboxConfigured) {
  const matches = Array.isArray(record.matches) ? record.matches : [];
  const match = matches[0];
  let state = record.matchExclusion ? 'filtered' : 'unmatched';
  if (match && record.prepareError) state = 'error';
  else if (match && !record.infoHash) state = 'prepare';
  else if (match && cached) state = 'cached';
  else if (match && record.infoHash) state = 'warmable';
  const matchHtml = match
    ? '<div class="fw-medium">' + escapeHtml(match.eventTitle) + '</div><div class="text-secondary small">'
      + escapeHtml(match.promotion) + (matches.length > 1 ? ' · +' + (matches.length - 1) + ' match' : '') + '</div>'
    : (record.matchExclusion
      ? '<span class="text-secondary">Rejected before matching</span>'
        + '<div class="text-secondary small">' + escapeHtml(record.matchExclusion) + '</div>'
      : '<span class="text-secondary">No current SSS event</span>');
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
    + '<td>' + escapeHtml(categoryLabel(record.category)) + '</td>'
    + '<td>' + matchHtml + '</td><td>' + badge(state)
      + (record.prepareError ? '<div class="text-danger small mt-1">' + escapeHtml(record.prepareError) + '</div>' : '')
      + '</td><td class="text-end">' + action + '</td></tr>';
}

function renderBody(data) {
  const cfg = data.config || {};
  const status = data.status || {};
  const releases = data.releases || [];
  const cached = data.cached || new Set();
  // One picker per promotion that fields two named sides, built from the
  // catalog rather than a hardcoded roster. Selecting nothing means no filter,
  // which is how boxing and anything else without a recurring line-up keeps
  // preparing everything it matches.
  const selected = cfg.teamFilters || {};
  const teamGroups = (data.catalogTeams || []).filter((group) => group.teams.length >= 2);
  const teamFilterBlock = teamGroups.length
    ? '<div class="mt-3"><label class="form-label">Limit preparation to selected teams</label>'
      + '<div class="form-hint mb-2">Applies to the expensive half only \u2014 fetching torrent details and warming to TorBox. Everything still matches and stays listed below, and the Prepare and Warm buttons ignore this. A promotion with nothing selected is not filtered.</div>'
      + '<div class="row g-2">'
      + teamGroups.map(function group(entry) {
        const chosen = selected[entry.promotion] || [];
        return '<div class="col-md-4"><label class="form-label small mb-1">'
          + escapeHtml(entry.promotionName)
          + (chosen.length ? ' <span class="badge bg-orange-lt">' + chosen.length + ' selected</span>'
            : ' <span class="text-secondary">all fixtures</span>')
          + '</label><select class="form-select" name="teamFilter:' + escapeHtml(entry.promotion)
          + '" multiple size="7">'
          + entry.teams.map(function option(team) {
            return '<option value="' + escapeHtml(team.name) + '"'
              + (chosen.includes(team.name) ? ' selected' : '') + '>'
              + escapeHtml(team.name) + ' (' + team.fixtures + ')</option>';
          }).join('')
          + '</select></div>';
      }).join('')
      + '</div><div class="form-hint mt-2">Ctrl-click or Cmd-click to select several. The number after each name is how many fixtures it appears in over the last 120 days.</div></div>'
    : '';
  const warmChecks = (data.promotions || []).map((promotion) =>
    '<label class="form-check form-check-inline"><input class="form-check-input" type="checkbox" name="autoWarmPromotions" value="'
      + escapeHtml(promotion.id) + '"' + ((cfg.autoWarmPromotions || []).includes(promotion.id) ? ' checked' : '')
      + '><span class="form-check-label">' + escapeHtml(promotion.name) + '</span></label>').join('')
    || '<span class="text-secondary small">No promotions are enabled yet.</span>';
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
    + statCard('Discovered', status.releases || 0, (status.fromArchive || 0) + ' from the dated archive', 'azure')
    + statCard('Matched', status.matched || 0, 'Connected to current SSS events', 'blue')
    + statCard('Prepared', status.preparedMatched === undefined ? (status.prepared || 0) : status.preparedMatched,
      (status.preparedOrphans
        ? status.preparedOrphans + ' more prepared but no longer matched'
        : 'Validated torrent identities'), 'purple')
    + statCard('Ready on TorBox', cached.size || 0, data.torboxConfigured ? 'Checked with this admin account' : 'TorBox key not configured', 'green')
    + '</div>'
    + '<div class="row row-cards mt-1"><div class="col-lg-7"><div class="card"><div class="card-header">'
    + '<div><h3 class="card-title">Source controls</h3><div class="text-secondary small">Fixed to sport-video.org.ua; external URLs and redirects are rejected.</div></div></div>'
    + '<form method="POST" action="/admin/sport-video/settings"><div class="card-body">'
    // Everything under the master switch is subordinate to it, and used to be
    // drawn identically — so "Scan automatically" read as active while
    // Sport-Video itself was off. The dependent block is dimmed and labelled
    // instead of disabled: a disabled input submits nothing, so disabling these
    // would silently clear them the next time the form was saved.
    + '<style>'
    +   '.sv-dependent{transition:opacity .15s ease}'
    +   '.sv-dependent.is-inactive{opacity:.45}'
    +   '.sv-dependent-note{display:none;margin:10px 0 0;font-size:.8rem}'
    +   '.sv-dependent.is-inactive .sv-dependent-note{display:block}'
    + '</style>'
    + '<label class="form-check form-switch"><input class="form-check-input" type="checkbox" id="sv-enabled" name="enabled" value="on"'
      + (cfg.enabled ? ' checked' : '') + '><span class="form-check-label"><strong>Enable Sport-Video results</strong></span><span class="form-check-description">Adds matched releases to event TorBox results alongside existing pipelines.</span></label>'
    + '<div class="sv-dependent' + (cfg.enabled ? '' : ' is-inactive') + '" id="sv-dependent">'
    + '<div class="alert alert-warning sv-dependent-note" role="status">These settings are saved, but nothing below runs while Sport-Video results are off.</div>'
    + '<label class="form-check form-switch mt-3"><input class="form-check-input" type="checkbox" name="autoScan" value="on"'
      + (cfg.autoScan ? ' checked' : '') + '><span class="form-check-label"><strong>Scan automatically</strong></span><span class="form-check-description">Checks category indexes periodically without automatically adding torrents to TorBox.</span></label>'
    + '<div class="mt-3"><label class="form-label">Included sports</label><div>' + checkboxes + '</div></div>'
    + '<div class="row mt-3"><div class="col-sm-4"><label class="form-label">Every (hours)</label><input class="form-control" type="number" min="1" max="168" step="1" name="intervalHours" value="'
      + escapeHtml(cfg.intervalHours || 6) + '"></div><div class="col-sm-4"><label class="form-label">Startup delay (seconds)</label><input class="form-control" type="number" min="10" max="3600" name="startDelaySeconds" value="'
      + escapeHtml(cfg.startDelaySeconds || 90) + '"></div><div class="col-sm-4"><label class="form-label">Prepare per scan</label><input class="form-control" type="number" min="1" max="200" name="maxDetailsPerScan" value="'
      + escapeHtml(cfg.maxDetailsPerScan || 50) + '"></div></div>'
    + '<div class="mt-3"><label class="form-label">Automatically warm to TorBox</label>'
      + '<div class="form-hint mb-2">Off by default. A selected promotion has its matched, prepared releases submitted to TorBox during a scan, for accounts that hold a TorBox key and have that promotion\'s catalog switched on. Everything else stays a manual click.</div>'
      + '<div>' + warmChecks + '</div></div>'
    + '<div class="row mt-3"><div class="col-sm-6"><label class="form-label">Archive pages per scan</label>'
      + '<input class="form-control" type="number" min="0" max="60" name="archivePages" value="'
      + escapeHtml(cfg.archivePages === undefined ? 12 : cfg.archivePages) + '">'
      + '<div class="form-hint">Fallback only: used when the site search index cannot be read. About 60 releases per page, newest first. Set 0 to read the sport pages only.</div></div>'
      + '<div class="col-sm-6"><label class="form-label">Auto-warm releases per scan</label>'
      + '<input class="form-control" type="number" min="1" max="50" name="autoWarmPerScan" value="'
      + escapeHtml(cfg.autoWarmPerScan === undefined ? 5 : cfg.autoWarmPerScan) + '">'
      + '<div class="form-hint">Caps TorBox submissions from a single scan.</div></div></div>'
    + teamFilterBlock
    + '<div class="row mt-3"><div class="col-sm-6"><label class="form-label">Automatic window (days)</label>'
      + '<input class="form-control" type="number" min="1" max="90" name="autoWarmWindowDays" value="'
      + escapeHtml(cfg.autoWarmWindowDays === undefined ? 14 : cfg.autoWarmWindowDays) + '">'
      + '<div class="form-hint">Automatic preparation and warming stop for fixtures older than this. TorBox keeps a cached copy for at least 30 days, so an older fixture is either still cached and needs nothing, or has aged out. The Prepare and Warm buttons ignore this limit.</div></div></div></div>'
    + '</div>'
    + '<script>(function(){var master=document.getElementById("sv-enabled"),block=document.getElementById("sv-dependent");'
    + 'if(!master||!block)return;function sync(){block.classList.toggle("is-inactive",!master.checked);}'
    + 'master.addEventListener("change",sync);sync();})();</script>'
    + '<div class="card-footer d-flex gap-2"><button class="btn btn-primary" type="submit">Save settings</button></form>'
    + '<form method="POST" action="/admin/sport-video/scan"><button class="btn btn-outline-primary" type="submit"'
      + (status.running ? ' disabled' : '') + '>' + (status.running ? 'Scan running…' : 'Scan now') + '</button></form>'
    + '<form method="POST" action="/admin/sport-video/rematch"><button class="btn btn-outline-secondary" type="submit"'
      + (status.running ? ' disabled' : '') + ' title="Re-check stored releases against the current event catalog without fetching anything">Re-match events</button></form></div></div></div>'
    + '<div class="col-lg-5"><div class="card"><div class="card-header"><h3 class="card-title">Latest scan</h3></div><div class="card-body">'
    + '<div class="datagrid"><div class="datagrid-item"><div class="datagrid-title">Last completed</div><div class="datagrid-content">' + escapeHtml(formatTime(status.completedAt)) + '</div></div>'
    + '<div class="datagrid-item"><div class="datagrid-title">Current work</div><div class="datagrid-content">' + escapeHtml(status.current || 'Idle') + '</div></div>'
    + '<div class="datagrid-item"><div class="datagrid-title">Unmatched</div><div class="datagrid-content">' + escapeHtml(status.unmatched || 0) + '</div></div>'
    + '<div class="datagrid-item"><div class="datagrid-title">Discovery source</div><div class="datagrid-content">' + escapeHtml(status.discoverySource || 'Not yet run') + '</div></div>'
    + '<div class="datagrid-item"><div class="datagrid-title">Search index entries</div><div class="datagrid-content">' + escapeHtml(status.searchIndexEntries || 0) + '</div></div>'
    + '<div class="datagrid-item"><div class="datagrid-title">Archive pages read</div><div class="datagrid-content">' + escapeHtml(status.archivePagesRead || 0) + '</div></div>'
    + '<div class="datagrid-item"><div class="datagrid-title">Filtered out</div><div class="datagrid-content">' + escapeHtml(status.filtered || 0) + '</div></div>'
    + '<div class="datagrid-item"><div class="datagrid-title">Matched, outside window</div><div class="datagrid-content">' + escapeHtml(status.outsideWindow || 0) + '</div></div>'
    + '<div class="datagrid-item"><div class="datagrid-title">Skipped, team filter</div><div class="datagrid-content">' + escapeHtml(status.outsideTeamFilter || 0) + '</div></div>'
    + '<div class="datagrid-item"><div class="datagrid-title">Last re-match</div><div class="datagrid-content">' + escapeHtml(formatTime(status.lastRematchAt)) + '</div></div>'
    + '<div class="datagrid-item"><div class="datagrid-title">Last error</div><div class="datagrid-content ' + (status.lastError ? 'text-danger' : 'text-success') + '">' + escapeHtml(status.lastError || 'None') + '</div></div></div>'
    + '<div class="alert alert-warning mt-3 mb-0"><strong>Operator-controlled source.</strong> Availability and rights vary by release and jurisdiction. SSS does not bulk-submit or automatically warm this catalogue.</div>'
    + '</div></div></div></div>'
    + '<div class="card mt-3"><div class="card-header"><div><h3 class="card-title">Match diagnostics</h3>'
      + '<div class="text-secondary small">Every event in the window, its aliases and generated queries, each nearby release, and the exact reason any of them were rejected.</div></div></div>'
    + '<form method="GET" action="/admin/sport-video/diagnostics.csv" id="sv-diag"><div class="card-body"><div class="row g-2 align-items-end">'
    + '<div class="col-md-4"><label class="form-label">Promotion</label><select class="form-select" name="promotion">'
      + '<option value="">All promotions</option>'
      + (data.promotions || []).map(function promotionOption(promotion) {
        return '<option value="' + escapeHtml(promotion.id) + '">' + escapeHtml(promotion.name) + '</option>';
      }).join('') + '</select></div>'
    + '<div class="col-md-3"><label class="form-label">Days either side of today</label>'
      + '<input class="form-control" type="number" min="1" max="3650" name="days" value="60"></div>'
    + '<div class="col-md-5"><button class="btn btn-primary" type="submit">Download CSV</button> '
      + '<button class="btn btn-outline-primary" type="submit" formaction="/admin/sport-video/diagnostics.json">Download JSON</button>'
      + '<div class="form-hint mt-1">CSV is one row per event and candidate release. JSON keeps the full alias and query lists. Neither contains torrent URLs.</div></div>'
    + '</div></div></form></div>'
    + '<div class="card mt-3"><div class="card-header"><div><h3 class="card-title">Discovered releases</h3><div class="text-secondary small">Newest 200 retained rows · exact event matching before TorBox checks</div></div></div>'
    + '<div class="card-body border-bottom"><div class="row g-2"><div class="col-md-5"><input id="sv-search" class="form-control" type="search" placeholder="Filter by release, event or promotion"></div>'
    + '<div class="col-md-3"><select id="sv-state" class="form-select"><option value="">All states</option><option value="cached">Ready</option><option value="warmable">Warmable</option><option value="prepare">Needs preparation</option><option value="unmatched">Unmatched</option><option value="filtered">Filtered out</option><option value="error">Errors</option></select></div>'
    + '<div class="col-md-2"><select id="sv-category" class="form-select"><option value="">All sports</option>'
    + Object.entries(CATEGORY_LABELS).concat([['archive', ARCHIVE_LABEL]]).map(function categoryOption(entry) { return '<option value="' + escapeHtml(entry[0]) + '">' + escapeHtml(entry[1]) + '</option>'; }).join('') + '</select></div>'
    + '<div class="col-md-2"><span id="sv-count" class="form-control text-secondary">' + releases.length + ' shown</span></div></div></div>'
    + '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th>Date</th><th>Source release</th><th>Sport</th><th>Matched SSS event</th><th>State</th><th></th></tr></thead><tbody id="sv-rows">'
    + (rows || '<tr><td colspan="6" class="text-secondary py-5 text-center">No discoveries yet. Enable the source and run the first scan.</td></tr>')
    + '</tbody></table></div></div>'
    + '<script>(function(){var q=document.getElementById("sv-search"),s=document.getElementById("sv-state"),g=document.getElementById("sv-category"),c=document.getElementById("sv-count");function f(){var text=(q.value||"").toLowerCase(),state=s.value,category=g.value,n=0;document.querySelectorAll("#sv-rows tr[data-search]").forEach(function(r){var show=(!text||r.dataset.search.indexOf(text)>=0)&&(!state||r.dataset.state===state)&&(!category||r.dataset.category===category);r.hidden=!show;if(show)n++;});c.textContent=n+" shown";}q.addEventListener("input",f);s.addEventListener("change",f);g.addEventListener("change",f);}());</script>';
}

module.exports = { renderBody, CATEGORY_LABELS };
