'use strict';

const shell = require('./ui/shell');

function returnPath(query) {
  const params = new URLSearchParams();
  if (query && query.q) params.set('q', query.q);
  if (query && query.promotion) params.set('promotion', query.promotion);
  const text = params.toString();
  return '/admin/events' + (text ? '?' + text : '');
}

function renderBody(input) {
  const data = input || {};
  const query = data.query || {};
  const q = String(query.q || '').trim().toLowerCase();
  const promotion = String(query.promotion || '').trim();
  const overrides = data.overrides || {};
  const allEvents = Array.isArray(data.events) ? data.events : [];
  const promotions = Array.isArray(data.promotions) ? data.promotions : [];
  const filtered = allEvents.filter((event) => {
    if (promotion && event.promotion !== promotion) return false;
    if (!q) return true;
    return [event.id, event.name, event.date, event.promotion].join(' ').toLowerCase().includes(q);
  }).sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 100);
  const path = returnPath(query);
  const flash = data.flash ? '<div class="note" data-tone="' + (data.error ? 'bad' : 'ok') + '"><div><b>'
    + shell.escapeHtml(data.flash) + '</b></div></div>' : '';
  const options = ['<option value="">All promotions</option>'].concat(promotions.map((item) =>
    '<option value="' + shell.escapeHtml(item.id) + '"' + (promotion === item.id ? ' selected' : '') + '>'
      + shell.escapeHtml(item.name) + '</option>')).join('');
  const rows = filtered.map((event) => {
    const patch = overrides[event.id] || {};
    const effectiveDate = patch.date || event.date || '';
    const changed = Object.prototype.hasOwnProperty.call(patch, 'date');
    const action = '/admin/events/' + encodeURIComponent(event.id) + '/date';
    return '<div class="panel">'
      + '<div class="panel-head"><div><h3>' + shell.escapeHtml(event.name || 'Untitled event') + '</h3>'
      + '<p>' + shell.escapeHtml(event.promotion || 'Unknown promotion') + ' · <code>' + shell.escapeHtml(event.id) + '</code></p></div>'
      + (changed ? '<span class="chip" data-tone="warn">Date overridden</span>' : '<span class="chip plain" data-tone="off">Source date</span>')
      + '</div><div class="panel-body">'
      + '<div class="grid-2"><div><span class="row-sub">Source date</span><strong>' + shell.escapeHtml(event.date || 'None') + '</strong></div>'
      + '<div><span class="row-sub">Catalog date</span><strong>' + shell.escapeHtml(effectiveDate || 'None') + '</strong></div></div>'
      + '<form method="POST" action="' + action + '" style="margin-top:14px"><label class="f"><span>Correct date</span>'
      + '<input class="t" type="date" name="date" required value="' + shell.escapeHtml(effectiveDate) + '"></label>'
      + '<input type="hidden" name="returnTo" value="' + shell.escapeHtml(path) + '">'
      + '<div style="margin-top:10px;display:flex;gap:10px"><button class="btn primary" type="submit">Save date</button>'
      + (changed ? '<button class="btn ghost" type="submit" formaction="/admin/events/' + encodeURIComponent(event.id) + '/date/reset">Use source date</button>' : '')
      + '</div></form></div></div>';
  }).join('') || '<div class="note" data-tone="info"><div><b>No events matched.</b><span>Try a different event name, ID, date, or promotion.</span></div></div>';
  return '<div class="wrap"><div class="lede"><h2>Event Editor</h2><p>Correct a source date without changing the source. The override is reapplied after every refresh until you remove it.</p></div>'
    + flash
    + '<form method="GET" action="/admin/events" class="panel"><div class="panel-body"><div class="grid-2">'
    + '<label class="f"><span>Find event</span><input class="t" name="q" value="' + shell.escapeHtml(query.q || '') + '" placeholder="Name, event ID, or date"></label>'
    + '<label class="f"><span>Promotion</span><select class="t" name="promotion">' + options + '</select></label>'
    + '</div><div style="margin-top:12px"><button class="btn ghost" type="submit">Search events</button></div></div></form>'
    + '<div class="hint" style="margin:14px 0">Showing ' + filtered.length + ' of ' + allEvents.length + ' events (up to 100 matching results).</div>'
    + rows + '</div>';
}

module.exports = { renderBody, returnPath };
