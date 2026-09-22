'use strict';

const usenetIndexer = require('./sources/usenet-indexer');
const nzbdavPlayback = require('./sources/nzbdav-playback');
const nntpPlayback = require('./sources/nntp-playback');

// One definition of "ready" for the account page, manifest, and tests. The
// pipeline needs at least one discovery source and one usable playback backend.
function status(userConfig) {
  const cfg = userConfig || {};
  const nativeSearch = usenetIndexer.isConfigured(usenetIndexer.providerConfig(cfg));
  const uuSearch = cfg.diyUuSearchEnabled !== false && Boolean(cfg.uuManifestUrl);
  const nzbdav = nzbdavPlayback.isConfigured(nzbdavPlayback.providerConfig(cfg));
  const nntp = nntpPlayback.isConfigured(nntpPlayback.providerConfig(cfg));
  const discovery = nativeSearch || uuSearch;
  const playback = nzbdav || nntp;
  return Object.freeze({
    nativeSearch,
    uuSearch,
    discovery,
    nzbdav,
    nntp,
    playback,
    ready: discovery && playback,
  });
}

module.exports = { status };
