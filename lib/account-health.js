'use strict';

// Per-account pipeline health (issue #76). Diagnosis sees the server as a
// whole; an account's own TorBox key, Easynews login or TorBox Usenet access
// can be refused without anyone knowing. Every stream request's log already
// says so ("torbox: checkcached HTTP 401", "easynews: auth failed"), so an
// observer on that log records the latest outcome per account and pipeline:
// ok, auth (the key or login was refused) or error (anything else).
//
// Kept in data/account-health.json, written at most every few seconds. A
// failure only shows while it is newer than the last success.

const fs = require('fs');
const path = require('path');
const config = require('../config');

const FLUSH_MS = 5000;
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const PIPELINES = {
  torbox: 'TorBox',
  easynews: 'Easynews',
  'torbox-usenet': 'TorBox Usenet',
};

let state = null;
let timer = null;
let fileOverride = null;

function file() {
  return fileOverride || path.join(path.dirname(config.availabilityDbFile || './data/availability.sqlite'), 'account-health.json');
}
function load() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(file(), 'utf8')) || {}; } catch (_) { state = {}; }
  return state;
}
function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!state) return;
  try { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(state), { mode: 0o600 }); }
  catch (error) { console.error('[account-health] could not save: ' + error.message); }
}
function schedule() {
  if (timer) return;
  timer = setTimeout(flush, FLUSH_MS);
  if (timer.unref) timer.unref();
}

function record(username, pipeline, outcome, detail, at) {
  if (!username || !PIPELINES[pipeline]) return;
  try {
    const s = load();
    const user = s[username] || (s[username] = {});
    const entry = user[pipeline] || (user[pipeline] = {});
    const now = at || Date.now();
    if (outcome === 'ok') { entry.okAt = now; }
    else { entry.failAt = now; entry.kind = outcome === 'auth' ? 'auth' : 'error'; entry.detail = String(detail || '').slice(0, 120); }
    schedule();
  } catch (_) { /* health must never break a request */ }
}

// A saved key or login replaces what was known about it.
function reset(username, pipeline) {
  const s = load();
  if (s[username] && s[username][pipeline]) { delete s[username][pipeline]; schedule(); }
}

// Watches one stream request's log. Success lines only count when that
// request saw no failure from the same pipeline: a refused TorBox check still
// prints "0 cached / N uncached" afterwards.
const RULES = [
  { pipeline: 'torbox', fail: /torbox: checkcached HTTP (\d+)/, network: /torbox: checkcached network error/, ok: /^torbox: \d+ cached \/ \d+ uncached/ },
  { pipeline: 'easynews', auth: /easynews: auth failed \(HTTP (\d+)\)/, fail: /easynews: HTTP (\d+)/, ok: /easynews: (search completed|\d+ unique result)/ },
  { pipeline: 'torbox-usenet', fail: /torbox-usenet: (?:batch checkcached|mylist|owned mylist|requestdl|create) HTTP (\d+)/, ok: /^torbox-usenet: checked \d+ of \d+ NZB/ },
];
function observer(username) {
  if (!username) return () => {};
  const failed = new Set();
  return (message) => {
    const line = String(message || '').trim();
    for (const rule of RULES) {
      let m;
      if (rule.auth && (m = rule.auth.exec(line))) {
        failed.add(rule.pipeline); record(username, rule.pipeline, 'auth', 'HTTP ' + m[1]);
      } else if (rule.fail && (m = rule.fail.exec(line))) {
        failed.add(rule.pipeline);
        const status = Number(m[1]);
        record(username, rule.pipeline, status === 401 || status === 403 ? 'auth' : 'error', 'HTTP ' + status);
      } else if (rule.network && rule.network.test(line)) {
        failed.add(rule.pipeline); record(username, rule.pipeline, 'error', 'network error');
      } else if (rule.ok && rule.ok.test(line) && !failed.has(rule.pipeline)) {
        record(username, rule.pipeline, 'ok');
      }
    }
  };
}

// Current problems for one account: pipelines whose last failure is newer
// than their last success and less than a week old.
function problems(username, now) {
  const user = load()[username] || {};
  const at = now || Date.now();
  return Object.entries(user)
    .filter(([pipeline, e]) => PIPELINES[pipeline] && e.failAt && e.failAt > (e.okAt || 0) && at - e.failAt < STALE_MS)
    .map(([pipeline, e]) => ({ pipeline, name: PIPELINES[pipeline], kind: e.kind, detail: e.detail, at: e.failAt, okAt: e.okAt || null }));
}

function all(now) {
  return Object.keys(load()).map((username) => ({ username, problems: problems(username, now) })).filter((u) => u.problems.length);
}

// What to tell the owner, in one line.
function message(problem) {
  if (problem.kind === 'auth') {
    return problem.pipeline === 'easynews' ? 'Easynews refused your username or password'
      : problem.name + ' refused your API key' + (problem.pipeline === 'torbox-usenet' ? ' for Usenet' : '');
  }
  return problem.name + ' failed (' + (problem.detail || 'error') + ')';
}

// Tests only.
function _reset(filePath) {
  if (timer) clearTimeout(timer);
  timer = null;
  state = null;
  fileOverride = filePath || null;
}

module.exports = { record, reset, observer, problems, all, message, flush, PIPELINES, _reset };
