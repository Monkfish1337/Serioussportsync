// 0.37.0 — Tabler-based page chrome.
//
// Replaces the hand-rolled accountPage() wrapper from earlier releases.
// Loads Tabler v1.x CSS + JS from the installed package (no build step), wraps
// the supplied body HTML in a dark-themed shell with:
//   - Topbar: compact version marker
//   - Sidebar: brand, account/profile/logout, plus every admin section for
//     administrators, with the currentSection highlighted
//   - Main content area: bodyHtml dropped into a Tabler container
//
// Non-admin users receive the same identity/account sidebar with admin-only
// navigation omitted.
//
// The red accent (--accent / --tblr-primary) is preserved via a small CSS
// override block so SSS keeps its visual identity instead of inheriting
// Tabler's default blue.
//
// Auth pages (/login, /invite) call tablerPage with opts.layout = 'auth'
// to get a centered-card layout instead of the full shell.

// Served by addon.js from the installed @tabler/core package. Previously these
// were cdn.jsdelivr.net URLs, which made a self-hosted addon's admin page
// unstyled on any network that could not reach the CDN — and gave no hint why.
// The version is in the query so a browser cache cannot outlive an upgrade.
const TABLER_VERSION = (() => {
  try { return require('@tabler/core/package.json').version || '1'; }
  catch (_) { return '1'; }
})();
const TABLER_CSS = '/assets/vendor/tabler/css/tabler.min.css?v=' + TABLER_VERSION;
const TABLER_JS  = '/assets/vendor/tabler/js/tabler.min.js?v=' + TABLER_VERSION;

const APP_VERSION = (() => {
  try { return require('../package.json').version || ''; }
  catch (_) { return ''; }
})();

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// Sidebar sections for admin users. Each entry: { id, label, href, icon }.
// `icon` is an SVG path data string from tabler-icons.io (24x24, stroke).
// We inline the SVG so we don't need a separate icon font request.
const ADMIN_SECTIONS = [
  { id: 'admin',        label: 'Admin',         href: '/admin',
    icon: 'M3 12l2 0 m4 0l6 0 m4 0l2 0 M3 5l2 0 m4 0l6 0 m4 0l2 0 M3 19l2 0 m4 0l6 0 m4 0l2 0' },
  { id: 'database',     label: 'Database',      href: '/admin/database',
    icon: 'M4 6c0 -1.1 3.6 -2 8 -2s8 .9 8 2s-3.6 2 -8 2s-8 -.9 -8 -2 M4 6v12c0 1.1 3.6 2 8 2s8 -.9 8 -2v-12 M4 12c0 1.1 3.6 2 8 2s8 -.9 8 -2' },
  { id: 'sport-video',  label: 'Sport-Video',   href: '/admin/sport-video',
    icon: 'M15 10l4.553 -2.276a1 1 0 0 1 1.447 .894v6.764a1 1 0 0 1 -1.447 .894l-4.553 -2.276v-4z M3 6m0 2a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2z' },
  { id: 'logs',         label: 'Logs',          href: '/admin/logs',
    icon: 'M14 3v4a1 1 0 0 0 1 1h4 M5 13v-8a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2h-4 M9 17h-7 M5 14l-3 3l3 3' },
  { id: 'promotions',   label: 'Promotions',    href: '/admin/promotions',
    icon: 'M7 4l10 0 M7 20l10 0 M5 4v6a4 4 0 0 0 4 4l6 0a4 4 0 0 0 4 -4v-6 M12 14l0 6' },
  { id: 'metadata',     label: 'Metadata',      href: '/admin/metadata',
    icon: 'M4 6c0 -1.1 3.6 -2 8 -2s8 .9 8 2s-3.6 2 -8 2s-8 -.9 -8 -2 M4 6v6c0 1.1 3.6 2 8 2s8 -.9 8 -2v-6 M4 12v6c0 1.1 3.6 2 8 2s8 -.9 8 -2v-6' },
  { id: 'nuvio-collections', label: 'Nuvio Collections', href: '/admin/nuvio-collections',
    icon: 'M4 5h16v4h-16z M4 13h7v6h-7z M15 13h5v6h-5z' },
  { id: 'backup',       label: 'Backup',        href: '/admin/backup',
    icon: 'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2 M7 11l5 5l5 -5 M12 4l0 12' },
];

function buildSidebar(currentSection, user, isAdmin) {
  let items = '';
  for (const s of (isAdmin ? ADMIN_SECTIONS : [])) {
    const active = (s.id === currentSection) ? ' active' : '';
    items += ''
      + '<li class="nav-item' + active + '">'
      +   '<a class="nav-link" href="' + escapeHtml(s.href) + '">'
      +     '<span class="nav-link-icon d-md-none d-lg-inline-block">'
      +       '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      +         '<path stroke="none" d="M0 0h24v24H0z" fill="none"/>'
      +         '<path d="' + s.icon + '"/>'
      +       '</svg>'
      +     '</span>'
      +     '<span class="nav-link-title">' + escapeHtml(s.label) + '</span>'
      +   '</a>'
      + '</li>';
  }
  // DIY Usenet is per-account configuration, not an operator tool, so it sits
  // beside Account in the sidebar for every signed-in user rather than in the
  // admin section above.
  const usenetActive = currentSection === 'usenet' ? ' active' : '';
  const usenetItem = ''
    + '<li class="nav-item' + usenetActive + '">'
    +   '<a class="nav-link" href="/account/usenet">'
    +     '<span class="nav-link-icon d-md-none d-lg-inline-block">'
    +       '<svg xmlns="http://www.w3.org/2000/svg" class="icon" width="24" height="24" viewBox="0 0 24 24" '
    +       'stroke-width="2" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">'
    +       '<path stroke="none" d="M0 0h24v24H0z" fill="none"/>'
    +       '<path d="M3 19a9 9 0 0 1 9 -9 M3 5a15 15 0 0 1 15 15 M4 18a1 1 0 1 0 2 0a1 1 0 0 0 -2 0"/>'
    +       '</svg>'
    +     '</span>'
    +     '<span class="nav-link-title">DIY Usenet</span>'
    +   '</a>'
    + '</li>';

  const accountActive = currentSection === 'account' ? ' active' : '';
  items += ''
    + '<li class="nav-item' + accountActive + '">'
    +   '<a class="nav-link" href="/account">'
    +     '<span class="nav-link-icon d-md-none d-lg-inline-block">'
    +       '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    +         '<path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0 M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"/>'
    +       '</svg>'
    +     '</span>'
    +     '<span class="nav-link-title">Account</span>'
    +   '</a>'
    + '</li>'
    + usenetItem;
  const username = (user && user.username) || '';
  const role = (user && user.role) || '';
  const profile = user ? ''
    + '<div class="w-100 border-top mt-3 pt-3 pb-2">'
    +   '<a href="/account" class="d-flex align-items-center text-reset text-decoration-none px-2 mb-2" aria-label="Profile">'
    +     '<span class="avatar avatar-sm bg-red-lt me-2">' + escapeHtml((username[0] || '?').toUpperCase()) + '</span>'
    +     '<span class="overflow-hidden"><span class="d-block text-truncate">' + escapeHtml(username) + '</span>'
    +       '<span class="d-block small text-secondary text-truncate">' + escapeHtml(role) + '</span></span>'
    +   '</a>'
    +   '<form method="POST" action="/logout" class="px-2">'
    +     '<button type="submit" class="btn btn-outline-secondary btn-sm w-100">Log out</button>'
    +   '</form>'
    + '</div>' : '';
  return ''
    + '<aside class="navbar navbar-vertical navbar-expand-lg" data-bs-theme="dark">'
    +   '<div class="container-fluid">'
    +     '<button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#sidebar-menu">'
    +       '<span class="navbar-toggler-icon"></span>'
    +     '</button>'
    +     '<div class="navbar-brand navbar-brand-autodark">'
    +       '<a href="' + (isAdmin ? '/admin' : '/account') + '" class="d-flex align-items-center text-decoration-none">'
    +         '<span class="sss-brand-logo me-2">SSS</span>'
    +         '<span class="text-white fw-semibold">SeriousSportSync</span>'
    +       '</a>'
    +     '</div>'
    +     '<div class="collapse navbar-collapse" id="sidebar-menu">'
    +       '<ul class="navbar-nav pt-lg-3">' + items + '</ul>'
    +       profile
    +     '</div>'
    +   '</div>'
    + '</aside>';
}

function buildTopbar(user, isAdminLayout) {
  return ''
    + '<header class="navbar navbar-expand-md d-print-none" data-bs-theme="dark">'
    +   '<div class="container-xl">'
    +     '<div class="navbar-nav flex-row order-md-last ms-auto">'
    +       '<div class="d-none d-md-flex align-items-center me-3">'
    +         '<span class="badge bg-secondary-lt text-secondary">v' + escapeHtml(APP_VERSION) + '</span>'
    +       '</div>'
    +     '</div>'
    +   '</div>'
    + '</header>';
}

// SSS brand overrides, layered over the vendored Tabler stylesheet.
//
// 0.90.8 — the colours come from the selected skin rather than being pinned to
// the original red. Everything Tabler derives for itself is still left alone;
// this only sets what it cannot derive. See lib/skins.js.
//
// Legacy variable aliases (--bg, --panel, --text, --muted, --accent, etc.)
// remain for the few older inline-styled fragments that still use them, and
// now follow the skin like everything else.
function themeCss(skin) {
  const skins = require('./skins');
  return `
:root, [data-bs-theme=dark], [data-bs-theme=light] {
  ${skins.cssVariables(skin)}
  /* Legacy SSS variable aliases for pre-Tabler inline styles */
  --bg: var(--tblr-body-bg);
  --panel: var(--tblr-bg-surface);
  --text: var(--tblr-body-color);
  --muted: var(--tblr-secondary);
  --mute: var(--tblr-secondary);
  --border: var(--tblr-border-color);
  --accent: var(--sss-accent);
  --accent2: var(--sss-accent-hover);
  --fg: var(--tblr-body-color);
}
.btn-primary, .btn-primary:hover, .btn-primary:focus, .btn-primary:active {
  --tblr-btn-bg: var(--sss-accent);
  --tblr-btn-border-color: var(--sss-accent);
  --tblr-btn-hover-bg: var(--sss-accent-hover);
  --tblr-btn-hover-border-color: var(--sss-accent-hover);
  --tblr-btn-active-bg: var(--sss-accent-active);
  --tblr-btn-active-border-color: var(--sss-accent-active);
}
.sss-brand-logo {
  display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px;
  background: var(--sss-accent); color: #fff;
  border-radius: 6px;
  font-weight: 700; font-size: 12px;
  letter-spacing: 0.5px;
}
.page-body .card { margin-bottom: 1rem; }
.text-mono, .mono { font-family: ui-monospace, "SF Mono", "Cascadia Code", "Source Code Pro", Menlo, Consolas, monospace; }
.verdict-ok  { background: var(--tblr-green-lt); color: var(--tblr-green); padding: 2px 8px; border-radius: 4px; font-weight: 600; font-size: 12px; }
.verdict-rej { background: var(--tblr-red-lt);   color: var(--tblr-red);   padding: 2px 8px; border-radius: 4px; font-weight: 600; font-size: 12px; }
.verdict-err { background: var(--tblr-orange-lt);color: var(--tblr-orange);padding: 2px 8px; border-radius: 4px; font-weight: 600; font-size: 12px; }
`;
}

// The skin in force. Reading settings must never be what stops a page
// rendering, so an unreadable settings file falls back to the default rather
// than throwing out of the page chrome.
function activeSkin() {
  try {
    const skins = require('./skins');
    return skins.get(require('./settings').getAppearance().skin);
  } catch (_) {
    try { return require('./skins').get(null); } catch (__) { return null; }
  }
}

// Build the main full-shell page (admin + non-admin variants).
//
// opts:
//   user            — the logged-in user record (for the user menu / role check)
//   currentSection  — sidebar id to highlight (admin layout only)
//   layout          — 'admin' | 'user' | 'auth'  (auth = centered card, no shell)
function tablerPage(title, bodyHtml, opts) {
  opts = opts || {};
  const user = opts.user || null;
  const layoutHint = opts.layout || (user && user.role === 'admin' ? 'admin' : 'user');

  if (layoutHint === 'auth') {
    return authShell(title, bodyHtml, opts.skin || activeSkin());
  }

  const isAdmin = layoutHint === 'admin';
  const sidebar = buildSidebar(opts.currentSection || (isAdmin ? 'admin' : 'account'), user, isAdmin);
  const topbar  = buildTopbar(user, isAdmin);
  const skin = opts.skin || activeSkin();

  return [
    '<!doctype html><html lang="en" data-bs-theme="' + ((skin && skin.mode) === 'light' ? 'light' : 'dark') + '">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<title>' + escapeHtml(title) + ' — SeriousSportSync</title>',
    '<link href="' + TABLER_CSS + '" rel="stylesheet">',
    '<style>' + themeCss(skin) + '</style>',
    '</head>',
    '<body>',
    '<div class="page">',
    sidebar,
    '<div class="page-wrapper">',
    topbar,
    '<div class="page-body">',
    '<div class="container-xl">',
    bodyHtml,
    '</div></div></div></div>',
    '<script src="' + TABLER_JS + '"></script>',
    '</body></html>',
  ].join('');
}

// Centered single-card layout for /login + /invite. No sidebar, no topbar —
// just a brand + the supplied form.
function authShell(title, bodyHtml, skin) {
  const chosen = skin || activeSkin();
  return [
    '<!doctype html><html lang="en" data-bs-theme="' + ((chosen && chosen.mode) === 'light' ? 'light' : 'dark') + '">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<title>' + escapeHtml(title) + ' — SeriousSportSync</title>',
    '<link href="' + TABLER_CSS + '" rel="stylesheet">',
    '<style>' + themeCss(chosen) + '</style>',
    '</head>',
    '<body class="d-flex flex-column">',
    '<div class="page page-center">',
    '<div class="container container-tight py-4">',
    '<div class="text-center mb-4">',
    '<a href="/" class="navbar-brand navbar-brand-autodark d-inline-flex align-items-center text-decoration-none">',
    '<span class="sss-brand-logo me-2" style="width:40px;height:40px;font-size:14px;">SSS</span>',
    '<span class="text-white fw-semibold fs-3">SeriousSportSync</span>',
    '</a>',
    '</div>',
    '<div class="card card-md">',
    '<div class="card-body">',
    '<h2 class="h2 text-center mb-4">' + escapeHtml(title) + '</h2>',
    bodyHtml,
    '</div></div>',
    '</div></div>',
    '<script src="' + TABLER_JS + '"></script>',
    '</body></html>',
  ].join('');
}

module.exports = {
  tablerPage,
  escapeHtml,
  APP_VERSION,
  // Exposed for tests / external composition; not used in the normal path.
  buildSidebar,
  buildTopbar,
  authShell,
  themeCss,
  activeSkin,
  ADMIN_SECTIONS,
};
