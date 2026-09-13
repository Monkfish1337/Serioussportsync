'use strict';
const test = require('node:test');
const {execFileSync} = require('node:child_process');
const path = require('node:path');

for (const script of ['test-prowlarr-deadline.js', 'diagnose-discovery-cache.js']) {
  test(script, () => {
    execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', script)], {
      cwd: path.join(__dirname, '..'), timeout: 15000, stdio: 'pipe',
    });
  });
}
