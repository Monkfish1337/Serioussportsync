'use strict';

// The admin sidebar (issue #73): grouped by job, drawn as buttons with icons,
// and collapsible to icons only, remembered per browser.

const test = require('node:test');
const assert = require('node:assert/strict');
const shell = require('../lib/ui/shell');

const admin = { username: 'monkeh', role: 'admin' };

test('destinations are grouped by job, in order', () => {
  const groups = [];
  for (const item of shell.destinations(true)) if (item.group && groups[groups.length - 1] !== item.group) groups.push(item.group);
  assert.deepEqual(groups, ['Health', 'Sources', 'Content', 'System']);
  assert.equal(shell.destinations(false).some((item) => item.group), false, 'a non-admin sees no operator groups');
});

test('every destination is a button with an icon and a name that survives collapsing', () => {
  const html = shell.rail('promotions', admin, true);
  const links = html.match(/<a class="rail-btn"[\s\S]*?<\/a>/g) || [];
  assert.equal(links.length, shell.destinations(true).length);
  for (const link of links) {
    assert.match(link, /<svg /, 'each item has an icon');
    assert.match(link, / title="[^"]+"/, 'collapsed, the title names it');
  }
  assert.match(html, /<a class="rail-btn" href="\/admin\/promotions" title="Promotions" aria-current="page">/);
});

test('the rail collapses, and the choice is restored before the page draws', () => {
  const html = shell.rail('admin', admin, true);
  assert.match(html, /<button class="rail-toggle" type="button" aria-label="Collapse sidebar" aria-expanded="true"/);
  assert.match(html, /localStorage\.setItem\("sss\.rail"/);
  const page = shell.page({ user: admin, section: 'admin', body: '' });
  assert.ok(page.indexOf('sss.rail') < page.indexOf('<body>'), 'restored in <head>, so a collapsed rail never flashes open');
  assert.match(page, /try\{if\(localStorage\.getItem\("sss\.rail"\)==="collapsed"\)/, 'storage access is wrapped');
});
