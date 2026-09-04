'use strict';

// 0.90.8 — the admin skin.
//
// Tabler is themed through CSS custom properties, not through swappable
// stylesheets, so a "skin" here is a small set of variable values layered over
// the one vendored tabler.min.css. That is the whole mechanism: no second
// stylesheet to download, no build step, and a skin costs nothing to add.
//
// Three things are worth changing and no more:
//
//   • MODE — dark or light. Tabler implements this itself via
//     data-bs-theme on <html>, so the skin only has to name which one.
//   • ACCENT — Tabler's --tblr-primary and the handful of derived variables
//     that do not compute themselves from it (the button states, the link
//     colour, the tinted background used by .bg-primary-lt).
//   • RADIUS — --tblr-border-radius. Small, but it is most of the difference
//     between a page reading as "utility" and "product".
//
// Deliberately NOT offered: a font picker. Every font Tabler's own theme
// builder offers is a Google Fonts request, and this addon serves its own
// assets precisely so it works on a network that cannot reach a CDN — that was
// the whole point of vendoring Tabler in 0.90.0. A skin that silently
// reintroduces a remote font would undo it.
//
// The sidebar stays dark in every skin. Tabler's own layouts do the same, a
// dark rail reads as chrome rather than content, and it keeps the brand mark
// and the white sidebar text correct without a second set of rules.

const DEFAULT_SKIN = 'sportsroom';

// accent      — the colour at rest
// accentHover — one step darker, for :hover and links
// accentActive— two steps darker, for :active
// tint        — the low-alpha wash behind .bg-primary-lt and friends
const SKINS = Object.freeze([
  {
    id: 'sportsroom',
    name: 'Sportsroom',
    description: 'The SSS red on near-black. The original look.',
    mode: 'dark',
    accent: '#ef4444', accentHover: '#dc2626', accentActive: '#b91c1c',
    radius: '4px',
  },
  {
    id: 'floodlight',
    name: 'Floodlight',
    description: 'Cool blue on near-black. Quieter under a long session.',
    mode: 'dark',
    accent: '#4dabf7', accentHover: '#339af0', accentActive: '#1c7ed6',
    radius: '4px',
  },
  {
    id: 'pitch',
    name: 'Pitch',
    description: 'Green on near-black, matching the discovered-football tile.',
    mode: 'dark',
    accent: '#2fbf71', accentHover: '#25a05e', accentActive: '#1c7a48',
    radius: '4px',
  },
  {
    id: 'floodlit-amber',
    name: 'Amber',
    description: 'Warm amber on near-black. High contrast without the red.',
    mode: 'dark',
    accent: '#f59f00', accentHover: '#e08600', accentActive: '#b36a00',
    radius: '4px',
  },
  {
    id: 'terrace',
    name: 'Terrace',
    description: 'Violet on near-black, with softer corners.',
    mode: 'dark',
    accent: '#9b5de5', accentHover: '#8445d1', accentActive: '#6c34b0',
    radius: '10px',
  },
  {
    id: 'broadcast',
    name: 'Broadcast',
    description: 'Red on near-black with sharp corners. Denser, more utilitarian.',
    mode: 'dark',
    accent: '#ef4444', accentHover: '#dc2626', accentActive: '#b91c1c',
    radius: '0px',
  },
  {
    id: 'daylight',
    name: 'Daylight',
    description: 'Light mode, SSS red. For a bright room or a projector.',
    mode: 'light',
    accent: '#e03131', accentHover: '#c92a2a', accentActive: '#a51111',
    radius: '4px',
  },
  {
    id: 'newsprint',
    name: 'Newsprint',
    description: 'Light mode, indigo, softer corners. The calmest of the set.',
    mode: 'light',
    accent: '#4263eb', accentHover: '#3b5bdb', accentActive: '#364fc7',
    radius: '10px',
  },
]);

function list() { return SKINS.map((skin) => Object.assign({}, skin)); }

function get(id) {
  const key = String(id || '').trim().toLowerCase();
  return SKINS.find((skin) => skin.id === key)
    || SKINS.find((skin) => skin.id === DEFAULT_SKIN);
}

function isKnown(id) {
  return SKINS.some((skin) => skin.id === String(id || '').trim().toLowerCase());
}

function hexToRgb(hex) {
  const value = String(hex || '').replace('#', '');
  const full = value.length === 3
    ? value.split('').map((c) => c + c).join('')
    : value;
  const number = parseInt(full, 16);
  if (!Number.isFinite(number)) return '0, 0, 0';
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255].join(', ');
}

// The variable block for a skin. Everything Tabler derives for itself is left
// alone; only what it cannot derive is set.
function cssVariables(skin) {
  const chosen = skin && skin.accent ? skin : get(DEFAULT_SKIN);
  const rgb = hexToRgb(chosen.accent);
  return [
    '--tblr-primary: ' + chosen.accent + ';',
    '--tblr-primary-rgb: ' + rgb + ';',
    '--tblr-primary-fg: #fff;',
    '--tblr-primary-darken: ' + chosen.accentHover + ';',
    '--tblr-primary-lt: rgba(' + rgb + ', 0.12);',
    '--tblr-link-color: ' + chosen.accent + ';',
    '--tblr-link-hover-color: ' + chosen.accentHover + ';',
    '--tblr-border-radius: ' + chosen.radius + ';',
    // Consumed by the SSS-specific rules (brand mark, legacy aliases) so they
    // follow the skin instead of pinning the old red.
    '--sss-accent: ' + chosen.accent + ';',
    '--sss-accent-hover: ' + chosen.accentHover + ';',
    '--sss-accent-active: ' + chosen.accentActive + ';',
  ].join(' ');
}

module.exports = { SKINS, DEFAULT_SKIN, list, get, isKnown, cssVariables, hexToRgb };
