#!/usr/bin/env node
'use strict';

// Generate the bundled fallback artwork for the built-in promotions.
//
// An event with no image of its own is shown with its promotion's default.
// Those defaults were TheSportsDB league banners and badges from 2014-2020
// (MotoGP's 2015 banner with the old logo, UFC's 2016 roster, AEW's 2019
// banner, the old WWE badge) and three plain logo cards, and 128 MotoGP
// events alone showed that 2015 banner. These cards replace them: drawn from
// scratch, no league logos, the same frame as the Discovered tiles
// (scripts/make-discovered-art.py) so every fallback reads as one set.
//
// Run from the repo root:
//   npm i --no-save @resvg/resvg-js
//   node scripts/make-promotion-art.js [path/to/Poppins-*.ttf folder]
// Writes public/promo-<id>.png: 1000x563 landscape for every promotion, plus
// public/promo-<id>-poster.png (600x900) or -square.png (600x600) for the
// promotions whose tiles are that shape.

const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const OUT = path.join(__dirname, '..', 'public');
const FONT_DIR = process.argv[2] || path.join(__dirname, 'fonts');

// Glyphs are drawn in a 200x200 box at 0,0; {deep} is the promotion's deep accent.
const FLAG = `
  <path d="M34 14 V192" stroke="#ffffff" stroke-width="11" stroke-linecap="round"/>
  <g transform="translate(40 18)">
    <path d="M0 0 C40 -10 80 14 150 2 V100 C80 112 40 88 0 98 Z" fill="#ffffff"/>
    <clipPath id="flagclip"><path d="M0 0 C40 -10 80 14 150 2 V100 C80 112 40 88 0 98 Z"/></clipPath>
    <g clip-path="url(#flagclip)" fill="{deep}">
      ${[0, 1, 2, 3, 4].map((c) => [0, 1, 2, 3].filter((r) => (c + r) % 2 === 0)
        .map((r) => `<rect x="${c * 30}" y="${r * 26 - 10}" width="30" height="${r === 3 ? 34 : 26}"/>`).join('')).join('')}
    </g>
  </g>`;

const HELMET = `
  <clipPath id="helmetclip"><path d="M22 132 C20 66 70 24 126 26 C168 28 192 66 190 110 V136 C190 150 180 160 166 160 H52 C34 160 22 150 22 132 Z"/></clipPath>
  <path d="M22 132 C20 66 70 24 126 26 C168 28 192 66 190 110 V136 C190 150 180 160 166 160 H52 C34 160 22 150 22 132 Z" fill="#ffffff"/>
  <path clip-path="url(#helmetclip)" d="M112 66 H200 V108 H122 C113 108 106 101 106 92 V74 C106 69 108 66 112 66 Z" fill="{deep}"/>
  <path d="M36 132 H150" stroke="{deep}" stroke-width="8" stroke-linecap="round"/>
  <path d="M52 92 C60 64 84 46 110 42" stroke="{deep}" stroke-width="8" stroke-linecap="round" fill="none"/>`;

function octagon(r) {
  return Array.from({ length: 8 }, (_, k) => {
    const a = (Math.PI / 8) + k * Math.PI / 4;
    return (100 + r * Math.cos(a)).toFixed(1) + ',' + (100 + r * Math.sin(a)).toFixed(1);
  }).join(' ');
}
const OCTAGON = `
  <polygon points="${octagon(96)}" fill="#ffffff"/>
  <polygon points="${octagon(78)}" fill="{deep}"/>
  <polygon points="${octagon(62)}" fill="none" stroke="#ffffff" stroke-width="5" opacity="0.55"/>
  <path d="M100 38 V162 M38 100 H162" stroke="#ffffff" stroke-width="4" opacity="0.35"/>`;

const GLOVE = `
  <path d="M64 58 C64 28 94 14 124 18 C164 23 184 54 180 96 C177 126 162 142 144 148 V178 H74 V148 C54 138 44 120 48 102 C38 98 32 86 34 74 C36 58 52 50 64 58 Z" fill="#ffffff"/>
  <path d="M74 152 H144" stroke="{deep}" stroke-width="9"/>
  <path d="M74 166 H144" stroke="{deep}" stroke-width="5" opacity="0.6"/>
  <path d="M62 62 C68 84 80 96 102 98" stroke="{deep}" stroke-width="8" fill="none" stroke-linecap="round"/>`;

const STAR = (cx, cy, r) => {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5;
    const rr = i % 2 ? r * 0.45 : r;
    pts.push((cx + rr * Math.cos(a)).toFixed(1) + ',' + (cy + rr * Math.sin(a)).toFixed(1));
  }
  return `<polygon points="${pts.join(' ')}" fill="{deep}"/>`;
};
const BELT = `
  <rect x="2" y="78" width="196" height="44" rx="16" fill="#ffffff"/>
  <path d="M14 100 H186" stroke="{deep}" stroke-width="4" stroke-dasharray="6 8" opacity="0.6"/>
  <ellipse cx="100" cy="100" rx="62" ry="50" fill="{deep}" stroke="#ffffff" stroke-width="9"/>
  <ellipse cx="100" cy="100" rx="40" ry="30" fill="#ffffff"/>
  ${STAR(100, 101, 22)}
  <circle cx="22" cy="100" r="9" fill="{deep}"/>
  <circle cx="178" cy="100" r="9" fill="{deep}"/>`;

const BASEBALL = `
  <circle cx="100" cy="100" r="92" fill="#ffffff"/>
  <circle cx="100" cy="100" r="92" fill="none" stroke="{deep}" stroke-width="9"/>
  <path d="M40 26 C74 74 74 126 40 174" stroke="{deep}" stroke-width="8" fill="none"/>
  <path d="M160 26 C126 74 126 126 160 174" stroke="{deep}" stroke-width="8" fill="none"/>
  <path d="M52 52 L66 44 M50 74 L65 68 M49 100 L64 100 M50 126 L65 132 M52 148 L66 156"
        stroke="{deep}" stroke-width="7" stroke-linecap="round"/>
  <path d="M148 52 L134 44 M150 74 L135 68 M151 100 L136 100 M150 126 L135 132 M148 148 L134 156"
        stroke="{deep}" stroke-width="7" stroke-linecap="round"/>`;

// id, kicker, title, subtitle, accent, deep accent, glyph, extra shape
const PROMOTIONS = [
  ['f1', 'MOTORSPORT', 'Formula 1', 'Practice, qualifying and the race', '#e8352b', '#5c0f0b', FLAG],
  ['motogp', 'MOTORSPORT', 'MotoGP', 'Grand Prix motorcycle racing', '#ff6a1a', '#6b2508', HELMET],
  ['ufc', 'MIXED MARTIAL ARTS', 'UFC', 'Numbered events and Fight Nights', '#d93a3a', '#5a1010', OCTAGON],
  ['one', 'MARTIAL ARTS', 'ONE Championship', 'MMA, Muay Thai and kickboxing', '#f2b705', '#5c4502', OCTAGON],
  ['boxing', 'COMBAT SPORTS', 'Boxing', 'Title fights and fight nights', '#d4a93a', '#57410c', GLOVE, 'poster'],
  ['wwe', 'WRESTLING', 'WWE', 'Premium live events', '#e03a45', '#5b0f15', BELT],
  ['wwe-raw', 'WWE', 'Raw', 'Every Monday', '#e03a45', '#5b0f15', BELT],
  ['wwe-smackdown', 'WWE', 'SmackDown', 'Every Friday', '#3b82f6', '#102c5c', BELT],
  ['wwe-nxt', 'WWE', 'NXT', 'Every Tuesday', '#e3c14b', '#4d3f0c', BELT],
  ['aew', 'WRESTLING', 'AEW', 'Pay-per-views', '#c9a24a', '#4a3a12', BELT],
  ['aew-dynamite', 'AEW', 'Dynamite', 'Every Wednesday', '#c9a24a', '#4a3a12', BELT],
  ['aew-collision', 'AEW', 'Collision', 'Every Saturday', '#8b9bb4', '#263247', BELT],
  ['mlb', 'BASEBALL', 'MLB', 'Regular season and postseason', '#2f80ed', '#10375c', BASEBALL, 'square'],
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function background(w, h, accent, deep) {
  return `<defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#11151c"/>
      <stop offset="55%" stop-color="#1b2230"/>
      <stop offset="100%" stop-color="${deep}"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <rect x="0" y="0" width="${w}" height="8" fill="${accent}"/>
  <circle cx="${w - 120}" cy="80" r="${Math.round(w * 0.24)}" fill="${accent}" opacity="0.10"/>`;
}

// Title size shrinks for long names so it never runs off the card.
function titleSize(title, room, max) {
  return Math.min(max, Math.floor(room / (title.length * 0.62)));
}

function landscape([, kicker, title, subtitle, accent, deep, glyph]) {
  const w = 1000, h = 563;
  const size = titleSize(title, 560, 72);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  ${background(w, h, accent, deep)}
  <g transform="translate(84 ${(h - 250) / 2}) scale(1.25)">${glyph.replace(/\{deep\}/g, deep)}</g>
  <text x="380" y="262" font-family="Poppins" font-size="30" font-weight="600" fill="${accent}" letter-spacing="6">${esc(kicker)}</text>
  <text x="380" y="${262 + 12 + size}" font-family="Poppins" font-size="${size}" font-weight="700" fill="#ffffff">${esc(title)}</text>
  <text x="380" y="${262 + 12 + size + 44}" font-family="Poppins" font-size="24" fill="#93a1b5">${esc(subtitle)}</text>
</svg>`;
}

function stacked([, kicker, title, subtitle, accent, deep, glyph], w, h) {
  const size = titleSize(title, w - 80, 76);
  const top = Math.round(h * (h > w ? 0.2 : 0.12));
  const g = h > w ? 1.4 : 1.1;
  const below = top + 200 * g + (h > w ? 90 : 60);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  ${background(w, h, accent, deep)}
  <g transform="translate(${(w - 200 * g) / 2} ${top}) scale(${g})">${glyph.replace(/\{deep\}/g, deep)}</g>
  <text x="${w / 2}" y="${below}" text-anchor="middle" font-family="Poppins" font-size="28" font-weight="600" fill="${accent}" letter-spacing="6">${esc(kicker)}</text>
  <text x="${w / 2}" y="${below + 12 + size}" text-anchor="middle" font-family="Poppins" font-size="${size}" font-weight="700" fill="#ffffff">${esc(title)}</text>
  <text x="${w / 2}" y="${below + 12 + size + 42}" text-anchor="middle" font-family="Poppins" font-size="22" fill="#93a1b5">${esc(subtitle)}</text>
</svg>`;
}

function render(svg, file) {
  const fontFiles = fs.readdirSync(FONT_DIR).filter((f) => /^Poppins-.*\.ttf$/i.test(f)).map((f) => path.join(FONT_DIR, f));
  if (!fontFiles.length) throw new Error('No Poppins-*.ttf in ' + FONT_DIR + ' (Google Fonts, OFL)');
  const png = new Resvg(svg, { font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Poppins' } }).render().asPng();
  fs.writeFileSync(path.join(OUT, file), png);
  console.log('wrote public/' + file);
}

for (const p of PROMOTIONS) {
  render(landscape(p), 'promo-' + p[0] + '.png');
  if (p[7] === 'poster') render(stacked(p, 600, 900), 'promo-' + p[0] + '-poster.png');
  if (p[7] === 'square') render(stacked(p, 600, 600), 'promo-' + p[0] + '-square.png');
}

module.exports = { PROMOTIONS };
