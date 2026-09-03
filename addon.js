const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { buildManifest } = require('./lib/manifest');
const { handleCatalog } = require('./lib/catalog');
const { handleMeta } = require('./lib/meta');
const { handleStream, resolvePlay, warmTorbox } = require('./lib/streams');

function setFreshStreamHeaders(res) {
  res.setHeader('ETag', '"sss-stream-' + Date.now().toString(36) + '-'
    + crypto.randomBytes(4).toString('hex') + '"');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}
const store = require('./lib/store');
const settings = require('./lib/settings');
const { runRefresh: runEventsRefresh } = require('./scripts/refresh');
const promotions = require('./lib/promotions');
const users = require('./lib/users');
const sessions = require('./lib/sessions');
const { proxyWebdav } = require('./lib/webdav-proxy');
const nzbdavClient = require('./lib/sources/nzbdav');
const nzbdavWebdav = require('./lib/sources/nzbdav-webdav');
const usenetIndexer = require('./lib/sources/usenet-indexer');
const nntpClient = require('./lib/sources/nntp-client');
const nntpPlayback = require('./lib/sources/nntp-playback');
const availabilityStore = require('./lib/availability-index');
const availabilityWarmer = require('./lib/availability-warmer');
const availabilityScheduler = require('./lib/availability-scheduler');
const adminDatabase = require('./lib/admin-database');
const adminLogs = require('./lib/admin-logs');
const adminSportVideo = require('./lib/admin-sport-video');
const sportVideo = require('./lib/sources/sport-video');
const matchDiagnostics = require('./lib/match-diagnostics');
const torboxResolver = require('./lib/sources/torbox-resolver');
// 0.27.0: in-memory log buffer for /admin/logs.
const logBuffer = require('./lib/log-buffer');
const security = require('./lib/security');
// 0.37.0: Tabler-based page chrome (sidebar + topbar + container layout).
// Used by all post-0.37.0 page renders; the legacy accountPage() wrapper
// below remains for any unconverted pages and is removed once all renders
// use tablerChrome.tablerPage().
const tablerChrome = require('./lib/tabler-chrome');
const { cleanOrder, orderByIds } = require('./lib/catalog-order');
const { effectiveCatalogSelection, CURRENT_DEFAULTS_VERSION } = require('./lib/catalog-selection');
const { buildNuvioCollections } = require('./lib/nuvio-collections');
const APP_VERSION = require('./package.json').version || '?';


// Compute the public origin (scheme://host) for an incoming request. Honors
// X-Forwarded-Proto/Host (set by cloudflared, nginx, etc.) so that links we
// generate in HTML reflect the user's actual entry URL, not the internal
// container address. Falls back to req.protocol/host, then to PUBLIC_URL env.
function publicOriginFromReq(req) {
  return security.publicOrigin(req);
}

// Login rate-limiter (0.22.2). In-memory per-client-IP counter of failed login
// attempts. Locks out an IP after LOGIN_MAX_FAILS within LOGIN_WINDOW_MS, for
// LOGIN_LOCKOUT_MS. State resets on server restart — acceptable for a self-
// hosted, low-traffic deployment. Successful login clears the counter for that
// IP. Pruning happens lazily on each check so the map can't grow unbounded.
const LOGIN_MAX_FAILS = parseInt(process.env.LOGIN_MAX_FAILS || '5', 10);
const LOGIN_WINDOW_MS = parseInt(process.env.LOGIN_WINDOW_MS || (15 * 60 * 1000), 10);
const LOGIN_LOCKOUT_MS = parseInt(process.env.LOGIN_LOCKOUT_MS || (15 * 60 * 1000), 10);
const loginFails = new Map(); // ip -> { fails, firstFailAt, lockUntil }

function clientIp(req) {
  // Forwarded addresses are attacker-controlled unless the deployment has
  // explicitly declared its reverse proxy trusted.
  if (config.trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf).trim();
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function loginLockedOut(ip) {
  const e = loginFails.get(ip);
  if (!e) return 0;
  if (e.lockUntil && e.lockUntil > Date.now()) {
    return Math.ceil((e.lockUntil - Date.now()) / 1000);
  }
  return 0;
}

function recordLoginFail(ip) {
  const now = Date.now();
  let e = loginFails.get(ip);
  if (!e || now - e.firstFailAt > LOGIN_WINDOW_MS) {
    e = { fails: 0, firstFailAt: now, lockUntil: 0 };
  }
  e.fails += 1;
  if (e.fails >= LOGIN_MAX_FAILS) {
    e.lockUntil = now + LOGIN_LOCKOUT_MS;
  }
  loginFails.set(ip, e);
  // Lazy prune — drop entries whose window AND lockout have both expired.
  if (loginFails.size > 1000) {
    for (const [k, v] of loginFails) {
      if (now - v.firstFailAt > LOGIN_WINDOW_MS && (!v.lockUntil || v.lockUntil < now)) {
        loginFails.delete(k);
      }
    }
  }
}

function clearLoginFails(ip) { loginFails.delete(ip); }

function createApp() {
  security.assertRuntimeConfig();
  const app = express();
  app.disable('x-powered-by');
  app.use(security.headers);

  app.use(express.urlencoded({ extended: false, limit: '256kb', parameterLimit: 500 }));

  // Attach req.user from session cookie if present.
  function loadSession(req, res, next) {
    const sess = sessions.readSession(req);
    if (sess && sess.userId) {
      const u = users.findById(sess.userId);
      if (u && Number(u.sessionVersion || 1) === Number(sess.sessionVersion || 1)) {
        req.user = u;
        users.touchLastSeen(u.id);
      }
    }
    next();
  }
  app.use(loadSession);
  app.use(security.csrf);

  function requireLogin(req, res, next) {
    if (!req.user) return res.redirect('/login');
    next();
  }

  // Admin-only middleware. Anonymous -> /login, non-admin -> 403.
  function requireAdmin(req, res, next) {
    if (!req.user) return res.redirect('/login');
    if (req.user.role !== 'admin') {
      return res.status(403).send(authPage('Forbidden',
        '<p style="color:var(--accent);margin:0 0 12px;">Admin only.</p>'
        + '<p><a href="/account">Back to your account</a></p>'));
    }
    next();
  }

  // CORS is needed only for addon API resources consumed by clients. Admin,
  // account, setup, login, health, and invite responses remain same-origin.
  app.use(security.cors);

  // Branded artwork (UFC/WWE upcoming logo cards, etc). Public, no auth.
  app.use('/assets', express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));

  // Default caching for addon payloads.
  //
  // These URLs live under /u/:userId/:apiToken/, so the path itself is a
  // credential. `public` invited any shared proxy between SSS and the client to
  // store one account's catalog and hand it to another viewer; `private` keeps
  // the browser or client cache while forbidding shared ones. Express still
  // emits an ETag and answers conditional requests with a 304, so repeat views
  // stay cheap.
  function send(res, payload, opts) {
    const o = opts || {};
    res.setHeader('Cache-Control', o.cacheControl || 'private, max-age=3600, stale-if-error=600');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(JSON.stringify(payload));
  }

  // --- Public: health -------------------------------------------------
  app.get('/health', (req, res) => {
    const events = store.getEvents();
    const meta = store.loadFromDisk() || {};
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(JSON.stringify({
      ok: true,
      version: APP_VERSION,
      events: events.length,
      updatedAt: meta.updatedAt || null,
    }));
  });

  // --- Phase 2: setup / login / logout / account (must come BEFORE
  //     the wildcard /:token mount). --------------------------------
  app.get('/setup', (req, res) => {
    if (users.userCount() > 0) return res.status(410).send('Setup already complete.');
    const prefill = (config.admin && config.admin.user) || '';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(authPage('Initial setup',
      '<p style="margin:0 0 16px;color:var(--muted);font-size:13px;">'
      + 'No users exist yet. Create your admin account. The username '
      + 'will be auto-promoted to <code>admin</code> if it matches the '
      + '<code>ADMIN_USER</code> env var (currently <code>'
      + escapeHtml(prefill || '(unset)') + '</code>).</p>'
      + '<form method="POST" action="/setup">'
      + '<label class="form-label">Username</label>'
      + '<input class="form-control" name="username" value="' + escapeHtml(prefill) + '" required minlength="3" maxlength="32" autofocus>'
      + '<label class="form-label">Password</label>'
      + '<input class="form-control" name="password" type="password" required minlength="8">'
      + '<button class="btn btn-primary w-100 mt-3" type="submit">Create admin account</button>'
      + '</form>'
    ));
  });

  app.post('/setup', async (req, res) => {
    if (users.userCount() > 0) return res.status(410).send('Setup already complete.');
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    try {
      const u = await users.createUser({ username, password, role: 'admin' });
      sessions.setCookie(res, u, req);
      res.redirect('/account');
    } catch (err) {
      res.status(400).send(authPage('Setup failed',
        '<p>' + escapeHtml(err.message) + '</p><p><a href="/setup">Try again</a></p>'));
    }
  });

  app.get('/login', (req, res) => {
    if (req.user) return res.redirect('/account');
    if (users.userCount() === 0) return res.redirect('/setup');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(authPage('Sign in',
      '<form method="POST" action="/login">'
      + '<label class="form-label">Username</label>'
      + '<input class="form-control" name="username" required autofocus>'
      + '<label class="form-label">Password</label>'
      + '<input class="form-control" name="password" type="password" required>'
      + '<button class="btn btn-primary w-100 mt-3" type="submit">Sign in</button>'
      + '</form>'
    ));
  });

  app.post('/login', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const ip = clientIp(req);

    // Rate-limit check (0.22.2). If this IP is locked out, refuse without
    // touching bcrypt — keeps the brute-force window cheap on the server.
    const lockedFor = loginLockedOut(ip);
    if (lockedFor > 0) {
      const mins = Math.ceil(lockedFor / 60);
      res.setHeader('Retry-After', String(lockedFor));
      return res.status(429).send(authPage('Sign in',
        '<p style="color:var(--accent);margin:0 0 12px;">Too many failed sign-in attempts. '
        + 'Try again in about ' + mins + ' minute' + (mins === 1 ? '' : 's') + '.</p>'
      ));
    }

    const u = users.findByUsername(username);
    // Always run bcrypt — verifyDummy for unknown users — so response time
    // doesn't reveal whether the username exists.
    const ok = u
      ? await users.verifyPassword(password, u.passwordHash)
      : (await users.verifyDummy(password), false);
    if (!ok) {
      recordLoginFail(ip);
      await new Promise((r) => setTimeout(r, 250 + Math.floor(Math.random() * 250)));
      return res.status(401).send(authPage('Sign in',
        '<p style="color:var(--accent);margin:0 0 12px;">Invalid username or password.</p>'
        + '<form method="POST" action="/login">'
        + '<label class="form-label">Username</label>'
        + '<input class="form-control" name="username" value="' + escapeHtml(username) + '" required>'
        + '<label class="form-label">Password</label>'
        + '<input class="form-control" name="password" type="password" required autofocus>'
        + '<button class="btn btn-primary w-100 mt-3" type="submit">Sign in</button>'
        + '</form>'
      ));
    }
    clearLoginFails(ip);
    sessions.setCookie(res, u, req);
    users.touchLastSeen(u.id);
    res.redirect('/account');
  });

  app.post('/logout', (req, res) => { sessions.clearCookie(res, req); res.redirect('/login'); });

  app.get('/account', requireLogin, (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(renderAccountPage(req.user, { flash: req.query.flash || null, origin: publicOriginFromReq(req) }));
  });

  app.get('/account/nuvio-collections.json', requireLogin, (req, res) => {
    const payload = buildNuvioCollections({
      user: req.user,
      origin: publicOriginFromReq(req),
    });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="serioussportsync-nuvio-collections.json"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(payload, null, 2));
  });

  app.post('/account/save', requireLogin, (req, res) => {
    const b = req.body || {};
    // Collect selected catalogs (empty = all). Stremio sends repeated form
    // fields with the same name; express.urlencoded returns string or array.
    const cats = Array.isArray(b.catalogs) ? b.catalogs : (b.catalogs ? [b.catalogs] : []);
    const allCatalogIds = new Set();
    const allPromotionIds = new Set();
    for (const p of promotions.enabled) {
      allPromotionIds.add(p.id);
      for (const c of p.catalogs) allCatalogIds.add(c.id);
    }
    const cleanCats = cats.filter((c) => allCatalogIds.has(c));
    // Storage convention: if user picked everything, store [] which downstream
    // interprets as "all enabled catalogs" — keeps the file small + lets new
    // catalogs auto-enable without the user re-saving.
    const finalCats = (cleanCats.length === allCatalogIds.size) ? [] : cleanCats;
    // maxStreams: 0 = unlimited, 1-20 cap. Anything else is rejected silently.
    const maxStreamsRaw = parseInt(String(b.maxStreams || '0'), 10);
    const maxStreams = (Number.isFinite(maxStreamsRaw) && maxStreamsRaw >= 0 && maxStreamsRaw <= 20) ? maxStreamsRaw : 0;
    try {
      // 0.33.0: active backend fields are uuManifestUrl + torboxApiKey.
      // 0.34.0: Easynews creds drive Pipeline C (direct Easynews search).
      // 0.36.0: dropped the rd / tb / pm / autoCache* hidden-input passthrough.
      // Old values (if any) stay in users.json — updateUserConfig only patches
      // the keys we name here, so legacy fields remain on disk but are no
      // longer touched by the UI. The schema still includes them in users.js
      // so existing records continue deserialising cleanly.
      users.updateUserConfig(req.user.id, {
        torboxEnabled: b.torboxEnabled === 'on'
          || b.torboxEnabled === '1' || b.torboxEnabled === 'true',
        uuEnabled: b.uuEnabled === 'on'
          || b.uuEnabled === '1' || b.uuEnabled === 'true',
        easynewsEnabled: b.easynewsEnabled === 'on'
          || b.easynewsEnabled === '1' || b.easynewsEnabled === 'true',
        uuManifestUrl: security.cleanHttpUrl(b.uuManifestUrl, {
          label: 'Usenet Ultimate manifest URL', allowSensitiveQuery: true,
        }),
        torboxApiKey: String(b.torboxApiKey || '').trim(),
        easynewsUsername: String(b.easynewsUsername || '').trim(),
        easynewsPassword: String(b.easynewsPassword || ''),
        diyUsenetEnabled: b.diyUsenetEnabled === 'on'
          || b.diyUsenetEnabled === '1' || b.diyUsenetEnabled === 'true',
        diyNativeSearchEnabled: b.diyNativeSearchEnabled === 'on'
          || b.diyNativeSearchEnabled === '1' || b.diyNativeSearchEnabled === 'true',
        diyUuSearchEnabled: b.diyUuSearchEnabled === 'on'
          || b.diyUuSearchEnabled === '1' || b.diyUuSearchEnabled === 'true',
        diySearchKind: String(b.diySearchKind || '') === 'prowlarr' ? 'prowlarr' : 'newznab',
        diySearchName: String(b.diySearchName || '').trim().slice(0, 80),
        diySearchUrl: security.cleanHttpUrl(b.diySearchUrl, { label: 'Search URL' }),
        diySearchApiKey: String(b.diySearchApiKey || ''),
        nzbdavUrl: security.cleanHttpUrl(b.nzbdavUrl, { label: 'NZB DAV API URL' }),
        nzbdavApiKey: String(b.nzbdavApiKey || ''),
        nzbdavWebdavUrl: security.cleanHttpUrl(b.nzbdavWebdavUrl, { label: 'NZB DAV WebDAV URL' }),
        nzbdavWebdavUsername: String(b.nzbdavWebdavUsername || '').trim(),
        nzbdavWebdavPassword: String(b.nzbdavWebdavPassword || ''),
        nativeNntpEnabled: b.nativeNntpEnabled === 'on'
          || b.nativeNntpEnabled === '1' || b.nativeNntpEnabled === 'true',
        nntpHost: String(b.nntpHost || '').trim(),
        nntpPort: Math.min(65535, Math.max(1, parseInt(String(b.nntpPort || '563'), 10) || 563)),
        nntpTls: b.nntpTls === 'on' || b.nntpTls === '1' || b.nntpTls === 'true',
        nntpUsername: String(b.nntpUsername || '').trim(),
        nntpPassword: String(b.nntpPassword || ''),
        nntpConnections: Math.min(50, Math.max(1,
          parseInt(String(b.nntpConnections || '20'), 10) || 20)),
        catalogs: finalCats,
        catalogDefaultsVersion: CURRENT_DEFAULTS_VERSION,
        showCatalogsOnHome: b.showCatalogsOnHome === 'on' || b.showCatalogsOnHome === '1' || b.showCatalogsOnHome === 'true',
        promotionOrder: cleanOrder(b.promotionOrder, allPromotionIds),
        catalogOrder: cleanOrder(b.catalogOrder, allCatalogIds),
        maxStreams,
        // 0.38.0: warm-to-cache pseudo-streams toggle (default true).
        showWarmRows: b.showWarmRows === 'on' || b.showWarmRows === '1' || b.showWarmRows === 'true',
      });
      res.redirect('/account?flash=saved');
    } catch (err) {
      res.redirect('/account?flash=' + encodeURIComponent('Save failed: ' + security.safeErrorMessage(err)));
    }
  });

  app.post('/account/test-nzbdav', requireLogin, async (req, res) => {
    const b = req.body || {};
    try {
      const api = await nzbdavClient.testConnection({
        url: String(b.nzbdavUrl || '').trim(),
        apiKey: String(b.nzbdavApiKey || ''),
      });
      if (!api.ok) throw new Error('API check failed: ' + api.error);
      await nzbdavWebdav.list({
        url: String(b.nzbdavWebdavUrl || b.nzbdavUrl || '').trim(),
        username: String(b.nzbdavWebdavUsername || ''),
        password: String(b.nzbdavWebdavPassword || ''),
      }, '/');
      res.redirect('/account?flash=' + encodeURIComponent('NZB DAV API and WebDAV connected'));
    } catch (error) {
      res.redirect('/account?flash=' + encodeURIComponent('NZB DAV connection failed: ' + security.safeErrorMessage(error)));
    }
  });

  app.post('/account/test-diy-search', requireLogin, async (req, res) => {
    const b = req.body || {};
    const query = String(b.diySearchTestQuery || 'UFC').trim().slice(0, 200) || 'UFC';
    try {
      const result = await usenetIndexer.search([query], {
        enabled: true,
        kind: String(b.diySearchKind || '') === 'prowlarr' ? 'prowlarr' : 'newznab',
        name: String(b.diySearchName || '').trim(),
        url: String(b.diySearchUrl || '').trim(),
        apiKey: String(b.diySearchApiKey || ''),
      });
      if (!result.ok) throw new Error(result.error || 'search failed');
      res.redirect('/account?flash=' + encodeURIComponent(
        'Native Usenet search connected: ' + result.results.length + ' result(s) for "' + query + '"'));
    } catch (error) {
      res.redirect('/account?flash=' + encodeURIComponent(
        'Native Usenet search failed: ' + security.safeErrorMessage(error)));
    }
  });

  app.post('/account/test-nntp', requireLogin, async (req, res) => {
    const b = req.body || {};
    try {
      const result = await nntpClient.testConnection({
        host: String(b.nntpHost || '').trim(),
        port: parseInt(String(b.nntpPort || '563'), 10),
        tls: b.nntpTls === 'on' || b.nntpTls === '1' || b.nntpTls === 'true',
        username: String(b.nntpUsername || '').trim(),
        password: String(b.nntpPassword || ''),
      });
      res.redirect('/account?flash=' + encodeURIComponent(
        'Native NNTP connected and authenticated' + (result.proxied ? ' through the outbound proxy' : '')));
    } catch (error) {
      res.redirect('/account?flash=' + encodeURIComponent(
        'Native NNTP connection failed: ' + security.safeErrorMessage(error)));
    }
  });

  app.post('/account/regenerate-token', requireLogin, (req, res) => {
    try {
      users.regenerateApiToken(req.user.id);
      // Invalidate the just-regenerated session? No — same user, same browser.
      // The OLD apiToken-based install URL stops working immediately; the
      // session cookie keeps the user logged in.
      res.redirect('/account?flash=token-regenerated');
    } catch (err) {
      res.redirect('/account?flash=' + encodeURIComponent('Regenerate failed: ' + err.message));
    }
  });

  // --- Per-user addon API (Phase 2): /u/:userId/:apiToken/* ---------
  // Each user's install URL embeds their userId + apiToken. The token is
  // verified in constant time against users.json. The user's stored config
  // (debrid keys + catalog selection) flows through into the manifest and
  // stream resolver.
  function buildUserAddonRouter() {
    const r = express.Router({ mergeParams: true });

    r.use((req, res, next) => {
      const { userId, apiToken } = req.params;
      const u = users.findByApiToken(userId, apiToken);
      if (!u) return res.status(404).send('Not found');
      req.userAccount = u;
      users.touchLastSeen(u.id);
      next();
    });

    // The manifest is configuration, not content: it carries the catalog
    // selection, the published order and the showInHome hint, so a one-hour
    // max-age meant a saved change on the Configure page appeared not to work
    // until the client's cache expired. `no-cache` still permits the stored
    // copy — it just forces revalidation, and Express's ETag keeps the
    // revalidation a 304.
    r.get('/manifest.json', (req, res) => {
      send(res, buildManifest({ user: req.userAccount, origin: publicOriginFromReq(req) }),
        { cacheControl: 'private, no-cache' });
    });

    r.get('/catalog/:type/:id.json', (req, res) => {
      send(res, handleCatalog({ type: req.params.type, id: req.params.id, extra: {} }));
    });
    r.get('/catalog/:type/:id/:extra.json', (req, res) => {
      send(res, handleCatalog({ type: req.params.type, id: req.params.id, extra: parseExtra(req.params.extra) }));
    });

    r.get('/meta/:type/:id.json', (req, res) => {
      send(res, handleMeta({ type: req.params.type, id: decodeURIComponent(req.params.id) }));
    });

    r.get('/stream/:type/:id.json', async (req, res) => {
      try {
        const result = await handleStream({
          type: req.params.type,
          id: decodeURIComponent(req.params.id),
          debug: req.query.debug === '1',
          userConfig: req.userAccount.config || null,
          username: req.userAccount.username,
          userId: req.params.userId,
          apiToken: req.params.apiToken,
          origin: publicOriginFromReq(req),
        });
        // Availability may change seconds after a TorBox warm. Nuvio's Refresh
        // Links action must reach SSS instead of replaying a five-minute cache.
        // Express otherwise generates a stable ETag and can turn a real refresh
        // into a bodyless 304 after Nuvio has cleared its displayed rows. Give
        // every completed lookup a unique validator so refresh always receives
        // the newly built stream list.
        setFreshStreamHeaders(res);
        // Stream responses are account-specific and should not be shared.
        send(res, result, { cacheControl: 'private, no-store' });
      } catch (err) {
        console.error('[stream] user-route handler error:', err);
        send(res, { streams: [] }, { cacheControl: 'private, no-store' });
      }
    });

    // Play-time resolution. Stream rows point here; the debrid add + unrestrict
    // happens now (on click), then we 302-redirect to the playable URL. This is
    // the ONLY place a torrent is ever added to a user's debrid — a search can
    // no longer pollute their account. ':eventId' is URL-encoded (it contains a
    // colon, e.g. ufc:2449567) and Express decodes it for us.
    //
    // 0.25.0: every resolve URL carries ?exp=&sig= built by lib/url-sign.js
    // and is rejected if expired or signature-mismatched. The path-level
    // apiToken alone is no longer sufficient — it gets you through the router
    // middleware, but the resolve action requires a live signature too.
    const urlSign = require('./lib/url-sign');
    r.get('/resolve/:provider/:eventId/:infoHash', async (req, res) => {
      const { provider, eventId, infoHash } = req.params;
      const v = urlSign.verifyResolve({
        userId: req.params.userId,
        provider, eventId, infoHash,
        exp: req.query.exp, sig: req.query.sig,
      });
      if (!v.ok) {
        console.warn('[resolve] signature rejected (' + v.reason + ') for '
          + req.userAccount.username + ' ' + eventId + ' ' + infoHash);
        return res.status(403)
          .set('Cache-Control', 'no-store')
          .send('Resolve link ' + v.reason + '. Close and re-open the event in your client.');
      }
      try {
        const out = await resolvePlay({
          providerCode: provider,
          eventId,
          infoHash,
          creds: req.userAccount.config || null,
          username: req.userAccount.username,
          userId: req.params.userId,
        });
        if (out && out.upstream) {
          const range = req.headers.range ? ' ' + String(req.headers.range) : '';
          console.log('[resolve ' + req.userAccount.username + '] webdav proxy '
            + req.method + range);
          return await proxyWebdav(req, res, out.upstream);
        }
        if (out && out.nativeNntp) {
          const range = req.headers.range ? ' ' + String(req.headers.range) : '';
          console.log('[resolve ' + req.userAccount.username + '] native nntp '
            + req.method + range);
          return await nntpPlayback.serve(req, res,
            out.nativeNntp.descriptor, out.nativeNntp.config, {
              log: (message) => console.log('[resolve ' + req.userAccount.username + '] ' + message),
            });
        }
        if (out && out.url) {
          res.setHeader('Cache-Control', 'no-store');
          return res.redirect(302, out.url);
        }
        // Not cached / unresolvable on this provider — tell the player plainly.
        res.status(404).send('Not cached on ' + provider + ' (or no longer available).');
      } catch (err) {
        console.error('[resolve] handler error:', err);
        if (!res.headersSent) {
          res.removeHeader('Content-Range');
          res.removeHeader('Content-Length');
          res.removeHeader('Content-Disposition');
          const safeMessage = err && err.httpStatus && err.message
            ? err.message : 'Resolve failed.';
          res.status(Number(err && err.httpStatus) || 502).send(safeMessage);
        }
        else res.destroy(err);
      }
    });

    // 0.38.0: Warm-to-cache route. Submits the magnet to the user's TorBox
    // account (the side-effectful add we deliberately avoid in /stream and
    // /resolve), then redirects to a tiny placeholder MP4 so Stremio's
    // player has something to display. Rate-limited per-user to keep TB
    // 429-safe under button-mashing.
    const warmRateLimit = require('./lib/warm-rate-limit');
    r.get('/warm/:provider/:eventId/:infoHash', async (req, res) => {
      const { provider, eventId, infoHash } = req.params;
      const userId = req.params.userId;
      const username = req.userAccount.username;
      const tag = '[warm u=' + username + ']';
      const log = (m) => console.log(tag + ' ' + m);

      // Verify the HMAC signature first — same scheme as /resolve.
      const v = urlSign.verifyResolve({
        userId,
        provider: 'torbox-warm', eventId, infoHash,
        exp: req.query.exp, sig: req.query.sig,
      });
      if (!v.ok) {
        log('signature rejected (' + v.reason + ')');
        return res.status(403).send('Warm link expired or invalid.');
      }

      // Provider check — currently warm is TorBox-only.
      if (provider !== 'torbox') {
        log('unsupported provider: ' + provider);
        return res.status(404).send('Unsupported warm provider.');
      }

      const creds = req.userAccount.config || {};
      res.setHeader('Cache-Control', 'private, no-store');
      try {
        const result = await warmTorbox({
          eventId, infoHash, creds, username, log,
          // An already-ready stale row becomes playback before consuming the
          // add-torrent rate limit.
          beforeSubmit: () => warmRateLimit.check(userId),
        });
        if (result.url) {
          log('warm link became playable; redirecting now');
          return res.redirect(302, result.url);
        }
        if (result.error === 'rate-limited') {
          log('rate-limited; retry in ' + result.retryAfterSec + 's');
          res.setHeader('Retry-After', String(result.retryAfterSec));
          return res.redirect(302, '/assets/warm-rate-limited.mp4');
        }
        if (result.queued || result.waiting) {
          return res.redirect(302, '/assets/warm-added.mp4');
        }
        log('warm failed: ' + (result.error || 'unknown'));
        return res.redirect(302, '/assets/warm-failed.mp4');
      } catch (err) {
        log('warm error: ' + err.message);
        return res.redirect(302, '/assets/warm-failed.mp4');
      }
    });

    return r;
  }

  // Mount BEFORE the wildcard /:token to claim these paths.

  // --- Admin panel (Phase 2 Day 4) ----------------------------------
  app.get('/admin', requireAdmin, (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderAdminPage(req.user, { flash: req.query.flash || null, origin: publicOriginFromReq(req) }));
  });

  app.post('/admin/users/create', requireAdmin, async (req, res) => {
    const b = req.body || {};
    const username = String(b.username || '').trim();
    const password = String(b.password || '');
    const role = b.role === 'admin' ? 'admin' : 'user';
    try {
      const u = await users.createUser({ username, password, role });
      res.redirect('/admin?flash=' + encodeURIComponent('Created user "' + u.username + '" (id ' + u.id + ')'));
    } catch (err) {
      res.redirect('/admin?flash=' + encodeURIComponent('Create failed: ' + err.message));
    }
  });

  app.post('/admin/users/:id/delete', requireAdmin, (req, res) => {
    const id = req.params.id;
    if (id === req.user.id) {
      return res.redirect('/admin?flash=' + encodeURIComponent('You cannot delete your own account here.'));
    }
    try {
      const ok = users.deleteUser(id);
      res.redirect('/admin?flash=' + encodeURIComponent(ok ? 'User deleted.' : 'User not found.'));
    } catch (err) {
      res.redirect('/admin?flash=' + encodeURIComponent('Delete failed: ' + err.message));
    }
  });

  app.post('/admin/users/:id/regenerate-token', requireAdmin, (req, res) => {
    const id = req.params.id;
    try {
      users.regenerateApiToken(id);
      res.redirect('/admin?flash=' + encodeURIComponent('API token regenerated for user ' + id + '. Their old install URL is now invalid.'));
    } catch (err) {
      res.redirect('/admin?flash=' + encodeURIComponent('Regenerate failed: ' + err.message));
    }
  });

  app.post('/admin/users/:id/set-password', requireAdmin, async (req, res) => {
    const id = req.params.id;
    const newPass = String(req.body.newPassword || '');
    try {
      await users.setPassword(id, newPass);
      res.redirect('/admin?flash=' + encodeURIComponent('Password updated for user ' + id + '.'));
    } catch (err) {
      res.redirect('/admin?flash=' + encodeURIComponent('Set password failed: ' + err.message));
    }
  });

  app.post('/admin/users/:id/set-role', requireAdmin, (req, res) => {
    const id = req.params.id;
    const newRole = String(req.body.role || '');
    try {
      // Last-admin lockout protection: refuse to demote the only remaining
      // admin (or yourself if you're the only one) to a non-admin role.
      if (newRole !== 'admin') {
        const target = users.findById(id);
        if (target && target.role === 'admin' && users.countAdmins() <= 1) {
          throw new Error('cannot demote the last admin — promote another user to admin first');
        }
      }
      users.setRole(id, newRole);
      res.redirect('/admin?flash=' + encodeURIComponent('Role updated for user ' + id + ' (now ' + newRole + ').'));
    } catch (err) {
      res.redirect('/admin?flash=' + encodeURIComponent('Set role failed: ' + err.message));
    }
  });

  // 0.36.0: Refresh catalogs button. Fires scripts/refresh.js (events from
  // TSDB / Wikipedia / etc). Most useful right
  // after adding a custom promotion via /admin/promotions — events show up
  // in the catalog within ~minute(s) without waiting on the scheduled refresh.
  app.post('/admin/refresh-events', requireAdmin, (req, res) => {
    runEventsRefresh({ log: (m) => console.log(m) })
      .then(() => {
        console.log('[admin] manual events refresh complete');
        return availabilityWarmer.run({ reason: 'manual-catalog-refresh' });
      })
      .catch((err) => console.error('[admin] manual events refresh failed:', err.message));
    res.redirect('/admin?flash=' + encodeURIComponent('Catalog refresh started in the background — pulls events from TSDB for every promotion. Check server logs for progress.'));
  });

  // 0.41.0 — per-promotion refresh. Speeds up iteration when you're just
  // tweaking one promotion (e.g. EPL aliases) — skips fetching sources for
  // every other promotion. Events belonging to other promotions are
  // preserved in the store untouched.
  app.post('/admin/promotions/:id/refresh', requireAdmin, (req, res) => {
    const id = String(req.params.id || '').trim();
    const p = promotions.all.find((x) => x.id === id);
    if (!p) {
      return res.redirect('/admin/promotions?flash=' + encodeURIComponent('Refresh: promotion "' + id + '" not found'));
    }
    if (!p.enabled) {
      return res.redirect('/admin/promotions?flash=' + encodeURIComponent('Refresh: promotion "' + id + '" is disabled'));
    }
    const currentRef = String(p.sourceRef || '');
    if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'previewedSourceRef')
        || String(req.body.previewedSourceRef || '') !== currentRef) {
      return res.redirect('/admin/promotions?flash=' + encodeURIComponent('Preview the event changes before refreshing "' + id + '".'));
    }
    runEventsRefresh({ promotionId: id, log: (m) => console.log(m) })
      .then((result) => {
        const line = '[admin] per-promotion refresh "' + id + '" '
          + (result.ok ? 'complete: ' : 'failed: ') + JSON.stringify(result);
        if (result.ok) console.log(line);
        else console.error(line);
        if (result.ok) return availabilityWarmer.run({ reason: 'promotion-refresh' });
        return null;
      })
      .catch((err) => console.error('[admin] per-promotion refresh "' + id + '" failed: ' + err.message));
    res.redirect('/admin/promotions?flash=' + encodeURIComponent('Refresh started for "' + p.name + '" — other promotions untouched. Check server logs for progress.'));
  });

  const logQuery = (req, extra) => Object.assign({
    category: req.query.category,
    user: req.query.user,
    substring: req.query.substring,
    regex: req.query.regex === 'on' || req.query.regex === 'true',
    level: req.query.level,
    limit: parseInt(req.query.limit, 10) || 1000,
  }, extra || {});

  // Structured operations console: snapshot + SSE tail + text/NDJSON export.
  app.get('/admin/logs', requireAdmin, (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(renderLogsPage(req.user, req.query));
  });
  app.get('/admin/logs.json', requireAdmin, (req, res) => {
    const rows = logBuffer.filtered(logQuery(req, { sinceId: req.query.sinceId }));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(JSON.stringify({ rows, stats: logBuffer.counts() }));
  });
  app.get('/admin/logs/stream', requireAdmin, (req, res) => {
    const query = logQuery(req, { sinceId: req.query.sinceId, limit: 5000 });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.flushHeaders) res.flushHeaders();
    let lastId = Number(query.sinceId) || 0;
    const sendRow = (row) => {
      if (!row || row.id <= lastId || !logBuffer.matches(row, Object.assign({}, query, { sinceId: null }))) return;
      lastId = row.id;
      res.write('id: ' + row.id + '\ndata: ' + JSON.stringify(row) + '\n\n');
    };
    for (const row of logBuffer.filtered(query)) sendRow(row);
    logBuffer.bus.on('line', sendRow);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      logBuffer.bus.off('line', sendRow);
    });
  });
  app.get('/admin/logs.txt', requireAdmin, (req, res) => {
    const rows = logBuffer.filtered(logQuery(req));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sss-logs-' + stamp + '.log"');
    res.send(adminLogs.rowsToText(rows));
  });
  app.get('/admin/logs.ndjson', requireAdmin, (req, res) => {
    const rows = logBuffer.filtered(logQuery(req));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sss-logs-' + stamp + '.ndjson"');
    res.send(rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
  });
  app.post('/admin/logs/clear', requireAdmin, (req, res) => {
    logBuffer.clear();
    console.warn('[admin] retained operations logs cleared', { module: 'admin', user: req.user.username });
    res.json({ ok: true, stats: logBuffer.counts() });
  });
  app.post('/admin/logs/preferences', requireAdmin, (req, res) => {
    const preferences = settings.setLogPreferences({
      detailedRejections: req.body.detailedRejections === 'on',
    });
    console.log('[admin] detailed rejection logging '
      + (preferences.detailedRejections ? 'enabled' : 'set to sampled'));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, preferences });
  });

  function databaseSnapshot() {
    const index = availabilityStore.getDefault();
    const stats = index.stats();
    let fileSize = 0;
    try { fileSize = fs.statSync(stats.file).size; } catch (_) { /* in-memory or unavailable */ }
    return {
      stats,
      fileSize,
      warm: availabilityWarmer.status(),
      scheduler: availabilityScheduler.status(),
      searches: index.recentSearches(25).map((row) => {
        const event = store.getEvent(row.eventId);
        return Object.assign({}, row, { eventTitle: event && event.name || '' });
      }),
    };
  }

  app.get('/admin/database', requireAdmin, (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    let snapshot;
    try { snapshot = databaseSnapshot(); }
    catch (error) {
      snapshot = { stats: {}, warm: availabilityWarmer.status(), scheduler: availabilityScheduler.status(), searches: [], fileSize: 0 };
      snapshot.flash = 'Database unavailable: ' + security.safeErrorMessage(error);
    }
    snapshot.flash = req.query.flash || snapshot.flash || null;
    res.send(tablerChrome.tablerPage('Database', adminDatabase.renderBody(snapshot), {
      user: req.user, currentSection: 'database',
    }));
  });

  app.get('/admin/database/status.json', requireAdmin, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      res.send(JSON.stringify(databaseSnapshot()));
    } catch (error) {
      res.status(503).send(JSON.stringify({ ok: false, error: security.safeErrorMessage(error) }));
    }
  });

  async function sportVideoSnapshot(user) {
    const state = sportVideo.load();
    const releases = (state.releases || []).slice(0, 200);
    const torboxKey = String(user && user.config && user.config.torboxApiKey || '').trim();
    let cached = new Set();
    if (torboxKey) {
      const hashes = Array.from(new Set(releases.map((record) => String(record.infoHash || '').toLowerCase())
        .filter((hash) => /^[a-f0-9]{40}$/.test(hash))));
      if (hashes.length) {
        cached = await torboxResolver.checkCachedBatch(hashes, torboxKey,
          (message) => console.log('[sport-video] ' + message));
      }
    }
    return {
      config: settings.getSportVideo(), status: sportVideo.status(), releases,
      cached, torboxConfigured: Boolean(torboxKey),
      promotions: promotions.enabled.map((promotion) => ({ id: promotion.id, name: promotion.name })),
      catalogTeams: matchDiagnostics.catalogTeams({}),
    };
  }

  app.get('/admin/sport-video', requireAdmin, async (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    let snapshot;
    try { snapshot = await sportVideoSnapshot(req.user); }
    catch (error) {
      snapshot = {
        config: settings.getSportVideo(), status: sportVideo.status(),
        promotions: promotions.enabled.map((promotion) => ({ id: promotion.id, name: promotion.name })),
        catalogTeams: [],
        releases: sportVideo.load().releases.slice(0, 200), cached: new Set(),
        torboxConfigured: Boolean(req.user.config && req.user.config.torboxApiKey),
        flash: 'TorBox availability check failed: ' + security.safeErrorMessage(error),
      };
    }
    snapshot.flash = req.query.flash || snapshot.flash || null;
    res.send(tablerChrome.tablerPage('Sport-Video', adminSportVideo.renderBody(snapshot), {
      user: req.user, currentSection: 'sport-video',
    }));
  });

  app.post('/admin/sport-video/settings', requireAdmin, (req, res) => {
    try {
      settings.setSportVideo({
        enabled: req.body.enabled === 'on', autoScan: req.body.autoScan === 'on',
        intervalHours: req.body.intervalHours, startDelaySeconds: req.body.startDelaySeconds,
        maxDetailsPerScan: req.body.maxDetailsPerScan, archivePages: req.body.archivePages,
        autoWarmPromotions: req.body.autoWarmPromotions, autoWarmPerScan: req.body.autoWarmPerScan,
        autoWarmWindowDays: req.body.autoWarmWindowDays,
        // Multi-selects post as teamFilter:<promotionId>, one field per
        // promotion, so an untouched promotion simply never appears.
        teamFilters: Object.entries(req.body || {}).reduce((out, [field, value]) => {
          if (!field.startsWith('teamFilter:')) return out;
          out[field.slice('teamFilter:'.length)] = [].concat(value || []);
          return out;
        }, {}),
        categories: req.body.categories,
      });
      sportVideo.startScheduler();
      res.redirect('/admin/sport-video?flash=' + encodeURIComponent('Sport-Video settings saved and applied.'));
    } catch (error) {
      res.redirect('/admin/sport-video?flash=' + encodeURIComponent('Save failed: ' + security.safeErrorMessage(error)));
    }
  });

  app.post('/admin/sport-video/scan', requireAdmin, (_req, res) => {
    const alreadyRunning = sportVideo.status().running;
    sportVideo.scan().catch(() => {});
    res.redirect('/admin/sport-video?flash=' + encodeURIComponent(alreadyRunning
      ? 'A Sport-Video scan is already running.' : 'Sport-Video scan started. Refresh this page for results.'));
  });

  // Re-check stored releases against the catalog as it stands now. Sport-Video
  // publishes ahead of metadata refreshes, so a release discovered before its
  // fixture existed would otherwise stay unmatched until it was rediscovered.
  app.post('/admin/sport-video/rematch', requireAdmin, (_req, res) => {
    try {
      const result = sportVideo.rematch();
      res.redirect('/admin/sport-video?flash=' + encodeURIComponent(
        'Re-matched ' + result.releases + ' stored release(s); ' + result.matched + ' now match a current event.'));
    } catch (error) {
      res.redirect('/admin/sport-video?flash=' + encodeURIComponent(
        'Re-match failed: ' + security.safeErrorMessage(error)));
    }
  });

  // Match diagnostics export. Replays the matching decision for every event in
  // the window and every release within a day of it, keeping the reason each
  // one was rejected. Read-only, admin-only, and never includes torrent URLs.
  function diagnosticsReport(req) {
    return matchDiagnostics.diagnose({
      promotionId: String(req.query.promotion || '').trim(),
      days: Number(req.query.days) || 60,
    });
  }

  app.get('/admin/sport-video/diagnostics.csv', requireAdmin, (req, res) => {
    try {
      const report = diagnosticsReport(req);
      const stamp = report.generatedAt.slice(0, 10);
      const scope = (report.promotionFilter || 'all').replace(/[^A-Za-z0-9_-]/g, '');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Disposition',
        'attachment; filename="sss-match-diagnostics-' + scope + '-' + stamp + '.csv"');
      res.send(matchDiagnostics.toCsv(report));
    } catch (error) {
      res.status(500).send('Diagnostics export failed: ' + security.safeErrorMessage(error));
    }
  });

  app.get('/admin/sport-video/diagnostics.json', requireAdmin, (req, res) => {
    try {
      const report = diagnosticsReport(req);
      const stamp = report.generatedAt.slice(0, 10);
      const scope = (report.promotionFilter || 'all').replace(/[^A-Za-z0-9_-]/g, '');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Disposition',
        'attachment; filename="sss-match-diagnostics-' + scope + '-' + stamp + '.json"');
      res.send(JSON.stringify(report, null, 2));
    } catch (error) {
      res.status(500).send(JSON.stringify({ ok: false, error: security.safeErrorMessage(error) }));
    }
  });

  app.post('/admin/sport-video/prepare/:id', requireAdmin, async (req, res) => {
    try {
      const record = await sportVideo.prepare(String(req.params.id || ''));
      res.redirect('/admin/sport-video?flash=' + encodeURIComponent('Prepared torrent identity for ' + record.title + '.'));
    } catch (error) {
      res.redirect('/admin/sport-video?flash=' + encodeURIComponent('Preparation failed: ' + security.safeErrorMessage(error)));
    }
  });

  app.post('/admin/sport-video/warm/:id', requireAdmin, async (req, res) => {
    try {
      let record = sportVideo.load().releases.find((item) => item.id === String(req.params.id || ''));
      if (!record) throw new Error('Sport-Video release not found');
      if (!record.infoHash) record = await sportVideo.prepare(record.id);
      const match = Array.isArray(record.matches) && record.matches[0];
      if (!match) throw new Error('Release is not matched to a current SSS event');
      const warmRateLimit = require('./lib/warm-rate-limit');
      const result = await warmTorbox({
        eventId: match.eventId, infoHash: record.infoHash,
        creds: req.user.config || {}, username: req.user.username,
        beforeSubmit: () => warmRateLimit.check(req.user.id),
      });
      let message = 'TorBox could not accept this release.';
      if (result.url || result.ready) message = 'Release is already ready on TorBox. Open the matched event and refresh its links.';
      else if (result.queued || result.waiting) message = 'Release is warming on TorBox. Check the TorBox dashboard, then refresh the matched event links.';
      else if (result.error === 'rate-limited') message = 'Too many TorBox warm requests. Wait ' + result.retryAfterSec + ' seconds and try again.';
      else if (result.error) message = 'TorBox warm failed: ' + result.error;
      res.redirect('/admin/sport-video?flash=' + encodeURIComponent(message));
    } catch (error) {
      res.redirect('/admin/sport-video?flash=' + encodeURIComponent('TorBox warm failed: ' + security.safeErrorMessage(error)));
    }
  });

  // Preserve old bookmarks without retaining the legacy Health UI or actions.
  app.get('/admin/health', requireAdmin, (_req, res) => res.redirect(302, '/admin/database'));

  app.post('/admin/database/settings', requireAdmin, (req, res) => {
    try {
      settings.setAvailabilityWarm({
        enabled: req.body.enabled === 'on',
        serveConfirmed: req.body.serveConfirmed === 'on',
        prepareTorrent: req.body.prepareTorrent === 'on',
        prepareUsenet: req.body.prepareUsenet === 'on',
        prepareEasynews: req.body.prepareEasynews === 'on',
        windowDays: req.body.windowDays,
        intervalHours: req.body.intervalHours,
        maxEventsPerRun: req.body.maxEventsPerRun,
        startDelaySeconds: req.body.startDelaySeconds,
      });
      availabilityScheduler.reconfigure();
      res.redirect('/admin/database?flash=' + encodeURIComponent('Automatic preparation settings saved and applied.'));
    } catch (error) {
      res.redirect('/admin/database?flash=' + encodeURIComponent('Save failed: ' + security.safeErrorMessage(error)));
    }
  });

  app.post('/admin/database/settings/reset', requireAdmin, (_req, res) => {
    settings.resetAvailabilityWarm();
    availabilityScheduler.reconfigure();
    res.redirect('/admin/database?flash=' + encodeURIComponent('Warmer settings reset to environment defaults.'));
  });

  app.post('/admin/database/warm', requireAdmin, (_req, res) => {
    const alreadyRunning = availabilityWarmer.status().running;
    availabilityScheduler.runNow('manual', { force: true }).catch((error) => {
      console.error('[availability] manual warm-up failed:', error.message);
    });
    res.redirect('/admin/database?flash=' + encodeURIComponent(alreadyRunning
      ? 'Automatic preparation is already running.' : 'Automatic preparation started.'));
  });

  app.post('/admin/database/prune', requireAdmin, (_req, res) => {
    try {
      const removed = availabilityStore.getDefault().prune();
      const total = Object.values(removed).reduce((sum, value) => sum + value, 0);
      res.redirect('/admin/database?flash=' + encodeURIComponent('Pruned ' + total + ' expired database row(s).'));
    } catch (error) {
      res.redirect('/admin/database?flash=' + encodeURIComponent('Prune failed: ' + security.safeErrorMessage(error)));
    }
  });

  app.post('/admin/database/wipe', requireAdmin, (_req, res) => {
    try {
      availabilityStore.getDefault().wipe();
      res.redirect('/admin/database?flash=' + encodeURIComponent('Smart Availability database wiped.'));
    } catch (error) {
      res.redirect('/admin/database?flash=' + encodeURIComponent('Wipe failed: ' + security.safeErrorMessage(error)));
    }
  });

  // Backup endpoint (0.24.0). Streams a timestamped tar.gz of the data/
  // directory to the admin as a download. Includes events.json, users.json,
  // settings, all denylists, positive cache, and other runtime state —
  // everything that lives in the named Docker volume. Pipe-streams via the
  // container's bundled tar binary so we don't bloat the npm tree.
  app.get('/admin/backup', requireAdmin, (req, res) => {
    const { spawn } = require('child_process');
    // Fold the WAL into the main database so a copied archive is immediately
    // self-contained even when no later write has triggered a checkpoint.
    try { availabilityStore.getDefault().checkpoint(); }
    catch (error) { console.error('[availability] backup checkpoint failed:', error.message); }
    const dataDir = path.dirname(config.dataFile); // ./data → /app/data
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = 'serioussportsync-backup-' + ts + '.tar.gz';
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.setHeader('Cache-Control', 'no-store');
    const proc = spawn('tar', ['-czf', '-', '-C', dataDir, '.']);
    proc.stdout.pipe(res);
    proc.stderr.on('data', (d) => console.error('[backup] tar stderr: ' + d.toString().trim()));
    proc.on('error', (err) => {
      console.error('[backup] spawn error:', err.message);
      if (!res.headersSent) res.status(500).end('Backup failed: ' + err.message);
    });
    proc.on('exit', (code) => {
      if (code !== 0) console.error('[backup] tar exited with code ' + code);
    });
  });

  // Save server-wide metadata and torrent discovery sources.
  app.post('/admin/sources', requireAdmin, (req, res) => {
    const b = req.body || {};
    try {
      settings.setCompanion({
        url: security.cleanHttpUrl(b.companionUrl, { label: 'Companion URL' }),
        authToken: String(b.companionAuthToken || ''),
      });
      settings.setProwlarr({
        url: security.cleanHttpUrl(b.prowlarrUrl, { label: 'Prowlarr URL' }),
        apiKey: String(b.prowlarrApiKey || ''),
      });
      // 0.38.1: football-data.org API key — admin-saved value wins over the
      // FOOTBALL_DATA_API_KEY env var. Empty input is allowed (falls back to env).
      settings.setFootballData({
        apiKey: String(b.footballDataApiKey || ''),
      });
      settings.setApiFootball({
        apiKey: String(b.apiFootballApiKey || ''),
      });
      res.redirect('/admin?flash=' + encodeURIComponent('Sources saved.'));
    } catch (err) {
      res.redirect('/admin?flash=' + encodeURIComponent('Save failed: ' + security.safeErrorMessage(err)));
    }
  });

  app.post('/admin/invites/create', requireAdmin, (req, res) => {
    const b = req.body || {};
    const username = String(b.username || '').trim();
    const role = b.role === 'admin' ? 'admin' : 'user';
    try {
      const inv = users.createInvite({ username, role });
      res.redirect('/admin?flash=' + encodeURIComponent('Invite created for "' + inv.username + '". URL is in the Invites section below.'));
    } catch (err) {
      res.redirect('/admin?flash=' + encodeURIComponent('Invite create failed: ' + err.message));
    }
  });

  app.post('/admin/invites/:token/revoke', requireAdmin, (req, res) => {
    const ok = users.revokeInvite(req.params.token);
    res.redirect('/admin?flash=' + encodeURIComponent(ok ? 'Invite revoked.' : 'Invite not found.'));
  });

  // --- 0.35.0: promotion creator (admin-added TSDB-backed promotions) ---
  const adminPromotions = require('./lib/admin-promotions');
  const adminMetadata = require('./lib/admin-metadata');
  const adminNuvioCollections = require('./lib/admin-nuvio-collections');
  const nuvioCollectionSettings = require('./lib/nuvio-collection-settings');

  app.get('/admin/metadata', requireAdmin, (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(tablerChrome.tablerPage('Metadata', adminMetadata.renderBody({ flash: req.query.flash || null }), {
      user: req.user, currentSection: 'metadata',
    }));
  });

  app.get('/admin/nuvio-collections', requireAdmin, (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const body = adminNuvioCollections.renderBody({
      flash: req.query.flash || null,
      promotion: String(req.query.promotion || '').trim() || null,
    });
    res.send(tablerChrome.tablerPage('Nuvio Collections', body, {
      user: req.user, currentSection: 'nuvio-collections',
    }));
  });

  app.post('/admin/nuvio-collections/save', requireAdmin, (req, res) => {
    try {
      const body = req.body || {};
      nuvioCollectionSettings.updateCollection({
        title: body.title,
        backdropImage: body.backdropImage,
        pinToTop: body.pinToTop === '1' || body.pinToTop === 'on',
        showAllTab: body.showAllTab === '1' || body.showAllTab === 'on',
      });
      res.redirect('/admin/nuvio-collections?flash=' + encodeURIComponent('Collection settings saved. Export JSON again in Account to apply it in Nuvio.'));
    } catch (err) {
      res.redirect('/admin/nuvio-collections?flash=' + encodeURIComponent('Save failed: ' + err.message));
    }
  });

  function saveNuvioFolder(req, res, folderId) {
    try {
      const validIds = new Set(promotions.enabled.map((promotion) => promotion.id));
      const input = adminNuvioCollections.folderInput(req.body || {});
      nuvioCollectionSettings.upsertFolder(folderId, input, validIds);
      res.redirect('/admin/nuvio-collections?flash=' + encodeURIComponent(
        (folderId ? 'Collection folder updated.' : 'Collection folder added.') + ' Export JSON again in Account to apply it in Nuvio.'));
    } catch (err) {
      res.redirect('/admin/nuvio-collections?flash=' + encodeURIComponent('Folder save failed: ' + err.message));
    }
  }

  app.post('/admin/nuvio-collections/folders/create', requireAdmin, (req, res) => saveNuvioFolder(req, res, null));
  app.post('/admin/nuvio-collections/folders/:id/save', requireAdmin, (req, res) => saveNuvioFolder(req, res, req.params.id));
  app.post('/admin/nuvio-collections/folders/:id/delete', requireAdmin, (req, res) => {
    const removed = nuvioCollectionSettings.removeFolder(String(req.params.id || ''));
    res.redirect('/admin/nuvio-collections?flash=' + encodeURIComponent(
      removed ? 'Collection folder removed. Promotions and events were not deleted.' : 'Collection folder not found.'));
  });

  app.get('/admin/promotions', requireAdmin, (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const body = adminPromotions.renderBody({
      editId: String(req.query.edit || '').trim() || null,
      create: req.query.create === '1',
      flash:  req.query.flash || null,
    });
    res.send(tablerChrome.tablerPage('Promotions', body, { user: req.user, currentSection: 'promotions' }));
  });

  app.post('/admin/promotions/create', requireAdmin, (req, res) => {
    try {
      const spec = adminPromotions.saveFromForm(req.body || {});
      const repaired = spec.ignoredExclusionKeywords && spec.ignoredExclusionKeywords.length
        ? ' Conflicting reject words were ignored: ' + spec.ignoredExclusionKeywords.join(', ') + '.' : '';
      res.redirect('/admin/nuvio-collections?promotion=' + encodeURIComponent(spec.id)
        + '&flash=' + encodeURIComponent('Created "' + spec.name + '".' + repaired + ' Choose its Nuvio folder and artwork below, then refresh it from Promotions.'));
    } catch (err) {
      res.redirect('/admin/promotions?create=1&flash=' + encodeURIComponent('Create failed: ' + err.message) + '#promotionWizard');
    }
  });

  app.get('/admin/promotions/:id/research', requireAdmin, (req, res) => {
    const body = adminPromotions.renderMatchingLab(String(req.params.id || ''), {
      flash: req.query.flash || null,
    });
    if (!body) return res.redirect(303, '/admin/promotions?flash=' + encodeURIComponent(
      'Matching Lab is available for shipped promotions. Custom promotions can be researched from Edit.'));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(tablerChrome.tablerPage('Promotion Matching Lab', body, { user: req.user, currentSection: 'promotions' }));
  });

  app.post('/admin/promotions/:id/matching-override', requireAdmin, (req, res) => {
    const id = String(req.params.id || '');
    try {
      adminPromotions.saveMatchingOverride(id, req.body || {});
      res.redirect(303, '/admin/promotions/' + encodeURIComponent(id) + '/research?flash=' + encodeURIComponent(
        'Matching override saved and activated.'));
    } catch (error) {
      res.redirect(303, '/admin/promotions/' + encodeURIComponent(id) + '/research?flash=' + encodeURIComponent(
        'Save failed: ' + error.message));
    }
  });

  app.post('/admin/promotions/:id/matching-override/reset', requireAdmin, (req, res) => {
    const id = String(req.params.id || '');
    adminPromotions.resetMatchingOverride(id);
    res.redirect(303, '/admin/promotions?flash=' + encodeURIComponent('Restored shipped matching rules for "' + id + '".'));
  });

  app.get('/admin/promotions/new', requireAdmin, (req, res) => {
    res.redirect(302, '/admin/promotions?create=1#promotionWizard');
  });

  // Retired expert tools now converge on the unified Promotions workflow.
  // Keep stored data files untouched so upgrades and rollback remain safe.
  app.use(['/admin/power-tool', '/admin/search', '/admin/match-editor', '/admin/match-test', '/admin/content'], requireAdmin, (req, res) => {
    res.redirect(303, '/admin/promotions?flash=' + encodeURIComponent(
      'This legacy tool has moved into Promotions. No stored configuration was deleted.'));
  });

  app.post('/admin/metadata-sources/create', requireAdmin, (req, res) => {
    try {
      const source = adminPromotions.createMetadataSource(req.body || {});
      res.redirect('/admin/metadata?flash=' + encodeURIComponent('Added metadata source "' + source.name + '". It is now available in Promotions.'));
    } catch (err) {
      res.redirect('/admin/metadata?flash=' + encodeURIComponent('Add source failed: ' + err.message));
    }
  });

  app.post('/admin/metadata-sources/preview', requireAdmin, async (req, res) => {
    const out = await adminMetadata.previewInput(req.body || {});
    res.status(out.ok ? 200 : 422).json(out);
  });

  app.post('/admin/promotions/derive-aliases', requireAdmin, (req, res) => {
    const body = req.body || {};
    const out = adminPromotions.deriveAliases(body.name, body.examples, body.badExamples);
    res.status(out.ok ? 200 : 400);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(out));
  });

  app.post('/admin/promotions/source-preview', requireAdmin, async (req, res) => {
    const out = await adminPromotions.previewWizardSource(req.body || {});
    res.status(out.ok ? 200 : 422).json(out);
  });

  app.post('/admin/promotions/preview-matching', requireAdmin, (req, res) => {
    const out = adminPromotions.previewMatching(req.body || {});
    res.status(out.ok ? 200 : 400);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(out));
  });

  app.post('/admin/promotions/search-releases', requireAdmin, async (req, res) => {
    const out = await adminPromotions.searchReleaseExamples(
      (req.user && req.user.config) || {}, req.body || {}
    );
    res.status(out.ok ? 200 : 422).json(out);
  });

  app.post('/admin/promotions/alias-research', requireAdmin, async (req, res) => {
    const out = await adminPromotions.researchAliases(
      (req.user && req.user.config) || {}, req.body || {}
    );
    res.setHeader('Cache-Control', 'no-store');
    res.status(out.ok ? 200 : 422).json(out);
  });

  app.post('/admin/promotions/:id/update', requireAdmin, (req, res) => {
    const id = req.params.id;
    try {
      const spec = adminPromotions.saveFromForm(req.body || {}, { updateId: id });
      const repaired = spec.ignoredExclusionKeywords && spec.ignoredExclusionKeywords.length
        ? ' Conflicting reject words were removed: ' + spec.ignoredExclusionKeywords.join(', ') + '.' : '';
      res.redirect('/admin/promotions?flash=' + encodeURIComponent('Updated "' + id + '".' + repaired));
    } catch (err) {
      res.redirect('/admin/promotions?edit=' + encodeURIComponent(id)
        + '&flash=' + encodeURIComponent('Update failed: ' + err.message) + '#promotionWizard');
    }
  });

  app.post('/admin/promotions/:id/source', requireAdmin, (req, res) => {
    const id = String(req.params.id || '').trim();
    try {
      const sourceRef = String((req.body && req.body.sourceRef) || '').trim();
      if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'previewedSourceRef')
          || String(req.body.previewedSourceRef || '') !== sourceRef) {
        throw new Error('Preview the event changes before saving this source');
      }
      const promotion = adminPromotions.assignSource(id, sourceRef);
      res.redirect('/admin/promotions?flash=' + encodeURIComponent(
        'Metadata source updated for "' + promotion.name + '". Run its refresh when ready to import events from the new source.'));
    } catch (err) {
      res.redirect('/admin/promotions?flash=' + encodeURIComponent('Source assignment failed: ' + err.message));
    }
  });

  app.post('/admin/promotions/:id/source-preview', requireAdmin, async (req, res) => {
    const out = await adminPromotions.previewSourceChange(
      req.params.id, String((req.body && req.body.sourceRef) || '').trim()
    );
    res.status(out.ok ? 200 : 422).json(out);
  });

  app.post('/admin/promotions/:id/delete', requireAdmin, (req, res) => {
    const id = req.params.id;
    try {
      const ok = adminPromotions.deleteCustom(id);
      res.redirect('/admin/promotions?flash=' + encodeURIComponent(
        ok ? ('Deleted custom promotion "' + id + '". Stored events remain until next refresh purges them.')
           : ('Promotion "' + id + '" not found or not deletable.')));
    } catch (err) {
      res.redirect('/admin/promotions?flash=' + encodeURIComponent('Delete failed: ' + err.message));
    }
  });

  // TSDB league id pre-flight check — used by inline fetch() on the promotions
  // form to confirm the entered id resolves to a real league before saving.
  app.post('/admin/promotions/validate-leagueid', requireAdmin, async (req, res) => {
    const out = await adminPromotions.validateLeagueId(String((req.body && req.body.leagueId) || ''));
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(out));
  });

  // 0.38.0: football-data.org competition validator. Same shape as the TSDB
  // one, fed by the source-picker dropdown's "Check football-data" button.
  app.post('/admin/promotions/validate-competition', requireAdmin, async (req, res) => {
    const out = await adminPromotions.validateCompetitionId(String((req.body && req.body.competitionId) || ''));
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(out));
  });

  // 0.42.13: TMDB TV show validator. Same shape as TSDB/football-data validators,
  // fed by the source-picker dropdown's "Check TMDB" button.
  app.post('/admin/promotions/validate-tvid', requireAdmin, async (req, res) => {
    const out = await adminPromotions.validateTvId(String((req.body && req.body.tvId) || ''));
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(out));
  });

  // --- Public invite redemption (no login required) ----------------
  app.get('/invite/:token', (req, res) => {
    const inv = users.findInvite(req.params.token);
    if (!inv) {
      return res.status(404).send(authPage('Invite invalid',
        '<p style="color:var(--accent);margin:0 0 12px;">This invite is invalid, already used, or expired.</p>'
        + '<p><a href="/login">Sign in</a></p>'));
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(authPage('Accept invite — SeriousSportSync',
      '<p style="margin:0 0 16px;color:var(--muted);font-size:13px;">'
      + 'You\'ve been invited to create an account on this SeriousSportSync instance.'
      + '</p>'
      + '<table class="info" style="margin-bottom:16px;">'
      +   '<tr><th>Username</th><td><code>' + escapeHtml(inv.username) + '</code></td></tr>'
      +   '<tr><th>Role</th><td>' + escapeHtml(inv.role) + '</td></tr>'
      +   '<tr><th>Expires</th><td style="font-size:12px;">' + escapeHtml(inv.expiresAt.slice(0, 16).replace('T', ' ')) + '</td></tr>'
      + '</table>'
      + '<form method="POST" action="/invite/' + encodeURIComponent(req.params.token) + '">'
      +   '<label class="form-label">Set your password</label>'
      +   '<input class="form-control" name="password" type="password" required minlength="8" placeholder="min 8 chars" autofocus>'
      +   '<button class="btn btn-primary w-100 mt-3" type="submit">Create account</button>'
      + '</form>'
    ));
  });

  app.post('/invite/:token', async (req, res) => {
    const password = String(req.body.password || '');
    try {
      const u = await users.consumeInvite(req.params.token, password);
      sessions.setCookie(res, u, req);
      res.redirect('/account?flash=' + encodeURIComponent('Welcome! Your account has been created.'));
    } catch (err) {
      res.status(400).send(authPage('Invite accept failed',
        '<p style="color:var(--accent);">' + escapeHtml(err.message) + '</p>'
        + '<p><a href="/invite/' + encodeURIComponent(req.params.token) + '">Try again</a></p>'));
    }
  });

  app.use('/u/:userId/:apiToken', buildUserAddonRouter());

  // Root URL is the entry point. Anonymous visitors land on /login (or
  // /setup if the install is brand-new and has no users yet). Authenticated
  // users go straight to their /account page. There is no anonymous catalog
  // browsing in this version — all addon access is per-user via the
  // /u/:userId/:apiToken/* routes mounted above.
  app.get('/', (req, res) => {
    if (req.user) return res.redirect('/account');
    if (users.userCount() === 0) return res.redirect('/setup');
    return res.redirect('/login');
  });

  return app;
}

function renderAdminPage(currentUser, opts) {
  opts = opts || {};
  const all = users.listUsers();

  const flashHtml = opts.flash
    ? '<div class="alert alert-info alert-dismissible" role="alert">'
      + '<div>' + escapeHtml(opts.flash) + '</div>'
      + '<a class="btn-close" data-bs-dismiss="alert"></a>'
      + '</div>'
    : '';

  // Active invites — table + create form, all in a single card.
  users.cleanExpiredInvites();
  const invites = users.listInvites();
  const inviteRows = invites.map(function (i) {
    const url = '/invite/' + i.token;
    const exp = (i.expiresAt || '').slice(0, 16).replace('T', ' ');
    const roleBadgeClass = i.role === 'admin' ? 'bg-red-lt' : 'bg-blue-lt';
    return ''
      + '<tr>'
      +   '<td><code>' + escapeHtml(i.username) + '</code></td>'
      +   '<td><span class="badge ' + roleBadgeClass + '">' + escapeHtml(i.role) + '</span></td>'
      +   '<td class="text-secondary small">' + escapeHtml(exp) + '</td>'
      +   '<td>'
      +     '<div class="input-group input-group-sm">'
      +       '<input class="form-control text-mono" value="' + escapeHtml(url) + '" readonly>'
      +       '<button type="button" class="btn btn-outline-primary btn-copy" data-copy="' + escapeHtml(url) + '">Copy</button>'
      +     '</div>'
      +   '</td>'
      +   '<td><form method="POST" action="/admin/invites/' + escapeHtml(i.token) + '/revoke" class="d-inline" onsubmit="return confirm(\'Revoke invite for ' + escapeHtml(i.username) + '?\');"><button type="submit" class="btn btn-sm btn-outline-danger">Revoke</button></form></td>'
      + '</tr>';
  }).join('');
  const invitesHtml = ''
    + '<div class="card mb-3">'
    +   '<div class="card-header"><h3 class="card-title">Invites (' + invites.length + ')</h3></div>'
    +   '<div class="card-body">'
    +     '<p class="text-secondary small mb-3">Send the invite URL to the recipient. They set their own password on first visit. Invites expire after 7 days.</p>'
    +     (invites.length > 0
        ? '<div class="table-responsive mb-3"><table class="table table-vcenter card-table"><thead><tr><th>Username</th><th>Role</th><th>Expires</th><th>Invite URL</th><th class="w-1"></th></tr></thead><tbody>' + inviteRows + '</tbody></table></div>'
        : '<p class="text-secondary fst-italic mb-3">No active invites.</p>')
    +     '<form method="POST" action="/admin/invites/create" class="row g-2 align-items-end">'
    +       '<div class="col-md-6">'
    +         '<label class="form-label">New invite — username</label>'
    +         '<input class="form-control" name="username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9_.\\-]{3,32}" placeholder="3-32 chars, letters/digits/_-.">'
    +       '</div>'
    +       '<div class="col-md-3">'
    +         '<label class="form-label">Role</label>'
    +         '<select class="form-select" name="role"><option value="user" selected>user</option><option value="admin">admin</option></select>'
    +       '</div>'
    +       '<div class="col-md-3">'
    +         '<button class="btn btn-primary w-100" type="submit">Create invite</button>'
    +       '</div>'
    +     '</form>'
    +   '</div>'
    + '</div>';

  // Users table (Tabler-styled).
  const rows = all.map(function (u) {
    const isMe = (u.id === currentUser.id);
    const created = (u.createdAt || '').slice(0, 10);
    const seen = u.lastSeen ? u.lastSeen.slice(0, 10) : '—';
    const roleBadgeClass = u.role === 'admin' ? 'bg-red-lt' : 'bg-blue-lt';
    const deleteBtn = isMe
      ? '<span class="text-secondary small">(you)</span>'
      : '<form method="POST" action="/admin/users/' + escapeHtml(u.id) + '/delete" class="d-inline" onsubmit="return confirm(\'Delete user ' + escapeHtml(u.username) + '? This is permanent.\');"><button type="submit" class="btn btn-sm btn-outline-danger">Delete</button></form>';
    const regenBtn = '<form method="POST" action="/admin/users/' + escapeHtml(u.id) + '/regenerate-token" class="d-inline" onsubmit="return confirm(\'Regenerate API token for ' + escapeHtml(u.username) + '? Their old install URL will stop working immediately.\');"><button type="submit" class="btn btn-sm btn-outline-primary">Regenerate token</button></form>';
    const roleSelect = '<form method="POST" action="/admin/users/' + escapeHtml(u.id) + '/set-role" class="d-inline" onsubmit="return confirm(\'Change role for ' + escapeHtml(u.username) + '?\');">'
      + '<div class="input-group input-group-sm d-inline-flex" style="width:auto;">'
      +   '<select name="role" class="form-select form-select-sm">'
      +     '<option value="user"'  + (u.role === 'user'  ? ' selected' : '') + '>user</option>'
      +     '<option value="admin"' + (u.role === 'admin' ? ' selected' : '') + '>admin</option>'
      +   '</select>'
      +   '<button type="submit" class="btn btn-outline-primary btn-sm">Set</button>'
      + '</div></form>';

    const setPwForm = '<details class="d-inline-block ms-1">'
      + '<summary class="btn btn-sm btn-outline-primary" style="list-style:none;cursor:pointer;">Set password</summary>'
      + '<form method="POST" action="/admin/users/' + escapeHtml(u.id) + '/set-password" class="mt-2 p-2 border rounded">'
      +   '<div class="input-group input-group-sm">'
      +     '<input type="password" name="newPassword" required minlength="8" placeholder="new password" class="form-control">'
      +     '<button type="submit" class="btn btn-primary">Save</button>'
      +   '</div>'
      + '</form></details>';

    return ''
      + '<tr>'
      +   '<td><code>' + escapeHtml(u.username) + '</code>' + (isMe ? ' <span class="text-secondary small">(you)</span>' : '') + '</td>'
      +   '<td><span class="badge ' + roleBadgeClass + '">' + escapeHtml(u.role) + '</span></td>'
      +   '<td class="text-secondary small">' + escapeHtml(created) + '</td>'
      +   '<td class="text-secondary small">' + escapeHtml(seen) + '</td>'
      +   '<td class="text-nowrap"><div class="d-flex flex-wrap gap-1 align-items-center">' + roleSelect + setPwForm + regenBtn + deleteBtn + '</div></td>'
      + '</tr>';
  }).join('');

  // Torrent discovery endpoints are optional and may be used together.
  const _comp = settings.getCompanion();
  const _prowlarr = settings.getProwlarr();
  // 0.38.1: football-data.org API key field on /admin Sources so admins can
  // save/rotate the key without editing docker-compose.yml.
  const _fd = settings.getFootballData();
  const _apiFootball = settings.getApiFootball();

  const body = ''
    + '<div class="page-header">'
    +   '<div class="row align-items-center">'
    +     '<div class="col">'
    +       '<h2 class="page-title">Admin</h2>'
    +       '<div class="text-secondary mt-1">Admin panel — manage users for this SeriousSportSync instance. Logged in as <code>' + escapeHtml(currentUser.username) + '</code>.</div>'
    +     '</div>'
    +   '</div>'
    + '</div>'
    + flashHtml

    // Companion scraper config
    + '<div class="card mb-3">'
    +   '<div class="card-header"><h3 class="card-title">Torrent discovery and metadata sources</h3></div>'
    +   '<div class="card-body">'
    +     '<p class="text-secondary small mb-3">URL of the SeriousSportScraper companion service you have deployed. The metadata addon delegates content discovery to it and resolves the returned hashes through each user\'s own TorBox key. Leave blank if you only want to use direct Prowlarr.</p>'
    +     '<form method="POST" action="/admin/sources">'
    +       '<div class="mb-3">'
    +         '<label class="form-label">Companion URL</label>'
    +         '<input class="form-control text-mono" name="companionUrl" value="' + escapeHtml(_comp.url) + '" placeholder="http://scraper:8080" autocomplete="off">'
    +       '</div>'
    +       secretField('Companion auth token (optional)', 'companionAuthToken', _comp.authToken, 'shared bearer if scraper is internet-exposed')

    +       '<hr class="my-4">'
    +       '<h4 class="mb-2">Direct Prowlarr (optional)</h4>'
    +       '<p class="text-secondary small mb-3">Query Prowlarr directly when a user opens an event. Discovery is request-only and limited to that event. Results are filtered and checked against each user\'s TorBox account; raw torrent rows are never returned. The URL must be reachable from this container. For a separate Dockge stack, use a shared Docker network or the server address; <code>localhost</code> refers to this container.</p>'
    +       '<div class="mb-3">'
    +         '<label class="form-label">Prowlarr URL</label>'
    +         '<input class="form-control text-mono" type="url" name="prowlarrUrl" value="' + escapeHtml(_prowlarr.url) + '" placeholder="http://prowlarr:9696" autocomplete="off">'
    +       '</div>'
    +       secretField('Prowlarr API key', 'prowlarrApiKey', _prowlarr.apiKey, 'Settings → General → Security')

    // 0.38.1: football-data.org API key block. Saved value overrides
    // FOOTBALL_DATA_API_KEY env var. Used by custom promotions whose source
    // === 'football-data' (FIFA WC, EPL, Champions League, etc.).
    +       '<hr class="my-4">'
    +       '<h4 class="mb-2">football-data.org</h4>'
    +       '<p class="text-secondary small mb-3">API key for the football-data.org parallel source — used by custom promotions whose source is set to football-data (FIFA WC, EPL, Champions League, etc.). Free tier covers ~10 req/min. Sign up at <a href="https://www.football-data.org/client/register" target="_blank" rel="noopener" class="link-primary">football-data.org/client/register</a>. Saving here overrides the FOOTBALL_DATA_API_KEY env var.</p>'
    +       secretField('football-data.org API key', 'footballDataApiKey', _fd.apiKey, 'paste your football-data.org token')

    +       '<hr class="my-4">'
    +       '<h4 class="mb-2">API-Football</h4>'
    +       '<p class="text-secondary small mb-3">Optional key for API-Football providers created in Metadata. Current-season access depends on your API-Football plan; its free plan may be limited to historical seasons. The shipped Champions League provider now uses UEFA directly and needs no key. Create a key at <a href="https://dashboard.api-football.com/register" target="_blank" rel="noopener" class="link-primary">dashboard.api-football.com</a>. Saving here overrides <code>API_FOOTBALL_API_KEY</code>.</p>'
    +       secretField('API-Football API key', 'apiFootballApiKey', _apiFootball.apiKey, 'paste your API-Football key')

    +       '<hr class="my-4">'
    +       '<button class="btn btn-primary" type="submit">Save sources</button>'
    +     '</form>'
    +   '</div>'
    + '</div>'

    // Catalogs / refresh
    + '<div class="card mb-3">'
    +   '<div class="card-header"><h3 class="card-title">Catalogs</h3></div>'
    +   '<div class="card-body">'
    +     '<p class="text-secondary small mb-3">Pulls fresh event metadata from TSDB (and any other configured sources) for every enabled promotion — built-in and custom. Runs in the background; scheduled refresh fires every 6h regardless. Use this button after adding a new custom promotion so its events appear without waiting on the scheduler.</p>'
    +     '<form method="POST" action="/admin/refresh-events" class="d-inline">'
    +       '<button class="btn btn-primary" type="submit">Refresh catalogs now</button>'
    +     '</form>'
    +   '</div>'
    + '</div>'

    // Users
    + '<div class="card mb-3">'
    +   '<div class="card-header"><h3 class="card-title">Users (' + all.length + ')</h3></div>'
    +   '<div class="table-responsive">'
    +     '<table class="table table-vcenter card-table">'
    +       '<thead><tr><th>Username</th><th>Role</th><th>Created</th><th>Last seen</th><th class="w-1"></th></tr></thead>'
    +       '<tbody>' + rows + '</tbody>'
    +     '</table>'
    +   '</div>'
    + '</div>'

    // Create new user
    + '<div class="card mb-3">'
    +   '<div class="card-header"><h3 class="card-title">Create a new user</h3></div>'
    +   '<div class="card-body">'
    +     '<p class="text-secondary small mb-3">After creating a user, they log in at the root URL and copy their own install URL from their account page. Install URLs and API tokens are private to each user and are never shown here.</p>'
    +     '<form method="POST" action="/admin/users/create" class="row g-2 align-items-end">'
    +       '<div class="col-md-4">'
    +         '<label class="form-label">Username</label>'
    +         '<input class="form-control" name="username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9_.\\-]{3,32}" placeholder="3-32 chars">'
    +       '</div>'
    +       '<div class="col-md-3">'
    +         '<label class="form-label">Password</label>'
    +         '<input class="form-control" name="password" type="password" required minlength="8" placeholder="min 8 chars">'
    +       '</div>'
    +       '<div class="col-md-2">'
    +         '<label class="form-label">Role</label>'
    +         '<select class="form-select" name="role"><option value="user" selected>user</option><option value="admin">admin</option></select>'
    +       '</div>'
    +       '<div class="col-md-3">'
    +         '<button class="btn btn-primary w-100" type="submit">Create user</button>'
    +       '</div>'
    +     '</form>'
    +   '</div>'
    + '</div>'

    + invitesHtml

    // Shared inline JS: password show/toggle + copy button.
    // (Sidebar nav links replaced the bottom footer strip — chrome handles nav.)
    + '<script>'
    + 'document.addEventListener("click",function(e){var b=e.target&&e.target.closest?e.target.closest(".btn-reveal"):null;if(!b)return;e.preventDefault();var g=b.closest(".input-group");if(!g)return;var i=g.querySelector("input");if(!i)return;var sh=i.type==="password";i.type=sh?"text":"password";b.textContent=sh?"Hide":"Show";});'
    + 'document.addEventListener("click",function(e){var c=e.target&&e.target.closest?e.target.closest(".btn-copy"):null;if(!c)return;var u=c.getAttribute("data-copy");if(!u)return;if(navigator.clipboard)navigator.clipboard.writeText(u);var t=c.textContent;c.textContent="Copied!";setTimeout(function(){c.textContent=t;},1500);});'
    + '</script>';

  return tablerChrome.tablerPage('Admin', body, { user: currentUser, currentSection: 'admin' });
}

// Operations-console log viewer. The original renderer remains below during
// the transition for easy rollback, but all routes use this implementation.
function renderLogsPage(currentUser, q) {
  const opts = adminLogs.queryOptions(q);
  const rows = logBuffer.filtered(opts);
  const body = adminLogs.renderBody({
    rows,
    stats: logBuffer.counts(),
    query: q,
    preferences: settings.getLogPreferences(),
  });
  return tablerChrome.tablerPage('Logs', body, { user: currentUser, currentSection: 'logs' });
}

// 0.27.0 legacy renderer retained temporarily for rollback comparison.
// run server-side via logBuffer.filtered(). Tail mode is a small inline JS
// that polls /admin/logs.json every 3s and re-renders just the table body.
function renderLogsPageLegacy(currentUser, q) {
  q = q || {};
  const category   = String(q.category   || 'all');
  const userFilter = String(q.user       || '');
  const substring  = String(q.substring  || '');
  const level      = String(q.level      || 'all');
  const limit      = Math.max(50, Math.min(5000, parseInt(q.limit, 10) || 500));
  const tail       = q.tail === 'on';

  const stats = logBuffer.counts();
  const rows = logBuffer.filtered({ category, user: userFilter, substring, level, limit });

  const knownCats = ['stream','resolve','warm','refresh','admin','server','availability','denylist','positive-cache','dead-indexer','onefc','crypto-keys','users','other'];
  const seenCats = new Set(Object.keys(stats.byCategory || {}));
  knownCats.forEach((c) => seenCats.add(c));
  const cats = ['all', ...Array.from(seenCats).sort()];

  const opt = (val, sel) => '<option value="' + escapeHtml(val) + '"' + (val === sel ? ' selected' : '') + '>' + escapeHtml(val) + '</option>';

  const rowHtml = (e) => {
    const time = new Date(e.ts).toISOString().replace('T', ' ').slice(0, 19);
    const lvlBadgeClass = e.level === 'error' ? 'bg-red-lt' : e.level === 'warn' ? 'bg-yellow-lt' : 'bg-secondary-lt';
    return '<tr>'
      +   '<td class="text-secondary text-mono" style="width:160px;">' + escapeHtml(time) + '</td>'
      +   '<td style="width:110px;"><span class="badge bg-secondary-lt">' + escapeHtml(e.category) + '</span></td>'
      +   '<td class="text-secondary" style="width:110px;">' + escapeHtml(e.user || '') + '</td>'
      +   '<td style="width:60px;"><span class="badge ' + lvlBadgeClass + '">' + escapeHtml(e.level) + '</span></td>'
      +   '<td class="text-mono" style="font-size:12px;word-break:break-word;white-space:pre-wrap;">' + escapeHtml(e.line) + '</td>'
      + '</tr>';
  };
  const rowsHtml = rows.length === 0
    ? '<tr><td colspan="5" class="text-center text-secondary py-4">No log lines match these filters.</td></tr>'
    : rows.map(rowHtml).join('');

  // Tail-mode auto-refresh JS — polls /admin/logs.json every 3s and replaces
  // the tbody. Builds rows in the SAME shape as server-rendered ones above
  // (Tabler badges + same column widths) so the live update is invisible.
  const tailJs = tail
    ? `<script>(function(){
        function esc(s){return String(s||'').replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
        function badgeClass(lvl){return lvl==='error'?'bg-red-lt':lvl==='warn'?'bg-yellow-lt':'bg-secondary-lt';}
        function fmt(rows){
          if(!rows.length) return '<tr><td colspan="5" class="text-center text-secondary py-4">No log lines match these filters.</td></tr>';
          return rows.map(function(e){
            var t=new Date(e.ts).toISOString().replace('T',' ').slice(0,19);
            return '<tr>'
              + '<td class="text-secondary text-mono" style="width:160px;">'+esc(t)+'</td>'
              + '<td style="width:110px;"><span class="badge bg-secondary-lt">'+esc(e.category)+'</span></td>'
              + '<td class="text-secondary" style="width:110px;">'+esc(e.user||'')+'</td>'
              + '<td style="width:60px;"><span class="badge '+badgeClass(e.level)+'">'+esc(e.level)+'</span></td>'
              + '<td class="text-mono" style="font-size:12px;word-break:break-word;white-space:pre-wrap;">'+esc(e.line)+'</td>'
              + '</tr>';
          }).join('');
        }
        function poll(){
          fetch('/admin/logs.json'+location.search,{cache:'no-store'})
            .then(function(r){return r.json();})
            .then(function(d){var b=document.getElementById('log-rows');if(b)b.innerHTML=fmt(d.rows||[]);})
            .catch(function(){});
        }
        setInterval(poll, 3000);
      })();</script>`
    : '';

  const summaryByCat = Object.entries(stats.byCategory || {})
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => escapeHtml(c) + ':' + n)
    .join(' · ');

  const body = ''
    + '<div class="page-header">'
    +   '<div class="row align-items-center">'
    +     '<div class="col">'
    +       '<h2 class="page-title">Logs</h2>'
    +       '<div class="text-secondary mt-1">Live server logs (in-memory ring buffer, last ' + stats.max + ' lines).</div>'
    +     '</div>'
    +   '</div>'
    + '</div>'

    // Filter form
    + '<div class="card mb-3">'
    +   '<div class="card-body">'
    +     '<form class="row g-2 align-items-end" method="GET" action="/admin/logs">'
    +       '<div class="col-md-2"><label class="form-label">Category</label><select class="form-select form-select-sm" name="category">' + cats.map((c) => opt(c, category)).join('') + '</select></div>'
    +       '<div class="col-md-2"><label class="form-label">User</label><input class="form-control form-control-sm" name="user" value="' + escapeHtml(userFilter) + '" placeholder="any"></div>'
    +       '<div class="col-md-3"><label class="form-label">Search</label><input class="form-control form-control-sm" name="substring" value="' + escapeHtml(substring) + '" placeholder="text…"></div>'
    +       '<div class="col-md-1"><label class="form-label">Level</label><select class="form-select form-select-sm" name="level">' + ['all','log','warn','error'].map((l) => opt(l, level)).join('') + '</select></div>'
    +       '<div class="col-md-1"><label class="form-label">Limit</label><select class="form-select form-select-sm" name="limit">' + ['100','500','1000','2500','5000'].map((n) => opt(n, String(limit))).join('') + '</select></div>'
    +       '<div class="col-md-2"><label class="form-label">Tail</label><label class="form-check form-switch mt-1"><input class="form-check-input" type="checkbox" name="tail" value="on"' + (tail ? ' checked' : '') + '><span class="form-check-label">3s refresh</span></label></div>'
    +       '<div class="col-md-1"><button type="submit" class="btn btn-primary btn-sm w-100">Apply</button></div>'
    +     '</form>'
    +   '</div>'
    + '</div>'

    // Stats line
    + '<div class="text-secondary small mb-2">'
    +   (tail ? '<span class="status-dot status-dot-animated bg-red me-1"></span>' : '')
    +   '<strong>' + stats.total + '</strong> / ' + stats.max + ' lines buffered &middot; '
    +   summaryByCat + ' &middot; '
    +   'errors: ' + (stats.byLevel.error || 0) + ' &middot; '
    +   'warns: ' + (stats.byLevel.warn || 0) + ' &middot; '
    +   'showing ' + rows.length
    + '</div>'

    // Log table card
    + '<div class="card">'
    +   '<div class="table-responsive">'
    +     '<table class="table table-vcenter card-table table-sm">'
    +       '<thead><tr><th>Time (UTC)</th><th>Cat</th><th>User</th><th>Lvl</th><th>Line</th></tr></thead>'
    +       '<tbody id="log-rows">' + rowsHtml + '</tbody>'
    +     '</table>'
    +   '</div>'
    + '</div>'
    + tailJs;

  return tablerChrome.tablerPage('Logs', body, { user: currentUser, currentSection: 'logs' });
}

// 0.28.0/0.28.1: admin per-event power tool. Page state in URL —
//   ?event=<id>       — selected event
//   ?page=<N>          — pagination (1-indexed, 10/page)
//   ?showAll=on        — include candidates the promotion's relevance check
//                        rejected (default off — only relevant rows shown).
//   ?indexer=<name>    — filter to one indexer source (default 'all').
// Server-side renders event details + paginated candidate list. Forms drive
// the actions. Tiny JS for select-all + count.
function secretField(label, name, value, placeholder) {
  return ''
    + '<div class="mb-3">'
    +   '<label class="form-label">' + escapeHtml(label) + '</label>'
    +   '<div class="input-group input-group-flat">'
    +     '<input class="form-control text-mono" type="password" name="' + escapeHtml(name) + '" value="' + escapeHtml(value || '') + '" placeholder="' + escapeHtml(placeholder || '') + '" autocomplete="off">'
    +     '<span class="input-group-text">'
    +       '<a href="#" class="link-secondary btn-reveal" tabindex="-1">Show</a>'
    +     '</span>'
    +   '</div>'
    + '</div>';
}

function renderAccountPage(user, opts) {
  opts = opts || {};
  const cfg = user.config || {};
  const apiToken = user.apiToken || '';
  const installPath = '/u/' + user.id + '/' + apiToken + '/manifest.json';
  const installUrl = (opts.origin || '') + installPath;
  const stremioInstallUrl = installUrl.replace(/^https?:\/\//i, 'stremio://');
  const nuvioJson = JSON.stringify(buildNuvioCollections({ user, origin: opts.origin }), null, 2);
  const effectiveSelection = effectiveCatalogSelection(cfg);
  const selected = effectiveSelection || new Set();
  const selectAll = effectiveSelection === null;
  const orderedPromotions = orderByIds(promotions.enabled, cfg.promotionOrder, (p) => p.id);

  // Per-promotion catalog tickboxes. Both levels follow the user's saved
  // manifest order; registry additions that are not saved yet append safely.
  let catGroupsHtml = '';
  for (const p of orderedPromotions) {
    let items = '';
    const orderedCatalogs = orderByIds(p.catalogs, cfg.catalogOrder, (c) => c.id);
    for (const c of orderedCatalogs) {
      const checked = (selectAll || selected.has(c.id)) ? ' checked' : '';
      items += ''
        + '<div class="catalog-sort-item d-flex align-items-center gap-2" data-catalog-id="' + escapeHtml(c.id) + '">'
        +   '<button class="btn btn-sm btn-ghost-secondary catalog-drag-handle" type="button" title="Hold and drag to reorder catalog" aria-label="Reorder ' + escapeHtml(c.name) + '">&#8942;&#8942;</button>'
        +   '<label class="form-check flex-fill mb-0">'
        +     '<input class="form-check-input" type="checkbox" name="catalogs" value="' + escapeHtml(c.id) + '"' + checked + '>'
        +     '<span class="form-check-label">' + escapeHtml(c.name) + '</span>'
        +   '</label>'
        + '</div>';
    }
    catGroupsHtml += ''
      + '<div class="catalog-sort-group mb-2" data-promotion-id="' + escapeHtml(p.id) + '">'
      +   '<div class="card h-100">'
      +     '<div class="card-header d-flex align-items-center">'
      +       '<h3 class="card-title">' + escapeHtml(p.name) + '</h3>'
      +       '<button class="btn btn-icon btn-ghost-secondary promotion-drag-handle ms-auto" type="button" title="Hold and drag to reorder promotion" aria-label="Reorder ' + escapeHtml(p.name) + '">&#8942;&#8942;</button>'
      +     '</div>'
      +     '<div class="card-body py-2 catalog-sort-items">' + items + '</div>'
      +   '</div>'
      + '</div>';
  }

  // Flash banner (Tabler alert).
  let flashHtml = '';
  if (opts.flash) {
    let txt = '';
    let cls = 'alert-success';
    if (opts.flash === 'saved') txt = 'Settings saved.';
    else if (opts.flash === 'token-regenerated') txt = 'API token regenerated. Old install URL no longer works.';
    else { txt = opts.flash; cls = 'alert-warning'; }
    flashHtml = '<div class="alert ' + cls + ' alert-dismissible" role="alert">'
      + '<div>' + escapeHtml(txt) + '</div>'
      + '<a class="btn-close" data-bs-dismiss="alert" aria-label="close"></a>'
      + '</div>';
  }

  const defaultMaxStreams = parseInt(process.env.STREAM_MAX_ROWS || '20', 10);

  const catalogsPanel = ''
    + '<style>'
    +   '.promotion-drag-handle,.catalog-drag-handle{cursor:grab;touch-action:none;user-select:none;font-weight:700;letter-spacing:-3px;}'
    +   '.promotion-drag-handle:active,.catalog-drag-handle:active{cursor:grabbing;}'
    +   '.catalog-order-list{display:flex;flex-direction:column;}'
    +   '.catalog-sort-group.sorting,.catalog-sort-item.sorting{opacity:.45;outline:2px solid var(--tblr-primary);outline-offset:1px;}'
    +   '.catalog-sort-group{width:100%;}'
    +   '.catalog-sort-item{min-height:38px;border-radius:4px;padding:2px 0;}'
    +   '.catalog-sort-item:hover{background:rgba(255,255,255,.035);}'
    + '</style>'
    + '<div class="config-fold-body">'
    +     '<label class="form-check form-switch mb-3">'
    +       '<input class="form-check-input" type="checkbox" name="showCatalogsOnHome" value="on"' + ((cfg.showCatalogsOnHome !== false) ? ' checked' : '') + '>'
    +       '<span class="form-check-label">Ask compatible Nuvio clients to show enabled catalogs as home rows</span>'
    +     '</label>'
    +     '<p class="text-secondary small mb-1">Turning this off keeps collection sources registered while sending Nuvio\'s <code>showInHome: false</code> hint and Desktop-compatible hidden-catalog metadata. You may need to refresh or reinstall the addon for Nuvio to reload its manifest.</p>'
    +     '<p class="text-secondary small mb-1">Tick the catalogs to include. Unticked catalogs are excluded from both the generated collection and, when home rows are enabled, your install URL\'s manifest.</p>'
    +     '<p class="text-secondary small mb-3">Drag the handles to reorder promotion blocks or catalogs within a promotion. This order is published directly in your manifest for Nuvio and Stremio.</p>'
    +     '<input type="hidden" name="promotionOrder" id="promotion-order" value="' + escapeHtml(orderedPromotions.map((p) => p.id).join(',')) + '">'
    +     '<input type="hidden" name="catalogOrder" id="catalog-order" value="' + escapeHtml(orderedPromotions.flatMap((p) => orderByIds(p.catalogs, cfg.catalogOrder, (c) => c.id).map((c) => c.id)).join(',')) + '">'
    +     '<div class="catalog-order-list" id="catalog-promotion-order">' + catGroupsHtml + '</div>'
    +   '</div>';

  const body = ''
    + '<style>'
    +   '.account-config{max-width:920px;margin:0 auto 4rem}.config-hero{padding:1rem 0 1.4rem}.config-eyebrow{color:var(--tblr-primary);font-size:.72rem;font-weight:800;letter-spacing:.13em;text-transform:uppercase}.config-title{font-size:clamp(2rem,5vw,3.15rem);letter-spacing:-.045em;line-height:1.02;margin:.55rem 0}.config-intro{max-width:700px}.config-block,.config-fold{border:1px solid var(--tblr-border-color);border-radius:14px;background:rgba(255,255,255,.018);margin-bottom:14px;overflow:hidden}.config-block-head,.config-fold summary{padding:16px 18px;font-weight:700;font-size:1rem}.config-block-head,.config-fold[open] summary{border-bottom:1px solid var(--tblr-border-color)}.config-fold summary{cursor:pointer;list-style:none}.config-fold summary:after{content:"⌄";float:right;color:var(--tblr-secondary)}.config-block-body,.config-fold-body{padding:18px}.provider-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.provider-grid .wide{grid-column:1/-1}.pipeline-map{display:grid;grid-template-columns:1fr auto 1fr auto 1fr;align-items:center;gap:10px;margin-bottom:18px}.pipeline-node{min-height:78px;border:1px solid var(--tblr-border-color);border-radius:12px;padding:12px;background:rgba(255,255,255,.025)}.pipeline-node strong{display:block;margin-bottom:3px}.pipeline-arrow{color:var(--tblr-primary);font-size:1.35rem;font-weight:800}.pipeline-stage{border:1px solid var(--tblr-border-color);border-radius:13px;background:rgba(0,0,0,.12);padding:16px;margin-top:14px}.pipeline-stage-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}.pipeline-stage-head h3{margin:0;font-size:1.05rem}.pipeline-kicker{color:var(--tblr-primary);font-size:.68rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;margin-bottom:3px}.pipeline-backends{display:grid;grid-template-columns:1fr 1fr;gap:14px}.pipeline-backend{border:1px solid var(--tblr-border-color);border-radius:12px;padding:15px;background:rgba(255,255,255,.018)}.pipeline-backend .provider-grid{grid-template-columns:1fr}.pipeline-output{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.save-bar{position:sticky;bottom:12px;z-index:5;display:flex;align-items:center;gap:14px;padding:13px 15px;margin:18px 0;background:rgba(20,21,24,.96);border:1px solid var(--tblr-border-color);border-radius:13px;box-shadow:0 16px 48px rgba(0,0,0,.35);backdrop-filter:blur(10px)}.save-bar .btn{min-width:180px}.product-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.product-card{border:1px solid var(--tblr-border-color);border-radius:13px;padding:18px;background:rgba(0,0,0,.14)}.product-card h3{margin:0 0 6px}.manifest-output{margin-top:14px;padding:14px;border:1px solid rgba(46,170,85,.35);background:rgba(46,170,85,.07);border-radius:11px}.session-note{border:1px solid rgba(239,68,68,.28);background:rgba(239,68,68,.07);border-radius:11px;padding:13px 14px}.config-management{display:flex;justify-content:flex-end;margin-top:12px;padding-top:12px;border-top:1px solid var(--tblr-border-color)}@media(max-width:720px){.provider-grid,.product-grid,.pipeline-backends{grid-template-columns:1fr}.provider-grid .wide{grid-column:auto}.pipeline-map{grid-template-columns:1fr}.pipeline-arrow{transform:rotate(90deg);text-align:center}.save-bar{align-items:flex-start;flex-direction:column}.save-bar .btn{width:100%}}'
    + '</style>'
    + '<main class="account-config">'
    + '<div class="config-hero">'
    +   '<div class="config-eyebrow">Signed-in configuration</div>'
    +   '<h1 class="config-title">Configure SeriousSportSync</h1>'
    +   '<p class="config-intro text-secondary mb-0">Add your services, choose catalogs, and install the private manifest from one account screen. Signing in is the only editing authority—there is no separate editing URL to save.</p>'
    + '</div>'
    + flashHtml
    + '<form method="POST" action="/account/save">'
    +   '<section class="config-block"><div class="config-block-head">Playback services</div><div class="config-block-body">'
    +     '<div class="provider-grid">'
    +       '<div class="wide"><label class="form-check form-switch mb-2"><input class="form-check-input" type="checkbox" name="torboxEnabled" value="on"' + (cfg.torboxEnabled !== false ? ' checked' : '') + '><span class="form-check-label"><strong>Enable TorBox pipeline</strong></span></label><p class="text-secondary small mb-2">Resolves companion results and returns playable URLs. Turning it off preserves the encrypted API key.</p>' + secretField('TorBox API key', 'torboxApiKey', cfg.torboxApiKey, 'paste your TorBox API key') + '</div>'
    +       '<div class="wide"><label class="form-check form-switch mb-2"><input class="form-check-input" type="checkbox" name="easynewsEnabled" value="on"' + (cfg.easynewsEnabled !== false ? ' checked' : '') + '><span class="form-check-label"><strong>Enable Easynews pipeline</strong></span></label><p class="text-secondary small mb-2">Turning it off preserves both credentials.</p></div>'
    +       '<div><label class="form-label" for="en-user">Easynews username</label><input class="form-control" type="text" id="en-user" name="easynewsUsername" value="' + escapeHtml(cfg.easynewsUsername || '') + '" autocomplete="off"></div>'
    +       '<div>' + secretField('Easynews password', 'easynewsPassword', cfg.easynewsPassword, 'your Easynews password') + '</div>'
    +       '<div class="wide"><label class="form-check form-switch mb-2"><input class="form-check-input" type="checkbox" name="uuEnabled" value="on"' + (cfg.uuEnabled !== false ? ' checked' : '') + '><span class="form-check-label"><strong>Enable Usenet Ultimate stream rows</strong></span></label><p class="text-secondary small mb-2">When disabled, the DIY pipeline may still use UU for text search, but UU’s own playback rows are hidden.</p><label class="form-label" for="uu-url">Usenet Ultimate manifest URL</label><input class="form-control text-mono" type="url" id="uu-url" name="uuManifestUrl" value="' + escapeHtml(cfg.uuManifestUrl || '') + '" placeholder="https://your-uu.example/stremio/&lt;config&gt;/manifest.json"></div>'
    +     '</div>'
    +   '</div></section>'
    +   '<details class="config-fold" open><summary>DIY Usenet pipeline</summary><div class="config-fold-body">'
    +     '<div class="pipeline-map">'
    +       '<div class="pipeline-node"><strong>1. Discover</strong><span class="text-secondary small">Prowlarr, Newznab/NZBHydra, and optional UU title search.</span></div><div class="pipeline-arrow">→</div>'
    +       '<div class="pipeline-node"><strong>2. Match</strong><span class="text-secondary small">SSS filters noise, checks event relevance, ranks, and stores opaque candidates.</span></div><div class="pipeline-arrow">→</div>'
    +       '<div class="pipeline-node"><strong>3. Play</strong><span class="text-secondary small">Choose native NNTP, NZB DAV, or keep both as independent result rows.</span></div>'
    +     '</div>'
    +     '<div class="alert alert-info mb-0"><strong>One search, flexible playback:</strong> both backends consume the same filtered candidates and run alongside every existing service. Disabling either backend preserves its encrypted credentials.</div>'
    +     '<section class="pipeline-stage"><div class="pipeline-stage-head"><div><div class="pipeline-kicker">Stage 1</div><h3>Search and candidate discovery</h3></div><span class="badge bg-blue-lt">Shared input</span></div>'
    +     '<div class="provider-grid">'
    +       '<div class="wide"><label class="form-check form-switch"><input class="form-check-input" type="checkbox" name="diyNativeSearchEnabled" value="on"' + (cfg.diyNativeSearchEnabled === true ? ' checked' : '') + '><span class="form-check-label"><strong>Enable native Usenet text search</strong></span></label></div>'
    +       '<div><label class="form-label" for="diy-search-kind">Search service</label><select class="form-select" id="diy-search-kind" name="diySearchKind"><option value="newznab"' + (cfg.diySearchKind !== 'prowlarr' ? ' selected' : '') + '>Newznab / NZBHydra</option><option value="prowlarr"' + (cfg.diySearchKind === 'prowlarr' ? ' selected' : '') + '>Prowlarr</option></select></div>'
    +       '<div><label class="form-label" for="diy-search-name">Display name</label><input class="form-control" type="text" id="diy-search-name" name="diySearchName" value="' + escapeHtml(cfg.diySearchName || '') + '" placeholder="NZBHydra or NZBGeek"></div>'
    +       '<div><label class="form-label" for="diy-search-url">Search URL</label><input class="form-control text-mono" type="url" id="diy-search-url" name="diySearchUrl" value="' + escapeHtml(cfg.diySearchUrl || '') + '" placeholder="http://nzbhydra2:5076 or http://prowlarr:9696"></div>'
    +       '<div>' + secretField('Search API key', 'diySearchApiKey', cfg.diySearchApiKey, 'paste the indexer or manager API key') + '</div>'
    +       '<div><label class="form-label" for="diy-search-test-query">Test query</label><input class="form-control" type="text" id="diy-search-test-query" name="diySearchTestQuery" value="UFC" maxlength="200"></div>'
    +       '<div class="d-flex align-items-end"><button class="btn btn-outline-primary w-100" type="submit" formaction="/account/test-diy-search" formnovalidate>Test native search</button></div>'
    +       '<div class="wide"><label class="form-check form-switch"><input class="form-check-input" type="checkbox" name="diyUuSearchEnabled" value="on"' + (cfg.diyUuSearchEnabled !== false ? ' checked' : '') + '><span class="form-check-label">Also use UU text search for DIY results</span></label><div class="form-hint">Turn this off to validate SSS native search without UU. This does not control UU’s own stream rows.</div></div>'
    +     '</div></section>'
    +     '<section class="pipeline-stage"><div class="pipeline-stage-head"><div><div class="pipeline-kicker">Stage 2</div><h3>Playback backends</h3></div><span class="badge bg-green-lt">Choose one or both</span></div>'
    +     '<div class="pipeline-backends">'
    +       '<div class="pipeline-backend"><div class="d-flex justify-content-between gap-2 mb-2"><div><h4 class="h4 mb-1">NZB DAV</h4><div class="text-secondary small">Complete download and WebDAV playback, including archive releases.</div></div><span class="badge bg-green-lt align-self-start">Stable</span></div>'
    +         '<label class="form-check form-switch mb-3"><input class="form-check-input" type="checkbox" name="diyUsenetEnabled" value="on"' + (cfg.diyUsenetEnabled === true ? ' checked' : '') + '><span class="form-check-label"><strong>Enable NZB DAV rows</strong></span></label>'
    +         '<div class="provider-grid">'
    +           '<div><label class="form-label" for="nzbdav-url">API URL</label><input class="form-control text-mono" type="url" id="nzbdav-url" name="nzbdavUrl" value="' + escapeHtml(cfg.nzbdavUrl || '') + '" placeholder="http://nzbdav:3000"></div>'
    +           '<div>' + secretField('API key', 'nzbdavApiKey', cfg.nzbdavApiKey, 'paste the NZB DAV API key') + '</div>'
    +           '<div><label class="form-label" for="nzbdav-webdav-url">WebDAV URL</label><input class="form-control text-mono" type="url" id="nzbdav-webdav-url" name="nzbdavWebdavUrl" value="' + escapeHtml(cfg.nzbdavWebdavUrl || '') + '" placeholder="http://nzbdav:3000"></div>'
    +           '<div><label class="form-label" for="nzbdav-webdav-user">WebDAV username</label><input class="form-control" type="text" id="nzbdav-webdav-user" name="nzbdavWebdavUsername" value="' + escapeHtml(cfg.nzbdavWebdavUsername || '') + '" autocomplete="off"></div>'
    +           '<div>' + secretField('WebDAV password', 'nzbdavWebdavPassword', cfg.nzbdavWebdavPassword, 'your WebDAV password') + '</div>'
    +         '</div><button class="btn btn-outline-primary mt-3 w-100" type="submit" formaction="/account/test-nzbdav" formnovalidate>Test NZB DAV pipeline</button></div>'
    +       '<div class="pipeline-backend"><div class="d-flex justify-content-between gap-2 mb-2"><div><h4 class="h4 mb-1">Native NNTP</h4><div class="text-secondary small">Instant range streaming for direct files and stored RAR4/RAR5 videos.</div></div><span class="badge bg-azure-lt align-self-start">Preview</span></div>'
    +         '<label class="form-check form-switch mb-3"><input class="form-check-input" type="checkbox" name="nativeNntpEnabled" value="on"' + (cfg.nativeNntpEnabled === true ? ' checked' : '') + '><span class="form-check-label"><strong>Enable native NNTP rows</strong></span></label>'
    +         '<div class="provider-grid">'
    +           '<div><label class="form-label" for="nntp-host">NNTP host</label><input class="form-control text-mono" id="nntp-host" name="nntpHost" value="' + escapeHtml(cfg.nntpHost || '') + '" placeholder="news.provider.example"></div>'
    +           '<div><label class="form-label" for="nntp-port">Port</label><input class="form-control" type="number" min="1" max="65535" id="nntp-port" name="nntpPort" value="' + escapeHtml(String(cfg.nntpPort || 563)) + '"></div>'
    +           '<div><label class="form-label" for="nntp-user">Username</label><input class="form-control" id="nntp-user" name="nntpUsername" value="' + escapeHtml(cfg.nntpUsername || '') + '" autocomplete="off"></div>'
    +           '<div>' + secretField('Password', 'nntpPassword', cfg.nntpPassword, 'your NNTP password') + '</div>'
    +           '<div><label class="form-label" for="nntp-connections">Maximum connections</label><input class="form-control" type="number" min="1" max="50" id="nntp-connections" name="nntpConnections" value="' + escapeHtml(String(cfg.nntpConnections || 20)) + '"><div class="form-hint">20 recommended; sockets are pre-authenticated, pooled, and reused. Do not exceed your provider limit.</div></div>'
    +           '<div class="d-flex align-items-center"><label class="form-check form-switch mt-3"><input class="form-check-input" type="checkbox" name="nntpTls" value="on"' + (cfg.nntpTls !== false ? ' checked' : '') + '><span class="form-check-label">Use TLS (recommended)</span></label></div>'
    +         '</div><button class="btn btn-outline-primary mt-3 w-100" type="submit" formaction="/account/test-nntp" formnovalidate>Test NNTP pipeline</button></div>'
    +     '</div>'
    +     '<div class="pipeline-output"><span class="badge bg-secondary-lt">Shared filtered results</span><span class="badge bg-green-lt">📦 NZB DAV rows</span><span class="badge bg-azure-lt">⚡ Native NNTP rows</span><span class="badge bg-secondary-lt">Independent toggles</span></div>'
    +     '</section>'
    +   '</div></details>'
    +   '<details class="config-fold"><summary>Catalogs and display order</summary>' + catalogsPanel + '</details>'
    +   '<details class="config-fold"><summary>Advanced playback settings</summary><div class="config-fold-body">'
    +     '<div class="provider-grid">'
    +       '<div><label class="form-label">Maximum results per event</label><input class="form-control" type="number" name="maxStreams" min="0" max="20" value="' + escapeHtml(String(cfg.maxStreams || 0)) + '"><div class="form-hint">0 uses the server default (' + escapeHtml(String(defaultMaxStreams)) + ').</div></div>'
    +       '<div><label class="form-check form-switch mt-4"><input class="form-check-input" type="checkbox" name="showWarmRows" value="on"' + ((cfg.showWarmRows !== false) ? ' checked' : '') + '><span class="form-check-label">Show warm-to-cache rows for uncached TorBox results</span></label></div>'
    +     '</div>'
    +   '</div></details>'
    +   '<div class="save-bar"><button class="btn btn-primary" type="submit">Save configuration</button><span class="text-secondary small">Saves services, catalogs, ordering, and advanced settings together.</span></div>'
    +   '<section class="config-block"><div class="config-block-head">Install and export</div><div class="config-block-body">'
    +     '<div class="session-note mb-3"><strong>No second editing link.</strong> Return to <code>/account</code> and sign in whenever you want to change this configuration.</div>'
    +     '<div class="product-grid">'
    +       '<div class="product-card"><h3>Stremio addon</h3><p class="text-secondary small">Install the current private manifest or copy it into another compatible client.</p><div class="d-flex flex-wrap gap-2"><a class="btn btn-primary" href="' + escapeHtml(stremioInstallUrl) + '">Install Stremio</a><button class="btn btn-outline-primary" type="button" id="copyUrlBtn">Copy manifest</button></div></div>'
    +       '<div class="product-card"><h3>Nuvio collection</h3><p class="text-secondary small">Export folders using the enabled catalogs and saved order.</p><div class="d-flex flex-wrap gap-2"><a class="btn btn-primary" href="/account/nuvio-collections.json" download>Download JSON</a><button class="btn btn-outline-primary" type="button" id="copyNuvioJsonBtn">Copy JSON</button></div><span class="text-secondary small" id="copyNuvioJsonStatus" aria-live="polite"></span></div>'
    +     '</div>'
    +     '<div class="manifest-output"><label class="form-label">Your private manifest URL</label><div class="input-group"><input class="form-control text-mono" id="murl" value="' + escapeHtml(installUrl) + '" readonly><button class="btn btn-outline-success" type="button" id="copyUrlOutputBtn">Copy</button></div></div>'
    +     '<textarea id="nuvioJsonPayload" class="d-none" tabindex="-1" aria-hidden="true" readonly>' + escapeHtml(nuvioJson) + '</textarea>'
    +     '<div class="config-management"><button class="btn btn-outline-danger" type="submit" formaction="/account/regenerate-token" formnovalidate onclick="return confirm(\'Rotate the manifest? Your current install URL stops working immediately.\');">Rotate manifest URL</button></div>'
    +   '</div></section>'
    + '</form>'
    + '</main>'

    // Inline JS: copy install URL + toggle password reveal. Same logic as
    // before, just rebound to Tabler's input-group markup.
    + '<script>'
    + '(function(){'
    +   'var buttons=[document.getElementById("copyUrlBtn"),document.getElementById("copyUrlOutputBtn")], code = document.getElementById("murl");'
    +   'buttons.forEach(function(btn){if(!btn||!code)return;btn.addEventListener("click", function() {'
    +     'var t = code.value;'
    +     'if (navigator.clipboard) { navigator.clipboard.writeText(t); }'
    +     'var old=btn.textContent;btn.textContent = "Copied!"; setTimeout(function(){ btn.textContent = old; }, 1800);'
    +   '});});'
    + '})();'
    + '(function(){'
    +   'var btn=document.getElementById("copyNuvioJsonBtn"),status=document.getElementById("copyNuvioJsonStatus"),payload=document.getElementById("nuvioJsonPayload");if(!btn||!payload)return;'
    +   'function legacyCopy(text){var area=document.createElement("textarea");area.value=text;area.setAttribute("readonly","");area.style.position="fixed";area.style.left="0";area.style.top="0";area.style.width="2px";area.style.height="2px";area.style.opacity=".01";document.body.appendChild(area);area.focus();area.select();area.setSelectionRange(0,area.value.length);var ok=false;try{ok=document.execCommand("copy");}finally{document.body.removeChild(area);}if(!ok)throw new Error("Browser blocked copying — use Download JSON");}'
    +   'function done(){if(status)status.textContent="Copied — paste into Nuvio Collections import.";btn.disabled=false;}'
    +   'function failed(err){try{legacyCopy(payload.value);done();}catch(_){if(status)status.textContent=(err&&err.message)||"Browser blocked copying — use Download JSON";btn.disabled=false;}}'
    +   'btn.addEventListener("click",function(){btn.disabled=true;if(status)status.textContent="Copying…";var text=payload.value;if(navigator.clipboard&&navigator.clipboard.writeText&&window.isSecureContext){navigator.clipboard.writeText(text).then(done).catch(failed);}else{try{legacyCopy(text);done();}catch(err){failed(err);}}});'
    + '})();'
    + 'document.addEventListener("click", function(e){'
    +   'var a = e.target && e.target.closest ? e.target.closest(".btn-reveal") : null;'
    +   'if (!a) return; e.preventDefault();'
    +   'var grp = a.closest(".input-group"); if (!grp) return;'
    +   'var i = grp.querySelector("input"); if (!i) return;'
    +   'var show = i.type === "password"; i.type = show ? "text" : "password";'
    +   'a.textContent = show ? "Hide" : "Show";'
    + '});'
    + '(function(){'
    +   'var root=document.getElementById("catalog-promotion-order"),promotionInput=document.getElementById("promotion-order"),catalogInput=document.getElementById("catalog-order");'
    +   'if(!root||!promotionInput||!catalogInput)return;'
    +   'var active=null,kind="",pointerId=null,activeHandle=null;'
    +   'function list(parent,selector){return Array.prototype.slice.call(parent.querySelectorAll(":scope > "+selector));}'
    +   'function sync(){promotionInput.value=list(root,".catalog-sort-group").map(function(x){return x.getAttribute("data-promotion-id");}).join(",");catalogInput.value=Array.prototype.slice.call(root.querySelectorAll(".catalog-sort-item")).map(function(x){return x.getAttribute("data-catalog-id");}).join(",");}'
    +   'function fromHandle(handle){if(handle.classList.contains("promotion-drag-handle"))return {item:handle.closest(".catalog-sort-group"),kind:"promotion"};return {item:handle.closest(".catalog-sort-item"),kind:"catalog"};}'
    +   'function targetAt(el){if(!active)return null;var selector=kind==="promotion"?".catalog-sort-group":".catalog-sort-item";var target=el&&el.closest?el.closest(selector):null;if(!target||target===active)return null;if(kind==="catalog"&&target.parentElement!==active.parentElement)return null;return target;}'
    +   'function place(target,y){if(!target)return;var r=target.getBoundingClientRect(),after=y>r.top+r.height/2;target.parentElement.insertBefore(active,after?target.nextSibling:target);sync();}'
    +   'function finish(){if(active)active.classList.remove("sorting");if(activeHandle&&pointerId!==null&&activeHandle.hasPointerCapture&&activeHandle.hasPointerCapture(pointerId))activeHandle.releasePointerCapture(pointerId);active=null;activeHandle=null;kind="";pointerId=null;sync();}'
    +   'root.addEventListener("pointerdown",function(e){var h=e.target.closest(".promotion-drag-handle,.catalog-drag-handle");if(!h||e.button>0)return;var d=fromHandle(h);active=d.item;activeHandle=h;kind=d.kind;pointerId=e.pointerId;active.classList.add("sorting");if(h.setPointerCapture)h.setPointerCapture(e.pointerId);e.preventDefault();});'
    +   'root.addEventListener("pointermove",function(e){if(pointerId!==e.pointerId||!active)return;place(targetAt(document.elementFromPoint(e.clientX,e.clientY)),e.clientY);e.preventDefault();});'
    +   'root.addEventListener("pointerup",function(e){if(pointerId===e.pointerId)finish();});'
    +   'root.addEventListener("pointercancel",finish);'
    +   'root.addEventListener("keydown",function(e){var h=e.target.closest(".promotion-drag-handle,.catalog-drag-handle");if(!h||!["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.key))return;var d=fromHandle(h),items=d.kind==="promotion"?list(root,".catalog-sort-group"):list(d.item.parentElement,".catalog-sort-item"),i=items.indexOf(d.item),back=e.key==="ArrowUp"||e.key==="ArrowLeft",j=back?i-1:i+1;if(j<0||j>=items.length)return;e.preventDefault();if(back)d.item.parentElement.insertBefore(d.item,items[j]);else d.item.parentElement.insertBefore(d.item,items[j].nextSibling);sync();h.focus();});'
    +   'var form=root.closest("form");if(form)form.addEventListener("submit",sync);sync();'
    + '})();'
    + '</script>';

  return tablerChrome.tablerPage('Account', body, { user, currentSection: 'account' });
}


function accountPage(title, bodyHtml, bodyClass) {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>' + escapeHtml(title) + ' - SeriousSportSync</title>',
    '<style>',
    ':root{--bg:#0a0a0a;--panel:#141417;--text:#f1f1f4;--muted:#8a8a93;--accent:#d20a11;--accent2:#ff2d36;--ok:#2eaa55;--border:#26262c;}',
    '*{box-sizing:border-box;}',
    'body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:radial-gradient(circle at 20% 0%,#1a0608 0%,var(--bg) 50%);color:var(--text);min-height:100vh;}',
    '.wrap{max-width:680px;margin:0 auto;padding:48px 24px;}',
    '.brand{display:flex;align-items:center;gap:12px;margin-bottom:20px;}',
    '.brand .logo{width:44px;height:44px;background:linear-gradient(135deg,var(--accent),var(--accent2));border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:900;color:#fff;font-size:12px;}',
    '.brand h1{margin:0;font-size:22px;font-weight:700;display:flex;align-items:center;gap:10px;}',
    '.app-version{font-size:11px;font-weight:500;color:var(--muted);background:rgba(255,255,255,0.06);padding:2px 8px;border-radius:6px;letter-spacing:.04em;}',
    '.brand p{margin:2px 0 0;color:var(--muted);font-size:13px;}',
    '.card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:24px;}',
    'h2{margin:0 0 16px;font-size:16px;font-weight:600;}',
    'h3.sec{margin:24px 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:600;}',
    '.hint{color:var(--muted);font-size:12px;margin:0 0 10px;line-height:1.5;}',
    '.lbl{display:block;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em;margin:14px 0 6px;}',
    '.inp{width:100%;padding:11px 13px;background:#0a0a0d;color:var(--text);border:1px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit;}',
    '.inp.mono{font-family:"SF Mono",monospace;font-size:12px;}',
    '.secret-row{display:flex;gap:8px;align-items:stretch;}',
    '.secret-row .inp{flex:1;}',
    '.btn-reveal{flex:0 0 auto;border:1px solid var(--border);background:#13131a;color:var(--muted);border-radius:8px;padding:0 16px;font-size:12px;cursor:pointer;font-family:inherit;}',
    '.btn-reveal:hover{color:var(--text);border-color:var(--accent);}',
    '.inp:focus{outline:0;border-color:var(--accent);}',
    '.btn-install{appearance:none;border:0;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-weight:600;width:100%;padding:13px;font-size:14px;margin-top:18px;border-radius:8px;cursor:pointer;}',
    '.btn-copy{appearance:none;background:var(--border);color:var(--text);border:0;padding:9px 14px;font-size:12px;border-radius:6px;cursor:pointer;}',
    '.btn-copy:hover{filter:brightness(1.3);}',
    'table.info{width:100%;border-collapse:collapse;font-size:13px;}',
    'table.info th{text-align:left;color:var(--muted);font-weight:500;padding:6px 12px 6px 0;width:110px;vertical-align:top;}',
    'table.info td{padding:6px 0;color:var(--text);word-break:break-all;}',
    '.url-row{display:flex;gap:8px;align-items:center;}',
    '.url-row code{flex:1;background:#0a0a0d;border:1px solid var(--border);padding:10px 12px;border-radius:6px;color:var(--text);font-size:12px;overflow:auto;white-space:nowrap;font-family:"SF Mono",monospace;}',
    '.install-cell{max-width:360px;}',
    '.install-url{display:inline-block;max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle;background:#0a0a0d;border:1px solid var(--border);padding:6px 9px;border-radius:6px;color:var(--muted);font-size:11px;font-family:"SF Mono",monospace;}',
    '.btn-copy-sm{padding:5px 10px;font-size:11px;vertical-align:middle;}',
    '.flash{background:#0d2818;border:1px solid #1f5232;color:#7eda9a;padding:10px 14px;border-radius:8px;font-size:13px;margin-top:18px;}',
    '.cats{display:flex;flex-direction:column;gap:14px;}',
    '.cat-group{background:#0a0a0d;border:1px solid var(--border);border-radius:8px;padding:12px 14px;}',
    '.cat-group-title{font-size:12px;font-weight:600;color:var(--accent2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;}',
    '.cat{display:block;padding:4px 0;font-size:13px;color:var(--text);cursor:pointer;}',
    '.cat input{margin-right:8px;}',
    /* Tabbed account page */
    '.tabs-form{margin-top:8px;}',
    '.tabs{margin:0 0 24px;position:relative;}',
    '.tabs > input[type="radio"]{position:absolute;left:-9999px;opacity:0;pointer-events:none;}',
    '.tabstrip{display:flex;gap:2px;border-bottom:1px solid var(--border);overflow-x:auto;background:rgba(0,0,0,0.25);border-radius:8px 8px 0 0;}',
    '.tabstrip label{padding:14px 22px;cursor:pointer;color:var(--muted);font-size:14px;font-weight:500;user-select:none;white-space:nowrap;border-bottom:2px solid transparent;border-radius:8px 8px 0 0;transition:all 0.15s ease;}',
    '.tabstrip label:hover{color:var(--text);background:rgba(255,255,255,0.04);}',
    '.tab-panel{display:none;padding:24px 4px 8px;}',
    '#t-services:checked ~ .tabstrip label[for="t-services"]{color:var(--accent);border-bottom-color:var(--accent);background:rgba(210,10,17,0.08);}',
    '#t-catalogs:checked ~ .tabstrip label[for="t-catalogs"]{color:var(--accent);border-bottom-color:var(--accent);background:rgba(210,10,17,0.08);}',
    '#t-manifest:checked ~ .tabstrip label[for="t-manifest"]{color:var(--accent);border-bottom-color:var(--accent);background:rgba(210,10,17,0.08);}',
    '#t-services:checked ~ .tab-panel[data-tab="services"]{display:block;}',
    '#t-catalogs:checked ~ .tab-panel[data-tab="catalogs"]{display:block;}',
    '#t-manifest:checked ~ .tab-panel[data-tab="manifest"]{display:block;}',
    /* User header */
    '.user-header{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;margin:0 0 18px;background:rgba(255,255,255,0.025);border-radius:8px;border:1px solid var(--border);}',
    '.user-header-left{font-size:14px;}',
    '.user-header-right{display:flex;gap:14px;align-items:center;font-size:13px;}',
    '.header-link{color:var(--accent);text-decoration:none;font-weight:500;}',
    '.header-link:hover{text-decoration:underline;}',
    /* Role badges */
    '.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;}',
    '.badge-admin{background:rgba(255,80,80,0.15);color:#ff6f6f;}',
    '.badge-user{background:rgba(120,160,255,0.15);color:#7eb1ff;}',
    /* Small buttons + danger */
    '.btn-sm{background:transparent;border:1px solid var(--border);color:var(--text);padding:5px 10px;font-size:12px;border-radius:6px;cursor:pointer;}',
    '.btn-sm:hover{border-color:var(--accent);color:var(--accent);}',
    '.btn-danger{background:transparent;border:1px solid rgba(255,80,80,0.4);color:#ff6f6f;padding:5px 10px;font-size:12px;border-radius:6px;cursor:pointer;}',
    '.btn-danger:hover{background:rgba(255,80,80,0.1);border-color:#ff6f6f;}',
    /* Form action bar */
    '.form-actions{display:flex;align-items:center;gap:14px;margin-top:8px;padding-top:18px;border-top:1px solid var(--border);}',
    '.form-actions-hint{color:var(--muted);font-size:12px;}',
    /* Admin user table */
    'table.user-list{width:100%;border-collapse:collapse;margin:8px 0 24px;font-size:13px;}',
    'table.user-list th{text-align:left;color:var(--muted);font-weight:500;padding:8px 10px;border-bottom:1px solid var(--border);}',
    'table.user-list td{padding:10px;border-bottom:1px solid var(--border);vertical-align:middle;}',
    'table.user-list tbody tr:hover{background:rgba(255,255,255,0.02);}',
    /* Admin actions cell — stack vertically */
    'td.admin-actions{padding:10px;vertical-align:top;min-width:220px;}',
    'td.admin-actions > *{display:block;margin-bottom:6px;}',
    'td.admin-actions > *:last-child{margin-bottom:0;}',
    'td.admin-actions form{margin:0;}',
    'td.admin-actions details{margin:0;}',
    'td.admin-actions details summary{display:inline-block;padding:5px 10px;list-style:none;cursor:pointer;border:1px solid var(--border);border-radius:6px;font-size:12px;}',
    'td.admin-actions details summary:hover{border-color:var(--accent);color:var(--accent);}',
    /* Wider container for admin page (default 680 is too tight) */
    'body.admin .wrap{max-width:1100px;}',
        'code{font-family:"SF Mono",monospace;font-size:12px;}',
    'a{color:var(--accent2);text-decoration:none;}a:hover{text-decoration:underline;}',
    '</style></head><body class="' + (bodyClass || '') + '"><div class="wrap">',
    '<div class="brand"><div class="logo">SSS</div><div><h1>SeriousSportSync <span class="app-version">v' + escapeHtml(APP_VERSION) + '</span></h1><p>' + escapeHtml(title) + '</p></div></div>',
    '<div class="card"><h2>' + escapeHtml(title) + '</h2>',
    bodyHtml,
    '</div></div></body></html>',
  ].join('');
}

// 0.37.0: authPage now delegates to the Tabler 'auth' layout (centered card).
// All existing callers (login / invite / setup / sign-in errors) keep the
// same (title, bodyHtml) signature; the body just goes inside the Tabler
// card. The legacy CSS block below is preserved verbatim because the
// other (yet-to-be-converted) admin pages still consume it via accountPage().
// Once all admin pages move to tablerChrome the whole block can be deleted.
function authPage(title, bodyHtml) {
  return tablerChrome.tablerPage(title, bodyHtml, { layout: 'auth' });
}

function _legacyAuthPageUnused(title, bodyHtml) {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>' + escapeHtml(title) + ' - SeriousSportSync</title>',
    '<style>',
    ':root{--bg:#0a0a0a;--panel:#141417;--text:#f1f1f4;--muted:#8a8a93;--accent:#d20a11;--accent2:#ff2d36;--border:#26262c;}',
    '*{box-sizing:border-box;}',
    'body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:radial-gradient(circle at 20% 0%,#1a0608 0%,var(--bg) 50%);color:var(--text);min-height:100vh;}',
    '.wrap{max-width:480px;margin:0 auto;padding:48px 24px;}',
    '.brand{display:flex;align-items:center;gap:12px;margin-bottom:20px;}',
    '.brand .logo{width:44px;height:44px;background:linear-gradient(135deg,var(--accent),var(--accent2));border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:900;color:#fff;font-size:12px;}',
    '.brand h1{margin:0;font-size:22px;font-weight:700;display:flex;align-items:center;gap:10px;}',
    '.app-version{font-size:11px;font-weight:500;color:var(--muted);background:rgba(255,255,255,0.06);padding:2px 8px;border-radius:6px;letter-spacing:.04em;}',
    '.brand p{margin:2px 0 0;color:var(--muted);font-size:13px;}',
    '.card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:24px;}',
    '.inp{width:100%;padding:12px 14px;background:#0a0a0d;color:var(--text);border:1px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit;}',
    '.inp:focus{outline:0;border-color:var(--accent);}',
    '.btn-install{appearance:none;border:0;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-weight:600;width:100%;padding:14px;font-size:15px;margin-top:18px;border-radius:8px;cursor:pointer;}',
    '.btn-copy{appearance:none;background:var(--border);color:var(--text);border:0;padding:10px 16px;font-size:13px;border-radius:8px;cursor:pointer;}',
    'table.info{width:100%;border-collapse:collapse;font-size:13px;}',
    'table.info th{text-align:left;color:var(--muted);font-weight:500;padding:8px 12px 8px 0;width:120px;vertical-align:top;}',
    'table.info td{padding:8px 0;color:var(--text);word-break:break-all;}',
    'table.user-list{width:100%;border-collapse:collapse;margin:8px 0 24px;font-size:13px;}',
    'table.user-list th{text-align:left;color:var(--muted);font-weight:500;padding:8px 10px;border-bottom:1px solid var(--border);}',
    'table.user-list td{padding:10px;border-bottom:1px solid var(--border);vertical-align:middle;}',
    'table.user-list tbody tr:hover{background:rgba(255,255,255,0.02);}',
    '.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;}',
    '.badge-admin{background:rgba(255,80,80,0.15);color:#ff6f6f;}',
    '.badge-user{background:rgba(120,160,255,0.15);color:#7eb1ff;}',
    '.btn-sm{background:transparent;border:1px solid var(--border);color:var(--text);padding:5px 10px;font-size:12px;border-radius:6px;cursor:pointer;}',
    '.btn-sm:hover{border-color:var(--accent);color:var(--accent);}',
    '.btn-danger{background:transparent;border:1px solid rgba(255,80,80,0.4);color:#ff6f6f;padding:5px 10px;font-size:12px;border-radius:6px;cursor:pointer;}',
    '.btn-danger:hover{background:rgba(255,80,80,0.1);border-color:#ff6f6f;}',
    /* Tabbed account page */
    '.tabs-form{margin-top:8px;}',
    '.tabs{margin:0 0 24px;}',
    '.tabs > input[type="radio"]{display:none;}',
    '.tabstrip{display:flex;gap:4px;border-bottom:1px solid var(--border);margin-bottom:0;overflow-x:auto;}',
    '.tabstrip label{padding:14px 22px;cursor:pointer;color:var(--muted);border-bottom:2px solid transparent;font-size:14px;font-weight:500;transition:color 0.12s,border-color 0.12s;user-select:none;white-space:nowrap;}',
    '.tabstrip label:hover{color:var(--text);}',
    '.tab-panel{display:none;padding:24px 4px 8px;animation:fadeIn 0.18s ease-out;}',
    '@keyframes fadeIn{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:none;}}',
    '#t-services:checked ~ .tabstrip label[for="t-services"],',
    '#t-catalogs:checked ~ .tabstrip label[for="t-catalogs"],',
    '#t-manifest:checked ~ .tabstrip label[for="t-manifest"]{color:var(--accent);border-bottom-color:var(--accent);}',
    '#t-services:checked ~ .tab-panel[data-tab="services"],',
    '#t-catalogs:checked ~ .tab-panel[data-tab="catalogs"],',
    '#t-manifest:checked ~ .tab-panel[data-tab="manifest"]{display:block;}',
    /* User header */
    '.user-header{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;margin:0 0 18px;background:rgba(255,255,255,0.025);border-radius:8px;border:1px solid var(--border);}',
    '.user-header-left{font-size:14px;}',
    '.user-header-right{display:flex;gap:14px;align-items:center;font-size:13px;}',
    '.header-link{color:var(--accent);text-decoration:none;font-weight:500;}',
    '.header-link:hover{text-decoration:underline;}',
    /* Form action bar */
    '.form-actions{display:flex;align-items:center;gap:14px;margin-top:8px;padding-top:18px;border-top:1px solid var(--border);}',
    '.form-actions-hint{color:var(--muted);font-size:12px;}',
    /* Admin actions column — stack buttons vertically with consistent spacing */
    'td.admin-actions{padding:10px;vertical-align:top;min-width:220px;}',
    'td.admin-actions > *{display:block;margin-bottom:6px;}',
    'td.admin-actions > *:last-child{margin-bottom:0;}',
    'td.admin-actions form{margin:0;}',
    'td.admin-actions details{margin:0;}',
    'td.admin-actions details summary{display:inline-block;padding:5px 10px;}',
    'code{font-family:"SF Mono",monospace;font-size:12px;background:#0a0a0d;padding:2px 6px;border-radius:4px;border:1px solid var(--border);}',
    'a{color:var(--accent2);text-decoration:none;}a:hover{text-decoration:underline;}',
    'h2{margin:0 0 16px;font-size:16px;font-weight:600;}',
    '</style></head><body><div class="wrap">',
    '<div class="brand"><div class="logo">SSS</div><div><h1>SeriousSportSync <span class="app-version">v' + escapeHtml(APP_VERSION) + '</span></h1><p>' + escapeHtml(title) + '</p></div></div>',
    '<div class="card"><h2>' + escapeHtml(title) + '</h2>',
    bodyHtml,
    '</div></div></body></html>',
  ].join('');
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, function(c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function parseExtra(segment) {
  const out = {};
  if (!segment) return out;
  const decoded = decodeURIComponent(segment);
  for (const part of decoded.split('&')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

module.exports = { createApp, setFreshStreamHeaders };
