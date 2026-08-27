'use strict';

const metadataSources = require('./metadata-sources');
const promotions = require('./promotions');

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function describe(source) {
  source = source || {};
  if (source.type === 'thesportsdb') return 'League ' + source.leagueId;
  if (source.type === 'football-data') return source.teamId ? 'Team ' + source.teamId : 'Competition ' + source.competitionId;
  if (source.type === 'tmdb') return 'TV ' + (source.tvIds || [source.tvId]).filter(Boolean).join(', ');
  if (source.type === 'onefc') return 'Official watch.onefc.com schedule';
  if (source.type === 'mlb') return 'Official MLB schedule (no API key)';
  return source.type || 'Unknown';
}

function renderBody(opts) {
  opts = opts || {};
  const definitions = metadataSources.list();
  const allPromotions = promotions.all;
  let rows = '';
  for (const definition of definitions) {
    const usedBy = allPromotions.filter((p) => p.sourceRef === definition.id).map((p) => p.name);
    rows += '<tr><td><strong>' + escapeHtml(definition.name) + '</strong><br><span class="text-mono text-secondary small">' + escapeHtml(definition.id) + '</span></td>'
      + '<td><span class="badge bg-azure-lt">' + escapeHtml(definition.source.type) + '</span><br><span class="text-secondary small">' + escapeHtml(describe(definition.source)) + '</span></td>'
      + '<td>' + escapeHtml(usedBy.join(', ') || 'Not assigned') + '</td>'
      + '<td>' + (definition.system ? '<span class="badge bg-blue-lt">shipped</span>' : '<span class="badge bg-green-lt">custom</span>') + '</td></tr>';
  }
  const flash = opts.flash ? '<div class="alert alert-info">' + escapeHtml(opts.flash) + '</div>' : '';
  return `
    <div class="page-header"><div><h2 class="page-title">Metadata</h2><p class="text-secondary mt-1">Manage reusable event schedules here, then assign one while creating or editing a promotion.</p></div></div>
    ${flash}
    <div class="card mb-4"><div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th>Source</th><th>Adapter</th><th>Used by</th><th>Kind</th></tr></thead><tbody>${rows}</tbody></table></div></div>
    <div class="card"><div class="card-header"><h3 class="card-title">Add metadata source</h3></div><div class="card-body">
      <p class="text-secondary">Choose where event names and dates come from. Credentials are configured separately and never stored in this source definition.</p>
      <form method="POST" action="/admin/metadata-sources/create">
        <div class="row g-3">
          <div class="col-md-5"><label class="form-label" for="m-name">Name</label><input class="form-control" id="m-name" required maxlength="80" name="name" placeholder="Official MLB schedule"></div>
          <div class="col-md-3"><label class="form-label" for="m-id">Source ID</label><input class="form-control text-mono" id="m-id" required pattern="[a-z0-9_-]{2,50}" name="id" placeholder="mlb-official"><small class="text-secondary">Generated from the name.</small></div>
          <div class="col-md-4"><label class="form-label" for="m-type">Provider</label><select class="form-select" id="m-type" name="type"><option value="mlb">MLB official schedule</option><option value="thesportsdb">TheSportsDB league</option><option value="football-data">football-data.org</option><option value="tmdb">TMDB TV series</option><option value="onefc">ONE official schedule</option></select></div>
        </div>
        <div class="adapter-fields mt-3" data-adapter="thesportsdb"><label class="form-label">TheSportsDB league ID</label><input class="form-control" name="leagueId" placeholder="4424"></div>
        <div class="adapter-fields mt-3" data-adapter="tmdb"><label class="form-label">TMDB TV IDs</label><input class="form-control" name="tvIds" placeholder="224, 3231"></div>
        <div class="adapter-fields mt-3" data-adapter="football-data"><div class="row g-2"><div class="col-md-6"><label class="form-label">Team ID</label><input class="form-control" name="teamId" placeholder="66"></div><div class="col-md-6"><label class="form-label">Competition ID/code</label><input class="form-control" name="competitionId" placeholder="PL or 2021"></div></div><small class="text-secondary">Enter either a team or competition.</small></div>
        <div class="alert alert-success mt-3 adapter-note" data-adapter="mlb">No identifier or API key is required. This uses MLB's public official schedule feed.</div>
        <div class="alert alert-success mt-3 adapter-note" data-adapter="onefc">No identifier is required. This uses ONE Championship's official schedule feed.</div>
        <button class="btn btn-primary mt-3" type="submit">Add source</button>
      </form>
    </div></div>
    <script>(function(){
      var name = document.getElementById('m-name'), id = document.getElementById('m-id'), type = document.getElementById('m-type');
      if (name && id) name.addEventListener('input', function(){ if (id.dataset.manual === '1') return; id.value = name.value.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,50); });
      if (id) id.addEventListener('input', function(e){ if (e.isTrusted) id.dataset.manual = '1'; });
      function fields(){ var selected = type.value; document.querySelectorAll('.adapter-fields,.adapter-note').forEach(function(el){ el.style.display = el.dataset.adapter === selected ? '' : 'none'; }); }
      if (type) { type.addEventListener('change', fields); fields(); }
    })();</script>`;
}

module.exports = { renderBody, describe };
