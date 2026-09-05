'use strict';

// The admin skin.
//
// A skin supplies an accent triple, a corner radius and a mode; lib/ui/tokens
// turns that into the variable set every page renders through. The tests that
// matter are about what a skin must NOT do: break the page when settings are
// unreadable, accept an arbitrary value from a form post, or reintroduce a
// remote asset — the last of which would undo the reason the UI ships inline.

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

  // 0.92.0 — the same skin drives the new token set, which is what every page
  // now renders through. A skin that coloured only the retired variables would
  // pass the assertions above and change nothing on screen.
  const tokens = require('../lib/ui/tokens');
  const vars = tokens.variables(skins.get('newsprint'));
  assert.match(vars, /--accent: #4263eb;/);
  assert.match(vars, /--accent-rgb: 66, 99, 235;/, 'tints are mixed from the rgb triple');
  assert.match(vars, /--r: 10px;/);
  assert.match(vars, /--ground: #f2f4f8;/, 'a light skin must bring the light ground with it');
});

test('hexToRgb handles both shorthand and full notation', () => {
  assert.equal(skins.hexToRgb('#fff'), '255, 255, 255');
  assert.equal(skins.hexToRgb('#ef4444'), '239, 68, 68');
  assert.equal(skins.hexToRgb('ef4444'), '239, 68, 68');
  assert.equal(skins.hexToRgb('nonsense'), '0, 0, 0');
});

test('a light skin switches the whole token set, not just the accent', () => {
  const page = (id) => chrome.tablerPage('T', '<p>body</p>', {
    user: { username: 'a', role: 'admin' }, skin: skins.get(id),
  });
  assert.match(page('newsprint'), /<html lang="en" data-mode="light">/);
  assert.match(page('sportsroom'), /<html lang="en" data-mode="dark">/);
  // The whole token set swaps, not just the accent — a light mode that kept
  // the dark ground would be an unreadable page, which is the classic bug.
  assert.match(page('newsprint'), /--ground: #f2f4f8;/);
  assert.match(page('sportsroom'), /--ground: #0a111c;/);
});

test('the login page is skinned too, not left on the default', () => {
  const auth = chrome.authShell('Sign in', '<form></form>', skins.get('pitch'));
  assert.match(auth, /--accent: #/, 'the sign-in page renders through the design system');
  assert.match(auth, /--ground: #/);
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
  const shell = require('../lib/ui/shell');
  assert.doesNotThrow(() => shell.activeSkin());
  assert.doesNotThrow(() => shell.page({ user: null, title: 'x', body: '' }));
  const css = require('../lib/ui/css');
  assert.ok(css.stylesheet(null).includes('--accent'));
  assert.ok(css.stylesheet(undefined).includes('--ground'));
});
