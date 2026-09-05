// 0.37.0 — page chrome. Tabler-based until 0.92.0, an adapter over the SSS
// design system since.
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


const uiShell = require('./ui/shell');

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
// The rail's destinations live in lib/ui/shell now. ADMIN_SECTIONS and the
// Tabler sidebar/topbar builders that used to live here rendered navbar markup
// nothing styles any more, so they are gone rather than left as scenery.
// 0.92.0 — this is now a THIN ADAPTER over lib/ui/shell.
//
// Every page that still speaks Tabler's markup keeps calling tablerPage() and
// gets the new shell, tokens and controls without a line of its own HTML
// changing. lib/ui/compat.js maps the legacy class names onto the new tokens,
// so .card, .form-control and .btn-primary render in the new system.
//
// Keeping the old entry point rather than editing thirteen call sites is the
// point: the migration is one file, and it is reviewable. Pages are rewritten
// in the native vocabulary one at a time afterwards, with no visible jump when
// each lands.
//
// The Tabler package itself is no longer loaded — no stylesheet, no JS. The
// small amount of behaviour that came from its JS (dismissing an alert) is
// below, because it is two lines and the alternative is shipping a framework
// for them.
const CHROME_SCRIPT = [
  '(function(){',
  'document.addEventListener("click",function(e){',
  'var b=e.target&&e.target.closest?e.target.closest("[data-bs-dismiss=\'alert\']"):null;',
  'if(!b)return;e.preventDefault();var a=b.closest(".alert");if(a)a.remove();});',
  '}());',
].join('');

// Sidebar ids used by existing pages, mapped to the new rail's destinations.
const SECTION_ALIASES = { account: 'configure' };

function tablerPage(title, bodyHtml, opts) {
  opts = opts || {};
  const user = opts.user || null;
  const layoutHint = opts.layout || (user && user.role === 'admin' ? 'admin' : 'user');
  if (layoutHint === 'auth') return authShell(title, bodyHtml, opts.skin);

  const section = opts.currentSection || (layoutHint === 'admin' ? 'admin' : 'configure');
  return uiShell.page({
    user: user,
    section: SECTION_ALIASES[section] || section,
    title: title,
    subtitle: opts.subtitle || '',
    body: '<div class="wrap">' + bodyHtml + '</div>',
    script: CHROME_SCRIPT,
    skin: opts.skin,
  });
}

function authShell(title, bodyHtml, skin) {
  return uiShell.authPage(title, bodyHtml, { skin: skin });
}

module.exports = {
  tablerPage,
  escapeHtml,
  APP_VERSION,
  // Exposed for tests / external composition; not used in the normal path.
  authShell,
};
