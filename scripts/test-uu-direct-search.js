const assert = require('assert');
const http = require('http');
const uu = require('../lib/sources/usenet-ultimate');

async function main() {
  let receivedBody = null;
  const server = http.createServer((req, res) => {
    assert.strictEqual(req.method, 'POST');
    assert.strictEqual(req.url, '/stremio/test-key/search');
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      receivedBody = JSON.parse(body);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        version: 1,
        results: [{
          title: 'UFC.Fight.Night.284.1080p.WEB-DL',
          link: 'https://indexer.example/download/123.nzb',
          size: 123456789,
          pubDate: '2026-08-14T12:00:00.000Z',
          indexerName: 'Test Indexer',
          attributes: { grabs: '4' },
        }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const config = { base: `http://127.0.0.1:${address.port}`, configHash: 'test-key' };
    const output = await uu.search(['UFC Fight Night 284', 'UFC Fight Night 284'], config);
    assert.strictEqual(output.ok, true);
    assert.deepStrictEqual(receivedBody, { queries: ['UFC Fight Night 284'] });
    assert.strictEqual(output.results.length, 1);
    assert.strictEqual(output.results[0].indexer, 'Test Indexer');

    const rows = uu.buildStreamRows(output.results, config, 'UFC Fight Night 284');
    assert.strictEqual(rows.length, 1);
    assert.match(rows[0].url, /\/stremio\/test-key\/nzbdav\/stream\//);
    assert.match(rows[0].title, /Test Indexer/);
    console.log('UU direct-search contract: OK');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
