'use strict';

// Assertions against the deployment files themselves.
//
// The container hardening — read-only root, dropped capabilities, no privilege
// escalation, non-root user, loopback-only default binding — is the strongest
// part of this deployment and the easiest thing to delete by accident while
// editing something adjacent. There is no staging environment to catch that,
// so the invariants are asserted here as text. Borrowed from Comet's
// tests/test_deployment_contract.py, which does the same thing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

const dockerfile = read('Dockerfile');
const compose = read('docker-compose.yml');
const ci = read('.github/workflows/ci.yml');
const container = read('.github/workflows/container.yml');

test('the container runs unprivileged and read-only', () => {
  for (const invariant of ['read_only: true', 'cap_drop', 'no-new-privileges:true']) {
    assert.ok(compose.includes(invariant), 'docker-compose.yml lost: ' + invariant);
  }
  assert.match(compose, /cap_drop:\s*\n\s*-\s*ALL/, 'cap_drop must drop ALL, not a subset');
  // A read-only root filesystem needs somewhere to write scratch files.
  assert.match(compose, /tmpfs:/);
  assert.match(dockerfile, /^USER app$/m, 'Dockerfile must drop to a non-root user');
  assert.match(dockerfile, /adduser -S app/, 'the app user must be a system user');
});

test('the service is not exposed beyond the host by default', () => {
  // The published port must default to loopback. Anything else puts an
  // unauthenticated /health and a login form on the LAN.
  assert.match(compose, /SSS_BIND_ADDRESS:-127\.0\.0\.1/,
    'the default bind address must be loopback');
});

test('resource use is bounded', () => {
  assert.match(compose, /mem_limit:/, 'a memory ceiling must be set');
  assert.match(compose, /cpus:/, 'a CPU limit must be set');
  assert.match(compose, /max-size:/, 'container logs must be size-capped');
  assert.match(compose, /max-file:/, 'container log rotation must be bounded');
});

test('no secret is committed with a usable default', () => {
  // The compose file must refuse to start without a secret rather than
  // substituting one.
  assert.match(compose, /SESSION_SECRET:\s*"\$\{SESSION_SECRET:\?/,
    'SESSION_SECRET must use the ${VAR:?message} form so compose fails closed');
  for (const [name, text] of [['docker-compose.yml', compose], ['Dockerfile', dockerfile]]) {
    assert.doesNotMatch(text, /SESSION_SECRET\s*[:=]\s*["']?[A-Za-z0-9]{20,}/,
      name + ' appears to contain a hardcoded secret');
  }
});

test('the image reports its own health', () => {
  assert.match(dockerfile, /HEALTHCHECK/, 'the image must declare a healthcheck');
  assert.match(dockerfile, /\/health/, 'the healthcheck must probe the health endpoint');
  assert.match(dockerfile, /ENTRYPOINT \["\/sbin\/tini"/, 'tini must be PID 1 to reap and forward signals');
});

test('a build only publishes after its own verification passes', () => {
  // ci.yml and container.yml are independent workflows, so container.yml has
  // to verify for itself. Commit 44bc161 published an image from a commit
  // whose test suite was failing because this did not hold.
  const verify = container.indexOf('npm run test:unit');
  const build = container.search(/docker\/build-push-action/);
  assert.ok(verify !== -1, 'container.yml must run the unit suite before building');
  assert.ok(build !== -1, 'container.yml must contain a build step');
  assert.ok(verify < build, 'verification must precede the build and push');
});

test('CI runs the full suite, not a subset', () => {
  for (const script of ['test:unit', 'test:nuvio', 'test:account']) {
    assert.ok(ci.includes('npm run ' + script), 'ci.yml stopped running ' + script);
  }
  assert.match(ci, /npm audit --omit=dev/, 'ci.yml must audit production dependencies');
  assert.match(ci, /node --check/, 'ci.yml must syntax-check committed JavaScript');
});

test('every test file is reachable by the test script', () => {
  // `node --test test/*.test.js` only picks up files matching that suffix, so a
  // file named otherwise is silently never run.
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts['test:unit'], /test\/\*\.test\.js/);
  const stray = fs.readdirSync(path.join(root, 'test'))
    .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'));
  assert.deepEqual(stray, [], 'test files not matching *.test.js would never run: ' + stray.join(', '));
});
