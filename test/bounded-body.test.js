'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const boundedBody = require('../lib/bounded-body');

function response(chunks, declared) {
  return {
    headers: { get: (name) => name === 'content-length' && declared ? String(declared) : null },
    body: Readable.from(chunks),
  };
}

test('reads a response body within its byte limit', async () => {
  const value = await boundedBody.readJson(response(['{"ok":', 'true}']), 32, 'Test response');
  assert.deepEqual(value, { ok: true });
});

test('rejects oversized declared and streamed response bodies', async () => {
  await assert.rejects(boundedBody.readBuffer(response(['small'], 100), 10, 'Declared'), /size limit/);
  await assert.rejects(boundedBody.readBuffer(response(['12345', '67890', 'x']), 10, 'Streamed'), /size limit/);
});
