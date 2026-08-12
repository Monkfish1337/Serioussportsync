const express = require('express');
const path = require('path');
const config = require('./config');
const { buildManifest } = require('./lib/manifest');
const { handleCatalog } = require('./lib/catalog');
const { handleMeta } = require('./lib/meta');
const { handleStream, resolvePlay } = require('./lib/streams');
const store = require('./lib/store');
const streamcache = require('./lib/streamcache');
const settings = require('./lib/settings');
const { runStreamRefresh, readStatus: readWarmerStatus } = require('./scripts/refresh-streams');
const { runRefresh: runEventsRefresh } = require('./scripts/refresh');
const promotions = require('./lib/promotions');
const users = require('./lib/users');
const sessions = require('./lib/sessions');
// 0.24.0: per-provider state modules for the admin /health page.
const rdDenylist = require('./lib/rd-denylist');
const tbDenylist = require('./lib/tb-denylist');
const pmDenylist = require('./lib/pm-denylist');
const positiveCache = require('./lib/positive-cache');
// 0.27.0: in-memory log buffer for /admin/logs.
const logBuffer = require('./lib/log-buffer');
// 0.28.0: per-event admin power tool.
const powerTool = require('./lib/power-tool');
// 0.37.0: Tabler-based page chrome (sidebar + topbar + container layout).
// Used by all post-0.37.0 page renders; the legacy accountPage() wrapper
// below remains for any unconverted pages and is removed once all renders
// use tablerChrome.tablerPage().
const tablerChrome = require('./lib/tabler-chrome');
const APP_VERSION = require('./package.json').version || '?';


// Compute the public origin (scheme://host) for an incoming request. Honors
// X-Forwarded-Proto/Host (set by cloudflared, nginx, etc.) so that links we
// generate in HTML reflect the user's actual entry URL, not the internal
// container address. Falls back to req.protocol/host, then to PUBLIC_URL env.
function publicOriginFromReq(req) {
  if (req) {
    const xfp = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const xfh = (req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    const proto = xfp || req.protocol || 'http';
    const host = xfh || req.headers.host || '';
    if (host) return proto + '://' + host;
  }
  if (config.publicUrl) return config.publicUrl.replace(/\/+$/, '');
  return '';
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
  // Cloudflare Tunnel forwards the real IP in CF-Connecting-IP. Fall through
  // to the standard proxy chain header, then the socket address.
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
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
  const app = express();
  app.disable('x-powered-by');

  app.use(express.urlencoded({ extended: false, limit: '16kb' }));

  // Attach req.user from session cookie if present.
  function loadSession(req, res, next) {
    const sess = sessions.readSession(req);
    if (sess && sess.userId) {
      const u = users.findById(sess.userId);
      if (u) {
        req.user = u;
        users.touchLastSeen(u.id);
      }
    }
    next();
  }
  app.use(loadSession);

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

  // CORS — needed for the Stremio install URL.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Branded artwork (UFC/WWE upcoming logo cards, etc). Public, no auth.
  app.use('/assets', express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));

  function send(res, payload, opts) {
    const o = opts || {};
    res.setHeader('Cache-Control', o.cacheControl || 'public, max-age=3600');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(JSON.stringify(payload));
  }

  // --- Public: health -------------------------------------------------
  app.get('/health', (req, res) => {
    const events = store.getEvents();
    const meta = store.loadFromDisk() || {};
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const companion = settings.getCompanion();
    const newsnab = settings.getNewsnab();
    res.send(JSON.stringify({
      ok: true,
      events: events.length,
      updatedAt: meta.updatedAt || null,
      companionConfigured: !!(companion && companion.url),
      newsnabConfigured: !!(newsnab && newsnab.url && newsnab.apiKey),
      accountsEnabled: true,
      promotions: promotions.enabled.map((p) => p.id),
      userCount: users.userCount(),
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
      sessions.setCookie(res, u.id, req);
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
    sessions.setCookie(res, u.id, req);
    users.touchLastSeen(u.id);
    res.redirect('/account');
  });

  app.post('/logout', (req, res) => { sessions.clearCookie(res, req); res.redirect('/login'); });
  app.get('/logout',  (req, res) => { sessions.clearCookie(res, req); res.redirect('/login'); });

  app.get('/account', requireLogin, (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderAccountPage(req.user, { flash: req.query.flash || null, origin: publicOriginFromReq(req) }));
  });

  app.post('/account/save', requireLogin, (req, res) => {
    const b = req.body || {};
    // Collect selected catalogs (empty = all). Stremio sends repeated form
    // fields with the same name; express.urlencoded returns string or array.
    const cats = Array.isArray(b.catalogs) ? b.catalogs : (b.catalogs ? [b.catalogs] : []);
    const allCatalogIds = new Set();
    for (const p of promotions.enabled) for (const c of p.catalogs) allCatalogIds.add(c.id);
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
        uuManifestUrl: String(b.uuManifestUrl || '').trim(),
        torboxApiKey: String(b.torboxApiKey || '').trim(),
        easynewsUsername: String(b.easynewsUsername || '').trim(),
        easynewsPassword: String(b.easynewsPassword || ''),
        catalogs: finalCats,
        maxStreams,
        // 0.38.0: warm-to-cache pseudo-streams toggle (default true).
        showWarmRows: b.showWarmRows === 'on' || b.showWarmRows === '1' || b.showWarmRows === 'true',
      });
      res.redirect('/account?flash=saved');
    } catch (err) {
      res.redirect('/account?flash=' + encodeURIComponent('Save failed: ' + err.message));
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

    r.get('/manifest.json', (req, res) => {
      send(res, buildManifest({ user: req.userAccount, origin: publicOriginFromReq(req) }));
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
        send(res, result, { cacheControl: req.query.debug ? 'no-store' : 'public, max-age=300' });
      } catch (err) {
        console.error('[stream] user-route handler error:', err);
        send(res, { streams: [] });
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
        });
        if (out && out.url) {
          res.setHeader('Cache-Control', 'no-store');
          return res.redirect(302, out.url);
        }
        // Not cached / unresolvable on this provider — tell the player plainly.
        res.status(404).send('Not cached on ' + provider + ' (or no longer available).');
      } catch (err) {
        console.error('[resolve] handler error:', err);
        res.status(502).send('Resolve failed.');
      }
    });

    // 0.38.0: Warm-to-cache route. Submits the magnet to the user's TorBox
    // account (the side-effectful add we deliberately avoid in /stream and
    // /resolve), then redirects to a tiny placeholder MP4 so Stremio's
    // player has something to display. Rate-limited per-user to keep TB
    // 429-safe under button-mashing.
    const torboxResolverLib = require('./lib/sources/torbox-resolver');
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

      // Rate-limit gate.
      const rl = warmRateLimit.check(userId);
      if (!rl.ok) {
        log('rate-limited; retry in ' + rl.retryAfterSec + 's');
        res.setHeader('Retry-After', String(rl.retryAfterSec));
        return res.redirect(302, '/assets/warm-rate-limited.mp4');
      }

      // Hash sanity check.
      if (!/^[a-f0-9]{40}$/i.test(String(infoHash || ''))) {
        log('bad hash');
        return res.redirect(302, '/assets/warm-failed.mp4');
      }
      const hash = String(infoHash).toLowerCase();

      // Pull the user's TorBox key.
      const creds = req.userAccount.config || {};
      const torboxKey = (creds.torboxApiKey || '').trim();
      if (!torboxKey) {
        log('no torbox key on user — cannot warm');
        return res.redirect(302, '/assets/warm-failed.mp4');
      }

      // Side-effectful add. We don't poll — fire-and-forget is the contract
      // (see placeholder MP4 explanation in the README).
      try {
        const magnet = torboxResolverLib.buildMagnet(hash);
        await torboxResolverLib.createTorrent(magnet, torboxKey, log);
        log('queued ' + hash.slice(0, 10) + '… on user TorBox');
        res.setHeader('Cache-Control', 'no-store');
        return res.redirect(302, '/assets/warm-added.mp4');
      } catch (err) {
        log('createTorrent error: ' + err.message);
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

  // Manually trigger the proactive stream-candidate warmer. Fire-and-forget so
  // the admin gets an immediate redirect rather than blocking on the whole walk.
  // 0.36.0: kept for backward compat with any external scripts hitting this
  // endpoint, but the UI button now points at /admin/refresh-events instead
  // (the events refresh is far more useful — populates newly-added custom
  // promotions without waiting for the 6h scheduled refresh).
  app.post('/admin/refresh-streams', requireAdmin, (req, res) => {
    runStreamRefresh({ log: (m) => console.log(m) })
      .then((r) => console.log('[admin] manual stream warm: ' + JSON.stringify(r)))
      .catch((err) => console.error('[admin] manual stream warm failed:', err.message));
    res.redirect('/admin?flash=' + encodeURIComponent('Stream-cache warm started in the background — check server logs for progress.'));
  });

  // 0.36.0: Refresh catalogs button. Fires scripts/refresh.js (events from
  // TSDB / Wikipedia / etc) rather than the stream warmer. Most useful right
  // after adding a custom promotion via /admin/promotions — events show up
  // in the catalog within ~minute(s) without waiting on the scheduled refresh.
  app.post('/admin/refresh-events', requireAdmin, (req, res) => {
    runEventsRefresh({ log: (m) => console.log(m) })
      .then(() => console.log('[admin] manual events refresh complete'))
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
    runEventsRefresh({ promotionId: id, log: (m) => console.log(m) })
      .then((result) => console.log('[admin] per-promotion refresh "' + id + '" complete: ' + JSON.stringify(result)))
      .catch((err) => console.error('[admin] per-promotion refresh "' + id + '" failed: ' + err.message));
    res.redirect('/admin/promotions?flash=' + encodeURIComponent('Refresh started for "' + p.name + '" — other promotions untouched. Check server logs for progress.'));
  });

  // 0.28.0: admin per-event power tool. Pick an event, re-search its
  // indexers, pick specific torrents, warm them on the admin's TB/PM keys,
  // and re-verify the candidate cache — all without touching the global
  // 3-hour warmer cycle. Replaces the user-facing auto-warm that was
  // disabled in 0.26.2 because of TB 429 cascades.
  app.get('/admin/power-tool', requireAdmin, (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(renderPowerToolPage(req.user, req.query));
  });
  app.post('/admin/power-tool/search', requireAdmin, async (req, res) => {
    const eventId = String(req.body.event || '').trim();
    if (!eventId) return res.redirect('/admin/power-tool?flash=' + encodeURIComponent('No event selected.'));
    try {
      const r = await powerTool.searchEvent(eventId, (m) => console.log(m));
      const msg = r.ok ? ('Search complete — ' + r.count + ' candidate(s) cached.')
                       : ('Search failed: ' + r.reason);
      res.redirect('/admin/power-tool?event=' + encodeURIComponent(eventId) + '&flash=' + encodeURIComponent(msg));
    } catch (e) {
      res.redirect('/admin/power-tool?event=' + encodeURIComponent(eventId) + '&flash=' + encodeURIComponent('Search error: ' + e.message));
    }
  });
  app.post('/admin/power-tool/warm', requireAdmin, async (req, res) => {
    const eventId = String(req.body.event || '').trim();
    const provider = String(req.body.provider || '').toLowerCase();
    const hashesRaw = req.body.hashes;
    const hashes = Array.isArray(hashesRaw) ? hashesRaw : (hashesRaw ? [hashesRaw] : []);
    if (!eventId || !provider || hashes.length === 0) {
      return res.redirect('/admin/power-tool?event=' + encodeURIComponent(eventId) + '&flash=' + encodeURIComponent('Pick at least one candidate + a provider.'));
    }
    try {
      const r = await powerTool.warmHashes(eventId, hashes, provider, (m) => console.log(m));
      const msg = r.ok ? ('Warmed ' + r.results.filter((x) => x.ok).length + '/' + r.results.length + ' on ' + provider.toUpperCase() + '. Click "Re-verify" in ~60s to confirm cache.')
                       : ('Warm failed: ' + r.reason);
      res.redirect('/admin/power-tool?event=' + encodeURIComponent(eventId) + '&flash=' + encodeURIComponent(msg));
    } catch (e) {
      res.redirect('/admin/power-tool?event=' + encodeURIComponent(eventId) + '&flash=' + encodeURIComponent('Warm error: ' + e.message));
    }
  });
  // 0.28.2: LIVE Prowlarr/Zilean search. Admin types a free-form query;
  // we hit the indexers directly and stash the results so the next page
  // render can show them. No relevance filter, no streamcache write —
  // results sit in memory per-admin per-event until the commit step.
  app.post('/admin/power-tool/live-search', requireAdmin, async (req, res) => {
    const eventId = String(req.body.event || '').trim();
    const query   = String(req.body.query || '').trim();
    const sources = [];
    if (req.body.src_prowlarr) sources.push('prowlarr');
    if (req.body.src_zilean)   sources.push('zilean');
    if (req.body.src_extra)    sources.push('extra');
    if (sources.length === 0) sources.push('prowlarr');
    if (!eventId || !query) {
      return res.redirect('/admin/power-tool?event=' + encodeURIComponent(eventId)
        + '&flash=' + encodeURIComponent('Pick an event and type a search query.'));
    }
    try {
      const r = await powerTool.liveSearch(req.user.id, eventId, query, sources, (m) => console.log(m));
      const msg = r.ok
        ? ('Live search returned ' + r.count + ' result(s) for "' + query + '"')
        : ('Live search failed: ' + r.reason);
      res.redirect('/admin/power-tool?event=' + encodeURIComponent(eventId)
        + '&q=' + encodeURIComponent(query)
        + '&srcs=' + encodeURIComponent(sources.join(','))
        + '&flash=' + encodeURIComponent(msg));
    } catch (e) {
      res.redirect('/admin/power-tool?event=' + encodeURIComponent(eventId)
        + '&flash=' + encodeURIComponent('Live search error: ' + e.message));
    }
  });

  app.post('/admin/power-tool/commit', requireAdmin, async (req, res) => {
    const eventId = String(req.body.event || '').trim();
    const provider = String(req.body.provider || 'none').toLowerCase();
    const hashesRaw = req.body.hashes;
    const hashes = Array.isArray(hashesRaw) ? hashesRaw : (hashesRaw ? [hashesRaw] : []);
    if (!eventId || hashes.length === 0) {
      return res.redirect('/admin/power-tool?event=' + encodeURIComponent(eventId)
        + '&flash=' + encodeURIComponent('Tick at least one row before committing.'));
    }
    try {
      const r = await powerTool.commitAndWarm(req.user.id, eventId, hashes, provider, (m) => console.log(m));
      let msg;
      if (!r.ok) msg = 'Commit failed: ' + r.reason;
      else {
        const warmStr = r.warm && r.warm.ok
          ? (' · warmed ' + r.warm.results.filter((x) => x.ok).length + '/' + r.warm.results.length + ' on ' + provider.toUpperCase())
          : (provider === 'none' ? ' (no warm)' : ' · warm: ' + ((r.warm && r.warm.reason) || 'failed'));
        msg = 'Committed ' + r.picks + ' pick(s) (' + r.added + ' new, ' + r.updated + ' updated)' + warmStr;
      }
      res.redirect('/admin/power-tool?event=' + encodeURIComponent(eventId)
        + '&flash=' + encodeURIComponent(msg));
    } catch (e) {
      res.redirect('/admin/power-tool?event=' + encodeURIComponent(eventId)
        + '&flash=' + encodeURIComponent('Commit error: ' + e.message));
    }
  });

  app.post('/admin/power-tool/reverify', requireAdmin, async (req, res) => {
    const eventId = String(req.body.event || '').trim();
    if (!eventId) return res.redirect('/admin/power-tool?flash=' + encodeURIComponent('No event selected.'));
    try {
      const r = await powerTool.reverifyEvent(eventId, (m) => console.log(m));
      const msg = r.ok
        ? ('Re-verified — TB: ' + r.tbHits + ' cached / ' + r.tbMisses + ' not, PM: ' + r.pmHits + ' cached / ' + r.pmMisses + ' not.')
        : ('Re-verify failed: ' + r.reason);
      res.redirect('/admin/power-tool?event=' + encodeURIComponent(eventId) + '&flash=' + encodeURIComponent(msg));
    } catch (e) {
      res.redirect('/admin/power-tool?event=' + encodeURIComponent(eventId) + '&flash=' + encodeURIComponent('Re-verify error: ' + e.message));
    }
  });

  // 0.27.0: in-GUI log viewer. /admin/logs renders the page with filter
  // inputs + the latest matching rows; /admin/logs.json is a JSON endpoint
  // for the tail-mode auto-refresh (polled every 3s by the page's inline JS).
  app.get('/admin/logs', requireAdmin, (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(renderLogsPage(req.user, req.query));
  });
  app.get('/admin/logs.json', requireAdmin, (req, res) => {
    const rows = logBuffer.filtered({
      category: req.query.category,
      user: req.query.user,
      substring: req.query.substring,
      level: req.query.level,
      limit: parseInt(req.query.limit, 10) || 1000,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(JSON.stringify({ rows, stats: logBuffer.counts() }));
  });

  // 0.24.0: admin observability page. Surfaces denylist sizes, positive-cache
  // hits, warmer last-run stats, and candidate cache stats — everything that
  // used to require SSH + cat. Each card has wipe buttons for the things that
  // are safe to nuke (denylists / positive cache; not user data).
  app.get('/admin/health', requireAdmin, (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderHealthPage(req.user, { flash: req.query.flash || null }));
  });

  app.post('/admin/health/wipe/:kind', requireAdmin, (req, res) => {
    const kind = String(req.params.kind || '').toLowerCase();
    try {
      let msg;
      switch (kind) {
        case 'rd-denylist': rdDenylist.wipe(); msg = 'RD denylist wiped.'; break;
        case 'tb-denylist': tbDenylist.wipe(); msg = 'TB denylist wiped.'; break;
        case 'pm-denylist': pmDenylist.wipe(); msg = 'PM denylist wiped.'; break;
        case 'positive-cache': positiveCache.wipe(); msg = 'Positive cache wiped.'; break;
        default: return res.redirect('/admin/health?flash=' + encodeURIComponent('Unknown wipe kind: ' + kind));
      }
      res.redirect('/admin/health?flash=' + encodeURIComponent(msg));
    } catch (err) {
      res.redirect('/admin/health?flash=' + encodeURIComponent('Wipe failed: ' + err.message));
    }
  });

  // Backup endpoint (0.24.0). Streams a timestamped tar.gz of the data/
  // directory to the admin as a download. Includes events.json, users.json,
  // settings, all denylists, positive cache, stream cache, warmer status —
  // everything that lives in the named Docker volume. Pipe-streams via the
  // container's bundled tar binary so we don't bloat the npm tree.
  app.get('/admin/backup', requireAdmin, (req, res) => {
    const { spawn } = require('child_process');
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

  // Save the companion-scraper endpoint.
  //
  // 0.36.0: stopped writing the legacy Prowlarr/Zilean fields from this
  // form (they were already labelled "Unused by 0.33.0+" in the UI).
  // Existing values in settings.json stay intact — we just no longer
  // touch them on save. The metadata addon doesn't query Prowlarr/Zilean
  // directly any more; the companion scraper owns indexer discovery.
  app.post('/admin/sources', requireAdmin, (req, res) => {
    const b = req.body || {};
    try {
      settings.setCompanion({
        url: String(b.companionUrl || ''),
        authToken: String(b.companionAuthToken || ''),
      });
      // 0.38.1: football-data.org API key — admin-saved value wins over the
      // FOOTBALL_DATA_API_KEY env var. Empty input is allowed (falls back to env).
      settings.setFootballData({
        apiKey: String(b.footballDataApiKey || ''),
      });
      res.redirect('/admin?flash=' + encodeURIComponent('Sources saved.'));
    } catch (err) {
      res.redirect('/admin?flash=' + encodeURIComponent('Save failed: ' + err.message));
    }
  });

  // 0.39.0 — /admin/search: general search across both Prowlarr instances.
  const generalSearch = require('./lib/admin-general-search');
  app.get('/admin/search', requireAdmin, (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const body = generalSearch.renderBody({
      query: req.query && req.query.q ? String(req.query.q) : '',
      flash: req.query && req.query.flash ? String(req.query.flash) : null,
    });
    res.send(tablerChrome.tablerPage('Search', body, {
      user: req.user,
      layout: 'admin',
      currentSection: 'search',
    }));
  });

  app.post('/admin/search/scrape', requireAdmin, generalSearch.handleScrape);
  app.post('/admin/search/grab',   requireAdmin, generalSearch.handleGrab);

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

  // --- 0.35.0: match editor (admin-editable alias + noise overrides) ---
  const matchEditor = require('./lib/admin-match-editor');

  app.get('/admin/match-editor', requireAdmin, (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const body = matchEditor.renderBody({
      selectedPromotionId: String(req.query.promo || '').trim() || null,
      flash: req.query.flash || null,
    });
    res.send(tablerChrome.tablerPage('Match editor', body, { user: req.user, currentSection: 'match-editor' }));
  });

  app.post('/admin/match-editor/save', requireAdmin, (req, res) => {
    const promo = String((req.body && req.body.promo) || '').trim();
    try {
      matchEditor.saveFromForm(promo, req.body || {});
      res.redirect('/admin/match-editor?promo=' + encodeURIComponent(promo)
        + '&flash=' + encodeURIComponent('Overrides saved — takes effect on next /stream call (no restart needed).'));
    } catch (err) {
      res.redirect('/admin/match-editor?promo=' + encodeURIComponent(promo)
        + '&flash=' + encodeURIComponent('Save failed: ' + err.message));
    }
  });

  app.post('/admin/match-editor/clear', requireAdmin, (req, res) => {
    const promo = String((req.body && req.body.promo) || '').trim();
    try {
      matchEditor.clearOverrides(promo);
      res.redirect('/admin/match-editor?promo=' + encodeURIComponent(promo)
        + '&flash=' + encodeURIComponent('All overrides cleared for this promotion.'));
    } catch (err) {
      res.redirect('/admin/match-editor?promo=' + encodeURIComponent(promo)
        + '&flash=' + encodeURIComponent('Clear failed: ' + err.message));
    }
  });

  // 0.35.0: test-bench JSON endpoint (called via fetch() from the editor page).
  app.post('/admin/match-test', requireAdmin, (req, res) => {
    const body = req.body || {};
    const out = matchEditor.testMatch({
      promotionId: String(body.promo || '').trim(),
      eventId:     String(body.eventId || '').trim(),
      title:       String(body.title || ''),
    });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(out));
  });

  // --- 0.35.0: promotion creator (admin-added TSDB-backed promotions) ---
  const adminPromotions = require('./lib/admin-promotions');

  app.get('/admin/promotions', requireAdmin, (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const body = adminPromotions.renderBody({
      editId: String(req.query.edit || '').trim() || null,
      flash:  req.query.flash || null,
    });
    res.send(tablerChrome.tablerPage('Promotions', body, { user: req.user, currentSection: 'promotions' }));
  });

  app.post('/admin/promotions/create', requireAdmin, (req, res) => {
    try {
      const spec = adminPromotions.saveFromForm(req.body || {});
      res.redirect('/admin/promotions?flash=' + encodeURIComponent(
        'Created custom promotion "' + spec.name + '". Run a refresh from /admin to populate its events.'));
    } catch (err) {
      res.redirect('/admin/promotions?flash=' + encodeURIComponent('Create failed: ' + err.message));
    }
  });

  app.post('/admin/promotions/:id/update', requireAdmin, (req, res) => {
    const id = req.params.id;
    try {
      adminPromotions.saveFromForm(req.body || {}, { updateId: id });
      res.redirect('/admin/promotions?flash=' + encodeURIComponent('Updated "' + id + '".'));
    } catch (err) {
      res.redirect('/admin/promotions?edit=' + encodeURIComponent(id)
        + '&flash=' + encodeURIComponent('Update failed: ' + err.message));
    }
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
      sessions.setCookie(res, u.id, req);
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

  // Stream-cache stats for the refresh card. The actual button drives
  // /admin/refresh-events (the catalog-events refresh, not the stream warmer).
  let scStats = { total: 0, fresh: 0, stale: 0, updatedAt: null, ttlHours: 0 };
  try { scStats = streamcache.stats(); } catch (e) { /* file may not exist yet */ }
  const scUpdated = scStats.updatedAt ? scStats.updatedAt.slice(0, 16).replace('T', ' ') : 'never';

  // 0.33.0: companion-scraper URL is the primary content config.
  const _comp = settings.getCompanion();
  // 0.38.1: football-data.org API key field on /admin Sources so admins can
  // save/rotate the key without editing docker-compose.yml.
  const _fd = settings.getFootballData();

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
    +   '<div class="card-header"><h3 class="card-title">Companion scraper</h3></div>'
    +   '<div class="card-body">'
    +     '<p class="text-secondary small mb-3">URL of the SeriousSportScraper companion service you have deployed. The metadata addon delegates content discovery to it and resolves the returned hashes through each user\'s own TorBox key. Leave blank to disable the TorBox pipeline.</p>'
    +     '<form method="POST" action="/admin/sources">'
    +       '<div class="mb-3">'
    +         '<label class="form-label">Companion URL</label>'
    +         '<input class="form-control text-mono" name="companionUrl" value="' + escapeHtml(_comp.url) + '" placeholder="http://scraper:8080" autocomplete="off">'
    +       '</div>'
    +       secretField('Companion auth token (optional)', 'companionAuthToken', _comp.authToken, 'shared bearer if scraper is internet-exposed')

    // 0.38.1: football-data.org API key block. Saved value overrides
    // FOOTBALL_DATA_API_KEY env var. Used by custom promotions whose source
    // === 'football-data' (FIFA WC, EPL, Champions League, etc.).
    +       '<hr class="my-4">'
    +       '<h4 class="mb-2">football-data.org</h4>'
    +       '<p class="text-secondary small mb-3">API key for the football-data.org parallel source — used by custom promotions whose source is set to football-data (FIFA WC, EPL, Champions League, etc.). Free tier covers ~10 req/min. Sign up at <a href="https://www.football-data.org/client/register" target="_blank" rel="noopener" class="link-primary">football-data.org/client/register</a>. Saving here overrides the FOOTBALL_DATA_API_KEY env var.</p>'
    +       secretField('football-data.org API key', 'footballDataApiKey', _fd.apiKey, 'paste your football-data.org token')

    // 0.39.0: general-search config lives on the scraper, not SSS. Indexer
    // sources are configured in the scraper at /sources; downloader targets
    // (qBit + SAB) at /downloaders. SSS only proxies — see /admin/search.
    +       '<hr class="my-4">'
    +       '<h4 class="mb-2">General search</h4>'
    +       '<p class="text-secondary small mb-0">The <a href="/admin/search" class="link-primary">/admin/search</a> page proxies through to the companion scraper above. Configure Prowlarr instances on the scraper\'s <a href="' + escapeHtml(_comp.url || '#') + '/sources" target="_blank" rel="noopener" class="link-primary">Sources</a> page and qBit / SAB credentials on its <a href="' + escapeHtml(_comp.url || '#') + '/downloaders" target="_blank" rel="noopener" class="link-primary">Downloaders</a> page (scraper v0.1.4+).</p>'

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
    +     '<p class="text-secondary small mb-3">Stream candidate cache: <strong>' + scStats.fresh + '</strong> fresh / <strong>' + scStats.total + '</strong> cached events · last warmed ' + escapeHtml(scUpdated) + '</p>'
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

// 0.24.0: admin observability page. Pure render — no state mutation. All the
// data lives in lib/{rd,tb,pm}-denylist, lib/positive-cache, lib/streamcache,
// and scripts/refresh-streams' status file.
function renderHealthPage(currentUser, opts) {
  opts = opts || {};
  const flashHtml = opts.flash
    ? '<div class="alert alert-info alert-dismissible" role="alert">'
      + '<div>' + escapeHtml(opts.flash) + '</div>'
      + '<a class="btn-close" data-bs-dismiss="alert"></a>'
      + '</div>'
    : '';

  // Helper: Tabler stat card with title + value + sub + optional action button.
  function statCard(title, valueHtml, subHtml, actionHtml) {
    return ''
      + '<div class="col-sm-6 col-lg-4">'
      +   '<div class="card">'
      +     '<div class="card-body">'
      +       '<div class="subheader mb-2">' + title + '</div>'
      +       '<div class="h2 mb-1">' + valueHtml + '</div>'
      +       (subHtml ? '<div class="text-secondary small">' + subHtml + '</div>' : '')
      +       (actionHtml ? '<div class="mt-3">' + actionHtml + '</div>' : '')
      +     '</div>'
      +   '</div>'
      + '</div>';
  }

  function denyCard(provider, dl) {
    let s = { total: 0, fresh: 0, stale: 0, hard: 0, soft: 0, ttlDays: 0, softTtlHours: 0 };
    try { s = dl.stats(); } catch (e) { /* file may not exist yet */ }
    const kind = provider.toLowerCase() + '-denylist';
    const value = '<strong>' + s.fresh + '</strong> <span class="text-secondary fs-4">fresh</span>';
    const sub = s.hard + ' hard, ' + s.soft + ' soft &middot; ' + s.stale + ' stale &middot; hard TTL ' + s.ttlDays + 'd &middot; soft TTL ' + s.softTtlHours + 'h';
    const action = '<form method="POST" action="/admin/health/wipe/' + kind + '" onsubmit="return confirm(\'Wipe the ' + provider + ' denylist? All ' + s.fresh + ' entries will be removed.\');" class="d-inline">'
      + '<button type="submit" class="btn btn-sm btn-outline-danger">Wipe</button>'
      + '</form>';
    return statCard(provider + ' denylist', value, sub, action);
  }

  // Positive cache
  let posS = { totalHashes: 0, freshEntries: 0, byProvider: {}, ttlDays: 0 };
  try { posS = positiveCache.stats(); } catch (e) { /* */ }
  const byProvText = ['rd', 'tb', 'pm']
    .map((p) => p.toUpperCase() + ': ' + (posS.byProvider[p] || 0))
    .join(' &middot; ');
  const positiveCardHtml = statCard(
    'Positive cache',
    '<strong>' + posS.freshEntries + '</strong> <span class="text-secondary fs-4">fresh entr' + (posS.freshEntries === 1 ? 'y' : 'ies') + '</span>',
    'across ' + posS.totalHashes + ' hash' + (posS.totalHashes === 1 ? '' : 'es') + ' &middot; ' + byProvText + ' &middot; TTL ' + posS.ttlDays + 'd',
    '<form method="POST" action="/admin/health/wipe/positive-cache" onsubmit="return confirm(\'Wipe positive cache? All known-cached (hash, provider) entries will be removed.\');" class="d-inline">'
      + '<button type="submit" class="btn btn-sm btn-outline-danger">Wipe</button>'
      + '</form>'
  );

  // Candidate cache
  let scS = { total: 0, fresh: 0, stale: 0, updatedAt: null, ttlHours: 0 };
  try { scS = streamcache.stats(); } catch (e) { /* */ }
  const scUpdated = scS.updatedAt ? scS.updatedAt.slice(0, 16).replace('T', ' ') : 'never';
  const streamCacheCardHtml = statCard(
    'Candidate cache',
    '<strong>' + scS.fresh + '</strong> <span class="text-secondary fs-4">/ ' + scS.total + ' fresh</span>',
    'TTL ' + scS.ttlHours + 'h &middot; last warmed ' + escapeHtml(scUpdated),
    '<form method="POST" action="/admin/refresh-streams" class="d-inline">'
      + '<button type="submit" class="btn btn-sm btn-outline-primary">Warm now</button>'
      + '</form>'
  );

  // Warmer last run
  let w = null;
  try { w = readWarmerStatus && readWarmerStatus(); } catch (e) { w = null; }
  let warmerCardHtml;
  if (w) {
    const endStr = (w.lastRunEnd || '').slice(0, 16).replace('T', ' ');
    const verifyLine = w.verifyEnabled
      ? 'TB: ' + (w.tbHits || 0) + ' cached / ' + (w.tbMisses || 0) + ' not &middot; PM: ' + (w.pmHits || 0) + ' cached / ' + (w.pmMisses || 0) + ' not'
      : 'verification disabled (set WARMER_TB_TOKEN / WARMER_PM_KEY)';
    warmerCardHtml = statCard(
      'Last warmer run',
      '<strong>' + (w.warmed || 0) + '</strong> <span class="text-secondary fs-4">warmed</span>',
      (w.failed || 0) + ' failed, ' + (w.totalCands || 0) + ' total candidates &middot; ' + verifyLine
        + ' &middot; window &minus;' + (w.windowDaysBack || 0) + 'd / +' + (w.windowDaysAhead || 0) + 'd'
        + ' &middot; ' + (w.durationSeconds || 0) + 's &middot; finished ' + escapeHtml(endStr),
      null
    );
  } else {
    warmerCardHtml = statCard(
      'Last warmer run',
      '<span class="text-secondary fs-3">No data</span>',
      'No warmer run recorded yet. The warmer runs every ' + config.streamCache.refreshHours + 'h (scheduled) or via "Warm now".',
      null
    );
  }

  // Backup card
  const backupCardHtml = statCard(
    'Backup',
    '<span class="text-secondary fs-3">tar.gz</span>',
    'Timestamped tar.gz of /app/data (events, users, denylists, positive cache, stream cache, warmer status).',
    '<a href="/admin/backup" class="btn btn-sm btn-outline-primary">Download backup</a>'
  );

  const body = ''
    + '<div class="page-header">'
    +   '<div class="row align-items-center">'
    +     '<div class="col">'
    +       '<h2 class="page-title">Health</h2>'
    +       '<div class="text-secondary mt-1">Admin observability — denylists, positive cache, warmer status, candidate cache.</div>'
    +     '</div>'
    +   '</div>'
    + '</div>'
    + flashHtml
    + '<div class="row row-cards">'
    +   denyCard('RD', rdDenylist)
    +   denyCard('TB', tbDenylist)
    +   denyCard('PM', pmDenylist)
    +   positiveCardHtml
    +   streamCacheCardHtml
    +   warmerCardHtml
    +   backupCardHtml
    + '</div>';

  return tablerChrome.tablerPage('Health', body, { user: currentUser, currentSection: 'health' });
}

// 0.27.0: in-GUI log viewer. Filters (category / user / substring / level)
// run server-side via logBuffer.filtered(). Tail mode is a small inline JS
// that polls /admin/logs.json every 3s and re-renders just the table body.
function renderLogsPage(currentUser, q) {
  q = q || {};
  const category   = String(q.category   || 'all');
  const userFilter = String(q.user       || '');
  const substring  = String(q.substring  || '');
  const level      = String(q.level      || 'all');
  const limit      = Math.max(50, Math.min(5000, parseInt(q.limit, 10) || 500));
  const tail       = q.tail === 'on';

  const stats = logBuffer.counts();
  const rows = logBuffer.filtered({ category, user: userFilter, substring, level, limit });

  const knownCats = ['stream','resolve','warm','refresh','admin','server','denylist','positive-cache','dead-indexer','onefc','crypto-keys','streamcache','users','other'];
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
function renderPowerToolPage(currentUser, q) {
  q = q || {};
  const eventId = String(q.event || '');
  const flash = String(q.flash || '');
  const showAll = q.showAll === 'on';
  const indexer = String(q.indexer || 'all');
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const PAGE_SIZE = 10;

  const tbKeySet = !!(config.warmer && config.warmer.tbToken);
  const pmKeySet = !!(config.warmer && config.warmer.pmApiKey);

  // Event picker datalist — all events sorted most-recent first.
  const allEvents = powerTool.listEvents();
  const datalistOpts = allEvents.map((e) =>
    '<option value="' + escapeHtml(e.id) + '">'
    + escapeHtml(e.date || '????-??-??') + ' — ' + escapeHtml(e.name)
    + (e.isPast ? ' (past)' : '')
    + '</option>'
  ).join('');

  const ev = eventId ? powerTool.getEvent(eventId) : null;
  const evaluated = ev ? powerTool.evaluateCandidates(ev.id) : null;

  // Selected-event card.
  let eventCard = '';
  if (eventId && !ev) {
    eventCard = '<div class="pt-card pt-card-error">'
      + '<h3>Event not found</h3>'
      + '<div class="pt-row">No event with id <code>' + escapeHtml(eventId) + '</code> in the metadata store.</div>'
      + '</div>';
  } else if (ev) {
    const brief = powerTool.eventBrief(ev);
    eventCard = '<div class="pt-card">'
      + '<div class="pt-card-head">'
      +   '<h3>Selected event</h3>'
      +   '<div class="pt-card-actions">'
      +     '<form method="POST" action="/admin/power-tool/search" style="display:inline;">'
      +       '<input type="hidden" name="event" value="' + escapeHtml(brief.id) + '">'
      +       '<button class="btn-sm" type="submit">🔎 Search indexers</button>'
      +     '</form>'
      +     '<form method="POST" action="/admin/power-tool/reverify" style="display:inline;">'
      +       '<input type="hidden" name="event" value="' + escapeHtml(brief.id) + '">'
      +       '<button class="btn-sm" type="submit"' + (tbKeySet || pmKeySet ? '' : ' disabled title="Set WARMER_TB_TOKEN / WARMER_PM_KEY in .env first"') + '>♻️ Re-verify cache</button>'
      +     '</form>'
      +   '</div>'
      + '</div>'
      + '<div class="pt-row pt-name">' + escapeHtml(brief.name) + '</div>'
      + '<div class="pt-row pt-sub">'
      +   'id <code>' + escapeHtml(brief.id) + '</code>'
      +   ' &middot; date ' + escapeHtml(brief.date || '?')
      +   ' &middot; promotion ' + escapeHtml(brief.promotion || '?')
      + '</div>'
      + (brief.aliases.length > 0
          ? '<div class="pt-row pt-sub" style="margin-top:6px;">aliases: '
            + brief.aliases.map((a) => '<code style="font-size:11px;">' + escapeHtml(a) + '</code>').join(' ')
            + '</div>'
          : '')
      + '</div>';
  }

  // Candidates section — apply filters, paginate.
  let candidatesBlock = '';
  if (ev) {
    if (evaluated === null) {
      candidatesBlock = '<div class="pt-card"><h3>Candidates</h3>'
        + '<div class="pt-row pt-sub">No candidate cache for this event yet. Click "🔎 Search indexers" above to populate it.</div>'
        + '</div>';
    } else if (evaluated.total === 0) {
      candidatesBlock = '<div class="pt-card"><h3>Candidates</h3>'
        + '<div class="pt-row pt-sub">Candidate cache is empty — indexers returned 0 results. Re-run search later or check Prowlarr/Zilean directly.</div>'
        + '</div>';
    } else {
      // Filter chain: indexer first, then relevance.
      let filtered = evaluated.candidates;
      if (indexer !== 'all') filtered = filtered.filter((c) => (c.indexer || '') === indexer);
      if (!showAll) filtered = filtered.filter((c) => c.relevant);
      const totalAfterFilter = filtered.length;
      const totalPages = Math.max(1, Math.ceil(totalAfterFilter / PAGE_SIZE));
      const safePage = Math.min(page, totalPages);
      const pageStart = (safePage - 1) * PAGE_SIZE;
      const pageEnd = Math.min(pageStart + PAGE_SIZE, totalAfterFilter);
      const pageRows = filtered.slice(pageStart, pageEnd);

      const formattedSize = (b) => {
        if (!b || b <= 0) return '?';
        const gb = b / 1073741824;
        if (gb >= 1) return gb.toFixed(2) + ' GB';
        return Math.round(b / 1048576) + ' MB';
      };
      const candRowsHtml = pageRows.length === 0
        ? '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:20px;">No candidates match these filters.</td></tr>'
        : pageRows.map((c) => {
            const verif = c.cachedProviders || {};
            const tbBadge = verif.tb === true ? '<span class="cv-cached">TB✓</span>'
                          : verif.tb === false ? '<span class="cv-not">TB✗</span>'
                          : '<span class="cv-unk">TB?</span>';
            const pmBadge = verif.pm === true ? '<span class="cv-cached">PM✓</span>'
                          : verif.pm === false ? '<span class="cv-not">PM✗</span>'
                          : '<span class="cv-unk">PM?</span>';
            const relBadge = c.relevant
              ? '<span class="rel-yes" title="passes relevance">✓</span>'
              : '<span class="rel-no" title="rejected: ' + escapeHtml(c.rejectionReason || 'rejected') + '">✗</span>';
            return '<tr class="' + (c.relevant ? '' : 'cand-rejected') + '">'
              +   '<td><input type="checkbox" name="hashes" value="' + escapeHtml(c.infoHash) + '" form="warm-form"></td>'
              +   '<td class="cand-rel">' + relBadge + '</td>'
              +   '<td class="cand-title">' + escapeHtml((c.title || '').slice(0, 110)) + '</td>'
              +   '<td class="cand-size">' + escapeHtml(formattedSize(c.size)) + '</td>'
              +   '<td class="cand-seeds">' + (c.seeders || 0) + '</td>'
              +   '<td class="cand-src">' + escapeHtml(c.indexer || '?') + '</td>'
              +   '<td class="cand-verif">' + tbBadge + ' ' + pmBadge + '</td>'
              +   '<td class="cand-hash"><code>' + escapeHtml(String(c.infoHash || '').slice(0, 10)) + '…</code></td>'
              + '</tr>';
          }).join('');

      // Filter form — preserves event in query string, GET so it bookmarks.
      const filterForm = '<form method="GET" action="/admin/power-tool" class="pt-filters">'
        + '<input type="hidden" name="event" value="' + escapeHtml(ev.id) + '">'
        + '<div><label>Indexer</label><select name="indexer" class="form-control">'
        +   ['all'].concat(evaluated.indexers).map((ix) =>
              '<option value="' + escapeHtml(ix) + '"' + (ix === indexer ? ' selected' : '') + '>' + escapeHtml(ix) + '</option>'
            ).join('')
        + '</select></div>'
        + '<div><label>Relevance</label><label style="display:flex;align-items:center;gap:6px;height:38px;font-size:13px;">'
        +   '<input type="checkbox" name="showAll" value="on"' + (showAll ? ' checked' : '') + '> Show rejected too'
        + '</label></div>'
        + '<div><label>&nbsp;</label><button type="submit" class="btn-sm">Apply</button></div>'
        + '</form>';

      // Pagination links — preserve filters.
      const baseParams = 'event=' + encodeURIComponent(ev.id)
        + (indexer !== 'all' ? '&indexer=' + encodeURIComponent(indexer) : '')
        + (showAll ? '&showAll=on' : '');
      const pageLink = (p, label) =>
        (p >= 1 && p <= totalPages && p !== safePage)
          ? '<a href="/admin/power-tool?' + baseParams + '&page=' + p + '" class="pg-link">' + label + '</a>'
          : '<span class="pg-link pg-disabled">' + label + '</span>';
      const pagination = totalAfterFilter > PAGE_SIZE
        ? '<div class="pt-pagination">'
          + pageLink(1, '« First')
          + pageLink(safePage - 1, '‹ Prev')
          + '<span class="pg-info">Page ' + safePage + ' of ' + totalPages + '</span>'
          + pageLink(safePage + 1, 'Next ›')
          + pageLink(totalPages, 'Last »')
          + '</div>'
        : '';

      const summaryLine = ''
        + '<strong>' + evaluated.total + '</strong> total candidates &middot; '
        + '<strong style="color:#7fd089;">' + evaluated.relevant + '</strong> pass relevance &middot; '
        + 'showing ' + (totalAfterFilter === 0 ? 0 : pageStart + 1) + '–' + pageEnd + ' of ' + totalAfterFilter + ' filtered';

      candidatesBlock = '<div class="pt-card pt-results">'
        + '<div class="pt-card-head">'
        +   '<h3>Candidates</h3>'
        +   filterForm
        + '</div>'
        + '<div class="pt-row pt-sub" style="margin-bottom:10px;">' + summaryLine + '</div>'
        + '<form method="POST" action="/admin/power-tool/warm" id="warm-form" style="display:inline;">'
        +   '<input type="hidden" name="event" value="' + escapeHtml(ev.id) + '">'
        +   '<table class="cand-table">'
        +     '<thead><tr><th><input type="checkbox" id="check-all"></th><th class="cand-rel">OK</th><th>Title</th><th class="cand-size">Size</th><th class="cand-seeds">Seeds</th><th class="cand-src">Source</th><th>Verified</th><th>Hash</th></tr></thead>'
        +     '<tbody>' + candRowsHtml + '</tbody>'
        +   '</table>'
        +   pagination
        +   '<div style="margin-top:14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding-top:12px;border-top:1px solid var(--border);">'
        +     '<span id="picked-count" style="color:var(--muted);font-size:12px;">0 selected</span>'
        +     '<button type="submit" name="provider" value="tb" class="btn btn-primary w-100 mt-3" style="margin:0;padding:9px 16px;width:auto;"' + (tbKeySet ? '' : ' disabled title="WARMER_TB_TOKEN not set in .env"') + '>🔥 Warm selected on TB</button>'
        +     '<button type="submit" name="provider" value="pm" class="btn btn-primary w-100 mt-3" style="margin:0;padding:9px 16px;width:auto;"' + (pmKeySet ? '' : ' disabled title="WARMER_PM_KEY not set in .env"') + '>🔥 Warm selected on PM</button>'
        +   '</div>'
        + '</form>'
        + '<div class="pt-row pt-sub" style="margin-top:10px;font-size:11px;">'
        +   'Verified badges: ✓ cached on this provider · ✗ not cached · ? unknown. Relevance ✓ = passes the promotion\'s isRelevantStreamTitle filter; ✗ = rejected (hover for reason).'
        + '</div>'
        + '</div>';
    }
  }

  // Inline styles — kept here so the page is self-contained.
  const styles = ''
    + '<style>'
    +   '.pt-picker{display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin-bottom:16px;padding:16px;background:linear-gradient(135deg,rgba(210,10,17,0.04),rgba(255,255,255,0.02));border:1px solid var(--border);border-radius:12px;}'
    +   '.pt-picker .inp{min-width:440px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;}'
    +   '.pt-card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:18px 20px;margin-bottom:14px;}'
    +   '.pt-card-error{border-color:var(--accent);}'
    +   '.pt-card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:10px;}'
    +   '.pt-card h3{margin:0;font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;font-weight:600;}'
    +   '.pt-card-actions{display:flex;gap:6px;flex-wrap:wrap;}'
    +   '.pt-row{font-size:14px;line-height:1.5;}'
    +   '.pt-row.pt-name{font-size:16px;font-weight:600;color:var(--text);margin-bottom:4px;}'
    +   '.pt-row.pt-sub{font-size:12px;color:var(--muted);}'
    +   '.pt-results{padding-bottom:14px;}'
    +   '.pt-filters{display:flex;gap:8px;align-items:end;}'
    +   '.pt-filters > div{display:flex;flex-direction:column;gap:3px;}'
    +   '.pt-filters label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;}'
    +   '.pt-filters .inp{min-width:120px;font-size:13px;}'
    +   '.cand-table{width:100%;border-collapse:collapse;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;table-layout:auto;}'
    +   '.cand-table th{text-align:left;padding:7px 8px;background:rgba(255,255,255,0.03);color:var(--muted);font-weight:500;border-bottom:1px solid var(--border);}'
    +   '.cand-table td{padding:7px 8px;border-bottom:1px solid rgba(255,255,255,0.04);vertical-align:top;}'
    +   '.cand-table tr.cand-rejected{opacity:.55;}'
    +   '.cand-table td.cand-title{max-width:520px;word-break:break-word;}'
    +   '.cand-table th.cand-size, .cand-table td.cand-size, .cand-table th.cand-seeds, .cand-table td.cand-seeds, .cand-table th.cand-src, .cand-table td.cand-src, .cand-table th.cand-rel, .cand-table td.cand-rel{white-space:nowrap;}'
    +   '.cand-table td.cand-rel{text-align:center;}'
    +   '.cv-cached{display:inline-block;padding:1px 5px;border-radius:3px;background:rgba(60,180,80,0.18);color:#7fd089;font-size:11px;}'
    +   '.cv-not{display:inline-block;padding:1px 5px;border-radius:3px;background:rgba(220,40,40,0.12);color:#e07070;font-size:11px;}'
    +   '.cv-unk{display:inline-block;padding:1px 5px;border-radius:3px;background:rgba(255,255,255,0.06);color:var(--muted);font-size:11px;}'
    +   '.rel-yes{color:#7fd089;font-weight:bold;}'
    +   '.rel-no{color:#e07070;font-weight:bold;cursor:help;}'
    +   '.pt-pagination{display:flex;gap:6px;align-items:center;justify-content:center;margin-top:12px;font-size:12px;}'
    +   '.pg-link{padding:5px 10px;border-radius:5px;background:rgba(255,255,255,0.04);text-decoration:none;color:var(--text);}'
    +   '.pg-link:hover:not(.pg-disabled){background:rgba(210,10,17,0.18);}'
    +   '.pg-disabled{opacity:.35;cursor:not-allowed;}'
    +   '.pg-info{padding:5px 12px;color:var(--muted);}'
    +   '.btn-install:disabled{opacity:0.4;cursor:not-allowed;}'
    + '</style>';

  const inlineJs = '<script>(function(){'
    + 'var ca=document.getElementById("check-all");'
    + 'var pc=document.getElementById("picked-count");'
    + 'function update(){if(!pc)return;var n=document.querySelectorAll("input[name=hashes]:checked").length;pc.textContent=n+" selected";}'
    + 'if(ca){ca.addEventListener("change",function(){var boxes=document.querySelectorAll("input[name=hashes]");boxes.forEach(function(b){b.checked=ca.checked;});update();});}'
    + 'document.addEventListener("change",function(e){if(e.target&&e.target.name==="hashes")update();});'
    + 'update();'
    + '})();</script>';

  const keyStatusBar = ''
    + '<div style="font-size:12px;color:var(--muted);margin-bottom:14px;">'
    +   'Admin warm keys: '
    +   'TB ' + (tbKeySet ? '<span style="color:#7fd089;">configured</span>' : '<span style="color:var(--accent2);">not set</span> (WARMER_TB_TOKEN)')
    +   ' &middot; PM ' + (pmKeySet ? '<span style="color:#7fd089;">configured</span>' : '<span style="color:var(--accent2);">not set</span> (WARMER_PM_KEY)')
    + '</div>';

  const body = styles
    + '<p style="color:var(--muted);font-size:13px;margin:0 0 10px;">'
    +   'Per-event admin tool — re-search indexers, warm chosen candidates onto the admin\'s TB/PM libraries, and re-verify the cache so rows appear in users\' /stream immediately. Bypasses the global 3-hour warm cycle.'
    + '</p>'
    + keyStatusBar
    + (flash ? '<div class="flash">' + escapeHtml(flash) + '</div>' : '')
    + '<form class="pt-picker" method="GET" action="/admin/power-tool">'
    +   '<div style="display:flex;flex-direction:column;gap:4px;flex:1;">'
    +     '<label style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;">Event (type to filter — ' + allEvents.length + ' available)</label>'
    +     '<input class="form-control" name="event" list="event-list" value="' + escapeHtml(eventId) + '" placeholder="e.g. ufc:2391889 or start typing a name" autocomplete="off">'
    +     '<datalist id="event-list">' + datalistOpts + '</datalist>'
    +   '</div>'
    +   '<button type="submit" class="btn btn-primary w-100 mt-3" style="margin:0;padding:10px 20px;width:auto;">Select</button>'
    + '</form>'
    + eventCard
    + candidatesBlock
    + inlineJs
    + '<div style="margin-top:24px;padding-top:18px;border-top:1px solid var(--border);">'
    +   '<a href="/admin" style="color:var(--accent);text-decoration:none;font-weight:500;">← Back to admin</a>'
    +   ' &nbsp;&middot;&nbsp; '
    +   '<a href="/admin/health" style="color:var(--text);text-decoration:none;font-size:13px;">📊 Health</a>'
    +   ' &nbsp;&middot;&nbsp; '
    +   '<a href="/admin/logs" style="color:var(--text);text-decoration:none;font-size:13px;">📜 Logs</a>'
    + '</div>';

  // 0.37.0: pragmatic conversion — power-tool's existing inline <style>
  // block keeps its bespoke layout intact via the legacy CSS variable aliases
  // defined in lib/tabler-chrome.js. Page gets the new sidebar/topbar chrome
  // without rewriting the 200+ lines of complex inner UI (event picker /
  // search results table / warm pipeline). Full Tabler conversion of the
  // inner content can land in 0.37.1 if desired.
  return tablerChrome.tablerPage('Power Tool', body, { user: currentUser, currentSection: 'power-tool' });
}

// Render a credential input as a masked field with a Show/Hide toggle.
// The toggle is wired by a small delegated listener in renderAccountPage.
// 0.37.0: Tabler-styled secret field (label + input-group with toggle button).
// Replaces the hand-rolled .lbl/.secret-row/.btn-reveal triplet.
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
  const selected = new Set(Array.isArray(cfg.catalogs) ? cfg.catalogs : []);
  const selectAll = selected.size === 0;

  // Per-promotion catalog tickboxes — grouped into Tabler list-group items.
  let catGroupsHtml = '';
  for (const p of promotions.enabled) {
    let items = '';
    for (const c of p.catalogs) {
      const checked = (selectAll || selected.has(c.id)) ? ' checked' : '';
      items += ''
        + '<label class="form-check">'
        +   '<input class="form-check-input" type="checkbox" name="catalogs" value="' + escapeHtml(c.id) + '"' + checked + '>'
        +   '<span class="form-check-label">' + escapeHtml(c.name) + '</span>'
        + '</label>';
    }
    catGroupsHtml += ''
      + '<div class="col-md-6 col-lg-4 mb-3">'
      +   '<div class="card">'
      +     '<div class="card-header">'
      +       '<h3 class="card-title">' + escapeHtml(p.name) + '</h3>'
      +     '</div>'
      +     '<div class="card-body py-2">' + items + '</div>'
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

  // Services tab — credentials for each provider.
  const servicesTab = ''
    + '<div class="card mb-3">'
    +   '<div class="card-header"><h3 class="card-title">TorBox</h3></div>'
    +   '<div class="card-body">'
    +     '<p class="text-secondary small mb-3">Used by the addon to check which scraper results are already cached on your TorBox subscription, and to return playable URLs only for cached items. Your key never leaves this addon.</p>'
    +     secretField('TorBox API key', 'torboxApiKey', cfg.torboxApiKey, 'paste your TorBox API key')
    +   '</div>'
    + '</div>'

    + '<div class="card mb-3">'
    +   '<div class="card-header"><h3 class="card-title">Easynews</h3></div>'
    +   '<div class="card-body">'
    +     '<p class="text-secondary small mb-3">Stream rows will play directly from members.easynews.com using your subscription. Your password is encrypted at rest and never appears in stream URLs returned to Stremio (auth is injected only at play-time via a signed redirect). Leave blank if you don\'t have an Easynews subscription.</p>'
    +     '<div class="mb-3">'
    +       '<label class="form-label" for="en-user">Easynews username</label>'
    +       '<input class="form-control" type="text" id="en-user" name="easynewsUsername" value="' + escapeHtml(cfg.easynewsUsername || '') + '" placeholder="your Easynews username" autocomplete="off">'
    +     '</div>'
    +     secretField('Easynews password', 'easynewsPassword', cfg.easynewsPassword, 'your Easynews password')
    +   '</div>'
    + '</div>'

    + '<div class="card mb-3">'
    +   '<div class="card-header"><h3 class="card-title">Usenet Ultimate</h3></div>'
    +   '<div class="card-body">'
    +     '<p class="text-secondary small mb-3">Stream rows will play through your UU instance. Leave blank if you don\'t use UU.</p>'
    +     '<div class="mb-3">'
    +       '<label class="form-label" for="uu-url">UU manifest URL</label>'
    +       '<input class="form-control text-mono" type="url" id="uu-url" name="uuManifestUrl" value="' + escapeHtml(cfg.uuManifestUrl || '') + '" placeholder="https://your-usenet-ultimate.elfhosted.com/stremio/&lt;config&gt;/manifest.json">'
    +     '</div>'
    +   '</div>'
    + '</div>'

    + '<div class="card mb-3">'
    +   '<div class="card-header"><h3 class="card-title">Result count</h3></div>'
    +   '<div class="card-body">'
    +     '<p class="text-secondary small mb-3">Cap the number of stream rows shown per event. 0 = use server default (' + escapeHtml(String(defaultMaxStreams)) + '). Sorted by size (largest first), then by recency.</p>'
    +     '<div class="mb-0">'
    +       '<label class="form-label">Max streams (0 = default)</label>'
    +       '<input class="form-control" type="number" name="maxStreams" min="0" max="50" value="' + escapeHtml(String(cfg.maxStreams || 0)) + '" style="max-width:140px;">'
    +     '</div>'
    +   '</div>'
    + '</div>'

    // 0.38.0: warm-to-cache toggle. Default ON so new users get the helpful
    // 🔥 rows automatically; opt-out for users who prefer cached-only rows.
    + '<div class="card mb-3">'
    +   '<div class="card-header"><h3 class="card-title">Warm to TorBox</h3></div>'
    +   '<div class="card-body">'
    +     '<p class="text-secondary small mb-3">When a release isn\'t already cached on your TorBox, show a 🔥 row that submits it for caching when clicked. Plays a brief "added — check back in 2-5 min" placeholder; come back once it\'s cached. Turn off if you prefer to only see ready-to-play rows.</p>'
    +     '<label class="form-check form-switch">'
    +       '<input class="form-check-input" type="checkbox" name="showWarmRows" value="on"' + ((cfg.showWarmRows !== false) ? ' checked' : '') + '>'
    +       '<span class="form-check-label">Show warm-to-cache rows for uncached releases</span>'
    +     '</label>'
    +   '</div>'
    + '</div>';

  // Catalogs tab — promotion-grouped tickboxes in a responsive grid.
  const catalogsTab = ''
    + '<div class="card mb-3">'
    +   '<div class="card-body">'
    +     '<p class="text-secondary small mb-3">Tick the catalogs you want to see in Stremio Discover. Unticked promotions are hidden from your install URL\'s manifest.</p>'
    +     '<div class="row">' + catGroupsHtml + '</div>'
    +   '</div>'
    + '</div>';

  // Manifest tab — install URL + API token + regenerate.
  const manifestTab = ''
    + '<div class="card mb-3">'
    +   '<div class="card-header"><h3 class="card-title">Install URL</h3></div>'
    +   '<div class="card-body">'
    +     '<p class="text-secondary small mb-3">Use this URL to install the addon in Stremio. It is tied to your account and API token.</p>'
    +     '<div class="input-group">'
    +       '<input class="form-control text-mono" id="murl" value="' + escapeHtml(installUrl) + '" readonly>'
    +       '<button class="btn btn-primary" type="button" id="copyUrlBtn">Copy</button>'
    +     '</div>'
    +   '</div>'
    + '</div>'

    + '<div class="card mb-3">'
    +   '<div class="card-header"><h3 class="card-title">API token</h3></div>'
    +   '<div class="card-body">'
    +     '<p class="text-secondary small mb-3">If your install URL leaks, regenerate this token. Your existing Stremio install stops working immediately; you\'ll need to reinstall with the new URL.</p>'
    +     '<div class="input-group mb-3">'
    +       '<input class="form-control text-mono" value="' + escapeHtml(apiToken) + '" readonly>'
    +     '</div>'
    +     '<button class="btn btn-danger" type="submit" formaction="/account/regenerate-token" formnovalidate onclick="return confirm(\'Regenerate API token? Your existing Stremio install stops working immediately.\');">'
    +       'Regenerate token'
    +     '</button>'
    +   '</div>'
    + '</div>';

  const body = ''
    + '<div class="page-header d-print-none">'
    +   '<div class="row align-items-center">'
    +     '<div class="col">'
    +       '<h2 class="page-title">Account</h2>'
    +     '</div>'
    +   '</div>'
    + '</div>'
    + flashHtml
    + '<form method="POST" action="/account/save">'
    +   '<ul class="nav nav-tabs" role="tablist">'
    +     '<li class="nav-item"><a href="#tab-services" class="nav-link active" data-bs-toggle="tab" role="tab">Services</a></li>'
    +     '<li class="nav-item"><a href="#tab-catalogs" class="nav-link" data-bs-toggle="tab" role="tab">Catalogs</a></li>'
    +     '<li class="nav-item"><a href="#tab-manifest" class="nav-link" data-bs-toggle="tab" role="tab">Manifest</a></li>'
    +   '</ul>'
    +   '<div class="tab-content pt-3">'
    +     '<div class="tab-pane fade show active" id="tab-services" role="tabpanel">' + servicesTab + '</div>'
    +     '<div class="tab-pane fade" id="tab-catalogs" role="tabpanel">' + catalogsTab + '</div>'
    +     '<div class="tab-pane fade" id="tab-manifest" role="tabpanel">' + manifestTab + '</div>'
    +   '</div>'
    +   '<div class="d-flex align-items-center mt-3">'
    +     '<button class="btn btn-primary" type="submit">Save settings</button>'
    +     '<span class="text-secondary small ms-3">Saves Services + Catalogs at the same time.</span>'
    +   '</div>'
    + '</form>'

    // Inline JS: copy install URL + toggle password reveal. Same logic as
    // before, just rebound to Tabler's input-group markup.
    + '<script>'
    + '(function(){'
    +   'var btn = document.getElementById("copyUrlBtn"), code = document.getElementById("murl");'
    +   'if (btn && code) btn.addEventListener("click", function() {'
    +     'var t = code.value;'
    +     'if (navigator.clipboard) { navigator.clipboard.writeText(t); }'
    +     'btn.textContent = "Copied!"; setTimeout(function(){ btn.textContent = "Copy"; }, 1800);'
    +   '});'
    + '})();'
    + 'document.addEventListener("click", function(e){'
    +   'var a = e.target && e.target.closest ? e.target.closest(".btn-reveal") : null;'
    +   'if (!a) return; e.preventDefault();'
    +   'var grp = a.closest(".input-group"); if (!grp) return;'
    +   'var i = grp.querySelector("input"); if (!i) return;'
    +   'var show = i.type === "password"; i.type = show ? "text" : "password";'
    +   'a.textContent = show ? "Hide" : "Show";'
    + '});'
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

module.exports = { createApp };
