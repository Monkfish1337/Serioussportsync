'use strict';

// Small runtime contract shared by every playback backend. Providers own the
// mechanics of preparing rows and resolving a selected item; streams.js owns
// event lookup, promotion matching, deadlines, and final cross-provider merge.

const CAPABILITIES = Object.freeze({
  DISCOVERY: 'discovery',
  DEFERRED_PLAYBACK: 'deferred-playback',
  DIRECT_PLAYBACK: 'direct-playback',
  NATIVE_NNTP: 'native-nntp',
  HEALTH: 'health',
});

const HEALTH_STATES = Object.freeze({
  OK: 'ok',
  DEGRADED: 'degraded',
  DOWN: 'down',
  UNKNOWN: 'unknown',
  NOT_CONFIGURED: 'not-configured',
});

class PlaybackProviderError extends Error {
  constructor(code, message, options) {
    const opts = options || {};
    super(message || code || 'playback provider failed');
    this.name = 'PlaybackProviderError';
    this.code = String(code || 'provider-failed');
    this.provider = opts.provider || null;
    this.retryable = opts.retryable === true;
    this.httpStatus = Number(opts.httpStatus) || 502;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

function unsupported(provider, operation) {
  return new PlaybackProviderError('unsupported-operation',
    provider + ' does not support ' + operation, {
      provider,
      retryable: false,
      httpStatus: 400,
    });
}

function createPlaybackProvider(definition) {
  const def = definition || {};
  const id = String(def.id || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(id)) {
    throw new TypeError('playback provider id must match [a-z0-9][a-z0-9-]{1,31}');
  }
  if (typeof def.prepare !== 'function') {
    throw new TypeError('playback provider ' + id + ' requires prepare(context)');
  }

  const capabilities = Object.freeze(Array.from(new Set(
    (def.capabilities || []).map((v) => String(v || '').trim()).filter(Boolean)
  )));

  const provider = {
    id,
    label: String(def.label || id),
    pipelineKey: String(def.pipelineKey || id),
    priority: Number.isFinite(def.priority) ? def.priority : 100,
    capabilities,
    supports(capability) { return capabilities.includes(capability); },
    isConfigured: typeof def.isConfigured === 'function'
      ? def.isConfigured
      : () => true,
    prepare: def.prepare,
    resolve: typeof def.resolve === 'function'
      ? def.resolve
      : async () => { throw unsupported(id, 'resolve'); },
    testConnection: typeof def.testConnection === 'function'
      ? def.testConnection
      : async () => ({ ok: false, status: HEALTH_STATES.UNKNOWN, error: 'not-implemented' }),
    health: typeof def.health === 'function'
      ? def.health
      : async (context) => ({
        status: provider.isConfigured(context)
          ? HEALTH_STATES.UNKNOWN
          : HEALTH_STATES.NOT_CONFIGURED,
      }),
  };

  return Object.freeze(provider);
}

function normalizeProviderError(error, provider) {
  if (error instanceof PlaybackProviderError) return error;
  return new PlaybackProviderError('provider-failed',
    error && error.message ? error.message : String(error || 'provider failed'), {
      provider: provider || null,
      retryable: true,
      cause: error,
    });
}

module.exports = {
  CAPABILITIES,
  HEALTH_STATES,
  PlaybackProviderError,
  createPlaybackProvider,
  normalizeProviderError,
};
