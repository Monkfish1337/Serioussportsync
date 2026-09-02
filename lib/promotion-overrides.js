'use strict';

// User-owned matching overlays for shipped promotions. They preserve the
// promotion's bespoke metadata/event logic while extending search aliases and
// relevance rules. Stored separately so image upgrades never overwrite them.

const fs = require('fs');
const path = require('path');
const config = require('../config');
const ruleTools = require('./promotion-aliases');

const FILE = process.env.PROMOTION_OVERRIDES_FILE
  || path.join(path.dirname(config.customPromotionsFile || './data/custom-promotions.json'), 'promotion-overrides.json');

function empty() { return { version: 1, overrides: [], updatedAt: null }; }
function load() {
  try {
    if (!fs.existsSync(FILE)) return empty();
    const value = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return value && Array.isArray(value.overrides) ? value : empty();
  } catch (_) { return empty(); }
}
function save(state) {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  state.updatedAt = new Date().toISOString();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}
function list() { return load().overrides.slice(); }
function find(promotionId) { return list().find((item) => item.promotionId === promotionId) || null; }
function lines(value, max, lower) {
  const input = Array.isArray(value) ? value : String(value || '').split(/[\r\n,]+/);
  const seen = new Set(), out = [];
  for (const entry of input) {
    const clean = String(entry || '').replace(/\s+/g, ' ').trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key); out.push(lower ? key : clean);
    if (out.length >= max) break;
  }
  return out;
}
function normalise(promotionId, promotionName, input) {
  const aliases = lines(input.promotionAliases, 20, false);
  const keywords = lines(input.relevanceKeywords, 20, true);
  const sanitized = ruleTools.sanitizeMatchingRules(promotionName, aliases, keywords,
    lines(input.exclusionKeywords, 20, true));
  const templates = (Array.isArray(input.searchTitleTemplates) ? input.searchTitleTemplates
    : String(input.searchTitleTemplates || '').split(/\r?\n/))
    .map((value) => String(value || '').trim()).filter(Boolean).slice(0, 12);
  if (!aliases.length && !keywords.length && !templates.length) {
    throw new Error('Confirm releases and create at least one matching rule before saving');
  }
  return {
    promotionId, promotionAliases: aliases,
    relevanceKeywords: keywords.length ? keywords : aliases.map((value) => value.toLowerCase()),
    exclusionKeywords: sanitized.exclusions,
    searchTitleTemplates: templates.length ? templates : ['{name}', '{name} {year}'],
    requireDateInTitle: input.requireDateInTitle === true || input.requireDateInTitle === '1',
    allowForeignLanguage: input.allowForeignLanguage === true || input.allowForeignLanguage === '1',
    updatedAt: new Date().toISOString(),
  };
}
function set(promotionId, promotionName, input) {
  const state = load();
  const value = normalise(String(promotionId || ''), String(promotionName || promotionId || ''), input || {});
  state.overrides = state.overrides.filter((item) => item.promotionId !== value.promotionId);
  state.overrides.push(value); save(state); return value;
}
function remove(promotionId) {
  const state = load();
  const before = state.overrides.length;
  state.overrides = state.overrides.filter((item) => item.promotionId !== promotionId);
  if (state.overrides.length !== before) save(state);
  return state.overrides.length !== before;
}

module.exports = { load, list, find, set, remove, normalise, file: FILE };
