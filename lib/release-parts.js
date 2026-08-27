'use strict';

// Promotion-neutral first pass for release segmentation. Promotions can add
// their own rules later; keeping the classifier separate means cached release
// titles can be reclassified without repeating provider searches.
function classifyReleasePart(title) {
  const value = String(title || '');
  if (!value) return 'unknown';
  if (/\b(?:early|early[._ -]?access)[._ -]+prelims?\b/i.test(value)) return 'early-prelims';
  if (/\b(?:prelims?|preliminary[._ -]+card|undercard)\b/i.test(value)) return 'prelims';
  if (/\b(?:main[._ -]+card|ppv[._ -]+card)\b/i.test(value)) return 'main-card';
  if (/\b(?:full[._ -]+event|complete[._ -]+event|full[._ -]+card)\b/i.test(value)) return 'full-event';
  return 'unknown';
}

module.exports = { classifyReleasePart };

