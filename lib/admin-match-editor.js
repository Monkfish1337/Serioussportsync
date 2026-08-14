// 0.35.0 — Admin /match-editor page logic.
//
// Renders the editor HTML body (addon.js wraps with accountPage chrome) and
// handles form-save + test-bench requests. Two override types per promotion:
//   - locationAliases (currently only MotoGP exposes an alias surface)
//   - noisePatterns   (every promotion accepts extra rejection patterns)
//
// Hot-reload: saving writes data/match-overrides.json. The next /stream call
// re-reads the file via match-overrides.getMerged* so no container restart
// is required.

const matchOverrides = require('./match-overrides');
const promotions = require('./promotions');
const store = require('./store');

// Promotions that expose a location-alias surface in the editor. Others get
// only the noise-pattern editor. Driven by which promotions' code routes
// through matchOverrides.getMergedAliases (currently MotoGP).
const ALIAS_EDITABLE_PROMOTIONS = new Set(['motogp']);

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// Render the page body. opts: { selectedPromotionId, flash }.
function renderBody(opts) {
  opts = opts || {};
  const list = promotions.all;
  const selectedId = opts.selectedPromotionId || (list[0] && list[0].id) || '';
  const selected = list.find((p) => p.id === selectedId) || list[0];

  const overrides = selected ? matchOverrides.getPromotionOverrides(selected.id)
                             : { locationAliases: {}, noisePatterns: [] };
  const aliasMap = overrides.locationAliases || {};
  const noiseList = overrides.noisePatterns || [];

  const showAliases = selected && ALIAS_EDITABLE_PROMOTIONS.has(selected.id);

  // Build promotion picker dropdown.
  let promoOpts = '';
  for (const p of list) {
    const sel = p.id === selectedId ? ' selected' : '';
    promoOpts += '<option value="' + escapeHtml(p.id) + '"' + sel + '>'
              + escapeHtml(p.name) + (p.isCustom ? ' (custom)' : '') + '</option>';
  }

  // Build alias table rows (only if this promotion supports alias edits).
  let aliasRows = '';
  if (showAliases) {
    const entries = Object.entries(aliasMap);
    if (entries.length === 0) {
      aliasRows = '<tr class="alias-empty"><td colspan="3" class="text-secondary text-center py-3"><em>No overrides yet. Add a row to extend the built-in aliases for a TSDB location.</em></td></tr>';
    } else {
      for (const [loc, aliases] of entries) {
        aliasRows += ''
          + '<tr>'
          +   '<td><input class="form-control text-mono" type="text" name="alias_loc" value="' + escapeHtml(loc) + '" placeholder="e.g. united kingdom"></td>'
          +   '<td><input class="form-control text-mono" type="text" name="alias_val" value="' + escapeHtml(aliases.join(', ')) + '" placeholder="british, silverstone, uk"></td>'
          +   '<td><button type="button" class="btn btn-outline-danger btn-sm" data-action="del-alias-row">Remove</button></td>'
          + '</tr>';
      }
    }
  }

  // Event picker for the test bench. Limit to this promotion's events.
  const data = store.loadFromDisk();
  const events = (data.events || []).filter((e) => {
    if (!e || !e.id) return false;
    const colon = e.id.indexOf(':');
    if (colon === -1) return false;
    const pfx = e.id.slice(0, colon);
    return selected && selected.idPrefix === pfx;
  }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  let eventOpts = '<option value="">— pick an event —</option>';
  for (const ev of events.slice(0, 100)) {
    eventOpts += '<option value="' + escapeHtml(ev.id) + '">'
              + escapeHtml(ev.name) + (ev.date ? ' (' + escapeHtml(ev.date) + ')' : '')
              + '</option>';
  }

  const flashHtml = opts.flash
    ? '<div class="alert alert-info alert-dismissible" role="alert">'
      + '<div>' + escapeHtml(opts.flash) + '</div>'
      + '<a class="btn-close" data-bs-dismiss="alert"></a>'
      + '</div>'
    : '';

  // Build alias card section (only for promotions with an alias-table surface).
  const aliasCardHtml = showAliases ? `
    <div class="card mb-3">
      <div class="card-header"><h3 class="card-title">Location aliases</h3></div>
      <div class="card-body">
        <p class="text-secondary small mb-3">Each row maps a TSDB location name to additional aliases that should be searched + accepted as matches. Use comma-separated values. Built-in aliases are extended, never replaced.</p>
        <div class="table-responsive">
          <table class="table table-vcenter card-table mb-0">
            <thead><tr><th>TSDB location</th><th>Extra aliases (comma-separated)</th><th class="w-1"></th></tr></thead>
            <tbody id="aliasBody">${aliasRows}</tbody>
          </table>
        </div>
        <button type="button" class="btn btn-outline-primary mt-3" id="addAliasRow">+ Add row</button>
      </div>
    </div>` : `
    <div class="card mb-3">
      <div class="card-header"><h3 class="card-title">Location aliases</h3></div>
      <div class="card-body">
        <p class="text-secondary mb-0"><em>${escapeHtml(selected ? selected.name : 'This promotion')} uses bespoke matching logic (not the alias-table pattern). Alias editing is not available here yet — only the noise patterns below apply.</em></p>
      </div>
    </div>`;

  // Tabler-classed render of the page body. Chrome (sidebar + topbar) is
  // provided by tabler-chrome.js; we just emit the section markup here.
  const bodyHtml = `
    <div class="page-header">
      <div class="row align-items-center">
        <div class="col">
          <h2 class="page-title">Match editor</h2>
          <div class="text-secondary mt-1">Add release-name aliases and noise-rejection patterns that the matching filter applies on top of the built-in defaults. Saving takes effect on the next /stream call — no container restart needed.</div>
        </div>
      </div>
    </div>
    ${flashHtml}

    <div class="card mb-3">
      <div class="card-body">
        <form method="GET" action="/admin/match-editor" class="row g-2 align-items-end">
          <div class="col-md-4">
            <label class="form-label" for="promo-sel">Promotion</label>
            <select class="form-select" id="promo-sel" name="promo" onchange="this.form.submit()">${promoOpts}</select>
          </div>
        </form>
      </div>
    </div>

    <form method="POST" action="/admin/match-editor/save">
      <input type="hidden" name="promo" value="${escapeHtml(selectedId)}">
      ${aliasCardHtml}

      <div class="card mb-3">
        <div class="card-header"><h3 class="card-title">Noise patterns</h3></div>
        <div class="card-body">
          <p class="text-secondary small mb-3">One JavaScript regex per line. Each pattern is applied case-insensitively. Titles matching any pattern are dropped during the noise filter stage. Bad patterns are silently skipped (check /admin/logs for parse warnings).</p>
          <textarea class="form-control text-mono" name="noise" rows="6" placeholder="\\bgrandstand\\b&#10;\\bbts\\b">${escapeHtml(noiseList.join('\n'))}</textarea>
        </div>
      </div>

      <div class="d-flex gap-2 mb-4">
        <button class="btn btn-primary" type="submit">Save overrides</button>
        <button class="btn btn-outline-danger" formaction="/admin/match-editor/clear" type="submit" onclick="return confirm('Clear ALL overrides for ${escapeHtml(selected ? selected.name : '')}?');">Clear all</button>
      </div>
    </form>

    <div class="card">
      <div class="card-header"><h3 class="card-title">Test bench</h3></div>
      <div class="card-body">
        <p class="text-secondary small mb-3">Paste a release title from your indexer logs and click Test to see whether the (saved) filter currently accepts or rejects it for a specific event. Apply pending edits with Save first to test them.</p>
        <form id="testForm">
          <input type="hidden" name="promo" value="${escapeHtml(selectedId)}">
          <div class="mb-3">
            <label class="form-label" for="test-ev">Event</label>
            <select class="form-select" id="test-ev" name="eventId">${eventOpts}</select>
          </div>
          <div class="mb-3">
            <label class="form-label" for="test-title">Release title</label>
            <input class="form-control text-mono" id="test-title" name="title" type="text" placeholder="MotoGP 2026 - Round04 - SpanishGP - Full Weekend (1080p DornaRip ...)" required>
          </div>
          <div class="d-flex align-items-center gap-3">
            <button class="btn btn-primary" type="submit">Test match</button>
            <span id="testOut"></span>
          </div>
        </form>
      </div>
    </div>

    <script>
    (function(){
      var addBtn = document.getElementById('addAliasRow');
      var tbody  = document.getElementById('aliasBody');
      if (addBtn && tbody) addBtn.addEventListener('click', function(){
        var empty = tbody.querySelector('.alias-empty'); if (empty) empty.remove();
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td><input class="form-control text-mono" type="text" name="alias_loc" placeholder="e.g. united kingdom"></td>'
        + '<td><input class="form-control text-mono" type="text" name="alias_val" placeholder="british, silverstone, uk"></td>'
        + '<td><button type="button" class="btn btn-outline-danger btn-sm" data-action="del-alias-row">Remove</button></td>';
        tbody.appendChild(tr);
      });
      document.addEventListener('click', function(e){
        if (e.target && e.target.dataset && e.target.dataset.action === 'del-alias-row') {
          var row = e.target.closest('tr'); if (row) row.remove();
        }
      });
      var testForm = document.getElementById('testForm');
      var testOut  = document.getElementById('testOut');
      function setVerdict(kind, msg) {
        testOut.textContent = '';
        var span = document.createElement('span');
        span.className = 'verdict-' + kind;
        span.textContent = kind === 'ok' ? 'MATCH' : kind === 'rej' ? 'REJECT' : 'ERROR';
        testOut.appendChild(span);
        testOut.appendChild(document.createTextNode(' ' + msg));
      }
      if (testForm) testForm.addEventListener('submit', async function(ev){
        ev.preventDefault();
        testOut.textContent = 'Testing…';
        try {
          var fd = new FormData(testForm);
          var body = new URLSearchParams();
          fd.forEach(function(v,k){ body.append(k,v); });
          var res = await fetch('/admin/match-test', { method:'POST', body:body, headers:{'Content-Type':'application/x-www-form-urlencoded'} });
          var j = await res.json();
          if (j.ok) setVerdict('ok', '(passed noise + relevance filters)');
          else setVerdict('rej', '(stage: ' + (j.stage || '?') + ', reason: ' + (j.reason || 'unknown') + ')');
        } catch(e){ setVerdict('err', e.message); }
      });
    })();
    </script>
  `;

  return bodyHtml;
}

// Parse the form payload from /admin/match-editor/save into a normalized
// overrides shape and persist it. Returns the saved overrides for the
// promotion (or null if everything cleared).
function saveFromForm(promotionId, body) {
  if (!promotionId) throw new Error('promo missing');

  // alias_loc and alias_val arrive as parallel arrays.
  const locsRaw = arrayOf(body.alias_loc);
  const valsRaw = arrayOf(body.alias_val);
  const aliasMap = {};
  for (let i = 0; i < locsRaw.length; i++) {
    const loc = String(locsRaw[i] || '').toLowerCase().trim();
    const val = String(valsRaw[i] || '').trim();
    if (!loc || !val) continue;
    const aliases = val.split(',').map((s) => s.toLowerCase().trim()).filter(Boolean);
    if (aliases.length) aliasMap[loc] = aliases;
  }

  const noiseRaw = String(body.noise || '');
  const noise = noiseRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

  return matchOverrides.setPromotionOverrides(promotionId, {
    locationAliases: aliasMap,
    noisePatterns: noise,
  });
}

function arrayOf(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// Test bench: run the candidate through the noise filter AND the relevance
// filter for the given event. Returns { ok, stage, reason }.
//   stage: 'noise' | 'relevance' | null
//   reason: present when ok === false
function testMatch({ promotionId, eventId, title }) {
  if (!promotionId) return { ok: false, stage: null, reason: 'no-promotion' };
  if (!eventId)     return { ok: false, stage: null, reason: 'no-event' };
  if (!title)       return { ok: false, stage: null, reason: 'no-title' };

  const promo = promotions.all.find((p) => p.id === promotionId);
  if (!promo) return { ok: false, stage: null, reason: 'unknown-promotion' };

  const data = store.loadFromDisk();
  const event = (data.events || []).find((e) => e.id === eventId);
  if (!event) return { ok: false, stage: null, reason: 'unknown-event' };

  // Stage 1: noise filter
  const releaseFilter = require('./sources/release-filter');
  const filtered = releaseFilter.filterSportsNoise(
    [{ title: String(title) }], null, promotionId
  );
  if (filtered.results.length === 0) {
    return { ok: false, stage: 'noise', reason: 'matched-noise-pattern' };
  }

  // Stage 2: per-promotion relevance check
  if (typeof promo.isRelevantStreamTitle !== 'function') {
    return { ok: false, stage: 'relevance', reason: 'no-relevance-fn' };
  }
  const verdict = promo.isRelevantStreamTitle(String(title), event);
  if (verdict.ok) return { ok: true, stage: null };
  return { ok: false, stage: 'relevance', reason: verdict.reason || 'unknown' };
}

module.exports = {
  renderBody,
  saveFromForm,
  testMatch,
  clearOverrides(promotionId) {
    matchOverrides.setPromotionOverrides(promotionId, null);
  },
};
