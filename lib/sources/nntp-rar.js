'use strict';

const { VIDEO_EXTENSIONS } = require('./nntp-nzb');

const RAR4_SIGNATURE = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
const RAR5_SIGNATURE = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
const MAX_SFX_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 2 * 1024 * 1024;
const MAX_BLOCKS_PER_VOLUME = 10000;
const MAX_ARCHIVE_VOLUMES = 512;
const MAX_ARCHIVE_ENTRIES = 10000;

function rarVolumeIdentity(filename) {
  const name = String(filename || '');
  let match = /^(.*)\.part(\d+)\.rar$/i.exec(name);
  if (match) return { base: match[1].toLowerCase(), volume: Number(match[2]) };
  match = /^(.*)\.r(\d{2,3})$/i.exec(name);
  if (match) return { base: match[1].toLowerCase(), volume: Number(match[2]) + 1 };
  match = /^(.*)\.([s-z])(\d{2})$/i.exec(name);
  if (match) return {
    base: match[1].toLowerCase(),
    volume: 101 + (match[2].toLowerCase().charCodeAt(0) - 0x73) * 100 + Number(match[3]),
  };
  match = /^(.*)\.rar$/i.exec(name);
  return match ? { base: match[1].toLowerCase(), volume: 0 } : null;
}

function groupRarVolumes(files) {
  const groups = new Map();
  for (let index = 0; index < (files || []).length; index++) {
    const file = files[index];
    const identity = rarVolumeIdentity(file && file.filename);
    if (!identity) continue;
    const key = identity.base;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ index, volume: identity.volume, file });
  }
  const output = [];
  for (const members of groups.values()) {
    members.sort((a, b) => a.volume - b.volume || a.index - b.index);
    const deduped = [];
    for (const member of members) {
      const previous = deduped[deduped.length - 1];
      if (previous && previous.volume === member.volume) {
        if (member.file.segments.length > previous.file.segments.length) deduped[deduped.length - 1] = member;
      } else deduped.push(member);
    }
    if (deduped.length > MAX_ARCHIVE_VOLUMES) continue;
    if (deduped.length > 1 && !deduped.every((member, i) =>
      i === 0 || member.volume === deduped[i - 1].volume + 1)) continue;
    output.push(deduped);
  }
  return output.sort((a, b) => b.reduce((sum, m) => sum + m.file.encodedSize, 0)
    - a.reduce((sum, m) => sum + m.file.encodedSize, 0));
}

function readVint(buffer, offset, limit) {
  let value = 0;
  let shift = 0;
  for (let length = 1; length <= 10 && offset + length <= limit; length++) {
    const byte = buffer[offset + length - 1];
    value += (byte & 0x7f) * (2 ** shift);
    if (!Number.isSafeInteger(value)) return null;
    if (!(byte & 0x80)) return { value, length };
    shift += 7;
  }
  return null;
}

function safeName(buffer, start, length) {
  if (!Number.isInteger(length) || length <= 0 || length > 16384 || start + length > buffer.length) return '';
  const value = buffer.toString('utf8', start, start + length).replace(/\\/g, '/');
  if (!value || value.includes('\0') || value.includes('\ufffd')) return '';
  return value.split('/').filter(Boolean).pop() || '';
}

function videoEntry(entries) {
  return entries.filter((entry) => {
    const ext = String(entry.name || '').split('.').pop().toLowerCase();
    return VIDEO_EXTENSIONS.has(ext) && !entry.directory && entry.stored && !entry.encrypted
      && !entry.incomplete && entry.fragments.length > 0
      && !/(?:^|[._ -])sample(?:[._ -]|$)/i.test(entry.name);
  }).sort((a, b) => b.size - a.size)[0] || null;
}

function addFragment(entries, openByName, parsed, fragment) {
  if (!parsed.name || parsed.directory) return;
  if (parsed.splitBefore) {
    const open = openByName.get(parsed.name);
    if (!open || open.stored !== parsed.stored || open.encrypted !== parsed.encrypted) return;
    open.fragments.push(fragment);
    open.size = open.fragments.reduce((sum, item) => sum + item.length, 0);
    open.incomplete = parsed.splitAfter;
    if (!parsed.splitAfter) openByName.delete(parsed.name);
    return;
  }
  if (entries.length >= MAX_ARCHIVE_ENTRIES) throw new Error('RAR contains too many entries');
  const entry = {
    name: parsed.name,
    size: fragment.length,
    stored: parsed.stored,
    encrypted: parsed.encrypted,
    directory: parsed.directory,
    incomplete: parsed.splitAfter,
    fragments: [fragment],
  };
  entries.push(entry);
  if (parsed.splitAfter) openByName.set(parsed.name, entry);
}

function parseRar5File(header, cursor, headerEnd, flags, dataSize, extraSize) {
  const read = () => {
    const found = readVint(header, cursor.value, headerEnd);
    if (!found) throw new Error('RAR5 file header is truncated');
    cursor.value += found.length;
    return found.value;
  };
  const fileFlags = read();
  const unpackedSize = read();
  read(); // attributes
  if (fileFlags & 0x02) cursor.value += 4;
  if (fileFlags & 0x04) cursor.value += 4;
  if (cursor.value > headerEnd) throw new Error('RAR5 file header is truncated');
  const compressionInfo = read();
  read(); // host OS
  const nameLength = read();
  const name = safeName(header, cursor.value, nameLength);
  cursor.value += nameLength;
  const extraStart = headerEnd - extraSize;
  let encrypted = false;
  if (extraSize) {
    if (extraStart < cursor.value) throw new Error('RAR5 extra area overlaps file fields');
    let at = extraStart;
    while (at < headerEnd) {
      const size = readVint(header, at, headerEnd);
      if (!size || size.value < 1) throw new Error('RAR5 extra record is invalid');
      const recordEnd = at + size.length + size.value;
      if (recordEnd > headerEnd) throw new Error('RAR5 extra record exceeds its header');
      const type = readVint(header, at + size.length, recordEnd);
      if (!type) throw new Error('RAR5 extra record type is missing');
      if (type.value === 1) encrypted = true;
      at = recordEnd;
    }
  }
  const method = (compressionInfo >> 7) & 0x07;
  return {
    name,
    declaredSize: unpackedSize,
    stored: method === 0,
    encrypted,
    directory: Boolean(fileFlags & 0x01),
    splitBefore: Boolean(flags & 0x08),
    splitAfter: Boolean(flags & 0x10),
    dataSize,
  };
}

async function parseRar5Volume(source, volumeIndex, entries, openByName) {
  const prefix = await source.readAt(0, Math.min(source.size, MAX_SFX_BYTES + RAR5_SIGNATURE.length));
  const signature = prefix.indexOf(RAR5_SIGNATURE);
  if (signature < 0 || signature > MAX_SFX_BYTES) throw new Error('RAR5 signature was not found');
  let offset = signature + RAR5_SIGNATURE.length;
  for (let blocks = 0; offset < source.size && blocks < MAX_BLOCKS_PER_VOLUME; blocks++) {
    let probe = await source.readAt(offset, Math.min(65536, source.size - offset));
    if (probe.length < 7) break;
    const headerSize = readVint(probe, 4, probe.length);
    if (!headerSize || headerSize.length > 3 || headerSize.value < 2 || headerSize.value > MAX_HEADER_BYTES) {
      throw new Error('RAR5 header size is invalid');
    }
    const totalHeader = 4 + headerSize.length + headerSize.value;
    if (totalHeader > probe.length) probe = await source.readAt(offset, totalHeader);
    if (probe.length < totalHeader) throw new Error('RAR5 header is truncated');
    const bodyStart = 4 + headerSize.length;
    const headerEnd = totalHeader;
    const typeField = readVint(probe, bodyStart, headerEnd);
    if (!typeField) throw new Error('RAR5 header type is missing');
    const cursor = { value: bodyStart + typeField.length };
    const flagField = readVint(probe, cursor.value, headerEnd);
    if (!flagField) throw new Error('RAR5 header flags are missing');
    cursor.value += flagField.length;
    const flags = flagField.value;
    let extraSize = 0;
    let dataSize = 0;
    if (flags & 0x01) {
      const found = readVint(probe, cursor.value, headerEnd);
      if (!found) throw new Error('RAR5 extra size is missing');
      cursor.value += found.length; extraSize = found.value;
    }
    if (flags & 0x02) {
      const found = readVint(probe, cursor.value, headerEnd);
      if (!found) throw new Error('RAR5 data size is missing');
      cursor.value += found.length; dataSize = found.value;
    }
    if (!Number.isSafeInteger(dataSize) || offset + totalHeader + dataSize > source.size) {
      throw new Error('RAR5 data area exceeds its volume');
    }
    if (typeField.value === 4) throw new Error('RAR5 encrypted headers are not supported');
    if (typeField.value === 2) {
      const parsed = parseRar5File(probe, cursor, headerEnd, flags, dataSize, extraSize);
      addFragment(entries, openByName, parsed, {
        volumeIndex, offset: offset + totalHeader, length: dataSize,
      });
    }
    const next = offset + totalHeader + dataSize;
    if (next <= offset) throw new Error('RAR5 block did not advance');
    offset = next;
    if (typeField.value === 5) break;
  }
}

async function parseRar4Volume(source, volumeIndex, entries, openByName) {
  const prefix = await source.readAt(0, Math.min(source.size, MAX_SFX_BYTES + RAR4_SIGNATURE.length));
  const signature = prefix.indexOf(RAR4_SIGNATURE);
  if (signature < 0 || signature > MAX_SFX_BYTES) throw new Error('RAR4 signature was not found');
  let offset = signature + RAR4_SIGNATURE.length;
  for (let blocks = 0; offset < source.size && blocks < MAX_BLOCKS_PER_VOLUME; blocks++) {
    let probe = await source.readAt(offset, Math.min(65536, source.size - offset));
    if (probe.length < 7) break;
    const type = probe[2];
    const flags = probe.readUInt16LE(3);
    const headerSize = probe.readUInt16LE(5);
    if (headerSize < 7 || headerSize > 65535) throw new Error('RAR4 header size is invalid');
    if (headerSize > probe.length) probe = await source.readAt(offset, headerSize);
    if (probe.length < headerSize) throw new Error('RAR4 header is truncated');
    let dataSize = flags & 0x8000 ? probe.readUInt32LE(7) : 0;
    if (type === 0x74 && flags & 0x0100) {
      if (headerSize < 40) throw new Error('RAR4 large-file header is truncated');
      dataSize += probe.readUInt32LE(32) * (2 ** 32);
    }
    if (!Number.isSafeInteger(dataSize) || offset + headerSize + dataSize > source.size) {
      throw new Error('RAR4 data area exceeds its volume');
    }
    if (type === 0x73 && flags & 0x0080) throw new Error('RAR4 encrypted headers are not supported');
    if (type === 0x74) {
      if (headerSize < 32) throw new Error('RAR4 file header is truncated');
      const nameLength = probe.readUInt16LE(26);
      const nameStart = flags & 0x0100 ? 40 : 32;
      const parsed = {
        name: safeName(probe, nameStart, nameLength),
        stored: probe[25] === 0x30,
        encrypted: Boolean(flags & 0x0004),
        directory: (flags & 0x00e0) === 0x00e0,
        splitBefore: Boolean(flags & 0x0001),
        splitAfter: Boolean(flags & 0x0002),
      };
      addFragment(entries, openByName, parsed, {
        volumeIndex, offset: offset + headerSize, length: dataSize,
      });
    }
    const next = offset + headerSize + dataSize;
    if (next <= offset) throw new Error('RAR4 block did not advance');
    offset = next;
    if (type === 0x7b) break;
  }
}

async function inspectRar(sources) {
  if (!Array.isArray(sources) || !sources.length || sources.length > MAX_ARCHIVE_VOLUMES) {
    throw new Error('RAR volume count is invalid');
  }
  const entries = [];
  const openByName = new Map();
  for (let volumeIndex = 0; volumeIndex < sources.length; volumeIndex++) {
    const source = sources[volumeIndex];
    const signature = await source.readAt(0, Math.min(source.size, MAX_SFX_BYTES + 8));
    if (signature.indexOf(RAR5_SIGNATURE) >= 0) {
      await parseRar5Volume(source, volumeIndex, entries, openByName);
    } else if (signature.indexOf(RAR4_SIGNATURE) >= 0) {
      await parseRar4Volume(source, volumeIndex, entries, openByName);
    } else throw new Error('Unsupported or damaged RAR volume');
  }
  for (const entry of openByName.values()) entry.incomplete = true;
  return { entries, selected: videoEntry(entries) };
}

module.exports = {
  MAX_ARCHIVE_VOLUMES, MAX_ARCHIVE_ENTRIES, MAX_BLOCKS_PER_VOLUME, MAX_HEADER_BYTES,
  rarVolumeIdentity, groupRarVolumes, readVint, inspectRar,
};
