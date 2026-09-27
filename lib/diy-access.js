'use strict';
function playbackConfig(user) {
  const config = user && user.config || {};
  if (user && user.role === 'admin') return config;
  // _publicNetworkOnly: the TorBox Usenet indexer (and the NZB links it
  // returns) of an account without admin rights may only be a public address.
  return {...config, diyUsenetEnabled:false, nativeNntpEnabled:false, diyNativeSearchEnabled:false, _publicNetworkOnly:true};
}
module.exports = {playbackConfig};
