// Real-Debrid failure denylist (0.22.1 introduced; 0.23.1 refactored).
//
// Thin wrapper around lib/provider-denylist.js — the same factory now backs
// per-provider denylists for RD, TB, and PM. Keeps the original API + on-disk
// file path (data/rd-denylist.json) so existing denylist entries are read
// without any migration.
//
// See lib/provider-denylist.js for the dual-TTL semantics (hard 30d for '451'
// content blocks, soft 24h for 'unresolvable' not-cached responses) and the
// soft→hard promotion rules.

const config = require('../config');
const { createDenylist } = require('./provider-denylist');

const rd = createDenylist({
  file:       (config.rdDenylist && config.rdDenylist.file)         || './data/rd-denylist.json',
  hardTtlMs:  Math.max(0, (config.rdDenylist && config.rdDenylist.ttlDays)      || 30) * 24 * 60 * 60 * 1000,
  softTtlMs:  Math.max(0, (config.rdDenylist && config.rdDenylist.softTtlHours) || 24) * 60 * 60 * 1000,
  logTag:     'rd-denylist',
});

module.exports = rd;
