'use strict';

// The "select your team" wizard, rendered on the Configure page.
//
// This is the user-facing half of lib/team-picker.js: four choosers, one per
// sport, each turning a pick into a promotion with catalogs. It lives on
// Configure rather than in Admin because it is a choice a person makes about
// their own viewing, which is the line the operator asked for — Admin is what
// an operator runs, Configure is what a user chooses.
//
// Creating a promotion does change the shared registry, so the action itself
// stays admin-only. A non-admin sees the wizard, sees what it would do, and is
// told plainly that an admin has to create it. Hiding it entirely would be
// worse: they would have no way to know the feature exists or what to ask for.

const teamPicker = require('./team-picker');
const promotions = require('./promotions');

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

// Promotions this wizard already created, so a chooser can show the pick as
// made rather than offering it again as if nothing happened.
function existingPicks() {
  const out = new Map();
  for (const chooser of teamPicker.CHOOSERS) {
    const prefix = chooser.key + '-';
    const match = promotions.all.find((promotion) =>
      promotion.isCustom && String(promotion.id).startsWith(prefix));
    if (match) out.set(chooser.key, match);
  }
  return out;
}

function renderBody(opts) {
  const options = opts || {};
  const isAdmin = options.isAdmin === true;
  const picks = options.picks || existingPicks();

  const cards = teamPicker.CHOOSERS.map((chooser) => {
    const existing = picks.get(chooser.key);
    const chosen = existing
      ? '<div class="team-chosen"><strong>' + escapeHtml(existing.name) + '</strong>'
        + '<span class="text-secondary small"> · catalogs created</span></div>'
      : '';
    return '<div class="team-card" data-chooser="' + escapeHtml(chooser.key) + '">'
      + '<div class="team-card-head"><h3>' + escapeHtml(chooser.label) + '</h3></div>'
      + '<p class="text-secondary small mb-2">' + escapeHtml(chooser.hint) + '</p>'
      + chosen
      + '<div class="d-flex gap-2 align-items-center flex-wrap">'
      + '<select class="form-select team-select" disabled><option>Loading teams…</option></select>'
      + '<button class="btn btn-primary team-create" type="button"'
      + (isAdmin ? '' : ' disabled') + '>' + (existing ? 'Replace' : 'Create catalogs') + '</button>'
      + '</div>'
      + '<div class="team-status text-secondary small mt-2" aria-live="polite"></div>'
      + '</div>';
  }).join('');

  const note = isAdmin
    ? '<p class="text-secondary small mb-3">Picking a team creates a promotion with Upcoming and Recent catalogs, then refreshes it. '
      + 'Football clubs use a team feed, so they carry every competition your football-data key covers; '
      + 'the US sports narrow their league feed to your club.</p>'
    : '<div class="alert alert-info">A team catalog is shared by everyone on this server, so an admin creates it. '
      + 'Choose your team below and ask an admin to add it.</div>';

  return '<style>'
    + '.team-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}'
    + '.team-card{border:1px solid var(--tblr-border-color);border-radius:12px;padding:15px;background:rgba(255,255,255,.018)}'
    + '.team-card-head h3{margin:0 0 4px;font-size:1rem}'
    + '.team-card .form-select{flex:1 1 200px;min-width:180px}'
    + '.team-chosen{margin-bottom:8px}'
    + '@media(max-width:720px){.team-grid{grid-template-columns:1fr}}'
    + '</style>'
    + note
    + '<div class="team-grid">' + cards + '</div>'
    + '<script>(function(){'
    + 'function post(url,body){return fetch(url,{method:"POST",credentials:"same-origin",'
    + 'headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams(body)});}'
    + 'document.querySelectorAll(".team-card").forEach(function(card){'
    + 'var key=card.dataset.chooser,select=card.querySelector(".team-select"),'
    + 'button=card.querySelector(".team-create"),status=card.querySelector(".team-status");'
    + 'fetch("/account/teams/"+encodeURIComponent(key)+".json",{credentials:"same-origin"})'
    + '.then(function(r){return r.json();}).then(function(data){'
    + 'if(!data.ok){select.innerHTML="<option>Unavailable</option>";status.textContent=data.error||"Could not load teams";return;}'
    + 'select.innerHTML=data.teams.map(function(t){'
    + 'return "<option value=\\""+t.id+"\\">"+t.name+"</option>";}).join("");'
    + 'select.disabled=false;'
    + '}).catch(function(e){select.innerHTML="<option>Unavailable</option>";status.textContent=e.message;});'
    + 'if(!button||button.disabled)return;'
    + 'button.addEventListener("click",function(){'
    + 'if(!select.value)return;'
    + 'button.disabled=true;status.textContent="Creating catalogs and fetching fixtures…";'
    + 'post("/account/teams",{chooser:key,teamId:select.value}).then(function(r){return r.json();})'
    + '.then(function(data){'
    + 'if(!data.ok){status.textContent=data.error||"Could not create the catalogs";button.disabled=false;return;}'
    + 'status.textContent=data.name+" added — "+data.events+" fixture(s). Reload to see its catalogs.";'
    + '}).catch(function(e){status.textContent=e.message;button.disabled=false;});'
    + '});});'
    + '})();</script>';
}

module.exports = { renderBody, existingPicks };
