'use strict';

const usenetIndexer = require('./sources/usenet-indexer');
const nzbdavPlayback = require('./sources/nzbdav-playback');
const nntpPlayback = require('./sources/nntp-playback');

// One definition of "ready" for the account page, manifest, and tests. The
// pipeline needs at least one discovery source and one usable playback backend.
function status(userConfig) {
  const cfg = userConfig || {};
  const enabled = cfg.diyUsenetEnabled === true;
  // Inspect backend readiness independently from the master switch so the UI
  // can say "configured, pipeline off" instead of pretending settings vanished.
  const inspectCfg = Object.assign({}, cfg, { diyUsenetEnabled: true });
  const nativeSearch = usenetIndexer.isConfigured(usenetIndexer.providerConfig(inspectCfg));
  const uuSearch = cfg.diyUuSearchEnabled !== false && Boolean(cfg.uuManifestUrl);
  const nzbdav = nzbdavPlayback.isConfigured(nzbdavPlayback.providerConfig(inspectCfg));
  const nntp = nntpPlayback.isConfigured(nntpPlayback.providerConfig(inspectCfg));
  const discovery = nativeSearch || uuSearch;
  const playback = nzbdav || nntp;
  return Object.freeze({
    nativeSearch,
    uuSearch,
    discovery,
    nzbdav,
    nntp,
    playback,
    enabled,
    ready: enabled && discovery && playback,
  });
}

module.exports = { status };
