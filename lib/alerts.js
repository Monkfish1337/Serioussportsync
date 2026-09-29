'use strict';

// Alerts (issue #75): Diagnosis findings sent to a webhook when they appear,
// plus an optional daily summary. A broken indexer used to be noticed days
// later, by hand; Diagnosis already finds it (e.g. "720pier: torrent downloads
// are failing"), so this only has to say so once, somewhere the operator looks.
//
// Every 30 minutes: collect the findings at or above the chosen severity,
// send the new ones (and those that got worse) in one message, and note the
// ones that cleared. A finding is sent once until it clears. State lives in
// data/alerts-state.json so a restart does not repeat everything.

const fs = require('fs');
const path = require('path');
const config = require('../config');

const INTERVAL_MS = 30 * 60 * 1000;
const RANK = { critical: 0, warning: 1, notice: 2 };
let timer = null;
let running = false;

function stateFile() {
  return path.join(path.dirname(config.availabilityDbFile || './data/availability.sqlite'), 'alerts-state.json');
}
function loadState(file) {
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return { sent: s.sent || {}, summaryDay: s.summaryDay || '' }; }
  catch (_) { return { sent: {}, summaryDay: '' }; }
}
function saveState(file, state) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(state, null, 1), { mode: 0o600 }); }
  catch (error) { console.error('[alerts] could not save state: ' + error.message); }
}

// Local date and hour in the display time zone, for the daily summary.
function local(now, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  return { day: parts.year + '-' + parts.month + '-' + parts.day, hour: Number(parts.hour) };
}

const LABEL = { critical: 'Critical', warning: 'Warning', notice: 'Notice' };
const line = (f) => LABEL[f.severity] + ': ' + f.title + (f.detail ? ' — ' + f.detail : '');

// One message in the webhook's own shape. `origin` links back to Diagnosis.
function payload(format, message, origin) {
  const link = origin ? origin.replace(/\/+$/, '') + '/admin/diagnosis' : '';
  const text = '**' + message.title + '**\n' + message.lines.join('\n') + (link ? '\n' + link : '');
  if (format === 'slack') return { text: text.replace(/\*\*/g, '*') };
  if (format === 'json') return { title: message.title, items: message.items, link };
  // Discord caps content at 2000 characters.
  return { content: text.length > 1990 ? text.slice(0, 1985) + '…' : text };
}

async function send(settings, message, deps) {
  const url = settings.webhookUrl;
  if (!url) return { ok: false, error: 'no-webhook' };
  const fetchImpl = deps.fetch || require('node-fetch');
  const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload(settings.format, message, deps.origin)), timeout: 10000 };
  try {
    const response = await fetchImpl(url, require('./http-agent').fetchOpts(opts, url));
    if (!response.ok) return { ok: false, error: 'HTTP ' + response.status };
    return { ok: true };
  } catch (error) {
    // The URL carries a token; never log or return it.
    return { ok: false, error: String(error && error.message || error).replace(url, '[webhook]').slice(0, 200) };
  }
}

function defaults() {
  return {
    now: Date.now,
    settings: () => require('./settings').getAlerts(),
    timeZone: () => require('./settings').getDisplayTimeZone(),
    collect: () => require('./diagnosis').collect(),
    file: stateFile(),
    origin: config.publicUrl || '',
    log: (message) => console.log('[alerts] ' + message),
  };
}

async function runOnce(options) {
  const d = Object.assign(defaults(), options || {});
  if (running) return { skipped: 'running' };
  running = true;
  try {
    const settings = d.settings();
    if (!settings.webhookUrl) return { skipped: 'no-webhook' };
    const now = d.now();
    const state = loadState(d.file);
    const result = d.collect();
    const limit = RANK[settings.minSeverity];
    const open = (result.findings || []).filter((f) => RANK[f.severity] <= limit);
    const sent = [];

    if (settings.immediate) {
      const fresh = open.filter((f) => !state.sent[f.id] || RANK[f.severity] < RANK[state.sent[f.id].severity]);
      const openIds = new Set(open.map((f) => f.id));
      const cleared = Object.entries(state.sent).filter(([id]) => !openIds.has(id)).map(([id, s]) => ({ id, severity: 'resolved', title: s.title }));
      if (fresh.length || cleared.length) {
        const message = {
          title: fresh.length ? 'SSS: ' + fresh.length + ' new problem' + (fresh.length === 1 ? '' : 's') : 'SSS: ' + cleared.length + ' resolved',
          lines: fresh.map(line).concat(cleared.map((f) => 'Resolved: ' + f.title)),
          items: fresh.map((f) => ({ id: f.id, severity: f.severity, stage: f.stage, title: f.title, detail: f.detail }))
            .concat(cleared.map((f) => ({ id: f.id, severity: 'resolved', title: f.title }))),
        };
        const out = await send(settings, message, d);
        if (out.ok) {
          for (const f of fresh) state.sent[f.id] = { severity: f.severity, title: f.title, at: new Date(now).toISOString() };
          for (const f of cleared) delete state.sent[f.id];
          sent.push('immediate');
        } else d.log('alert not sent: ' + out.error);
      }
    }

    if (settings.dailySummary) {
      const today = local(now, d.timeZone());
      if (today.hour >= settings.dailyHour && state.summaryDay !== today.day) {
        const counts = result.summary || {};
        const message = {
          title: 'SSS daily summary · ' + today.day,
          lines: open.length ? open.map(line) : ['Nothing to fix.'],
          items: open.map((f) => ({ id: f.id, severity: f.severity, stage: f.stage, title: f.title })),
        };
        message.lines.unshift((counts.critical || 0) + ' critical · ' + (counts.warning || 0) + ' warning · ' + (counts.notice || 0) + ' notice');
        const out = await send(settings, message, d);
        if (out.ok) { state.summaryDay = today.day; sent.push('summary'); }
        else d.log('summary not sent: ' + out.error);
      }
    }
    saveState(d.file, state);
    return { sent, open: open.length };
  } catch (error) {
    d.log('failed: ' + error.message);
    return { error: error.message };
  } finally {
    running = false;
  }
}

// The Send test button: proves the webhook works without waiting for a problem.
function test(options) {
  const d = Object.assign(defaults(), options || {});
  return send(d.settings(), { title: 'SSS test alert', lines: ['Alerts from SeriousSportSync will arrive here.'], items: [] }, d);
}

function start() {
  if (timer) return;
  const tick = () => { runOnce().catch(() => {}); };
  setTimeout(tick, 3 * 60 * 1000).unref();
  timer = setInterval(tick, INTERVAL_MS);
  timer.unref();
}

module.exports = { runOnce, test, start, payload, INTERVAL_MS };
