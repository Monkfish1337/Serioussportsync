const config = require('../config');
const store = require('./store');
const transform = require('./transform');

function handleMeta({ type, id }) {
  if (type !== config.addonType) return { meta: null };
  const ev = store.getEvent(id);
  if (!ev) return { meta: null };
  return { meta: transform.toDetailMeta(ev) };
}

module.exports = { handleMeta };
