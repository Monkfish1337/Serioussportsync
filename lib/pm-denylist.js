// Premiumize failure denylist (0.23.1). Wrapper around lib/provider-denylist.js,
// same dual-TTL semantics as the RD denylist. Persists to data/pm-denylist.json
// so a PM "not cached" outcome stops cluttering future stream rows for that
// hash, without affecting RD or TB advertising for the same hash.

const config = require('../config');
const { createDenylist } = require('./provider-denylist');

const pm = createDenylist({
  file:       (config.pmDenylist && config.pmDenylist.file)         || './data/pm-denylist.json',
  hardTtlMs:  Math.max(0, (config.pmDenylist && config.pmDenylist.ttlDays)      || 30) * 24 * 60 * 60 * 1000,
  softTtlMs:  Math.max(0, (config.pmDenylist && config.pmDenylist.softTtlHours) || 24) * 60 * 60 * 1000,
  logTag:     'pm-denylist',
});

module.exports = pm;
