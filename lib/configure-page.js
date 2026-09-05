'use strict';

// 0.91.0 — Configure, rebuilt as a flow.
//
// What was wrong was not mainly the styling. /account was one long scroll on
// which playback services, catalogs, collections and the install URL all
// carried the same weight, so nothing told a new user what to do first, and
// nothing ever told them they were finished. The install URL — the entire
// point of the page — sat in the middle of it.
//
// So: five steps, in an order that argues for itself.
//
//   1 Services     — a team you follow with nothing to search is a catalog
//                    that plays nothing, so credentials come first.
//   2 Your teams   — a pick creates a catalog, and the consequence shows up
//                    on step 3 immediately rather than three screens later.
//   3 Catalogs     — which rows exist and in what order.
//   4 Collections  — how those rows are grouped inside Nuvio.
//   5 Install      — the URL, and a check that any of it actually worked.
//
// TWO FLOWS OVER ONE SET OF STEPS. First run is a sequence with a permanent
// escape hatch ("Skip to install"); a wizard you cannot leave is worse than no
// wizard. Returning is not a sequence at all — you came back to fix one API
// key, so every step is equally reachable and the primary action is Save. The
// difference is decided by whether the account has ever been configured.
//
// One <form> spans all five steps and posts to /account/save exactly as
// before. The steps are panels shown and hidden in the browser, NOT separate
// requests: a partial save is how you lose settings, and every field must
// reach the server on every save or it gets blanked. The same reasoning is
// why nothing here is ever `disabled` — a disabled input submits nothing.

const shell = require('./ui/shell');
const nuvioAccount = require('./nuvio-account');
const escapeHtml = shell.escapeHtml;

const STEPS = [
  { id: 'services', label: 'Services', sub: 'TorBox, Usenet, Easynews' },
  { id: 'teams', label: 'Your teams', sub: 'Clubs to follow' },
  { id: 'catalogs', label: 'Catalogs', sub: 'Rows and order' },
  { id: 'collections', label: 'Collections', sub: 'Nuvio folders' },
  { id: 'install', label: 'Install', sub: 'Manifest URL' },
];

// A catalog's marker in the list.
//
// This used to render the promotion's poster. Those posters are wide landscape
// banners meant to fill a Stremio row, and several promotions have none at all,
// so a 62x35 slot showed a squashed crop, the wrong crest, or a broken image.
// The list needs something that identifies a row at a glance, and the artwork
// is not doing that job — so it is a coloured initial tile instead.
//
// The colour is derived from the promotion id, so it is stable across renders
// and distinct between neighbours without anyone choosing it.
function tile(promotion) {
  const id = String(promotion.id || promotion.name || '');
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  // Kept away from full saturation so a row of these reads as a set rather
  // than a paint chart, and dark enough that white initials hold on both themes.
  const background = 'hsl(' + hue + ' 42% 32%)';
  const initials = String(promotion.name || '?')
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map((word) => word[0]).join('').toUpperCase() || '?';
  return '<span class="tile" style="background:' + background + '" aria-hidden="true">'
    + escapeHtml(initials) + '</span>';
}

function chip(text, tone) {
  return '<span class="chip" data-tone="' + escapeHtml(tone || 'off') + '">' + escapeHtml(text) + '</span>';
}

function field(label, name, value, opts) {
  const options = opts || {};
  return '<label class="f"><span>' + escapeHtml(label) + '</span>'
    + '<input class="t' + (options.mono ? ' mono' : '') + '"'
    + ' type="' + escapeHtml(options.type || 'text') + '"'
    + ' name="' + escapeHtml(name) + '"'
    + ' value="' + escapeHtml(value == null ? '' : value) + '"'
    + (options.placeholder ? ' placeholder="' + escapeHtml(options.placeholder) + '"' : '')
    + (options.type === 'password' ? ' autocomplete="off"' : '')
    + '>'
    + (options.hint ? '<div class="hint">' + options.hint + '</div>' : '')
    + '</label>';
}

function toggle(name, on, title, detail) {
  return '<label class="sw"><input type="checkbox" name="' + escapeHtml(name) + '" value="on"'
    + (on ? ' checked' : '') + '><i></i>'
    + '<b>' + escapeHtml(title) + (detail ? '<small>' + escapeHtml(detail) + '</small>' : '') + '</b></label>';
}

function serviceCard(spec) {
  return '<div class="panel" style="margin:0">'
    + '<div class="panel-head">'
    + '<div class="row-main"><span class="row-name">' + escapeHtml(spec.name) + '</span>'
    + '<span class="row-sub">' + escapeHtml(spec.role) + '</span></div>'
    + chip(spec.stateText, spec.stateTone)
    + '</div>'
    + '<div class="panel-body">' + spec.body + '</div>'
    + '</div>';
}

// ---------------------------------------------------------------- step 1
function stepServices(cfg) {
  const torboxOn = !!String(cfg.torboxApiKey || '').trim();
  const uuOn = !!String(cfg.uuManifestUrl || '').trim();
  const easynewsOn = !!(String(cfg.easynewsUsername || '').trim() && cfg.easynewsPassword);
  const diyOn = cfg.diyUsenetEnabled === true;

  return ''
    + '<div class="lede"><h2>Where your streams come from</h2>'
    + '<p>SSS finds the fixture; these services find the file. Fill in the ones you have — every pipeline is optional, and one is enough to start.</p></div>'

    + '<div class="grid-2">'
    + serviceCard({
      name: 'TorBox', role: 'Debrid — torrents and usenet',
      stateText: torboxOn ? 'Configured' : 'Not set', stateTone: torboxOn ? 'ok' : 'off',
      body: field('API key', 'torboxApiKey', cfg.torboxApiKey, { type: 'password', mono: true, placeholder: 'paste your TorBox key' })
        + '<div style="margin-top:12px">' + toggle('torboxEnabled', cfg.torboxEnabled !== false, 'Use TorBox results') + '</div>',
    })
    + serviceCard({
      name: 'Usenet Ultimate', role: 'Indexer fan-out',
      stateText: uuOn ? 'Configured' : 'Not set', stateTone: uuOn ? 'ok' : 'off',
      body: field('Manifest URL', 'uuManifestUrl', cfg.uuManifestUrl, { mono: true, placeholder: 'http://host:1337/stremio/…/manifest.json' })
        + '<div style="margin-top:12px">' + toggle('uuEnabled', cfg.uuEnabled !== false, 'Use Usenet Ultimate results') + '</div>',
    })
    + serviceCard({
      name: 'Easynews', role: 'Usenet search and direct play',
      stateText: easynewsOn ? 'Configured' : 'Not set', stateTone: easynewsOn ? 'ok' : 'off',
      body: '<div class="grid-2" style="gap:10px">'
        + field('Username', 'easynewsUsername', cfg.easynewsUsername)
        + field('Password', 'easynewsPassword', cfg.easynewsPassword, { type: 'password' })
        + '</div><div style="margin-top:12px">' + toggle('easynewsEnabled', cfg.easynewsEnabled !== false, 'Use Easynews results') + '</div>',
    })
    + serviceCard({
      name: 'DIY Usenet', role: 'Your own Newznab or Prowlarr',
      stateText: diyOn ? 'On' : 'Off', stateTone: diyOn ? 'ok' : 'off',
      body: toggle('diyUsenetEnabled', diyOn, 'Enable the DIY Usenet pipeline',
        'Its indexer URL and key live on the DIY Usenet page.')
        + '<div class="hint">' + (diyOn
          ? '<a href="/account/usenet">Open DIY Usenet settings</a> to add or change your indexer.'
          : 'Switch this on and save, then <a href="/account/usenet">Open DIY Usenet settings</a> to add your indexer.')
        + '</div>',
    })
    + '</div>'

    + '<details class="fold adv">'
    + '<summary><div class="row-main"><h3>Advanced</h3>'
    + '<p>Result limits and warm rows — nothing here needs changing unless something is misbehaving</p></div></summary>'
    + '<div class="fold-body"><div class="grid-2">'
    + field('Maximum streams per fixture', 'maxStreams', cfg.maxStreams == null ? 20 : cfg.maxStreams,
      { type: 'number', hint: 'Rows returned after dedupe. 1–50.' })
    + '<div>' + toggle('showWarmRows', cfg.showWarmRows !== false, 'Show warm-to-cache rows',
      'Offers uncached TorBox candidates as a row that starts caching when selected.') + '</div>'
    + '</div></div></details>';
}

// ---------------------------------------------------------------- step 2
function stepTeams(choosers, teamPromotions) {
  const folds = choosers.map((entry) => {
    const mine = teamPromotions.filter((p) => p.chooser === entry.key);
    const on = mine.filter((p) => p.enabled);
    return '<details class="fold" data-league="' + escapeHtml(entry.key) + '"'
      + (on.length ? ' open' : '') + '>'
      + '<summary><div class="row-main"><h3>' + escapeHtml(entry.label) + '</h3>'
      + '<p>' + escapeHtml(entry.hint) + '</p></div>'
      + '<span class="chip" data-tone="' + (on.length ? 'ok' : 'off') + '" data-count="' + escapeHtml(entry.key) + '">'
      + (on.length ? on.length + ' selected' : 'None') + '</span></summary>'
      + '<div class="fold-body"><div class="teams" data-teams="' + escapeHtml(entry.key) + '">'
      + '<div class="hint">Loading teams…</div></div></div>'
      + '</details>';
  }).join('');

  const kept = teamPromotions.filter((p) => !p.enabled);
  const keptHtml = kept.length
    ? '<details class="fold"><summary><div class="row-main"><h3>Kept, not served</h3>'
      + '<p>Out of your manifest — fixtures still stored, nothing to re-fetch</p></div>'
      + '<span class="chip plain" data-tone="off">' + kept.length + '</span></summary>'
      + '<div class="fold-body"><div class="rows">'
      + kept.map((p) => '<div class="row">'
        + '<span class="row-main"><span class="row-name">' + escapeHtml(p.name) + '</span>'
        + '<span class="row-sub">Not in your manifest · pick the team again to restore it</span></span>'
        + '</div>').join('')
      + '</div></div></details>'
    : '';

  return ''
    + '<div class="lede"><h2>Your teams</h2>'
    + '<p>Every league works the same way: pick a team and SSS creates its catalog — league, both domestic cups and Europe where the feed covers them.</p></div>'
    + '<div class="panel"><div class="panel-body" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">'
    + '<span class="chip" data-tone="ok" id="teams-total">' + teamPromotions.filter((p) => p.enabled).length + ' catalogs</span>'
    + '<span class="row-sub" style="flex:1;min-width:220px">Deselecting drops a catalog out of your manifest, so it leaves Stremio on its own — but the fixtures stay on disk, and picking the team again brings it back instantly with nothing to re-fetch.</span>'
    + '</div></div>'
    + folds
    + keptHtml
    + '<div class="hint">Aliases that name two clubs — "Manchester", "United" — are dropped automatically, so a Man United catalog never picks up a City fixture.</div>';
}

// ---------------------------------------------------------------- step 3
function stepCatalogs(promotionList, selected, selectAll, folderOf) {
  const rows = promotionList.map((p) => {
    const ids = (p.catalogs || []).map((c) => c.id);
    const on = selectAll || ids.some((id) => selected.has(id));
    const folder = folderOf[p.id];
    return '<div class="row" draggable="true" data-id="' + escapeHtml(p.id) + '">'
      + '<button class="drag" type="button" title="Drag to reorder" aria-label="Reorder ' + escapeHtml(p.name) + '">'
      + '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
      + '<circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/>'
      + '<circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg></button>'
      + tile(p)
      + '<span class="row-main"><span class="row-name">' + escapeHtml(p.name) + '</span>'
      + '<span class="row-sub">' + escapeHtml(ids.length + (ids.length === 1 ? ' catalog' : ' catalogs')) + '</span>'
      + '<span class="row-tags">'
      + (folder ? '<span class="chip plain" data-tone="info">In ' + escapeHtml(folder) + '</span>' : '')
      + (p.isTeam ? '<span class="chip plain" data-tone="off">From your teams</span>' : '')
      + '</span></span>'
      + ids.map((id) => '<input type="hidden" class="cat-id" data-for="' + escapeHtml(p.id) + '" value="' + escapeHtml(id) + '">').join('')
      + '<label class="sw" title="Serve this promotion\'s rows"><input type="checkbox" class="promo-on"'
      + ' data-id="' + escapeHtml(p.id) + '"' + (on ? ' checked' : '')
      + ' aria-label="Show ' + escapeHtml(p.name) + '"><i></i>'
      + '<b style="font-size:12px;color:var(--ink-3)">Home row</b></label>'
      + '</div>';
  }).join('');

  return ''
    + '<div class="lede"><h2>Catalogs</h2>'
    + '<p>Drag to set the order they appear in. Switch one off and its rows leave your manifest — the metadata stays, so switching it back on is instant.</p></div>'
    + '<div class="panel">'
    + '<div class="panel-head"><div><h3>Your rows</h3><p id="catalog-count"></p></div>'
    + '<span class="chip plain" data-tone="off" style="margin-left:auto">Drag the handle to reorder</span></div>'
    + '<div class="rows" id="catalog-rows">' + rows + '</div>'
    + '<div class="panel-foot"><div class="hint" style="margin:0">'
    + '<strong>On the home screen</strong> and <strong>in a collection</strong> are separate things. '
    + 'A catalog you file into a Nuvio folder keeps its row here unless you switch it off — which is what the old page got wrong.'
    + '</div></div></div>'
    // The selection and the order are rebuilt from the rows on every change,
    // so what posts always matches what is on screen. A checkbox per catalog
    // would post nothing for the ones that are off, which is fine — but the
    // ORDER has to survive a save too, and only a hidden field can carry it.
    + '<input type="hidden" name="promotionOrder" id="promotionOrder" value="">'
    + '<div id="catalog-inputs"></div>';
}

// ---------------------------------------------------------------- step 4
function stepCollections(collections, promotionList, isAdmin) {
  const byId = {};
  promotionList.forEach((p) => { byId[p.id] = p.name; });

  const folders = (collections.folders || []).map((folder) => {
    const chosen = new Set(folder.promotions || []);
    // Not `name="promotions"` — these inputs live inside the Configure form's
    // DOM, and anything named would be posted to /account/save as well.
    const options = promotionList.map((p) => '<label class="sw" style="display:flex;padding:4px 0">'
      + '<input type="checkbox" class="folder-member" value="' + escapeHtml(p.id) + '"'
      + (chosen.has(p.id) ? ' checked' : '') + '><i></i>'
      + '<b style="font-weight:500">' + escapeHtml(p.name) + '</b></label>').join('');
    return '<div class="panel" style="margin:0">'
      + '<div class="panel-head"><div><h3>' + escapeHtml(folder.title) + '</h3>'
      + '<p>' + escapeHtml(Array.from(chosen).map((id) => byId[id]).filter(Boolean).join(' · ') || 'Empty — not exported') + '</p></div>'
      + '<span class="chip plain" data-tone="off" style="margin-left:auto">' + chosen.size + '</span></div>'
      // No <form> here, deliberately. These panels sit inside the Configure
      // form, and a form inside a form is not valid HTML: the browser closes
      // the outer one at the first </form>, which is precisely how the Save
      // button was detached from Configure in 0.89.0. The folder posts through
      // fetch to the same admin endpoint instead.
      + (isAdmin
        ? '<div class="panel-body" data-folder="' + escapeHtml(folder.id) + '"'
          + ' data-title="' + escapeHtml(folder.title) + '"'
          + ' data-artwork="' + escapeHtml(folder.artwork) + '"'
          + ' data-shape="' + escapeHtml(folder.tileShape) + '">'
          + '<details class="fold" style="margin:0"><summary><div class="row-main">'
          + '<h3 style="font-size:14px">Catalogs in this folder</h3></div></summary>'
          + '<div class="fold-body">' + options + '</div></details>'
          + '<div style="margin-top:12px;display:flex;gap:10px;align-items:center">'
          + '<button class="btn ghost sm" type="button" data-save-folder="' + escapeHtml(folder.id) + '">Save folder</button>'
          + '<span class="row-sub" data-folder-state="' + escapeHtml(folder.id) + '"></span></div>'
          + '</div>'
        : '<div class="panel-body"><div class="hint">Folders are shared by everyone on this server, so an admin edits them.</div></div>')
      + '</div>';
  }).join('');

  return ''
    + '<div class="lede"><h2>Nuvio collections</h2>'
    + '<p>Group your rows into folders on the Nuvio home screen. A folder with nothing in it is simply not exported.</p></div>'
    + '<div class="note" data-tone="info"><div><b>Folders do not hide rows</b>'
    + '<span>Adding a catalog to a folder groups it inside Nuvio. It keeps its home row until you switch that row off on the Catalogs step.</span></div></div>'
    + '<div class="grid-2" style="margin-top:16px">' + (folders || '<div class="hint">No folders yet.</div>') + '</div>'
    + (isAdmin ? '<div style="margin-top:14px"><a class="btn ghost" href="/admin/nuvio-collections">Create or rename folders</a></div>' : '')
    // Getting this into Nuvio used to mean copying a JSON blob by hand every
    // time anything changed. It can be written straight into a profile instead.
    + '<div style="margin-top:22px">' + nuvioAccount.panel() + '</div>';
}

// ---------------------------------------------------------------- step 5
function stepInstall(installUrl) {
  const stremio = installUrl.replace(/^https?:\/\//i, 'stremio://');
  return ''
    + '<div class="lede"><h2>Install</h2>'
    + '<p>Everything above is saved against your account. This URL is yours alone — it carries your token, so treat it like a password.</p></div>'

    + '<div class="panel"><div class="panel-head"><div><h3>Your manifest</h3>'
    + '<p>Paste into Stremio or Nuvio, or use a button below</p></div></div>'
    + '<div class="panel-body">'
    + '<div class="urlbox"><input class="t mono" id="manifest-url" readonly value="' + escapeHtml(installUrl) + '" aria-label="Manifest URL">'
    + '<button class="btn ghost" type="button" id="copy-manifest">Copy</button></div>'
    + '<div class="grid-3">'
    + '<a class="btn primary" href="' + escapeHtml(stremio) + '">Install in Stremio</a>'
    + '<a class="btn ghost" href="https://web.stremio.com/#/addons?addon=' + encodeURIComponent(installUrl) + '" target="_blank" rel="noreferrer noopener">Stremio Web</a>'
    + '<a class="btn ghost" href="/account/nuvio-collections.json">Nuvio collections JSON</a>'
    + '</div></div></div>'

    // The step SSS has never had. Until now the first evidence that any of the
    // setup worked was opening Stremio and finding an empty row — and a
    // pipeline returning nothing looked exactly like a pipeline that was never
    // configured.
    + '<div class="panel"><div class="panel-head"><div><h3>Check it works</h3>'
    + '<p>Runs a settled fixture from your catalogs — at least a week old, so releases exist — through every pipeline you configured</p></div>'
    + '<span class="chip plain" data-tone="off" id="verify-state" style="margin-left:auto">Not run</span></div>'
    + '<div class="panel-body">'
    + '<button class="btn ghost" type="button" id="verify-run">Run the check</button>'
    + '<div id="verify-out"></div>'
    + '</div></div>';
}

// ---------------------------------------------------------------- page
function render(input) {
  const data = input || {};
  const user = data.user || {};
  const cfg = user.config || {};
  const isFirstRun = data.isFirstRun !== false;
  const start = Math.max(0, STEPS.findIndex((s) => s.id === data.step));
  const at = start === -1 ? 0 : start;

  const rail = '<nav class="steprail" id="steprail" aria-label="Setup steps">'
    + STEPS.map((step, i) => '<button class="step" type="button" data-step-to="' + i + '"'
      + ' data-state="' + (i === at ? 'now' : (isFirstRun ? (i < at ? 'done' : 'todo') : 'done')) + '">'
      + '<span class="step-num">' + (i + 1) + '</span>'
      + '<span><span class="step-label">' + escapeHtml(step.label) + '</span>'
      + '<span class="step-sub">' + escapeHtml(step.sub) + '</span></span>'
      + '</button>').join('')
    + '</nav>';

  const flash = data.flash
    ? '<div class="wrap" style="padding-bottom:0"><div class="note" data-tone="'
      + (/fail|error/i.test(data.flash) ? 'bad' : 'ok') + '"><div><b>'
      + escapeHtml(data.flash === 'saved' ? 'Saved' : data.flash) + '</b></div></div></div>'
    : '';

  const panels = [
    stepServices(cfg),
    stepTeams(data.choosers || [], data.teamPromotions || []),
    stepCatalogs(data.promotions || [], data.selected || new Set(), data.selectAll, data.folderOf || {}),
    stepCollections(data.collections || {}, data.promotions || [], !!data.isAdmin),
    stepInstall(data.installUrl || ''),
  ].map((html, i) => '<section class="wrap step-panel" data-step="' + i + '"'
    + (i === at ? '' : ' hidden') + '>' + html + '</section>').join('');

  const controls = ''
    + '<div class="seg" role="group" aria-label="Detail level">'
    + '<button type="button" data-level="simple" aria-pressed="true">Simple</button>'
    + '<button type="button" data-level="advanced" aria-pressed="false">Advanced</button>'
    + '</div>'
    + '<button class="icon-btn" type="button" data-nav="-1" aria-label="Previous step">'
    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>'
    + '<button class="icon-btn" type="button" data-nav="1" aria-label="Next step">'
    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button>';

  const actions = ''
    + '<div class="actions">'
    + '<span class="saved" id="flow-note"></span>'
    + '<div class="spacer"></div>'
    + '<button class="btn ghost" type="button" id="skip-btn">Skip to install</button>'
    + '<button class="btn ghost" type="button" data-nav="-1">Back</button>'
    + '<button class="btn primary" type="submit" form="configure-form" id="next-btn">Save</button>'
    + '</div>';

  const body = flash
    + '<form method="POST" action="/account/save" id="configure-form">' + panels + '</form>';

  const manifestUrl = data.installUrl || '';

  return shell.page({
    user: user,
    section: 'configure',
    title: 'Configure',
    subtitle: user.username || '',
    controls: controls,
    steprail: rail,
    body: body,
    actions: actions,
    script: 'window.__sssManifestUrl = ' + JSON.stringify(manifestUrl) + ';'
      + nuvioAccount.mergeScript()
      + clientScript(at, isFirstRun)
      + nuvioAccount.clientScript('/account/nuvio-collections.json'),
  });
}

function clientScript(at, isFirstRun) {
  return '(' + String(function (startAt, firstRun) {
    var STEP_LABELS = ['Services', 'Your teams', 'Catalogs', 'Collections', 'Install'];
    var at = startAt;
    var flow = firstRun ? 'first' : 'return';
    var rail = document.getElementById('steprail');
    var form = document.getElementById('configure-form');

    function go(next) {
      at = Math.max(0, Math.min(STEP_LABELS.length - 1, next));
      Array.prototype.forEach.call(rail.children, function (el, i) {
        el.setAttribute('data-state',
          flow === 'return' ? (i === at ? 'now' : 'done')
            : (i < at ? 'done' : i === at ? 'now' : 'todo'));
      });
      document.querySelectorAll('.step-panel').forEach(function (p) {
        p.hidden = Number(p.getAttribute('data-step')) !== at;
      });
      var last = at === STEP_LABELS.length - 1;
      document.querySelectorAll('[data-nav="-1"]').forEach(function (b) { b.disabled = at === 0; });
      var next = document.getElementById('next-btn');
      var skip = document.getElementById('skip-btn');
      var note = document.getElementById('flow-note');
      skip.hidden = last || flow === 'return';
      if (flow === 'return') {
        next.textContent = 'Save changes';
        note.textContent = 'Change anything and save — every step is saved together.';
      } else {
        next.textContent = last ? 'Save and finish' : 'Save and continue';
        note.textContent = 'Step ' + (at + 1) + ' of ' + STEP_LABELS.length;
      }
      try { history.replaceState(null, '', '?step=' + at); } catch (e) {}
      window.scrollTo(0, 0);
    }

    rail.addEventListener('click', function (e) {
      var b = e.target.closest('[data-step-to]');
      if (b) go(Number(b.getAttribute('data-step-to')));
    });
    document.querySelectorAll('[data-nav]').forEach(function (b) {
      b.addEventListener('click', function () { go(at + Number(b.getAttribute('data-nav'))); });
    });
    document.getElementById('skip-btn').addEventListener('click', function () { go(STEP_LABELS.length - 1); });

    // Save lands back on the step you were on, not at the top of the flow.
    form.addEventListener('submit', function () {
      var back = document.createElement('input');
      back.type = 'hidden'; back.name = 'returnStep'; back.value = String(at);
      form.appendChild(back);
    });

    /* Simple / Advanced ------------------------------------------------ */
    document.querySelectorAll('[data-level]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var advanced = btn.getAttribute('data-level') === 'advanced';
        document.querySelectorAll('[data-level]').forEach(function (b) {
          b.setAttribute('aria-pressed', String(b === btn));
        });
        document.querySelectorAll('.adv').forEach(function (el) { el.hidden = !advanced; });
      });
    });
    document.querySelectorAll('.adv').forEach(function (el) { el.hidden = true; });

    /* Catalogs: order + selection ------------------------------------- */
    var rows = document.getElementById('catalog-rows');
    function syncCatalogs() {
      var order = [], chosen = [];
      Array.prototype.forEach.call(rows.children, function (row) {
        var id = row.getAttribute('data-id');
        order.push(id);
        var on = row.querySelector('.promo-on');
        if (on && on.checked) {
          row.querySelectorAll('.cat-id').forEach(function (input) { chosen.push(input.value); });
        }
      });
      document.getElementById('promotionOrder').value = order.join(',');
      var host = document.getElementById('catalog-inputs');
      host.innerHTML = chosen.map(function (id) {
        return '<input type="hidden" name="catalogs" value="' + id.replace(/"/g, '&quot;') + '">';
      }).join('') + '<input type="hidden" name="showCatalogsOnHome" value="on">';
      var live = rows.querySelectorAll('.promo-on:checked').length;
      document.getElementById('catalog-count').textContent =
        live + ' of ' + rows.children.length + ' promotions served';
    }
    rows.addEventListener('change', syncCatalogs);

    var dragging = null;
    rows.addEventListener('dragstart', function (e) {
      var row = e.target.closest('.row');
      if (!row) return;
      dragging = row; row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', row.getAttribute('data-id')); } catch (_) {}
    });
    rows.addEventListener('dragend', function () {
      if (dragging) dragging.classList.remove('dragging');
      clearMarks(); dragging = null; syncCatalogs();
    });
    function clearMarks() {
      Array.prototype.forEach.call(rows.children, function (r) { r.classList.remove('over', 'over-below'); });
    }
    rows.addEventListener('dragover', function (e) {
      e.preventDefault();
      var row = e.target.closest && e.target.closest('.row');
      if (!row || row === dragging || !dragging) return;
      clearMarks();
      var box = row.getBoundingClientRect();
      var below = e.clientY > box.top + box.height / 2;
      row.classList.add(below ? 'over-below' : 'over');
      if (below) row.after(dragging); else row.before(dragging);
    });
    rows.addEventListener('drop', function (e) { e.preventDefault(); clearMarks(); });

    /* Teams: loaded when a league is opened, not on page render -------- */
    var loaded = {};
    document.querySelectorAll('[data-league]').forEach(function (fold) {
      var key = fold.getAttribute('data-league');
      var load = function () {
        if (loaded[key]) return;
        loaded[key] = true;
        var host = fold.querySelector('[data-teams="' + key + '"]');
        fetch('/account/teams/' + encodeURIComponent(key) + '.json', { headers: { Accept: 'application/json' } })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (!data.ok) { host.innerHTML = '<div class="hint">' + (data.error || 'Team list unavailable') + '</div>'; return; }
            host.innerHTML = data.teams.map(function (team) {
              var on = (data.selected || []).indexOf(String(team.id)) > -1;
              return '<button type="button" class="team" data-team="' + team.id + '" data-key="' + key + '"'
                + ' aria-pressed="' + on + '">'
                + (team.crest ? '<img class="crest" src="' + team.crest + '" alt="" loading="lazy">' : '<span class="crest"></span>')
                + '<span class="team-name">' + team.name + '</span></button>';
            }).join('');
          })
          .catch(function () { host.innerHTML = '<div class="hint">Could not load the team list.</div>'; });
      };
      if (fold.open) load();
      fold.addEventListener('toggle', function () { if (fold.open) load(); });
    });

    document.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('.team');
      if (!btn) return;
      var on = btn.getAttribute('aria-pressed') === 'true';
      btn.disabled = true;
      fetch(on ? '/account/teams/remove' : '/account/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ chooser: btn.getAttribute('data-key'), teamId: btn.getAttribute('data-team') }).toString(),
      }).then(function (r) { return r.json(); }).then(function (data) {
        btn.disabled = false;
        if (!data.ok) { alert(data.error || 'That did not work'); return; }
        btn.setAttribute('aria-pressed', String(!on));
        // The catalog list is server-rendered, so reload to show the
        // consequence rather than guessing at it in two places.
        window.location.href = '/account?step=1';
      }).catch(function () { btn.disabled = false; });
    });

    /* Collections: save a folder without a nested form ----------------- */
    document.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('[data-save-folder]');
      if (!btn) return;
      var id = btn.getAttribute('data-save-folder');
      var box = document.querySelector('[data-folder="' + id + '"]');
      var state = document.querySelector('[data-folder-state="' + id + '"]');
      var body = new URLSearchParams();
      body.append('title', box.getAttribute('data-title'));
      body.append('artwork', box.getAttribute('data-artwork'));
      body.append('tileShape', box.getAttribute('data-shape'));
      box.querySelectorAll('.folder-member:checked').forEach(function (input) {
        body.append('promotions', input.value);
      });
      btn.disabled = true; state.textContent = 'Saving…';
      fetch('/admin/nuvio-collections/folders/' + encodeURIComponent(id) + '/save', {
        method: 'POST', body: body, redirect: 'follow',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }).then(function (r) {
        btn.disabled = false;
        state.textContent = r.ok ? 'Saved' : 'Could not save';
        setTimeout(function () { state.textContent = ''; }, 2500);
      }).catch(function () {
        btn.disabled = false; state.textContent = 'Could not save';
      });
    });

    /* Install: copy + verify ------------------------------------------ */
    var copy = document.getElementById('copy-manifest');
    if (copy) copy.addEventListener('click', function () {
      var input = document.getElementById('manifest-url');
      var done = function (ok) {
        copy.textContent = ok ? 'Copied' : 'Press Ctrl+C';
        setTimeout(function () { copy.textContent = 'Copy'; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
        navigator.clipboard.writeText(input.value).then(function () { done(true); })
          .catch(function () { input.select(); done(false); });
      } else {
        input.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
        done(ok);
      }
    });

    var verify = document.getElementById('verify-run');
    if (verify) verify.addEventListener('click', function () {
      var out = document.getElementById('verify-out');
      var state = document.getElementById('verify-state');
      verify.disabled = true; verify.textContent = 'Checking…';
      state.textContent = 'Running'; state.setAttribute('data-tone', 'info');
      out.innerHTML = '<div class="hint">Searching every configured pipeline. This can take up to 30 seconds.</div>';
      fetch('/account/verify', { method: 'POST', headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          verify.disabled = false; verify.textContent = 'Run again';
          if (!data.ok) {
            state.textContent = 'Could not run'; state.setAttribute('data-tone', 'warn');
            out.innerHTML = '<div class="note" data-tone="warn"><div><b>' + (data.error || 'Nothing to check') + '</b></div></div>';
            return;
          }
          var any = data.total > 0;
          state.textContent = any ? data.total + ' streams' : 'No streams';
          state.setAttribute('data-tone', any ? 'ok' : 'warn');
          out.innerHTML =
            '<div class="row" style="padding:0 0 12px;border:0"><span class="row-main">'
            + '<span class="row-name">' + data.event.name + '</span>'
            + '<span class="row-sub">' + data.event.date + ' · ' + data.event.promotion
            + ' · ' + data.event.ageDays + ' days ago</span></span></div>'
            + '<div class="rows" style="border-top:1px solid var(--line)">'
            + data.pipelines.map(function (p) {
              var tone = p.configured ? (p.rows > 0 ? 'ok' : 'warn') : '';
              return '<div class="row stripe"' + (tone ? ' data-tone="' + tone + '"' : '') + '>'
                + '<span class="chip" data-tone="' + (p.configured ? (p.rows ? 'ok' : 'warn') : 'off') + '">'
                + (p.configured ? (p.rows ? p.rows + ' streams' : 'Nothing found') : 'Not configured') + '</span>'
                + '<span class="row-main"><span class="row-name">' + p.name + '</span>'
                + '<span class="row-sub">' + (p.detail || '') + '</span></span></div>';
            }).join('')
            + '</div>'
            + (any
              ? '<div class="hint">' + data.total + ' stream'
                + (data.total === 1 ? '' : 's') + ' returned for this fixture.</div>'
              : '<div class="hint">Nothing came back for this fixture. That is not always a '
                + 'configuration problem — an older or lower-profile event may simply have no '
                + 'release. Try again after checking the credentials on step 1, and if other '
                + 'fixtures do return streams, this one is the exception rather than the rule.</div>');
        })
        .catch(function () {
          verify.disabled = false; verify.textContent = 'Run the check';
          state.textContent = 'Failed'; state.setAttribute('data-tone', 'bad');
          out.innerHTML = '<div class="note" data-tone="bad"><div><b>The check could not reach the server.</b></div></div>';
        });
    });

    syncCatalogs();
    go(at);
  }) + ')(' + at + ',' + (isFirstRun ? 'true' : 'false') + ');';
}

module.exports = { render, STEPS };
