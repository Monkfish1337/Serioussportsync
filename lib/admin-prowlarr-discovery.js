'use strict';
const discovery = require('./prowlarr-discovery');
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time = value => value ? require('./display-time').displayTime(value).slice(0,19)+' '+esc(require('./settings').getDisplayTimeZone()) : 'Ready';
// Discovery → Prowlarr (issue #72). Built from the native components in
// lib/ui/css.js: what the queue is doing and what is missing first, actions
// next, history and settings folded away. The old page opened with a 190px
// paragraph and ran to almost four screens.
function render(input) {
  const status = input || discovery.getDefault().status(), opt = status.options;
  const allEvents = require('./store').getEvents();
  const eventById = new Map(allEvents.map(event=>[event.id,event]));
  const missing = (status.eventStates || []).filter(event=>!event.seeded);
  const activeMissing = status.eventStates && new Set(missing.map(event=>event.id));
  const retryJobs = status.retryJobs || (activeMissing ? status.jobs.filter(job=>activeMissing.has(job.event)) : status.jobs);
  const selectedPromotions=opt.promotions || ['mlb','nba','nfl'];
  const promotionNames=new Map(require('./promotions').all.map(p=>[p.id,p.name]));
  const promotionPicker=require('./promotions').all.map(p=>`<label class="sw"><input type="checkbox" name="promotions" value="${esc(p.id)}" ${selectedPromotions.includes(p.id)?'checked':''}><i></i><b>${esc(p.name)}</b></label>`).join('');
  const fields = [['intervalSeconds','Seconds between searches',60,3600],['dailyRequests','Requests per indexer per day',10,1000],['lookbackDays','Days of past games',1,90],['timeoutSeconds','Search timeout (seconds)',30,180]];
  const p=status.progress;
  const sw=status.sweep;
  const running=sw && !sw.finishedAt;
  const nameOf=id=>esc(eventById.get(id)?.name || id);
  const leagueName=id=>esc(promotionNames.get(id) || String(id).toUpperCase());
  const now=Date.now();
  const table=(head,rows,empty)=>`<div class="tbl-wrap tbl-scroll"><table class="tbl"><thead><tr>${head.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${head.length}">${empty}</td></tr>`}</tbody></table></div>`;
  const fold=(title,sub,body)=>`<details class="fold"><summary><div><h3>${title}</h3>${sub?`<p>${sub}</p>`:''}</div></summary><div class="fold-body">${body}</div></details>`;
  const sweepButton=(label,promotion,primary)=>`<form method="POST" action="/admin/prowlarr-discovery/search-now">${promotion?`<input type="hidden" name="promotion" value="${esc(promotion)}">`:''}<button class="btn sm ${primary?'primary':'ghost'}" ${running||!opt.enabled?'disabled':''}>${esc(label)}</button></form>`;
  const byLeague=(p?p.byPromotion:[]).map(row=>({...row,missing:missing.filter(e=>e.promotion===row.id).length}));

  const state=!opt.enabled?['off','Off']:running?['info','Searching now']:missing.length?['warn',missing.length+' missing']:['ok','Up to date'];
  const stats=p?[['Games in window',p.eligible],['With a saved release',p.matched],['Still missing',p.outstanding],['Never searched',p.untouched]]:[];
  const summary=`<section class="panel"><div class="panel-head"><div><h3>Queue</h3><p>One query on one indexer at a time.</p></div><span class="chip" data-tone="${state[0]}">${esc(state[1])}</span></div><div class="panel-body">
    ${stats.length?`<div class="dv-stats">${stats.map(([label,value])=>`<div class="stat"><b>${value}</b><span>${label}</span></div>`).join('')}</div>`:''}
    ${p && p.untouched && p.firstPassEstimateMs!==null?`<p class="hint">The rest get a first search in about ${esc((p.firstPassEstimateMs/3600000).toFixed(1))} hours at the current pace.</p>`:''}
    ${!opt.enabled?'<div class="note" data-tone="warn"><div><b>The queue is off.</b><span>Selected promotions search Prowlarr live when opened. Turn it on in Settings.</span></div></div>':''}
  </div></section>`;

  const sweepReport=sw?`<div class="note" data-tone="${running?'info':sw.matched?'ok':'warn'}"><div><b>${running?'Searching':'Searched'} ${esc(sw.label)}: ${sw.searches.length} of up to ${sw.planned} search${sw.planned===1?'':'es'}, ${sw.matched} game match${sw.matched===1?'':'es'} saved</b>${sw.note?`<span>${esc(sw.note)}</span>`:''}</div></div>`
    +(sw.searches.length?table(['Game','Indexer','Query','Saved'],sw.searches.map(r=>`<tr><td>${nameOf(r.eventId)}</td><td>${esc(r.indexer)}</td><td class="mono">${esc(r.query)}</td><td class="tabular">${r.matched}${r.partial?' <span class="hint">incomplete</span>':''}</td></tr>`),''):'')
    +(running?'<script>setTimeout(function(){location.reload();},5000);</script>':''):'';
  const missingSorted=missing.slice().sort((a,b)=>String(b.date).localeCompare(String(a.date))).slice(0,250);
  const searchNow=`<section class="panel"><div class="panel-head"><div><h3>Search now</h3><p>One search per missing game, up to 20, 10 s apart. Budgets still apply.</p></div></div><div class="panel-body">
    ${sweepReport}
    <div class="dv-actions">${sweepButton('Search all missing','',true)}${byLeague.filter(r=>r.missing).map(r=>sweepButton(promotionNames.get(r.id) ? promotionNames.get(r.id)+' · '+r.missing : r.id.toUpperCase()+' · '+r.missing,r.id,false)).join('')}</div>
    ${missingSorted.length?`<form method="POST" action="/admin/prowlarr-discovery/search-now" class="dv-inline"><label class="f"><span>One game</span><select class="t" name="eventId">${missingSorted.map(event=>`<option value="${esc(event.id)}">${esc(event.date+' · '+event.name)}</option>`).join('')}</select></label><button class="btn ghost" ${running||!opt.enabled?'disabled':''}>Search this game</button></form><p class="hint">Tries each indexer until one matches, up to four searches.</p>`:''}
    <p class="hint"><a href="/admin/discovery/manual">Match a release by hand</a> when searching cannot find it.</p>
  </div></section>`;

  const indexers=`<section class="panel"><div class="panel-head"><div><h3>Indexers</h3><p>${status.matches} saved matches. Each indexer has a daily budget and cools down after failures.</p></div></div>${table(['Indexer','Requests today','Successes','Next search',''],status.indexers.map(i=>{
      const cooling=i.failures>0;
      return `<tr><td><b>${esc(i.name)}</b>${cooling||i.ignoresDates?`<div class="row-tags">${cooling?`<span class="chip" data-tone="warn">${i.failures} failure${i.failures===1?'':'s'}</span>`:''}${i.ignoresDates?'<span class="chip" data-tone="off">Ignores dates</span>':''}</div>`:''}</td><td class="tabular">${i.requests} / ${opt.dailyRequests}</td><td class="tabular">${i.successes}</td><td>${i.next_at && i.next_at>now?time(i.next_at):'Ready'}</td><td><form method="POST" action="/admin/prowlarr-discovery/reset-cooldown"><input type="hidden" name="indexerId" value="${esc(i.id)}"><button class="btn sm ghost" aria-label="Reset cooldown for ${esc(i.name)}" ${cooling?'':'disabled'}>Reset cooldown</button></form></td></tr>`;}),'History starts when the queue finds an enabled indexer and a game to search.')}</section>`;

  const leagueRows=byLeague.filter(row=>row.eligible).map(row=>`<tr><td>${leagueName(row.id)}</td><td class="tabular">${row.eligible}</td><td class="tabular">${row.searched}</td><td class="tabular">${row.matched}</td><td class="tabular">${row.missing||''}</td></tr>`);
  const missingRows=missingSorted.map(e=>`<tr><td>${esc(e.name)}<span class="row-sub">${esc(e.date)}</span></td><td>${esc(e.state)}</td><td>${e.nextAt?time(e.nextAt):'—'}</td></tr>`);
  const retryRows=retryJobs.map(j=>{const event=eventById.get(j.event);return `<tr><td>${esc(event?.name || j.event)}${event?`<span class="row-sub">${esc(event.date)}</span>`:''}</td><td>${esc(status.indexers.find(i=>i.id===j.indexer)?.name || j.indexer)}</td><td>${esc(j.status)}</td><td>${time(j.next_at)}</td></tr>`;});
  const matchedRows=status.matchedEvents.map(event=>`<tr><td>${esc(event.name)}<span class="row-sub">${esc(event.date)}</span></td><td>${esc(event.indexers.join(', ') || 'Prowlarr')}</td><td class="tabular">${event.releases}</td><td>${time(event.at)}</td></tr>`);
  const history=
    fold('By league',`${leagueRows.length} league${leagueRows.length===1?'':'s'} with games in the window`,table(['League','Games','Searched','Saved','Missing'],leagueRows,'No games in the window.'))
    +fold('Missing games',`${missing.length} without a seeded release`,table(['Game','Status','Next retry'],missingRows,'Every game in the window has a saved release.'))
    +fold('Next retries',`${retryJobs.length} scheduled`,table(['Game','Indexer','Last outcome','Next retry'],retryRows,'No retries recorded yet.'))
    +fold('Successfully matched events',`${status.matchedEvents.length} games with saved releases; each account's TorBox check still applies`,table(['Game','Indexers','Releases','Saved'],matchedRows,'No saved matches yet.'));

  const settings=fold('Settings',opt.enabled?'Queue on · '+selectedPromotions.length+' promotion'+(selectedPromotions.length===1?'':'s'):'Queue off',`<form method="POST" action="/admin/prowlarr-discovery" class="dv-form">
    <label class="sw"><input type="checkbox" name="enabled" value="1" ${opt.enabled?'checked':''}><i></i><b>Use the queue for the promotions below<small>Off: they search Prowlarr live when an event is opened.</small></b></label>
    <input type="hidden" name="promotionSelection" value="1"><div><span class="dv-label">Promotions</span><div class="dv-picks">${promotionPicker}</div><p class="hint">None selected pauses the queue. Separate from Bitmagnet and Sport-Video.</p></div>
    <div class="grid-2">${fields.map(([key,label,min,max])=>`<label class="f"><span>${label}</span><input class="t" type="number" name="${key}" min="${min}" max="${max}" value="${opt[key]}" required></label>`).join('')}</div>
    <ul class="hint dv-rules"><li>At least 10 seconds between requests; torrent downloads count against the daily budget.</li><li>Failures cool an indexer down for 1–24 hours, longer if it asks.</li><li>Recent games retry sooner; the same query is not repeated within six hours.</li><li>A game stops being searched once it has a seeded release; every third search goes to an overdue retry.</li><li>Unseeded releases are fetched too, so TorBox can still be asked about them.</li></ul>
    <div><button class="btn primary">Save settings</button></div></form>`);

  return `<div class="dv-stack">${summary}${searchNow}${indexers}${history}${settings}</div>`;
}
function renderManual(data) {
  const events=data.events||[],event=data.event,candidates=data.candidates||[];
  const picker=`<form method="GET" action="/admin/discovery/manual"><label class="form-label" for="manual-event">Event</label><select class="form-select" id="manual-event" name="eventId">${events.map(row=>`<option value="${esc(row.id)}" ${event&&row.id===event.id?'selected':''}>${esc(row.date+' · '+row.name)}</option>`).join('')}</select><button class="btn btn-outline-secondary mt-2">Choose event</button></form>`;
  if(!event) return `<div class="page-header"><h2 class="page-title">Manual resource matching</h2><a href="/admin/discovery">Back to Discovery</a></div>${data.flash?`<div class="alert alert-info">${esc(data.flash)}</div>`:''}${picker}<p class="text-secondary mt-3">No recent past events are available.</p>`;
  const rows=candidates.map(row=>`<tr><td><input class="form-check-input" type="checkbox" name="hashes" value="${esc(row.infoHash)}"></td><td>${esc(row.title)}<div class="text-secondary small text-mono">${esc(row.infoHash)}</div></td><td>${esc(row.indexer)}</td><td>${row.seeders}</td><td>${row.automatic?'<span class="badge bg-green-lt">Automatic match</span>':'<span class="badge bg-orange-lt">Manual confirmation needed</span>'}</td></tr>`).join('');
  return `<div class="page-header"><h2 class="page-title">Manual resource matching</h2><a href="/admin/discovery">Back to Discovery</a></div>${data.flash?`<div class="alert alert-info">${esc(data.flash)}</div>`:''}<p>Search Bitmagnet and Prowlarr now, review torrent results, and save selected hashes directly against one event. A manual confirmation overrides title matching only for this event. Normal per-account TorBox availability checks still apply.</p>${picker}<div class="card my-3"><div class="card-body"><h3>${esc(event.name)}</h3><div class="text-secondary mb-3">${esc(event.date)}</div><form method="POST" action="/admin/discovery/manual/search"><input type="hidden" name="eventId" value="${esc(event.id)}"><label class="form-label" for="manual-query">Optional search terms</label><input class="form-control" id="manual-query" name="query" value="${esc(data.query||'')}" placeholder="Leave blank to use the event's torrent queries"><div class="form-hint">Separate several searches with semicolons. Manual searches are explicit and do not wait for queue budgets or live playback settings.</div><button class="btn btn-info mt-3">Search torrent sources</button></form></div></div><form method="POST" action="/admin/discovery/manual/save"><input type="hidden" name="eventId" value="${esc(event.id)}"><div class="table-responsive"><table class="table"><thead><tr><th></th><th>Release</th><th>Source</th><th>Seeders</th><th>Current matcher</th></tr></thead><tbody>${rows||'<tr><td colspan="5">No hashed torrent candidates saved for this event yet. Run a search above.</td></tr>'}</tbody></table></div><button class="btn btn-success" ${candidates.length?'':'disabled'}>Add selected results to database</button></form>`;
}
module.exports={render,renderManual};
