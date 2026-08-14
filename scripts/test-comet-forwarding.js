const assert = require('assert');
const http = require('http');

async function main() {
  let streamPath = '';
  const config = Buffer.from(JSON.stringify({
    seriousSportsSyncManifestUrl: 'https://sports.example/u/user/token/manifest.json',
    debridService: 'torbox',
  })).toString('base64');
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/manifest.json')) {
      res.end(JSON.stringify({ id: 'comet', name: 'Comet Test', resources: [{ name: 'stream', types: ['movie'] }] }));
      return;
    }
    if (req.url.includes('/stream/movie/')) {
      streamPath = req.url;
      res.end(JSON.stringify({ streams: [{ name: 'Comet', title: 'NBA fixture', url: 'https://play.example/video' }] }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  process.env.COMET_ALLOWED_HOSTS = '127.0.0.1:' + address.port;
  const comet = require('../lib/sources/comet');
  const manifestUrl = 'http://127.0.0.1:' + address.port + '/' + encodeURIComponent(config) + '/manifest.json';

  try {
    const parsed = comet.parseManifestUrl(manifestUrl);
    assert(parsed, 'allowlisted Comet URL should parse');
    assert.strictEqual(comet.buildStreamUrl(parsed, 'movie', 'nba:2371750'), parsed.streamBase + 'stream/movie/nba%3A2371750.json');
    assert.strictEqual(comet.decodeConfiguredManifest(manifestUrl).seriousSportsSyncManifestUrl, 'https://sports.example/u/user/token/manifest.json');

    const connection = await comet.testManifest(manifestUrl, {
      expectedSssManifestUrl: 'https://sports.example/u/user/token/manifest.json',
    });
    assert.strictEqual(connection.ok, true);
    assert.strictEqual(connection.supportsSss, true);
    assert.strictEqual(connection.matchesSss, true);

    const dockerConnection = await comet.testManifest(manifestUrl, {
      expectedSssManifestUrl: 'http://serioussportsync-test:7000/u/user/token/manifest.json',
    });
    assert.strictEqual(dockerConnection.matchesSss, true);

    const rows = await comet.getStreams('movie', 'nba:2371750', parsed);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].url, 'https://play.example/video');
    assert(streamPath.includes('nba%3A2371750.json'));

    process.env.COMET_ALLOWED_HOSTS = '';
    assert.strictEqual(comet.parseManifestUrl(manifestUrl), null, 'private HTTP must require an allowlist');
    console.log('Comet forwarding tests passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
