'use strict';

const crypto = require('crypto');

const MAX_NZB_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_SEGMENTS = 200000;
const VIDEO_EXTENSIONS = new Set(['mkv', 'mp4', 'm4v', 'avi', 'mov', 'webm', 'ts', 'm2ts']);

function decodeXml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

function attribute(source, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp('(?:^|\\s)' + escaped + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i').exec(source);
  return decodeXml(match ? (match[1] !== undefined ? match[1] : match[2]) : '');
}

function filenameFromSubject(subject) {
  const quoted = /["']([^"']+\.([a-z0-9]{2,5}))["']/ig;
  let match;
  let selected = '';
  while ((match = quoted.exec(subject)) !== null) selected = match[1];
  if (selected) return selected.split(/[\\/]/).pop();
  const loose = /(?:^|\s)([^\s]+\.([a-z0-9]{2,5}))(?:\s|$)/i.exec(subject);
  return loose ? loose[1].split(/[\\/]/).pop() : '';
}

function parseNzb(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input || ''), 'utf8');
  if (!buffer.length || buffer.length > MAX_NZB_BYTES) throw new Error('NZB size is invalid');
  if (buffer.includes(0)) throw new Error('NZB contains invalid binary data');
  const xml = buffer.toString('utf8');
  if (!/<nzb(?:\s|>)/i.test(xml)) throw new Error('Invalid NZB document');
  const files = [];
  let segmentCount = 0;
  const filePattern = /<file\b([^>]*)>([\s\S]*?)<\/file\s*>/gi;
  let fileMatch;
  while ((fileMatch = filePattern.exec(xml)) !== null) {
    if (files.length >= MAX_FILES) throw new Error('NZB contains too many files');
    const subject = attribute(fileMatch[1], 'subject');
    const segments = [];
    const segmentPattern = /<segment\b([^>]*)>([\s\S]*?)<\/segment\s*>/gi;
    let segmentMatch;
    while ((segmentMatch = segmentPattern.exec(fileMatch[2])) !== null) {
      if (++segmentCount > MAX_SEGMENTS) throw new Error('NZB contains too many segments');
      const messageId = decodeXml(segmentMatch[2]).trim().replace(/^<|>$/g, '');
      if (!messageId || /[<>\r\n]/.test(messageId)) throw new Error('NZB contains an invalid message id');
      const number = Number(attribute(segmentMatch[1], 'number')) || segments.length + 1;
      const bytes = Number(attribute(segmentMatch[1], 'bytes')) || 0;
      segments.push({ number, bytes, messageId });
    }
    if (!segments.length) continue;
    segments.sort((a, b) => a.number - b.number);
    files.push({
      subject,
      filename: filenameFromSubject(subject),
      segments,
      encodedSize: segments.reduce((sum, segment) => sum + segment.bytes, 0),
    });
  }
  if (!files.length) throw new Error('NZB contains no usable files');
  const hash = crypto.createHash('sha1').update(files.flatMap((file) =>
    file.segments.map((segment) => segment.messageId)).sort().join('\n')).digest('hex');
  return { files, hash };
}

function selectDirectVideo(nzb) {
  return (nzb && nzb.files || []).filter((file) => {
    const ext = String(file.filename || '').split('.').pop().toLowerCase();
    return VIDEO_EXTENSIONS.has(ext) && !/(?:^|[._ -])sample(?:[._ -]|$)/i.test(file.filename);
  }).sort((a, b) => b.encodedSize - a.encodedSize)[0] || null;
}

module.exports = {
  MAX_NZB_BYTES, MAX_FILES, MAX_SEGMENTS, VIDEO_EXTENSIONS,
  decodeXml, filenameFromSubject, parseNzb, selectDirectVideo,
};
