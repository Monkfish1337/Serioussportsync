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

// Release examples often put a competition stage immediately before the
// date ("UEFA Champions League FINAL 2026.05.30").  A stage describes one
// event, not the promotion, so learning it as an alias makes every later
// fixture search for "FINAL".  Trim only trailing stage markers: words in
// the actual promotion name remain untouched.
function stripEventStageSuffix(value) {
  let clean = String(value || '').trim();
  const suffixes = [
    /\s+(?:grand\s+)?finals?$/i,
    /\s+semi[\s-]*finals?$/i,
    /\s+(?:quarter|qtr)[\s-]*finals?$/i,
    /\s+(?:round|rnd)\s+(?:of\s+)?(?:\d+|[a-z]+)$/i,
    /\s+(?:first|second|1st|2nd)\s+legs?$/i,
    /\s+legs?\s*\d+$/i,
  ];
  let previous;
  do {
    previous = clean;
    for (const pattern of suffixes) clean = clean.replace(pattern, '').trim();
  } while (clean !== previous);
  return clean;
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
    const prefix = stripEventStageSuffix(stablePrefix(line));
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

function sceneTerm(value) {
  return sceneTokens(value).join(' ');
}

// Reject rules run before positive matching, so an exclusion such as "mlb"
// would otherwise make the matching alias "MLB" impossible to use. Keep this
// generic: any exclusion that would reject the promotion name, an alias, or a
// recognition term is unsafe and must not enter the active ruleset.
function sanitizeMatchingRules(name, aliases, keywords, exclusions) {
  const positives = [name].concat(aliases || [], keywords || [])
    .map(sceneTerm).filter(Boolean);
  const safe = [];
  const removed = [];
  const seen = new Set();
  for (const value of exclusions || []) {
    const clean = String(value || '').trim();
    const normalized = sceneTerm(clean);
    if (!clean || !normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const conflicts = positives.some((positive) => positive === normalized
      || positive.startsWith(normalized + ' ')
      || positive.endsWith(' ' + normalized)
      || positive.includes(' ' + normalized + ' '));
    if (conflicts) removed.push(clean);
    else safe.push(clean);
  }
  return { exclusions: safe, removedExclusions: removed };
}

// Learn where a release places its promotion marker and date. This produces
// editable generic templates rather than sport-specific code. Example:
// "MLB.2026.08.25.Pirates.vs.Padres" teaches
// "{promotion} {date_spaced} {name}".
function deriveSearchTitleTemplates(name, examples) {
  const out = [];
  const add = (value) => { if (value && !out.includes(value)) out.push(value); };
  const lines = Array.isArray(examples) ? examples : String(examples || '').split(/\r?\n/);
  for (const line of lines) {
    const cleaned = cleanReleaseTitle(line).replace(/[-]+/g, ' ').replace(/\s+/g, ' ').trim();
    const prefix = stripEventStageSuffix(stablePrefix(line));
    if (!prefix) continue;
    const prefixAt = cleaned.toLowerCase().indexOf(prefix.toLowerCase());
    const fullDate = /\b(?:19|20)\d{2}\s+(?:0?[1-9]|1[0-2])\s+(?:0?[1-9]|[12]\d|3[01])\b/.exec(cleaned);
    if (fullDate) {
      add(prefixAt >= 0 && prefixAt < fullDate.index
        ? '{promotion} {date_spaced} {name}'
        : '{date_spaced} {promotion} {name}');
      continue;
    }
    const year = /\b(?:19|20)\d{2}\b/.exec(cleaned);
    if (year) add(prefixAt >= 0 && prefixAt < year.index
      ? '{promotion} {year} {name}'
      : '{year} {promotion} {name}');
  }
  add('{name}');
  add('{name} {year}');
  return out.slice(0, 6);
}

function suggestPromotionSetup(name, examples, badExamples) {
  const aliases = derivePromotionAliases(name, examples);
  const keywords = aliases.map((v) => v.toLowerCase());
  const sanitized = sanitizeMatchingRules(
    name,
    aliases,
    keywords,
    deriveExclusions(name, examples, badExamples)
  );
  return {
    aliases,
    keywords,
    exclusions: sanitized.exclusions,
    removedExclusions: sanitized.removedExclusions,
    searchTitleTemplates: deriveSearchTitleTemplates(name, examples),
  };
}

module.exports = {
  cleanReleaseTitle,
  stablePrefix,
  derivePromotionAliases,
  stripEventStageSuffix,
  deriveExclusions,
  deriveSearchTitleTemplates,
  sanitizeMatchingRules,
  suggestPromotionSetup,
};
