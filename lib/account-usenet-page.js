'use strict';

const diyUsenetStatus = require('./diy-usenet-status');

// Built-in Usenet, on a page of its own.
//
// One pipeline: a native indexer connection (Newznab, NZBHydra, or Prowlarr)
// for discovery, and a direct NNTP provider connection for playback. No
// helper container is involved — SSS talks to the indexer and the provider
// directly.

function renderBody(opts) {
  const options = opts || {};
  const cfg = options.cfg || {};
  const state = diyUsenetStatus.status(cfg);
  const escapeHtml = options.escapeHtml;
  const secretField = options.secretField;
  const flashClass = /failed|error|incomplete|invalid|required/i.test(String(options.flash || ''))
    ? 'alert-warning' : 'alert-success';
  const flash = options.flash
    ? '<div class="alert ' + flashClass + ' alert-dismissible" role="alert"><div>'
      + escapeHtml(options.flash) + '</div><a class="btn-close" data-bs-dismiss="alert"></a></div>'
    : '';
  const statusBadge = (ready) => ready
    ? '<span class="badge bg-green-lt">Ready</span>'
    : '<span class="badge bg-yellow-lt">Needs settings</span>';
  const discoveryName = cfg.diySearchName || (cfg.diySearchKind === 'prowlarr' ? 'Prowlarr' : 'Newznab');
  const engine = options.engine || {};
  const runtime = options.runtime || { active: [], recent: [], totals: {} };
  const pools = options.pools || [];
  const fmtBytes = (value) => {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GiB';
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MiB';
    return Math.round(bytes / 1024) + ' KiB';
  };
  const recentRows = runtime.recent.slice(0, 12).map((row) => '<tr>'
    + '<td>' + escapeHtml(row.filename || row.eventId || 'Unknown release') + '</td>'
    + '<td>' + escapeHtml(row.state) + '</td><td>' + (row.firstByteMs == null ? '—' : row.firstByteMs + ' ms') + '</td>'
    + '<td>' + fmtBytes(row.bytes) + '</td><td>' + escapeHtml(String(row.mbps || 0)) + ' Mbps</td>'
    + '<td>' + escapeHtml(row.error || '') + '</td></tr>').join('');
  const poolSummary = pools.length ? pools.map((pool) => escapeHtml(pool.host) + ': '
    + pool.busy + ' busy, ' + pool.idle + ' ready, ' + pool.waiting + ' waiting').join(' · ') : 'No NNTP connections opened yet.';

  return ''
    + '<style>'
    + '.provider-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.provider-grid .wide{grid-column:1/-1}'
    + '.pipeline-stage{border:1px solid var(--tblr-border-color);border-radius:13px;background:rgba(0,0,0,.12);padding:20px;margin-top:16px}'
    + '.pipeline-stage-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}'
    + '.pipeline-stage-head h3{margin:0;font-size:1.05rem}'
    + '.pipeline-kicker{color:var(--tblr-primary);font-size:.68rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;margin-bottom:3px}'
    + '.readiness-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:0 0 18px}.readiness-grid.status-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.readiness-card{min-width:0;border:1px solid var(--tblr-border-color);border-radius:12px;padding:13px;background:rgba(255,255,255,.018)}.readiness-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px}.readiness-card p{margin:0;color:var(--tblr-secondary);font-size:.78rem;overflow-wrap:anywhere}'
    + '.usenet-page{max-width:1120px;margin:0 auto 4rem}.usenet-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}.usenet-actions .btn{min-width:150px}'
    + '.pipeline-stage details summary{cursor:pointer;list-style:none;font-weight:700}.pipeline-stage details summary::-webkit-details-marker{display:none}.pipeline-stage details summary:after{content:"⌄";float:right;color:var(--tblr-secondary)}'
    + '@media(max-width:900px){.readiness-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}'
    + '@media(max-width:720px){.provider-grid,.readiness-grid,.readiness-grid.status-grid{grid-template-columns:1fr}.provider-grid .wide{grid-column:auto}.usenet-actions .btn{width:100%}}'
    + '</style>'
    + '<div class="usenet-page"><div class="page-header"><div class="row align-items-center"><div class="col">'
    + '<h2 class="page-title">Built-in Usenet</h2>'
    + '<div class="text-secondary mt-1">Connect your indexer and NNTP provider. Turn the pipeline on or off in Configure.</div>'
    + '</div></div></div>'
    + flash
    + '<div class="d-flex flex-wrap align-items-center gap-2 mb-3"><span class="badge ' + (state.enabled ? 'bg-green-lt' : 'bg-secondary-lt') + '">' + (state.enabled ? 'Enabled in Configure' : 'Off in Configure') + '</span><a class="small" href="/account?step=0">Change pipeline setting</a></div>'
    + '<div class="readiness-grid status-grid">'
    +   '<div class="readiness-card"><div class="readiness-card-head"><strong>Discovery</strong>' + statusBadge(state.discovery) + '</div><p>' + escapeHtml(state.discovery ? discoveryName : 'Add an indexer URL and API key') + '</p></div>'
    +   '<div class="readiness-card"><div class="readiness-card-head"><strong>Native NNTP</strong>' + statusBadge(state.playback) + '</div><p>' + (state.playback ? 'Provider details saved' : 'Add your NNTP provider') + '</p></div>'
    + '</div>'
    + '<form method="POST" action="/account/usenet/save">'
    +   '<section class="pipeline-stage"><div class="pipeline-stage-head"><div><div class="pipeline-kicker">Stage 1</div><h3>Search and candidate discovery</h3></div><span class="badge bg-blue-lt">Native indexer</span></div>'
    +   '<div class="provider-grid">'
    +     '<div><label class="form-label" for="diy-search-kind">Search service</label><select class="form-select" id="diy-search-kind" name="diySearchKind"><option value="newznab"' + (cfg.diySearchKind !== 'prowlarr' ? ' selected' : '') + '>Newznab / NZBHydra</option><option value="prowlarr"' + (cfg.diySearchKind === 'prowlarr' ? ' selected' : '') + '>Prowlarr</option></select></div>'
    +     '<div><label class="form-label" for="diy-search-name">Display name</label><input class="form-control" type="text" id="diy-search-name" name="diySearchName" value="' + escapeHtml(cfg.diySearchName || '') + '" placeholder="NZBHydra or NZBGeek"></div>'
    +     '<div><label class="form-label" for="diy-search-url">Search URL</label><input class="form-control text-mono" type="url" id="diy-search-url" name="diySearchUrl" value="' + escapeHtml(cfg.diySearchUrl || '') + '" placeholder="http://nzbhydra2:5076 or http://prowlarr:9696"></div>'
    +     '<div>' + secretField('Search API key', 'diySearchApiKey', cfg.diySearchApiKey, 'paste the indexer or manager API key') + '</div>'
    +     '<div><label class="form-label" for="diy-search-test-query">Test query</label><input class="form-control" type="text" id="diy-search-test-query" name="diySearchTestQuery" value="UFC" maxlength="200"></div>'
    +     '<div class="d-flex align-items-end"><button class="btn btn-outline-primary w-100" type="submit" formaction="/account/test-diy-search" formnovalidate>Test native search</button></div>'
    +   '</div></section>'
    +   '<section class="pipeline-stage"><div class="pipeline-stage-head"><div><div class="pipeline-kicker">Stage 2</div><h3>Native NNTP playback</h3></div><span class="badge bg-azure-lt">Direct provider connection</span></div>'
    +   '<div class="text-secondary small mb-2">Instant range streaming for direct files and stored RAR4/RAR5 videos — no download, upload, or WebDAV step.</div>'
    +   '<div class="provider-grid">'
    +     '<div><label class="form-label" for="nntp-host">NNTP host</label><input class="form-control text-mono" id="nntp-host" name="nntpHost" value="' + escapeHtml(cfg.nntpHost || '') + '" placeholder="news.provider.example"></div>'
    +     '<div><label class="form-label" for="nntp-port">Port</label><input class="form-control" type="number" min="1" max="65535" id="nntp-port" name="nntpPort" value="' + escapeHtml(String(cfg.nntpPort || 563)) + '"></div>'
    +     '<div><label class="form-label" for="nntp-user">Username</label><input class="form-control" id="nntp-user" name="nntpUsername" value="' + escapeHtml(cfg.nntpUsername || '') + '" autocomplete="off"></div>'
    +     '<div>' + secretField('Password', 'nntpPassword', cfg.nntpPassword, 'your NNTP password') + '</div>'
    +     '<div><label class="form-label" for="nntp-connections">Maximum connections</label><input class="form-control" type="number" min="1" max="50" id="nntp-connections" name="nntpConnections" value="' + escapeHtml(String(cfg.nntpConnections || 20)) + '"><div class="form-hint">20 recommended; sockets are pre-authenticated, pooled, and reused. Do not exceed your provider limit.</div></div>'
    +     '<div class="d-flex align-items-center"><label class="form-check form-switch mt-3"><input class="form-check-input" type="checkbox" name="nntpTls" value="on"' + (cfg.nntpTls !== false ? ' checked' : '') + '><span class="form-check-label">Use TLS (recommended)</span></label></div>'
    +   '</div><button class="btn btn-outline-primary mt-3 w-100" type="submit" formaction="/account/test-nntp" formnovalidate>Test NNTP pipeline</button></section>'
    + '<div class="usenet-actions">'
    +   '<button class="btn btn-primary" type="submit">Save connection settings</button>'
    +   '<a class="btn btn-outline-secondary" href="/account">Back to Configure</a>'
    + '</div>'
    + '</form>'
    + '<section class="pipeline-stage"><div class="pipeline-stage-head"><div><div class="pipeline-kicker">Playback address</div><h3>DIY playback on your LAN</h3></div><span class="badge bg-azure-lt">Server-wide</span></div>'
    + '<form method="POST" action="/admin/usenet/playback-origin">'
    + '<label class="form-label" for="diy-playback-origin">LAN address for SSS playback</label>'
    + '<input class="form-control text-mono" type="url" id="diy-playback-origin" name="diyPlaybackOrigin" value="' + escapeHtml(options.diyPlaybackOrigin || '') + '" placeholder="http://192.168.1.16:7000" autocomplete="off">'
    + '<div class="form-hint">Use the SSS address reachable by Nuvio on your Wi-Fi, even when its addon was installed from a Cloudflare manifest. Only Native NNTP links use this address; Easynews and torrent links keep their normal routes. Native NNTP rows are marked LAN and will not play outside your home network. Leave blank to use the manifest address.</div>'
    + '<button class="btn btn-primary mt-3" type="submit">Save playback address</button></form></section>'
    + '<section class="pipeline-stage"><details><summary>Advanced playback tuning</summary><p class="text-secondary small mt-2">Adjust only when playback logs show a specific latency or buffering problem.</p>'
    + '<form method="POST" action="/admin/usenet/engine"><div class="provider-grid">'
    + '<div><label class="form-label">Performance profile</label><select class="form-select" name="profile">'
    + ['balanced','low-latency','resilient'].map((value) => '<option value="' + value + '"' + (engine.profile === value ? ' selected' : '') + '>' + escapeHtml(value.replace('-', ' ')) + '</option>').join('') + '</select><div class="form-hint">Balanced is recommended. Save after changing profile to load its safe defaults, then adjust individual values if measured playback calls for it.</div></div>'
    + '<div><label class="form-label">Concurrent HTTP streams</label><input class="form-control" type="number" min="1" max="16" name="maxConcurrentStreams" value="' + escapeHtml(engine.maxConcurrentStreams || 4) + '"><div class="form-hint">Bounds total memory and connection pressure.</div></div>'
    + '<div><label class="form-label">Startup segments</label><input class="form-control" type="number" min="1" max="8" name="startupSegments" value="' + escapeHtml(engine.startupSegments || 1) + '"><div class="form-hint">Only this many articles are fetched before the first byte is sent.</div></div>'
    + '<div><label class="form-label">Read-ahead segments</label><input class="form-control" type="number" min="2" max="256" name="prefetchSegments" value="' + escapeHtml(engine.prefetchSegments || 24) + '"><div class="form-hint">Higher values absorb provider jitter but use more memory after playback starts.</div></div>'
    + '<div><label class="form-label">Article timeout (ms)</label><input class="form-control" type="number" min="3000" max="60000" step="1000" name="articleTimeoutMs" value="' + escapeHtml(engine.articleTimeoutMs || 15000) + '"></div>'
    + '<div><label class="form-label">Article retries</label><input class="form-control" type="number" min="0" max="5" name="articleRetries" value="' + escapeHtml(engine.articleRetries == null ? 2 : engine.articleRetries) + '"></div>'
    + '</div><div class="usenet-actions"><button class="btn btn-primary" type="submit">Save engine settings</button></div></form></details></section>'
    + '<section class="pipeline-stage"><div class="pipeline-stage-head"><div><div class="pipeline-kicker">Live diagnostics</div><h3>Recent native playback</h3></div><span class="badge bg-secondary-lt">Since restart</span></div>'
    + '<div class="readiness-grid">'
    +   '<div class="readiness-card"><div class="readiness-card-head"><strong>Active streams</strong><span class="badge bg-azure-lt">' + runtime.active.length + '</span></div><p>' + escapeHtml(poolSummary) + '</p></div>'
    +   '<div class="readiness-card"><div class="readiness-card-head"><strong>Completed</strong><span class="badge bg-green-lt">' + (runtime.totals.completed || 0) + '</span></div><p>' + fmtBytes(runtime.totals.bytes) + ' served since restart.</p></div>'
    +   '<div class="readiness-card"><div class="readiness-card-head"><strong>Retries</strong><span class="badge bg-yellow-lt">' + (runtime.totals.retries || 0) + '</span></div><p>' + (runtime.totals.failed || 0) + ' failed request(s).</p></div>'
    +   '<div class="readiness-card"><div class="readiness-card-head"><strong>Descriptor cache</strong><span class="badge bg-secondary-lt">' + (runtime.totals.cacheHits || 0) + '/' + ((runtime.totals.cacheHits || 0) + (runtime.totals.cacheMisses || 0)) + '</span></div><p>Hits avoid downloading and inspecting the NZB again.</p></div>'
    + '</div>'
    + '<div class="usenet-actions mb-3"><a class="btn btn-outline-secondary btn-sm" href="/admin/logs?category=resolve&amp;substring=nntp">Open Usenet logs</a><form method="POST" action="/admin/usenet/stats/reset"><button class="btn btn-outline-secondary btn-sm" type="submit">Reset runtime stats</button></form></div>'
    + (recentRows ? '<div class="table-responsive"><table class="table table-vcenter"><thead><tr><th>Release</th><th>Result</th><th>First byte</th><th>Served</th><th>Average</th><th>Error</th></tr></thead><tbody>' + recentRows + '</tbody></table></div>' : '<p class="text-secondary mb-0">No native NNTP playback has been attempted since this container started.</p>')
    + '</section></div>';
}

module.exports = { renderBody };
