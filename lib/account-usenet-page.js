'use strict';

// The DIY Usenet pipeline, on a page of its own.
//
// It used to be a fold on the Configure page, and it was by far the largest
// thing there: two discovery backends, two playback backends, roughly thirty
// inputs and four test buttons. Everything else on Configure is a handful of
// switches, so the fold buried the page's actual job under a subsystem most
// accounts never turn on.
//
// Configure now carries a single "enable" switch for it and a link here. The
// settings themselves are per-account, so this saves through its own route
// rather than the account form — a partial POST to /account/save would have
// blanked every field the page did not render.

function renderBody(opts) {
  const options = opts || {};
  const cfg = options.cfg || {};
  const escapeHtml = options.escapeHtml;
  const secretField = options.secretField;
  const flash = options.flash
    ? '<div class="alert alert-success alert-dismissible" role="alert"><div>'
      + escapeHtml(options.flash) + '</div><a class="btn-close" data-bs-dismiss="alert"></a></div>'
    : '';

  return ''
    + '<style>'
    + '.provider-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.provider-grid .wide{grid-column:1/-1}'
    + '.pipeline-map{display:grid;grid-template-columns:1fr auto 1fr auto 1fr;align-items:center;gap:10px;margin-bottom:18px}'
    + '.pipeline-node{min-height:78px;border:1px solid var(--tblr-border-color);border-radius:12px;padding:12px;background:rgba(255,255,255,.025)}'
    + '.pipeline-node strong{display:block;margin-bottom:3px}'
    + '.pipeline-arrow{color:var(--tblr-primary);font-size:1.35rem;font-weight:800}'
    + '.pipeline-stage{border:1px solid var(--tblr-border-color);border-radius:13px;background:rgba(0,0,0,.12);padding:16px;margin-top:14px}'
    + '.pipeline-stage-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}'
    + '.pipeline-stage-head h3{margin:0;font-size:1.05rem}'
    + '.pipeline-kicker{color:var(--tblr-primary);font-size:.68rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;margin-bottom:3px}'
    + '.pipeline-backends{display:grid;grid-template-columns:1fr 1fr;gap:14px}'
    + '.pipeline-backend{border:1px solid var(--tblr-border-color);border-radius:12px;padding:15px;background:rgba(255,255,255,.018)}'
    + '.pipeline-backend .provider-grid{grid-template-columns:1fr}'
    + '.pipeline-output{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}'
    + '@media(max-width:720px){.provider-grid,.pipeline-backends{grid-template-columns:1fr}.provider-grid .wide{grid-column:auto}'
    + '.pipeline-map{grid-template-columns:1fr}.pipeline-arrow{transform:rotate(90deg);text-align:center}}'
    + '</style>'
    + '<div class="page-header"><div class="row align-items-center"><div class="col">'
    + '<h2 class="page-title">DIY Usenet pipeline</h2>'
    + '<div class="text-secondary mt-1">Your own indexer and playback backend. '
    + 'Turn the pipeline on in <a href="/account">Configure</a>; set it up here.</div>'
    + '</div></div></div>'
    + flash
    + '<form method="POST" action="/account/usenet/save">'
    +   '<div class="pipeline-map">'
    +     '<div class="pipeline-node"><strong>1. Discover</strong><span class="text-secondary small">Prowlarr, Newznab/NZBHydra, and optional UU title search.</span></div><div class="pipeline-arrow">→</div>'
    +     '<div class="pipeline-node"><strong>2. Match</strong><span class="text-secondary small">SSS filters noise, checks event relevance, ranks, and stores opaque candidates.</span></div><div class="pipeline-arrow">→</div>'
    +     '<div class="pipeline-node"><strong>3. Play</strong><span class="text-secondary small">Choose native NNTP, NZB DAV, or keep both as independent result rows.</span></div>'
    +   '</div>'
    +   '<div class="alert alert-info mb-0"><strong>One search, flexible playback:</strong> both backends consume the same filtered candidates and run alongside every existing service. Disabling either backend preserves its encrypted credentials.</div>'
    +   '<section class="pipeline-stage"><div class="pipeline-stage-head"><div><div class="pipeline-kicker">Stage 1</div><h3>Search and candidate discovery</h3></div><span class="badge bg-blue-lt">Shared input</span></div>'
    +   '<div class="provider-grid">'
    +     '<div class="wide"><label class="form-check form-switch"><input class="form-check-input" type="checkbox" name="diyNativeSearchEnabled" value="on"' + (cfg.diyNativeSearchEnabled === true ? ' checked' : '') + '><span class="form-check-label"><strong>Enable native Usenet text search</strong></span></label></div>'
    +     '<div><label class="form-label" for="diy-search-kind">Search service</label><select class="form-select" id="diy-search-kind" name="diySearchKind"><option value="newznab"' + (cfg.diySearchKind !== 'prowlarr' ? ' selected' : '') + '>Newznab / NZBHydra</option><option value="prowlarr"' + (cfg.diySearchKind === 'prowlarr' ? ' selected' : '') + '>Prowlarr</option></select></div>'
    +     '<div><label class="form-label" for="diy-search-name">Display name</label><input class="form-control" type="text" id="diy-search-name" name="diySearchName" value="' + escapeHtml(cfg.diySearchName || '') + '" placeholder="NZBHydra or NZBGeek"></div>'
    +     '<div><label class="form-label" for="diy-search-url">Search URL</label><input class="form-control text-mono" type="url" id="diy-search-url" name="diySearchUrl" value="' + escapeHtml(cfg.diySearchUrl || '') + '" placeholder="http://nzbhydra2:5076 or http://prowlarr:9696"></div>'
    +     '<div>' + secretField('Search API key', 'diySearchApiKey', cfg.diySearchApiKey, 'paste the indexer or manager API key') + '</div>'
    +     '<div><label class="form-label" for="diy-search-test-query">Test query</label><input class="form-control" type="text" id="diy-search-test-query" name="diySearchTestQuery" value="UFC" maxlength="200"></div>'
    +     '<div class="d-flex align-items-end"><button class="btn btn-outline-primary w-100" type="submit" formaction="/account/test-diy-search" formnovalidate>Test native search</button></div>'
    +     '<div class="wide"><label class="form-check form-switch"><input class="form-check-input" type="checkbox" name="diyUuSearchEnabled" value="on"' + (cfg.diyUuSearchEnabled !== false ? ' checked' : '') + '><span class="form-check-label">Also use UU text search for DIY results</span></label><div class="form-hint">Turn this off to validate SSS native search without UU. This does not control UU’s own stream rows.</div></div>'
    +   '</div></section>'
    +   '<section class="pipeline-stage"><div class="pipeline-stage-head"><div><div class="pipeline-kicker">Stage 2</div><h3>Playback backends</h3></div><span class="badge bg-green-lt">Choose one or both</span></div>'
    +   '<div class="pipeline-backends">'
    +     '<div class="pipeline-backend"><div class="d-flex justify-content-between gap-2 mb-2"><div><h4 class="h4 mb-1">NZB DAV</h4><div class="text-secondary small">Complete download and WebDAV playback, including archive releases.</div></div><span class="badge bg-green-lt align-self-start">Stable</span></div>'
    +       '<label class="form-check form-switch mb-3"><input class="form-check-input" type="checkbox" name="diyUsenetEnabled" value="on"' + (cfg.diyUsenetEnabled === true ? ' checked' : '') + '><span class="form-check-label"><strong>Enable NZB DAV rows</strong></span></label>'
    +       '<div class="provider-grid">'
    +         '<div><label class="form-label" for="nzbdav-url">API URL</label><input class="form-control text-mono" type="url" id="nzbdav-url" name="nzbdavUrl" value="' + escapeHtml(cfg.nzbdavUrl || '') + '" placeholder="http://nzbdav:3000"></div>'
    +         '<div>' + secretField('API key', 'nzbdavApiKey', cfg.nzbdavApiKey, 'paste the NZB DAV API key') + '</div>'
    +         '<div><label class="form-label" for="nzbdav-webdav-url">WebDAV URL</label><input class="form-control text-mono" type="url" id="nzbdav-webdav-url" name="nzbdavWebdavUrl" value="' + escapeHtml(cfg.nzbdavWebdavUrl || '') + '" placeholder="http://nzbdav:3000"></div>'
    +         '<div><label class="form-label" for="nzbdav-webdav-user">WebDAV username</label><input class="form-control" type="text" id="nzbdav-webdav-user" name="nzbdavWebdavUsername" value="' + escapeHtml(cfg.nzbdavWebdavUsername || '') + '" autocomplete="off"></div>'
    +         '<div>' + secretField('WebDAV password', 'nzbdavWebdavPassword', cfg.nzbdavWebdavPassword, 'your WebDAV password') + '</div>'
    +       '</div><button class="btn btn-outline-primary mt-3 w-100" type="submit" formaction="/account/test-nzbdav" formnovalidate>Test NZB DAV pipeline</button></div>'
    +     '<div class="pipeline-backend"><div class="d-flex justify-content-between gap-2 mb-2"><div><h4 class="h4 mb-1">Native NNTP</h4><div class="text-secondary small">Instant range streaming for direct files and stored RAR4/RAR5 videos.</div></div><span class="badge bg-azure-lt align-self-start">Preview</span></div>'
    +       '<label class="form-check form-switch mb-3"><input class="form-check-input" type="checkbox" name="nativeNntpEnabled" value="on"' + (cfg.nativeNntpEnabled === true ? ' checked' : '') + '><span class="form-check-label"><strong>Enable native NNTP rows</strong></span></label>'
    +       '<div class="provider-grid">'
    +         '<div><label class="form-label" for="nntp-host">NNTP host</label><input class="form-control text-mono" id="nntp-host" name="nntpHost" value="' + escapeHtml(cfg.nntpHost || '') + '" placeholder="news.provider.example"></div>'
    +         '<div><label class="form-label" for="nntp-port">Port</label><input class="form-control" type="number" min="1" max="65535" id="nntp-port" name="nntpPort" value="' + escapeHtml(String(cfg.nntpPort || 563)) + '"></div>'
    +         '<div><label class="form-label" for="nntp-user">Username</label><input class="form-control" id="nntp-user" name="nntpUsername" value="' + escapeHtml(cfg.nntpUsername || '') + '" autocomplete="off"></div>'
    +         '<div>' + secretField('Password', 'nntpPassword', cfg.nntpPassword, 'your NNTP password') + '</div>'
    +         '<div><label class="form-label" for="nntp-connections">Maximum connections</label><input class="form-control" type="number" min="1" max="50" id="nntp-connections" name="nntpConnections" value="' + escapeHtml(String(cfg.nntpConnections || 20)) + '"><div class="form-hint">20 recommended; sockets are pre-authenticated, pooled, and reused. Do not exceed your provider limit.</div></div>'
    +         '<div class="d-flex align-items-center"><label class="form-check form-switch mt-3"><input class="form-check-input" type="checkbox" name="nntpTls" value="on"' + (cfg.nntpTls !== false ? ' checked' : '') + '><span class="form-check-label">Use TLS (recommended)</span></label></div>'
    +       '</div><button class="btn btn-outline-primary mt-3 w-100" type="submit" formaction="/account/test-nntp" formnovalidate>Test NNTP pipeline</button></div>'
    +   '</div>'
    +   '<div class="pipeline-output"><span class="badge bg-secondary-lt">Shared filtered results</span><span class="badge bg-green-lt">📦 NZB DAV rows</span><span class="badge bg-azure-lt">⚡ Native NNTP rows</span><span class="badge bg-secondary-lt">Independent toggles</span></div>'
    +   '</section>'
    + '<div class="d-flex gap-2 mt-3">'
    +   '<button class="btn btn-primary" type="submit">Save DIY Usenet settings</button>'
    +   '<a class="btn btn-outline-secondary" href="/account">Back to Configure</a>'
    + '</div>'
    + '</form>';
}

module.exports = { renderBody };
