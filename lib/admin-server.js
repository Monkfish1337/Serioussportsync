'use strict';

// Server page (issue #72): what applies to the whole instance. Sources first,
// then timing, then display. Moved out of addon.js and rebuilt from the native
// components; each fold's summary carries its state so nothing is hidden by
// closing it.

const settings = require('./settings');
const { escapeHtml } = require('./ui/shell');

const STYLE = '<style>'
  + '.sv2-stack>*+*{margin-top:14px}.sv2-stack .panel,.sv2-stack .fold{margin:0}'
  + '.sv2-stack .panel-head>div:first-child,.sv2-stack .fold>summary>div{flex:1;min-width:0}'
  + '.sv2-form>*+*{margin-top:14px}'
  + '.sv2-src{border:1px solid var(--line);border-radius:var(--r);background:var(--surface-2)}'
  + '.sv2-src>summary{display:flex;gap:10px;align-items:center;padding:11px 14px;cursor:pointer;list-style:none}'
  + '.sv2-src>summary::-webkit-details-marker{display:none}'
  + '.sv2-src>summary b{flex:1}.sv2-src>summary small{color:var(--ink-3);font-weight:400;display:block}'
  + '.sv2-src-body{padding:0 14px 14px}.sv2-src-body>*+*{margin-top:12px}'
  + '.sv2-chips{display:flex;gap:6px;flex-wrap:wrap}'
  + '.sv2-picks{display:flex;flex-wrap:wrap;gap:10px 18px}'
  + '.sv2-skins{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px}'
  + '.sv2-skin{display:block;cursor:pointer;border:1px solid var(--line);border-radius:var(--r);padding:12px;background:var(--surface-2)}'
  + '.sv2-skin:has(input:checked){border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}'
  + '.sv2-skin input{margin-right:7px}'
  + '.sv2-swatch{display:flex;gap:5px;align-items:center;margin:9px 0 7px}'
  + '.sv2-swatch i{width:26px;height:26px;border:1px solid rgba(128,128,128,.35)}'
  + '.sv2-swatch em{flex:1;height:26px;border:1px solid rgba(128,128,128,.35)}'
  + '.sv2-inline{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}.sv2-inline label.f{flex:1;min-width:220px}'
  + '</style>';

function secretField(label, name, value, placeholder) {
  return '<label class="f"><span>' + escapeHtml(label) + '</span><div class="urlbox">'
    + '<input class="t mono" type="password" name="' + escapeHtml(name) + '" value="' + escapeHtml(value || '')
    + '" placeholder="' + escapeHtml(placeholder || '') + '" autocomplete="off">'
    + '<button type="button" class="btn ghost sm btn-reveal">Show</button></div></label>';
}

function toggle(name, label, enabled, hint) {
  return '<label class="sw"><input type="checkbox" name="' + escapeHtml(name) + '" value="1"' + (enabled ? ' checked' : '')
    + '><i></i><b>' + escapeHtml(label) + (hint ? '<small>' + escapeHtml(hint) + '</small>' : '') + '</b></label>';
}

function field(label, name, value, attrs, hint) {
  return '<label class="f"><span>' + escapeHtml(label) + '</span><input class="t mono" name="' + escapeHtml(name)
    + '" value="' + escapeHtml(String(value == null ? '' : value)) + '" ' + (attrs || '') + ' autocomplete="off">'
    + (hint ? '<div class="hint">' + hint + '</div>' : '') + '</label>';
}

// One source: its name, what it is and whether it is on, visible while closed.
function source(opts) {
  return '<details class="sv2-src"' + (opts.open ? ' open' : '') + '><summary><b>' + escapeHtml(opts.title)
    + '<small>' + opts.summary + '</small></b>'
    + '<span class="chip" data-tone="' + (opts.enabled ? 'ok' : 'off') + '">' + (opts.enabled ? 'On' : 'Off') + '</span></summary>'
    + '<div class="sv2-src-body">' + opts.body + '</div></details>';
}

function renderBody(currentUser, opts) {
  opts = opts || {};
  const comp = settings.getCompanion();
  const prowlarr = settings.getProwlarr();
  const bitmagnet = settings.getBitmagnet();
  const timing = settings.getDiscoveryTiming();
  const sportVideo = settings.getSportVideo();
  const skins = require('./skins');
  const activeSkin = settings.getAppearance().skin;
  const radiusLabel = (radius) => radius === '0px' ? 'sharp corners' : radius === '4px' ? 'default corners' : 'soft corners';

  const sources = [
    source({
      title: 'Companion scraper', enabled: comp.enabled && !!comp.url, open: !comp.url,
      summary: 'SeriousSportSync-Scraper, if you run one: Prowlarr, Zilean and Torznab behind one endpoint.',
      body: toggle('companionEnabled', 'Companion scraper enabled', comp.enabled, 'Off keeps the URL and token.')
        + field('Companion URL', 'companionUrl', comp.url, 'placeholder="http://scraper:8080"')
        + secretField('Companion auth token (optional)', 'companionAuthToken', comp.authToken, 'shared bearer if the scraper is internet-exposed'),
    }),
    source({
      title: 'Direct Bitmagnet', enabled: bitmagnet.enabled && !!bitmagnet.url, open: !bitmagnet.url,
      summary: 'Your own Bitmagnet index. Local, so it answers in milliseconds with info hashes.',
      body: toggle('bitmagnetEnabled', 'Direct Bitmagnet enabled', bitmagnet.enabled, 'Off keeps the URL and settings.')
        + '<div class="grid-2">'
        + field('Bitmagnet URL', 'bitmagnetUrl', bitmagnet.url, 'type="url" placeholder="http://bitmagnet:3333"', '<code>/graphql</code> is added automatically.')
        + field('Results per query', 'bitmagnetLimit', bitmagnet.limit, 'type="number" min="1" max="5000"', 'Ordered by seeders; a lower limit drops the tail.')
        + '</div>'
        + '<label class="sw"><input type="checkbox" name="bitmagnetVideoOnly" value="1"' + (bitmagnet.videoOnly ? ' checked' : '')
        + '><i></i><b>Video files only<small>Can hide the newest releases, which have no file list yet.</small></b></label>',
    }),
    source({
      title: 'Direct Prowlarr', enabled: prowlarr.enabled && !!(prowlarr.url && prowlarr.apiKey), open: !(prowlarr.url && prowlarr.apiKey),
      summary: 'Remote trackers through Prowlarr. Queue and saved releases: <a href="/admin/prowlarr-discovery">Discovery → Prowlarr</a>.',
      body: toggle('prowlarrEnabled', 'Direct Prowlarr enabled', prowlarr.enabled, 'Off keeps the URL and API key.')
        + '<input type="hidden" name="prowlarrLiveSearchPresent" value="1">'
        + toggle('prowlarrLiveSearchEnabled', 'Prowlarr live search enabled', prowlarr.liveSearchEnabled,
          'Off: playback uses saved releases only. The background queue and manual searches keep working.')
        + '<div class="grid-2">'
        + field('Prowlarr URL', 'prowlarrUrl', prowlarr.url, 'type="url" placeholder="http://prowlarr:9696"', 'Must be reachable from this container.')
        + secretField('Prowlarr API key', 'prowlarrApiKey', prowlarr.apiKey, 'Settings → General → Security')
        + '</div>',
    }),
    // Sport-Video's pipeline settings live here with the other sources; what
    // it does with a matched release stays on Discovery → Sport-Video.
    source({
      title: 'Sport-Video', enabled: sportVideo.enabled, open: false,
      summary: 'Releases from sport-video.org.ua, matched to your events. Off by default: it reaches a third-party site on a schedule.',
      body: toggle('sportVideoEnabled', 'Sport-Video enabled', sportVideo.enabled, 'Off keeps every Sport-Video setting.')
        + '<label class="sw"><input type="checkbox" name="sportVideoAutoScan" value="1"' + (sportVideo.autoScan ? ' checked' : '')
        + '><i></i><b>Scan on a schedule<small>Off: serves what is already matched, fetches nothing new.</small></b></label>'
        + '<div class="grid-3">'
        + field('Scan every (hours)', 'sportVideoIntervalHours', sportVideo.intervalHours, 'type="number" min="1" max="168"')
        + field('Prepared per scan', 'sportVideoMaxDetailsPerScan', sportVideo.maxDetailsPerScan, 'type="number" min="1" max="200"')
        + field('Archive pages per scan', 'sportVideoArchivePages', sportVideo.archivePages, 'type="number" min="0" max="60"')
        + '</div>'
        + '<div><span class="hint" style="display:block;margin:0 0 8px">Sports to scan (at least one)</span><div class="sv2-picks">'
        + settings.SPORT_VIDEO_CATEGORIES.map((category) => '<label class="sw"><input type="checkbox" name="sportVideoCategories" value="'
          + escapeHtml(category) + '"' + ((sportVideo.categories || []).includes(category) ? ' checked' : '') + '><i></i><b>' + escapeHtml(category) + '</b></label>').join('')
        + '</div></div>'
        + '<a class="btn ghost sm" href="/admin/discovery?tab=sport-video">Scans, matches and TorBox actions</a>',
    }),
  ];
  const onCount = [comp.enabled && comp.url, bitmagnet.enabled && bitmagnet.url, prowlarr.enabled && prowlarr.url && prowlarr.apiKey, sportVideo.enabled].filter(Boolean).length;

  // Discovery timing: the trade-off between waiting and finding more. These
  // were environment variables until they needed tuning without a redeploy.
  const timingFold = '<details class="sv2-src"><summary><b>Discovery timing'
    + '<small>Request ' + timing.pipelineBudgetMs + ' ms · discovery ' + timing.discoveryBudgetMs + ' ms · ' + timing.prowlarrMaxQueries + ' Prowlarr queries</small></b></summary>'
    + '<div class="sv2-src-body"><p class="hint" style="margin:0">Higher finds more but makes the client wait. Blank uses the environment variable, then the default.</p>'
    + '<div class="grid-2">'
    + field('Stream request budget (ms)', 'pipelineBudgetMs', timing.pipelineBudgetMs, 'type="number" min="2000" max="120000"',
      'The whole request. Default 9500. <strong>Nuvio gives up at about 10 s</strong>; above 10000 the user gets nothing.')
    + field('Discovery budget (ms)', 'discoveryBudgetMs', timing.discoveryBudgetMs, 'type="number" min="1000" max="120000"',
      'Searching only, held at least 1 s under the request budget. Default 5000.')
    + field('Prowlarr queries per request', 'prowlarrMaxQueries', timing.prowlarrMaxQueries, 'type="number" min="1" max="60"',
      'About 2 s each; the discovery budget decides how many finish. Default 6.')
    + field('Prowlarr per-query timeout (ms)', 'prowlarrQueryTimeoutMs', timing.prowlarrQueryTimeoutMs, 'type="number" min="1000" max="120000"',
      'Other promotions. Default 15000.')
    + field('Prowlarr live search window (ms)', 'prowlarrLiveBudgetMs', timing.prowlarrLiveBudgetMs, 'type="number" min="1000" max="120000"',
      'MLB, NFL and NBA keep collecting for this long after the first response.')
    + field('Fast response wait (ms)', 'fastResponseGraceMs', timing.fastResponseGraceMs, 'type="number" min="0" max="120000"',
      '0 waits for thorough results. 8000 answers sooner; later results appear on refresh.')
    + field('Easynews queries per request', 'easynewsMaxQueries', timing.easynewsMaxQueries, 'type="number" min="1" max="6"')
    + field('Easynews per-query timeout (ms)', 'easynewsQueryTimeoutMs', timing.easynewsQueryTimeoutMs, 'type="number" min="500" max="120000"')
    + field('Index build budget (ms)', 'indexBuildBudgetMs', timing.indexBuildBudgetMs, 'type="number" min="1000" max="600000"',
      'Background build; nobody waits on it. Default 25000.')
    + '</div></div></details>';

  const sourcesPanel = '<section class="panel"><div class="panel-head"><div><h3>Discovery sources</h3>'
    + '<p>Where releases are found. Switching one off keeps its settings.</p></div>'
    + '<span class="chip" data-tone="' + (onCount ? 'ok' : 'warn') + '">' + onCount + ' of 4 on</span></div>'
    + '<form method="POST" action="/admin/sources"><div class="panel-body sv2-form"><input type="hidden" name="sourceToggles" value="1">'
    + sources.join('') + timingFold
    + '</div><div class="panel-foot"><button class="btn primary" type="submit">Save sources</button></div></form></section>';

  const zones = Array.from(new Set(['UTC', 'Europe/London'].concat(Intl.supportedValuesOf('timeZone'))));
  const timeZone = '<section class="panel"><div class="panel-head"><div><h3>Display time zone</h3>'
    + '<p>For log and discovery times. Event dates are unchanged.</p></div></div>'
    + '<form method="POST" action="/admin/time-zone" class="panel-body sv2-inline"><label class="f"><span>Time zone</span>'
    + '<input class="t" id="server-time-zone" name="timeZone" list="server-time-zones" value="' + escapeHtml(settings.getDisplayTimeZone()) + '" required></label>'
    + '<datalist id="server-time-zones">' + zones.map((zone) => '<option value="' + escapeHtml(zone) + '"></option>').join('') + '</datalist>'
    + '<button class="btn primary">Save time zone</button></form></section>';

  const current = skins.list().find((skin) => skin.id === activeSkin) || skins.list()[0];
  const appearance = '<details class="fold"><summary><div><h3>Appearance</h3><p>' + escapeHtml(current ? current.name : activeSkin)
    + ' · applies to the whole admin, for everyone</p></div></summary><div class="fold-body">'
    + '<form method="POST" action="/admin/appearance" class="sv2-form"><div class="sv2-skins">'
    + skins.list().map((skin) => {
      const dark = skin.mode === 'dark';
      return '<label class="sv2-skin"><input type="radio" name="skin" value="' + escapeHtml(skin.id) + '"' + (skin.id === activeSkin ? ' checked' : '') + '>'
        + '<strong>' + escapeHtml(skin.name) + '</strong>'
        + '<div class="sv2-swatch"><i style="background:' + escapeHtml(skin.accent) + ';border-radius:' + escapeHtml(skin.radius) + '"></i>'
        + '<em style="background:' + (dark ? '#1a1d24' : '#f6f8fb') + ';border-radius:' + escapeHtml(skin.radius) + '"></em></div>'
        + '<span class="row-sub">' + escapeHtml(skin.description) + '</span>'
        + '<span class="row-sub">' + (dark ? 'Dark' : 'Light') + ' · ' + escapeHtml(radiusLabel(skin.radius)) + '</span></label>';
    }).join('')
    + '</div><div><button class="btn primary" type="submit">Apply skin</button></div></form></div></details>';

  const flash = opts.flash ? '<div class="note" data-tone="info"><div><b>' + escapeHtml(opts.flash) + '</b></div></div>' : '';
  return STYLE
    + '<div class="lede"><h2>Server</h2><p>Settings for this whole instance. Signed in as <code>' + escapeHtml(currentUser.username) + '</code>.</p></div>'
    + flash + '<div class="sv2-stack">' + timeZone + sourcesPanel + appearance + '</div>';
}

module.exports = { renderBody, secretField };
