'use strict';

const crypto = require('crypto');
const nntpClient = require('./nntp-client');

const IDLE_MS = 60000;

class NntpConnectionPool {
  constructor(config, options) {
    this.config = config;
    this.options = options || {};
    this.maxConnections = Math.min(50, Math.max(1, Number(config.maxConnections) || 8));
    this.total = 0;
    this.idle = [];
    this.waiting = [];
    this.closed = false;
  }

  setLimit(value) {
    this.maxConnections = Math.min(50, Math.max(1, Number(value) || 8));
    while (this.total > this.maxConnections && this.idle.length) {
      this.discard(this.idle.pop());
    }
    this.pump();
  }

  acquire() {
    if (this.closed) return Promise.reject(new Error('NNTP connection pool is closed'));
    while (this.idle.length) {
      const session = this.idle.pop();
      clearTimeout(session._sssIdleTimer);
      if (!session.socket.destroyed) return Promise.resolve(session);
      this.total--;
    }
    if (this.total < this.maxConnections) return this.create();
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  async create() {
    this.total++;
    try {
      return await (this.options.connect || nntpClient.connectAuthenticated)(
        this.config, this.options);
    } catch (error) {
      this.total--;
      this.pump();
      throw error;
    }
  }

  release(session) {
    if (!session || session.socket.destroyed || this.closed || this.total > this.maxConnections) {
      this.discard(session);
      return;
    }
    const waiter = this.waiting.shift();
    if (waiter) { waiter.resolve(session); return; }
    session._sssIdleTimer = setTimeout(() => {
      const index = this.idle.indexOf(session);
      if (index >= 0) {
        this.idle.splice(index, 1);
        this.discard(session);
      }
    }, IDLE_MS);
    if (session._sssIdleTimer.unref) session._sssIdleTimer.unref();
    this.idle.push(session);
  }

  discard(session) {
    if (session && !session.socket.destroyed) session.destroy();
    if (session) this.total = Math.max(0, this.total - 1);
    this.pump();
  }

  pump() {
    while (!this.closed && this.waiting.length && this.total < this.maxConnections) {
      const waiter = this.waiting.shift();
      this.create().then(waiter.resolve, waiter.reject);
    }
  }

  async run(task) {
    const session = await this.acquire();
    try {
      const result = await task(session);
      this.release(session);
      return result;
    } catch (error) {
      this.discard(session);
      throw error;
    }
  }

  close() {
    this.closed = true;
    for (const session of this.idle.splice(0)) this.discard(session);
    while (this.waiting.length) this.waiting.shift().reject(new Error('NNTP connection pool is closed'));
  }
}

const registry = new Map();

function poolKey(config) {
  return crypto.createHash('sha256').update(JSON.stringify([
    config.host, config.port, config.tls, config.username, config.password,
  ])).digest('hex');
}

function getPool(config) {
  const key = poolKey(config);
  let pool = registry.get(key);
  if (!pool) {
    pool = new NntpConnectionPool(config);
    registry.set(key, pool);
  }
  pool.setLimit(config.maxConnections);
  return pool;
}

module.exports = { NntpConnectionPool, getPool, poolKey, IDLE_MS, _registry: registry };
