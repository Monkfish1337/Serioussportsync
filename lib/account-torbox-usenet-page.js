'use strict';

// TorBox Usenet settings, one page per account: its own indexer, how many
// NZBs are checked per event, and a test search. A separate pipeline from
// built-in Usenet; the on/off switch is here and on Configure.

const pipeline = require('./torbox-usenet-pipeline');

const esc = (value) => String(value === undefined || value === null ? '' : value)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderBody({ cfg, flash, isAdmin }) {
  const c = cfg || {};
  const state = pipeline.status(c);
  const chip = (ok, yes, no) => '<span class="chip" data-tone="' + (ok ? 'ok' : 'off') + '">' + esc(ok ? yes : no) + '</span>';
  const field = (label, name, value, extra) => '<label class="f"><span>' + esc(label) + '</span><input class="t" name="' + name + '" value="' + esc(value) + '"' + (extra || '') + '></label>';
  const warn = /fail|invalid|must|could not|required/i.test(String(flash || ''));
  return '<div class="lede"><h2>TorBox Usenet</h2><p>SSS searches your own Usenet indexer and hands the release to your TorBox, which downloads it and plays it to you. Nothing streams through this server, and it is separate from every other pipeline.</p></div>'
    + (flash ? '<div class="alert ' + (warn ? 'alert-warning' : 'alert-success') + '">' + esc(flash) + '</div>' : '')
    + '<form method="POST" action="/account/torbox-usenet/save">'
    + '<section class="panel"><div class="panel-head"><div><h3>Status</h3><p>All three are needed before rows appear.</p></div></div><div class="panel-body">'
    + '<div class="d-flex flex-wrap gap-2">' + chip(state.enabled, 'Switched on', 'Switched off') + chip(state.indexer, 'Indexer set', 'No indexer') + chip(state.torbox, 'TorBox key set', 'No TorBox key: add it on Configure') + '</div>'
    + '<label class="form-check form-switch"><input class="form-check-input" type="checkbox" name="torboxUsenetEnabled" value="on"' + (state.enabled ? ' checked' : '') + '><span class="form-check-label"><strong>Use TorBox Usenet</strong></span></label>'
    + '<p class="text-secondary small mb-0">Your TorBox plan must include Usenet downloads.</p>'
    + '</div></section>'
    + '<section class="panel"><div class="panel-head"><div><h3>Your indexer</h3><p>Newznab (NZBGeek, DrunkenSlug…), NZBHydra or Prowlarr.' + (isAdmin ? '' : ' It must be reachable on the public internet.') + '</p></div></div><div class="panel-body">'
    + '<div class="grid-2">'
    + '<label class="f"><span>Type</span><select class="t" name="tbuSearchKind"><option value="newznab"' + (c.tbuSearchKind !== 'prowlarr' ? ' selected' : '') + '>Newznab / NZBHydra</option><option value="prowlarr"' + (c.tbuSearchKind === 'prowlarr' ? ' selected' : '') + '>Prowlarr</option></select></label>'
    + field('Display name', 'tbuSearchName', c.tbuSearchName, ' placeholder="NZBGeek" maxlength="80"')
    + field('Indexer URL', 'tbuSearchUrl', c.tbuSearchUrl, ' type="url" placeholder="https://api.nzbgeek.info" autocomplete="off"')
    + field('API key', 'tbuSearchApiKey', c.tbuSearchApiKey, ' type="password" autocomplete="off"')
    + field('Test search', 'tbuTestQuery', 'UFC', ' maxlength="200"')
    + '<div style="align-self:end"><button class="btn ghost" type="submit" formaction="/account/torbox-usenet/test" formnovalidate>Test search</button></div>'
    + '</div></div></section>'
    + '<section class="panel"><div class="panel-head"><div><h3>NZBs checked per event</h3><p>How many of the top results are checked against TorBox when you open an event.</p></div></div><div class="panel-body">'
    + '<label class="f" style="max-width:220px"><span>Number checked (0–' + pipeline.MAX_CHECK_COUNT + ')</span><input class="t" type="number" min="0" max="' + pipeline.MAX_CHECK_COUNT + '" name="torboxUsenetCheckCount" value="' + esc(pipeline.checkCount(c)) + '"></label>'
    + '<p class="text-secondary small mb-0">A checked result shows ⚡ Instant (already in your TorBox) or \u{1F4E6} Cached (TorBox has it). Checking downloads the NZB from your indexer, which counts against its daily download limit. 0 checks none; every row then shows ⏳ Queue until you play it.</p>'
    + '</div></section>'
    + '<div class="d-flex gap-2"><button class="btn primary" type="submit">Save</button><a class="btn ghost" href="/account">Back to Configure</a></div>'
    + '</form>';
}

module.exports = { renderBody };
