'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rar = require('../lib/sources/nntp-rar');

function vint(value) {
  const bytes = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

function rar5Block(type, flags, fields, data, extra) {
  const payload = Buffer.from(data || []);
  const extraArea = Buffer.from(extra || []);
  let commonFlags = flags || 0;
  if (payload.length) commonFlags |= 0x02;
  if (extraArea.length) commonFlags |= 0x01;
  const body = Buffer.concat([
    vint(type), vint(commonFlags),
    extraArea.length ? vint(extraArea.length) : Buffer.alloc(0),
    payload.length ? vint(payload.length) : Buffer.alloc(0),
    Buffer.from(fields || []), extraArea,
  ]);
  return Buffer.concat([Buffer.alloc(4), vint(body.length), body, payload]);
}

function rar5Volume(name, content, splitBefore, splitAfter, options) {
  const opts = options || {};
  const nameBytes = Buffer.from(name);
  const compressionInfo = opts.compressed ? 0x80 : 0;
  const fileFields = Buffer.concat([
    vint(0), vint(opts.totalSize || content.length), vint(0),
    vint(compressionInfo), vint(0), vint(nameBytes.length), nameBytes,
  ]);
  let flags = 0;
  if (splitBefore) flags |= 0x08;
  if (splitAfter) flags |= 0x10;
  const encryptedExtra = opts.encrypted
    ? Buffer.concat([vint(2), vint(1), Buffer.from([0])]) : Buffer.alloc(0);
  return Buffer.concat([
    Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]),
    rar5Block(1, 0, vint(1)),
    rar5Block(2, flags, fileFields, content, encryptedExtra),
    rar5Block(5, 0, vint(0)),
  ]);
}

function rar4Volume(name, content, splitBefore, splitAfter) {
  const nameBytes = Buffer.from(name);
  const headerSize = 32 + nameBytes.length;
  let flags = 0x8000;
  if (splitBefore) flags |= 0x0001;
  if (splitAfter) flags |= 0x0002;
  const header = Buffer.alloc(headerSize);
  header[2] = 0x74;
  header.writeUInt16LE(flags, 3);
  header.writeUInt16LE(headerSize, 5);
  header.writeUInt32LE(content.length, 7);
  header.writeUInt32LE(content.length, 11);
  header[25] = 0x30;
  header.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(header, 32);
  return Buffer.concat([
    Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]), header, content,
  ]);
}

function source(buffer) {
  return {
    size: buffer.length,
    readAt: async (offset, length) => buffer.subarray(offset, Math.min(buffer.length, offset + length)),
  };
}

test('groups consecutive RAR parts and rejects volume gaps', () => {
  const files = ['show.part01.rar', 'show.part02.rar', 'other.part01.rar'].map((filename) => ({
    filename, segments: [{ messageId: filename }], encodedSize: 100,
  }));
  const groups = rar.groupRarVolumes(files);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].slice(0, 2).map((item) => item.volume), [1, 2]);
  assert.equal(rar.groupRarVolumes([
    { filename: 'show.part01.rar', segments: [{}] },
    { filename: 'show.part03.rar', segments: [{}] },
  ]).length, 0);
});

test('maps a stored RAR5 video across multiple volumes', async () => {
  const first = rar5Volume('main.mkv', Buffer.from('ABCD'), false, true, { totalSize: 8 });
  const second = rar5Volume('main.mkv', Buffer.from('EFGH'), true, false, { totalSize: 8 });
  const inspected = await rar.inspectRar([source(first), source(second)]);
  assert.equal(inspected.selected.name, 'main.mkv');
  assert.equal(inspected.selected.size, 8);
  assert.deepEqual(inspected.selected.fragments.map((fragment) => fragment.volumeIndex), [0, 1]);
  assert.deepEqual(inspected.selected.fragments.map((fragment) => fragment.length), [4, 4]);
});

test('maps a stored RAR4 video across old-style volumes', async () => {
  const first = rar4Volume('main.mkv', Buffer.from('ABCD'), false, true);
  const second = rar4Volume('main.mkv', Buffer.from('EFGH'), true, false);
  const inspected = await rar.inspectRar([source(first), source(second)]);
  assert.equal(inspected.selected.name, 'main.mkv');
  assert.equal(inspected.selected.size, 8);
  assert.deepEqual(inspected.selected.fragments.map((fragment) => fragment.length), [4, 4]);
});

test('does not select compressed or encrypted RAR5 video entries', async () => {
  const compressed = await rar.inspectRar([source(rar5Volume(
    'main.mkv', Buffer.from('DATA'), false, false, { compressed: true }))]);
  assert.equal(compressed.selected, null);
  const encrypted = await rar.inspectRar([source(rar5Volume(
    'main.mkv', Buffer.from('DATA'), false, false, { encrypted: true }))]);
  assert.equal(encrypted.selected, null);
});

test('rejects a RAR5 data area outside the bounded volume', async () => {
  const damaged = rar5Volume('main.mkv', Buffer.from('DATA'), false, false);
  await assert.rejects(rar.inspectRar([source(damaged.subarray(0, damaged.length - 10))]),
    /exceeds its volume|truncated/);
});

test('rejects archive volume counts above the global limit', async () => {
  const empty = { size: 0, readAt: async () => Buffer.alloc(0) };
  await assert.rejects(rar.inspectRar(Array.from({ length: rar.MAX_ARCHIVE_VOLUMES + 1 }, () => empty)),
    /volume count is invalid/);
});
