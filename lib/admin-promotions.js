// 0.35.0 — Admin /promotions page logic.
//
// Lists all promotions (hardcoded + custom). Custom promotions are editable
// via the in-page form. Hardcoded promotions are shown read-only with a
// badge. Add / Edit form takes a TSDB leagueId plus matching config; the
// validate-leagueid endpoint sanity-checks the ID against TSDB before save.

const customPromotions = require('./custom-promotions');
const promotions = require('./promotions');
const fetch = require('node-fetch');
const config = require('../config');
// 0.38.0: football-data validator lives next to the existing TSDB validator.
let footballData = null;
try { footballData = require('./sources/football-data'); } catch (e) { footballData = null; }
// 0.42.13 — TMDB validator lives next to the existing TSDB + football-data validators.
let tmdbSource = null;
try { tmdbSource = require('./sources/tmdb'); } catch (e) { tmdbSource = null; }

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// Render the page body. opts: { editId, flash }.
function renderBody(opts) {
  opts = opts || {};
  const flash = opts.flash || null;
  const editId = opts.editId || null;
  const all = promotions.all;
  const editing = editId ? customPromotions.findById(editId) : null;

  let flashHtml = flash
    ? '<div class="alert alert-info alert-dismissible" role="alert">'
      + '<div>' + escapeHtml(flash) + '</div>'
      + '<a class="btn-close" data-bs-dismiss="alert"></a>'
      + '</div>'
    : '';

  // Build the list table (Tabler classes).
  let rows = '';
  for (const p of all) {
    const provenance = p.isCustom
      ? '<span class="badge bg-green-lt">custom</span>'
      : '<span class="badge bg-blue-lt">built-in</span>';
    const leagueId = (p.source && p.source.leagueId) || '—';

    // 0.41.0 — per-promotion refresh button. Available for both built-in and
    // custom promotions; runs in the background, leaves other promotions'
    // events untouched, much faster than the global "Refresh catalogs" button
    // on /admin. Especially useful when iterating alias/keyword changes.
    const refreshBtn = ''
      + '<form method="POST" action="/admin/promotions/' + encodeURIComponent(p.id) + '/refresh" class="d-inline me-1">'
      +   '<button type="submit" class="btn btn-sm btn-outline-info" title="Fetch fresh events for just this promotion (other promotions untouched)">Refresh</button>'
      + '</form>';

    const actions = p.isCustom
      ? ''
        + refreshBtn
        + '<a class="btn btn-sm btn-outline-primary me-1" href="/admin/promotions?edit=' + encodeURIComponent(p.id) + '">Edit</a>'
        + '<form method="POST" action="/admin/promotions/' + encodeURIComponent(p.id) + '/delete" class="d-inline" onsubmit="return confirm(\'Delete custom promotion &quot;' + escapeHtml(p.name) + '&quot;? Stored events stay in the catalog until the next refresh.\');">'
        +   '<button type="submit" class="btn btn-sm btn-outline-danger">Delete</button>'
        + '</form>'
      : refreshBtn + '<span class="text-secondary small">read-only</span>';
    rows += ''
      + '<tr>'
      +   '<td>' + provenance + '</td>'
      +   '<td><strong>' + escapeHtml(p.name) + '</strong><br><span class="text-secondary text-mono small">id=' + escapeHtml(p.id) + '</span></td>'
      +   '<td class="text-mono">' + escapeHtml(leagueId) + '</td>'
      +   '<td>' + escapeHtml(p.posterShape || 'landscape') + '</td>'
      +   '<td>' + escapeHtml(String((p.catalogs || []).length)) + '</td>'
      +   '<td class="text-nowrap">' + actions + '</td>'
      + '</tr>';
  }

  // The add/edit form (single form serves both modes).
  const ed = editing || {};
  const isEdit = !!editing;
  const formAction = isEdit
    ? '/admin/promotions/' + encodeURIComponent(editing.id) + '/update'
    : '/admin/promotions/create';
  const formTitle = isEdit ? 'Edit "' + editing.name + '"' : 'Add a custom promotion';

  const tplLines = (ed.searchTitleTemplates && ed.searchTitleTemplates.length)
    ? ed.searchTitleTemplates.join('\n')
    : '{name}\n{name} {year}';
  const keywordsStr = (ed.relevanceKeywords && ed.relevanceKeywords.length)
    ? ed.relevanceKeywords.join(', ')
    : '';

  // 0.35.0: Check TSDB button — validates the form's promotion id (format + no
  // collision with built-ins) BEFORE hitting TSDB. Uses a template literal so
  // we don't need triple-escaped quote gymnastics inside the inline script.
  //
  // Reserved IDs + the editing-id are emitted as JS literals; client-side
  // validator uses them to flag collisions without a round-trip.
  const reservedIds = JSON.stringify(promotions.all.filter((p) => !p.isCustom).map((p) => p.id));
  const editingIdJs = isEdit ? JSON.stringify(editing.id) : 'null';
  // Build a single contiguous block of JS using a template literal. The
  // ${...} interpolations are evaluated server-side; everything else is
  // sent through verbatim. Uses textContent for plain text and a
  // verdict-span helper for the OK/FAIL badge so we avoid innerHTML
  // injection and stop battling escape chars.
  const validateJs = `<script>
(function(){
  var RESERVED = ${reservedIds};
  var EDITING_ID = ${editingIdJs};
  var ID_RE = /^[a-z0-9_-]{2,30}$/;
  var idInp  = document.getElementById('p-id');
  var out    = document.getElementById('validateOut');
  var srcSel = document.getElementById('p-source');
  var tsdbInp = document.getElementById('leagueId-input');
  var fdInp   = document.getElementById('competitionId-input');
  var tsdbBtn = document.getElementById('validateLeague');
  var fdBtn   = document.getElementById('validateCompetition');
  var tvInp   = document.getElementById('tvId-input');
  var tvBtn   = document.getElementById('validateTv');
  if (!out) return;

  function setVerdict(kind, msg) {
    out.textContent = '';
    var span = document.createElement('span');
    span.className = 'verdict-' + kind;
    span.textContent = kind === 'ok' ? 'OK' : kind === 'rej' ? 'FAIL' : 'ERROR';
    out.appendChild(span);
    out.appendChild(document.createTextNode(' ' + msg));
  }

  // 0.38.0: toggle source-specific blocks based on dropdown selection.
  function updateSourceVisibility() {
    var src = (srcSel && srcSel.value) || 'tsdb';
    document.querySelectorAll('.source-block').forEach(function(el){ el.style.display = 'none'; });
    var active = document.querySelector('.source-block.source-' + src);
    if (active) active.style.display = '';
  }
  if (srcSel) {
    srcSel.addEventListener('change', updateSourceVisibility);
    updateSourceVisibility();
  }

  function preflightId() {
    var promoId = idInp ? (idInp.value || '').trim().toLowerCase() : '';
    if (!promoId) { setVerdict('rej', 'Fill in the promotion ID first.'); idInp && idInp.focus(); return null; }
    if (!ID_RE.test(promoId)) { setVerdict('rej', 'Promotion id must match [a-z0-9_-]{2,30} (got: ' + promoId + ')'); idInp && idInp.focus(); return null; }
    if (promoId !== EDITING_ID && RESERVED.indexOf(promoId) !== -1) { setVerdict('rej', 'id "' + promoId + '" is reserved by a built-in promotion.'); idInp && idInp.focus(); return null; }
    return promoId;
  }

  // TSDB validator
  if (tsdbBtn) tsdbBtn.addEventListener('click', async function () {
    if (preflightId() === null) return;
    var id = (tsdbInp.value || '').trim();
    if (!id) { setVerdict('rej', 'Enter a TSDB league id.'); tsdbInp.focus(); return; }
    if (!/^\\d+$/.test(id)) { setVerdict('rej', 'League id must be numeric (got: ' + id + ')'); tsdbInp.focus(); return; }
    out.textContent = 'Checking TSDB…';
    try {
      var body = new URLSearchParams(); body.append('leagueId', id);
      var res = await fetch('/admin/promotions/validate-leagueid', {
        method: 'POST', body: body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      var j = await res.json();
      if (j.ok) {
        var sample = (j.sample || []).slice(0, 5).join(', ');
        setVerdict('ok', (j.leagueName || '(unnamed)') + ' · sport: ' + (j.sport || '?') + ' · recent events: ' + sample);
      } else {
        setVerdict('rej', j.error || 'unknown error');
      }
    } catch (e) { setVerdict('err', e.message); }
  });

  // football-data validator
  if (fdBtn) fdBtn.addEventListener('click', async function () {
    if (preflightId() === null) return;
    var id = (fdInp.value || '').trim();
    if (!id) { setVerdict('rej', 'Enter a competition id or code.'); fdInp.focus(); return; }
    if (!/^(\\d+|[A-Za-z0-9]{2,4})$/.test(id)) { setVerdict('rej', 'competitionId must be numeric or 2-4 char code (got: ' + id + ')'); fdInp.focus(); return; }
    out.textContent = 'Checking football-data.org…';
    try {
      var body = new URLSearchParams(); body.append('competitionId', id);
      var res = await fetch('/admin/promotions/validate-competition', {
        method: 'POST', body: body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      var j = await res.json();
      if (j.ok) {
        var sample = (j.sample || []).slice(0, 5).join(', ');
        setVerdict('ok', (j.leagueName || '(unnamed)') + ' · ' + (j.sport || 'Football') + ' · upcoming: ' + (sample || '(no upcoming matches)'));
      } else {
        setVerdict('rej', j.error || 'unknown error');
      }
    } catch (e) { setVerdict('err', e.message); }
  });

  // TMDB validator
  if (tvBtn) tvBtn.addEventListener('click', async function () {
    if (preflightId() === null) return;
    var id = (tvInp.value || '').trim();
    if (!id) { setVerdict('rej', 'Enter a TMDB TV show id.'); tvInp.focus(); return; }
    if (!/^\\d+$/.test(id)) { setVerdict('rej', 'tvId must be numeric (got: ' + id + ')'); tvInp.focus(); return; }
    out.textContent = 'Checking TMDB…';
    try {
      var body = new URLSearchParams(); body.append('tvId', id);
      var res = await fetch('/admin/promotions/validate-tvid', {
        method: 'POST', body: body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      var j = await res.json();
      if (j.ok) {
        setVerdict('ok', (j.showName || '(unnamed)') + ' · ' + (j.seasons || '?') + ' season(s) · first air: ' + (j.firstAirDate || '?') + ' · last air: ' + (j.lastAirDate || '?'));
      } else {
        setVerdict('rej', j.error || 'unknown error');
      }
    } catch (e) { setVerdict('err', e.message); }
  });
})();
</script>`;

  const body = `
    <div class="page-header">
      <div class="row align-items-center">
        <div class="col">
          <h2 class="page-title">Promotions</h2>
          <div class="text-secondary mt-1">Built-in promotions are read-only and have bespoke matching logic. Custom promotions you add use a generic TSDB template (name + year keyword matching). Good for: NFL, NBA, MLB, NHL, soccer leagues, regional MMA promotions, any TSDB-tracked sport where release titles include the event name.</div>
        </div>
      </div>
    </div>
    ${flashHtml}

    <div class="card mb-4">
      <div class="table-responsive">
        <table class="table table-vcenter card-table">
          <thead><tr><th>Source</th><th>Name</th><th>TSDB id</th><th>Poster</th><th>Catalogs</th><th class="w-1"></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-header"><h3 class="card-title">${escapeHtml(formTitle)}</h3></div>
      <div class="card-body">
        <form method="POST" action="${escapeHtml(formAction)}">
          <div class="row g-3">
            <div class="col-md-4">
              <label class="form-label" for="p-id">ID (lowercase, [a-z0-9_-])</label>
              <input class="form-control text-mono" id="p-id" type="text" name="id" value="${escapeHtml(ed.id || '')}" placeholder="nfl" required pattern="[a-z0-9_-]{2,30}" ${isEdit ? 'readonly' : ''}>
              ${isEdit ? '<small class="text-secondary">ID cannot be changed after creation (would orphan stored events).</small>' : ''}
            </div>
            <div class="col-md-8">
              <label class="form-label" for="p-name">Display name</label>
              <input class="form-control" id="p-name" type="text" name="name" value="${escapeHtml(ed.name || '')}" placeholder="NFL" required maxlength="64">
            </div>
          </div>

          <div class="mb-3 mt-3">
            <label class="form-label" for="p-source">Data source</label>
            <select class="form-select" id="p-source" name="source">
              <option value="tsdb"${(ed.source || 'tsdb') === 'tsdb' ? ' selected' : ''}>TheSportsDB (most sports)</option>
              <option value="football-data"${ed.source === 'football-data' ? ' selected' : ''}>football-data.org (football: FIFA WC, EPL, Champions League, etc.)</option>
              <option value="tmdb"${ed.source === 'tmdb' ? ' selected' : ''}>TMDB (TV shows: Match of the Day, ITV highlights, boxing analysis)</option>
            </select>
            <small class="text-secondary">Use football-data.org for football competitions — TheSportsDB's free tier has very sparse coverage for FIFA WC / EPL / etc. Requires the FOOTBALL_DATA_API_KEY env var (free signup at football-data.org/client/register).</small>
          </div>

          <div class="mb-3 source-block source-tsdb"${(ed.source === 'football-data') ? ' style="display:none;"' : ''}>
            <label class="form-label" for="leagueId-input">TSDB league id</label>
            <div class="input-group">
              <input class="form-control text-mono" id="leagueId-input" type="text" name="leagueId" value="${escapeHtml(ed.leagueId || '')}" placeholder="4391" pattern="\\d+">
              <button type="button" class="btn btn-outline-primary" id="validateLeague">Check TSDB</button>
            </div>
            <small class="text-secondary">Find ids at thesportsdb.com — example: 4391 = NFL, 4387 = NBA, 4424 = MLB, 4380 = NHL, 4328 = English Premier League.</small>
          </div>

          <div class="mb-3 source-block source-football-data"${(ed.source !== 'football-data') ? ' style="display:none;"' : ''}>
            <label class="form-label" for="competitionId-input">football-data competition id / code</label>
            <div class="input-group">
              <input class="form-control text-mono" id="competitionId-input" type="text" name="competitionId" value="${escapeHtml(ed.competitionId || '')}" placeholder="2000 or WC" pattern="(\\d+|[A-Za-z0-9]{2,4})">
              <button type="button" class="btn btn-outline-primary" id="validateCompetition">Check football-data</button>
            </div>
            <small class="text-secondary">Examples: 2000 / WC (FIFA World Cup), 2021 / PL (English Premier League), 2001 / CL (Champions League), 2002 / BL1 (Bundesliga), 2014 / PD (La Liga), 2019 / SA (Serie A), 2015 / FL1 (Ligue 1). Full list at football-data.org/coverage.</small>
          </div>

          <div class="mb-3 source-block source-tmdb"${(ed.source !== 'tmdb') ? ' style="display:none;"' : ''}>
            <label class="form-label" for="tvId-input">TMDB TV show id</label>
            <div class="input-group">
              <input class="form-control text-mono" id="tvId-input" type="text" name="tvId" value="${escapeHtml(ed.tvId || '')}" placeholder="224" pattern="\\d+">
              <button type="button" class="btn btn-outline-primary" id="validateTv">Check TMDB</button>
            </div>
            <small class="text-secondary">Find ids at themoviedb.org — example: 224 = Match of the Day. Requires TMDB_API_KEY env var.</small>
          </div>

          <div id="validateOut" class="mb-3"></div>

          <div class="row g-3">
            <div class="col-md-6">
              <label class="form-label" for="p-poster">Poster URL (fallback when TSDB has no per-event poster)</label>
              <input class="form-control text-mono" id="p-poster" type="url" name="poster" value="${escapeHtml(ed.poster || '')}" placeholder="https://...">
            </div>
            <div class="col-md-6">
              <label class="form-label" for="p-fanart">Fanart URL</label>
              <input class="form-control text-mono" id="p-fanart" type="url" name="fanart" value="${escapeHtml(ed.fanart || '')}" placeholder="https://...">
            </div>
            <div class="col-md-6">
              <label class="form-label" for="p-logo">Logo URL</label>
              <input class="form-control text-mono" id="p-logo" type="url" name="logo" value="${escapeHtml(ed.logo || '')}" placeholder="https://...">
            </div>
            <div class="col-md-6">
              <label class="form-label" for="p-shape">Poster shape</label>
              <select class="form-select" id="p-shape" name="posterShape">
                <option value="landscape"${ed.posterShape === 'landscape' || !ed.posterShape ? ' selected' : ''}>landscape (16:9 tiles)</option>
                <option value="square"${ed.posterShape === 'square' ? ' selected' : ''}>square</option>
                <option value="poster"${ed.posterShape === 'poster' ? ' selected' : ''}>poster (2:3 portrait)</option>
              </select>
            </div>
          </div>

          <div class="mb-3 mt-3">
            <label class="form-label" for="p-templates">Search title templates (one per line)</label>
            <textarea class="form-control text-mono" id="p-templates" name="searchTitleTemplates" rows="3" required>${escapeHtml(tplLines)}</textarea>
            <small class="text-secondary">Placeholders: <code>{name}</code> (event name from TSDB) · <code>{year}</code> · <code>{date}</code>. Defaults: <code>{name}</code> and <code>{name} {year}</code>.</small>
          </div>

          <div class="mb-3">
            <label class="form-label" for="p-keywords">Relevance keywords (comma-separated)</label>
            <input class="form-control text-mono" id="p-keywords" type="text" name="relevanceKeywords" value="${escapeHtml(keywordsStr)}" placeholder="nfl, football" required>
            <small class="text-secondary">A candidate release title must contain AT LEAST ONE keyword (case-insensitive substring) to pass relevance filtering. Plus a year match (year in title, if any, must match the event year).</small>
          </div>

          <hr class="my-4">
          <h4 class="mb-2">Football-only extras <span class="badge bg-secondary-lt ms-2">optional</span></h4>
          <p class="text-secondary small mb-3">For matchup-style events like "Manchester United FC vs Nottingham Forest FC" — expand each team into every known alias so searches catch "Man United vs Nottm Forest", "MUFC vs NFFC", etc. Leave the preset blank for non-football promotions.</p>

          <div class="row">
            <div class="col-md-4 mb-3">
              <label class="form-label" for="p-alias-preset">Team alias preset</label>
              <select class="form-select" id="p-alias-preset" name="teamAliasPreset">
                <option value=""${!ed.teamAliasPreset ? ' selected' : ''}>None</option>
                <option value="epl"${ed.teamAliasPreset === 'epl' ? ' selected' : ''}>EPL (all 20 clubs, 2025-26)</option>
                <option value="championship"${ed.teamAliasPreset === 'championship' ? ' selected' : ''}>Championship (all 24 clubs, 2025-26)</option>
                <option value="league-one"${ed.teamAliasPreset === 'league-one' ? ' selected' : ''}>League One (all 24 clubs, 2025-26)</option>
                <option value="efl"${ed.teamAliasPreset === 'efl' ? ' selected' : ''}>EFL — all English tiers (EPL + Championship + L1)</option>
                <option value="ucl"${ed.teamAliasPreset === 'ucl' ? ' selected' : ''}>UCL (EPL + top Euro clubs)</option>
              </select>
              <small class="text-secondary">Pre-baked alias table for every club in the league. Merged with any overrides below.</small>
            </div>
            <div class="col-md-8 mb-3">
              <label class="form-label" for="p-league-aliases">League aliases (comma-separated)</label>
              <input class="form-control text-mono" id="p-league-aliases" type="text" name="leagueAliases" value="${escapeHtml((ed.leagueAliases || []).join(', '))}" placeholder="EPL, Premier League, PL">
              <small class="text-secondary">League-prefix variants added to search queries ("EPL Man United vs Forest"). Overrides the preset default when non-empty.</small>
            </div>
          </div>

          <div class="mb-3">
            <label class="form-label" for="p-team-aliases">Team alias overrides (JSON)</label>
            <textarea class="form-control text-mono" id="p-team-aliases" name="teamAliases" rows="4" placeholder='{"Manchester United FC": ["Man United", "Man Utd", "MUFC"]}'>${escapeHtml(ed.teamAliases ? JSON.stringify(ed.teamAliases, null, 2) : '')}</textarea>
            <small class="text-secondary">JSON object mapping canonical name (as returned by football-data.org) to a list of aliases. Merged on top of the preset. Leave blank to use preset as-is.</small>
          </div>

          <hr class="my-4">
          <h4 class="mb-2">Pipeline toggles <span class="badge bg-secondary-lt ms-2">optional</span></h4>
          <p class="text-secondary small mb-3">Disable specific stream pipelines for events from this promotion. Useful when one pipeline is slow-and-empty (e.g. TorBox+Prowlarr for football, where UU/Newsnab does all the real work). A disabled pipeline is skipped entirely — no query, no wait.</p>
          <div class="row">
            <div class="col-md-4 mb-2">
              <label class="form-check">
                <input class="form-check-input" type="checkbox" name="disablePipelineTorbox" value="1"${(ed.disabledPipelines && ed.disabledPipelines.indexOf('torbox') !== -1) ? ' checked' : ''}>
                <span class="form-check-label">Disable TorBox pipeline</span>
              </label>
              <small class="text-secondary d-block">Skips companion scraper → Prowlarr/Zilean/Bitmagnet → TorBox cache check.</small>
            </div>
            <div class="col-md-4 mb-2">
              <label class="form-check">
                <input class="form-check-input" type="checkbox" name="disablePipelineNewsnab" value="1"${(ed.disabledPipelines && ed.disabledPipelines.indexOf('newsnab') !== -1) ? ' checked' : ''}>
                <span class="form-check-label">Disable Newsnab (UU) pipeline</span>
              </label>
              <small class="text-secondary d-block">Skips direct Newsnab search + UU stream URL builder.</small>
            </div>
            <div class="col-md-4 mb-2">
              <label class="form-check">
                <input class="form-check-input" type="checkbox" name="disablePipelineEasynews" value="1"${(ed.disabledPipelines && ed.disabledPipelines.indexOf('easynews') !== -1) ? ' checked' : ''}>
                <span class="form-check-label">Disable Easynews pipeline</span>
              </label>
              <small class="text-secondary d-block">Skips per-user Easynews direct search.</small>
            </div>
          </div>

          <hr class="my-4">
          <h4 class="mb-2">Date-strict matching <span class="badge bg-secondary-lt ms-2">recommended for football</span></h4>
          <p class="text-secondary small mb-3">When ON, releases MUST contain a date within &plusmn;1 day of the fixture (matched against YYYY.MM.DD or DD.MM.YYYY in the title). Rejects the common failure mode of same-teams-different-year matches sneaking through (e.g. old "Man City vs Villa" repeats). Turn OFF for promotions where release titles rarely include dates (numbered PPVs, WWE editions).</p>
          <div class="mb-3">
            <label class="form-check">
              <input class="form-check-input" type="checkbox" name="requireDateInTitle" value="1"${((typeof ed.requireDateInTitle === 'boolean') ? ed.requireDateInTitle : (ed.source === 'football-data')) ? ' checked' : ''}>
              <span class="form-check-label">Require date in release title (exact-day match)</span>
            </label>
            <small class="text-secondary d-block">Football-data.org sources default to ON. TSDB sources default to OFF. This checkbox overrides the source default.</small>
          </div>

          <div class="d-flex gap-2">
            <button class="btn btn-primary" type="submit">${isEdit ? 'Save changes' : 'Create promotion'}</button>
            ${isEdit ? '<a class="btn btn-outline-secondary" href="/admin/promotions">Cancel</a>' : ''}
          </div>
        </form>
      </div>
    </div>
    ${validateJs}
  `;

  return body;
}

// Parse form body into a custom-promotion spec, create or update.
//
// 0.38.0: form now carries a `source` field ('tsdb' | 'football-data') and
// the corresponding per-source identifier ('leagueId' for TSDB, 'competitionId'
// for football-data). The unused identifier gets dropped during normalisation.
function saveFromForm(body, opts) {
  opts = opts || {};
  const isUpdate = !!opts.updateId;

  const source = String(body.source || 'tsdb').trim();

  // 0.40.0 — parse the optional football alias fields.
  const teamAliasPreset = String(body.teamAliasPreset || '').toLowerCase().trim();
  const leagueAliases = String(body.leagueAliases || '')
    .split(/,/).map((s) => s.trim()).filter(Boolean);
  let teamAliases = null;
  const rawTeamAliases = String(body.teamAliases || '').trim();
  if (rawTeamAliases) {
    try {
      const parsed = JSON.parse(rawTeamAliases);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // Validate values are string arrays
        let allValid = true;
        for (const v of Object.values(parsed)) {
          if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) { allValid = false; break; }
        }
        if (allValid) teamAliases = parsed;
      }
    } catch (_) { /* validation happens downstream; leave null on parse fail */ }
  }

  const spec = {
    id: String(body.id || '').toLowerCase().trim(),
    name: String(body.name || '').trim(),
    source,
    poster: String(body.poster || '').trim(),
    fanart: String(body.fanart || '').trim(),
    logo:   String(body.logo   || '').trim(),
    posterShape: String(body.posterShape || 'landscape').trim(),
    searchTitleTemplates: String(body.searchTitleTemplates || '')
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    relevanceKeywords: String(body.relevanceKeywords || '')
      .split(/,/).map((s) => s.toLowerCase().trim()).filter(Boolean),
    teamAliasPreset: teamAliasPreset || undefined,
    teamAliases: teamAliases || undefined,
    leagueAliases: leagueAliases.length ? leagueAliases : undefined,
    // 0.42.0 — pipeline toggles. Falsy → all pipelines active.
    disabledPipelines: [
      body.disablePipelineTorbox === '1'   ? 'torbox'   : null,
      body.disablePipelineNewsnab === '1'  ? 'newsnab'  : null,
      body.disablePipelineEasynews === '1' ? 'easynews' : null,
    ].filter(Boolean),
    // 0.42.6 — date-strict matching. Checkbox is ALWAYS in the form when we
    // render it, so we can treat unchecked as an explicit `false`. This lets
    // users un-tick and save the promotion (0.42.5 bug: unchecked collapsed to
    // undefined which the update path treated as "no change" and preserved the
    // stored `true`, making the box impossible to untick).
    requireDateInTitle: body.requireDateInTitle === '1',
  };
  if (spec.disabledPipelines.length === 0) delete spec.disabledPipelines;
  // Per-source identifier.
  if (source === 'tsdb') {
    spec.leagueId = String(body.leagueId || '').trim();
  } else if (source === 'football-data') {
    spec.competitionId = String(body.competitionId || '').trim();
  } else if (source === 'tmdb') {
    spec.tvId = String(body.tvId || '').trim();
  }
  // idPrefix defaults to id — keep them in sync.
  spec.idPrefix = spec.id;

  // Collect existing IDs from hardcoded + custom promotions (excluding the one
  // being updated, if any).
  const existing = new Set();
  for (const p of promotions.all) {
    if (isUpdate && p.id === opts.updateId) continue;
    existing.add(p.id);
  }

  if (isUpdate) {
    customPromotions.update(opts.updateId, spec, existing);
  } else {
    customPromotions.add(spec, existing);
  }

  // Hot-reload the promotion registry so the new entry is available immediately.
  promotions.reload();
  return spec;
}

function deleteCustom(id) {
  const ok = customPromotions.remove(id);
  if (ok) promotions.reload();
  return ok;
}

// TSDB league id sanity-check. Confirms the id resolves to a real league and
// returns recent event names so the admin can be sure they typed the right id.
async function validateLeagueId(leagueId) {
  const id = String(leagueId || '').trim();
  if (!/^\d+$/.test(id)) return { ok: false, error: 'leagueId must be numeric' };

  const key = (config && config.tsdb && config.tsdb.apiKey) || '123';
  const lookupUrl = 'https://www.thesportsdb.com/api/v1/json/' + encodeURIComponent(key)
                  + '/lookupleague.php?id=' + encodeURIComponent(id);

  let leagueJson;
  try {
    const r = await fetch(lookupUrl, { headers: { 'User-Agent': 'serioussportsync/0.35' }, timeout: 15000 });
    if (!r.ok) return { ok: false, error: 'TSDB HTTP ' + r.status };
    leagueJson = await r.json();
  } catch (err) {
    return { ok: false, error: 'TSDB network: ' + err.message };
  }
  const league = leagueJson && leagueJson.leagues && leagueJson.leagues[0];
  if (!league) return { ok: false, error: 'TSDB returned no league for id ' + id };

  // Use the league's own season label. Football/basketball leagues use split
  // seasons such as 2026-2027; querying the calendar year silently returns 0.
  const currentYear = league.strCurrentSeason || String(new Date().getUTCFullYear());
  const seasonUrl = 'https://www.thesportsdb.com/api/v1/json/' + encodeURIComponent(key)
                  + '/eventsseason.php?id=' + encodeURIComponent(id)
                  + '&s=' + currentYear;
  let sample = [];
  let count = 0;
  try {
    const r = await fetch(seasonUrl, { headers: { 'User-Agent': 'serioussportsync/0.35' }, timeout: 15000 });
    if (r.ok) {
      const j = await r.json();
      const events = (j && j.events) || [];
      count = events.length;
      sample = events.slice(0, 5).map((e) => e.strEvent || e.strFilename || '');
    }
  } catch (_) { /* sample is best-effort */ }

  return {
    ok: true,
    leagueName: league.strLeague || '',
    sport:      league.strSport  || '',
    recentEventCount: count,
    sample,
  };
}

// 0.38.0: football-data competition validator. Mirrors validateLeagueId's
// shape so the admin UI uses one fetch handler.
async function validateCompetitionId(competitionId) {
  const id = String(competitionId || '').trim();
  if (!id) return { ok: false, error: 'competitionId required' };
  if (!/^(\d+|[A-Za-z0-9]{2,4})$/.test(id)) {
    return { ok: false, error: 'competitionId must be numeric (2000) or 2-4 char code (WC, PL, CL)' };
  }
  if (!footballData) return { ok: false, error: 'football-data source module not available in this build' };
  const apiKey = (config && config.footballData && config.footballData.apiKey)
    || (require('./settings').getFootballData && require('./settings').getFootballData().apiKey)
    || '';
  if (!apiKey) {
    return { ok: false, error: 'FOOTBALL_DATA_API_KEY is not configured - set it in env or /admin' };
  }
  try {
    const comp = await footballData.lookupCompetition({ competitionId: id, apiKey });
    if (!comp || !comp.name) {
      return { ok: false, error: 'football-data returned no competition for id ' + id };
    }
    return {
      ok: true,
      leagueName: comp.name || '',
      sport: 'Football',
      recentEventCount: comp.currentSeason ? 1 : 0,
      sample: comp.currentSeason
        ? ['Season ' + (comp.currentSeason.startDate || '?') + ' - ' + (comp.currentSeason.endDate || '?')]
        : [],
    };
  } catch (err) {
    return { ok: false, error: 'football-data: ' + err.message };
  }
}

// 0.42.13: TMDB TV show validator. Mirrors validateLeagueId's shape.
async function validateTvId(tvId) {
  const id = String(tvId || '').trim();
  if (!id) return { ok: false, error: 'tvId required' };
  if (!/^\d+$/.test(id)) {
    return { ok: false, error: 'tvId must be numeric (got: ' + id + ')' };
  }
  if (!tmdbSource) return { ok: false, error: 'tmdb source module not available in this build' };
  const apiKey = (config && config.tmdb && config.tmdb.apiKey) || (process.env.TMDB_API_KEY || '');
  if (!apiKey) {
    return { ok: false, error: 'TMDB_API_KEY is not configured - set it via env var' };
  }
  try {
    const show = await tmdbSource.lookupShow({ tvId: id, apiKey });
    if (!show || !show.name) {
      return { ok: false, error: 'tmdb returned no show for id ' + id };
    }
    const seasons = Array.isArray(show.seasons)
      ? show.seasons.filter((s) => Number(s.season_number) > 0).length
      : 0;
    return {
      ok: true,
      showName: show.name || '',
      seasons,
      firstAirDate: show.first_air_date || '',
      lastAirDate: show.last_air_date || '',
    };
  } catch (err) {
    return { ok: false, error: 'tmdb: ' + err.message };
  }
}

module.exports = {
  renderBody,
  saveFromForm,
  deleteCustom,
  validateLeagueId,
  validateCompetitionId,
  validateTvId,
};
