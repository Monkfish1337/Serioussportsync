'use strict';

// Artwork for the seven `discovered-*` catalogs.
//
// Two separate mistakes have made these tiles render empty. First they all fell
// back to the SSS banner, so the home screen showed seven identical rows.
// Then, given their own images, they were given them as '/assets/discovered-
// rugby.png' — a root-relative path.
//
// That second one is the interesting failure: a Stremio meta is fetched BY THE
// CLIENT, not by a browser sitting on an SSS page, so a root-relative URL
// resolves against the client's own origin and 404s. It looks completely
// correct in the code and in an admin page, and renders nothing on the device.
// Every other piece of bundled art goes through brandedPoster, which prefixes
// PUBLIC_URL, which is why none of them ever had this problem.
//
// PUBLIC_URL is read when lib/promotions is first required, so it is set here
// before the require rather than inside a test.

process.env.PUBLIC_URL = 'https://sss.test.invalid';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const promotions = require('../lib/promotions');
const releaseIngest = require('../lib/sources/release-ingest');

test('every discovered catalog has its own bundled artwork, as an absolute URL', () => {
  const seen = new Set();
  for (const sport of Object.keys(releaseIngest.SPORTS)) {
    const promotion = promotions.byPrefix[releaseIngest.promotionIdFor(sport)];
    assert.ok(promotion, 'no promotion for ' + sport);

    const poster = (promotion.defaults || {}).poster;
    assert.match(String(poster), /^https:\/\/sss\.test\.invalid\/assets\/discovered-[a-z]+\.png$/,
      sport + ' must carry an absolute poster URL, not a path the client cannot resolve');
    assert.equal(promotion.defaults.fanart, poster);

    assert.equal(seen.has(poster), false, 'two sports share artwork: ' + poster);
    seen.add(poster);

    // The image is bundled rather than fetched, so it has to actually ship —
    // brandedPoster returns the fallback when the file is missing, and an
    // empty poster would take us straight back to blank tiles.
    const file = path.join(__dirname, '..', 'public',
      poster.slice(poster.lastIndexOf('/') + 1));
    assert.equal(fs.existsSync(file), true, 'missing bundled image: ' + file);
  }
  assert.equal(seen.size, Object.keys(releaseIngest.SPORTS).length);
});
