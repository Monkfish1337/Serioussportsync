'use strict';

async function readBuffer(response, maxBytes, label) {
  const limit = Math.max(1, Number(maxBytes) || 1024 * 1024);
  const name = label || 'Response';
  const declared = Number(response && response.headers && response.headers.get
    ? response.headers.get('content-length') : 0) || 0;
  if (declared > limit) throw new Error(name + ' exceeded its size limit');

  if (response && response.body && response.body[Symbol.asyncIterator]) {
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > limit) {
        if (response.body.destroy) response.body.destroy();
        throw new Error(name + ' exceeded its size limit');
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }

  let buffer;
  if (response && typeof response.buffer === 'function') buffer = await response.buffer();
  else if (response && typeof response.text === 'function') buffer = Buffer.from(await response.text());
  else buffer = Buffer.alloc(0);
  if (buffer.length > limit) throw new Error(name + ' exceeded its size limit');
  return buffer;
}

async function readText(response, maxBytes, label) {
  return (await readBuffer(response, maxBytes, label)).toString('utf8');
}

async function readJson(response, maxBytes, label) {
  return JSON.parse(await readText(response, maxBytes, label));
}

module.exports = { readBuffer, readJson, readText };
