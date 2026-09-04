// 0.35.0 — Admin /promotions page logic.
//
// Lists all promotions (hardcoded + custom). Custom promotions are editable
// via the in-page form. Hardcoded promotions are shown read-only with a
// badge. Add / Edit form takes a TSDB leagueId plus matching config; the
// validate-leagueid endpoint sanity-checks the ID against TSDB before save.

const customPromotions = require('./custom-promotions');
const promotions = require('./promotions');
const promotionAliases = require('./promotion-aliases');
const promotionOverrides = require('./promotion-overrides');
const metadataSources = require('./metadata-sources');
const metadataSourceDiff = require('./metadata-source-diff');
const metadataPreview = require('./metadata-preview');
const store = require('./store');
const usenetIndexer = require('./sources/usenet-indexer');
const usenetUltimate = require('./sources/usenet-ultimate');
const easynews = require('./sources/easynews');
const companion = require('./sources/companion-scraper');
const settings = require('./settings');
const fetch = require('node-fetch');
const config = require('../config');

// Upper bound on an admin "Preview refresh". Long enough for a multi-season
// TSDB walk or a chunked ESPN window, short enough that a stalled source
// reports failure instead of leaving the panel spinning.
const PREVIEW_TIMEOUT_MS = 60000;
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
  const showWizard = Boolean(editing || opts.create);

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
      : source.type === 'api-football' ? 'competition ' + (source.leagueId || '?')
      : source.type === 'uefa' ? 'official UEFA competition ' + (source.competitionId || '?')
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
        + '<a class="btn btn-sm btn-outline-primary me-1" href="/admin/promotions?edit=' + encodeURIComponent(p.id) + '#promotionWizard">Edit</a>'
        + '<form method="POST" action="/admin/promotions/' + encodeURIComponent(p.id) + '/delete" class="d-inline" onsubmit="return confirm(\'Delete custom promotion &quot;' + escapeHtml(p.name) + '&quot;? Stored events stay in the catalog until the next refresh.\');">'
        +   '<button type="submit" class="btn btn-sm btn-outline-danger">Delete</button>'
        + '</form>'
      : refreshBtn + nuvioBtn
        + '<a class="btn btn-sm btn-outline-primary me-1" href="/admin/promotions/'
        + encodeURIComponent(p.id) + '/research">Improve matching</a>'
        + (p.matchingOverride ? '<span class="badge bg-green-lt">tuned</span>' : '<span class="text-secondary small">shipped rules</span>');
    // 0.90.2 — bulk refresh selector.
    //
    // Deliberately NOT inside a form: the row already contains two of them
    // (per-promotion refresh, change source), and wrapping the table would
    // nest one form inside another — the exact bug that broke the Configure
    // Save button in 0.89.0. The bulk bar collects these by id in script
    // instead, so the markup stays valid.
    const selectCell = p.enabled
      ? '<td class="w-1"><input class="form-check-input m-0 promotion-select" type="checkbox"'
        + ' value="' + escapeHtml(p.id) + '" aria-label="Select ' + escapeHtml(p.name) + ' for refresh"></td>'
      : '<td class="w-1"><input class="form-check-input m-0" type="checkbox" disabled'
        + ' title="Disabled promotions are not refreshed" aria-label="' + escapeHtml(p.name) + ' is disabled"></td>';
    rows += ''
      + '<tr>'
      +   selectCell
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
  const formTitle = isEdit ? 'Edit "' + editing.name + '"' : 'Create a promotion';
  const editingSourceRef = isEdit ? metadataSources.assignmentFor(editing.id) : null;
  let registeredSourceOptions = isEdit && !editingSourceRef
    ? '<option value="" selected>Keep current embedded source</option>'
    : '<option value=""' + (!editingSourceRef ? ' selected' : '') + '>Choose a saved schedule…</option>';
  for (const definition of sourceDefinitions) {
    registeredSourceOptions += '<option value="' + escapeHtml(definition.id) + '"'
      + ' data-source-type="' + escapeHtml(definition.source && definition.source.type || '') + '"'
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
  var researchBtn = document.getElementById('researchAliases');
  var researchOut = document.getElementById('aliasResearchResults');
  var confirmedResearchTitles = [];
  if (!out) return;

  var wizardForm = document.getElementById('promotionWizardForm');
  var wizardPanels = Array.from(document.querySelectorAll('[data-wizard-panel]'));
  var wizardButtons = Array.from(document.querySelectorAll('[data-wizard-go]'));
  var wizardCurrent = 0, wizardReached = 0;
  var sourcePreviewPassed = ${isEdit ? 'true' : 'false'};
  var sourcePreviewButton = document.getElementById('previewWizardSource');
  var sourcePreviewOutput = document.getElementById('wizardSourcePreview');
  var sourceType = document.getElementById('p-source-type');
  var strictDateInput = document.getElementById('p-require-date');
  var strictDateMode = document.getElementById('p-require-date-mode');

  function updateAutomaticDateMatching() {
    if (!strictDateInput || !strictDateMode || strictDateMode.value !== 'auto') return;
    var option = sourceRefSel && sourceRefSel.options[sourceRefSel.selectedIndex];
    strictDateInput.checked = !!(option && (option.dataset.sourceType === 'football-data' || option.dataset.sourceType === 'api-football' || option.dataset.sourceType === 'uefa'));
  }

  function selectedSourceMode() {
    var selected = document.querySelector('input[name="sourceMode"]:checked');
    return selected ? selected.value : 'existing';
  }
  function updateSourceMode() {
    var mode = selectedSourceMode();
    document.querySelectorAll('[data-source-mode]').forEach(function(panel){ panel.hidden = panel.dataset.sourceMode !== mode; });
    sourcePreviewPassed = ${isEdit ? 'true' : 'false'} && mode === 'existing';
    if (sourcePreviewOutput) sourcePreviewOutput.textContent = '';
  }
  function updateSourceProvider() {
    var type = sourceType ? sourceType.value : '';
    document.querySelectorAll('[data-source-provider]').forEach(function(panel){ panel.hidden = panel.dataset.sourceProvider !== type; });
    if (selectedSourceMode() === 'provider') sourcePreviewPassed = false;
  }
  document.querySelectorAll('input[name="sourceMode"]').forEach(function(radio){ radio.addEventListener('change', updateSourceMode); });
  if (sourceType) sourceType.addEventListener('change', updateSourceProvider);
  if (wizardForm) wizardForm.querySelectorAll('[data-source-mode] input,[data-source-mode] select').forEach(function(input){ input.addEventListener('input', function(){ sourcePreviewPassed=false; }); });
  if (sourceRefSel) sourceRefSel.addEventListener('change', updateAutomaticDateMatching);
  if (strictDateInput) strictDateInput.addEventListener('change', function(){ if(strictDateMode) strictDateMode.value='explicit'; });
  updateSourceMode(); updateSourceProvider(); updateAutomaticDateMatching();

  function showWizardStep(index) {
    wizardCurrent = Math.max(0, Math.min(wizardPanels.length - 1, index));
    wizardPanels.forEach(function(panel, i){ panel.hidden = i !== wizardCurrent; });
    wizardButtons.forEach(function(button, i){
      button.classList.toggle('active', i === wizardCurrent);
      button.classList.toggle('done', i < wizardCurrent || i < wizardReached);
      button.disabled = i > wizardReached;
    });
    if (wizardCurrent === 4) updateWizardReview();
    var wizard = document.getElementById('promotionWizard');
    if (wizard) wizard.scrollIntoView({behavior:'smooth',block:'start'});
  }
  function fieldValid(id, message) {
    var field=document.getElementById(id); if(!field || field.checkValidity()) return true;
    setVerdict('rej', message); field.reportValidity(); field.focus(); return false;
  }
  function validateWizardStep(index) {
    if (index === 0) return fieldValid('p-name','Enter the promotion name.') && fieldValid('p-id','Check the generated internal ID.');
    if (index === 1) {
      var mode=selectedSourceMode();
      if(mode==='existing' && !(sourceRefSel && sourceRefSel.value) && !EDITING_ID){setVerdict('rej','Choose a saved schedule, or select Provider ID or Official website.');return false;}
      if(!sourcePreviewPassed){setVerdict('rej','Test the schedule and confirm that it returns the right events before continuing.');sourcePreviewButton&&sourcePreviewButton.focus();return false;}
    }
    return true;
  }
  document.querySelectorAll('[data-wizard-next]').forEach(function(button){button.addEventListener('click',function(){
    if(!validateWizardStep(wizardCurrent))return; wizardReached=Math.max(wizardReached,wizardCurrent+1); showWizardStep(wizardCurrent+1);
  });});
  document.querySelectorAll('[data-wizard-prev]').forEach(function(button){button.addEventListener('click',function(){showWizardStep(wizardCurrent-1);});});
  wizardButtons.forEach(function(button){button.addEventListener('click',function(){var target=Number(button.dataset.wizardGo);if(target<=wizardReached)showWizardStep(target);});});

  function previewLine(parent, text, cls) { var el=document.createElement('div');el.className=cls||'';el.textContent=text;parent.appendChild(el); }
  if (sourcePreviewButton && wizardForm) sourcePreviewButton.addEventListener('click', async function(){
    sourcePreviewButton.disabled=true; sourcePreviewButton.textContent='Testing schedule…'; sourcePreviewOutput.textContent='';
    previewLine(sourcePreviewOutput,'Connecting without changing your catalog…','alert alert-info');
    try{
      var response=await fetch('/admin/promotions/source-preview',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(new FormData(wizardForm))});
      var result=await response.json(); sourcePreviewOutput.textContent='';
      if(!response.ok||!result.ok)throw new Error(result.error||'Schedule test failed');
      sourcePreviewPassed=true; var box=document.createElement('div');box.className='alert alert-success';sourcePreviewOutput.appendChild(box);
      previewLine(box,'Connected to '+result.source.name+' · '+result.normalized+' event(s) recognised','fw-semibold');
      var events=document.createElement('div');events.className='wizard-source-events';box.appendChild(events);
      (result.events||[]).slice(0,6).forEach(function(event){previewLine(events,(event.date||'No date')+' · '+event.name);});
      var first=(result.events||[])[0]; if(first){var eventInput=document.getElementById('p-preview-event'),dateInput=document.getElementById('p-preview-date');if(eventInput&&!eventInput.value)eventInput.value=first.name||'';if(dateInput&&!dateInput.value)dateInput.value=first.date||'';}
      setVerdict('ok','Schedule confirmed. Continue when the sample events look correct.');
    }catch(error){sourcePreviewPassed=false;sourcePreviewOutput.textContent='';previewLine(sourcePreviewOutput,error.message,'alert alert-danger');setVerdict('err',error.message);}
    finally{sourcePreviewButton.disabled=false;sourcePreviewButton.textContent='Test schedule and show events';}
  });

  function updateWizardReview(){
    var value=function(id){var el=document.getElementById(id);return el?(el.value||'').trim():'';};
    var promo=document.getElementById('reviewPromotion'),source=document.getElementById('reviewSource'),examples=document.getElementById('reviewExamples'),art=document.getElementById('reviewArtwork');
    if(promo)promo.textContent=value('p-name')||'Not named';
    if(source){var mode=selectedSourceMode(),label='';if(mode==='existing')label=sourceRefSel&&sourceRefSel.options[sourceRefSel.selectedIndex]?sourceRefSel.options[sourceRefSel.selectedIndex].text:'Saved schedule';else if(mode==='website')label=value('p-source-url')||'Official website';else label=sourceType&&sourceType.options[sourceType.selectedIndex]?sourceType.options[sourceType.selectedIndex].text:'Provider ID';source.textContent=label;}
    if(examples){var count=(aliasExamples&&aliasExamples.value||'').split(/\\r?\\n/).map(function(v){return v.trim();}).filter(Boolean).length;examples.textContent=count?count+' known-good title'+(count===1?'':'s'):'None added — safe defaults will be used';}
    if(art){var selected=[value('p-poster')&&'poster',value('p-fanart')&&'background',value('p-logo')&&'logo'].filter(Boolean);art.textContent=selected.length?selected.join(', '):'Default artwork';}
  }
  if (wizardForm) wizardForm.addEventListener('submit',function(event){var identityOk=validateWizardStep(0);var sourceOk=identityOk&&validateWizardStep(1);if(!identityOk||!sourceOk){event.preventDefault();showWizardStep(identityOk?1:0);}});
  showWizardStep(0);

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

  function addRejectedTitle(title) {
    if (!badExamples) return;
    var rows = (badExamples.value || '').split(/\\r?\\n/).map(function(v){return v.trim();}).filter(Boolean);
    if (rows.indexOf(title) === -1) rows.push(title);
    badExamples.value = rows.join('\\n');
  }

  function researchBody() {
    var value=function(id){var el=document.getElementById(id);return el?el.value||'':'';};
    var body=new URLSearchParams();
    body.append('name',value('p-name'));body.append('eventName',value('p-preview-event'));body.append('eventDate',value('p-preview-date'));
    body.append('query',value('p-indexer-query'));body.append('promotionAliases',value('p-promotion-aliases'));
    body.append('exclusionKeywords',value('p-exclusions'));body.append('relevanceKeywords',value('p-keywords'));body.append('searchTitleTemplates',value('p-templates'));
    if(strictDateInput&&strictDateInput.checked)body.append('requireDateInTitle','1');
    var foreign=document.querySelector('input[name="allowForeignLanguage"]');if(foreign&&foreign.checked)body.append('allowForeignLanguage','1');
    return body;
  }

  function researchRow(parent,item,group){
    var row=document.createElement('div');row.className='alias-research-row';
    var action=document.createElement('button');action.type='button';action.className='btn btn-sm '+(group==='rejected'?'btn-outline-danger':'btn-outline-success');action.textContent=group==='rejected'?'Mark unrelated':'Confirm release';
    action.addEventListener('click',function(){if(group==='rejected')addRejectedTitle(item.title);else{addReleaseTitle(item.title);if(confirmedResearchTitles.indexOf(item.title)===-1)confirmedResearchTitles.push(item.title);}action.disabled=true;action.textContent='Confirmed';});
    var copy=document.createElement('div');copy.className='min-w-0';var title=document.createElement('div');title.className='text-mono small text-break';title.textContent=item.title;copy.appendChild(title);
    var detail=document.createElement('div');detail.className='text-secondary small';detail.textContent=[(item.providers||[]).join(' + '),item.indexer,item.sizeLabel,item.publishedAt,item.reason].filter(Boolean).join(' · ');copy.appendChild(detail);
    row.appendChild(action);row.appendChild(copy);parent.appendChild(row);
  }

  if(researchBtn)researchBtn.addEventListener('click',async function(){
    var eventName=document.getElementById('p-preview-event');if(!eventName||(eventName.value||'').trim()===''){setVerdict('rej','Choose one sample event from the tested schedule first.');eventName&&eventName.focus();return;}
    researchBtn.disabled=true;researchBtn.textContent='Researching configured sources…';confirmedResearchTitles=[];if(researchOut)researchOut.textContent='Running broad and exact searches. Slow federated indexers may take up to 45 seconds.';
    try{
      var res=await fetch('/admin/promotions/alias-research',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:researchBody()});var json=await res.json();if(!res.ok||!json.ok)throw new Error(json.error||'Alias research failed');if(!researchOut)return;researchOut.textContent='';
      var summary=document.createElement('div');summary.className='alert alert-info';summary.textContent=json.counts.discovered+' discovered · '+json.counts.matched+' matched · '+json.counts.possible+' need review · '+json.counts.rejected+' rejected';researchOut.appendChild(summary);
      var providerLine=document.createElement('div');providerLine.className='d-flex flex-wrap gap-2 mb-3';(json.providers||[]).forEach(function(provider){var badge=document.createElement('span');badge.className='badge '+(provider.ok?'bg-green-lt':'bg-red-lt');badge.textContent=provider.name+' · '+(provider.ok?provider.count+' found':provider.error);providerLine.appendChild(badge);});researchOut.appendChild(providerLine);
      var queryDetails=document.createElement('details');queryDetails.className='mb-3';var querySummary=document.createElement('summary');querySummary.className='text-secondary small';querySummary.textContent='Searches used ('+(json.queries||[]).length+')';queryDetails.appendChild(querySummary);(json.queries||[]).forEach(function(query){var line=document.createElement('div');line.className='text-mono small text-secondary ms-3';line.textContent=query;queryDetails.appendChild(line);});researchOut.appendChild(queryDetails);
      var suggested=json.suggested||{};if((json.groups.matched||[]).length){var useAll=document.createElement('button');useAll.type='button';useAll.className='btn btn-primary btn-sm mb-3 me-2';useAll.textContent='Use matched titles and suggestions';useAll.addEventListener('click',function(){(json.groups.matched||[]).forEach(function(item){addReleaseTitle(item.title);});if(aliasOut&&(suggested.aliases||[]).length)aliasOut.value=suggested.aliases.join('\\n');if(keywordInp&&(suggested.keywords||[]).length)keywordInp.value=suggested.keywords.join(', ');if(exclusionOut&&(suggested.exclusions||[]).length)exclusionOut.value=suggested.exclusions.join(', ');if(templateOut&&(suggested.searchTitleTemplates||[]).length)templateOut.value=suggested.searchTitleTemplates.join('\\n');var learned=document.getElementById('learnedMatching');if(learned)learned.open=true;useAll.disabled=true;useAll.textContent='Applied';});researchOut.appendChild(useAll);}
      [['matched','Matched automatically'],['possible','Needs your review'],['rejected','Rejected by current rules']].forEach(function(entry){var rows=(json.groups&&json.groups[entry[0]])||[];if(!rows.length)return;var section=document.createElement('details');section.className='alias-research-group mb-2';if(entry[0]!=='rejected')section.open=true;var heading=document.createElement('summary');heading.textContent=entry[1]+' ('+rows.length+')';section.appendChild(heading);rows.forEach(function(item){researchRow(section,item,entry[0]);});researchOut.appendChild(section);});
      var actions=document.createElement('div');actions.className='d-flex flex-wrap gap-2 mt-3';var build=document.createElement('button');build.type='button';build.className='btn btn-success btn-sm';build.textContent='Build rules from confirmed releases';build.addEventListener('click',function(){if(!confirmedResearchTitles.length){build.textContent='Confirm at least one release first';return;}if(aliasBtn)aliasBtn.click();build.disabled=true;build.textContent='Matching rules created';});actions.appendChild(build);
      if(json.report){var copy=document.createElement('button');copy.type='button';copy.className='btn btn-outline-secondary btn-sm';copy.textContent='Copy safe research report';copy.addEventListener('click',async function(){try{await navigator.clipboard.writeText(json.report);copy.textContent='Report copied';}catch(_){var area=document.createElement('textarea');area.value=json.report;area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();document.execCommand('copy');area.remove();copy.textContent='Report copied';}});actions.appendChild(copy);}researchOut.appendChild(actions);
      if(json.report){var reportDetails=document.createElement('details');reportDetails.className='mt-3';var reportSummary=document.createElement('summary');reportSummary.className='text-secondary small';reportSummary.textContent='Preview safe research report';reportDetails.appendChild(reportSummary);var reportArea=document.createElement('textarea');reportArea.className='form-control text-mono small mt-2';reportArea.rows=12;reportArea.readOnly=true;reportArea.value=json.report;reportDetails.appendChild(reportArea);researchOut.appendChild(reportDetails);}
    }catch(error){if(researchOut){researchOut.textContent='';var alert=document.createElement('div');alert.className='alert alert-danger';alert.textContent=error.message;researchOut.appendChild(alert);}}
    finally{researchBtn.disabled=false;researchBtn.textContent='Research configured sources';}
  });

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
    finally { aliasBtn.disabled = false; aliasBtn.textContent = 'Create matching rules'; }
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
    <style>
      .promotion-wizard{max-width:980px;margin:0 auto 2rem}.wizard-steps{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:22px}.wizard-step-button{border:1px solid var(--tblr-border-color);background:rgba(255,255,255,.018);border-radius:11px;padding:11px 8px;color:var(--tblr-secondary);font-size:.75rem;text-align:left}.wizard-step-button strong{display:block;color:inherit;font-size:.86rem}.wizard-step-button.active{border-color:var(--tblr-primary);background:rgba(var(--tblr-primary-rgb),.09);color:var(--tblr-body-color)}.wizard-step-button.done{color:var(--tblr-success)}.wizard-panel[hidden]{display:none!important}.wizard-kicker{color:var(--tblr-primary);font-size:.7rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.source-paths{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.source-path{display:block;border:1px solid var(--tblr-border-color);border-radius:12px;padding:15px;cursor:pointer;background:rgba(255,255,255,.018)}.source-path:has(input:checked){border-color:var(--tblr-primary);box-shadow:0 0 0 1px var(--tblr-primary);background:rgba(var(--tblr-primary-rgb),.08)}.source-path input{margin-right:7px}.source-path strong{display:block;margin-bottom:5px}.source-config{border:1px solid var(--tblr-border-color);border-radius:12px;padding:16px;margin-top:14px}.wizard-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:18px;border-top:1px solid var(--tblr-border-color);margin-top:18px}.wizard-summary{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.wizard-summary>div{border:1px solid var(--tblr-border-color);border-radius:11px;padding:14px}.wizard-summary span{display:block;color:var(--tblr-secondary);font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}.wizard-source-events{display:grid;grid-template-columns:repeat(2,1fr);gap:7px;margin-top:10px}.wizard-source-events div{border:1px solid var(--tblr-border-color);border-radius:8px;padding:9px;font-size:.78rem}.advanced-stack details{border:1px solid var(--tblr-border-color);border-radius:11px;margin-top:10px}.advanced-stack summary{cursor:pointer;padding:13px 15px;font-weight:600}.advanced-stack details>div{padding:0 15px 15px}@media(max-width:760px){.wizard-steps{grid-template-columns:1fr 1fr}.source-paths,.wizard-summary,.wizard-source-events{grid-template-columns:1fr}.wizard-step-button{min-height:58px}}
      .alias-research-group{border:1px solid var(--tblr-border-color);border-radius:10px;padding:10px 12px}.alias-research-group summary{cursor:pointer;font-weight:600}.alias-research-row{display:flex;align-items:flex-start;gap:10px;border-top:1px solid var(--tblr-border-color);padding:10px 0}.alias-research-row:first-of-type{margin-top:8px}
    </style>
    <div class="page-header">
      <div class="row align-items-center g-3">
        <div class="col">
          <h2 class="page-title">Promotions</h2>
          <div class="text-secondary mt-1">Build sports catalogs from an event schedule and a few real release examples. SSS handles the technical matching rules.</div>
        </div>
        <div class="col-auto"><a class="btn btn-primary" href="/admin/promotions?create=1#promotionWizard">Create promotion</a></div>
      </div>
    </div>
    ${flashHtml}

    <div class="card mb-4">
      <div class="card-body border-bottom py-2 d-flex flex-wrap align-items-center gap-2">
        <form method="POST" action="/admin/promotions/refresh-selected" id="bulkRefreshForm" class="d-flex align-items-center gap-2 m-0">
          <input type="hidden" name="promotionIds" id="bulkRefreshIds" value="">
          <button class="btn btn-sm btn-outline-info" type="submit" id="bulkRefreshButton" disabled>Refresh selected</button>
        </form>
        <span class="text-secondary small" id="bulkRefreshCount">No promotions selected</span>
        <span class="text-secondary small ms-auto">Refreshes run one after another in the background. Promotions you do not tick are left untouched.</span>
      </div>
      <div class="table-responsive">
        <table class="table table-vcenter card-table">
          <thead><tr><th class="w-1"><input class="form-check-input m-0" type="checkbox" id="promotionSelectAll" aria-label="Select every enabled promotion"></th><th>Kind</th><th>Name</th><th>Metadata source</th><th>Poster</th><th>Catalogs</th><th class="w-1"></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
    <script>(function(){
      var boxes=Array.prototype.slice.call(document.querySelectorAll('.promotion-select'));
      var all=document.getElementById('promotionSelectAll');
      var button=document.getElementById('bulkRefreshButton');
      var ids=document.getElementById('bulkRefreshIds');
      var count=document.getElementById('bulkRefreshCount');
      if(!boxes.length||!button||!ids||!count)return;
      function sync(){
        var picked=boxes.filter(function(box){return box.checked;}).map(function(box){return box.value;});
        ids.value=picked.join(',');
        button.disabled=picked.length===0;
        count.textContent=picked.length?(picked.length+' selected'):'No promotions selected';
        if(all){all.checked=picked.length===boxes.length;all.indeterminate=picked.length>0&&picked.length<boxes.length;}
      }
      boxes.forEach(function(box){box.addEventListener('change',sync);});
      if(all)all.addEventListener('change',function(){boxes.forEach(function(box){box.checked=all.checked;});sync();});
      sync();
    })();</script>

    <div class="card mb-3 promotion-wizard" id="promotionWizard"${showWizard ? '' : ' hidden'}>
      <div class="card-header"><div><div class="wizard-kicker">Guided setup</div><h3 class="card-title mt-1">${escapeHtml(formTitle)}</h3><div class="text-secondary small mt-1">Five short steps. You can review everything before it is saved.</div></div></div>
      <div class="card-body">
        <form method="POST" action="${escapeHtml(formAction)}" id="promotionWizardForm">
          <nav class="wizard-steps" aria-label="Promotion setup progress">
            <button class="wizard-step-button active" type="button" data-wizard-go="0"><span>1</span><strong>Name</strong></button>
            <button class="wizard-step-button" type="button" data-wizard-go="1"><span>2</span><strong>Schedule</strong></button>
            <button class="wizard-step-button" type="button" data-wizard-go="2"><span>3</span><strong>Releases</strong></button>
            <button class="wizard-step-button" type="button" data-wizard-go="3"><span>4</span><strong>Appearance</strong></button>
            <button class="wizard-step-button" type="button" data-wizard-go="4"><span>5</span><strong>Review</strong></button>
          </nav>
          <div id="validateOut" class="mb-3" aria-live="polite"></div>

          <section class="wizard-panel" data-wizard-panel="0">
          <div class="wizard-kicker">Step 1 of 5</div><h3 class="mt-1 mb-2">What should users see?</h3>
          <p class="text-secondary">Enter the promotion or competition name. SSS creates the internal ID automatically.</p>
          <div class="row g-3">
            <div class="col-md-4">
              <label class="form-label" for="p-id">Internal ID</label>
              <input class="form-control text-mono" id="p-id" type="text" name="id" value="${escapeHtml(ed.id || '')}" placeholder="nfl" required pattern="[a-z0-9_-]{2,30}" ${isEdit ? 'readonly' : ''}>
              ${isEdit ? '<small class="text-secondary">ID cannot be changed after creation (would orphan stored events).</small>' : ''}
            </div>
            <div class="col-md-8">
              <label class="form-label" for="p-name">Promotion name</label>
              <input class="form-control" id="p-name" type="text" name="name" value="${escapeHtml(ed.name || '')}" placeholder="NFL" required maxlength="64">
            </div>
          </div>
          <div class="wizard-footer"><a class="btn btn-outline-secondary" href="/admin/promotions">Cancel</a><button class="btn btn-primary" type="button" data-wizard-next>Choose schedule</button></div>
          </section>

          <section class="wizard-panel" data-wizard-panel="1" hidden>
          <div class="wizard-kicker">Step 2 of 5</div><h3 class="mt-1 mb-2">Where do event names and dates come from?</h3>
          <p class="text-secondary">Choose a tested provider from Metadata. Promotions decide how events are presented and matched; Metadata owns where schedules come from.</p>
          <input type="hidden" name="sourceMode" value="existing">
          <div class="source-config" data-source-mode="existing">
            <div class="d-flex align-items-start justify-content-between gap-3 mb-2"><div><label class="form-label mb-1" for="p-source-ref">Saved event provider</label><div class="text-secondary small">Includes shipped adapters and providers created by you.</div></div><a class="btn btn-outline-primary btn-sm" href="/admin/metadata?create=1#providerCreator" target="_blank" rel="noopener">Create provider in Metadata</a></div>
            <select class="form-select" id="p-source-ref" name="sourceRef">${registeredSourceOptions}</select>
            <div class="form-hint">Created a provider in the other tab? Reload Promotions and it will appear here.</div>
          </div>
          <button class="btn btn-outline-info mt-3" id="previewWizardSource" type="button">Test schedule and show events</button>
          <div id="wizardSourcePreview" class="mt-3" aria-live="polite"></div>

          <div class="wizard-footer"><button class="btn btn-outline-secondary" type="button" data-wizard-prev>Back</button><button class="btn btn-primary" type="button" data-wizard-next>Use this schedule</button></div>
          </section>

          <section class="wizard-panel" data-wizard-panel="2" hidden>
          <div class="wizard-kicker">Step 3 of 5</div><h3 class="mt-1 mb-2">Show SSS how releases are named</h3>
          <p class="text-secondary">Paste a few real titles that belong to this promotion. SSS will derive aliases and search patterns for you.</p>
          <div class="card bg-dark-lt mb-3">
            <div class="card-body">
              <h4 class="mb-1">Add real release titles <span class="badge bg-green-lt ms-2">optional</span></h4>
              <p class="text-secondary small">A few examples teach SSS the abbreviations, date layout, and event wording people actually upload. If you have none, safe defaults are created from the promotion name.</p>
              <div class="card border-info mb-3"><div class="card-body">
                <div class="d-flex flex-wrap align-items-start justify-content-between gap-3 mb-3"><div><h4 class="mb-1">Alias Research</h4><div class="text-secondary small">SSS runs broad, rule-independent searches as well as exact promotion searches across Companion and your configured services. Confirm genuine releases and SSS will build the aliases and patterns. A safe report can be copied for troubleshooting; credentials, hashes, and download links never leave the server.</div></div><span class="badge bg-blue-lt">admin only</span></div>
                <div class="row g-2"><div class="col-md-8"><label class="form-label" for="p-preview-event">Sample event from the schedule</label><input class="form-control" id="p-preview-event" placeholder="Chicago Cubs vs Arizona Diamondbacks"></div><div class="col-md-4"><label class="form-label" for="p-preview-date">Event date</label><input class="form-control" id="p-preview-date" type="date"></div></div>
                <button class="btn btn-info mt-3" type="button" id="researchAliases">Research configured sources</button>
                <div class="mt-3" id="aliasResearchResults" aria-live="polite"></div>
              </div></div>
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
              <button class="btn btn-outline-primary mt-3" type="button" id="deriveAliases">Create matching rules</button>
              <details class="mt-3" id="learnedMatching"><summary class="text-secondary">Review what SSS learned</summary><div class="row g-3 mt-1">
                <div class="col-md-6"><label class="form-label" for="p-promotion-aliases">Names releases use for this promotion</label><textarea class="form-control text-mono" id="p-promotion-aliases" name="promotionAliases" rows="3" placeholder="Major League Baseball&#10;MLB">${escapeHtml(promotionAliasLines)}</textarea></div>
                <div class="col-md-6"><label class="form-label" for="p-exclusions">Words that reject a result</label><input class="form-control text-mono" id="p-exclusions" name="exclusionKeywords" value="${escapeHtml(exclusionStr)}" placeholder="network, daily show"><small class="text-secondary">A word that conflicts with the promotion name or an alias is ignored automatically.</small></div>
                <div class="col-12"><label class="form-label" for="p-keywords">Recognition terms override</label><input class="form-control text-mono" id="p-keywords" type="text" name="relevanceKeywords" value="${escapeHtml(keywordsStr)}" placeholder="Generated automatically if left blank"><small class="text-secondary">Usually leave this blank. It exists for unusual release naming.</small></div>
              </div></details>
              <details class="mt-3"><summary class="text-secondary">Test the current rules again</summary><button class="btn btn-outline-info mt-2" type="button" id="previewMatching">Test these examples</button><div class="mt-3" id="matchingPreview"></div></details>
            </div>
          </div>

          <div class="wizard-footer"><button class="btn btn-outline-secondary" type="button" data-wizard-prev>Back</button><button class="btn btn-primary" type="button" data-wizard-next>Choose appearance</button></div>
          </section>

          <section class="wizard-panel" data-wizard-panel="3" hidden>
          <div class="wizard-kicker">Step 4 of 5</div><h3 class="mt-1 mb-2">How should it look?</h3>
          <p class="text-secondary">Artwork is optional. You can also choose collection artwork after creation in Nuvio Collections.</p>
          <div class="row g-3">
            <div class="col-md-6"><label class="form-label" for="p-poster">Poster URL</label><input class="form-control text-mono" id="p-poster" type="url" name="poster" value="${escapeHtml(ed.poster || '')}" placeholder="https://..."></div>
            <div class="col-md-6"><label class="form-label" for="p-fanart">Background URL</label><input class="form-control text-mono" id="p-fanart" type="url" name="fanart" value="${escapeHtml(ed.fanart || '')}" placeholder="https://..."></div>
            <div class="col-md-6"><label class="form-label" for="p-logo">Logo URL</label><input class="form-control text-mono" id="p-logo" type="url" name="logo" value="${escapeHtml(ed.logo || '')}" placeholder="https://..."></div>
            <div class="col-md-6"><label class="form-label" for="p-shape">Poster shape</label><select class="form-select" id="p-shape" name="posterShape"><option value="landscape"${ed.posterShape === 'landscape' || !ed.posterShape ? ' selected' : ''}>landscape</option><option value="square"${ed.posterShape === 'square' ? ' selected' : ''}>square</option><option value="poster"${ed.posterShape === 'poster' ? ' selected' : ''}>portrait poster</option></select></div>
          </div>
          <div class="wizard-footer"><button class="btn btn-outline-secondary" type="button" data-wizard-prev>Back</button><button class="btn btn-primary" type="button" data-wizard-next>Review promotion</button></div>
          </section>

          <section class="wizard-panel" data-wizard-panel="4" hidden>
          <div class="wizard-kicker">Step 5 of 5</div><h3 class="mt-1 mb-2">Review and create</h3>
          <p class="text-secondary">Check the plain-language summary. Advanced controls are available below but are not required.</p>
          <div class="wizard-summary mb-3"><div><span>Promotion</span><strong id="reviewPromotion">—</strong></div><div><span>Event schedule</span><strong id="reviewSource">—</strong></div><div><span>Release examples</span><strong id="reviewExamples">None added — safe defaults will be used</strong></div><div><span>Artwork</span><strong id="reviewArtwork">Default artwork</strong></div></div>
          <div class="alert alert-success"><strong>What happens next</strong><div class="small mt-1">SSS saves the promotion and its reusable schedule, then opens Nuvio Collections so you can choose its folder and collection image. Return here to preview and refresh its events.</div></div>

          <div class="advanced-stack"><details>
          <summary>Advanced search patterns <span class="text-secondary fw-normal">— optional</span></summary>
          <div><label class="form-label" for="p-templates">Search title patterns</label><textarea class="form-control text-mono" id="p-templates" name="searchTitleTemplates" rows="4" required>${escapeHtml(tplLines)}</textarea><small class="text-secondary">Usually learned from the release examples. Available placeholders: <code>{promotion}</code>, <code>{name}</code>, <code>{year}</code>, <code>{date}</code>, <code>{date_spaced}</code>, <code>{date_dotted}</code>.</small></div>
          </details></div>

          <div class="advanced-stack"><details>
          <summary>Football aliases, pipeline controls, and date matching <span class="text-secondary fw-normal">— optional</span></summary>
          <div>
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
            <input type="hidden" id="p-require-date-mode" name="requireDateMode" value="${isEdit ? 'explicit' : 'auto'}">
            <label class="form-check">
              <input class="form-check-input" id="p-require-date" type="checkbox" name="requireDateInTitle" value="1"${((typeof ed.requireDateInTitle === 'boolean') ? ed.requireDateInTitle : (ed.source === 'football-data')) ? ' checked' : ''}>
              <span class="form-check-label">Require date in release title (exact-day match)</span>
            </label>
            <small class="text-secondary d-block">Football-data.org sources default to ON. TSDB sources default to OFF. This checkbox overrides the source default.</small>
          </div>
          <div class="mb-3">
            <label class="form-check">
              <input class="form-check-input" type="checkbox" name="allowForeignLanguage" value="1"${ed.allowForeignLanguage ? ' checked' : ''}>
              <span class="form-check-label">Include non-English releases</span>
            </label>
            <small class="text-secondary d-block">Off by default. Enable when Spanish, French, German, or other language coverage is useful for this promotion.</small>
          </div>
          </div>
          </details></div>

          <div class="wizard-footer">
            <button class="btn btn-outline-secondary" type="button" data-wizard-prev>Back</button>
            <div class="d-flex gap-2">
            <button class="btn btn-primary" type="submit">${isEdit ? 'Save changes' : 'Create promotion'}</button>
            ${isEdit ? '<a class="btn btn-outline-secondary" href="/admin/promotions">Cancel</a>' : ''}
            </div>
          </div>
          </section>
        </form>
      </div>
    </div>
    ${validateJs}
  `;

  return body;
}

function renderMatchingLab(promotionId, opts) {
  opts = opts || {};
  const promotion = promotions.all.find((item) => item.id === promotionId);
  if (!promotion || promotion.isCustom) return null;
  const saved = promotionOverrides.find(promotion.id) || {};
  const defaultRequireDate = ['football-data', 'api-football', 'uefa']
    .includes(String(promotion.source && promotion.source.type || ''));
  const events = store.getEvents().filter((event) => {
    const owner = promotions.getByEventId(event.id);
    return owner && owner.id === promotion.id;
  }).sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 100);
  const eventOptions = events.map((event, index) => '<option value="' + index + '" data-name="'
    + escapeHtml(event.name || '') + '" data-date="' + escapeHtml(event.date || '') + '">'
    + escapeHtml((event.date || 'No date') + ' · ' + (event.name || event.id)) + '</option>').join('');
  const value = (items, separator) => escapeHtml(Array.isArray(items) ? items.join(separator) : '');
  const flash = opts.flash ? '<div class="alert alert-info">' + escapeHtml(opts.flash) + '</div>' : '';
  const savedBadge = saved.promotionId ? '<span class="badge bg-green-lt ms-2">saved override active</span>' : '';
  return `
    <div class="page-header"><div class="row align-items-center g-3"><div class="col"><h2 class="page-title">Improve ${escapeHtml(promotion.name)}</h2><div class="text-secondary mt-1">Research real release names and extend the shipped matching logic without replacing its specialist event handling.</div></div><div class="col-auto"><a class="btn btn-outline-secondary" href="/admin/promotions">Back to promotions</a></div></div></div>
    ${flash}
    <div class="card mb-3"><div class="card-header"><h3 class="card-title">Matching Lab ${savedBadge}</h3></div><div class="card-body">
      <form method="POST" action="/admin/promotions/${encodeURIComponent(promotion.id)}/matching-override" id="matchingLabForm">
        <input type="hidden" name="name" id="lab-name" value="${escapeHtml(promotion.name)}">
        <div class="row g-3"><div class="col-md-8"><label class="form-label">Sample catalog event</label><select class="form-select" id="lab-event-select">${eventOptions || '<option value="">No stored events — enter one below</option>'}</select></div><div class="col-md-4"><label class="form-label">Event date</label><input class="form-control" type="date" id="lab-event-date"></div></div>
        <div class="mt-3"><label class="form-label">Event name</label><input class="form-control" id="lab-event-name" placeholder="Enter an event exactly as it appears in the catalog"></div>
        <div class="mt-3 d-flex flex-wrap gap-2"><button class="btn btn-info" type="button" id="lab-research">Research configured sources</button><button class="btn btn-outline-primary" type="button" id="lab-generate">Create rules from confirmed titles</button></div>
        <div class="mt-3" id="lab-results" aria-live="polite"></div>
        <hr class="my-4"><div class="row g-3"><div class="col-md-6"><label class="form-label">Confirmed release titles</label><textarea class="form-control text-mono" rows="6" id="lab-good"></textarea></div><div class="col-md-6"><label class="form-label">Confirmed unrelated titles</label><textarea class="form-control text-mono" rows="6" id="lab-bad"></textarea></div></div>
        <div class="row g-3 mt-1"><div class="col-md-6"><label class="form-label">Promotion aliases</label><textarea class="form-control text-mono" rows="5" id="lab-aliases" name="promotionAliases">${value(saved.promotionAliases, '\n')}</textarea></div><div class="col-md-6"><label class="form-label">Recognition keywords</label><textarea class="form-control text-mono" rows="5" id="lab-keywords" name="relevanceKeywords">${value(saved.relevanceKeywords, ', ')}</textarea></div><div class="col-md-6"><label class="form-label">Search patterns</label><textarea class="form-control text-mono" rows="5" id="lab-templates" name="searchTitleTemplates">${value(saved.searchTitleTemplates, '\n')}</textarea></div><div class="col-md-6"><label class="form-label">Reject words</label><textarea class="form-control text-mono" rows="5" id="lab-exclusions" name="exclusionKeywords">${value(saved.exclusionKeywords, ', ')}</textarea></div></div>
        <div class="row g-3 mt-1"><div class="col-md-6"><label class="form-check"><input class="form-check-input" type="checkbox" id="lab-date" name="requireDateInTitle" value="1"${(saved.promotionId ? saved.requireDateInTitle : defaultRequireDate) ? ' checked' : ''}><span class="form-check-label">Require the fixture date</span></label></div><div class="col-md-6"><label class="form-check"><input class="form-check-input" type="checkbox" id="lab-foreign" name="allowForeignLanguage" value="1"${saved.allowForeignLanguage ? ' checked' : ''}><span class="form-check-label">Allow non-English releases</span></label></div></div>
        <div class="d-flex flex-wrap gap-2 mt-4"><button class="btn btn-primary" type="submit">Save matching override</button>${saved.promotionId ? '<button class="btn btn-outline-danger" type="submit" formaction="/admin/promotions/' + encodeURIComponent(promotion.id) + '/matching-override/reset" onclick="return confirm(\'Restore the shipped matching rules?\')">Restore shipped rules</button>' : ''}</div>
      </form>
    </div></div>
    <script>(function(){
      var select=document.getElementById('lab-event-select'),name=document.getElementById('lab-event-name'),date=document.getElementById('lab-event-date'),results=document.getElementById('lab-results');
      function useEvent(){var option=select&&select.options[select.selectedIndex];if(!option)return;if(option.dataset.name)name.value=option.dataset.name;if(option.dataset.date)date.value=option.dataset.date;}if(select){select.addEventListener('change',useEvent);useEvent();}
      function append(id,title){var area=document.getElementById(id),rows=(area.value||'').split(/\\r?\\n/).map(function(v){return v.trim();}).filter(Boolean);if(rows.indexOf(title)===-1)rows.push(title);area.value=rows.join('\\n');}
      function researchBody(){var body=new URLSearchParams();body.append('name',document.getElementById('lab-name').value);body.append('eventName',name.value);body.append('eventDate',date.value);body.append('promotionAliases',document.getElementById('lab-aliases').value);body.append('relevanceKeywords',document.getElementById('lab-keywords').value);body.append('searchTitleTemplates',document.getElementById('lab-templates').value);body.append('exclusionKeywords',document.getElementById('lab-exclusions').value);if(document.getElementById('lab-date').checked)body.append('requireDateInTitle','1');if(document.getElementById('lab-foreign').checked)body.append('allowForeignLanguage','1');return body;}
      function line(parent,item,group){var row=document.createElement('div');row.className='border-top py-2 d-flex gap-2 align-items-start';var button=document.createElement('button');button.type='button';button.className='btn btn-sm '+(group==='rejected'?'btn-outline-danger':'btn-outline-success');button.textContent=group==='rejected'?'Mark unrelated':'Confirm release';button.addEventListener('click',function(){append(group==='rejected'?'lab-bad':'lab-good',item.title);button.disabled=true;button.textContent='Confirmed';});var copy=document.createElement('div');copy.className='min-w-0';var heading=document.createElement('div');heading.className='text-mono text-break';heading.textContent=item.title;var detail=document.createElement('div');detail.className='text-secondary small';detail.textContent=[(item.providers||[]).join(' + '),item.reason].filter(Boolean).join(' · ');copy.appendChild(heading);copy.appendChild(detail);row.appendChild(button);row.appendChild(copy);parent.appendChild(row);}
      document.getElementById('lab-research').addEventListener('click',async function(){var button=this;if(!name.value.trim()){results.textContent='Choose or enter a sample event first.';name.focus();return;}button.disabled=true;button.textContent='Researching…';results.textContent='Searching stored intelligence and live configured sources. This may take up to 45 seconds.';try{var response=await fetch('/admin/promotions/alias-research',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:researchBody()});var data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'Research failed');results.textContent='';var summary=document.createElement('div');summary.className='alert alert-info';summary.textContent=data.counts.discovered+' discovered · '+data.counts.matched+' matched · '+data.counts.possible+' need review · '+data.counts.rejected+' rejected';results.appendChild(summary);['matched','possible','rejected'].forEach(function(group){var items=data.groups[group]||[];if(!items.length)return;var box=document.createElement('details');box.className='card mb-2';box.open=group!=='rejected';var heading=document.createElement('summary');heading.className='card-header';heading.textContent=(group==='matched'?'Matched':group==='possible'?'Needs review':'Rejected')+' ('+items.length+')';box.appendChild(heading);var body=document.createElement('div');body.className='card-body pt-0';items.forEach(function(item){line(body,item,group);});box.appendChild(body);results.appendChild(box);});if(data.report){var copy=document.createElement('button');copy.type='button';copy.className='btn btn-outline-secondary btn-sm mt-2';copy.textContent='Copy safe research report';copy.addEventListener('click',function(){navigator.clipboard.writeText(data.report).then(function(){copy.textContent='Report copied';});});results.appendChild(copy);}}catch(error){results.textContent=error.message;}finally{button.disabled=false;button.textContent='Research configured sources';}});
      document.getElementById('lab-generate').addEventListener('click',async function(){var body=new URLSearchParams({name:document.getElementById('lab-name').value,examples:document.getElementById('lab-good').value,badExamples:document.getElementById('lab-bad').value});var response=await fetch('/admin/promotions/derive-aliases',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body});var data=await response.json();if(!response.ok||!data.ok){results.textContent=data.error||'Could not create rules';return;}document.getElementById('lab-aliases').value=(data.aliases||[]).join('\\n');document.getElementById('lab-keywords').value=(data.keywords||[]).join(', ');document.getElementById('lab-templates').value=(data.searchTitleTemplates||[]).join('\\n');document.getElementById('lab-exclusions').value=(data.exclusions||[]).join(', ');results.textContent='Matching rules created from the confirmed titles. Review them, then save the override.';});
    })();</script>`;
}

function saveMatchingOverride(promotionId, body) {
  const promotion = promotions.all.find((item) => item.id === promotionId && !item.isCustom);
  if (!promotion) throw new Error('Shipped promotion not found: ' + promotionId);
  const saved = promotionOverrides.set(promotion.id, promotion.name, body || {});
  promotions.reload();
  return saved;
}

function resetMatchingOverride(promotionId) {
  const removed = promotionOverrides.remove(promotionId);
  promotions.reload();
  return removed;
}

// Parse form body into a custom-promotion spec, create or update.
//
// 0.38.0: form now carries a `source` field ('tsdb' | 'football-data') and
// the corresponding per-source identifier ('leagueId' for TSDB, 'competitionId'
// for football-data). The unused identifier gets dropped during normalisation.
function persistFromForm(body, opts) {
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
    requireDateInTitle: body.requireDateMode === 'auto'
      ? (source === 'football-data' || source === 'api-football' || source === 'uefa')
      : body.requireDateInTitle === '1',
    allowForeignLanguage: body.allowForeignLanguage === '1',
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
  } else if (source === 'api-football') {
    spec.leagueId = String((selectedSource && selectedSource.leagueId) || body.apiFootballLeagueId || body.leagueId
      || (existingSpec && existingSpec.leagueId) || '').trim();
  } else if (source === 'uefa') {
    spec.competitionId = String((selectedSource && selectedSource.competitionId) || body.uefaCompetitionId
      || body.competitionId || (existingSpec && existingSpec.competitionId) || '').trim();
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

function sourceIdFor(body) {
  const explicit = String(body.sourceId || '').toLowerCase().trim();
  if (explicit) return explicit;
  const promotionId = String(body.id || '').toLowerCase().trim();
  return (promotionId + '-schedule').replace(/[^a-z0-9_-]/g, '').slice(0, 50);
}

function websiteSource(urlValue) {
  let url;
  try { url = new URL(String(urlValue || '').trim()); }
  catch (_) { return { ok: false, error: 'Enter a complete website URL beginning with http:// or https://' }; }
  if (!/^https?:$/.test(url.protocol)) return { ok: false, error: 'The schedule website must use http:// or https://' };
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const pathAndQuery = url.pathname + url.search;
  if (host === 'watch.onefc.com' || host === 'onefc.com' || host.endsWith('.onefc.com')) {
    return { ok: true, type: 'onefc', detected: 'ONE Championship official schedule' };
  }
  if (host === 'mlb.com' || host.endsWith('.mlb.com')) {
    return { ok: true, type: 'mlb', detected: 'MLB official schedule' };
  }
  if ((host === 'uefa.com' || host.endsWith('.uefa.com'))
      && /\/uefachampionsleague(?:\/|$)/i.test(url.pathname)) {
    return { ok: true, type: 'uefa', competitionId: '1', detected: 'Official UEFA Champions League schedule' };
  }
  if (host === 'thesportsdb.com' || host.endsWith('.thesportsdb.com')) {
    const leagueId = (pathAndQuery.match(/(?:league[\/=]|[?&]id=)(\d{2,})/i) || [])[1];
    if (leagueId) return { ok: true, type: 'thesportsdb', leagueId, detected: 'TheSportsDB league ' + leagueId };
    return { ok: false, error: 'That is TheSportsDB, but SSS could not find a league ID in the URL. Choose “Provider ID” and paste the numeric league ID.' };
  }
  if (host === 'themoviedb.org' || host.endsWith('.themoviedb.org')) {
    const tvId = (url.pathname.match(/\/tv\/(\d+)/i) || [])[1];
    if (tvId) return { ok: true, type: 'tmdb', tvIds: tvId, detected: 'TMDB TV series ' + tvId };
  }
  return {
    ok: false,
    error: 'SSS does not yet have a schedule adapter for ' + host
      + '. An arbitrary webpage cannot be imported reliably. Choose a supported provider under Provider ID, or add an adapter before using this site.',
  };
}

function wizardSourceDefinition(body) {
  body = body || {};
  const mode = String(body.sourceMode || 'existing').trim();
  if (mode === 'existing') {
    const sourceRef = String(body.sourceRef || '').trim();
    const definition = sourceRef ? metadataSources.find(sourceRef) : null;
    if (!definition) return { ok: false, error: 'Choose an event schedule before continuing' };
    return { ok: true, existing: true, definition };
  }
  let sourceInput;
  if (mode === 'website') {
    const detected = websiteSource(body.sourceUrl);
    if (!detected.ok) return detected;
    const customName = String(body.sourceName || '').trim();
    sourceInput = Object.assign({}, detected, {
      id: sourceIdFor(body),
      name: customName || (String(body.name || 'Promotion').trim() + ' schedule'),
    });
  } else if (mode === 'provider') {
    const customName = String(body.sourceName || '').trim();
    sourceInput = {
      id: sourceIdFor(body),
      name: customName || (String(body.name || 'Promotion').trim() + ' schedule'),
      type: String(body.sourceType || '').trim(),
      leagueId: body.leagueId,
      teamId: body.teamId,
      competitionId: body.competitionId,
      apiFootballLeagueId: body.apiFootballLeagueId,
      uefaCompetitionId: body.uefaCompetitionId,
      tvIds: body.tvIds,
    };
  } else {
    return { ok: false, error: 'Choose how SSS should get the event schedule' };
  }
  const verdict = metadataSources.validateDefinition(sourceInput);
  if (!verdict.ok) return verdict;
  return { ok: true, existing: false, definition: verdict.definition };
}

async function previewWizardSource(body, opts) {
  const verdict = wizardSourceDefinition(body);
  if (!verdict.ok) return verdict;
  try { return await metadataPreview.preview(verdict.definition, opts); }
  catch (error) {
    return { ok: false, error: String(error && error.message || error || 'Schedule preview failed')
      .replace(/(\/api\/v1\/json\/)[^/\s]+\//gi, '$1[redacted]/')
      .replace(/([?&](?:api_?key|apikey|token)=)[^&\s]+/gi, '$1[redacted]') };
  }
}

// The wizard can create a reusable source and promotion in one action. Older
// form submissions without sourceMode continue through unchanged.
function saveFromForm(body, opts) {
  body = Object.assign({}, body || {});
  const mode = String(body.sourceMode || '').trim();
  if (!mode || mode === 'existing') return persistFromForm(body, opts);
  const sourceVerdict = wizardSourceDefinition(body);
  if (!sourceVerdict.ok) throw new Error(sourceVerdict.error);
  let createdSource = null;
  try {
    createdSource = metadataSources.add({
      id: sourceVerdict.definition.id,
      name: sourceVerdict.definition.name,
      type: sourceVerdict.definition.source.type,
      leagueId: sourceVerdict.definition.source.leagueId,
      teamId: sourceVerdict.definition.source.teamId,
      competitionId: sourceVerdict.definition.source.competitionId,
      apiFootballLeagueId: sourceVerdict.definition.source.type === 'api-football'
        ? sourceVerdict.definition.source.leagueId : undefined,
      uefaCompetitionId: sourceVerdict.definition.source.type === 'uefa'
        ? sourceVerdict.definition.source.competitionId : undefined,
      tvIds: (sourceVerdict.definition.source.tvIds || [sourceVerdict.definition.source.tvId]).filter(Boolean).join(', '),
    });
    body.sourceRef = createdSource.id;
    return persistFromForm(body, opts);
  } catch (error) {
    if (createdSource) metadataSources.removeCustom(createdSource.id);
    throw error;
  }
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
    // A preview must always answer. Adapters have their own timeouts now, but
    // a multi-season fetch is a sequence of them, and the admin UI has no
    // client-side deadline: a slow source left the panel reading "Fetching and
    // comparing events…" forever with no way to tell stalled from working.
    // Losing the race abandons the in-flight work rather than cancelling it;
    // that is acceptable because a preview writes nothing.
    const budgetMs = (opts && opts.timeoutMs != null) ? opts.timeoutMs : PREVIEW_TIMEOUT_MS;
    const comparison = metadataSourceDiff.compare(promotion, definition, existingEvents, opts);
    // The abandoned promise still settles; without a handler a late rejection
    // would surface as an unhandled rejection and take the process down.
    comparison.catch(() => {});
    if (!(budgetMs > 0)) return await comparison;
    let timer = null;
    const expiry = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(
        'The source did not answer within ' + Math.round(budgetMs / 1000)
        + 's. It may be rate-limited — try again shortly.')), budgetMs);
      // Deliberately not unref'd: the timer is the only thing guaranteeing an
      // answer, and `finally` always clears it.
    });
    try { return await Promise.race([comparison, expiry]); }
    finally { if (timer) clearTimeout(timer); }
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
    allowForeignLanguage: body.allowForeignLanguage === '1',
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

function researchDraft(body) {
  body = body || {};
  const name = String(body.name || '').trim();
  const eventName = String(body.eventName || '').trim();
  if (!name) return { ok: false, error: 'Enter the promotion name first' };
  if (!eventName) return { ok: false, error: 'Choose or enter one event from the schedule first' };
  const splitLines = (value) => String(value || '').split(/\r?\n/).map((part) => part.trim()).filter(Boolean);
  const splitTerms = (value) => String(value || '').split(/[\r\n,]+/).map((part) => part.trim()).filter(Boolean);
  const promotion = promotions.createGenericPromotion({
    id: 'alias-research', name, source: 'tsdb', leagueId: '1',
    searchTitleTemplates: splitLines(body.searchTitleTemplates).length
      ? splitLines(body.searchTitleTemplates) : ['{name}', '{name} {year}'],
    relevanceKeywords: splitTerms(body.relevanceKeywords),
    promotionAliases: splitLines(body.promotionAliases),
    exclusionKeywords: splitTerms(body.exclusionKeywords),
    requireDateInTitle: body.requireDateInTitle === '1',
    allowForeignLanguage: body.allowForeignLanguage === '1',
  });
  const event = { name: eventName.slice(0, 200), date: String(body.eventDate || '').trim().slice(0, 10) };
  const manual = String(body.query || '').split(/[;\r\n]+/).map((part) => part.trim().slice(0, 200)).filter(Boolean);
  const dotted = event.date.replace(/-/g, '.');
  const compactEvent = event.name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    // Club/legal markers are frequently present in schedules but omitted by
    // uploaders. This is a generic research variant, never a saved team fix.
    .replace(/\b(?:fc|cf|afc|cfc|sc|fk|sk)\b\.?/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  const aliases = promotionAliases.derivePromotionAliases(name, []);
  const generated = promotion.searchTitles(event);
  const broad = [event.name, compactEvent, name + ' ' + event.name,
    name + ' ' + compactEvent];
  for (const alias of aliases.slice(1, 3)) broad.push(alias + ' ' + compactEvent);
  if (dotted) broad.push(name + ' ' + dotted + ' ' + compactEvent);
  const queries = Array.from(new Set(manual.concat(broad, generated)
    .map((value) => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean)))
    .slice(0, 6);
  return { ok: true, name, promotion, event, queries };
}

function safeResearchError(value) {
  const text = String(value || 'Search failed').toLowerCase();
  if (text.includes('timeout') || text.includes('network')) return 'Timed out or unavailable';
  if (text.includes('auth') || text.includes('401') || text.includes('403')) return 'Authentication failed';
  if (text.includes('unsupported') || text.includes('404') || text.includes('405')) return 'Direct search is not supported';
  return 'Search failed';
}

function researchTitleClass(title, draft) {
  const verdict = draft.promotion.isRelevantStreamTitle(title, draft.event);
  if (verdict.ok) return { group: 'matched', reason: 'matched' };
  const normalized = String(title || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const tokens = Array.from(new Set(draft.event.name.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9]+/g) || []))
    .filter((token) => token.length > 2 && !/^(?:the|and|versus)$/.test(token));
  const teamHits = tokens.filter((token) => new RegExp('\\b' + token + '\\b').test(normalized)).length;
  const dotted = draft.event.date.replace(/-/g, '.');
  const spaced = draft.event.date.replace(/-/g, ' ');
  const dateHint = Boolean(draft.event.date && (normalized.includes(spaced)
    || String(title).includes(dotted)));
  return {
    group: dateHint || (tokens.length && teamHits >= Math.max(1, Math.ceil(tokens.length / 2)))
      ? 'possible' : 'rejected',
    reason: String(verdict.reason || 'not-matched').slice(0, 100),
  };
}

async function researchAliases(userConfig, body, opts) {
  opts = opts || {};
  const draft = researchDraft(body);
  if (!draft.ok) return draft;
  const tasks = [];
  const nativeConfig = usenetIndexer.providerConfig(userConfig || {});
  // This is an explicit admin research action, so a configured discovery
  // service remains available even when its playback pipeline toggle is off.
  nativeConfig.enabled = true;
  if (usenetIndexer.isConfigured(nativeConfig)) {
    tasks.push({ id: 'native-indexer', name: nativeConfig.name || 'DIY indexer', run: () =>
      (opts.nativeSearch || usenetIndexer.search)(draft.queries, nativeConfig,
        { maxQueries: 6, timeoutMs: 30000 }) });
  }
  const uuConfig = usenetUltimate.parseManifestUrl(String((userConfig || {}).uuManifestUrl || '').trim());
  if (uuConfig) {
    tasks.push({ id: 'usenet-ultimate', name: 'Usenet Ultimate', run: () =>
      (opts.uuSearch || usenetUltimate.search)(draft.queries, uuConfig,
        { maxQueries: 6, timeoutMs: 30000 }) });
  }
  const easynewsConfig = userConfig && userConfig.easynewsUsername && userConfig.easynewsPassword
    ? { username: String(userConfig.easynewsUsername).trim(), password: userConfig.easynewsPassword } : null;
  if (easynewsConfig && easynewsConfig.username) {
    tasks.push({ id: 'easynews', name: 'Easynews', run: () =>
      (opts.easynewsSearch || easynews.multiSearch)(draft.queries, Object.assign({
        maxQueries: 6, timeoutMs: 8000, totalTimeoutMs: 45000, queryDelayMs: 100,
      }, easynewsConfig)) });
  }
  const companionConfig = opts.companionConfig || settings.getCompanion();
  if (companionConfig && companionConfig.url) {
    tasks.push({ id: 'release-intelligence', name: 'Release Intelligence', run: () =>
      (opts.intelligenceSearch || companion.intelligenceSearch)({
        queries: draft.queries, limit: 250,
      }) });
    tasks.push({ id: 'companion', name: 'SSS Companion (TorBox discovery)', run: async () => {
      const results = await (opts.companionSearch || companion.scrape)({
        promotion: draft.promotion,
        event: draft.event,
        searchTitles: draft.queries,
        budgetMs: 45000,
        researchMode: true,
        throwOnFailure: true,
        log: () => {},
      });
      return {
        ok: true,
        results: (results || []).map((item) => Object.assign({}, item, {
          indexer: 'SSS Companion',
          publishedAt: item.publishDate || item.publishedAt || null,
        })),
      };
    } });
  }
  if (!tasks.length) return { ok: false, error: 'Configure SSS Companion, DIY Discover, Usenet Ultimate, or Easynews first' };

  const settled = await Promise.allSettled(tasks.map((task) => Promise.resolve().then(task.run)));
  const providers = [];
  const releases = new Map();
  settled.forEach((outcome, index) => {
    const task = tasks[index];
    const result = outcome.status === 'fulfilled' ? (outcome.value || {}) : { ok: false, error: outcome.reason && outcome.reason.message };
    providers.push({
      id: task.id, name: task.name, ok: result.ok !== false,
      count: Array.isArray(result.results) ? result.results.length : 0,
      error: result.ok === false ? safeResearchError(result.error) : '',
    });
    for (const item of result.results || []) {
      const title = String(item && item.title || '').trim().slice(0, 500);
      if (!title) continue;
      const key = title.toLowerCase();
      const current = releases.get(key) || {
        title, indexer: String(item.indexer || task.name).slice(0, 100),
        size: Number(item.size) || 0,
        publishedAt: item.publishedAt ? String(item.publishedAt).slice(0, 100) : '',
        providers: [],
      };
      if (!current.providers.includes(task.name)) current.providers.push(task.name);
      releases.set(key, current);
    }
  });

  const groups = { matched: [], possible: [], rejected: [] };
  for (const release of releases.values()) {
    const classification = researchTitleClass(release.title, draft);
    groups[classification.group].push({
      title: release.title,
      indexer: release.indexer,
      providers: release.providers,
      sizeLabel: sizeLabel(release.size),
      publishedAt: release.publishedAt,
      reason: classification.reason,
    });
  }
  const counts = {
    discovered: releases.size,
    matched: groups.matched.length,
    possible: groups.possible.length,
    rejected: groups.rejected.length,
  };
  Object.keys(groups).forEach((key) => { groups[key] = groups[key].slice(0, 40); });
  // Only confirmed matches may generate one-click rules. Possible rows remain
  // visible for human review but cannot silently teach a false alias.
  const trainingTitles = groups.matched.slice(0, 20).map((row) => row.title);
  const suggested = trainingTitles.length
    ? promotionAliases.suggestPromotionSetup(draft.name, trainingTitles, groups.rejected.slice(0, 10).map((row) => row.title))
    : { aliases: [], keywords: [], exclusions: [], searchTitleTemplates: [] };
  const reportLines = [
    'SeriousSportSync alias research',
    'Promotion: ' + draft.name,
    'Event: ' + draft.event.name + (draft.event.date ? ' | ' + draft.event.date : ''),
    '',
    'Sources:',
  ];
  for (const provider of providers) reportLines.push('- ' + provider.name + ': '
    + (provider.ok ? provider.count + ' discovered' : provider.error));
  reportLines.push('', 'Queries:');
  for (const query of draft.queries) reportLines.push('- ' + query);
  reportLines.push('', 'Outcome: ' + counts.discovered + ' discovered | ' + counts.matched
    + ' matched | ' + counts.possible + ' review | ' + counts.rejected + ' rejected');
  for (const key of ['matched', 'possible', 'rejected']) {
    reportLines.push('', key.toUpperCase() + ':');
    for (const row of groups[key]) reportLines.push('- [' + row.providers.join(' + ') + '] '
      + row.title + (row.reason ? ' | ' + row.reason : ''));
  }
  return {
    ok: true,
    event: draft.event,
    queries: draft.queries,
    providers,
    counts,
    groups,
    suggested: {
      aliases: suggested.aliases || [],
      keywords: suggested.keywords || [],
      exclusions: suggested.exclusions || [],
      searchTitleTemplates: suggested.searchTitleTemplates || [],
    },
    report: reportLines.join('\n').slice(0, 60000),
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

// Which promotions a bulk-refresh request actually refreshes.
//
// Kept out of the route so the rules are testable without starting a refresh:
// exercising them through HTTP would fire real source fetches, which in a test
// run means network calls and a process that will not exit.
//
// Ids arrive as one comma-separated field because the checkboxes cannot live
// in a form of their own — the table rows already contain forms, and nesting
// them is what detached the Configure Save button in 0.89.0.
function selectForRefresh(idsField, all) {
  const requested = String(idsField || '').split(',').map((value) => value.trim()).filter(Boolean);
  const selected = [];
  const skipped = [];
  const seen = new Set();
  for (const id of requested) {
    if (seen.has(id)) continue;          // ticking a row twice is one refresh
    seen.add(id);
    const promotion = (all || []).find((item) => item && item.id === id);
    if (!promotion) skipped.push(id + ' (not found)');
    else if (!promotion.enabled) skipped.push(promotion.name + ' (disabled)');
    else selected.push(promotion);
  }
  return { selected, skipped };
}

module.exports = {
  selectForRefresh,
  renderBody,
  renderMatchingLab,
  saveMatchingOverride,
  resetMatchingOverride,
  saveFromForm,
  deleteCustom,
  assignSource,
  createMetadataSource,
  validateLeagueId,
  validateCompetitionId,
  validateTvId,
  deriveAliases,
  previewMatching,
  researchAliases,
  searchReleaseExamples,
  previewSourceChange,
  websiteSource,
  wizardSourceDefinition,
  previewWizardSource,
};
