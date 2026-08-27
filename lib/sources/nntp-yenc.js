'use strict';

function numberField(line, name) {
  const match = new RegExp('(?:^|\\s)' + name + '=(\\d+)(?:\\s|$)', 'i').exec(line);
  return match ? Number(match[1]) : 0;
}

function decodeArticle(article) {
  const lines = [];
  let offset = 0;
  while (offset <= article.length) {
    let end = article.indexOf('\r\n', offset);
    if (end < 0) end = article.length;
    lines.push(article.subarray(offset, end));
    if (end === article.length) break;
    offset = end + 2;
  }
  const beginIndex = lines.findIndex((line) => line.subarray(0, 7).toString('ascii') === '=ybegin');
  if (beginIndex < 0) throw new Error('Article has no yEnc header');
  const beginLine = lines[beginIndex].toString('utf8');
  const partLineIndex = lines.findIndex((line, index) =>
    index > beginIndex && line.subarray(0, 6).toString('ascii') === '=ypart');
  const endIndex = lines.findIndex((line, index) =>
    index > beginIndex && line.subarray(0, 5).toString('ascii') === '=yend');
  if (endIndex < 0) throw new Error('Article has no yEnc trailer');
  const dataStart = partLineIndex >= 0 ? partLineIndex + 1 : beginIndex + 1;
  const partLine = partLineIndex >= 0 ? lines[partLineIndex].toString('ascii') : '';
  const chunks = [];
  let decodedBytes = 0;
  for (let lineIndex = dataStart; lineIndex < endIndex; lineIndex++) {
    const encoded = lines[lineIndex];
    const decoded = Buffer.allocUnsafe(encoded.length);
    let written = 0;
    for (let i = 0; i < encoded.length; i++) {
      let value = encoded[i];
      if (value === 0x3d) {
        if (++i >= encoded.length) throw new Error('Article has truncated yEnc escape');
        value = (encoded[i] - 64) & 0xff;
      }
      decoded[written++] = (value - 42) & 0xff;
    }
    chunks.push(decoded.subarray(0, written));
    decodedBytes += written;
  }
  const trailer = lines[endIndex].toString('ascii');
  const declaredPartSize = numberField(trailer, 'size');
  if (declaredPartSize && declaredPartSize !== decodedBytes) throw new Error('yEnc decoded size mismatch');
  const begin = partLine ? numberField(partLine, 'begin') : 1;
  const end = partLine ? numberField(partLine, 'end') : decodedBytes;
  if (!begin || !end || end < begin || end - begin + 1 !== decodedBytes) {
    throw new Error('yEnc part boundaries are invalid');
  }
  const nameMatch = /(?:^|\s)name=(.*)$/i.exec(beginLine);
  return {
    data: Buffer.concat(chunks, decodedBytes),
    begin: begin - 1,
    endExclusive: end,
    totalSize: numberField(beginLine, 'size') || decodedBytes,
    filename: nameMatch ? nameMatch[1].trim() : '',
  };
}

module.exports = { decodeArticle };
