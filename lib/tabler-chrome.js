// 0.37.0 — Tabler-based page chrome.
//
// Replaces the hand-rolled accountPage() wrapper from earlier releases.
// Loads Tabler v1.x CSS + JS from cdn.jsdelivr.net (no build step), wraps
// the supplied body HTML in a dark-themed shell with:
//   - Topbar: brand + version + user menu + logout
//   - Sidebar (admin only): links to every admin section, with the
//     currentSection highlighted
//   - Main content area: bodyHtml dropped into a Tabler container
//
// Non-admin users see only the topbar (no sidebar — they only have /account
// anyway, so a one-link sidebar would just waste space).
//
// The red accent (--accent / --tblr-primary) is preserved via a small CSS
// override block so SSS keeps its visual identity instead of inheriting
// Tabler's default blue.
//
// Auth pages (/login, /invite) call tablerPage with opts.layout = 'auth'
// to get a centered-card layout instead of the full shell.

const TABLER_CSS = 'https://cdn.jsdelivr.net/npm/@tabler/core@1.0.0/dist/css/tabler.min.css';
const TABLER_JS  = 'https://cdn.jsdelivr.net/npm/@tabler/core@1.0.0/dist/js/tabler.min.js';

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
  { id: 'health',       label: 'Health',        href: '/admin/health',
    icon: 'M3 12h4l3 8 4 -16 3 8h4' },
  { id: 'logs',         label: 'Logs',          href: '/admin/logs',
    icon: 'M14 3v4a1 1 0 0 0 1 1h4 M5 13v-8a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2h-4 M9 17h-7 M5 14l-3 3l3 3' },
  { id: 'power-tool',   label: 'Power Tool',    href: '/admin/power-tool',
    icon: 'M7 10h3v-3l-3.5 -3.5a6 6 0 0 1 8 8l6 6l-2 2l-6 -6a6 6 0 0 1 -8 -8l3.5 3.5' },
  // 0.39.0 — general search + grab (queries both Prowlarr instances, sends to qBit/SAB)
  { id: 'search',       label: 'Search',        href: '/admin/search',
    icon: 'M21 21l-6 -6 M10 17a7 7 0 1 0 0 -14a7 7 0 0 0 0 14z' },
  { id: 'match-editor', label: 'Match Editor',  href: '/admin/match-editor',
    icon: 'M12 21l-8 -4.5v-9l8 -4.5l8 4.5v9l-8 4.5 M12 12l8 -4.5 M12 12v9 M12 12l-8 -4.5' },
  { id: 'promotions',   label: 'Promotions',    href: '/admin/promotions',
    icon: 'M7 4l10 0 M7 20l10 0 M5 4v6a4 4 0 0 0 4 4l6 0a4 4 0 0 0 4 -4v-6 M12 14l0 6' },
  { id: 'content',      label: 'Content Studio', href: '/admin/content',
    icon: 'M4 6h16 M4 12h16 M4 18h10 M8 3v6 M16 9v6 M10 15v6' },
  { id: 'backup',       label: 'Backup',        href: '/admin/backup',
    icon: 'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2 M7 11l5 5l5 -5 M12 4l0 12' },
];

function buildSidebar(currentSection) {
  let items = '';
  for (const s of ADMIN_SECTIONS) {
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
  return ''
    + '<aside class="navbar navbar-vertical navbar-expand-lg" data-bs-theme="dark">'
    +   '<div class="container-fluid">'
    +     '<button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#sidebar-menu">'
    +       '<span class="navbar-toggler-icon"></span>'
    +     '</button>'
    +     '<div class="navbar-brand navbar-brand-autodark">'
    +       '<a href="/admin" class="d-flex align-items-center text-decoration-none">'
    +         '<span class="sss-brand-logo me-2">SSS</span>'
    +         '<span class="text-white fw-semibold">SeriousSportSync</span>'
    +       '</a>'
    +     '</div>'
    +     '<div class="collapse navbar-collapse" id="sidebar-menu">'
    +       '<ul class="navbar-nav pt-lg-3">' + items + '</ul>'
    +     '</div>'
    +   '</div>'
    + '</aside>';
}

function buildTopbar(user, isAdminLayout) {
  const username = (user && user.username) || '';
  const role = (user && user.role) || '';
  const userMenu = user ? ''
    + '<div class="nav-item dropdown">'
    +   '<a href="#" class="nav-link d-flex lh-1 text-reset p-0" data-bs-toggle="dropdown">'
    +     '<span class="avatar avatar-sm bg-red-lt">' + escapeHtml((username[0] || '?').toUpperCase()) + '</span>'
    +     '<div class="d-none d-xl-block ps-2">'
    +       '<div>' + escapeHtml(username) + '</div>'
    +       '<div class="mt-1 small text-secondary">' + escapeHtml(role) + '</div>'
    +     '</div>'
    +   '</a>'
    +   '<div class="dropdown-menu dropdown-menu-end dropdown-menu-arrow">'
    +     '<a href="/account" class="dropdown-item">Account</a>'
    +     '<div class="dropdown-divider"></div>'
    +     '<a href="/logout" class="dropdown-item">Logout</a>'
    +   '</div>'
    + '</div>'
    : '';

  // For non-admin layouts we put the SSS brand in the topbar (since there's
  // no sidebar to carry it).
  const brandInTopbar = !isAdminLayout
    ? '<a href="/account" class="navbar-brand d-flex align-items-center text-decoration-none">'
      +   '<span class="sss-brand-logo me-2">SSS</span>'
      +   '<span class="text-white fw-semibold">SeriousSportSync</span>'
      + '</a>'
    : '';

  return ''
    + '<header class="navbar navbar-expand-md d-print-none" data-bs-theme="dark">'
    +   '<div class="container-xl">'
    +     brandInTopbar
    +     '<div class="navbar-nav flex-row order-md-last ms-auto">'
    +       '<div class="d-none d-md-flex align-items-center me-3">'
    +         '<span class="badge bg-secondary-lt text-secondary">v' + escapeHtml(APP_VERSION) + '</span>'
    +       '</div>'
    +       userMenu
    +     '</div>'
    +   '</div>'
    + '</header>';
}

// SSS brand colour overrides. Tabler defaults to blue (#066fd1) for primary,
// we want our red. Variables follow Tabler/Bootstrap 5 naming.
//
// Legacy variable aliases (--bg, --panel, --text, --muted, --accent, etc.)
// are also defined here so any inline-styled page (currently /admin/power-tool)
// that uses the old SSS variable names keeps rendering correctly without a
// full Tabler-classes rewrite. These can be retired once every page uses
// pure Tabler classes.
const SSS_THEME_CSS = `
:root, [data-bs-theme=dark] {
  --tblr-primary: #ef4444;
  --tblr-primary-rgb: 239, 68, 68;
  --tblr-primary-fg: #fff;
  --tblr-primary-darken: #dc2626;
  --tblr-primary-lt: rgba(239, 68, 68, 0.12);
  --tblr-link-color: #ef4444;
  --tblr-link-hover-color: #dc2626;
  /* Legacy SSS variable aliases for pre-Tabler inline styles */
  --bg: var(--tblr-body-bg);
  --panel: var(--tblr-bg-surface);
  --text: var(--tblr-body-color);
  --muted: var(--tblr-secondary);
  --mute: var(--tblr-secondary);
  --border: var(--tblr-border-color);
  --accent: #ef4444;
  --accent2: #dc2626;
  --fg: var(--tblr-body-color);
}
.btn-primary, .btn-primary:hover, .btn-primary:focus, .btn-primary:active {
  --tblr-btn-bg: #ef4444;
  --tblr-btn-border-color: #ef4444;
  --tblr-btn-hover-bg: #dc2626;
  --tblr-btn-hover-border-color: #dc2626;
  --tblr-btn-active-bg: #b91c1c;
  --tblr-btn-active-border-color: #b91c1c;
}
.sss-brand-logo {
  display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px;
  background: #ef4444; color: #fff;
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
    return authShell(title, bodyHtml);
  }

  const isAdmin = layoutHint === 'admin';
  const sidebar = isAdmin ? buildSidebar(opts.currentSection || 'admin') : '';
  const topbar  = buildTopbar(user, isAdmin);

  return [
    '<!doctype html><html lang="en" data-bs-theme="dark">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<title>' + escapeHtml(title) + ' — SeriousSportSync</title>',
    '<link href="' + TABLER_CSS + '" rel="stylesheet">',
    '<style>' + SSS_THEME_CSS + '</style>',
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
function authShell(title, bodyHtml) {
  return [
    '<!doctype html><html lang="en" data-bs-theme="dark">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<title>' + escapeHtml(title) + ' — SeriousSportSync</title>',
    '<link href="' + TABLER_CSS + '" rel="stylesheet">',
    '<style>' + SSS_THEME_CSS + '</style>',
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
  ADMIN_SECTIONS,
};
