'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const config = require('../config');
const contentStore = require('../lib/content-store');
const editor = require('../lib/event-editor');
const shell = require('../lib/ui/shell');

test('date overrides are composed over refresh-owned source events', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-event-editor-'));
  const original = config.contentStudioFile;
  config.contentStudioFile = path.join(dir, 'content-studio.json');
  try {
    contentStore.setOverride('ufc:100', { date: '2026-10-10' });
    const event = contentStore.compose([{ id: 'ufc:100', name: 'Fight Night', date: '2026-10-09' }])[0];
    assert.equal(event.date, '2026-10-10');
  } finally {
    config.contentStudioFile = original;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('event editor shows source and overridden dates and is in the sidebar', () => {
  const html = editor.renderBody({
    events: [{ id: 'ufc:100', promotion: 'ufc', name: 'Fight Night', date: '2026-10-09' }],
    overrides: { 'ufc:100': { date: '2026-10-10' } },
    promotions: [{ id: 'ufc', name: 'UFC' }],
  });
  assert.match(html, /Source date/);
  assert.match(html, /2026-10-10/);
  assert.match(html, /Use source date/);
  const ids = shell.destinations(true).map((item) => item.id);
  assert.equal(ids[ids.indexOf('promotions') + 1], 'events');
});
