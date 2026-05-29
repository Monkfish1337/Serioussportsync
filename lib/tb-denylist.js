// TorBox failure denylist (0.23.1). Wrapper around lib/provider-denylist.js,
// same dual-TTL semantics as the RD denylist. Persists to data/tb-denylist.json
// so a TB "not cached" outcome stops cluttering future stream rows for that
// hash, without affecting RD or PM advertising for the same hash.

const config = require('../config');
const { createDenylist } = require('./provider-denylist');

const tb = createDenylist({
  file:       (config.tbDenylist && config.tbDenylist.file)         || './data/tb-denylist.json',
  hardTtlMs:  Math.max(0, (config.tbDenylist && config.tbDenylist.ttlDays)      || 30) * 24 * 60 * 60 * 1000,
  softTtlMs:  Math.max(0, (config.tbDenylist && config.tbDenylist.softTtlHours) || 24) * 60 * 60 * 1000,
  logTag:     'tb-denylist',
});

module.exports = tb;
