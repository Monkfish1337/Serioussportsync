// In-memory log ring buffer (0.27.0).
//
// Server-side captures every console.log / .warn / .error line into a bounded
// ring buffer so the admin /logs page can render recent activity without
// needing SSH + `docker compose logs`. Entries are structured with timestamp,
// level, raw text, derived category, and derived user — all parsed from the
// existing log prefix conventions ([stream u=foo], [resolve u=bar], [refresh],
// etc.) so we don't need to instrument every log call.
//
// Memory: ~5000 lines × ~200 bytes = ~1 MB. Set LOG_BUFFER_LINES env to tune.
//
// Defence: every line is run through lib/redact.js before storage, so even
// if some path forgets to redact at log time, the buffer doesn't keep secrets.

const { redact } = require('./redact');

const MAX_LINES = Math.max(100, parseInt(process.env.LOG_BUFFER_LINES || '5000', 10));
const buf = [];
let seq = 0;

// Categorise a log line by its leading bracket prefix. Order matters — the
// more-specific patterns are checked before the more-general ones.
function classify(line) {
  // [stream u=name]   /   [resolve u=name]
  let m = line.match(/^\[(stream|resolve)\s+u=([^\]]+)\]/);
  if (m) return { category: m[1], user: m[2].trim() };

  // [stream] without user (system-level, e.g. the route handler error catch)
  m = line.match(/^\[(stream|resolve)\]/);
  if (m) return { category: m[1], user: null };

  // Named subsystems
  m = line.match(/^\[(stream-refresh|refresh|admin|serioussportsync|rd-denylist|tb-denylist|pm-denylist|positive-cache|crypto-keys|streamcache|users|dead-indexer|onefc)\]/);
  if (m) {
    const tag = m[1];
    // Aggregate denylists under a single "denylist" category for UX.
    if (/-denylist$/.test(tag)) return { category: 'denylist', user: null };
    return { category: tag === 'serioussportsync' ? 'server' : tag, user: null };
  }

  // Anything else — uncategorised
  return { category: 'other', user: null };
}

function push(level, rawLine) {
  const safe = redact(String(rawLine));
  const { category, user } = classify(safe);
  buf.push({
    id: ++seq,
    ts: Date.now(),
    level,
    line: safe,
    category,
    user,
  });
  if (buf.length > MAX_LINES) buf.shift();
}

// Filter the buffer in place — used by /admin/logs render. Empty filter
// values match everything. `since` is a unix ms (inclusive). All filters
// AND'd together.
function filtered(opts) {
  const o = opts || {};
  const cat = o.category && o.category !== 'all' ? o.category : null;
  const usr = o.user ? String(o.user).toLowerCase() : null;
  const sub = o.substring ? String(o.substring).toLowerCase() : null;
  const lvl = o.level && o.level !== 'all' ? o.level : null;
  const sinceMs = o.since ? Number(o.since) : 0;
  const limit = o.limit ? Math.max(1, Math.min(MAX_LINES, Number(o.limit))) : 1000;

  const out = [];
  for (let i = buf.length - 1; i >= 0 && out.length < limit; i--) {
    const e = buf[i];
    if (cat && e.category !== cat) continue;
    if (usr && (!e.user || !e.user.toLowerCase().includes(usr))) continue;
    if (sub && !e.line.toLowerCase().includes(sub)) continue;
    if (lvl && e.level !== lvl) continue;
    if (sinceMs && e.ts < sinceMs) continue;
    out.push(e);
  }
  return out.reverse(); // chronological order
}

function counts() {
  const byCat = {};
  const byLevel = { log: 0, warn: 0, error: 0 };
  for (const e of buf) {
    byCat[e.category] = (byCat[e.category] || 0) + 1;
    if (byLevel[e.level] === undefined) byLevel[e.level] = 0;
    byLevel[e.level]++;
  }
  return { total: buf.length, max: MAX_LINES, byCategory: byCat, byLevel };
}

// Wrap a target object's console-like methods so each call ALSO records the
// formatted line into the buffer. Idempotent: calling twice doesn't re-wrap.
function wrapConsole(target) {
  if (!target || target.__sssWrapped) return;
  target.__sssWrapped = true;
  ['log', 'info', 'warn', 'error'].forEach((method) => {
    const orig = target[method] ? target[method].bind(target) : (() => {});
    const level = (method === 'log' || method === 'info') ? 'log'
                : (method === 'warn') ? 'warn' : 'error';
    target[method] = (...args) => {
      try {
        const line = args.map((a) =>
          typeof a === 'string' ? a
          : (a instanceof Error ? (a.stack || a.message)
          : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())
        ).join(' ');
        push(level, line);
      } catch { /* never let logging itself throw */ }
      orig(...args);
    };
  });
}

module.exports = { push, filtered, counts, wrapConsole, MAX_LINES };
