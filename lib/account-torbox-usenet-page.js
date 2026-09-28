'use strict';

// TorBox Usenet settings, one page per account: its search source, how many
// NZBs are checked per event, and a test search. A separate pipeline from
// built-in Usenet; the on/off switch is here and on Configure.
//
// The source is one of three: Newznab indexers searched directly (several
// may be added), one NZBHydra, or one Prowlarr.

const pipeline = require('./torbox-usenet-pipeline');

const esc = (value) => String(value === undefined || value === null ? '' : value)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SOURCES = [
  ['newznab', 'Newznab indexers', 'Add your indexers directly (NZBGeek, DrunkenSlug…). SSS searches them all at once.'],
  ['nzbhydra', 'NZBHydra', 'One NZBHydra, which searches your indexers for SSS.'],
  ['prowlarr', 'Prowlarr', 'One Prowlarr, which searches your Usenet indexers for SSS.'],
];

function renderBody({ cfg, flash, isAdmin, check }) {
  const c = cfg || {};
  const state = pipeline.status(c);
  const kind = pipeline.sourceKind(c);
  const chip = (ok, yes, no) => '<span class="chip" data-tone="' + (ok ? 'ok' : 'off') + '">' + esc(ok ? yes : no) + '</span>';
  const input = (name, value, extra) => '<input class="t" name="' + name + '" value="' + esc(value) + '"' + (extra || '') + '>';
  const field = (label, name, value, extra) => '<label class="f"><span>' + esc(label) + '</span>' + input(name, value, extra) + '</label>';
  const warn = /fail|invalid|must|could not|required/i.test(String(flash || ''));

  // Saved Newznab indexers, then empty rows to add more (always at least two).
  const saved = pipeline.newznabIndexers(c);
  const rows = saved.concat(Array.from({ length: 2 }, () => ({}))).slice(0, pipeline.MAX_NEWZNAB_INDEXERS);
  const newznab = '<div data-source="newznab"><p class="text-secondary small">One row per indexer; save to get more empty rows. Clear a row\'s URL to remove it. Up to '
    + pipeline.MAX_NEWZNAB_INDEXERS + '.</p>'
    + rows.map((row, i) => '<div class="grid-3" style="margin-bottom:10px">'
      + field('Name', 'nzIndexerName', row.name, (i ? '' : ' placeholder="NZBGeek"') + ' maxlength="80"')
      + field('URL', 'nzIndexerUrl', row.url, ' type="url"' + (i ? '' : ' placeholder="https://api.nzbgeek.info"') + ' autocomplete="off"')
      + field('API key', 'nzIndexerApiKey', row.apiKey, ' type="password" autocomplete="off"')
      + '</div>').join('')
    + '</div>';
  const single = '<div data-source="nzbhydra prowlarr"><div class="grid-3">'
    + field('Name', 'tbuSearchName', c.tbuSearchName, ' placeholder="NZBHydra" maxlength="80"')
    + field('URL', 'tbuSearchUrl', kind === 'newznab' ? '' : c.tbuSearchUrl, ' type="url" placeholder="https://hydra.example.com" autocomplete="off"')
    + field('API key', 'tbuSearchApiKey', kind === 'newznab' ? '' : c.tbuSearchApiKey, ' type="password" autocomplete="off"')
    + '</div></div>';

  return '<div class="lede"><h2>TorBox Usenet</h2><p>SSS searches your own Usenet indexers and hands the release to your TorBox, which downloads it and plays it to you. Nothing streams through this server, and it is separate from every other pipeline.</p></div>'
    + (flash ? '<div class="alert ' + (warn ? 'alert-warning' : 'alert-success') + '">' + esc(flash) + '</div>' : '')
    + (check ? '<section class="panel"><div class="panel-head"><div><h3>Check result</h3><p>'
      + (check.ok ? 'Everything works. TorBox Usenet rows will appear when you open an event.' : 'Stopped at the step marked Failed.')
      + '</p></div></div><div class="panel-body"><ol class="mb-0">' + check.steps.map((st) => '<li><strong>' + esc(st.name) + '</strong> '
        + '<span class="chip" data-tone="' + (st.ok ? 'ok' : 'bad') + '">' + (st.ok ? 'OK' : 'Failed') + '</span> <span class="text-secondary">' + esc(st.detail) + '</span></li>').join('')
      + '</ol></div></section>' : '')
    + '<form method="POST" action="/account/torbox-usenet/save">'
    + '<section class="panel"><div class="panel-head"><div><h3>Status</h3><p>All three are needed before rows appear.</p></div></div><div class="panel-body">'
    + '<div class="d-flex flex-wrap gap-2">' + chip(state.enabled, 'Switched on', 'Switched off')
    + chip(state.indexer, state.indexers + ' search source' + (state.indexers === 1 ? '' : 's') + ' set', 'No search source') + chip(state.torbox, 'TorBox key set', 'No TorBox key: add it on Configure') + '</div>'
    + '<label class="form-check form-switch"><input class="form-check-input" type="checkbox" name="torboxUsenetEnabled" value="on"' + (state.enabled ? ' checked' : '') + '><span class="form-check-label"><strong>Use TorBox Usenet</strong></span></label>'
    + '<p class="text-secondary small mb-0">Your TorBox plan must include Usenet downloads.</p>'
    + '</div></section>'
    + '<section class="panel"><div class="panel-head"><div><h3>Where to search</h3><p>Choose one.' + (isAdmin ? '' : ' Every address must be reachable on the public internet.') + '</p></div></div><div class="panel-body">'
    + '<div class="grid-3">' + SOURCES.map(([value, label, hint]) => '<label class="form-check"><input class="form-check-input" type="radio" name="tbuSearchKind" value="' + value + '"'
      + (kind === value ? ' checked' : '') + '><span class="form-check-label"><strong>' + esc(label) + '</strong><span class="d-block text-secondary small">' + esc(hint) + '</span></span></label>').join('') + '</div>'
    + newznab + single
    + '<div class="d-flex gap-2 align-items-end" style="margin-top:12px">' + field('Test search', 'tbuTestQuery', 'UFC', ' maxlength="200"')
    + '<button class="btn ghost" type="submit" formaction="/account/torbox-usenet/test" formnovalidate>Test search</button></div>'
    + '</div></section>'
    + '<section class="panel"><div class="panel-head"><div><h3>NZBs checked per event</h3><p>How many of the top results are checked against TorBox when you open an event.</p></div></div><div class="panel-body">'
    + '<label class="f" style="max-width:220px"><span>Number checked (0–' + pipeline.MAX_CHECK_COUNT + ')</span><input class="t" type="number" min="0" max="' + pipeline.MAX_CHECK_COUNT + '" name="torboxUsenetCheckCount" value="' + esc(pipeline.checkCount(c)) + '"></label>'
    + '<p class="text-secondary small mb-0">A checked result shows as Instant (already in your TorBox) or Cached (TorBox has it). Checking downloads the NZB from your indexer, which counts against its daily download limit. 0 checks none; every row then shows Queue until you play it.</p>'
    + '</div></section>'
    + '<div class="d-flex gap-2 flex-wrap"><button class="btn primary" type="submit">Save</button>'
    + '<button class="btn ghost" type="submit" formaction="/account/torbox-usenet/check" formnovalidate title="Uses your saved settings. Downloads one NZB; adds nothing to TorBox.">Check TorBox Usenet</button>'
    + '<a class="btn ghost" href="/account">Back to Configure</a></div>'
    + '<p class="text-secondary small">Check TorBox Usenet uses your saved settings: it searches, downloads one NZB and asks TorBox whether it has it. Nothing is added to your TorBox.</p>'
    + '</form>'
    // Show only the chosen source's fields. Without script both show and the
    // server uses the ones for the chosen source.
    + '<script>(function(){var f=document.querySelector(\'form[action="/account/torbox-usenet/save"]\');if(!f)return;'
    + 'function sync(){var k=(f.querySelector(\'input[name="tbuSearchKind"]:checked\')||{}).value||"newznab";'
    + 'f.querySelectorAll("[data-source]").forEach(function(el){el.hidden=el.getAttribute("data-source").split(" ").indexOf(k)<0;});}'
    + 'f.addEventListener("change",function(e){if(e.target.name==="tbuSearchKind")sync();});sync();})();</script>';
}

module.exports = { renderBody };
