'use strict';

const { escapeHtml } = require('./tabler-chrome');

const CATEGORY_LABELS = Object.freeze({
  americanfootball: 'American football', basketball: 'Basketball', baseball: 'Baseball',
  football: 'Football', hockey: 'Hockey', rugby: 'Rugby / AFL / GAA', other: 'Other sport',
});

// Releases found only on a dated archive page have no sport label of their own.
// They are listed and filterable like any other row rather than hidden.
const ARCHIVE_LABEL = 'From archive';

function categoryLabel(value) {
  if (value === 'archive') return ARCHIVE_LABEL;
  return CATEGORY_LABELS[value] || value || 'Unknown';
}

function formatTime(value) {
  if (!value) return 'Not yet';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString('en-GB',{timeZone:require('./settings').getDisplayTimeZone()});
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (!bytes) return 'Unknown size';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return (bytes / Math.pow(1024, power)).toFixed(power > 2 ? 2 : 1) + ' ' + units[power];
}

function badge(state) {
  const map = {
    cached: ['Ready', 'ok'], warmable: ['Warmable', 'warn'],
    prepare: ['Needs preparation', 'info'], unmatched: ['Unmatched', 'off'],
    filtered: ['Filtered out', 'off'], error: ['Prepare failed', 'bad'],
  };
  const value = map[state] || [state, 'off'];
  return '<span class="chip" data-tone="' + value[1] + '">' + escapeHtml(value[0]) + '</span>';
}

function row(record, cached, torboxConfigured) {
  const matches = Array.isArray(record.matches) ? record.matches : [];
  const match = matches[0];
  let state = record.matchExclusion ? 'filtered' : 'unmatched';
  if (match && record.prepareError) state = 'error';
  else if (match && !record.infoHash) state = 'prepare';
  else if (match && cached) state = 'cached';
  else if (match && record.infoHash) state = 'warmable';
  const matchHtml = match
    ? escapeHtml(match.eventTitle) + '<span class="row-sub">'
      + escapeHtml(match.promotion) + (matches.length > 1 ? ' · +' + (matches.length - 1) + ' match' : '') + '</span>'
    : (record.matchExclusion
      ? 'Rejected before matching<span class="row-sub">' + escapeHtml(record.matchExclusion) + '</span>'
      : '<span class="row-sub">No current SSS event</span>');
  let action = '';
  if (match && !record.infoHash) {
    action = '<form method="POST" action="/admin/sport-video/prepare/' + encodeURIComponent(record.id) + '">'
      + '<button class="btn sm ghost" type="submit">Prepare</button></form>';
  } else if (match && record.infoHash && !cached) {
    action = torboxConfigured
      ? '<form method="POST" action="/admin/sport-video/warm/' + encodeURIComponent(record.id) + '">'
        + '<button class="btn sm primary" type="submit">Warm to TorBox</button></form>'
      : '<span class="row-sub">Add a TorBox key in Account</span>';
  }
  return '<tr data-search="' + escapeHtml([record.title, record.category, match && match.eventTitle, state].join(' ').toLowerCase())
    + '" data-state="' + escapeHtml(state) + '" data-category="' + escapeHtml(record.category) + '">'
    + '<td class="tabular" style="white-space:nowrap">' + escapeHtml(record.date || 'Unknown') + '</td>'
    + '<td>' + escapeHtml(record.title) + '<span class="row-sub">'
      + escapeHtml(record.resolution || record.video || '') + (record.language ? ' · ' + escapeHtml(record.language) : '')
      + (record.infoHash ? ' · ' + escapeHtml(formatBytes(record.size)) : '') + '</span></td>'
    + '<td>' + escapeHtml(categoryLabel(record.category)) + '</td>'
    + '<td>' + matchHtml + '</td><td>' + badge(state)
      + (record.prepareError ? '<span class="row-sub">' + escapeHtml(record.prepareError) + '</span>' : '')
      + (record.prepareRetryAt ? '<span class="row-sub">Retry: ' + escapeHtml(require('./display-time').displayTime(record.prepareRetryAt)) + '</span>' : '')
      + '</td><td>' + action + '</td></tr>';
}

// A folded settings group. `state` is the point: a section you cannot see must
// still say what it is set to, or folding it away is just hiding state from the
// operator. `open` starts it expanded when it holds something non-default.
// <details>, never `disabled`: a closed <details> still submits its inputs,
// where a disabled input submits nothing and clears the setting on save.
function section(title, state, body, open) {
  return '<details class="sv-section"' + (open ? ' open' : '')
    + ' data-sv-section="' + escapeHtml(title.toLowerCase().replace(/[^a-z]+/g, '-')) + '">'
    + '<summary>' + escapeHtml(title)
    + (state ? '<span class="sv-section-state">' + escapeHtml(state) + '</span>' : '')
    + '</summary><div class="sv-section-body">' + body + '</div></details>';
}

function plural(count, word) {
  return count + ' ' + word + (count === 1 ? '' : 's');
}

const STYLE = '<style>'
  + '.sv-stack>*+*{margin-top:14px}.sv-stack .panel,.sv-stack .fold{margin:0}'
  + '.sv-stack .panel-head>div:first-child,.sv-stack .fold>summary>div{flex:1;min-width:0}'
  + '.sv-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}'
  + '.sv-form>*+*{margin-top:14px}'
  + '.sv-label{display:block;font-size:11px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3);margin-bottom:8px}'
  + '.sv-picks{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px 16px}'
  + '.sv-teams{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}'
  + '.sv-teams select{height:9.5em}'
  + '.sv-dependent{transition:opacity .15s ease}.sv-dependent.is-inactive{opacity:.45}'
  + '.sv-dependent-note{display:none}.sv-dependent.is-inactive .sv-dependent-note{display:flex}'
  + '.sv-section{border:1px solid var(--line);border-radius:var(--r);background:var(--surface-2)}'
  + '.sv-section>summary{cursor:pointer;padding:11px 14px;font-weight:600;list-style:none;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}'
  + '.sv-section>summary::-webkit-details-marker{display:none}'
  + '.sv-section>summary::before{content:"\\25B8";display:inline-block;transition:transform .15s ease;color:var(--ink-3)}'
  + '.sv-section[open]>summary::before{transform:rotate(90deg)}'
  + '.sv-section-state{font-weight:400;font-size:12px;color:var(--ink-3)}'
  + '.sv-section-body{padding:0 14px 14px}.sv-section-body>*+*{margin-top:12px}'
  + '.sv-filters{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.sv-filters input{flex:1;min-width:200px}.sv-filters select{width:auto}'
  + '.sv-actions{display:flex;gap:8px;flex-wrap:wrap}.sv-actions form{margin:0}'
  + '.panel>.tbl-wrap .tbl th:first-child,.panel>.tbl-wrap .tbl td:first-child{padding-left:18px}'
  + '.sv-examples{margin:6px 0 0;padding-left:18px;font-size:12px}'
  + '</style>';

function renderBody(data) {
  const cfg = data.config || {};
  const status = data.status || {};
  const releases = data.releases || [];
  const cached = data.cached || new Set();
  // One picker per promotion that fields two named sides, built from the
  // catalog rather than a hardcoded roster. Selecting nothing means no filter,
  // which is how boxing and anything else without a recurring line-up keeps
  // preparing everything it matches.
  const selected = cfg.teamFilters || {};
  const teamGroups = (data.catalogTeams || []).filter((group) => group.teams.length >= 2);
  const teamFilterBlock = teamGroups.length
    ? '<p class="hint">Limits automatic preparation and warming to these teams. Everything is still matched and listed, and the buttons ignore it. Nothing selected means no limit. Ctrl- or Cmd-click to pick several; the number is fixtures in the last 120 days.</p>'
      + '<div class="sv-teams">'
      + teamGroups.map(function group(entry) {
        const chosen = selected[entry.promotion] || [];
        return '<label class="f"><span>' + escapeHtml(entry.promotionName)
          + (chosen.length ? ' · ' + chosen.length + ' selected' : ' · all')
          + '</span><select class="t" name="teamFilter:' + escapeHtml(entry.promotion) + '" multiple>'
          + entry.teams.map(function option(team) {
            return '<option value="' + escapeHtml(team.name) + '"'
              + (chosen.includes(team.name) ? ' selected' : '') + '>'
              + escapeHtml(team.name) + ' (' + team.fixtures + ')</option>';
          }).join('')
          + '</select></label>';
      }).join('')
      + '</div>'
    : '';
  const warmChecks = (data.promotions || []).map((promotion) =>
    '<label class="sw"><input type="checkbox" name="autoWarmPromotions" value="'
      + escapeHtml(promotion.id) + '"' + ((cfg.autoWarmPromotions || []).includes(promotion.id) ? ' checked' : '')
      + '><i></i><b>' + escapeHtml(promotion.name) + '</b></label>').join('')
    || '<span class="hint">No promotions are enabled yet.</span>';
  const checkboxes = Object.entries(CATEGORY_LABELS).map(([value, label]) =>
    '<label class="sw"><input type="checkbox" name="categories" value="'
      + escapeHtml(value) + '"' + ((cfg.categories || []).includes(value) ? ' checked' : '') + '><i></i><b>'
      + escapeHtml(label) + '</b></label>').join('');
  // Values the folded summaries quote, resolved once so the summary and the
  // input inside the section can never disagree.
  const autoWarmPerScan = cfg.autoWarmPerScan === undefined ? 5 : cfg.autoWarmPerScan;
  const autoWarmWindowDays = cfg.autoWarmWindowDays === undefined ? 14 : cfg.autoWarmWindowDays;
  const archivePages = cfg.archivePages === undefined ? 12 : cfg.archivePages;
  const warmCount = (cfg.autoWarmPromotions || []).length;
  const warmSummary = warmCount
    ? plural(warmCount, 'promotion') + ' · up to ' + autoWarmPerScan
      + ' per scan · last ' + plural(autoWarmWindowDays, 'day')
    : 'Off — every release stays a manual click';
  const teamFilterCount = Object.keys(selected)
    .filter((promotion) => (selected[promotion] || []).length).length;
  const teamSummary = teamFilterCount
    ? plural(teamFilterCount, 'promotion') + ' limited to chosen teams'
    : 'Not limited — every matched fixture is prepared';

  const rows = releases.map((record) => row(record, cached.has(String(record.infoHash || '').toLowerCase()), data.torboxConfigured)).join('');
  const flash = data.flash ? '<div class="note" data-tone="info"><div><b>' + escapeHtml(data.flash) + '</b></div></div>' : '';
  const stateChip = status.running ? ['info', 'Scanning'] : cfg.enabled ? ['ok', 'On'] : ['off', 'Off'];
  const prepared = status.preparedMatched === undefined ? (status.prepared || 0) : status.preparedMatched;

  const summary = '<section class="panel"><div class="panel-head"><div><h3>Sport-Video</h3>'
    + '<p>Releases from sport-video.org.ua, matched to SSS events. Scanning is read-only; warming is your choice.</p></div>'
    + '<span class="chip" data-tone="' + stateChip[0] + '">' + stateChip[1] + '</span></div><div class="panel-body">'
    + '<div class="sv-stats">'
    + [['Discovered', status.releases || 0, (status.fromArchive || 0) + ' from archive'],
      ['Matched', status.matched || 0, 'to SSS events'],
      ['Prepared', prepared, status.preparedOrphans ? status.preparedOrphans + ' no longer matched' : 'torrent known'],
      ['Ready on TorBox', cached.size || 0, data.torboxConfigured ? 'this admin account' : 'no TorBox key']]
      .map(([label, value, detail]) => '<div class="stat"><b>' + escapeHtml(value) + '</b><span>' + escapeHtml(label) + '</span><em>' + escapeHtml(detail) + '</em></div>').join('')
    + '</div>'
    + (status.lastError
      ? '<div class="note" data-tone="bad"><div><b>Last scan failed</b><span>' + escapeHtml(status.lastError) + '</span></div></div>'
      : '<p class="hint">Last scan: ' + escapeHtml(formatTime(status.completedAt)) + ' · ' + escapeHtml(status.current || 'Idle') + ' · no errors.</p>')
    + '</div><div class="panel-foot">'
    + '<form method="POST" action="/admin/sport-video/scan"><button class="btn primary" type="submit"'
      + (status.running ? ' disabled' : '') + '>' + (status.running ? 'Scan running…' : 'Scan now') + '</button></form>'
    + '<form method="POST" action="/admin/sport-video/rematch"><button class="btn ghost" type="submit"'
      + (status.running ? ' disabled' : '') + ' title="Re-check stored releases against the current events without fetching anything">Re-match events</button></form></div></section>';

  // The four counts that explain a release you expected and did not get.
  const why = '<details class="fold"><summary><div><h3>Why a release is missing</h3><p>'
    + (status.unmatched || 0) + ' unmatched · ' + (status.filtered || 0) + ' filtered · ' + (status.outsideWindow || 0) + ' too old · ' + (status.outsideTeamFilter || 0) + ' outside team limits</p></div></summary><div class="fold-body">'
    + '<div class="sv-stats">'
    + [['Unmatched', status.unmatched || 0, 'no current SSS event'],
      ['Filtered out', status.filtered || 0, 'rejected before matching'],
      ['Outside window', status.outsideWindow || 0, 'matched but too old'],
      ['Team filter', status.outsideTeamFilter || 0, 'outside team limits']]
      .map(([label, value, detail]) => '<div class="stat"><b>' + escapeHtml(value) + '</b><span>' + escapeHtml(label) + '</span><em>' + escapeHtml(detail) + '</em></div>').join('')
    + '</div>'
    + section('Scan details', String(status.discoverySource || 'Not yet run'),
      '<div class="sv-stats">'
      + [['Search index entries', status.searchIndexEntries || 0], ['Archive pages read', status.archivePagesRead || 0], ['Last re-match', formatTime(status.lastRematchAt)]]
        .map(([label, value]) => '<div class="stat"><b style="font-size:18px">' + escapeHtml(value) + '</b><span>' + escapeHtml(label) + '</span></div>').join('')
      + '</div>'
      // Discussions #40: how often a page offers several torrents (quality
      // variants). Only the first is used today.
      + '<p class="hint">Pages with several torrents: '
        + (status.variantPagesChecked
          ? escapeHtml(status.multiVariantPages || 0) + ' of ' + escapeHtml(status.variantPagesChecked) + ' prepared pages'
          : 'Measured from the next prepared page')
        + '. Only the first torrent on a page is used.</p>'
      + ((status.multiVariantExamples || []).length
        ? '<ul class="sv-examples">'
          + status.multiVariantExamples.map(function example(item) {
            return '<li>' + escapeHtml(item.title) + ' · ' + escapeHtml(item.count) + ' torrents'
              + (item.names.length ? '<span class="row-sub">' + item.names.map(escapeHtml).join('<br>') + '</span>' : '')
              + '</li>';
          }).join('') + '</ul>'
        : ''),
      false)
    + '</div></details>';

  const settings = '<details class="fold"><summary><div><h3>Settings</h3><p>'
    + (cfg.enabled ? 'On' : 'Off') + (cfg.autoScan ? ' · scans every ' + (cfg.intervalHours || 6) + ' h' : ' · manual scans') + ' · ' + plural((cfg.categories || []).length, 'sport')
    + ' · warming ' + (warmCount ? 'on' : 'off') + '</p></div></summary><div class="fold-body">'
    + '<form method="POST" action="/admin/sport-video/settings" class="sv-form">'
    // Everything under the master switch is dimmed and labelled while it is
    // off, not disabled: a disabled input submits nothing, so disabling these
    // would silently clear them the next time the form was saved.
    + '<label class="sw"><input type="checkbox" id="sv-enabled" name="enabled" value="on"'
      + (cfg.enabled ? ' checked' : '') + '><i></i><b>Enable Sport-Video results<small>Adds matched releases to TorBox results.</small></b></label>'
    + '<div class="' + 'sv-dependent' + (cfg.enabled ? '' : ' is-inactive') + '" id="sv-dependent"><div class="sv-form">'
    + '<div class="note sv-dependent-note" data-tone="warn" role="status"><div><b>Saved, but nothing below runs while Sport-Video results are off.</b></div></div>'
    + '<label class="sw"><input type="checkbox" name="autoScan" value="on"'
      + (cfg.autoScan ? ' checked' : '') + '><i></i><b>Scan automatically<small>Reads the site; adds nothing to TorBox.</small></b></label>'
    + '<div><span class="sv-label">Sports</span><div class="sv-picks">' + checkboxes + '</div></div>'
    + '<div class="grid-2"><label class="f"><span>Every (hours)</span><input class="t" type="number" min="1" max="168" step="1" name="intervalHours" value="'
      + escapeHtml(cfg.intervalHours || 6) + '"></label></div>'
    // Warming submits torrents to TorBox on the operator's account, so it gets
    // its own section and its summary says plainly whether anything is armed.
    + section('Automatic warming', warmSummary,
      '<p class="hint">Sends matched, prepared releases of these promotions to TorBox during a scan, for accounts with a TorBox key and that catalog on.</p>'
      + '<div class="sv-picks">' + warmChecks + '</div>'
      + '<div class="grid-2"><label class="f"><span>Releases per scan</span><input class="t" type="number" min="1" max="50" name="autoWarmPerScan" value="'
        + escapeHtml(autoWarmPerScan) + '"></label>'
      + '<label class="f"><span>Window (days)</span><input class="t" type="number" min="1" max="90" name="autoWarmWindowDays" value="'
        + escapeHtml(autoWarmWindowDays) + '"></label></div>'
      + '<p class="hint">Older fixtures are skipped: TorBox keeps a cached copy about 30 days. The Prepare and Warm buttons ignore the window.</p>',
      (cfg.autoWarmPromotions || []).length > 0)
    + (teamFilterBlock ? section('Team limits', teamSummary, teamFilterBlock, teamFilterCount > 0) : '')
    + section('Advanced tuning', 'Startup delay, prepare limit, archive fallback',
      '<div class="grid-3">'
      + '<label class="f"><span>Startup delay (s)</span><input class="t" type="number" min="10" max="3600" name="startDelaySeconds" value="'
        + escapeHtml(cfg.startDelaySeconds || 90) + '"></label>'
      + '<label class="f"><span>Prepare per scan</span><input class="t" type="number" min="1" max="200" name="maxDetailsPerScan" value="'
        + escapeHtml(cfg.maxDetailsPerScan || 50) + '"></label>'
      + '<label class="f"><span>Archive pages per scan</span><input class="t" type="number" min="0" max="60" name="archivePages" value="'
        + escapeHtml(archivePages) + '"></label></div>'
      + '<p class="hint">Archive pages are a fallback when the search index cannot be read: about 60 releases each, newest first. 0 reads the sport pages only.</p>',
      false)
    + '</div></div>'
    + '<p class="hint">Fixed to sport-video.org.ua; other URLs and redirects are rejected. Availability and rights vary by release.</p>'
    + '<div><button class="btn primary" type="submit">Save settings</button></div></form></div></details>'
    + '<script>(function(){var master=document.getElementById("sv-enabled"),block=document.getElementById("sv-dependent");'
    + 'if(!master||!block)return;function sync(){block.classList.toggle("is-inactive",!master.checked);}'
    + 'master.addEventListener("change",sync);sync();})();</script>'
    // Remember which sections were left open. Storage throws in some privacy
    // modes, so every access is wrapped.
    + '<script>(function(){'
    + 'var key="sss.sv.sections";var saved={};'
    + 'try{saved=JSON.parse(localStorage.getItem(key)||"{}")||{};}catch(e){saved={};}'
    + 'var all=document.querySelectorAll("details[data-sv-section]");'
    + 'all.forEach(function(item){var id=item.getAttribute("data-sv-section");'
    + 'if(Object.prototype.hasOwnProperty.call(saved,id))item.open=!!saved[id];'
    + 'item.addEventListener("toggle",function(){saved[id]=item.open;'
    + 'try{localStorage.setItem(key,JSON.stringify(saved));}catch(e){}});});'
    + '})();</script>';

  const diagnostics = '<details class="fold"><summary><div><h3>Match diagnostics</h3><p>Download every event in a window with its queries, nearby releases and why each was rejected.</p></div></summary><div class="fold-body">'
    + '<form method="GET" action="/admin/sport-video/diagnostics.csv" id="sv-diag" class="sv-form"><div class="grid-2">'
    + '<label class="f"><span>Promotion</span><select class="t" name="promotion"><option value="">All promotions</option>'
      + (data.promotions || []).map(function promotionOption(promotion) {
        return '<option value="' + escapeHtml(promotion.id) + '">' + escapeHtml(promotion.name) + '</option>';
      }).join('') + '</select></label>'
    + '<label class="f"><span>Days either side of today</span><input class="t" type="number" min="1" max="3650" name="days" value="60"></label></div>'
    + '<div class="sv-actions"><button class="btn primary" type="submit">Download CSV</button>'
      + '<button class="btn ghost" type="submit" formaction="/admin/sport-video/diagnostics.json">Download JSON</button></div>'
    + '<p class="hint">CSV: one row per event and release. JSON: full alias and query lists. No torrent URLs in either.</p>'
    + '</form></div></details>';

  const list = '<section class="panel"><div class="panel-head"><div><h3>Discovered releases</h3><p>Newest 200 kept. Matched to an event before any TorBox check.</p></div></div>'
    + '<div class="panel-body"><div class="sv-filters"><input id="sv-search" class="t" type="search" placeholder="Filter by release, event or promotion">'
    + '<select id="sv-state" class="t"><option value="">All states</option><option value="cached">Ready</option><option value="warmable">Warmable</option><option value="prepare">Needs preparation</option><option value="unmatched">Unmatched</option><option value="filtered">Filtered out</option><option value="error">Errors</option></select>'
    + '<select id="sv-category" class="t"><option value="">All sports</option>'
    + Object.entries(CATEGORY_LABELS).concat([['archive', ARCHIVE_LABEL]]).map(function categoryOption(entry) { return '<option value="' + escapeHtml(entry[0]) + '">' + escapeHtml(entry[1]) + '</option>'; }).join('') + '</select>'
    + '<span id="sv-count" class="hint" style="margin:0">' + releases.length + ' shown</span></div></div>'
    + '<div class="tbl-wrap tbl-scroll"><table class="tbl"><thead><tr><th>Date</th><th>Source release</th><th>Sport</th><th>Matched SSS event</th><th>State</th><th></th></tr></thead><tbody id="sv-rows">'
    + (rows || '<tr><td colspan="6">Nothing discovered yet. Turn the source on and run a scan.</td></tr>')
    + '</tbody></table></div></section>'
    + '<script>(function(){var q=document.getElementById("sv-search"),s=document.getElementById("sv-state"),g=document.getElementById("sv-category"),c=document.getElementById("sv-count");function f(){var text=(q.value||"").toLowerCase(),state=s.value,category=g.value,n=0;document.querySelectorAll("#sv-rows tr[data-search]").forEach(function(r){var show=(!text||r.dataset.search.indexOf(text)>=0)&&(!state||r.dataset.state===state)&&(!category||r.dataset.category===category);r.hidden=!show;if(show)n++;});c.textContent=n+" shown";}q.addEventListener("input",f);s.addEventListener("change",f);g.addEventListener("change",f);}());</script>';

  return STYLE + flash + '<div class="sv-stack">' + summary + list + why + settings + diagnostics + '</div>';
}

module.exports = { renderBody, CATEGORY_LABELS };
