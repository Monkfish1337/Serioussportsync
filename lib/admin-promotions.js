// 0.35.0 — Admin /promotions page logic.
//
// Lists all promotions (hardcoded + custom). Custom promotions are editable
// via the in-page form. Hardcoded promotions are shown read-only with a
// badge. Add / Edit form takes a TSDB leagueId plus matching config; the
// validate-leagueid endpoint sanity-checks the ID against TSDB before save.

const customPromotions = require('./custom-promotions');
const promotions = require('./promotions');
const promotionAliases = require('./promotion-aliases');
const metadataSources = require('./metadata-sources');
const metadataSourceDiff = require('./metadata-source-diff');
const store = require('./store');
const usenetIndexer = require('./sources/usenet-indexer');
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
  const sourceDefinitions = metadataSources.list();
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
    const source = p.source || {};
    const sourceDetail = source.type === 'thesportsdb' ? 'league ' + (source.leagueId || '?')
      : source.type === 'football-data' ? (source.teamId ? 'team ' + source.teamId : 'competition ' + (source.competitionId || '?'))
      : source.type === 'tmdb' ? 'TV ' + (source.tvIds || [source.tvId]).filter(Boolean).join(', ')
      : source.type === 'onefc' ? 'watch.onefc.com' : source.type || 'unknown';
    let sourceOptions = '<option value="">Use promotion default</option>';
    for (const definition of sourceDefinitions) {
      sourceOptions += '<option value="' + escapeHtml(definition.id) + '"'
        + (p.sourceRef === definition.id ? ' selected' : '') + '>'
        + escapeHtml(definition.name) + '</option>';
    }
    const currentDefinition = sourceDefinitions.find((definition) => definition.id === p.sourceRef);
    const sourceControl = '<strong>' + escapeHtml(currentDefinition ? currentDefinition.name : 'Embedded source') + '</strong>'
      + '<br><small class="text-secondary">' + escapeHtml(sourceDetail) + '</small>'
      + '<details class="mt-1"><summary class="small link-primary">Change source</summary>'
      + '<form method="POST" action="/admin/promotions/' + encodeURIComponent(p.id) + '/source" class="source-change-form mt-1" data-promotion-id="' + escapeHtml(p.id) + '">'
      + '<div class="d-flex gap-1"><select class="form-select form-select-sm source-change-select" name="sourceRef" aria-label="Metadata source for ' + escapeHtml(p.name) + '">' + sourceOptions + '</select>'
      + '<button class="btn btn-sm btn-outline-info event-diff-preview" type="button">Preview</button>'
      + '<button class="btn btn-sm btn-outline-primary event-diff-confirm" type="submit" disabled>Save</button></div>'
      + '<input type="hidden" name="previewedSourceRef" value=""><div class="source-diff-output mt-2"></div></form></details>';

    // 0.41.0 — per-promotion refresh button. Available for both built-in and
    // custom promotions; runs in the background, leaves other promotions'
    // events untouched, much faster than the global "Refresh catalogs" button
    // on /admin. Especially useful when iterating alias/keyword changes.
    const refreshBtn = ''
      + '<form method="POST" action="/admin/promotions/' + encodeURIComponent(p.id) + '/refresh" class="promotion-refresh-form d-inline-block me-1" data-promotion-id="' + escapeHtml(p.id) + '" data-source-ref="' + escapeHtml(p.sourceRef || '') + '">'
      +   '<button type="button" class="btn btn-sm btn-outline-info event-diff-preview" title="Preview catalog changes before refreshing">Preview refresh</button>'
      +   '<button type="submit" class="btn btn-sm btn-outline-info event-diff-confirm" title="Fetch fresh events for just this promotion (other promotions untouched)" disabled>Refresh</button>'
      +   '<input type="hidden" name="previewedSourceRef" value=""><div class="source-diff-output text-start mt-1"></div>'
      + '</form>';
    const nuvioBtn = '<a class="btn btn-sm btn-outline-secondary me-1" href="/admin/nuvio-collections?promotion=' + encodeURIComponent(p.id) + '#add-folder">Nuvio</a>';

    const actions = p.isCustom
      ? ''
        + refreshBtn
        + nuvioBtn
        + '<a class="btn btn-sm btn-outline-primary me-1" href="/admin/promotions?edit=' + encodeURIComponent(p.id) + '">Edit</a>'
        + '<form method="POST" action="/admin/promotions/' + encodeURIComponent(p.id) + '/delete" class="d-inline" onsubmit="return confirm(\'Delete custom promotion &quot;' + escapeHtml(p.name) + '&quot;? Stored events stay in the catalog until the next refresh.\');">'
        +   '<button type="submit" class="btn btn-sm btn-outline-danger">Delete</button>'
        + '</form>'
      : refreshBtn + nuvioBtn + '<span class="text-secondary small">read-only</span>';
    rows += ''
      + '<tr>'
      +   '<td>' + provenance + '</td>'
      +   '<td><strong>' + escapeHtml(p.name) + '</strong><br><span class="text-secondary text-mono small">id=' + escapeHtml(p.id) + '</span></td>'
      +   '<td>' + sourceControl + '</td>'
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
  const editingSourceRef = isEdit ? metadataSources.assignmentFor(editing.id) : null;
  let registeredSourceOptions = isEdit && !editingSourceRef
    ? '<option value="" selected>Keep current embedded source</option>'
    : '<option value="" disabled' + (!editingSourceRef ? ' selected' : '') + '>Choose a metadata source…</option>';
  for (const definition of sourceDefinitions) {
    registeredSourceOptions += '<option value="' + escapeHtml(definition.id) + '"'
      + (editingSourceRef === definition.id ? ' selected' : '') + '>'
      + escapeHtml(definition.name) + '</option>';
  }
  const tplLines = (ed.searchTitleTemplates && ed.searchTitleTemplates.length)
    ? ed.searchTitleTemplates.join('\n')
    : '{name}\n{name} {year}';
  const keywordsStr = (ed.relevanceKeywords && ed.relevanceKeywords.length)
    ? ed.relevanceKeywords.join(', ')
    : '';
  const repairedRules = all.filter((promotion) => promotion.ignoredExclusionKeywords
    && promotion.ignoredExclusionKeywords.length);
  if (repairedRules.length) {
    flashHtml += '<div class="alert alert-warning"><strong>Conflicting reject words were ignored:</strong> '
      + repairedRules.map((promotion) => escapeHtml(promotion.name) + ' ('
        + escapeHtml(promotion.ignoredExclusionKeywords.join(', ')) + ')').join('; ')
      + '. Edit and save the promotion to persist the cleanup.</div>';
  }
  const promotionAliasLines = (ed.promotionAliases && ed.promotionAliases.length)
    ? ed.promotionAliases.join('\n')
    : '';
  const exclusionStr = (ed.exclusionKeywords && ed.exclusionKeywords.length)
    ? ed.exclusionKeywords.join(', ')
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
  var sourceRefSel = document.getElementById('p-source-ref');
  var inlineSource = document.getElementById('inline-source-config');
  var tsdbInp = document.getElementById('leagueId-input');
  var fdInp   = document.getElementById('competitionId-input');
  var tsdbBtn = document.getElementById('validateLeague');
  var fdBtn   = document.getElementById('validateCompetition');
  var tvInp   = document.getElementById('tvId-input');
  var tvBtn   = document.getElementById('validateTv');
  var aliasBtn = document.getElementById('deriveAliases');
  var previewBtn = document.getElementById('previewMatching');
  var aliasExamples = document.getElementById('p-release-examples');
  var badExamples = document.getElementById('p-bad-examples');
  var aliasOut = document.getElementById('p-promotion-aliases');
  var exclusionOut = document.getElementById('p-exclusions');
  var previewOut = document.getElementById('matchingPreview');
  var keywordInp = document.getElementById('p-keywords');
  var templateOut = document.getElementById('p-templates');
  var indexerQuery = document.getElementById('p-indexer-query');
  var indexerBtn = document.getElementById('searchIndexerReleases');
  var indexerOut = document.getElementById('indexerReleaseResults');
  if (!out) return;

  function diffLine(parent, text, cls) { var el=document.createElement('div'); el.className=cls||''; el.textContent=text; parent.appendChild(el); }
  function renderEventDiff(target, result) {
    target.textContent='';
    if(!result.ok){diffLine(target,'Preview failed: '+(result.error||'Unknown error'),'text-danger small');return;}
    var c=result.counts||{};
    diffLine(target,'After refresh: '+c.after+' events · +'+c.added+' added · ~'+c.updated+' updated · ='+c.unchanged+' unchanged · -'+c.removed+' removed','fw-semibold small');
    ['added','updated','removed'].forEach(function(kind){var rows=(result.samples&&result.samples[kind])||[];if(!rows.length)return;diffLine(target,kind.charAt(0).toUpperCase()+kind.slice(1)+': '+rows.map(function(e){return (e.date||'?')+' '+e.name+(e.sourceId?' (#'+e.sourceId+')':'');}).join(' | '),'text-secondary small');});
  }
  document.querySelectorAll('.event-diff-preview').forEach(function(button){button.addEventListener('click',async function(){
    var form=button.closest('form'),promotionId=form.dataset.promotionId,select=form.querySelector('.source-change-select');
    var sourceRef=select?select.value:(form.dataset.sourceRef||''),output=form.querySelector('.source-diff-output'),confirm=form.querySelector('.event-diff-confirm'),hidden=form.querySelector('input[name="previewedSourceRef"]');
    button.disabled=true;confirm.disabled=true;hidden.value='';output.textContent='Fetching and comparing events…';
    try{var body=new URLSearchParams({sourceRef:sourceRef});var res=await fetch('/admin/promotions/'+encodeURIComponent(promotionId)+'/source-preview',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body});var json=await res.json();renderEventDiff(output,json);if(res.ok&&json.ok){hidden.value=sourceRef;confirm.disabled=false;}}
    catch(err){renderEventDiff(output,{ok:false,error:err.message});}
    finally{button.disabled=false;}
  });});
  document.querySelectorAll('.source-change-select').forEach(function(select){select.addEventListener('change',function(){var form=select.closest('form');form.querySelector('.event-diff-confirm').disabled=true;form.querySelector('input[name="previewedSourceRef"]').value='';form.querySelector('.source-diff-output').textContent='Preview the selected source before saving.';});});

  function addReleaseTitle(title) {
    var examples = document.getElementById('p-release-examples'); if (!examples) return;
    var rows = (examples.value || '').split(/\\r?\\n/).map(function(v){return v.trim();}).filter(Boolean);
    if (rows.indexOf(title) === -1) rows.push(title);
    examples.value = rows.join('\\n');
  }

  if (indexerBtn) indexerBtn.addEventListener('click', async function () {
    var query = (indexerQuery && indexerQuery.value || '').trim() || (document.getElementById('p-name').value || '').trim();
    if (!query) { setVerdict('err', 'Enter a promotion name or indexer query first.'); return; }
    indexerBtn.disabled = true; indexerBtn.textContent = 'Searching…'; if (indexerOut) indexerOut.textContent = '';
    try {
      var body = new URLSearchParams(); body.append('query', query);
      ['includeTerms','excludeTerms','quality','indexerName','maxAgeDays','minSizeGb','maxSizeGb','sort','limit'].forEach(function(name){ var el=document.getElementById('p-indexer-'+name.replace(/[A-Z]/g,function(c){return '-'+c.toLowerCase();})); if(el) body.append(name,el.value||''); });
      var res = await fetch('/admin/promotions/search-releases', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: body });
      var json = await res.json(); if (!res.ok || !json.ok) throw new Error(json.error || 'Indexer search failed');
      if (!indexerOut) return;
      var heading = document.createElement('div'); heading.className = 'fw-semibold mb-2'; heading.textContent = json.results.length + ' of ' + json.total + ' release title(s) from ' + json.provider; indexerOut.appendChild(heading);
      if (!json.results.length) { var empty=document.createElement('div'); empty.className='text-secondary small'; empty.textContent='No titles found. Try an abbreviation or a team/event name.'; indexerOut.appendChild(empty); }
      json.results.forEach(function(item){
        var row=document.createElement('div'); row.className='d-flex align-items-start gap-2 border-top py-2';
        var use=document.createElement('button'); use.type='button'; use.className='btn btn-sm btn-outline-success flex-shrink-0'; use.textContent='Use title'; use.addEventListener('click',function(){addReleaseTitle(item.title); use.disabled=true; use.textContent='Added';});
        var copy=document.createElement('div'); var title=document.createElement('div'); title.className='text-mono small'; title.textContent=item.title; copy.appendChild(title);
        var detail=document.createElement('div'); detail.className='text-secondary small'; detail.textContent=[item.indexer,item.sizeLabel,item.publishedAt].filter(Boolean).join(' · '); copy.appendChild(detail);
        row.appendChild(use); row.appendChild(copy); indexerOut.appendChild(row);
      });
    } catch (e) { if(indexerOut){var err=document.createElement('div');err.className='alert alert-danger';err.textContent=e.message;indexerOut.appendChild(err);} }
    finally { indexerBtn.disabled = false; indexerBtn.textContent = 'Search configured indexer'; }
  });

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
  if (sourceRefSel && inlineSource) sourceRefSel.addEventListener('change', function () {
    inlineSource.open = !sourceRefSel.value;
  });
  var nameForId = document.getElementById('p-name');
  if (!EDITING_ID && nameForId && idInp) nameForId.addEventListener('input', function () {
    if (idInp.dataset.manual === '1') return;
    idInp.value = nameForId.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  });
  if (idInp) idInp.addEventListener('input', function (event) { if (event.isTrusted) idInp.dataset.manual = '1'; });

  if (aliasBtn) aliasBtn.addEventListener('click', async function () {
    var nameInp = document.getElementById('p-name');
    var name = nameInp ? (nameInp.value || '').trim() : '';
    if (!name) { setVerdict('rej', 'Enter the promotion display name first.'); nameInp && nameInp.focus(); return; }
    aliasBtn.disabled = true;
    aliasBtn.textContent = 'Analysing…';
    try {
      var body = new URLSearchParams();
      body.append('name', name);
      body.append('examples', aliasExamples ? aliasExamples.value : '');
      body.append('badExamples', badExamples ? badExamples.value : '');
      var res = await fetch('/admin/promotions/derive-aliases', {
        method: 'POST', body: body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      var j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || 'Alias analysis failed');
      if (aliasOut) aliasOut.value = (j.aliases || []).join('\\n');
      if (keywordInp && !(keywordInp.value || '').trim()) keywordInp.value = (j.keywords || []).join(', ');
      if (exclusionOut && !(exclusionOut.value || '').trim()) exclusionOut.value = (j.exclusions || []).join(', ');
      var currentTemplates = templateOut ? (templateOut.value || '').trim() : '';
      var defaultTemplates = '{name}\\n{name} {year}';
      if (templateOut && (j.searchTitleTemplates || []).length && (!EDITING_ID || !currentTemplates || currentTemplates === defaultTemplates)) {
        templateOut.value = j.searchTitleTemplates.join('\\n');
      }
      var learned = document.getElementById('learnedMatching'); if (learned) learned.open = true;
      var removed = (j.removedExclusions || []).length ? ' Conflicting reject words ignored: ' + j.removedExclusions.join(', ') + '.' : '';
      setVerdict('ok', 'Examples analyzed, including release search layout. Review the suggestions below, then test them.' + removed);
    } catch (e) { setVerdict('err', e.message); }
    finally { aliasBtn.disabled = false; aliasBtn.textContent = 'Analyze examples'; }
  });

  function addPreviewLine(parent, text, className) {
    var line = document.createElement('div');
    line.className = className || 'small';
    line.textContent = text;
    parent.appendChild(line);
  }

  if (previewBtn) previewBtn.addEventListener('click', async function () {
    var value = function(id) { var el = document.getElementById(id); return el ? el.value : ''; };
    var body = new URLSearchParams();
    body.append('name', value('p-name'));
    body.append('eventName', value('p-preview-event'));
    body.append('eventDate', value('p-preview-date'));
    body.append('goodExamples', value('p-release-examples'));
    body.append('badExamples', value('p-bad-examples'));
    body.append('promotionAliases', value('p-promotion-aliases'));
    body.append('exclusionKeywords', value('p-exclusions'));
    body.append('relevanceKeywords', value('p-keywords'));
    body.append('searchTitleTemplates', value('p-templates'));
    var strictDate = document.querySelector('input[name="requireDateInTitle"]');
    if (strictDate && strictDate.checked) body.append('requireDateInTitle', '1');
    previewBtn.disabled = true;
    previewBtn.textContent = 'Previewing…';
    if (previewOut) previewOut.textContent = 'Generating preview…';
    try {
      var res = await fetch('/admin/promotions/preview-matching', {
        method: 'POST', body: body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      var j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || 'Preview failed');
      if (previewOut) {
        previewOut.textContent = '';
        if ((j.warnings || []).length) addPreviewLine(previewOut, 'FIXED · ignored conflicting reject words: ' + j.warnings.join(', '), 'small text-warning mb-2');
        addPreviewLine(previewOut, 'Searches SSS will try (' + (j.queries || []).length + ')', 'fw-semibold mb-1');
        (j.queries || []).forEach(function(query) { addPreviewLine(previewOut, '• ' + query, 'small text-secondary'); });
        (j.examples || []).forEach(function(item) {
          var correct = (item.expected === 'accept') === item.accepted;
          var icon = correct ? 'PASS' : 'CHECK';
          var expected = item.expected === 'accept' ? 'should appear' : 'must not appear';
          addPreviewLine(previewOut, icon + ' · ' + expected + ' · SSS ' + (item.accepted ? 'included' : 'rejected') + ' it (' + item.reason + ') · ' + item.title,
            correct ? 'small text-success' : 'small text-danger');
        });
        if (!(j.examples || []).length) addPreviewLine(previewOut, 'Add known-good or known-bad titles to see classifications.', 'small text-secondary');
      }
    } catch (e) { if (previewOut) previewOut.textContent = 'Preview failed: ' + e.message; }
    finally { previewBtn.disabled = false; previewBtn.textContent = 'Preview matching'; }
  });

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
          <div class="text-secondary mt-1">A promotion combines an event schedule with rules that recognize matching releases. Add and manage schedule providers under <a href="/admin/metadata">Metadata</a>.</div>
        </div>
      </div>
    </div>
    ${flashHtml}

    <div class="card mb-4">
      <div class="table-responsive">
        <table class="table table-vcenter card-table">
          <thead><tr><th>Kind</th><th>Name</th><th>Metadata source</th><th>Poster</th><th>Catalogs</th><th class="w-1"></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-header"><h3 class="card-title">${escapeHtml(formTitle)}</h3></div>
      <div class="card-body">
        <form method="POST" action="${escapeHtml(formAction)}">
          <h4 class="mb-2">Promotion and schedule</h4>
          <p class="text-secondary small">Give the catalog a name and choose its event provider. Everything else has safe defaults.</p>
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
            <label class="form-label" for="p-source-ref">Event schedule</label>
            <select class="form-select" id="p-source-ref" name="sourceRef"${isEdit ? '' : ' required'}>${registeredSourceOptions}</select>
            <small class="text-secondary">Choose where event names and dates come from. Need another provider? <a href="/admin/metadata">Add it under Metadata</a>.</small>
          </div>

          <div id="validateOut" class="mb-3"></div>

          <div class="card bg-dark-lt mb-3">
            <div class="card-body">
              <h4 class="mb-1">Help SSS recognize releases <span class="badge bg-green-lt ms-2">optional</span></h4>
              <p class="text-secondary small">The promotion name creates safe defaults automatically. Add examples only when releases use abbreviations, alternate names, or recurring unwanted results.</p>
              <div class="card bg-dark mb-3"><div class="card-body py-3"><label class="form-label" for="p-indexer-query">Find real release examples from your indexer</label><div class="input-group"><input class="form-control text-mono" id="p-indexer-query" placeholder="MLB; Cubs vs Diamondbacks"><button class="btn btn-outline-info" type="button" id="searchIndexerReleases">Search configured indexer</button></div><small class="text-secondary">Separate up to five searches with semicolons. Uses Account → DIY Discover and only reads release titles; it never downloads or submits anything.</small>
              <details class="mt-3"><summary class="text-secondary">Filter and sort release results</summary><div class="row g-2 mt-1">
                <div class="col-md-4"><label class="form-label" for="p-indexer-include-terms">Must contain</label><input class="form-control text-mono" id="p-indexer-include-terms" placeholder="cubs, diamondbacks"><small class="text-secondary">Comma-separated; every term must match.</small></div>
                <div class="col-md-4"><label class="form-label" for="p-indexer-exclude-terms">Must not contain</label><input class="form-control text-mono" id="p-indexer-exclude-terms" placeholder="network, highlights"></div>
                <div class="col-md-2"><label class="form-label" for="p-indexer-quality">Quality</label><select class="form-select" id="p-indexer-quality"><option value="">Any</option><option value="720p">720p</option><option value="1080p">1080p</option><option value="2160p">2160p / 4K</option></select></div>
                <div class="col-md-2"><label class="form-label" for="p-indexer-indexer-name">Indexer</label><input class="form-control" id="p-indexer-indexer-name" placeholder="Any"></div>
                <div class="col-md-3"><label class="form-label" for="p-indexer-max-age-days">Published</label><select class="form-select" id="p-indexer-max-age-days"><option value="0">Any time</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last year</option></select></div>
                <div class="col-md-2"><label class="form-label" for="p-indexer-min-size-gb">Minimum GB</label><input class="form-control" id="p-indexer-min-size-gb" type="number" min="0" max="1000" step="0.1" placeholder="0"></div>
                <div class="col-md-2"><label class="form-label" for="p-indexer-max-size-gb">Maximum GB</label><input class="form-control" id="p-indexer-max-size-gb" type="number" min="0" max="1000" step="0.1" placeholder="Any"></div>
                <div class="col-md-3"><label class="form-label" for="p-indexer-sort">Sort by</label><select class="form-select" id="p-indexer-sort"><option value="relevance">Indexer relevance</option><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="largest">Largest first</option><option value="smallest">Smallest first</option><option value="title">Title A–Z</option></select></div>
                <div class="col-md-2"><label class="form-label" for="p-indexer-limit">Show</label><select class="form-select" id="p-indexer-limit"><option value="20">20</option><option value="40" selected>40</option><option value="80">80</option></select></div>
              </div></details><div class="mt-3" id="indexerReleaseResults"></div></div></div>
              <div class="row g-3">
                <div class="col-md-6"><label class="form-label" for="p-release-examples">Titles that should appear</label><textarea class="form-control text-mono" id="p-release-examples" rows="4" placeholder="MLB.2026.08.26.Chicago.Cubs.at.Arizona.Diamondbacks.1080p"></textarea><small class="text-secondary">One real release title per line.</small></div>
                <div class="col-md-6"><label class="form-label" for="p-bad-examples">Titles that must not appear</label><textarea class="form-control text-mono" id="p-bad-examples" rows="4" placeholder="MLB.Network.Daily.Show.2026.08.26.720p"></textarea><small class="text-secondary">Optional. Use false positives you have actually seen.</small></div>
              </div>
              <button class="btn btn-outline-primary mt-3" type="button" id="deriveAliases">Analyze examples</button>
              <details class="mt-3" id="learnedMatching"><summary class="text-secondary">Review what SSS learned</summary><div class="row g-3 mt-1">
                <div class="col-md-6"><label class="form-label" for="p-promotion-aliases">Names releases use for this promotion</label><textarea class="form-control text-mono" id="p-promotion-aliases" name="promotionAliases" rows="3" placeholder="Major League Baseball&#10;MLB">${escapeHtml(promotionAliasLines)}</textarea></div>
                <div class="col-md-6"><label class="form-label" for="p-exclusions">Words that reject a result</label><input class="form-control text-mono" id="p-exclusions" name="exclusionKeywords" value="${escapeHtml(exclusionStr)}" placeholder="network, daily show"><small class="text-secondary">A word that conflicts with the promotion name or an alias is ignored automatically.</small></div>
                <div class="col-12"><label class="form-label" for="p-keywords">Recognition terms override</label><input class="form-control text-mono" id="p-keywords" type="text" name="relevanceKeywords" value="${escapeHtml(keywordsStr)}" placeholder="Generated automatically if left blank"><small class="text-secondary">Usually leave this blank. It exists for unusual release naming.</small></div>
              </div></details>
              <details class="mt-3"><summary class="text-secondary">Test the rules with one event</summary><div class="row g-2 mt-1">
                <div class="col-md-8"><label class="form-label" for="p-preview-event">Event name from the schedule</label><input class="form-control" id="p-preview-event" placeholder="Chicago Cubs vs Arizona Diamondbacks"></div>
                <div class="col-md-4"><label class="form-label" for="p-preview-date">Event date</label><input class="form-control" id="p-preview-date" type="date"></div>
              </div><button class="btn btn-outline-info mt-2" type="button" id="previewMatching">Test these examples</button><div class="mt-3" id="matchingPreview"></div></details>
            </div>
          </div>

          <details class="card mb-3">
          <summary class="card-header cursor-pointer"><h4 class="card-title d-inline">Appearance and expert search patterns</h4><span class="text-secondary ms-2">advanced</span></summary>
          <div class="card-body"><div class="row g-3">
            <div class="col-md-6"><label class="form-label" for="p-poster">Poster URL</label><input class="form-control text-mono" id="p-poster" type="url" name="poster" value="${escapeHtml(ed.poster || '')}" placeholder="https://..."></div>
            <div class="col-md-6"><label class="form-label" for="p-fanart">Background URL</label><input class="form-control text-mono" id="p-fanart" type="url" name="fanart" value="${escapeHtml(ed.fanart || '')}" placeholder="https://..."></div>
            <div class="col-md-6"><label class="form-label" for="p-logo">Logo URL</label><input class="form-control text-mono" id="p-logo" type="url" name="logo" value="${escapeHtml(ed.logo || '')}" placeholder="https://..."></div>
            <div class="col-md-6"><label class="form-label" for="p-shape">Poster shape</label><select class="form-select" id="p-shape" name="posterShape"><option value="landscape"${ed.posterShape === 'landscape' || !ed.posterShape ? ' selected' : ''}>landscape</option><option value="square"${ed.posterShape === 'square' ? ' selected' : ''}>square</option><option value="poster"${ed.posterShape === 'poster' ? ' selected' : ''}>portrait poster</option></select></div>
            <div class="col-12"><label class="form-label" for="p-templates">Search title patterns</label><textarea class="form-control text-mono" id="p-templates" name="searchTitleTemplates" rows="4" required>${escapeHtml(tplLines)}</textarea><small class="text-secondary">Learned from example release layout. Available placeholders: <code>{promotion}</code>, <code>{name}</code>, <code>{year}</code>, <code>{date}</code>, <code>{date_spaced}</code>, <code>{date_dotted}</code>.</small></div>
          </div></div></details>

          <details class="card mb-3">
          <summary class="card-header cursor-pointer"><h4 class="card-title d-inline">Football aliases, pipeline controls, and date strictness</h4><span class="text-secondary ms-2">advanced</span></summary>
          <div class="card-body">
          <hr class="my-2">
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
          <p class="text-secondary small mb-3">Disable specific stream pipelines for events from this promotion. A disabled provider is skipped entirely — no query and no wait.</p>
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
                <input class="form-check-input" type="checkbox" name="disablePipelineUu" value="1"${(ed.disabledPipelines && (ed.disabledPipelines.indexOf('uu') !== -1 || ed.disabledPipelines.indexOf('newsnab') !== -1)) ? ' checked' : ''}>
                <span class="form-check-label">Disable Usenet Ultimate pipeline</span>
              </label>
              <small class="text-secondary d-block">Skips UU's direct event-title search and NzbDAV playback.</small>
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
          </div>
          </details>

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
  const existingSpec = isUpdate
    ? (opts.existingSpec || customPromotions.findById(opts.updateId))
    : null;

  const sourceRef = String(body.sourceRef || '').trim();
  const selectedDefinition = sourceRef ? metadataSources.find(sourceRef) : null;
  if (sourceRef && !selectedDefinition) throw new Error('Metadata source not found: ' + sourceRef);
  const selectedSource = selectedDefinition ? selectedDefinition.source : null;
  // Legacy custom promotions may use an embedded adapter with no sourceRef.
  // The unified form intentionally has no hidden legacy `source` field, so an
  // edit must inherit the stored adapter instead of silently defaulting to
  // TSDB and demanding a numeric leagueId (notably for embedded MLB sources).
  let source = String(body.source || (existingSpec && existingSpec.source) || 'tsdb').trim();
  if (selectedSource) {
    source = selectedSource.type === 'thesportsdb' ? 'tsdb' : selectedSource.type;
  }

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

  const promotionName = String(body.name || '').trim();
  let learnedAliases = String(body.promotionAliases || '')
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!learnedAliases.length) learnedAliases = promotionAliases.derivePromotionAliases(promotionName, []);
  let relevanceKeywords = String(body.relevanceKeywords || '')
    .split(/,/).map((s) => s.toLowerCase().trim()).filter(Boolean);
  if (!relevanceKeywords.length) relevanceKeywords = learnedAliases.map((s) => s.toLowerCase());
  const enteredExclusions = String(body.exclusionKeywords || '')
    .split(/[\r\n,]+/).map((s) => s.toLowerCase().trim()).filter(Boolean);
  const matchingRules = promotionAliases.sanitizeMatchingRules(
    promotionName, learnedAliases, relevanceKeywords, enteredExclusions
  );

  const spec = {
    id: String(body.id || '').toLowerCase().trim(),
    name: promotionName,
    source,
    sourceRef: sourceRef || undefined,
    poster: String(body.poster || '').trim(),
    fanart: String(body.fanart || '').trim(),
    logo:   String(body.logo   || '').trim(),
    posterShape: String(body.posterShape || 'landscape').trim(),
    searchTitleTemplates: String(body.searchTitleTemplates || '')
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    relevanceKeywords,
    promotionAliases: learnedAliases,
    exclusionKeywords: matchingRules.exclusions,
    teamAliasPreset: teamAliasPreset || undefined,
    teamAliases: teamAliases || undefined,
    leagueAliases: leagueAliases.length ? leagueAliases : undefined,
    // 0.42.0 — pipeline toggles. Falsy → all pipelines active.
    disabledPipelines: [
      body.disablePipelineTorbox === '1'   ? 'torbox'   : null,
      body.disablePipelineUu === '1'       ? 'uu'       : null,
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
    spec.leagueId = String((selectedSource && selectedSource.leagueId) || body.leagueId
      || (existingSpec && existingSpec.leagueId) || '').trim();
  } else if (source === 'football-data') {
    if (selectedSource && selectedSource.teamId) spec.teamId = String(selectedSource.teamId);
    else if (existingSpec && existingSpec.teamId && !selectedSource) spec.teamId = String(existingSpec.teamId);
    else spec.competitionId = String((selectedSource && selectedSource.competitionId) || body.competitionId
      || (existingSpec && existingSpec.competitionId) || '').trim();
  } else if (source === 'tmdb') {
    const ids = selectedSource && (selectedSource.tvIds || [selectedSource.tvId]).filter(Boolean);
    if (ids && ids.length > 1) spec.tvIds = ids.map(String);
    else if (!ids && existingSpec && Array.isArray(existingSpec.tvIds) && existingSpec.tvIds.length > 1) {
      spec.tvIds = existingSpec.tvIds.map(String);
    } else spec.tvId = String((ids && ids[0]) || body.tvId
      || (existingSpec && existingSpec.tvId) || '').trim();
  } else if (source === 'onefc') {
    // The official ONE adapter has no user-entered identifier.
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

  metadataSources.assign(spec.id, sourceRef);

  // Hot-reload the promotion registry so the new entry is available immediately.
  promotions.reload();
  spec.ignoredExclusionKeywords = matchingRules.removedExclusions;
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

function assignSource(promotionId, sourceRef) {
  const id = String(promotionId || '').trim();
  if (!promotions.all.some((promotion) => promotion.id === id)) {
    throw new Error('promotion not found: ' + id);
  }
  metadataSources.assign(id, sourceRef);
  promotions.reload();
  return promotions.all.find((promotion) => promotion.id === id);
}

function defaultSourceDefinition(promotion) {
  const systemRef = metadataSources.SYSTEM_ASSIGNMENTS[promotion.id];
  if (systemRef) return metadataSources.find(systemRef);
  if (promotion.isCustom) {
    const spec = customPromotions.findById(promotion.id);
    if (spec) {
      const embedded = promotions.createGenericPromotion(spec);
      return { id: '', name: 'Embedded source for ' + promotion.name, system: false, source: embedded.source };
    }
  }
  return { id: '', name: 'Embedded source for ' + promotion.name, system: false, source: promotion.source };
}

async function previewSourceChange(promotionId, sourceRef, opts) {
  const id = String(promotionId || '').trim();
  const promotion = promotions.all.find((item) => item.id === id);
  if (!promotion) return { ok: false, error: 'Promotion not found: ' + id };
  const ref = String(sourceRef || '').trim();
  const definition = ref ? metadataSources.find(ref) : defaultSourceDefinition(promotion);
  if (!definition) return { ok: false, error: 'Metadata source not found: ' + ref };
  try {
    const existingEvents = opts && opts.existingEvents ? opts.existingEvents : (store.loadFromDisk().events || []);
    return await metadataSourceDiff.compare(promotion, definition, existingEvents, opts);
  } catch (err) {
    return { ok: false, error: metadataSourceDiff.safeError(err) };
  }
}

function createMetadataSource(body) {
  return metadataSources.add(body || {});
}

function deriveAliases(name, examples, badExamples) {
  const cleanName = String(name || '').trim();
  if (!cleanName) return { ok: false, error: 'Promotion name is required' };
  const result = promotionAliases.suggestPromotionSetup(cleanName, examples, badExamples);
  return {
    ok: true,
    aliases: result.aliases,
    keywords: result.keywords,
    exclusions: result.exclusions,
    removedExclusions: result.removedExclusions,
    searchTitleTemplates: result.searchTitleTemplates,
  };
}

function previewMatching(body) {
  body = body || {};
  const name = String(body.name || '').trim();
  if (!name) return { ok: false, error: 'Promotion name is required' };
  const splitLines = (value) => String(value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const splitTerms = (value) => String(value || '').split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean);
  const spec = {
    id: 'preview',
    name,
    source: 'tsdb',
    leagueId: '1',
    searchTitleTemplates: splitLines(body.searchTitleTemplates).length
      ? splitLines(body.searchTitleTemplates) : ['{name}', '{name} {year}'],
    relevanceKeywords: splitTerms(body.relevanceKeywords),
    promotionAliases: splitLines(body.promotionAliases),
    exclusionKeywords: splitTerms(body.exclusionKeywords),
    requireDateInTitle: body.requireDateInTitle === '1',
  };
  const preview = promotions.createGenericPromotion(spec);
  const event = {
    name: String(body.eventName || '').trim() || name,
    date: String(body.eventDate || '').trim(),
  };
  const classify = (title, expected) => {
    const verdict = preview.isRelevantStreamTitle(title, event);
    return { title, expected, accepted: !!verdict.ok, reason: verdict.ok ? 'matched' : verdict.reason };
  };
  const examples = splitLines(body.goodExamples).map((title) => classify(title, 'accept'))
    .concat(splitLines(body.badExamples).map((title) => classify(title, 'reject')));
  return {
    ok: true,
    event,
    queries: preview.searchTitles(event),
    examples,
    warnings: preview.ignoredExclusionKeywords || [],
  };
}

function sizeLabel(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '';
  if (value >= 1024 * 1024 * 1024) return (value / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  return Math.round(value / (1024 * 1024)) + ' MB';
}

function terms(value) {
  return String(value || '').split(/[,\r\n]+/).map((part) => part.toLowerCase().trim()).filter(Boolean).slice(0, 20);
}

async function searchReleaseExamples(userConfig, input, opts) {
  opts = opts || {};
  input = typeof input === 'string' ? { query: input } : (input || {});
  const queries = String(input.query || '').split(/[;\r\n]+/).map((part) => part.trim().slice(0, 200))
    .filter(Boolean).slice(0, 5);
  if (!queries.length) return { ok: false, error: 'A search query is required' };
  const provider = usenetIndexer.providerConfig(userConfig || {});
  provider.enabled = true;
  if (!provider.url || !provider.apiKey) {
    return { ok: false, error: 'Configure a native Newznab/NZBHydra or Prowlarr search service under Account → DIY Discover first' };
  }
  try {
    const search = opts.search || usenetIndexer.search;
    const result = await search(queries, provider, { maxQueries: 5, timeoutMs: 12000 });
    if (!result.ok) return { ok: false, error: result.error || 'Indexer search failed' };
    const include = terms(input.includeTerms);
    const exclude = terms(input.excludeTerms);
    const quality = String(input.quality || '').toLowerCase().trim();
    const indexerNeedle = String(input.indexerName || '').toLowerCase().trim().slice(0, 100);
    const maxAgeDays = Math.min(3650, Math.max(0, Number(input.maxAgeDays) || 0));
    const minSize = Math.min(1000, Math.max(0, Number(input.minSizeGb) || 0)) * 1024 * 1024 * 1024;
    const maxSize = Math.min(1000, Math.max(0, Number(input.maxSizeGb) || 0)) * 1024 * 1024 * 1024;
    const limit = [20, 40, 80].includes(Number(input.limit)) ? Number(input.limit) : 40;
    const cutoff = maxAgeDays ? Number(opts.now || Date.now()) - maxAgeDays * 86400000 : 0;
    const seen = new Set();
    const rows = [];
    for (const item of result.results || []) {
      const title = String(item.title || '').trim().slice(0, 500);
      const key = title.toLowerCase();
      if (!title || seen.has(key)) continue;
      const indexer = String(item.indexer || provider.name || 'Indexer').slice(0, 100);
      const size = Number(item.size) || 0;
      const publishedMs = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
      if (include.some((term) => !key.includes(term)) || exclude.some((term) => key.includes(term))) continue;
      if (quality && !key.includes(quality)) continue;
      if (indexerNeedle && !indexer.toLowerCase().includes(indexerNeedle)) continue;
      if (minSize && size < minSize) continue;
      if (maxSize && size > maxSize) continue;
      if (cutoff && (!Number.isFinite(publishedMs) || publishedMs < cutoff)) continue;
      seen.add(key);
      rows.push({
        title,
        indexer,
        size,
        publishedMs: Number.isFinite(publishedMs) ? publishedMs : 0,
        sizeLabel: sizeLabel(size),
        publishedAt: item.publishedAt ? String(item.publishedAt).slice(0, 100) : '',
      });
    }
    const sort = String(input.sort || 'relevance');
    if (sort === 'newest') rows.sort((a, b) => b.publishedMs - a.publishedMs);
    else if (sort === 'oldest') rows.sort((a, b) => a.publishedMs - b.publishedMs);
    else if (sort === 'largest') rows.sort((a, b) => b.size - a.size);
    else if (sort === 'smallest') rows.sort((a, b) => a.size - b.size);
    else if (sort === 'title') rows.sort((a, b) => a.title.localeCompare(b.title));
    const total = rows.length;
    const safeRows = rows.slice(0, limit).map(({ publishedMs, size, ...row }) => row);
    return { ok: true, provider: provider.name || (provider.kind === 'prowlarr' ? 'Prowlarr' : 'Newznab'), total, results: safeRows };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  renderBody,
  saveFromForm,
  deleteCustom,
  assignSource,
  createMetadataSource,
  validateLeagueId,
  validateCompetitionId,
  validateTvId,
  deriveAliases,
  previewMatching,
  searchReleaseExamples,
  previewSourceChange,
};
