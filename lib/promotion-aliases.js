'use strict';

// Turn a handful of known-good scene release names into conservative,
// operator-editable promotion aliases. This intentionally favours precision:
// volatile event numbers, dates and encode/source tags stop the stable prefix.
const TECH_TOKEN = /^(?:2160p|1080[pi]|720p|480p|uhd|hdr10?|dv|dolby|web(?:-?dl)?|webrip|bluray|b[rd]rip|h\.?26[45]|x26[45]|hevc|avc|aac\d*|ac3|ddp?\d*|atmos|remux|proper|repack|multi|complete)$/i;
const YEAR_TOKEN = /^(?:19|20)\d{2}$/;
const DATE_TOKEN = /^(?:19|20)\d{2}[.-]\d{1,2}[.-]\d{1,2}$/;

function cleanReleaseTitle(value) {
  return String(value || '')
    .replace(/\.(?:mkv|mp4|avi|ts|nzb)$/i, '')
    .replace(/[._]+/g, ' ')
    .replace(/\s+-\s*[A-Za-z0-9]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stablePrefix(value) {
  const tokens = cleanReleaseTitle(value).split(/\s+/).filter(Boolean);
  const kept = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i].replace(/^[([{]+|[\])},:;]+$/g, '');
    if (!token) continue;
    const numeric = /^\d+$/.test(token);
    const formulaSeries = numeric && /^[1-4]$/.test(token) && kept.length && /^formula$/i.test(kept[kept.length - 1]);
    if (YEAR_TOKEN.test(token) || DATE_TOKEN.test(token) || TECH_TOKEN.test(token)
        || (numeric && !formulaSeries)) break;
    kept.push(token);
    if (kept.length >= 5) break;
  }
  return kept.join(' ').trim();
}

function acronym(name) {
  const words = String(name || '').match(/[A-Za-z0-9]+/g) || [];
  const significant = words.filter((w) => !/^(?:the|of|and)$/i.test(w));
  if (significant.length < 2) return '';
  return significant.map((w) => w[0]).join('').toUpperCase();
}

function derivePromotionAliases(name, examples) {
  const out = [];
  const seen = new Set();
  const add = (value) => {
    const clean = String(value || '').replace(/\s+/g, ' ').trim();
    const key = clean.toLowerCase();
    if (clean.length >= 2 && clean.length <= 64 && !seen.has(key)) {
      seen.add(key);
      out.push(clean);
    }
  };

  add(name);
  add(acronym(name));
  if (/\bformula\s+1\b/i.test(name)) {
    add('F1');
    add('Formula1');
  }

  const lines = Array.isArray(examples)
    ? examples
    : String(examples || '').split(/\r?\n/);
  for (const line of lines) {
    const prefix = stablePrefix(line);
    add(prefix);
    if (/^formula\s+1$/i.test(prefix)) add('F1');
  }
  return out.slice(0, 12);
}

function sceneTokens(value) {
  return cleanReleaseTitle(value).toLowerCase().match(/[a-z0-9]+/g) || [];
}

function deriveExclusions(name, goodExamples, badExamples) {
  const goodLines = Array.isArray(goodExamples) ? goodExamples : String(goodExamples || '').split(/\r?\n/);
  const badLines = Array.isArray(badExamples) ? badExamples : String(badExamples || '').split(/\r?\n/);
  const goodTokens = new Set(sceneTokens(name));
  for (const line of goodLines) for (const token of sceneTokens(line)) goodTokens.add(token);
  const ignored = new Set(['the', 'and', 'with', 'from', 'versus', 'vs']);
  const aliases = new Set(derivePromotionAliases(name, goodLines).map((v) => v.toLowerCase()));
  const out = [];
  const seen = new Set();
  const add = (value) => {
    const clean = String(value || '').replace(/\s+/g, ' ').trim();
    const key = clean.toLowerCase();
    if (clean && clean.length <= 64 && !seen.has(key) && !aliases.has(key)) {
      seen.add(key); out.push(clean);
    }
  };

  for (const line of badLines) {
    if (!String(line || '').trim()) continue;
    const prefix = stablePrefix(line);
    const prefixTokens = sceneTokens(prefix);
    if (prefixTokens.some((token) => !goodTokens.has(token))) add(prefix);
    for (const token of sceneTokens(line)) {
      if (ignored.has(token) || goodTokens.has(token) || YEAR_TOKEN.test(token)
          || TECH_TOKEN.test(token) || /^\d+$/.test(token)) continue;
      if (token.length >= 4 || /\d/.test(token)) add(token);
    }
  }
  return out.slice(0, 12);
}

function suggestPromotionSetup(name, examples, badExamples) {
  const aliases = derivePromotionAliases(name, examples);
  return {
    aliases,
    keywords: aliases.map((v) => v.toLowerCase()),
    exclusions: deriveExclusions(name, examples, badExamples),
  };
}

module.exports = {
  cleanReleaseTitle,
  stablePrefix,
  derivePromotionAliases,
  deriveExclusions,
  suggestPromotionSetup,
};
