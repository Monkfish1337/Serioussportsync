'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NntpConnectionPool } = require('../lib/sources/nntp-pool');

test('bounds concurrent NNTP work and reuses authenticated sessions', async () => {
  let connections = 0;
  let active = 0;
  let peak = 0;
  const pool = new NntpConnectionPool({ maxConnections: 2 }, {
    connect: async () => {
      connections++;
      const socket = { destroyed: false };
      return {
        socket,
        destroy() { socket.destroyed = true; },
      };
    },
  });
  try {
    const values = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      pool.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return index;
      })));
    assert.deepEqual(values, [0, 1, 2, 3, 4, 5]);
    assert.equal(peak, 2);
    assert.equal(connections, 2);
  } finally { pool.close(); }
});

test('pre-authenticates idle sessions up to the configured ceiling', async () => {
  let connections = 0;
  const pool = new NntpConnectionPool({ maxConnections: 4 }, {
    connect: async () => {
      connections++;
      const socket = { destroyed: false };
      return { socket, destroy() { socket.destroyed = true; } };
    },
  });
  try {
    assert.equal(await pool.warm(), 4);
    assert.equal(connections, 4);
    assert.equal(pool.idle.length, 4);
    assert.equal(await pool.warm(), 0);
    assert.equal(connections, 4);
  } finally { pool.close(); }
});
