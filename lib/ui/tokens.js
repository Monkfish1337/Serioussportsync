'use strict';

// 0.91.0 — the SSS design system, part one: tokens.
//
// This replaces Tabler rather than themes it. Tabler gave the admin a
// competent bootstrap look for free, and the cost was that every page came out
// the same shape: one card style, one border, one weight, top to bottom, with
// no way to say that one thing on a page matters more than another.
//
// What is here is deliberately small. A token set, two themes, and no
// framework — because the whole reason the admin renders as strings of HTML
// from Node is that there is no build step, and a design system that needs one
// would be the wrong answer to "SSS looks very 90s".
//
// The palette is not neutral grey. Grounds and surfaces carry a slight blue
// bias, which is what stops a dark UI reading as unconsidered; the accent is
// the SSS red, and semantic colour (ready / attention / failed / pending) is
// kept separate from it so a red button and a red chip never mean the same
// thing by accident.
//
// The 0.90.8 skins survive as accent sets: a skin now supplies the accent
// triple and the corner radius, and everything else comes from here.

const SKIN_FALLBACK = {
  mode: 'dark',
  accent: '#ff3b47', accentHover: '#e02b37', accentActive: '#b91c1c',
  radius: '8px',
};

function hexToRgb(hex) {
  const value = String(hex || '').replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const number = parseInt(full, 16);
  if (!Number.isFinite(number)) return '0, 0, 0';
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255].join(', ');
}

// Grounds and surfaces per mode. A light theme is not an inverted dark one:
// the accent drops saturation so it still reads on white, and the neutrals
// warm slightly rather than becoming pure grey.
const MODES = {
  dark: {
    ground: '#0a111c', surface: '#101a29', surface2: '#141f30', raised: '#1a2739',
    line: '#23334a', lineStrong: '#33465f',
    ink: '#e8eefa', ink2: '#a9bad4', ink3: '#6f83a0',
    ok: '#19c58f', warn: '#f5a524', info: '#5aa9ff', bad: '#ff5c6c',
    tint: '0.14',
  },
  light: {
    ground: '#f2f4f8', surface: '#ffffff', surface2: '#f7f9fc', raised: '#ffffff',
    line: '#dde3ec', lineStrong: '#c3cddc',
    ink: '#16202e', ink2: '#4a5a72', ink3: '#7d8ba1',
    ok: '#0f8f68', warn: '#a96b00', info: '#1f6fd0', bad: '#c4303e',
    tint: '0.10',
  },
};

function variables(skin) {
  const chosen = Object.assign({}, SKIN_FALLBACK, skin || {});
  const mode = MODES[chosen.mode === 'light' ? 'light' : 'dark'];
  const rgb = hexToRgb(chosen.accent);
  return [
    '--ground: ' + mode.ground + ';',
    '--surface: ' + mode.surface + ';',
    '--surface-2: ' + mode.surface2 + ';',
    '--raised: ' + mode.raised + ';',
    '--line: ' + mode.line + ';',
    '--line-strong: ' + mode.lineStrong + ';',
    '--ink: ' + mode.ink + ';',
    '--ink-2: ' + mode.ink2 + ';',
    '--ink-3: ' + mode.ink3 + ';',
    '--accent: ' + chosen.accent + ';',
    '--accent-rgb: ' + rgb + ';',
    '--accent-hover: ' + chosen.accentHover + ';',
    '--accent-active: ' + chosen.accentActive + ';',
    '--accent-ink: #fff;',
    '--accent-soft: rgba(' + rgb + ', ' + mode.tint + ');',
    '--ok: ' + mode.ok + ';',
    '--ok-soft: rgba(' + hexToRgb(mode.ok) + ', ' + mode.tint + ');',
    '--warn: ' + mode.warn + ';',
    '--warn-soft: rgba(' + hexToRgb(mode.warn) + ', ' + mode.tint + ');',
    '--info: ' + mode.info + ';',
    '--info-soft: rgba(' + hexToRgb(mode.info) + ', ' + mode.tint + ');',
    '--bad: ' + mode.bad + ';',
    '--bad-soft: rgba(' + hexToRgb(mode.bad) + ', ' + mode.tint + ');',
    '--r-sm: 4px;',
    '--r: ' + chosen.radius + ';',
    '--r-lg: calc(' + chosen.radius + ' + 6px);',
    '--rail-w: 68px;',
    '--pad: 20px;',
  ].join(' ');
}

// Fonts are bundled, never fetched. Vendoring Tabler in 0.90.0 was so a
// self-hosted addon renders on a network that cannot reach a CDN; a design
// system that opens with a Google Fonts request would undo that on day one.
// Barlow Condensed would suit the labels, but a stack that degrades to the
// platform's own condensed face costs nothing and always arrives.
const FONTS = [
  "--font-body: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;",
  "--font-cond: 'Barlow Condensed', 'Archivo Narrow', 'Roboto Condensed', 'Segoe UI Semibold', system-ui, sans-serif;",
  "--font-mono: ui-monospace, 'SF Mono', 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;",
].join(' ');

module.exports = { variables, hexToRgb, FONTS, MODES, SKIN_FALLBACK };
