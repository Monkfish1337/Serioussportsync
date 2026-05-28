// HTTP/HTTPS proxy agent singleton, driven by env vars.
//
// If HTTPS_PROXY / HTTP_PROXY is set (typical: http://gluetun:8888), every
// outbound fetch in the addon (Prowlarr, Zilean, debrid APIs) routes through
// it — EXCEPT for hosts in NO_PROXY, which go direct. This is important when
// Prowlarr itself lives behind the proxy host (e.g. PROWLARR_URL points at
// gluetun:9696 and we don't want to proxy that call through gluetun:8888,
// which would cause gluetun to refuse with 503).
//
// NO_PROXY format: comma-separated host names. Matching is case-insensitive
// and supports leading "." for suffix match (".internal" matches a.internal).

const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy
           || process.env.HTTP_PROXY  || process.env.http_proxy
           || '';

const NO_PROXY_RAW = process.env.NO_PROXY || process.env.no_proxy || '';
const NO_PROXY_LIST = NO_PROXY_RAW
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

let agent = null;
if (PROXY) {
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    agent = new HttpsProxyAgent(PROXY);
    console.log('[http-agent] outbound HTTP routed via proxy: ' + PROXY
      + (NO_PROXY_LIST.length ? ' (bypass: ' + NO_PROXY_LIST.join(',') + ')' : ''));
  } catch (err) {
    console.warn('[http-agent] HTTPS_PROXY=' + PROXY + ' but https-proxy-agent failed to load: ' + err.message);
  }
}

// True if `url`'s hostname matches an entry in NO_PROXY. Plain hostname
// equality plus dot-suffix (".example.com" matches any sub of example.com).
function shouldBypass(url) {
  if (!agent || NO_PROXY_LIST.length === 0) return !agent;
  let host;
  try { host = new URL(url).hostname.toLowerCase(); }
  catch (_) { return false; }
  for (const entry of NO_PROXY_LIST) {
    if (entry === '*') return true;
    if (entry.startsWith('.')) {
      if (host === entry.slice(1) || host.endsWith(entry)) return true;
    } else {
      if (host === entry) return true;
    }
  }
  return false;
}

function getAgent() { return agent; }

// Call as fetchOpts(extraOptions, targetUrl). The targetUrl is required when
// NO_PROXY is set — without it we can't tell whether to attach the agent.
// For backwards compat we still allow fetchOpts(extra) which always attaches.
function fetchOpts(extra, targetUrl) {
  const o = Object.assign({}, extra || {});
  if (!agent) return o;
  if (targetUrl && shouldBypass(targetUrl)) return o;
  o.agent = agent;
  return o;
}

module.exports = { getAgent, fetchOpts, shouldBypass, proxyUrl: PROXY, noProxy: NO_PROXY_LIST };
