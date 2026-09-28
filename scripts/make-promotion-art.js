#!/usr/bin/env node
'use strict';

// Generate the bundled fallback artwork for every built-in promotion and the
// seven Discovered catalogs.
//
// An event with no image of its own is shown with its promotion's default.
// Those defaults were TheSportsDB league banners and badges from 2014-2020
// (MotoGP's 2015 banner with the old logo, UFC's 2016 roster, AEW's 2019
// banner, the old WWE badge) and plain logo cards, and 128 MotoGP events
// alone showed that 2015 banner (issue #69). These cards replace them: a
// kicker and a name on the same frame for every promotion, no league logos,
// so every fallback reads as one set.
//
// Run from the repo root:
//   npm i --no-save @resvg/resvg-js
//   node scripts/make-promotion-art.js [folder with Poppins-*.ttf]
// Writes public/promo-<id>.png (1000x563 landscape) for every promotion, plus
// promo-<id>-poster.png (600x900) or promo-<id>-square.png (600x600) where the
// promotion's tiles are that shape, and public/discovered-<sport>.png.

const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const OUT = path.join(__dirname, '..', 'public');
const FONT_DIR = process.argv[2] || path.join(__dirname, 'fonts');

// file prefix + id, kicker, title, accent, deep accent, extra tile shape
const CARDS = [
  ['promo-f1', 'MOTORSPORT', 'Formula 1', '#e8352b', '#5c0f0b'],
  ['promo-motogp', 'MOTORSPORT', 'MotoGP', '#ff6a1a', '#6b2508'],
  ['promo-ufc', 'MIXED MARTIAL ARTS', 'UFC', '#d93a3a', '#5a1010'],
  ['promo-one', 'MARTIAL ARTS', 'ONE Championship', '#f2b705', '#5c4502'],
  ['promo-boxing', 'COMBAT SPORTS', 'Boxing', '#d4a93a', '#57410c', 'poster'],
  ['promo-wwe', 'WRESTLING', 'WWE', '#e03a45', '#5b0f15'],
  ['promo-wwe-raw', 'WWE', 'Raw', '#e03a45', '#5b0f15'],
  ['promo-wwe-smackdown', 'WWE', 'SmackDown', '#3b82f6', '#102c5c'],
  ['promo-wwe-nxt', 'WWE', 'NXT', '#e3c14b', '#4d3f0c'],
  ['promo-aew', 'WRESTLING', 'AEW', '#c9a24a', '#4a3a12'],
  ['promo-aew-dynamite', 'AEW', 'Dynamite', '#c9a24a', '#4a3a12'],
  ['promo-aew-collision', 'AEW', 'Collision', '#8b9bb4', '#263247'],
  ['promo-mlb', 'BASEBALL', 'MLB', '#2f80ed', '#10375c', 'square'],
  ['promo-nfl', 'AMERICAN FOOTBALL', 'NFL', '#e2703a', '#6b2410', 'square'],
  ['promo-nba', 'BASKETBALL', 'NBA', '#f0932b', '#7a3d05', 'square'],
  ['promo-nhl', 'ICE HOCKEY', 'NHL', '#56ccf2', '#0d3b52', 'square'],
  ['promo-ucl', 'FOOTBALL', 'Champions League', '#5b7cfa', '#101f5c', 'square'],
  ['promo-epl', 'FOOTBALL', 'Premier League', '#a855f7', '#3b0f5c', 'square'],
  ['promo-motd', 'FOOTBALL', 'Match of the Day', '#2fbf71', '#0f5132'],
  ['discovered-football', 'DISCOVERED', 'Football', '#2fbf71', '#0f5132'],
  ['discovered-americanfootball', 'DISCOVERED', 'American Football', '#e2703a', '#6b2410'],
  ['discovered-basketball', 'DISCOVERED', 'Basketball', '#f0932b', '#7a3d05'],
  ['discovered-baseball', 'DISCOVERED', 'Baseball', '#2f80ed', '#10375c'],
  ['discovered-hockey', 'DISCOVERED', 'Hockey', '#56ccf2', '#0d3b52'],
  ['discovered-rugby', 'DISCOVERED', 'Rugby', '#9b5de5', '#3d1c66'],
  ['discovered-other', 'DISCOVERED', 'Other Sports', '#8d99ae', '#2b2d42'],
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

// Title size shrinks for long names so it never runs off the card.
function titleSize(title, room, max) {
  return Math.min(max, Math.floor(room / (title.length * 0.6)));
}

function card([, kicker, title, accent, deep], w, h) {
  const size = titleSize(title, w - 120, w > h ? 104 : 88);
  const kickerSize = Math.round(w > h ? 30 : 26);
  const block = kickerSize + 18 + size;
  const top = Math.round((h - block) / 2) + kickerSize;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#11151c"/>
      <stop offset="55%" stop-color="#1b2230"/>
      <stop offset="100%" stop-color="${deep}"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <rect x="0" y="0" width="${w}" height="8" fill="${accent}"/>
  <circle cx="${w - 120}" cy="80" r="${Math.round(Math.max(w, h) * 0.24)}" fill="${accent}" opacity="0.10"/>
  <text x="${w / 2}" y="${top}" text-anchor="middle" font-family="Poppins" font-size="${kickerSize}" font-weight="600" fill="${accent}" letter-spacing="6">${esc(kicker)}</text>
  <text x="${w / 2}" y="${top + 18 + size * 0.9}" text-anchor="middle" font-family="Poppins" font-size="${size}" font-weight="700" fill="#ffffff">${esc(title)}</text>
</svg>`;
}

function render(svg, file) {
  const fontFiles = fs.readdirSync(FONT_DIR).filter((f) => /^Poppins-.*\.ttf$/i.test(f)).map((f) => path.join(FONT_DIR, f));
  if (!fontFiles.length) throw new Error('No Poppins-*.ttf in ' + FONT_DIR + ' (Google Fonts, OFL)');
  const png = new Resvg(svg, { font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Poppins' } }).render().asPng();
  fs.writeFileSync(path.join(OUT, file), png);
  console.log('wrote public/' + file);
}

if (require.main === module) {
  for (const c of CARDS) {
    render(card(c, 1000, 563), c[0] + '.png');
    if (c[5] === 'poster') render(card(c, 600, 900), c[0] + '-poster.png');
    if (c[5] === 'square') render(card(c, 600, 600), c[0] + '-square.png');
  }
}

module.exports = { CARDS };
