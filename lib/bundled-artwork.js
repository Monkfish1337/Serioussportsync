'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const versions = new Map();

// Keep saved image selections stable while changing the served URL whenever
// bundled collection artwork changes. Browsers and media clients cache URLs.
function versionedArtwork(value) {
  const image = String(value || '');
  if (!/^\/assets\/collection-[a-z0-9-]+\.png$/.test(image)) return image;
  if (!versions.has(image)) {
    try {
      const bytes = fs.readFileSync(path.join(__dirname, '..', 'public', path.basename(image)));
      versions.set(image, crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12));
    } catch (_) { return image; }
  }
  return image + '?v=' + versions.get(image);
}

module.exports = { versionedArtwork };
