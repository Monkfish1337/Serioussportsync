'use strict';

// Provider-neutral football club identity helpers. Metadata providers tend to
// return registered legal names while release groups use shorter broadcast
// names. These transformations are intentionally mechanical; non-obvious
// identities such as PSG and Inter remain the job of promotion alias presets.

const PREFIX_RE = /^(?:F\.?C\.?|F\.?K\.?|N\.?K\.?|G\.?N\.?K\.?|P\.?F\.?C\.?|A\.?F\.?C\.?|S\.?K\.?|Š\.?K\.?|C\.?F\.?)\s+/i;
const SUFFIX_RE = /\s+(?:F\.?C\.?|C\.?F\.?|A\.?F\.?C\.?|F\.?K\.?|S\.?K\.?|S\.?C\.?|B\.?C\.?|N\.?K\.?|P\.?F\.?C\.?|VfB)$/i;

function foldAscii(value) {
  return String(value || '')
    .replace(/[øØ]/g, (m) => m === 'Ø' ? 'O' : 'o')
    .replace(/[łŁ]/g, (m) => m === 'Ł' ? 'L' : 'l')
    .replace(/[đĐðÐ]/g, (m) => /[ĐÐ]/.test(m) ? 'D' : 'd')
    .replace(/[þÞ]/g, (m) => m === 'Þ' ? 'Th' : 'th')
    .replace(/[æÆ]/g, (m) => m === 'Æ' ? 'AE' : 'ae')
    .replace(/[œŒ]/g, (m) => m === 'Œ' ? 'OE' : 'oe')
    .replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function clean(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function stripLegalAffixes(value) {
  let output = clean(value);
  let previous;
  do {
    previous = output;
    output = output.replace(PREFIX_RE, '').replace(SUFFIX_RE, '').trim();
  } while (output && output !== previous);
  return output;
}

function sceneForm(value) {
  return foldAscii(stripLegalAffixes(value))
    .replace(/[’']/g, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim().replace(/\s+/g, ' ');
}

function unique(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const item = clean(value);
    const key = item.toLowerCase();
    if (item && !seen.has(key)) { seen.add(key); output.push(item); }
  }
  return output;
}

function providerTeamNames(team) {
  team = team || {};
  const translated = team.translations || {};
  const english = (field) => translated[field] && translated[field].EN;
  const providerNames = unique([
    english('displayOfficialName'), english('displayName'), team.internationalName,
    english('shortName'), team.teamCode,
  ]);
  const mechanical = [];
  for (const name of providerNames) {
    mechanical.push(sceneForm(name), foldAscii(stripLegalAffixes(name)), stripLegalAffixes(name));
  }
  // Release-friendly mechanical forms first, provider identities behind them.
  return unique(mechanical.concat(providerNames));
}

module.exports = { foldAscii, stripLegalAffixes, sceneForm, providerTeamNames };
