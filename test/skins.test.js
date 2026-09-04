'use strict';

// The admin skin.
//
// Tabler is themed through CSS custom properties, not swappable stylesheets, so
// a skin is a small variable block layered over the one vendored
// tabler.min.css. The tests that matter are about what a skin must NOT do:
// break the page when settings are unreadable, accept an arbitrary value from
// a form post, or reintroduce a remote font request — the last of which would
// undo the whole reason Tabler was vendored in 0.90.0.

const test = require('node:test');
const assert = require('node:assert/strict');
const skins = require('../lib/skins');
const chrome = require('../lib/tabler-chrome');

test('every skin is complete and internally consistent', () => {
  const ids = new Set();
  for (const skin of skins.list()) {
    assert.match(skin.id, /^[a-z0-9-]+$/, 'skin ids are used in URLs and CSS keys');
    assert.equal(ids.has(skin.id), false, 'duplicate skin id: ' + skin.id);
    ids.add(skin.id);
    assert.ok(skin.name && skin.description, skin.id + ' needs a name and a description');
    assert.ok(skin.mode === 'dark' || skin.mode === 'light', skin.id + ' has no valid mode');
    for (const shade of ['accent', 'accentHover', 'accentActive']) {
      assert.match(skin[shade], /^#[0-9a-f]{6}$/i, skin.id + '.' + shade + ' must be a hex colour');
    }
    assert.match(skin.radius, /^\d+px$/, skin.id + ' needs a pixel radius');
  }
  // A set with no light option, or only one dark, would not be worth a picker.
  assert.ok(skins.list().some((skin) => skin.mode === 'light'));
  assert.ok(skins.list().filter((skin) => skin.mode === 'dark').length >= 2);
});

test('an unknown skin falls back rather than rendering an unstyled page', () => {
  for (const bad of [null, undefined, '', 'nonsense', '../../etc/passwd', 42]) {
    assert.equal(skins.get(bad).id, skins.DEFAULT_SKIN, JSON.stringify(bad) + ' should fall back');
    assert.equal(skins.isKnown(bad), false);
  }
  assert.equal(skins.isKnown('SPORTSROOM'), true, 'ids are matched case-insensitively');
});

test('the variable block carries the accent in both hex and rgb', () => {
  // Tabler derives its tints from --tblr-primary-rgb, so a skin that set only
  // the hex would colour the buttons and leave every .bg-primary-lt wash the
  // old colour.
  const css = skins.cssVariables(skins.get('newsprint'));
  assert.match(css, /--tblr-primary: #4263eb;/);
  assert.match(css, /--tblr-primary-rgb: 66, 99, 235;/);
  assert.match(css, /--tblr-border-radius: 10px;/);
  assert.match(css, /--sss-accent: #4263eb;/);
});

test('hexToRgb handles both shorthand and full notation', () => {
  assert.equal(skins.hexToRgb('#fff'), '255, 255, 255');
  assert.equal(skins.hexToRgb('#ef4444'), '239, 68, 68');
  assert.equal(skins.hexToRgb('ef4444'), '239, 68, 68');
  assert.equal(skins.hexToRgb('nonsense'), '0, 0, 0');
});

test('a light skin actually switches Tabler into light mode', () => {
  const page = (id) => chrome.tablerPage('T', '<p>body</p>', {
    user: { username: 'a', role: 'admin' }, skin: skins.get(id),
  });
  assert.match(page('newsprint'), /<html lang="en" data-bs-theme="light">/);
  assert.match(page('sportsroom'), /<html lang="en" data-bs-theme="dark">/);
  // The sidebar stays dark in both — it is chrome, and its white text and
  // brand mark depend on it.
  assert.match(page('newsprint'), /navbar-vertical[^>]*data-bs-theme="dark"/);
});

test('the login page is skinned too, not left on the default', () => {
  const auth = chrome.authShell('Sign in', '<form></form>', skins.get('pitch'));
  assert.match(auth, /--tblr-primary: #2fbf71;/);
});

test('no skin reintroduces a remote asset', () => {
  // Vendoring Tabler in 0.90.0 was specifically so a self-hosted addon renders
  // on a network with no CDN access. A skin that pulled a webfont would undo
  // that silently — the page would still work for whoever added the skin.
  for (const skin of skins.list()) {
    const html = chrome.tablerPage('T', '', { user: { username: 'a', role: 'admin' }, skin });
    assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic|jsdelivr|unpkg|cdnjs|@import/,
      skin.id + ' pulls a remote asset');
  }
});

test('a broken settings file leaves the chrome renderable', () => {
  // activeSkin is called on every page render. If it could throw, an
  // unreadable settings file would take down the admin entirely — including
  // the page an operator would use to fix it.
  assert.doesNotThrow(() => chrome.activeSkin());
  assert.ok(chrome.themeCss(null).includes('--tblr-primary'));
  assert.ok(chrome.themeCss(undefined).includes('--sss-accent'));
});
