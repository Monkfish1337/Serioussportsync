'use strict';
const {escapeHtml:esc} = require('./ui/shell');
const tabs={events:'Events',prowlarr:'Prowlarr','sport-video':'Sport-Video',preparation:'Bitmagnet'};
function render(data) {
  const tab=Object.hasOwn(tabs,data.tab)?data.tab:'events';
  const rows=new Map();
  for(const e of data.queue.eventStates || []) rows.set(e.id,{...e,sources:e.matched?['Prowlarr']:[]});
  const events=new Map(data.events.map(e=>[e.id,e]));
  for(const match of data.queue.matchedEvents || []) {
    const event=events.get(match.id);if(!event) continue;
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
