'use strict';

// 0.91.0 — the SSS design system, part three: the page shell.
//
// A slim icon rail of DESTINATIONS, a topbar that carries the page's own
// controls, and content. The rail is deliberately not a settings menu: it
// answers "where am I", and everything a page does lives on that page.
//
// This runs alongside lib/tabler-chrome.js rather than replacing it in one
// go. Pages move over one at a time; whatever has not moved keeps rendering
// exactly as it did, and the two can be told apart on sight, which is what
// makes a migration reviewable.

const css = require('./css');
const skins = require('../skins');

const APP_VERSION = (() => {
  try { return require('../../package.json').version || ''; }
  catch (_) { return ''; }
})();

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// Reading settings must never be the thing that stops a page rendering — the
// page an operator would use to fix a broken settings file is one of these.
function activeSkin() {
  try {
    const settings = require('../settings');
    return skins.get(settings.getAppearance().skin);
  } catch (_) {
    try { return skins.get(null); } catch (__) { return null; }
  }
}

const ICONS = {
  configure: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="7" cy="18" r="2" fill="currentColor" stroke="none"/>',
  usenet: '<path d="M3 19a9 9 0 0 1 9 -9M3 5a15 15 0 0 1 15 15"/><circle cx="5" cy="18" r="1.2"/>',
  admin: '<path d="M3 12h2m4 0h6m4 0h2M3 5h2m4 0h6m4 0h2M3 19h2m4 0h6m4 0h2"/>',
  sportVideo: '<rect x="3" y="6" width="12" height="12" rx="2"/><path d="M15 10l4.5-2.3a1 1 0 0 1 1.5.9v6.8a1 1 0 0 1-1.5.9L15 14z"/>',
  promotions: '<path d="M7 4h10M7 20h10M5 4v6a4 4 0 0 0 4 4h6a4 4 0 0 0 4-4V4M12 14v6"/>',
  database: '<path d="M4 6c0-1.1 3.6-2 8-2s8 .9 8 2-3.6 2-8 2-8-.9-8-2M4 6v12c0 1.1 3.6 2 8 2s8-.9 8-2V6M4 12c0 1.1 3.6 2 8 2s8-.9 8-2"/>',
  logs: '<path d="M14 3v4a1 1 0 0 0 1 1h4M5 13V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2h-4M9 17H2M5 14l-3 3 3 3"/>',
  collections: '<path d="M4 5h16v4H4zM4 13h7v6H4zM15 13h5v6h-5z"/>',
  account: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1"/>',
};

function icon(name) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + (ICONS[name] || ICONS.configure) + '</svg>';
}

// Destinations, in the order someone actually needs them: your own setup
// first, operator tools after.
function destinations(isAdmin) {
  const items = [
    { id: 'configure', label: 'Configure', href: '/account', icon: 'configure' },
    { id: 'usenet', label: 'DIY Usenet', href: '/account/usenet', icon: 'usenet' },
  ];
  if (isAdmin) {
    items.push(
      { id: 'admin', label: 'Server', href: '/admin', icon: 'admin' },
      { id: 'promotions', label: 'Promotions', href: '/admin/promotions', icon: 'promotions' },
      { id: 'sport-video', label: 'Sport-Video', href: '/admin/sport-video', icon: 'sportVideo' },
      { id: 'nuvio-collections', label: 'Collections', href: '/admin/nuvio-collections', icon: 'collections' },
      { id: 'database', label: 'Database', href: '/admin/database', icon: 'database' },
      { id: 'logs', label: 'Logs', href: '/admin/logs', icon: 'logs' }
    );
  }
  return items;
}

function rail(current, user, isAdmin) {
  const items = destinations(isAdmin).map((item) => ''
    + '<a class="rail-btn" href="' + escapeHtml(item.href) + '"'
    + (item.id === current ? ' aria-current="page"' : '') + '>'
    + icon(item.icon)
    + '<span class="rail-tip">' + escapeHtml(item.label) + '</span>'
    + '</a>').join('');
  const name = (user && user.username) || '';
  return ''
    + '<nav class="rail" aria-label="Sections">'
    + '<a class="rail-mark" href="' + (isAdmin ? '/admin' : '/account') + '" aria-label="SeriousSportSync">SSS</a>'
    + items
    + '<div class="rail-spacer"></div>'
    + '<form method="POST" action="/logout">'
    + '<button class="rail-btn" type="submit" aria-label="Log out ' + escapeHtml(name) + '">'
    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M14 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2M9 12h11M17 9l3 3-3 3"/></svg>'
    + '<span class="rail-tip">Log out ' + escapeHtml(name) + '</span>'
    + '</button></form>'
    + '</nav>';
}

// opts: { user, section, title, subtitle, controls, steprail, body, actions, head }
function page(opts) {
  const options = opts || {};
  const user = options.user || null;
  const isAdmin = !!(user && user.role === 'admin');
  const skin = options.skin || activeSkin();
  const mode = (skin && skin.mode) === 'light' ? 'light' : 'dark';

  const topbar = ''
    + '<header class="topbar">'
    + '<h1>' + escapeHtml(options.title || 'SeriousSportSync')
    + (options.subtitle ? ' <small>' + escapeHtml(options.subtitle) + '</small>' : '')
    + '</h1>'
    + '<div class="right">' + (options.controls || '')
    + '<span class="chip plain" data-tone="off">v' + escapeHtml(APP_VERSION) + '</span>'
    + '</div>'
    + '</header>';

  return [
    '<!doctype html><html lang="en" data-mode="' + mode + '">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="color-scheme" content="' + (mode === 'light' ? 'light' : 'dark') + '">',
    '<title>' + escapeHtml(options.title || 'SeriousSportSync') + ' — SeriousSportSync</title>',
    '<style>' + css.stylesheet(skin) + '</style>',
    options.head || '',
    '</head>',
    '<body>',
    '<div class="app">',
    rail(options.section, user, isAdmin),
    '<div class="main">',
    topbar,
    options.steprail || '',
    '<div class="scroll">' + (options.body || '') + '</div>',
    options.actions || '',
    '</div></div>',
    options.script ? '<script>' + options.script + '</script>' : '',
    '</body></html>',
  ].join('');
}

// Centred card for /login and /invite. Same tokens, no shell.
function authPage(title, bodyHtml, opts) {
  const options = opts || {};
  const skin = options.skin || activeSkin();
  const mode = (skin && skin.mode) === 'light' ? 'light' : 'dark';
  return [
    '<!doctype html><html lang="en" data-mode="' + mode + '">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="color-scheme" content="' + (mode === 'light' ? 'light' : 'dark') + '">',
    '<title>' + escapeHtml(title) + ' — SeriousSportSync</title>',
    '<style>' + css.stylesheet(skin) + '</style>',
    '</head>',
    '<body><div class="auth"><div class="auth-card">',
    '<div class="auth-brand">',
    '<span class="rail-mark" style="margin:0">SSS</span>',
    '<strong style="font-family:var(--font-cond);font-size:20px;letter-spacing:.04em;text-transform:uppercase">SeriousSportSync</strong>',
    '</div>',
    '<div class="panel"><div class="panel-head"><h2>' + escapeHtml(title) + '</h2></div>',
    '<div class="panel-body">' + bodyHtml + '</div></div>',
    '</div></div></body></html>',
  ].join('');
}

module.exports = { page, authPage, escapeHtml, icon, rail, destinations, activeSkin, APP_VERSION };
