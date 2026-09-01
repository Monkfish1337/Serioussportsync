// Structured in-memory operations log.
//
// Existing console calls continue to work, while object arguments are retained
// as expandable diagnostic fields. The buffer is bounded by both entries and
// bytes, redacts before storage, and emits new records for the admin SSE tail.

const { EventEmitter } = require('events');
const { redact } = require('./redact');

const MAX_LINES = Math.max(100, parseInt(process.env.LOG_BUFFER_LINES || '5000', 10));
const MAX_BYTES = Math.max(256 * 1024, parseInt(process.env.LOG_BUFFER_MAX_BYTES || String(5 * 1024 * 1024), 10));
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const buf = [];
const bus = new EventEmitter();
bus.setMaxListeners(0);
let seq = 0;
let bytes = 0;

function normalizeLevel(level) {
  const value = String(level || '').toLowerCase();
  if (value === 'log') return 'info';
  return LEVELS.includes(value) ? value : 'info';
}

function classify(line, fields) {
  if (fields && fields.module) {
    return { category: String(fields.module), user: fields.user ? String(fields.user) : null };
  }
  let match = line.match(/^\[(stream|resolve)\s+u=([^\s\]]+)(?:\s+rid=([^\]]+))?\]/);
  if (match) return { category: match[1], user: match[2].trim(), requestId: match[3] || null };
  match = line.match(/^\[(stream|resolve)\s+([^\]]+)\]/);
  if (match) return { category: match[1], user: match[2].trim(), requestId: null };
  match = line.match(/^\[(stream|resolve)\]/);
  if (match) return { category: match[1], user: null, requestId: null };
  match = line.match(/^\[([^\]\s]+)[^\]]*\]/);
  if (match) {
    const tag = match[1];
    if (/-denylist$/.test(tag)) return { category: 'denylist', user: null, requestId: null };
    return { category: tag === 'serioussportsync' ? 'server' : tag, user: null, requestId: null };
  }
  return { category: 'other', user: null, requestId: null };
}

function safeFields(input) {
  if (!input || typeof input !== 'object') return {};
  try {
    const json = JSON.stringify(input, (key, value) => {
      if (/^(?:api[_-]?key|api[_-]?token|access[_-]?token|auth(?:orization)?|cookie|pass(?:key|word)?|secret|session(?:secret)?|token)$/i.test(key)) {
        return value ? '***' : value;
      }
      if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
      if (typeof value === 'bigint') return String(value);
      return value;
    });
    return JSON.parse(redact(json));
  } catch (_) {
    return { detail: redact(String(input)) };
  }
}

function push(level, rawLine, rawFields) {
  const safe = redact(String(rawLine || ''));
  const fields = safeFields(rawFields);
  const classified = classify(safe, fields);
  const entry = {
    id: ++seq,
    ts: Date.now(),
    level: normalizeLevel(level),
    line: safe,
    category: classified.category,
    user: fields.user ? String(fields.user) : classified.user,
    requestId: fields.requestId ? String(fields.requestId) : classified.requestId,
    fields,
  };
  const size = Buffer.byteLength(safe, 'utf8') + Buffer.byteLength(JSON.stringify(fields), 'utf8') + 96;
  Object.defineProperty(entry, '_bytes', { value: size, enumerable: false });
  buf.push(entry);
  bytes += size;
  while (buf.length > MAX_LINES || (bytes > MAX_BYTES && buf.length > 1)) {
    const removed = buf.shift();
    bytes -= removed && removed._bytes || 0;
  }
  bus.emit('line', entry);
  return entry;
}

function filterLevels(value) {
  if (!value || value === 'all') return null;
  const list = Array.isArray(value) ? value : String(value).split(',');
  const accepted = new Set(list.map(normalizeLevel));
  return accepted.size ? accepted : null;
}

function matches(entry, opts) {
  const o = opts || {};
  const category = o.category && o.category !== 'all' ? String(o.category) : null;
  const user = o.user ? String(o.user).toLowerCase() : null;
  const substring = o.substring ? String(o.substring) : null;
  const levels = filterLevels(o.level || o.levels);
  if (category && entry.category !== category) return false;
  if (user && (!entry.user || !entry.user.toLowerCase().includes(user))) return false;
  if (levels && !levels.has(entry.level)) return false;
  if (o.sinceId && entry.id <= Number(o.sinceId)) return false;
  if (o.since && entry.ts < Number(o.since)) return false;
  if (substring) {
    const haystack = entry.line + '\n' + JSON.stringify(entry.fields || {});
    if (o.regex) {
      try { if (!new RegExp(substring, 'i').test(haystack)) return false; }
      catch (_) { return false; }
    } else if (!haystack.toLowerCase().includes(substring.toLowerCase())) return false;
  }
  return true;
}

function filtered(opts) {
  const o = opts || {};
  const limit = o.limit ? Math.max(1, Math.min(MAX_LINES, Number(o.limit))) : 1000;
  const out = [];
  for (let i = buf.length - 1; i >= 0 && out.length < limit; i--) {
    if (matches(buf[i], o)) out.push(buf[i]);
  }
  return out.reverse();
}

function counts() {
  const byCategory = {};
  const byLevel = Object.fromEntries(LEVELS.map((level) => [level, 0]));
  for (const entry of buf) {
    byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
    byLevel[entry.level] = (byLevel[entry.level] || 0) + 1;
  }
  return { total: buf.length, max: MAX_LINES, bytes, maxBytes: MAX_BYTES, lastId: seq, byCategory, byLevel };
}

function clear() {
  buf.length = 0;
  bytes = 0;
}

function wrapConsole(target) {
  if (!target || target.__sssWrapped) return;
  target.__sssWrapped = true;
  ['trace', 'debug', 'log', 'info', 'warn', 'error'].forEach((method) => {
    const original = target[method] ? target[method].bind(target) : (() => {});
    const level = method === 'log' ? 'info' : method;
    target[method] = (...args) => {
      try {
        const fieldArgs = args.filter((arg) => arg && typeof arg === 'object' && !(arg instanceof Error));
        const fields = Object.assign({}, ...fieldArgs);
        const parts = args.filter((arg) => !fieldArgs.includes(arg)).map((arg) =>
          arg instanceof Error ? (arg.stack || arg.message) : String(arg));
        push(level, parts.join(' '), fields);
      } catch (_) { /* logging must never break application work */ }
      original(...args);
    };
  });
}

module.exports = {
  LEVELS, MAX_LINES, MAX_BYTES, bus, clear, counts, filtered, matches,
  normalizeLevel, push, wrapConsole,
};
