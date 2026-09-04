// Provider-neutral release filtering shared by playback pipelines and admin tools.

const NOISE_PATTERNS = [
  /\bvlog\b/i, /\bembedded\b/i, /\binterview\b/i,
  /\bpress[\s._-]*conf/i, /\bweigh[\s._-]*in\b/i, /\bceremonial\b/i,
  /\b(?:q[\s._-]*and[\s._-]*a|qanda|q&a)\b/i,
  /\bpreview\b/i, /\brecap\b/i, /\bhighlights?\b/i,
  /\bbest[\s._-]*finishes?\b/i, /\bpromo\b/i, /\btrailer\b/i,
  /\bbehind[\s._-]*the[\s._-]*scenes\b/i, /\bdocumentary\b/i,
  /\bcountdown\b/i, /\bhype\b/i, /\bon[\s._-]*the[\s._-]*line\b/i,
  /\bextra[\s._-]*rounds\b/i, /\bits[\s._-]*time\b/i,
  /\bfight[\s._-]*week\b/i, /\banniversary\b/i,
  /\btalk(?:ing)?[\s._-]*smack\b/i, /\bthe[\s._-]*bump\b/i,
  /\bafter[\s._-]*the[\s._-]*bell\b/i, /\bcontrol[\s._-]*center\b/i,
  /\btech[\s._-]*talk\b/i, /\btop[\s._-]*10\b/i,
  /\bpre[\s._-]*fight\b/i, /\bpost[\s._-]*fight\b/i,
  /\bpresser\b/i, /\bopen[\s._-]*workout/i, /\bmedia[\s._-]*day\b/i,
];

// An English nationality adjective is a language tag in a release name and a
// place name in an event name, and sport is full of the second kind: the F1 and
// MotoGP calendars are literally a list of them. "Formula 1 Hungarian Grand
// Prix Practice 1" was being dropped as Hungarian-audio, which is why those
// promotions matched nothing at all.
//
// So each ambiguous word is guarded against the nouns that make it a place.
// The words below only ever appear as an event name when followed by one of
// these; a real language tag is followed by a quality, a codec, a group or
// nothing.
const EVENT_NOUN = '(?:grand[\\s._-]*prix|gp|moto[\\s._-]*gp|open|masters|cup'
  + '|league|derby|championships?|classic|trophy|series|nationals?|round'
  + '|grand[\\s._-]*slam|riviera|riders?|driver)';

// Native-language names are unambiguous — no sporting event is called the
// "Deutsch Grand Prix" — so they need no guard.
const UNAMBIGUOUS_LANG_PATTERNS = [
  /\bESPA[NÑ]OL\b/i, /\bFRANCAIS\b/i, /\bFRAN[ÇC]AIS\b/i,
  /\bITALIANO\b/i, /\bDEUTSCH\b/i, /\bPORTUGU[EÊ]S\b/i,
  /\bPT[\s._-]?BR\b/i, /\bNEDERLANDS\b/i, /\bPOLSKI\b/i,
  /\bRU[\s._-]?DUB\b/i, /\bT[UÜ]RK[ÇC]E\b/i, /\bMAGYAR\b/i,
  /\bMANDARIN\b/i, /\bARABIC\b/i,
];

const AMBIGUOUS_LANG_WORDS = [
  'SPANISH', 'FRENCH', 'ITALIAN', 'GERMAN', 'PORTUGUESE', 'BRAZILIAN',
  'DUTCH', 'POLISH', 'RUSSIAN', 'TURKISH', 'CZECH', 'HUNGARIAN',
  'GREEK', 'JAPANESE', 'KOREAN', 'CHINESE',
];

const FOREIGN_LANG_PATTERNS = UNAMBIGUOUS_LANG_PATTERNS.concat(
  AMBIGUOUS_LANG_WORDS.map((word) =>
    new RegExp('\\b' + word + '\\b(?![\\s._-]*' + EVENT_NOUN + '\\b)', 'i'))
);

const ALLOW_FOREIGN_LANG = /^(1|true|yes|on)$/i.test(String(process.env.ALLOW_FOREIGN_LANG || ''));

function isLikelyEventContent(title, extraPatterns, options) {
  if (!title) return false;
  for (const re of NOISE_PATTERNS) if (re.test(title)) return false;
  const allowForeignLanguage = ALLOW_FOREIGN_LANG || !!(options && options.allowForeignLanguage);
  if (!allowForeignLanguage) {
    for (const re of FOREIGN_LANG_PATTERNS) if (re.test(title)) return false;
  }
  if (extraPatterns) {
    for (const re of extraPatterns) if (re && re.test(title)) return false;
  }
  return true;
}

function rejectionReason(title, extraPatterns, options) {
  for (const re of NOISE_PATTERNS) if (re.test(title)) return 'sports-noise';
  const allowForeignLanguage = ALLOW_FOREIGN_LANG || !!(options && options.allowForeignLanguage);
  if (!allowForeignLanguage) {
    for (const re of FOREIGN_LANG_PATTERNS) if (re.test(title)) return 'foreign-language';
  }
  if (extraPatterns) {
    for (const re of extraPatterns) if (re && re.test(title)) return 'promotion-rule';
  }
  return null;
}

function filterSportsNoise(results, log, promotionId, options) {
  if (!Array.isArray(results)) return { results: [], dropped: 0 };
  let extraPatterns = null;
  if (promotionId) {
    try {
      const overrides = require('../match-overrides');
      extraPatterns = overrides.getMergedNoisePatterns(promotionId, [])
        .map((pattern) => overrides.compileOverridePattern(pattern, 'i'))
        .filter(Boolean);
    } catch (err) {
      if (log) log('  release filter: override load failed: ' + err.message);
    }
  }
  const kept = [];
  let dropped = 0;
  for (const result of results) {
    const reason = rejectionReason(result.title, extraPatterns, options);
    if (!reason) kept.push(result);
    else {
      dropped++;
      if (log) log('  release filter: ' + reason + ' drop: ' + result.title);
    }
  }
  return { results: kept, dropped };
}

module.exports = { isLikelyEventContent, filterSportsNoise, rejectionReason };
