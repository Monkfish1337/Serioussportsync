'use strict';

const usenetIndexer = require('./sources/usenet-indexer');
const nntpPlayback = require('./sources/nntp-playback');

// One definition of "ready" for the account page, manifest, and tests. Built-in
// Usenet needs a configured native indexer (Newznab/NZBHydra/Prowlarr) for
// discovery and a configured native NNTP provider for playback.
function status(userConfig) {
  const cfg = userConfig || {};
  const enabled = cfg.diyUsenetEnabled === true;
  // Inspect backend readiness independently from the master switch so the UI
  // can say "configured, pipeline off" instead of pretending settings vanished.
  const inspectCfg = Object.assign({}, cfg, { diyUsenetEnabled: true });
  const discovery = usenetIndexer.isConfigured(usenetIndexer.providerConfig(inspectCfg));
  const playback = nntpPlayback.isConfigured(nntpPlayback.providerConfig(inspectCfg));
  return Object.freeze({
    discovery,
    playback,
    enabled,
    ready: enabled && discovery && playback,
  });
}

module.exports = { status };
