'use strict';

// What an account may use of built-in Usenet.
//
// Administrators keep everything: their own indexer, native NNTP playback
// through this server, and TorBox Usenet playback. Other accounts may search
// their own indexer and play through TorBox, which downloads and serves the
// file itself, so the server only fetches small NZB files. They cannot use
// native NNTP (it streams every byte through the server) and their indexer
// and NZB links must be public internet addresses.
function usenetPlayback(user) {
  const config = user && user.config || {};
  const admin = user && user.role === 'admin';
  const chosen = ['nntp', 'torbox', 'both'].includes(config.usenetPlayback) ? config.usenetPlayback : (admin ? 'nntp' : 'torbox');
  return admin ? chosen : 'torbox';
}

function playbackConfig(user) {
  const config = user && user.config || {};
  if (user && user.role === 'admin') return { ...config, usenetPlayback: usenetPlayback(user) };
  return { ...config, usenetPlayback: 'torbox', _publicNetworkOnly: true,
    nativeNntpEnabled: false, nntpHost: '', nntpUsername: '', nntpPassword: '' };
}

module.exports = { playbackConfig, usenetPlayback };
