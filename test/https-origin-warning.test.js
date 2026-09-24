'use strict';
// Issue #31: behind an HTTPS proxy without PUBLIC_URL, SSS generates http://
// install and playback links. Both install pages carry a hidden warning that
// the browser reveals when the page is HTTPS and the manifest link is HTTP.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { httpsOriginWarning } = require('../lib/https-origin-warning');

function reveal(protocol, value) {
  const html = httpsOriginWarning('murl', 'alert');
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const note = { style: { display: 'none' } };
  vm.runInNewContext(script, {
    location: { protocol },
    document: { getElementById: (id) => id === 'murl' ? { value } : id === 'https-origin-warning-murl' ? note : null },
  });
  return note.style.display !== 'none';
}

test('the warning shows only for an HTTPS page generating HTTP links', () => {
  assert.equal(reveal('https:', 'http://sss.example.com/u/1/t/manifest.json'), true);
  assert.equal(reveal('https:', 'https://sss.example.com/u/1/t/manifest.json'), false);
  assert.equal(reveal('http:', 'http://192.168.1.16:7000/u/1/t/manifest.json'), false);
  assert.match(httpsOriginWarning('murl', 'alert'), /style="display:none"/);
  assert.match(httpsOriginWarning('murl', 'alert'), /PUBLIC_URL/);
});

test('the setup wizard install step includes the warning', () => {
  const configurePage = require('../lib/configure-page');
  const src = require('node:fs').readFileSync(require.resolve('../lib/configure-page'), 'utf8');
  assert.match(src, /httpsOriginWarning\('manifest-url'/);
  const addon = require('node:fs').readFileSync(require.resolve('../addon.js'), 'utf8');
  assert.match(addon, /httpsOriginWarning\('murl'/);
  assert.ok(configurePage);
});
