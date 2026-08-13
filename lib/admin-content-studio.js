const store = require('./store');
const contentStore = require('./content-store');
const promotions = require('./promotions');
const { escapeHtml } = require('./tabler-chrome');
const fetch = require('node-fetch');
const config = require('../config');

function e(value) { return escapeHtml(value == null ? '' : String(value)); }
function selected(a, b) { return String(a || '') === String(b || '') ? ' selected' : ''; }
function checked(v) { return v ? ' checked' : ''; }

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (c === '"' && quoted && next === '"') { field += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) { row.push(field); field = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && next === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => String(x).trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field); if (row.some((x) => String(x).trim())) rows.push(row);
  if (rows.length < 2) return [];
  const headers = rows.shift().map((x) => String(x).trim().toLowerCase());
  return rows.map((values) => Object.fromEntries(headers.map((h, i) => [h, values[i] || ''])));
}

function icsValue(line) {
  const idx = line.indexOf(':');
  return idx < 0 ? '' : line.slice(idx + 1).replace(/\\n/gi, '\n').replace(/\\,/g, ',').trim();
}

function icsDate(value) {
  const v = String(value || '').trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? m[1] + '-' + m[2] + '-' + m[3] : v;
}

function parseIcs(text) {
  const unfolded = String(text || '').replace(/\r?\n[ \t]/g, '');
  const blocks = unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/gi) || [];
  return blocks.map((block) => {
    const lines = block.split(/\r?\n/);
    const find = (name) => {
      const line = lines.find((l) => l.toUpperCase().startsWith(name + ':') || l.toUpperCase().startsWith(name + ';'));
      return line ? icsValue(line) : '';
    };
    return { name: find('SUMMARY'), date: icsDate(find('DTSTART')), description: find('DESCRIPTION'), venue: find('LOCATION'), sourceId: find('UID') };
  });
}

function parseImport(format, text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Paste or choose an import file first.');
  let records;
  if (format === 'ics') records = parseIcs(raw);
  else if (format === 'csv') records = parseCsv(raw);
  else {
    const parsed = JSON.parse(raw);
    records = Array.isArray(parsed) ? parsed : parsed.events;
  }
  if (!Array.isArray(records)) throw new Error('Import must contain an array of events.');
  return records.slice(0, 500).map((r, index) => ({
    row: index + 1,
    name: String(r.name || r.title || r.summary || '').trim(),
    date: icsDate(r.date || r.start || r.dtstart || ''),
    time: String(r.time || '').trim(),
    venue: String(r.venue || r.location || '').trim(),
    description: String(r.description || '').trim(),
    aliases: Array.isArray(r.aliases) ? r.aliases.join('\n') : String(r.aliases || ''),
    searchAliases: Array.isArray(r.searchAliases) ? r.searchAliases.join('\n') : String(r.searchAliases || ''),
    sourceId: String(r.sourceId || r.uid || '').trim(),
    valid: !!String(r.name || r.title || r.summary || '').trim() && /^\d{4}-\d{2}-\d{2}$/.test(icsDate(r.date || r.start || r.dtstart || '')),
  }));
}

function applyImport(promotionId, records) {
  let added = 0, skipped = 0;
  for (const record of records) {
    if (!record.valid) { skipped++; continue; }
    contentStore.upsertManual(Object.assign({}, record, { promotion: promotionId }));
    added++;
  }
  return { added, skipped };
}

const STOP = new Set('the a an and or vs v at on in of for from full event episode night day live part show'.split(' '));
function tokens(title) {
  return String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter((x) => x.length > 2 && !STOP.has(x) && !/^20\d\d$/.test(x));
}
function suggestMatches(positiveText, negativeText) {
  const positives = String(positiveText || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const negatives = String(negativeText || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const negativeTokens = new Set(negatives.flatMap(tokens));
  const counts = new Map();
  for (const token of positives.flatMap(tokens)) counts.set(token, (counts.get(token) || 0) + 1);
  const common = Array.from(counts.entries()).filter(([word, count]) => !negativeTokens.has(word) && count >= Math.max(1, Math.ceil(positives.length * 0.5))).sort((a,b) => b[1]-a[1]).map(([word]) => word);
  const aliases = positives.slice(0, 8).map((x) => x.replace(/\b(2160p|1080p|720p|web[- .]?dl|webrip|hdtv|x26[45]|hevc|aac|proper|repack)\b/ig, '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim()).filter((x) => x.length >= 4);
  const negativeDistinct = Array.from(negativeTokens).filter((x) => !counts.has(x)).slice(0, 12);
  return { aliases: Array.from(new Set(aliases)).slice(0, 6), keywords: common.slice(0, 10), excludePatterns: negativeDistinct.map((x) => '\\b' + x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b') };
}

function promotionOptions(value) {
  return promotions.all.map((p) => '<option value="' + e(p.id) + '"' + selected(p.id, value) + '>' + e(p.name) + '</option>').join('');
}

function nav(tab) {
  const items = [['overview','Overview'],['events','Events'],['inbox','Missing inbox'],['import','Import'],['matching','Matching assistant'],['promotion','Add promotion']];
  return '<ul class="nav nav-tabs mb-4">' + items.map(([id,label]) => '<li class="nav-item"><a class="nav-link' + (tab === id ? ' active' : '') + '" href="/admin/content?tab=' + id + '">' + label + '</a></li>').join('') + '</ul>';
}

function flashHtml(flash) {
  return flash ? '<div class="alert alert-info alert-dismissible"><div>' + e(flash) + '</div><a class="btn-close" data-bs-dismiss="alert"></a></div>' : '';
}

function overview() {
  const events = store.getEvents();
  const state = contentStore.load();
  const cards = promotions.all.map((p) => {
    const count = events.filter((event) => event.promotion === p.id).length;
    const manual = state.manualEvents.filter((event) => event.promotion === p.id).length;
    const pending = state.inbox.filter((item) => item.status === 'pending' && item.candidate && item.candidate.promotion === p.id).length;
    return '<div class="col-sm-6 col-xl-4"><div class="card h-100"><div class="card-body"><div class="d-flex justify-content-between"><h3 class="card-title">' + e(p.name) + '</h3><span class="badge ' + (p.isCustom ? 'bg-green-lt' : 'bg-blue-lt') + '">' + (p.isCustom ? 'custom' : 'built-in') + '</span></div><div class="text-secondary">' + count + ' visible · ' + manual + ' manual · ' + pending + ' to review</div></div><div class="card-footer"><a class="btn btn-sm btn-primary" href="/admin/content?tab=events&promo=' + encodeURIComponent(p.id) + '">Manage events</a> <form class="d-inline" method="POST" action="/admin/promotions/' + encodeURIComponent(p.id) + '/refresh"><button class="btn btn-sm btn-outline-info">Refresh</button></form></div></div></div>';
  }).join('');
  return '<div class="d-flex justify-content-between align-items-center mb-3"><div><h2 class="mb-1">Promotion overview</h2><p class="text-secondary mb-0">One place to see coverage, add missing events, and review source decisions.</p></div><a class="btn btn-primary" href="/admin/content?tab=events&new=1">Add event</a></div><div class="row g-3">' + cards + '</div>';
}

function eventForm(event, promoId, isManual) {
  const item = event || {};
  const action = item.id ? '/admin/content/events/' + encodeURIComponent(item.id) + '/save' : '/admin/content/events/create';
  return '<div class="card mb-4"><div class="card-header"><h3 class="card-title">' + (item.id ? 'Edit event' : 'Add event') + '</h3></div><div class="card-body"><form method="POST" action="' + action + '"><div class="row g-3">'
    + '<div class="col-md-4"><label class="form-label">Promotion</label><select class="form-select" name="promotion"' + (item.id ? ' disabled' : '') + '>' + promotionOptions(item.promotion || promoId) + '</select>' + (item.id ? '<input type="hidden" name="promotion" value="' + e(item.promotion) + '">' : '') + '</div>'
    + '<div class="col-md-5"><label class="form-label">Event name</label><input class="form-control" required name="name" value="' + e(item.name) + '"></div>'
    + '<div class="col-md-3"><label class="form-label">Date</label><input class="form-control" required type="date" name="date" value="' + e(item.date) + '"></div>'
    + '<div class="col-md-3"><label class="form-label">Time (UTC)</label><input class="form-control" type="time" step="1" name="time" value="' + e(item.time) + '"></div>'
    + '<div class="col-md-3"><label class="form-label">Kind</label><input class="form-control" name="kind" value="' + e(item.kind) + '" placeholder="event, ppv, race…"></div>'
    + '<div class="col-md-3"><label class="form-label">Venue</label><input class="form-control" name="venue" value="' + e(item.venue) + '"></div>'
    + '<div class="col-md-3"><label class="form-label">City</label><input class="form-control" name="city" value="' + e(item.city) + '"></div>'
    + '<div class="col-md-6"><label class="form-label">Poster URL</label><input class="form-control" type="url" name="poster" value="' + e(item.poster) + '"></div>'
    + '<div class="col-md-6"><label class="form-label">Background URL</label><input class="form-control" type="url" name="fanart" value="' + e(item.fanart) + '"></div>'
    + '<div class="col-md-6"><label class="form-label">Alternate/search titles</label><textarea class="form-control" rows="4" name="searchAliases" placeholder="One exact search phrase per line">' + e((item.searchAliases || []).join('\n')) + '</textarea><small class="text-secondary">These are added to the normal event searches and can rescue valid releases rejected by the standard matcher.</small></div>'
    + '<div class="col-md-6"><label class="form-label">Event-specific exclusions</label><textarea class="form-control text-mono" rows="4" name="excludePatterns" placeholder="One regular expression per line">' + e((item.excludePatterns || []).join('\n')) + '</textarea><small class="text-secondary">Only affects this event.</small></div>'
    + '<div class="col-12"><label class="form-label">Description / editor notes</label><textarea class="form-control" rows="3" name="description">' + e(item.description) + '</textarea></div>'
    + '</div><div class="mt-3"><button class="btn btn-primary">Save ' + (isManual ? 'manual event' : item.id ? 'override' : 'event') + '</button> <a class="btn btn-link" href="/admin/content?tab=events&promo=' + encodeURIComponent(item.promotion || promoId || '') + '">Cancel</a></div></form></div></div>';
}

function eventsPage(opts) {
  const state = contentStore.load();
  const promoId = opts.promo || (promotions.all[0] && promotions.all[0].id) || '';
  const allEvents = store.getEvents();
  const chosen = opts.edit ? allEvents.find((x) => x.id === opts.edit) : null;
  const manualIds = new Set(state.manualEvents.map((x) => x.id));
  let body = '<div class="d-flex flex-wrap gap-2 align-items-end mb-3"><form method="GET" action="/admin/content"><input type="hidden" name="tab" value="events"><label class="form-label">Promotion</label><div class="input-group"><select class="form-select" name="promo">' + promotionOptions(promoId) + '</select><button class="btn btn-outline-primary">Open</button></div></form><a class="btn btn-primary ms-auto" href="/admin/content?tab=events&promo=' + encodeURIComponent(promoId) + '&new=1">Add event</a></div>';
  if (opts.newEvent || chosen) body += eventForm(chosen, promoId, chosen && manualIds.has(chosen.id));
  const query = String(opts.query || '').toLowerCase();
  const rows = allEvents.filter((x) => x.promotion === promoId && (!query || String(x.name).toLowerCase().includes(query))).slice(0, 300).map((item) => {
    const manual = manualIds.has(item.id);
    const overridden = !!state.eventOverrides[item.id];
    return '<tr><td><strong>' + e(item.name) + '</strong><br><small class="text-secondary text-mono">' + e(item.id) + '</small></td><td>' + e(item.date) + '</td><td>' + (manual ? '<span class="badge bg-green-lt">manual</span>' : '<span class="badge bg-blue-lt">source</span>') + (overridden ? ' <span class="badge bg-yellow-lt">edited</span>' : '') + '</td><td class="text-nowrap"><a class="btn btn-sm btn-outline-primary" href="/admin/content?tab=events&promo=' + encodeURIComponent(promoId) + '&edit=' + encodeURIComponent(item.id) + '">Edit</a> <form class="d-inline" method="POST" action="/admin/content/events/' + encodeURIComponent(item.id) + '/disable"><button class="btn btn-sm btn-outline-warning">Disable</button></form>' + (manual ? ' <form class="d-inline" method="POST" action="/admin/content/events/' + encodeURIComponent(item.id) + '/delete" onsubmit="return confirm(\'Delete this manual event?\')"><button class="btn btn-sm btn-outline-danger">Delete</button></form>' : overridden ? ' <form class="d-inline" method="POST" action="/admin/content/events/' + encodeURIComponent(item.id) + '/reset"><button class="btn btn-sm btn-outline-secondary">Reset</button></form>' : '') + '</td></tr>';
  }).join('');
  body += '<div class="card"><div class="card-header"><h3 class="card-title">Events</h3><form class="ms-auto" method="GET"><input type="hidden" name="tab" value="events"><input type="hidden" name="promo" value="' + e(promoId) + '"><input class="form-control" name="q" value="' + e(opts.query) + '" placeholder="Filter events"></form></div><div class="table-responsive"><table class="table table-vcenter"><thead><tr><th>Event</th><th>Date</th><th>Origin</th><th></th></tr></thead><tbody>' + (rows || '<tr><td colspan="4" class="text-secondary">No events found.</td></tr>') + '</tbody></table></div></div>';
  const disabled = state.disabledEventIds.map((id) => '<form class="d-inline me-2 mb-2" method="POST" action="/admin/content/events/' + encodeURIComponent(id) + '/enable"><button class="btn btn-sm btn-outline-secondary">Restore ' + e(id) + '</button></form>').join('');
  if (disabled) body += '<div class="card mt-3"><div class="card-header"><h3 class="card-title">Disabled events</h3></div><div class="card-body">' + disabled + '</div></div>';
  return body;
}

function inboxPage() {
  const items = contentStore.load().inbox.filter((x) => x.status === 'pending');
  const rows = items.map((item) => '<tr><td><strong>' + e(item.candidate.name) + '</strong><br><small class="text-secondary">' + e(item.candidate.promotion) + ' · ' + e(item.candidate.date) + '</small></td><td><span class="badge bg-yellow-lt">' + e(item.reason) + '</span><br><small>' + e(item.details) + '</small></td><td><form class="d-inline" method="POST" action="/admin/content/inbox/' + e(item.key) + '/accept"><button class="btn btn-sm btn-primary">Accept as manual</button></form> <form class="d-inline" method="POST" action="/admin/content/inbox/' + e(item.key) + '/ignore"><button class="btn btn-sm btn-outline-secondary">Ignore</button></form><form class="mt-2 d-flex gap-1" method="POST" action="/admin/content/inbox/' + e(item.key) + '/merge"><input class="form-control form-control-sm" name="targetId" placeholder="Existing event ID"><button class="btn btn-sm btn-outline-info">Merge</button></form></td></tr>').join('');
  return '<div class="mb-3"><h2 class="mb-1">Missing event inbox</h2><p class="text-secondary">Events rejected by a promotion filter and likely duplicates appear here instead of disappearing silently.</p></div><div class="card"><div class="table-responsive"><table class="table table-vcenter"><thead><tr><th>Candidate</th><th>Why it needs review</th><th>Decision</th></tr></thead><tbody>' + (rows || '<tr><td colspan="3" class="text-secondary">Inbox clear. New source decisions appear after a refresh.</td></tr>') + '</tbody></table></div></div>';
}

function importPage(preview) {
  let previewHtml = '';
  if (preview && preview.records) {
    const rows = preview.records.map((x) => '<tr><td>' + x.row + '</td><td>' + e(x.name) + '</td><td>' + e(x.date) + '</td><td>' + (x.valid ? '<span class="badge bg-green-lt">ready</span>' : '<span class="badge bg-red-lt">needs name/date</span>') + '</td></tr>').join('');
    previewHtml = '<div class="card mt-3"><div class="card-header"><h3 class="card-title">Preview</h3></div><div class="table-responsive"><table class="table"><thead><tr><th>#</th><th>Name</th><th>Date</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table></div><div class="card-footer"><form method="POST" action="/admin/content/import/apply"><input type="hidden" name="promotion" value="' + e(preview.promotion) + '"><input type="hidden" name="format" value="' + e(preview.format) + '"><textarea hidden name="content">' + e(preview.content) + '</textarea><button class="btn btn-primary">Import ' + preview.records.filter((x) => x.valid).length + ' valid events</button></form></div></div>';
  }
  return '<h2>Import events</h2><p class="text-secondary">Preview and validate calendar or spreadsheet data before it becomes manual content. Maximum 500 events per import.</p><div class="card"><div class="card-body"><form method="POST" action="/admin/content/import/preview"><div class="row g-3"><div class="col-md-4"><label class="form-label">Promotion</label><select class="form-select" name="promotion">' + promotionOptions(preview && preview.promotion) + '</select></div><div class="col-md-3"><label class="form-label">Format</label><select class="form-select" name="format"><option value="ics">ICS calendar</option><option value="csv">CSV</option><option value="json">JSON</option></select></div><div class="col-12"><label class="form-label">File or pasted content</label><input class="form-control mb-2" id="importFile" type="file" accept=".ics,.csv,.json,text/calendar,text/csv,application/json"><textarea class="form-control text-mono" id="importContent" name="content" rows="10" required placeholder="Choose a file or paste its contents here">' + e(preview && preview.content) + '</textarea></div></div><button class="btn btn-primary mt-3">Preview import</button></form></div></div>' + previewHtml + '<script>document.getElementById("importFile").addEventListener("change",function(){var f=this.files[0];if(!f)return;var r=new FileReader();r.onload=function(){document.getElementById("importContent").value=r.result};r.readAsText(f);});</script>';
}

function matchingPage(result) {
  const r = result || {};
  const suggestions = r.suggestions ? '<div class="card mt-3"><div class="card-header"><h3 class="card-title">Suggested event rules</h3></div><div class="card-body"><form method="POST" action="/admin/content/matching/apply"><input type="hidden" name="eventId" value="' + e(r.eventId) + '"><label class="form-label">Search aliases</label><textarea class="form-control" name="searchAliases" rows="5">' + e(r.suggestions.aliases.join('\n')) + '</textarea><label class="form-label mt-3">Exclude patterns</label><textarea class="form-control text-mono" name="excludePatterns" rows="5">' + e(r.suggestions.excludePatterns.join('\n')) + '</textarea><button class="btn btn-primary mt-3">Apply to event</button></form><div class="mt-3 text-secondary">Distinctive positive tokens: ' + e(r.suggestions.keywords.join(', ') || 'none found') + '</div></div></div>' : '';
  return '<h2>Matching assistant</h2><p class="text-secondary">Paste examples that should and should not match. The assistant proposes event-specific searches and exclusions; nothing changes until you apply them.</p><div class="card"><div class="card-body"><form method="POST" action="/admin/content/matching/suggest"><div class="mb-3"><label class="form-label">Event ID</label><input class="form-control text-mono" required name="eventId" value="' + e(r.eventId) + '" placeholder="wwe:123456"></div><div class="row g-3"><div class="col-md-6"><label class="form-label">Correct release titles</label><textarea class="form-control text-mono" required name="positive" rows="9" placeholder="One title per line">' + e(r.positive) + '</textarea></div><div class="col-md-6"><label class="form-label">Incorrect release titles</label><textarea class="form-control text-mono" name="negative" rows="9" placeholder="One title per line">' + e(r.negative) + '</textarea></div></div><button class="btn btn-primary mt-3">Suggest rules</button></form></div></div>' + suggestions;
}

function promotionPage(opts) {
  opts = opts || {};
  const source = opts.source || 'tsdb';
  const discovered = (opts.discovery || []).map((item) => '<tr><td><strong>' + e(item.name) + '</strong><br><small class="text-secondary">' + e(item.description) + '</small></td><td class="text-mono">' + e(item.id) + '</td><td><a class="btn btn-sm btn-primary" href="/admin/content?tab=promotion&source=' + encodeURIComponent(source) + '&sourceId=' + encodeURIComponent(item.id) + '&name=' + encodeURIComponent(item.name) + '">Use this source</a></td></tr>').join('');
  const noResults = source === 'tsdb'
    ? 'No match found. The free TheSportsDB API requires an exact league name (for example NBA) or a numeric league ID.'
    : 'No matching sources found.';
  const discovery = '<div class="card mb-3"><div class="card-header"><h3 class="card-title">Find a source</h3></div><div class="card-body"><form method="GET" action="/admin/content"><input type="hidden" name="tab" value="promotion"><input type="hidden" name="discover" value="1"><div class="row g-2"><div class="col-md-3"><select class="form-select" name="source"><option value="tsdb"' + selected(source,'tsdb') + '>TheSportsDB</option><option value="football-data"' + selected(source,'football-data') + '>football-data.org</option><option value="tmdb"' + selected(source,'tmdb') + '>TMDB TV show</option></select></div><div class="col-md-7"><input class="form-control" name="query" value="' + e(opts.discoveryQuery) + '" placeholder="Exact league name, source ID, competition, or show name"></div><div class="col-md-2"><button class="btn btn-outline-primary w-100">Search</button></div></div></form></div>' + (opts.discovery ? '<div class="table-responsive"><table class="table"><tbody>' + (discovered || '<tr><td class="text-secondary">' + e(noResults) + '</td></tr>') + '</tbody></table></div>' : '') + '</div>';
  return '<h2>Add a promotion</h2><p class="text-secondary">Find the source by name, preview its ID, then create the promotion with practical matching defaults.</p>' + discovery + '<div class="card"><div class="card-body"><form method="POST" action="/admin/content/promotions/create"><div class="row g-3"><div class="col-md-4"><label class="form-label">Name</label><input class="form-control" required name="name" value="' + e(opts.name) + '" placeholder="National Football League"></div><div class="col-md-3"><label class="form-label">Short ID</label><input class="form-control" required pattern="[a-z0-9_-]{2,30}" name="id" placeholder="nfl"></div><div class="col-md-3"><label class="form-label">Source</label><select class="form-select" name="source" id="quickSource"><option value="tsdb"' + selected(source,'tsdb') + '>TheSportsDB</option><option value="football-data"' + selected(source,'football-data') + '>football-data.org</option><option value="tmdb"' + selected(source,'tmdb') + '>TMDB TV show</option></select></div><div class="col-md-2"><label class="form-label">Source ID</label><input class="form-control" required name="sourceId" value="' + e(opts.sourceId) + '" placeholder="4391"></div><div class="col-md-6"><label class="form-label">Poster URL (optional)</label><input class="form-control" type="url" name="poster"></div><div class="col-md-6"><label class="form-label">Background URL (optional)</label><input class="form-control" type="url" name="fanart"></div></div><details class="mt-3"><summary class="text-secondary">Advanced matching defaults</summary><div class="row g-3 mt-1"><div class="col-md-6"><label class="form-label">Search templates</label><textarea class="form-control" name="searchTitleTemplates" rows="3" placeholder="{name}\n{name} {year}"></textarea></div><div class="col-md-6"><label class="form-label">Relevance keywords</label><input class="form-control" name="relevanceKeywords" placeholder="nfl, football"></div></div></details><button class="btn btn-primary mt-3">Create promotion</button> <a class="btn btn-link" href="/admin/promotions">Open full advanced editor</a></form></div></div>';
}

async function discoverSources(source, query) {
  const q = String(query || '').trim();
  if (q.length < 2) throw new Error('Enter at least two characters to search.');
  if (source === 'tsdb') {
    const key = (config.tsdb && config.tsdb.apiKey) || '123';
    // The v1 `search_all_leagues.php` endpoint only filters by country/sport;
    // passing `l=NBA` returns `{ countries: "Invalid name passed" }`. The free
    // v1 API can still resolve an exact league name via its team listing,
    // whose rows carry idLeague/strLeague. Numeric input uses the direct
    // league lookup. Premium v2 has true free-text league search, but requiring
    // that here would make the default public v1 key unusable.
    const numeric = /^\d+$/.test(q);
    const endpoint = numeric
      ? '/lookupleague.php?id=' + encodeURIComponent(q)
      : '/search_all_teams.php?l=' + encodeURIComponent(q);
    const url = 'https://www.thesportsdb.com/api/v1/json/' + encodeURIComponent(key) + endpoint;
    const response = await fetch(url, { headers: { 'User-Agent': 'serioussportsync/content-studio' }, timeout: 15000 });
    if (!response.ok) throw new Error('TheSportsDB returned HTTP ' + response.status);
    const json = await response.json();
    const rows = numeric
      ? (Array.isArray(json.leagues) ? json.leagues : [])
      : (Array.isArray(json.teams) ? json.teams : []);
    const found = new Map();
    for (const row of rows) {
      const id = String(row && row.idLeague || '').trim();
      if (!id || found.has(id)) continue;
      found.set(id, {
        id,
        name: row.strLeague || q,
        description: [row.strSport, row.strCountry].filter(Boolean).join(' · '),
      });
    }
    return Array.from(found.values()).slice(0, 30);
  }
  if (source === 'football-data') {
    const settings = require('./settings');
    const apiKey = (settings.getFootballData && settings.getFootballData().apiKey) || (config.footballData && config.footballData.apiKey) || '';
    if (!apiKey) throw new Error('Configure a football-data.org API key on the admin page first.');
    const response = await fetch('https://api.football-data.org/v4/competitions', { headers: { 'X-Auth-Token': apiKey }, timeout: 15000 });
    if (!response.ok) throw new Error('football-data.org returned HTTP ' + response.status);
    const json = await response.json();
    const needle = q.toLowerCase();
    return (json.competitions || []).filter((x) => [x.name, x.code, x.area && x.area.name].some((v) => String(v || '').toLowerCase().includes(needle))).slice(0, 30).map((x) => ({ id: x.code || x.id, name: x.name, description: x.area && x.area.name }));
  }
  if (source === 'tmdb') {
    const apiKey = (config.tmdb && config.tmdb.apiKey) || '';
    if (!apiKey) throw new Error('Configure TMDB_API_KEY first.');
    const response = await fetch('https://api.themoviedb.org/3/search/tv?api_key=' + encodeURIComponent(apiKey) + '&query=' + encodeURIComponent(q), { timeout: 15000 });
    if (!response.ok) throw new Error('TMDB returned HTTP ' + response.status);
    const json = await response.json();
    return (json.results || []).slice(0, 30).map((x) => ({ id: x.id, name: x.name, description: [x.first_air_date, x.original_name].filter(Boolean).join(' · ') }));
  }
  throw new Error('Unknown source.');
}

function renderBody(opts) {
  opts = opts || {};
  const tab = opts.tab || 'overview';
  let content;
  if (tab === 'events') content = eventsPage(opts);
  else if (tab === 'inbox') content = inboxPage();
  else if (tab === 'import') content = importPage(opts.preview);
  else if (tab === 'matching') content = matchingPage(opts.matchResult);
  else if (tab === 'promotion') content = promotionPage(opts);
  else content = overview();
  return '<div class="page-header mb-3"><div class="row align-items-center"><div class="col"><h1 class="page-title">Content Studio</h1><div class="text-secondary mt-1">Curate promotions and events without editing JSON or losing changes on refresh.</div></div></div></div>' + flashHtml(opts.flash) + nav(tab) + content;
}

module.exports = { renderBody, parseImport, applyImport, suggestMatches, discoverSources };
