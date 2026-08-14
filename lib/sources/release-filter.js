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

const FOREIGN_LANG_PATTERNS = [
  /\bSPANISH\b/i, /\bESPA[NÑ]OL\b/i, /\bFRENCH\b/i,
  /\bFRANCAIS\b/i, /\bFRAN[ÇC]AIS\b/i, /\bITALIAN\b/i,
  /\bITALIANO\b/i, /\bGERMAN\b/i, /\bDEUTSCH\b/i,
  /\bPORTUGUESE\b/i, /\bPORTUGU[EÊ]S\b/i, /\bBRAZILIAN\b/i,
  /\bPT[\s._-]?BR\b/i, /\bDUTCH\b/i, /\bNEDERLANDS\b/i,
  /\bPOLISH\b/i, /\bPOLSKI\b/i, /\bRUSSIAN\b/i,
  /\bRU[\s._-]?DUB\b/i, /\bARABIC\b/i, /\bTURKISH\b/i,
  /\bT[UÜ]RK[ÇC]E\b/i, /\bCZECH\b/i, /\bHUNGARIAN\b/i,
  /\bMAGYAR\b/i, /\bGREEK\b/i, /\bJAPANESE\b/i,
  /\bKOREAN\b/i, /\bCHINESE\b/i, /\bMANDARIN\b/i,
];

const ALLOW_FOREIGN_LANG = /^(1|true|yes|on)$/i.test(String(process.env.ALLOW_FOREIGN_LANG || ''));

function isLikelyEventContent(title, extraPatterns) {
  if (!title) return false;
  for (const re of NOISE_PATTERNS) if (re.test(title)) return false;
  if (!ALLOW_FOREIGN_LANG) {
    for (const re of FOREIGN_LANG_PATTERNS) if (re.test(title)) return false;
  }
  if (extraPatterns) {
    for (const re of extraPatterns) if (re && re.test(title)) return false;
  }
  return true;
}

function filterSportsNoise(results, log, promotionId) {
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
    if (isLikelyEventContent(result.title, extraPatterns)) kept.push(result);
    else {
      dropped++;
      if (log) log('  release filter: noise drop: ' + result.title);
    }
  }
  return { results: kept, dropped };
}

module.exports = { isLikelyEventContent, filterSportsNoise };
