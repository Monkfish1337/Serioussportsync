'use strict';

// User-created metadata provider for public JSON APIs. The provider is kept
// deliberately declarative: users supply the endpoint, the array containing
// events, and dotted field paths. No user JavaScript is evaluated.
const crypto = require('crypto');
const fetch = require('node-fetch');
const httpAgent = require('../http-agent');
const security = require('../security');
const boundedBody = require('../bounded-body');

const MAX_BYTES = 5 * 1024 * 1024;
const PATH_RE = /^(?:[A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_-]+)*$/;

function pathValue(value, path) {
  const key = String(path || '').trim();
  if (!key) return value;
  return key.split('.').reduce((current, part) => current == null ? undefined : current[part], value);
}

function validatePath(value, label, required) {
  const path = String(value || '').trim();
  if (!path && !required) return '';
  if (!path || path.length > 160 || !PATH_RE.test(path)) {
    throw new Error(label + ' must be a dotted field path such as event.name');
  }
  return path;
}

function normalizeDate(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
}

function normalizeTime(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  const match = text.match(/(?:T|^)(\d{2}:\d{2}(?::\d{2})?)/);
  return match ? match[1] : null;
}

function definition(input) {
  const url = security.cleanHttpUrl(input.url, {
    label: 'JSON/API URL', allowEmpty: false, maxLength: 2048,
  });
  const fields = input.fields || input;
  return {
    type: 'json-feed',
    url,
    arrayPath: String(input.arrayPath || '').trim()
      ? validatePath(input.arrayPath, 'Event list path', false) : '',
    fields: {
      name: validatePath(fields.nameField || fields.name, 'Event name field', true),
      date: validatePath(fields.dateField || fields.date, 'Event date field', true),
      id: validatePath(fields.idField || fields.id, 'Event ID field', false),
      time: validatePath(fields.timeField || fields.time, 'Start time field', false),
      venue: validatePath(fields.venueField || fields.venue, 'Venue field', false),
      description: validatePath(fields.descriptionField || fields.description, 'Description field', false),
      poster: validatePath(fields.posterField || fields.poster, 'Artwork field', false),
    },
  };
}

async function boundedJson(url, opts) {
  const options = opts || {};
  let current = security.cleanHttpUrl(url, { label: 'JSON/API URL', allowEmpty: false });
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await (options.fetchImpl || fetch)(current, httpAgent.fetchOpts({
      method: 'GET', redirect: 'manual', timeout: options.timeoutMs || 10000,
      headers: { Accept: 'application/json', 'User-Agent': 'SeriousSportSync/metadata-provider' },
    }, current));
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      current = security.cleanHttpUrl(new URL(response.headers.get('location'), current).toString(), {
        label: 'JSON/API redirect', allowEmpty: false,
      });
      continue;
    }
    if (!response.ok) throw new Error('JSON/API provider returned HTTP ' + response.status);
    try { return await boundedBody.readJson(response, MAX_BYTES, 'JSON/API response'); }
    catch (error) {
      if (/size limit/i.test(error.message)) throw new Error('JSON/API response is larger than 5 MB');
      throw new Error('Provider did not return valid JSON');
    }
  }
  throw new Error('JSON/API provider redirected too many times');
}

function mapEvents(payload, source) {
  const config = definition(source || {});
  const rows = pathValue(payload, config.arrayPath);
  if (!Array.isArray(rows)) {
    throw new Error(config.arrayPath
      ? 'Event list path “' + config.arrayPath + '” did not contain an array'
      : 'The JSON response root must be an array, or enter its event list path');
  }
  return rows.slice(0, 5000).map((row, index) => {
    const name = String(pathValue(row, config.fields.name) || '').trim();
    const dateRaw = pathValue(row, config.fields.date);
    const date = normalizeDate(dateRaw);
    if (!name || !date) return null;
    const explicitId = config.fields.id ? pathValue(row, config.fields.id) : '';
    const sourceId = String(explicitId || crypto.createHash('sha256')
      .update(name + '|' + date + '|' + index).digest('hex').slice(0, 20));
    const timeRaw = config.fields.time ? pathValue(row, config.fields.time) : dateRaw;
    return {
      sourceId, name, date, time: normalizeTime(timeRaw),
      venue: config.fields.venue ? String(pathValue(row, config.fields.venue) || '').trim() || null : null,
      description: config.fields.description ? String(pathValue(row, config.fields.description) || '').trim() || null : null,
      poster: config.fields.poster ? String(pathValue(row, config.fields.poster) || '').trim() || null : null,
      source: { type: 'json-feed', sourceId },
    };
  }).filter(Boolean);
}

async function fetchAll(source, opts) {
  const config = definition(source || {});
  const payload = await boundedJson(config.url, opts);
  const events = mapEvents(payload, config);
  if (!events.length) throw new Error('Provider returned JSON, but no rows matched the name and date fields');
  return events;
}

module.exports = { definition, pathValue, normalizeDate, mapEvents, fetchAll, boundedJson, MAX_BYTES };
