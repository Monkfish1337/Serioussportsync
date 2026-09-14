'use strict';
const {escapeHtml:esc} = require('./ui/shell');
const tabs={overview:'Overview',events:'Events',prowlarr:'Prowlarr','sport-video':'Sport-Video',preparation:'Preparation'};
function render(data) {
  const tab=Object.hasOwn(tabs,data.tab)?data.tab:'overview';
  const selected=data.selected===null?data.promotions.map(p=>p.id):data.selected;
  const rows=new Map();
  for(const e of data.queue.eventStates || []) rows.set(e.id,{...e,sources:e.matched?['Prowlarr']:[]});
  const events=new Map(data.events.map(e=>[e.id,e]));
  for(const release of data.releases) for(const match of release.matches || []) {
    const event=events.get(match.eventId); if(!event) continue;
    const row=rows.get(event.id) || {...event,sources:[],state:'Not in measured queue'};
    if(!row.sources.includes('Sport-Video')) row.sources.push('Sport-Video');
    rows.set(event.id,row);
  }
  let body=data.body || '';
  if(tab==='overview') body=`<h3 class="mt-3">Background coverage</h3><p>${data.queue.progress?.eligible || 0} eligible Prowlarr events · ${data.queue.progress?.matched || 0} with saved matches · ${data.queue.progress?.untouched || 0} awaiting a first search.</p><p>${data.releases.length} saved Sport-Video listings. Source workers retain their own pacing, budgets and retries. Saved matches still require an availability check for the user's account.</p><h3>Promotions for automatic discovery</h3><form method="POST" action="/admin/discovery/promotions">${data.promotions.map(p=>`<label class="form-check"><input class="form-check-input" type="checkbox" name="promotions" value="${esc(p.id)}" ${selected.includes(p.id)?'checked':''}><span class="form-check-label">${esc(p.name)}${['mlb','nba','nfl'].includes(p.id)?' · measured Prowlarr supported':''}</span></label>`).join('')}<button class="btn btn-primary mt-3">Save promotion selection</button></form><p class="text-secondary mt-2">Controls background event searches and preparation. Selecting none pauses that work. Source switches, categories and each user's catalogs also apply. Sport-Video shared listings continue to be collected. Saved results and playback remain available.</p>`;
  if(tab==='events') {
    const visible=[...rows.values()].filter(e=>!data.promotion || e.id.split(':')[0]===data.promotion).sort((a,b)=>String(b.date).localeCompare(String(a.date)));
    body=`<form method="GET" action="/admin/discovery" class="my-3"><input type="hidden" name="tab" value="events"><label for="promotion" class="form-label">View promotion</label><select id="promotion" class="form-select" name="promotion"><option value="">All promotions</option>${data.promotions.map(p=>`<option value="${esc(p.id)}" ${p.id===data.promotion?'selected':''}>${esc(p.name)}</option>`).join('')}</select><button class="btn btn-outline-secondary mt-2">Apply filter</button></form><p>Saved sources are combined by event. A saved match does not guarantee playable links. Prowlarr waiting states cover its event window; Sport-Video contributes retained matched listings.</p><table class="table"><thead><tr><th>Event</th><th>Date</th><th>Saved sources</th><th>Prowlarr status</th></tr></thead><tbody>${visible.slice(0,250).map(e=>`<tr><td>${esc(e.name)}</td><td>${esc(e.date)}</td><td>${esc(e.sources.join(', ') || 'None')}</td><td>${esc(e.state)}</td></tr>`).join('') || '<tr><td colspan="4">No observations yet.</td></tr>'}</tbody></table><p>Showing up to 250 events.</p>`;
  }
  return `<h2>Discovery</h2>${data.flash?`<div class="alert alert-info">${esc(data.flash)}</div>`:''}<div class="d-flex gap-2 flex-wrap">${Object.entries(tabs).map(([id,label])=>`<a class="btn ${id===tab?'btn-primary':'btn-outline-secondary'}" ${id===tab?'aria-current="page"':''} href="/admin/discovery?tab=${id}">${label}</a>`).join(' ')}</div>${body}`;
}
module.exports={render,tabs};
