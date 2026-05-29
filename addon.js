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
const promotions = require('./lib/promotions');
const users = require('./lib/users');
const sessions = require('./lib/sessions');
// 0.24.0: per-provider state modules for the admin /health page.
const rdDenylist = require('./lib/rd-denylist');
const tbDenylist = require('./lib/tb-denylist');
const pmDenylist = require('./lib/pm-denylist');
const positiveCache = require('./lib/positive-cache');
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
    res.send(JSON.stringify({
      ok: true,
      events: events.length,
      updatedAt: meta.updatedAt || null,
      prowlarrConfigured: !!(config.prowlarr.url && config.prowlarr.apiKey),
      adminProtected: !!(config.admin.user && config.admin.password),
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
      + '<label class="lbl">Username</label>'
      + '<input class="inp" name="username" value="' + escapeHtml(prefill) + '" required minlength="3" maxlength="32" autofocus>'
      + '<label class="lbl">Password</label>'
      + '<input class="inp" name="password" type="password" required minlength="8">'
      + '<button class="btn-install" type="submit">Create admin account</button>'
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
      + '<label class="lbl">Username</label>'
      + '<input class="inp" name="username" required autofocus>'
      + '<label class="lbl">Password</label>'
      + '<input class="inp" name="password" type="password" required>'
      + '<button class="btn-install" type="submit">Sign in</button>'
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
        + '<label class="lbl">Username</label>'
        + '<input class="inp" name="username" value="' + escapeHtml(username) + '" required>'
        + '<label class="lbl">Password</label>'
        + '<input class="inp" name="password" type="password" required autofocus>'
        + '<button class="btn-install" type="submit">Sign in</button>'
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
    const autoCache = {
      rd: !!b.autoCacheRD,
      tb: !!b.autoCacheTB,
      pm: !!b.autoCachePM,
    };
    // maxStreams: 0 = unlimited, 1-20 cap. Anything else is rejected silently.
    const maxStreamsRaw = parseInt(String(b.maxStreams || '0'), 10);
    const maxStreams = (Number.isFinite(maxStreamsRaw) && maxStreamsRaw >= 0 && maxStreamsRaw <= 20) ? maxStreamsRaw : 0;
    try {
      users.updateUserConfig(req.user.id, {
        rd: String(b.rd || '').trim(),
        tb: String(b.tb || '').trim(),
        pm: String(b.pm || '').trim(),
        catalogs: finalCats,
        autoCache,
        maxStreams,
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
  app.post('/admin/refresh-streams', requireAdmin, (req, res) => {
    runStreamRefresh({ log: (m) => console.log(m) })
      .then((r) => console.log('[admin] manual stream warm: ' + JSON.stringify(r)))
      .catch((err) => console.error('[admin] manual stream warm failed:', err.message));
    res.redirect('/admin?flash=' + encodeURIComponent('Stream-cache warm started in the background — check server logs for progress.'));
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

  // Save the per-instance indexer source endpoints (Prowlarr + Zilean). These
  // override env and apply live (no restart) because the sources read settings
  // on each request.
  app.post('/admin/sources', requireAdmin, (req, res) => {
    const b = req.body || {};
    try {
      settings.setSources({
        prowlarrUrl: String(b.prowlarrUrl || ''),
        prowlarrApiKey: String(b.prowlarrApiKey || ''),
        zileanUrl: String(b.zileanUrl || ''),
      });
      res.redirect('/admin?flash=' + encodeURIComponent('Indexer sources saved.'));
    } catch (err) {
      res.redirect('/admin?flash=' + encodeURIComponent('Save failed: ' + err.message));
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
      +   '<label class="lbl">Set your password</label>'
      +   '<input class="inp" name="password" type="password" required minlength="8" placeholder="min 8 chars" autofocus>'
      +   '<button class="btn-install" type="submit">Create account</button>'
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

  let flashHtml = '';
  if (opts.flash) {
    flashHtml = '<div class="flash">' + escapeHtml(opts.flash) + '</div>';
  }

  // Active invites (server-generated tokens, redeemable at /invite/:token).
  users.cleanExpiredInvites();
  const invites = users.listInvites();
  const inviteRows = invites.map(function (i) {
    const url = '/invite/' + i.token;
    const exp = (i.expiresAt || '').slice(0, 16).replace('T', ' ');
    return ''
      + '<tr>'
      +   '<td><code>' + escapeHtml(i.username) + '</code></td>'
      +   '<td><span class="badge badge-' + escapeHtml(i.role) + '">' + escapeHtml(i.role) + '</span></td>'
      +   '<td style="font-size:12px;color:var(--muted);">' + escapeHtml(exp) + '</td>'
      +   '<td class="install-cell"><code class="install-url" title="' + escapeHtml(url) + '">' + escapeHtml(url) + '</code> <button type="button" class="btn-copy btn-copy-sm" data-copy="' + escapeHtml(url) + '">Copy</button></td>'
      +   '<td><form method="POST" action="/admin/invites/' + escapeHtml(i.token) + '/revoke" style="display:inline;" onsubmit="return confirm(\'Revoke invite for ' + escapeHtml(i.username) + '?\');"><button type="submit" class="btn-danger">Revoke</button></form></td>'
      + '</tr>';
  }).join('');
  const invitesHtml = ''
    + '<h3 class="sec">Invites (' + invites.length + ')</h3>'
    + '<p class="hint">Send the invite URL to the recipient. They set their own password on first visit. Invites expire after 7 days.</p>'
    + (invites.length > 0
        ? ('<table class="user-list"><thead><tr><th>Username</th><th>Role</th><th>Expires</th><th>Invite URL</th><th></th></tr></thead><tbody>' + inviteRows + '</tbody></table>')
        : '<p style="color:var(--muted);font-size:13px;">No active invites.</p>')
    + '<form method="POST" action="/admin/invites/create">'
    +   '<label class="lbl">New invite — username</label>'
    +   '<input class="inp" name="username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9_.\\-]{3,32}" placeholder="3-32 chars, letters/digits/_-.">'
    +   '<label class="lbl">Role</label>'
    +   '<select class="inp" name="role"><option value="user" selected>user</option><option value="admin">admin</option></select>'
    +   '<button class="btn-install" type="submit">Create invite</button>'
    + '</form>';

  const rows = all.map(function (u) {
    // NOTE: deliberately NOT exposing install URLs or API tokens here. Those are
    // per-user secrets — an admin who could see them could install the addon as
    // any user. They live only on each user's own account page. Admins can still
    // rotate a token via "Regenerate token" below (without ever seeing it).
    const isMe = (u.id === currentUser.id);
    const created = (u.createdAt || '').slice(0, 10);
    const seen = u.lastSeen ? u.lastSeen.slice(0, 10) : '—';
    const deleteBtn = isMe
      ? '<span style="color:var(--muted);font-size:12px;">(you)</span>'
      : '<form method="POST" action="/admin/users/' + escapeHtml(u.id) + '/delete" style="display:inline;margin-left:8px;" onsubmit="return confirm(\'Delete user ' + escapeHtml(u.username) + '? This is permanent.\');"><button type="submit" class="btn-danger">Delete</button></form>';
    const regenBtn = '<form method="POST" action="/admin/users/' + escapeHtml(u.id) + '/regenerate-token" style="display:inline;" onsubmit="return confirm(\'Regenerate API token for ' + escapeHtml(u.username) + '? Their old install URL will stop working immediately.\');"><button type="submit" class="btn-sm">Regenerate token</button></form>';
    const roleSelect = '<form method="POST" action="/admin/users/' + escapeHtml(u.id) + '/set-role" style="display:inline;" onsubmit="return confirm(\'Change role for ' + escapeHtml(u.username) + '?\');">'
      + '<select name="role" class="inp-sm" style="display:inline;width:auto;padding:3px 6px;font-size:11px;">'
      +   '<option value="user"'  + (u.role === 'user'  ? ' selected' : '') + '>user</option>'
      +   '<option value="admin"' + (u.role === 'admin' ? ' selected' : '') + '>admin</option>'
      + '</select> <button type="submit" class="btn-sm">Set role</button></form>';

    const setPwForm = '<details style="display:inline-block;margin-left:6px;"><summary class="btn-sm" style="display:inline-block;list-style:none;cursor:pointer;">Set password</summary>'
      + '<form method="POST" action="/admin/users/' + escapeHtml(u.id) + '/set-password" style="display:inline-block;margin-top:6px;padding:8px;background:rgba(255,255,255,0.03);border-radius:6px;">'
      +   '<input type="password" name="newPassword" required minlength="8" placeholder="new password" class="inp" style="display:inline-block;width:180px;padding:5px 8px;font-size:12px;margin:0 6px 0 0;">'
      +   '<button type="submit" class="btn-sm">Save</button>'
      + '</form></details>';

    return ''
      + '<tr>'
      +   '<td><code>' + escapeHtml(u.username) + '</code>' + (isMe ? ' <span style="color:var(--muted);font-size:11px;">(you)</span>' : '') + '</td>'
      +   '<td><span class="badge badge-' + escapeHtml(u.role) + '">' + escapeHtml(u.role) + '</span></td>'
      +   '<td style="font-size:12px;color:var(--muted);">' + escapeHtml(created) + '</td>'
      +   '<td style="font-size:12px;color:var(--muted);">' + escapeHtml(seen) + '</td>'
      +   '<td class="admin-actions">' + roleSelect + setPwForm + regenBtn + deleteBtn + '</td>'
      + '</tr>';
  }).join('');

  // Stream-cache status + manual warm trigger.
  let scStats = { total: 0, fresh: 0, stale: 0, updatedAt: null, ttlHours: 0 };
  try { scStats = streamcache.stats(); } catch (e) { /* file may not exist yet */ }
  const scUpdated = scStats.updatedAt ? scStats.updatedAt.slice(0, 16).replace('T', ' ') : 'never';
  const scWarmer = config.streamCache.refresh
    ? ('every ' + config.streamCache.refreshHours + 'h')
    : 'disabled (STREAM_CACHE_REFRESH=off)';
  const streamCacheHtml = ''
    + '<h3 class="sec">Stream cache</h3>'
    + '<p class="hint">Cached indexer results (Prowlarr + Zilean candidates) per event, so stream requests skip the live search. TTL ' + scStats.ttlHours + 'h. Auto-warm: ' + escapeHtml(scWarmer) + '.</p>'
    + '<p style="font-size:13px;color:var(--muted);margin:0 0 10px;">'
    +   '<strong style="color:var(--text);">' + scStats.fresh + '</strong> fresh / '
    +   '<strong style="color:var(--text);">' + scStats.total + '</strong> cached events'
    +   ' &middot; last warmed ' + escapeHtml(scUpdated)
    + '</p>'
    + '<form method="POST" action="/admin/refresh-streams" style="display:inline;">'
    +   '<button class="btn-install" type="submit">Warm stream cache now</button>'
    + '</form>';

  // Indexer sources (effective values: stored override, else env fallback).
  const _pw = settings.getProwlarr();
  const _zl = settings.getZilean();
  const sourcesHtml = ''
    + '<h3 class="sec">Indexer sources</h3>'
    + '<p class="hint">Point the addon at your own indexers. At least one is needed for stream results (metadata works without). Values saved here override env vars and apply immediately — no restart. Leave blank to disable a source.</p>'
    + '<form method="POST" action="/admin/sources">'
    +   '<label class="lbl">Prowlarr URL</label>'
    +   '<input class="inp mono" name="prowlarrUrl" value="' + escapeHtml(_pw.url) + '" placeholder="http://prowlarr:9696" autocomplete="off">'
    +   secretField('Prowlarr API key', 'prowlarrApiKey', _pw.apiKey, 'Prowlarr \u2192 Settings \u2192 General \u2192 API Key')
    +   '<label class="lbl">Zilean URL</label>'
    +   '<input class="inp mono" name="zileanUrl" value="' + escapeHtml(_zl.url) + '" placeholder="http://zilean:8181" autocomplete="off">'
    +   '<button class="btn-install" type="submit">Save sources</button>'
    + '</form>';

  const body = ''
    + '<p style="color:var(--muted);font-size:13px;margin:0 0 16px;">'
    +   'Admin panel — manage users for this SeriousSportSync instance. '
    +   'Logged in as <code>' + escapeHtml(currentUser.username) + '</code>.'
    + '</p>'
    + flashHtml
    + sourcesHtml
    + '<h3 class="sec">Users (' + all.length + ')</h3>'
    + '<table class="user-list">'
    +   '<thead><tr>'
    +     '<th>Username</th><th>Role</th><th>Created</th><th>Last seen</th>'
    +     '<th></th>'
    +   '</tr></thead>'
    +   '<tbody>' + rows + '</tbody>'
    + '</table>'
    + '<h3 class="sec">Create a new user</h3>'
    + '<p class="hint">After creating a user, they log in at the root URL and copy their own install URL from their account page. Install URLs and API tokens are private to each user and are never shown here.</p>'
    + '<form method="POST" action="/admin/users/create">'
    +   '<label class="lbl">Username</label>'
    +   '<input class="inp" name="username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9_.\\-]{3,32}" placeholder="3-32 chars, letters/digits/_-.">'
    +   '<label class="lbl">Password</label>'
    +   '<input class="inp" name="password" type="password" required minlength="8" placeholder="min 8 chars">'
    +   '<label class="lbl">Role</label>'
    +   '<select class="inp" name="role"><option value="user" selected>user</option><option value="admin">admin</option></select>'
    +   '<button class="btn-install" type="submit">Create user</button>'
    + '</form>'
    + streamCacheHtml
    + '<script>document.addEventListener("click",function(e){var b=e.target&&e.target.closest?e.target.closest(".btn-reveal"):null;if(!b)return;e.preventDefault();var i=b.parentNode.querySelector("input");if(!i)return;var sh=i.type==="password";i.type=sh?"text":"password";b.textContent=sh?"Hide":"Show";});document.addEventListener("click",function(e){var c=e.target&&e.target.closest?e.target.closest(".btn-copy"):null;if(!c)return;var u=c.getAttribute("data-copy");if(!u)return;if(navigator.clipboard)navigator.clipboard.writeText(u);var t=c.textContent;c.textContent="Copied!";setTimeout(function(){c.textContent=t;},1500);});</script>'
    + '<div style="margin-top:24px;padding-top:18px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">'
    +   '<a href="/account" style="color:var(--accent);text-decoration:none;font-weight:500;">← Back to your account</a>'
    +   '<div style="display:flex;gap:14px;">'
    +     '<a href="/admin/health" style="color:var(--text);text-decoration:none;font-size:13px;">📊 Health</a>'
    +     '<a href="/admin/backup" style="color:var(--text);text-decoration:none;font-size:13px;">⬇️ Backup</a>'
    +   '</div>'
    + '</div>';

  return accountPage('Admin — SeriousSportSync', body, 'admin');
}

// 0.24.0: admin observability page. Pure render — no state mutation. All the
// data lives in lib/{rd,tb,pm}-denylist, lib/positive-cache, lib/streamcache,
// and scripts/refresh-streams' status file.
function renderHealthPage(currentUser, opts) {
  opts = opts || {};
  let flashHtml = '';
  if (opts.flash) {
    flashHtml = '<div class="flash">' + escapeHtml(opts.flash) + '</div>';
  }

  // Helpers: compact stat blocks + wipe buttons.
  function denyCard(provider, dl) {
    let s = { total: 0, fresh: 0, stale: 0, hard: 0, soft: 0, ttlDays: 0, softTtlHours: 0 };
    try { s = dl.stats(); } catch (e) { /* file may not exist yet */ }
    const kind = provider.toLowerCase() + '-denylist';
    return ''
      + '<div class="health-card">'
      +   '<h3>' + provider + ' denylist</h3>'
      +   '<div class="health-row"><strong>' + s.fresh + '</strong> fresh ('
      +     s.hard + ' hard, ' + s.soft + ' soft)</div>'
      +   '<div class="health-row health-sub">' + s.stale + ' stale &middot; hard TTL '
      +     s.ttlDays + 'd &middot; soft TTL ' + s.softTtlHours + 'h</div>'
      +   '<form method="POST" action="/admin/health/wipe/' + kind + '" '
      +     'onsubmit="return confirm(\'Wipe the ' + provider + ' denylist? '
      +     'All ' + s.fresh + ' entries will be removed.\');" style="margin-top:8px;">'
      +     '<button type="submit" class="btn-sm btn-danger">Wipe</button>'
      +   '</form>'
      + '</div>';
  }

  // Positive cache
  let posS = { totalHashes: 0, freshEntries: 0, byProvider: {}, ttlDays: 0 };
  try { posS = positiveCache.stats(); } catch (e) { /* */ }
  const byProvText = ['rd', 'tb', 'pm']
    .map((p) => p.toUpperCase() + ': ' + (posS.byProvider[p] || 0))
    .join(' &middot; ');
  const positiveCardHtml = ''
    + '<div class="health-card">'
    +   '<h3>Positive cache</h3>'
    +   '<div class="health-row"><strong>' + posS.freshEntries + '</strong> fresh entr'
    +     (posS.freshEntries === 1 ? 'y' : 'ies') + ' across <strong>'
    +     posS.totalHashes + '</strong> hash' + (posS.totalHashes === 1 ? '' : 'es') + '</div>'
    +   '<div class="health-row health-sub">' + byProvText + ' &middot; TTL ' + posS.ttlDays + 'd</div>'
    +   '<form method="POST" action="/admin/health/wipe/positive-cache" '
    +     'onsubmit="return confirm(\'Wipe positive cache? All known-cached '
    +     '(hash, provider) entries will be removed.\');" style="margin-top:8px;">'
    +     '<button type="submit" class="btn-sm btn-danger">Wipe</button>'
    +   '</form>'
    + '</div>';

  // Stream / candidate cache
  let scS = { total: 0, fresh: 0, stale: 0, updatedAt: null, ttlHours: 0 };
  try { scS = streamcache.stats(); } catch (e) { /* */ }
  const scUpdated = scS.updatedAt ? scS.updatedAt.slice(0, 16).replace('T', ' ') : 'never';
  const streamCacheCardHtml = ''
    + '<div class="health-card">'
    +   '<h3>Candidate cache</h3>'
    +   '<div class="health-row"><strong>' + scS.fresh + '</strong> fresh / <strong>'
    +     scS.total + '</strong> total events</div>'
    +   '<div class="health-row health-sub">TTL ' + scS.ttlHours + 'h &middot; last warmed ' + escapeHtml(scUpdated) + '</div>'
    +   '<form method="POST" action="/admin/refresh-streams" style="margin-top:8px;">'
    +     '<button type="submit" class="btn-sm">Warm now</button>'
    +   '</form>'
    + '</div>';

  // Warmer last run
  let w = null;
  try { w = readWarmerStatus && readWarmerStatus(); } catch (e) { w = null; }
  let warmerCardHtml;
  if (w) {
    const startStr = (w.lastRunStart || '').slice(0, 16).replace('T', ' ');
    const endStr   = (w.lastRunEnd   || '').slice(0, 16).replace('T', ' ');
    const verifyLine = w.verifyEnabled
      ? 'TB: ' + (w.tbHits || 0) + ' cached / ' + (w.tbMisses || 0) + ' not &middot; '
        + 'PM: ' + (w.pmHits || 0) + ' cached / ' + (w.pmMisses || 0) + ' not'
      : 'verification disabled (set WARMER_TB_TOKEN / WARMER_PM_KEY)';
    warmerCardHtml = ''
      + '<div class="health-card">'
      +   '<h3>Last warmer run</h3>'
      +   '<div class="health-row"><strong>' + (w.warmed || 0) + '</strong> warmed, '
      +     (w.failed || 0) + ' failed, ' + (w.totalCands || 0) + ' total candidates</div>'
      +   '<div class="health-row health-sub">' + verifyLine + '</div>'
      +   '<div class="health-row health-sub">window &minus;' + (w.windowDaysBack || 0)
      +     'd / +' + (w.windowDaysAhead || 0) + 'd &middot; '
      +     (w.durationSeconds || 0) + 's &middot; finished ' + escapeHtml(endStr) + '</div>'
      + '</div>';
  } else {
    warmerCardHtml = ''
      + '<div class="health-card">'
      +   '<h3>Last warmer run</h3>'
      +   '<div class="health-row health-sub">No warmer run recorded yet. The warmer runs every '
      +     config.streamCache.refreshHours + 'h (scheduled in server.js) or trigger one with the "Warm now" button.</div>'
      + '</div>';
  }

  // Backup card
  const backupCardHtml = ''
    + '<div class="health-card">'
    +   '<h3>Backup</h3>'
    +   '<div class="health-row health-sub">Download a timestamped tar.gz of /app/data (events, users, denylists, positive cache, stream cache, warmer status).</div>'
    +   '<a href="/admin/backup" class="btn-sm" style="display:inline-block;margin-top:8px;text-decoration:none;">Download backup</a>'
    + '</div>';

  // Inline styles tucked into the body (kept self-contained — no need to
  // touch the shared accountPage CSS for this one page).
  const styles = ''
    + '<style>'
    +   '.health-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-top:8px;}'
    +   '.health-card{background:rgba(255,255,255,0.02);border:1px solid var(--border);border-radius:10px;padding:14px 16px;}'
    +   '.health-card h3{margin:0 0 10px;font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;font-weight:600;}'
    +   '.health-row{font-size:14px;line-height:1.5;}'
    +   '.health-row.health-sub{font-size:12px;color:var(--muted);margin-top:2px;}'
    +   '.btn-danger{background:#2a0608 !important;color:var(--accent2) !important;border:1px solid #4a1015 !important;}'
    + '</style>';

  const body = styles
    + '<p style="color:var(--muted);font-size:13px;margin:0 0 16px;">'
    +   'Admin observability — denylists, positive cache, warmer status, candidate cache. '
    +   'Logged in as <code>' + escapeHtml(currentUser.username) + '</code>.'
    + '</p>'
    + flashHtml
    + '<div class="health-grid">'
    +   denyCard('RD', rdDenylist)
    +   denyCard('TB', tbDenylist)
    +   denyCard('PM', pmDenylist)
    +   positiveCardHtml
    +   streamCacheCardHtml
    +   warmerCardHtml
    +   backupCardHtml
    + '</div>'
    + '<div style="margin-top:24px;padding-top:18px;border-top:1px solid var(--border);">'
    +   '<a href="/admin" style="color:var(--accent);text-decoration:none;font-weight:500;">← Back to admin</a>'
    + '</div>';

  return accountPage('Health — SeriousSportSync', body, 'admin');
}

// Render a credential input as a masked field with a Show/Hide toggle.
// The toggle is wired by a small delegated listener in renderAccountPage.
function secretField(label, name, value, placeholder) {
  return ''
    + '<label class="lbl">' + label + '</label>'
    + '<div class="secret-row">'
    +   '<input class="inp mono" type="password" name="' + name + '" value="' + escapeHtml(value || '') + '" placeholder="' + escapeHtml(placeholder || '') + '" autocomplete="off">'
    +   '<button type="button" class="btn-reveal">Show</button>'
    + '</div>';
}

function renderAccountPage(user, opts) {
  opts = opts || {};
  const cfg = user.config || {};
  const apiToken = user.apiToken || '';
  // Install URL combines the request-derived origin (which honors
  // X-Forwarded-Proto/Host from cloudflared/nginx) with the per-user path.
  // opts.origin is computed by addon.js's publicOriginFromReq().
  const installPath = '/u/' + user.id + '/' + apiToken + '/manifest.json';
  const installUrl = (opts.origin || '') + installPath;
  const selected = new Set(Array.isArray(cfg.catalogs) ? cfg.catalogs : []);
  const selectAll = selected.size === 0;
  const ac = cfg.autoCache || {};

  // Catalog checkboxes per promotion.
  const catBlocks = [];
  for (const p of promotions.enabled) {
    const items = p.catalogs.map(function (c) {
      const checked = (selectAll || selected.has(c.id)) ? ' checked' : '';
      return '<label class="cat"><input type="checkbox" name="catalogs" value="'
        + escapeHtml(c.id) + '"' + checked + '> ' + escapeHtml(c.name) + '</label>';
    }).join('');
    catBlocks.push('<div class="cat-group"><div class="cat-group-title">'
      + escapeHtml(p.name) + '</div>' + items + '</div>');
  }
  const catRowsHtml = catBlocks.join('');

  let flashHtml = '';
  if (opts.flash) {
    let txt = '';
    if (opts.flash === 'saved') txt = '✓ Settings saved.';
    else if (opts.flash === 'token-regenerated') txt = '✓ API token regenerated. Old install URL no longer works.';
    else txt = opts.flash;
    flashHtml = '<div class="flash">' + escapeHtml(txt) + '</div>';
  }

  const adminLinkHtml = (user.role === 'admin')
    ? '<a href="/admin" class="header-link">Admin panel</a>'
    : '';

  const body = ''
    + '<div class="user-header">'
    +   '<div class="user-header-left"><span class="badge badge-' + escapeHtml(user.role) + '">'
    +     escapeHtml(user.role) + '</span> <strong>' + escapeHtml(user.username) + '</strong></div>'
    +   '<div class="user-header-right">' + adminLinkHtml
    +     ' <a href="/logout" class="header-link">Logout</a></div>'
    + '</div>'
    + flashHtml
    + '<form method="POST" action="/account/save" class="tabs-form">'
    +   '<div class="tabs">'
    +     '<input type="radio" name="__tab" id="t-services" checked>'
    +     '<input type="radio" name="__tab" id="t-catalogs">'
    +     '<input type="radio" name="__tab" id="t-manifest">'
    +     '<div class="tabstrip">'
    +       '<label for="t-services">Services</label>'
    +       '<label for="t-catalogs">Catalogs</label>'
    +       '<label for="t-manifest">Manifest</label>'
    +     '</div>'

    +     '<div class="tab-panel" data-tab="services">'
    +       '<h3 class="sec">Debrid providers</h3>'
    +       '<p class="hint">Leave a field blank to disable that provider for your account.</p>'
    +       secretField('Real-Debrid token', 'rd', cfg.rd, 'paste your RD token')
    +       secretField('TorBox API token', 'tb', cfg.tb, 'paste your TorBox token')
    +       secretField('Premiumize API key', 'pm', cfg.pm, 'paste your Premiumize key')

    +       '<h3 class="sec">Stream resolution</h3>'
    +       '<p class="hint">Limit how many cached releases to surface per event (each can return one link per debrid service). 0 = unlimited (default). Smaller numbers = faster, fewer options. Sorted by file size, largest first.</p>'
    +       '<label class="lbl">Max streams (0 = unlimited)</label>'
    +       '<input class="inp" type="number" name="maxStreams" min="0" max="20" value="'
    +         escapeHtml(String(cfg.maxStreams || 0)) + '" style="max-width:120px;">'

    +       '<h3 class="sec">Auto-warm cache on miss</h3>'
    +       '<p class="hint">When no cached streams exist, automatically queue the top candidate on the providers below. Uses your debrid storage quota. Server-wide AUTO_CACHE_ON_MISS must also be enabled by the admin.</p>'
    +       '<label class="cat"><input type="checkbox" name="autoCacheRD"' + (ac.rd ? ' checked' : '') + '> Auto-warm on Real-Debrid</label>'
    +       '<label class="cat"><input type="checkbox" name="autoCacheTB"' + (ac.tb ? ' checked' : '') + '> Auto-warm on TorBox</label>'
    +       '<label class="cat"><input type="checkbox" name="autoCachePM"' + (ac.pm ? ' checked' : '') + '> Auto-warm on Premiumize</label>'
    +     '</div>'

    +     '<div class="tab-panel" data-tab="catalogs">'
    +       '<h3 class="sec">Catalogs</h3>'
    +       '<p class="hint">Tick the catalogs you want to see in Stremio Discover. Unticked promotions are hidden from your install URL\'s manifest.</p>'
    +       '<div class="cats">' + catRowsHtml + '</div>'
    +     '</div>'

    +     '<div class="tab-panel" data-tab="manifest">'
    +       '<h3 class="sec">Install URL</h3>'
    +       '<p class="hint">Use this URL to install the addon in Stremio. It is tied to your account and API token.</p>'
    +       '<div class="url-row"><code id="murl">' + escapeHtml(installUrl) + '</code>'
    +         '<button class="btn-copy" type="button" id="copyUrlBtn">Copy</button></div>'
    +       '<h3 class="sec">API token</h3>'
    +       '<p class="hint">If your install URL leaks, regenerate this token. Your existing Stremio install stops working immediately; you\'ll need to reinstall with the new URL.</p>'
    +       '<div class="url-row"><code style="word-break:break-all;">' + escapeHtml(apiToken) + '</code></div>'
    +       '<button class="btn-danger" type="submit" formaction="/account/regenerate-token" formnovalidate onclick="return confirm(\'Regenerate API token? Your existing Stremio install stops working immediately.\');" style="margin-top:14px;">Regenerate token</button>'
    +     '</div>'
    +   '</div>'

    +   '<div class="form-actions">'
    +     '<button class="btn-install" type="submit">Save settings</button>'
    +     '<span class="form-actions-hint">Saves Services + Catalogs at the same time.</span>'
    +   '</div>'
    + '</form>'
    + '<script>'
    + '(function(){'
    +   'var btn = document.getElementById("copyUrlBtn"), code = document.getElementById("murl");'
    +   'if (!btn || !code) return;'
    +   'btn.addEventListener("click", function() {'
    +     'var t = code.textContent;'
    +     'if (navigator.clipboard) { navigator.clipboard.writeText(t); }'
    +     'btn.textContent = "Copied!"; setTimeout(function(){ btn.textContent = "Copy"; }, 1800);'
    +   '});'
    + '})();'
    + 'document.addEventListener("click", function(e){'
    +   'var b = e.target && e.target.closest ? e.target.closest(".btn-reveal") : null;'
    +   'if (!b) return; e.preventDefault();'
    +   'var i = b.parentNode.querySelector("input"); if (!i) return;'
    +   'var show = i.type === "password"; i.type = show ? "text" : "password";'
    +   'b.textContent = show ? "Hide" : "Show";'
    + '});'
    + '</script>';

  return accountPage('Account — SeriousSportSync', body);
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

function authPage(title, bodyHtml) {
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
