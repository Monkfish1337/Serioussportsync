'use strict';

// Diagnosis page, in the native SSS vocabulary (lib/ui/css.js): .lede, .seg,
// .panel, .chip, .btn. Overview follows an event's journey (Access → Schedule
// → Sources → Matching → Coverage → Playback) and shows where it breaks;
// Troubleshoot walks one event through the same steps. Client check keeps its
// own page and appears here as a tab.

const esc = (value) => String(value === undefined || value === null ? '' : value)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TABS = [
  { id: 'overview', label: 'Overview', href: '/admin/diagnosis' },
  { id: 'event', label: 'Troubleshoot an event', href: '/admin/diagnosis?tab=event' },
  { id: 'client-check', label: 'Client check', href: '/admin/client-check' },
  { id: 'tools', label: 'All tools', href: '/admin/diagnosis?tab=tools' },
];

function tabs(active) {
  return '<nav class="seg dx-tabs" aria-label="Diagnosis">' + TABS.map((t) => '<a href="' + t.href + '"'
    + (t.id === active ? ' aria-current="true"' : '') + '>' + esc(t.label) + '</a>').join('') + '</nav>';
}

const STYLE = '<style>'
  + '.dx-tabs{margin-bottom:18px;flex-wrap:wrap}'
  + '.dx-hero{display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap}'
  + '.dx-hero h3{margin:0;font-family:var(--font-cond);font-size:24px;letter-spacing:.02em}'
  + '.dx-hero p{margin:2px 0 0;font-size:12px;color:var(--ink-3)}'
  + '.dx-search{display:flex;gap:8px;flex:1 1 320px;max-width:440px}.dx-search input{flex:1}'
  + '.dx-journey{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,140px),1fr));gap:8px;margin:0 0 22px}.dx-journey>*{min-width:0}'
  + '.dx-stage{display:block;background:var(--surface);border:1px solid var(--line);border-top:3px solid var(--line-strong);border-radius:var(--r);padding:10px 12px;color:var(--ink);text-decoration:none}'
  + '.dx-stage:hover{border-color:var(--line-strong);color:var(--ink)}'
  + '.dx-stage b{display:block;font-family:var(--font-cond);font-size:15px;letter-spacing:.06em;text-transform:uppercase}'
  + '.dx-stage small{display:block;color:var(--ink-3);font-size:11px;line-height:1.3;min-height:2.6em}'
  + '.dx-stage .chip{margin-top:6px}'
  + '.dx-stage[data-status="ok"]{border-top-color:var(--ok)}.dx-stage[data-status="warning"]{border-top-color:var(--warn)}.dx-stage[data-status="problem"]{border-top-color:var(--bad)}'
  + '.dx-vitals{display:flex;flex-wrap:wrap;gap:6px 26px;font-size:13px}'
  + '.dx-vitals span{display:block;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)}'
  + '.dx-finding{border:1px solid var(--line);border-left:3px solid var(--info);border-radius:var(--r);background:var(--surface-2)}'
  + '.dx-finding[data-severity="critical"]{border-left-color:var(--bad)}.dx-finding[data-severity="warning"]{border-left-color:var(--warn)}'
  + '.dx-finding>summary{cursor:pointer;padding:10px 14px;list-style:none;display:flex;gap:10px;align-items:center;flex-wrap:wrap}'
  + '.dx-finding>summary::-webkit-details-marker{display:none}'
  + '.dx-finding>summary::after{content:"Details";margin-left:auto;font-size:12px;color:var(--ink-3)}.dx-finding[open]>summary::after{content:"Close"}'
  + '.dx-finding>div{padding:0 14px 14px}.dx-finding p{margin:0;color:var(--ink-2)}'
  + '.dx-label{font-size:11px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3);margin:12px 0 4px}'
  + '.dx-list{margin:0;padding-left:20px;font-size:13px}.dx-list li{overflow-wrap:anywhere}'
  + '.dx-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:14px}.dx-actions form{margin:0}.dx-actions .dx-hide{margin-left:auto}'
  + '.dx-quiet{background:none;border:0;padding:0;font:inherit;font-size:12px;color:var(--ink-3);cursor:pointer;text-decoration:underline}'
  + '.dx-clear{color:var(--ok);font-size:13px}'
  + '.dx-hidden summary{cursor:pointer;color:var(--ink-3);font-size:13px}.dx-hidden li{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:6px 0;border-bottom:1px solid var(--line);font-size:13px}'
  + '.dx-hidden li form{margin-left:auto}'
  + '.dx-verdict{display:flex;gap:10px;align-items:center;border-radius:var(--r);padding:12px 14px;font-weight:600}'
  + '.dx-verdict[data-tone="fail"]{background:var(--bad-soft);color:var(--bad)}.dx-verdict[data-tone="warn"]{background:var(--warn-soft);color:var(--warn)}'
  + '.dx-verdict[data-tone="wait"]{background:var(--info-soft);color:var(--info)}.dx-verdict[data-tone="pass"]{background:var(--ok-soft);color:var(--ok)}'
  + '.dx-steps{list-style:none;margin:0;padding:0}'
  + '.dx-step{display:grid;grid-template-columns:28px 1fr;gap:12px;padding:12px 10px;border-bottom:1px solid var(--line)}.dx-step:last-child{border-bottom:0}'
  + '.dx-dot{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:13px;color:var(--ground)}'
  + '.dx-step[data-verdict="pass"] .dx-dot{background:var(--ok)}.dx-step[data-verdict="fail"] .dx-dot{background:var(--bad)}'
  + '.dx-step[data-verdict="warn"] .dx-dot{background:var(--warn)}.dx-step[data-verdict="wait"] .dx-dot{background:var(--info)}'
  + '.dx-step[data-verdict="skip"] .dx-dot{background:var(--line-strong);color:var(--ink-3)}.dx-step[data-verdict="skip"]{color:var(--ink-3)}'
  + '.dx-step[data-here]{background:var(--bad-soft);border-radius:var(--r)}'
  + '.dx-step b{font-family:var(--font-cond);font-size:15px;letter-spacing:.05em;text-transform:uppercase}'
  + '.dx-step details{margin-top:6px}.dx-step summary{cursor:pointer;font-size:12px;color:var(--accent)}'
  + '.dx-muted{color:var(--ink-3);font-size:12px}'
  + '.dx-matches a{display:block;padding:10px 0;border-bottom:1px solid var(--line);text-decoration:none;color:var(--ink)}'
  + '.dx-tools{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}'
  + '.dx-tools a{display:block;padding:12px 14px;border:1px solid var(--line);border-radius:var(--r);background:var(--surface-2);text-decoration:none;color:var(--ink)}'
  + '.dx-tools a:hover{border-color:var(--line-strong)}.dx-tools small{display:block;color:var(--ink-3);font-size:12px;margin-top:2px}'
  + '@media(max-width:560px){.dx-actions .dx-hide{margin-left:0}}'
  + '</style>';

const SEV = {
  critical: { label: 'Problem', tone: 'bad' },
  warning: { label: 'Worth fixing', tone: 'warn' },
  notice: { label: 'For information', tone: 'info' },
};
const STATE = { ok: ['Working', 'ok'], warning: ['Worth a look', 'warn'], problem: ['Problem', 'bad'] };
const chip = (tone, text) => '<span class="chip" data-tone="' + tone + '">' + esc(text) + '</span>';
const external = (href) => (/^https?:/.test(href) ? ' target="_blank" rel="noreferrer noopener"' : '');
// A link, or an action (link.post: { action, fields }) sent as a form.
const button = (link, kind) => {
  if (!link) return '';
  if (link.post) {
    return '<form method="POST" action="' + esc(link.post.action) + '" class="dx-post">'
      + Object.entries(link.post.fields || {}).map(([k, v]) => '<input type="hidden" name="' + esc(k) + '" value="' + esc(v) + '">').join('')
      + '<button class="btn sm ' + kind + '">' + esc(link.label) + '</button></form>';
  }
  return '<a class="btn sm ' + kind + '" href="' + esc(link.href) + '"' + external(link.href) + '>' + esc(link.label) + '</a>';
};
const list = (items, tag) => '<' + (tag || 'ul') + ' class="dx-list">' + items.map((i) => '<li>' + esc(i) + '</li>').join('') + '</' + (tag || 'ul') + '>';
const panel = (id, title, sub, body, aside) => '<section class="panel"' + (id ? ' id="' + id + '"' : '') + '><div class="panel-head"><div><h3>' + esc(title) + '</h3>'
  + (sub ? '<p>' + esc(sub) + '</p>' : '') + '</div>' + (aside ? '<div style="margin-left:auto">' + aside + '</div>' : '') + '</div><div class="panel-body">' + body + '</div></section>';
const lede = (text) => '<div class="lede"><p>' + esc(text) + '</p></div>';

function findingCard(f, stageLabel, open) {
  const s = SEV[f.severity];
  return '<details class="dx-finding" data-severity="' + f.severity + '"' + (open ? ' open' : '') + '><summary>'
    + chip(s.tone, s.label) + '<strong>' + esc(f.title) + '</strong>' + (stageLabel ? '<span class="dx-muted">' + esc(stageLabel) + '</span>' : '')
    + '</summary><div>'
    + (f.detail ? '<p>' + esc(f.detail) + '</p>' : '')
    + (f.steps.length ? '<div class="dx-label">How to fix</div>' + list(f.steps, 'ol') : '')
    + (f.evidence.length ? '<div class="dx-label">Based on</div>' + list(f.evidence) : '')
    + '<div class="dx-actions">' + button(f.fix, 'primary') + (f.links || []).map((l) => button(l, 'ghost')).join('')
    + '<form method="POST" action="/admin/diagnosis/hide" class="dx-hide"><input type="hidden" name="id" value="' + esc(f.id) + '">'
    + '<input type="hidden" name="severity" value="' + esc(f.severity) + '">'
    + '<button class="dx-quiet" title="Comes back after 30 days, or sooner if it gets worse">Hide for 30 days</button></form>'
    + '</div></div></details>';
}

function renderOverview(result) {
  const s = result.summary;
  const headline = s.critical ? s.critical + (s.critical === 1 ? ' problem needs' : ' problems need') + ' attention'
    : s.warning ? s.warning + (s.warning === 1 ? ' thing is' : ' things are') + ' worth fixing'
      : 'Everything is working';
  const hero = '<section class="panel"><div class="panel-body dx-hero"><div><h3>' + esc(headline) + '</h3>'
    + '<p>Checked at ' + esc(String(result.at).slice(11, 16)) + ' UTC' + (s.notice ? ' · ' + s.notice + ' for information' : '')
    + ' · <a href="/admin/diagnosis">Check again</a></p></div>'
    + '<form class="dx-search" method="GET" action="/admin/diagnosis"><input type="hidden" name="tab" value="event">'
    + '<input class="t" name="q" placeholder="Troubleshoot an event: name or ID" aria-label="Event name or ID">'
    + '<button class="btn primary">Go</button></form></div></section>';

  const journey = '<nav class="dx-journey" aria-label="Stages">' + result.stages.map((st, i) => '<a class="dx-stage" data-status="' + st.status + '" href="#stage-' + st.id + '">'
    + '<b>' + (i + 1) + ' ' + esc(st.label) + '</b><small>' + esc(st.question) + '</small>'
    + chip(STATE[st.status][1], STATE[st.status][0] + (st.findings.length ? ' · ' + st.findings.length : '')) + '</a>').join('') + '</nav>';

  const labelOf = new Map(result.stages.map((st) => [st.id, st.label]));
  const first = result.findings.find((f) => f.severity !== 'notice');
  const start = first ? panel('', 'Start here', 'The most serious finding, with its fix.', findingCard(first, labelOf.get(first.stage), true)) : '';

  const sections = result.stages.map((st, i) => panel('stage-' + st.id, (i + 1) + ' ' + st.label, st.question,
    (st.vitals.length ? '<div class="dx-vitals">' + st.vitals.map(([k, v]) => '<div><span>' + esc(k) + '</span>' + esc(v) + '</div>').join('') + '</div>' : '')
    + (st.findings.length ? st.findings.map((f) => findingCard(f, '', false)).join('')
      : '<div class="dx-clear">✓ Nothing wrong found.</div>'),
    chip(STATE[st.status][1], STATE[st.status][0]))).join('');

  const hidden = result.hidden.length ? '<details class="dx-hidden" id="hidden"><summary>' + result.hidden.length + ' hidden finding'
    + (result.hidden.length === 1 ? '' : 's') + '</summary><ul class="dx-list" style="list-style:none;padding:0">'
    + result.hidden.map((f) => '<li>' + chip(SEV[f.severity].tone, labelOf.get(f.stage)) + esc(f.title)
      + ' <span class="dx-muted">until ' + esc(new Date(f.hiddenUntil).toISOString().slice(0, 10)) + '</span>'
      + '<form method="POST" action="/admin/diagnosis/show"><input type="hidden" name="id" value="' + esc(f.id) + '">'
      + '<button class="dx-quiet">Show again</button></form></li>').join('') + '</ul></details>' : '';

  return lede('Follows an event from schedule to playback and shows where it breaks. Nothing here searches or changes anything.')
    + hero + journey + start + sections + hidden;
}

const ICON = { pass: '✓', fail: '✕', warn: '!', wait: '…', skip: '–' };

function renderEvent(result) {
  const intro = lede('Walks one event from listing to playback and stops at the step that fails. Use it when an event has no links, the wrong links, or will not play.');
  const form = '<form class="dx-search" style="max-width:none;margin-bottom:16px" method="GET" action="/admin/diagnosis"><input type="hidden" name="tab" value="event">'
    + '<input class="t" name="q" value="' + esc(result.query) + '" placeholder="Event name or ID, e.g. Fulham, Austria GP, mlb:824784" aria-label="Event name or ID" autofocus>'
    + '<button class="btn primary">Troubleshoot</button></form>';
  if (!result.query) return intro + form;
  if (!result.event) {
    if (!result.matches.length) return intro + form + '<div class="alert alert-warning">No event matches "' + esc(result.query) + '".</div>';
    return intro + form + panel('', result.matches.length + ' events match', 'Choose one.', '<div class="dx-matches">'
      + result.matches.map((e) => '<a href="/admin/diagnosis?tab=event&q=' + encodeURIComponent(e.id) + '">' + esc(e.name)
        + ' <span class="dx-muted">' + esc(e.date) + ' · ' + esc(e.id) + '</span></a>').join('') + '</div>');
  }
  const e = result.event;
  const p = result.promotion || {};
  const id = encodeURIComponent(e.id);
  const here = (st) => st.verdict === 'fail' && st.id === result.verdict.step;
  const verdict = '<div class="dx-verdict" data-tone="' + result.verdict.tone + '">' + esc(result.verdict.text) + '</div>';
  const steps = '<ol class="dx-steps">' + result.steps.map((st) => '<li class="dx-step" data-verdict="' + st.verdict + '"' + (here(st) ? ' data-here' : '') + '>'
    + '<div class="dx-dot" aria-hidden="true">' + ICON[st.verdict] + '</div><div><b>' + esc(st.label) + '</b>'
    + (here(st) ? ' ' + chip('bad', 'Where it breaks') : '')
    + '<div>' + esc(st.summary) + '</div>'
    + (st.detail && st.detail.length && st.detailLabel ? '<details><summary>' + esc(st.detailLabel) + ' (' + st.detail.length + ')</summary>' + list(st.detail) + '</details>' : '')
    + (st.rejections && st.rejections.length ? '<details' + (st.verdict === 'fail' ? ' open' : '') + '><summary>Turned down ('
      + st.rejections.reduce((n, r) => n + r.count, 0) + ')</summary><ul class="dx-list">'
      + st.rejections.map((r) => '<li><strong>' + esc(r.reason) + '</strong> × ' + esc(r.count)
        + (r.examples.length ? '<div class="dx-muted">' + r.examples.map(esc).join('<br>') + '</div>' : '') + '</li>').join('') + '</ul></details>' : '')
    + (st.fix || (st.links && st.links.length) ? '<div class="dx-actions">' + button(st.fix, st.verdict === 'fail' ? 'primary' : 'ghost')
      + (st.links || []).map((l) => button(l, 'ghost')).join('') + '</div>' : '')
    + '</div></li>').join('') + '</ol>';
  const tools = [
    ['Client check on it', '/admin/client-check?eventId=' + id],
    ['Match by hand', '/admin/discovery/manual?eventId=' + id],
    p.reviewParent ? ['Review aliases', '/admin/promotions/' + encodeURIComponent(p.reviewParent) + '/aliases'] : null,
    p.reviewParent ? ['Improve matching', '/admin/promotions/' + encodeURIComponent(p.reviewParent) + '/research'] : null,
    ['Event Editor', '/admin/events?q=' + id],
    ['Its log lines', '/admin/logs?substring=' + id],
  ].filter(Boolean);
  return intro + form
    + panel('', e.name, (p.name ? p.name + ' · ' : '') + e.date + ' · ' + e.id, verdict + steps)
    + panel('', 'More for this event', 'Every page that can change or explain it.',
      '<div class="dx-actions" style="margin:0">' + tools.map(([label, href]) => button({ label, href }, 'ghost')).join('') + '</div>');
}

// Every diagnostic page, under the stage it helps with.
const TOOLS = [
  ['Access', 'Can clients reach SSS?', [
    ['Client check', '/admin/client-check', 'Opens an account\'s addon the way Nuvio does.'],
    ['Logs', '/admin/logs', 'Live log, filtered by area, level, user or request.'],
  ]],
  ['Schedule', 'Are events listed, with the right dates?', [
    ['Promotions', '/admin/promotions', 'Event counts, refresh and source per promotion.'],
    ['Event Editor', '/admin/events', 'Correct an event\'s date or add a missing one.'],
    ['Metadata', '/admin/metadata', 'Metadata providers and API keys.'],
  ]],
  ['Sources', 'Are the search sources answering?', [
    ['Prowlarr queue', '/admin/discovery?tab=prowlarr', 'Background search, indexer budgets and cooldowns.'],
    ['Sport-Video', '/admin/discovery?tab=sport-video', 'Scan status, errors and preparation.'],
    ['Bitmagnet preparation', '/admin/discovery?tab=preparation', 'Background torrent preparation.'],
    ['Built-in Usenet', '/admin/usenet', 'Indexer and NNTP state, timing and results.'],
    ['Server', '/admin', 'Connections and time budgets for every source.'],
  ]],
  ['Matching', 'Are the right releases accepted?', [
    ['Review aliases', '/admin/promotions', 'Which search patterns find releases. Open a promotion first.'],
    ['Improve matching', '/admin/promotions', 'Learned aliases, keywords and patterns. Open a promotion first.'],
    ['Sport-Video diagnostics', '/admin/discovery?tab=sport-video', 'Why each nearby release matched or not.'],
  ]],
  ['Coverage', 'Are releases saved before anyone asks?', [
    ['Discovery overview', '/admin/discovery?tab=overview', 'Seven-day coverage and every missing event with its reason.'],
    ['Manual matching', '/admin/discovery/manual', 'Attach a torrent to an event by hand.'],
  ]],
  ['Playback', 'Do links appear quickly, and do they play?', [
    ['Database', '/admin/database', 'Stored releases and background preparation.'],
    ['Backup', '/admin/backup', 'Download a backup of the data directory.'],
  ]],
];

function renderTools() {
  return lede('Every diagnostic page, under the stage it helps with.')
    + TOOLS.map(([stage, question, items]) => panel('', stage, question, '<div class="dx-tools">'
      + items.map(([name, href, what]) => '<a href="' + esc(href) + '"><strong>' + esc(name) + '</strong><small>' + esc(what) + '</small></a>').join('')
      + '</div>')).join('');
}

function render(data) {
  const tab = ['overview', 'event', 'tools'].includes(data.tab) ? data.tab : 'overview';
  const body = tab === 'event' ? renderEvent(data.investigation || { query: '', matches: [], event: null })
    : tab === 'tools' ? renderTools() : renderOverview(data.findings);
  const flash = data.flash ? '<div class="alert alert-info">' + esc(data.flash) + '</div>' : '';
  return STYLE + tabs(tab) + flash + body;
}

module.exports = { render, renderOverview, renderEvent, renderTools, tabs, TOOLS, STYLE };
