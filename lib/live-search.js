'use strict';
// Share only active searches. A later refresh must still be allowed to discover new releases.
const active = new Map();
function sharedSearch(key, producer) {
  if (active.has(key)) return active.get(key);
  const pending = Promise.resolve().then(producer);
  active.set(key, pending);
  pending.finally(() => { if (active.get(key) === pending) active.delete(key); }).catch(() => {});
  return pending;
}
module.exports = {sharedSearch};
