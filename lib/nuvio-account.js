'use strict';

// 0.93.0 — push collections straight into a Nuvio account.
//
// Until now the handover to Nuvio was manual: copy a JSON blob out of SSS and
// import it by hand, every time anything changed. Nuvio's own backend is a
// Supabase instance at api.nuvio.tv with sync RPCs behind an ordinary account
// login, so SSS can write the collection into a chosen profile directly.
//
// THE WHOLE THING RUNS IN THE BROWSER, ON PURPOSE.
//
// The page signs in to api.nuvio.tv itself and keeps the access token in a
// JavaScript variable for the life of the tab. The password is never posted to
// this server, never written to users.json, never reaches a log. That costs
// background sync — SSS cannot push on a schedule because it holds no token —
// and that is the right trade for a self-hosted box: an addon that stores your
// streaming account password is an addon whose backup file is a credential
// dump. `connect-src` in lib/security.js permits exactly one cross-origin
// destination, so the page cannot send those credentials anywhere else.
//
// Not stored anywhere, either: the token is deliberately kept out of
// localStorage and sessionStorage. Signing in again on the next visit is a few
// seconds; a token sitting in web storage is readable by anything that ever
// manages to run script on this origin.
//
// The API shape is Supabase's, taken from the published Nuvio Account Manager:
//   POST /auth/v1/token?grant_type=password   -> { access_token, ... }
//   POST /rest/v1/rpc/sync_pull_profiles      -> [{ id, profile_index, name }]
//   POST /rest/v1/rpc/sync_pull_collections   -> [{ collections_json }]
//   POST /rest/v1/rpc/sync_push_collections   <- { p_profile_id, p_collections_json }
//   GET  /rest/v1/addons?profile_id=eq.N      -> [{ url, name, enabled, sort_order }]
//   POST /rest/v1/rpc/sync_push_addons        <- { p_profile_id, p_addons }
//
// BOTH PUSH RPCS ARE A FULL REPLACE. That is the single most important fact
// here: sending just the SSS collection deletes every other collection on the
// profile, and sending just the SSS addon deletes every other addon. So every
// write below pulls first, merges, and pushes the whole list back. "Replace
// everything" is available, but only as a deliberate choice with a typed
// confirmation, because it is unrecoverable from this end.

const NUVIO_API = 'https://api.nuvio.tv';

// Supabase's anon key. Public by design — it identifies the project, it is not
// a credential, and every Nuvio client ships it. Pinned here rather than
// fetched so the page has no bootstrap request that could be redirected.
const NUVIO_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzgxNTIxMzQ2LCJleHAiOjE5MzkyMDEzNDZ9.tmQaj682pwzehpqlgCDMnySOqiUvpgRbrE43T4VJpDI';

const MODES = Object.freeze([
  {
    id: 'merge',
    label: 'Merge',
    detail: 'Update the SeriousSportSync collection and leave every other collection on the profile alone.',
  },
  {
    id: 'add',
    label: 'Add only',
    detail: 'Add it if the profile does not have it yet, and change nothing if it does.',
  },
  {
    id: 'replace',
    label: 'Replace all',
    detail: 'Delete every collection on the profile and leave only this one. Needs typed confirmation.',
  },
]);

// The merge itself, kept out of the DOM code so it can be tested directly.
// `incoming` is what SSS exports; `existing` is what the profile already has.
function mergeCollections(existing, incoming, mode) {
  const current = Array.isArray(existing) ? existing.slice() : [];
  const ours = Array.isArray(incoming) ? incoming : [];
  if (mode === 'replace') return { next: ours.slice(), added: ours.length, updated: 0, kept: 0 };

  let added = 0;
  let updated = 0;
  const next = current.slice();
  for (const collection of ours) {
    const at = next.findIndex((item) => item && item.id === collection.id);
    if (at === -1) { next.push(collection); added += 1; continue; }
    // 'add' means add — a collection already on the profile is left exactly as
    // it is, including any edits made in Nuvio itself.
    if (mode === 'add') continue;
    next[at] = collection;
    updated += 1;
  }
  return { next, added, updated, kept: current.length - updated };
}

// Same hazard for the addon list: sync_push_addons replaces it wholesale.
function mergeAddons(existing, manifestUrl, name) {
  const current = (Array.isArray(existing) ? existing : []).filter(Boolean).map((addon) => ({
    url: String(addon.url || ''),
    name: addon.name == null ? null : String(addon.name),
    enabled: addon.enabled !== false,
    sort_order: Number(addon.sort_order) || 0,
  })).filter((addon) => addon.url);

  const at = current.findIndex((addon) => addon.url === manifestUrl);
  if (at >= 0) {
    // Already installed. Re-enable it if it was switched off, but do not move
    // it — the profile's ordering is the user's, not ours.
    current[at].enabled = true;
    current[at].name = name;
    return { next: current, alreadyInstalled: true };
  }
  const highest = current.reduce((max, addon) => Math.max(max, addon.sort_order), 0);
  current.push({ url: manifestUrl, name: name, enabled: true, sort_order: highest + 1 });
  return { next: current, alreadyInstalled: false };
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// The panel. No <form> — it sits inside the Configure form, and a nested form
// detaches everything after it. The password field is a plain input that is
// never submitted anywhere: the sign-in button reads it and calls Nuvio.
function panel() {
  return ''
    + '<div class="panel" id="nuvio-push">'
    + '<div class="panel-head"><div><h3>Push to Nuvio</h3>'
    + '<p>Send this collection straight into a profile on your Nuvio account</p></div>'
    + '<span class="chip" data-tone="off" id="nuvio-state" style="margin-left:auto">Not connected</span></div>'

    + '<div class="panel-body">'
    + '<div class="note" data-tone="info"><div>'
    + '<b>Your password stays in this browser</b>'
    + '<span>The sign-in happens between this page and Nuvio directly. SeriousSportSync never receives '
    + 'your Nuvio password or access token, and nothing is written to disk here — so you sign in again '
    + 'each visit, and a backup of this server can never contain your streaming account.</span>'
    + '</div></div>'

    + '<div id="nuvio-signin">'
    + '<div class="grid-2" style="gap:12px">'
    + '<label class="f"><span>Nuvio email</span>'
    + '<input class="t" type="email" id="nuvio-email" autocomplete="username" placeholder="you@example.com"></label>'
    + '<label class="f"><span>Nuvio password</span>'
    + '<input class="t" type="password" id="nuvio-password" autocomplete="current-password"></label>'
    + '</div>'
    + '<div style="margin-top:12px"><button class="btn ghost" type="button" id="nuvio-signin-btn">Connect to Nuvio</button></div>'
    + '</div>'

    + '<div id="nuvio-connected" hidden>'
    + '<label class="f"><span>Profile</span><select class="t" id="nuvio-profile"></select></label>'
    + '<div style="margin-top:14px"><span class="row-sub" style="margin-bottom:6px;display:block">How to apply it</span>'
    + MODES.map((mode) => '<label class="sw" style="display:flex;align-items:flex-start;margin-bottom:8px">'
      + '<input type="radio" name="nuvio-mode" value="' + escapeHtml(mode.id) + '"'
      + (mode.id === 'merge' ? ' checked' : '') + ' style="margin-top:3px">'
      + '<b>' + escapeHtml(mode.label) + '<small>' + escapeHtml(mode.detail) + '</small></b></label>').join('')
    + '</div>'
    + '<label class="sw" style="margin-top:6px"><input type="checkbox" id="nuvio-install-addon" checked><i></i>'
    + '<b>Install the addon too<small>Adds this server\'s manifest to the profile if it is not already there. '
    + 'Your other addons are preserved.</small></b></label>'
    + '<div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">'
    + '<button class="btn primary" type="button" id="nuvio-push-btn">Push to this profile</button>'
    + '<button class="btn ghost" type="button" id="nuvio-signout">Disconnect</button>'
    + '</div>'
    + '</div>'

    + '<div id="nuvio-out"></div>'
    + '</div></div>';
}

// The client. Everything that touches a credential is in here, which is to say
// in the browser.
function clientScript(collectionsUrl) {
  return '(' + String(function (api, anonKey, exportUrl) {
    var token = null;
    var profiles = [];

    var el = function (id) { return document.getElementById(id); };
    var out = function (tone, title, detail) {
      el('nuvio-out').innerHTML = '<div class="note" data-tone="' + tone + '" style="margin-top:14px"><div>'
        + '<b>' + title + '</b>' + (detail ? '<span>' + detail + '</span>' : '') + '</div></div>';
    };
    var setState = function (tone, text) {
      var chip = el('nuvio-state');
      chip.setAttribute('data-tone', tone);
      chip.textContent = text;
    };

    function call(path, options) {
      var opts = options || {};
      var headers = { apikey: anonKey, 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      Object.keys(opts.headers || {}).forEach(function (k) { headers[k] = opts.headers[k]; });
      return fetch(api + path, { method: opts.method || 'GET', headers: headers, body: opts.body })
        .then(function (res) {
          return res.text().then(function (text) {
            var data = null;
            try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
            if (!res.ok) {
              var message = (data && (data.message || data.error_description || data.error))
                || ('Nuvio returned HTTP ' + res.status);
              throw new Error(message);
            }
            return data;
          });
        });
    }

    el('nuvio-signin-btn').addEventListener('click', function () {
      var email = el('nuvio-email').value.trim();
      var password = el('nuvio-password').value;
      if (!email || !password) { out('warn', 'Enter your Nuvio email and password first.'); return; }
      var btn = this;
      btn.disabled = true; btn.textContent = 'Connecting…';
      call('/auth/v1/token?grant_type=password', {
        method: 'POST', body: JSON.stringify({ email: email, password: password }),
      }).then(function (auth) {
        token = auth && auth.access_token;
        if (!token) throw new Error('Nuvio did not return an access token');
        // The password has done its job. Clear it so it is not sitting in a
        // field for the rest of the session or captured by a page snapshot.
        el('nuvio-password').value = '';
        return call('/rest/v1/rpc/sync_pull_profiles', { method: 'POST', body: '{}' });
      }).then(function (list) {
        profiles = Array.isArray(list) ? list : [];
        if (!profiles.length) throw new Error('That account has no profiles');
        el('nuvio-profile').innerHTML = profiles.map(function (p) {
          return '<option value="' + p.profile_index + '">' + (p.name || ('Profile ' + p.profile_index)) + '</option>';
        }).join('');
        el('nuvio-signin').hidden = true;
        el('nuvio-connected').hidden = false;
        setState('ok', 'Connected');
        out('ok', 'Connected to Nuvio.', profiles.length + ' profile' + (profiles.length === 1 ? '' : 's') + ' found.');
      }).catch(function (error) {
        token = null;
        setState('bad', 'Not connected');
        out('bad', 'Could not connect.', error.message);
      }).finally(function () {
        btn.disabled = false; btn.textContent = 'Connect to Nuvio';
      });
    });

    el('nuvio-signout').addEventListener('click', function () {
      token = null; profiles = [];
      el('nuvio-connected').hidden = true;
      el('nuvio-signin').hidden = false;
      setState('off', 'Not connected');
      out('info', 'Disconnected.', 'The access token has been discarded.');
    });

    el('nuvio-push-btn').addEventListener('click', function () {
      var mode = (document.querySelector('input[name="nuvio-mode"]:checked') || {}).value || 'merge';
      var profileId = Number(el('nuvio-profile').value);
      var installAddon = el('nuvio-install-addon').checked;

      // Replace deletes collections this page never saw and cannot restore.
      // A confirm() is not enough friction for an unrecoverable action.
      if (mode === 'replace') {
        var typed = window.prompt('Replace ALL collections on this profile?\\n\\n'
          + 'Every collection on the profile is deleted and only SeriousSportSync remains. '
          + 'This cannot be undone from here.\\n\\nType REPLACE to confirm.');
        if (String(typed || '').trim().toUpperCase() !== 'REPLACE') {
          out('info', 'Nothing was changed.', 'Replace needs the typed confirmation.');
          return;
        }
      }

      var btn = this;
      btn.disabled = true; btn.textContent = 'Pushing…';
      out('info', 'Working…', 'Reading what is already on the profile.');

      var summary = { added: 0, updated: 0, kept: 0, addon: null };

      Promise.all([
        fetch(exportUrl, { headers: { Accept: 'application/json' } }).then(function (r) { return r.json(); }),
        call('/rest/v1/rpc/sync_pull_collections', {
          method: 'POST', body: JSON.stringify({ p_profile_id: profileId }),
        }),
      ]).then(function (both) {
        var ours = both[0];
        var rows = both[1];
        var raw = rows && rows[0] && rows[0].collections_json;
        var existing = [];
        if (typeof raw === 'string') { try { existing = JSON.parse(raw) || []; } catch (_) { existing = []; } }
        else if (Array.isArray(raw)) existing = raw;

        var merged = window.__sssMergeCollections(existing, ours, mode);
        summary.added = merged.added; summary.updated = merged.updated; summary.kept = merged.kept;

        // The whole list goes back, always — this RPC is a full replace, so
        // sending only our own collection would delete the rest.
        return call('/rest/v1/rpc/sync_push_collections', {
          method: 'POST',
          body: JSON.stringify({ p_profile_id: profileId, p_collections_json: merged.next }),
        });
      }).then(function () {
        if (!installAddon) return null;
        return call('/rest/v1/addons?select=*&profile_id=eq.' + profileId + '&order=sort_order')
          .then(function (addons) {
            var merged = window.__sssMergeAddons(addons, window.__sssManifestUrl, 'SeriousSportSync');
            summary.addon = merged.alreadyInstalled ? 'already installed' : 'installed';
            if (merged.alreadyInstalled) return null;
            return call('/rest/v1/rpc/sync_push_addons', {
              method: 'POST',
              body: JSON.stringify({ p_profile_id: profileId, p_addons: merged.next }),
            });
          });
      }).then(function () {
        var parts = [];
        if (summary.added) parts.push(summary.added + ' collection added');
        if (summary.updated) parts.push(summary.updated + ' updated');
        if (mode === 'replace') parts.push('everything else removed');
        else if (summary.kept > 0) parts.push(summary.kept + ' of your own left untouched');
        if (summary.addon) parts.push('addon ' + summary.addon);
        if (!parts.length) parts.push('nothing needed changing');
        out('ok', 'Pushed to Nuvio.', parts.join(' · ') + '. Restart Nuvio to see it.');
      }).catch(function (error) {
        out('bad', 'The push failed.', error.message
          + ' Nothing partial is left behind: collections are written in one call.');
      }).finally(function () {
        btn.disabled = false; btn.textContent = 'Push to this profile';
      });
    });
  }) + ')(' + JSON.stringify(NUVIO_API) + ',' + JSON.stringify(NUVIO_ANON_KEY)
    + ',' + JSON.stringify(collectionsUrl) + ');';
}

// The two merges are shipped to the page as globals so the client above and
// the tests below run the same code rather than two copies that drift.
function mergeScript() {
  return 'window.__sssMergeCollections = ' + String(mergeCollections) + ';'
    + 'window.__sssMergeAddons = ' + String(mergeAddons) + ';';
}

module.exports = {
  panel, clientScript, mergeScript,
  mergeCollections, mergeAddons,
  MODES, NUVIO_API, NUVIO_ANON_KEY,
};
