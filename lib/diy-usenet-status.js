'use strict';

const usenetIndexer = require('./sources/usenet-indexer');
const nntpPlayback = require('./sources/nntp-playback');

// One definition of "ready" for the account page, manifest, and tests. Built-in
// Usenet needs a configured native indexer (Newznab/NZBHydra/Prowlarr) for
// discovery, plus a way to play what it finds: the native NNTP provider
// (through this server) and/or TorBox, which downloads and serves the file
// itself. `usenetPlayback` says which; lib/diy-access sets it per account.
function status(userConfig) {
  const cfg = userConfig || {};
  const enabled = cfg.diyUsenetEnabled === true;
  const mode = ['nntp', 'torbox', 'both'].includes(cfg.usenetPlayback) ? cfg.usenetPlayback : 'nntp';
  // Inspect backend readiness independently from the master switch so the UI
  // can say "configured, pipeline off" instead of pretending settings vanished.
  const inspectCfg = Object.assign({}, cfg, { diyUsenetEnabled: true });
  const discovery = usenetIndexer.isConfigured(usenetIndexer.providerConfig(inspectCfg));
  const playback = nntpPlayback.isConfigured(nntpPlayback.providerConfig(inspectCfg));
  const torbox = cfg.torboxEnabled !== false && Boolean(String(cfg.torboxApiKey || '').trim());
  const playable = (mode !== 'torbox' && playback) || (mode !== 'nntp' && torbox);
  return Object.freeze({
    discovery,
    playback,
    torbox,
    mode,
    enabled,
    ready: enabled && discovery && playable,
  });
}

module.exports = { status };
