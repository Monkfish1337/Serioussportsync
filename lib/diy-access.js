'use strict';
function playbackConfig(user) {
  const config = user && user.config || {};
  if (user && user.role === 'admin') return config;
  return {...config, diyUsenetEnabled:false, nativeNntpEnabled:false, diyNativeSearchEnabled:false};
}
module.exports = {playbackConfig};
