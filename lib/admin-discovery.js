'use strict';
const {escapeHtml:esc} = require('./ui/shell');
const tabs={overview:'Overview',events:'Events',prowlarr:'Prowlarr','sport-video':'Sport-Video',preparation:'Bitmagnet'};
function render(data) {
  const tab=Object.hasOwn(tabs,data.tab)?data.tab:'overview';
  const rows=new Map();
  for(const e of data.queue.eventStates || []) rows.set(e.id,{...e,sources:e.matched?['Prowlarr']:[]});
  const events=new Map(data.events.map(e=>[e.id,e]));
  for(const match of data.queue.matchedEvents || []) {
    const event=events.get(match.event || match.id);if(!event) continue;
    const row=rows.get(event.id) || {...event,sources:[],state:'Saved match — playback check required'};
    if(!row.sources.includes('Prowlarr')) row.sources.push('Prowlarr');
    rows.set(event.id,row);
  }
  for(const release of data.releases) for(const match of release.matches || []) {
    const event=events.get(match.eventId); if(!event) continue;
    const row=rows.get(event.id) || {...event,sources:[],state:'Not in measured queue'};
    if(!row.sources.includes('Sport-Video')) row.sources.push('Sport-Video');
    rows.set(event.id,row);
  }
  let body=data.body || '';
  if(tab==='overview' && data.coverage) {
    const c=data.coverage,names=new Map(data.promotions.map(p=>[p.id,p.name]));
    const missing=c.rows.filter(e=>!e.matched && (!data.promotion || e.promotion===data.promotion)).sort((a,b)=>String(b.date).localeCompare(String(a.date)));
    const time=require('./display-time').displayTime;
    body=`<div class="row row-cards my-3">${[['Past seven days',c.total],['Ready or warmable identities',c.matched],['Missing usable identities',c.missing]].map(([label,value])=>`<div class="col-md-4"><div class="card"><div class="card-body"><div class="text-secondary">${label}</div><div class="h1">${value}</div></div></div></div>`).join('')}</div>${data.coverageError?`<div class="alert alert-warning">Coverage is incomplete: ${esc(data.coverageError)}. Events without recorded matches may have database matches that could not be read.</div>`:''}<p>Rolling window: ${esc(time(c.from))} to ${esc(time(c.to))}. Unique past scheduled fixture events; disabled promotions and Sport-Video release-derived Discovered catalogs are excluded. See Sport-Video for their discovered, matched and prepared release counts. Future, cancelled and postponed events are excluded. Events without a start time are counted after their dated day ends in UTC.</p><p>Matched means an event has a relevant release with a usable torrent hash or Usenet/Easynews identity. These can be checked for playback or warmed where supported; credentials and provider availability still apply. Title-only matches do not count. This dashboard reads local evidence and makes no indexer searches.</p><h3>Coverage by promotion</h3><div class="table-responsive"><table class="table"><thead><tr><th>Promotion</th><th>Total</th><th>Ready / warmable</th><th>Missing</th><th>Recorded gap reasons / Prowlarr status</th></tr></thead><tbody>${c.promotions.map(p=>`<tr><td>${esc(names.get(p.id) || p.id)}</td><td>${p.total}</td><td>${p.matched}</td><td><a href="/admin/discovery?tab=overview&promotion=${encodeURIComponent(p.id)}">${p.missing}</a></td><td>${Object.entries(p.reasons).map(([reason,count])=>`${count} · ${esc(reason)}`).join('<br>') || 'All events have saved matches'}</td></tr>`).join('') || '<tr><td colspan="5">No past events in this window.</td></tr>'}</tbody></table></div><h3>Missing events</h3><form method="GET" action="/admin/discovery"><input type="hidden" name="tab" value="overview"><label class="form-label" for="coverage-promotion">Promotion</label><select class="form-select" name="promotion" id="coverage-promotion"><option value="">All promotions</option>${c.promotions.map(p=>`<option value="${esc(p.id)}" ${data.promotion===p.id?'selected':''}>${esc(names.get(p.id) || p.id)}</option>`).join('')}</select><button class="btn btn-outline-secondary my-2">Apply filter</button></form><p>${missing.length} events without a recorded usable identity (${c.titleOnly} title-only matches across all promotions). Reasons show saved evidence and source settings; enabled sources may have no recorded attempt or result. Live UU and Easynews are not searched to measure coverage.</p><div class="table-responsive"><table class="table"><thead><tr><th>Event</th><th>Date</th><th>Recorded reason / Prowlarr</th><th>Bitmagnet</th><th>Sport-Video</th><th>Next fixture retry</th></tr></thead><tbody>${missing.map(e=>`<tr><td>${esc(e.name)}</td><td>${esc(e.date)}</td><td>${esc(e.reason)}</td><td>${esc(e.bitmagnet)}</td><td>${esc(e.sportVideo)}</td><td>${e.nextAt?esc(time(e.nextAt)):'—'}</td></tr>`).join('') || '<tr><td colspan="6">No missing events in this selection.</td></tr>'}</tbody></table></div>`;
  }
  if(data.selection) {
    const ids=data.selection.ids===null?data.promotions.map(p=>p.id):data.selection.ids;
    body=`<details class="card my-3"><summary class="card-header">Promotions · ${ids.length} selected</summary><div class="card-body"><form method="POST" action="/admin/discovery/${data.selection.source}/promotions"><div class="row">${data.promotions.map(p=>`<label class="form-check col-md-4"><input class="form-check-input" type="checkbox" name="promotions" value="${esc(p.id)}" ${ids.includes(p.id)?'checked':''}><span class="form-check-label">${esc(p.name)}</span></label>`).join('')}</div><p class="text-secondary">Selecting none pauses automatic event work for this source. Manual actions and saved results remain available. Source switches and each user's catalogs still apply.</p><button class="btn btn-primary">Save promotions</button></form></div></details>`+body;
  }
  if(tab==='events') {
    const visible=[...rows.values()].filter(e=>!data.promotion || e.id.split(':')[0]===data.promotion).sort((a,b)=>String(b.date).localeCompare(String(a.date)));
    body=`<form method="GET" action="/admin/discovery" class="my-3"><input type="hidden" name="tab" value="events"><label for="promotion" class="form-label">View promotion</label><select id="promotion" class="form-select" name="promotion"><option value="">All promotions</option>${data.promotions.map(p=>`<option value="${esc(p.id)}" ${p.id===data.promotion?'selected':''}>${esc(p.name)}</option>`).join('')}</select><button class="btn btn-outline-secondary mt-2">Apply filter</button></form><p>Saved sources are combined by event. A saved match does not guarantee playable links. Prowlarr waiting states cover its event window; Sport-Video contributes retained matched listings.</p><table class="table"><thead><tr><th>Event</th><th>Date</th><th>Saved sources</th><th>Prowlarr status</th></tr></thead><tbody>${visible.slice(0,250).map(e=>`<tr><td>${esc(e.name)}</td><td>${esc(e.date)}</td><td>${esc(e.sources.join(', ') || 'None')}</td><td>${esc(e.state)}</td></tr>`).join('') || '<tr><td colspan="4">No observations yet.</td></tr>'}</tbody></table><p>Showing up to 250 events.</p>`;
  }
  return `<h2>Discovery</h2>${data.flash?`<div class="alert alert-info">${esc(data.flash)}</div>`:''}<div class="d-flex gap-2 flex-wrap">${Object.entries(tabs).map(([id,label])=>`<a class="btn ${id===tab?'btn-primary':'btn-outline-secondary'}" ${id===tab?'aria-current="page"':''} href="/admin/discovery?tab=${id}">${label}</a>`).join(' ')}</div><div id="discovery-content">${body}</div><script src="/assets/discovery-controls.js" defer></script>`;
}
module.exports={render,tabs};
