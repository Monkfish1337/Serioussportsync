'use strict';
const {escapeHtml:esc} = require('./ui/shell');
const tabs={overview:'Overview',events:'Events',prowlarr:'Prowlarr','sport-video':'Sport-Video',preparation:'Bitmagnet'};
const LEDES={
  overview:'Which recent games have a saved release, and which do not.',
  events:'Every recent game and where its saved releases came from.',
  prowlarr:'Background Prowlarr searches for games still missing a release.',
  'sport-video':'Releases posted on Sport-Video and the games they match.',
  preparation:'Bitmagnet searches that prepare links before an event is opened.',
};
// Shared by every Discovery tab (issue #72). Only what lib/ui/css.js lacks.
const STYLE='<style>'
  +'.dv-tabs{margin:0 0 18px;flex-wrap:wrap}'
  +'.dv-stack>*+*{margin-top:14px}'
  +'.dv-stack .panel{margin:0}.dv-stack .fold{margin:0}'
  +'.dv-stack .panel-head>div:first-child,.dv-stack .fold>summary>div{flex:1;min-width:0}'
  +'.dv-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}'
  +'.dv-actions{display:flex;flex-wrap:wrap;gap:8px}.dv-actions form{margin:0}'
  +'.dv-inline{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}.dv-inline label.f{flex:1;min-width:220px}'
  +'.dv-form>*+*{margin-top:16px}'
  +'.dv-label{display:block;font-size:11px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3);margin-bottom:8px}'
  +'.dv-picks{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px 16px}'
  +'.dv-rules{margin:0;padding-left:18px}.dv-rules li+li{margin-top:3px}'
  +'.panel>.tbl-wrap .tbl th:first-child,.panel>.tbl-wrap .tbl td:first-child{padding-left:18px}'
  +'.tbl .row-sub{margin-top:2px}'
  +'</style>';

function table(head,rows,empty) {
  return `<div class="tbl-wrap tbl-scroll"><table class="tbl"><thead><tr>${head.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${head.length}">${empty}</td></tr>`}</tbody></table></div>`;
}
function fold(title,sub,body) {
  return `<details class="fold"><summary><div><h3>${title}</h3>${sub?`<p>${sub}</p>`:''}</div></summary><div class="fold-body">${body}</div></details>`;
}
function promotionFilter(tab,promotions,selected,names) {
  return `<form method="GET" action="/admin/discovery" class="dv-inline"><input type="hidden" name="tab" value="${tab}"><label class="f"><span>Promotion</span><select class="t" name="promotion"><option value="">All promotions</option>${promotions.map(p=>`<option value="${esc(p.id)}" ${selected===p.id?'selected':''}>${esc(names.get(p.id) || p.name || p.id)}</option>`).join('')}</select></label><button class="btn ghost">Show</button></form>`;
}

function overview(data) {
  const c=data.coverage,names=new Map(data.promotions.map(p=>[p.id,p.name]));
  const time=require('./display-time').displayTime;
  const missing=c.rows.filter(e=>!e.matched && (!data.promotion || e.promotion===data.promotion)).sort((a,b)=>String(b.date).localeCompare(String(a.date)));
  const stats=[['Games',c.total],['With a saved release',c.matched],['Missing a release',c.missing],...(c.playable?[['Cached on TorBox',c.playable.cached]]:[])];
  const summary=`<section class="panel"><div class="panel-head"><div><h3>Past seven days</h3><p>${esc(time(c.from).slice(0,10))} to ${esc(time(c.to).slice(0,10))} · scheduled games that have finished</p></div></div><div class="panel-body">
    <div class="dv-stats">${stats.map(([label,value])=>`<div class="stat"><b>${value}</b><span>${label}</span></div>`).join('')}</div>
    ${data.coverageError?`<div class="note" data-tone="warn"><div><b>Coverage is incomplete</b><span>${esc(data.coverageError)}. Some saved matches could not be read.</span></div></div>`:''}
    <p class="hint">Saved: a relevant torrent from Prowlarr, Bitmagnet or Sport-Video. Cached: TorBox confirmed one in the last 48 h${c.playable?` (${c.playable.notCached} not cached, ${c.playable.unchecked} unchecked)`:''}.</p>
  </div></section>`;
  const promoRows=c.promotions.map(p=>`<tr><td>${esc(names.get(p.id) || p.id)}</td><td class="tabular">${p.total}</td><td class="tabular">${p.matched}</td><td class="tabular">${p.cached+p.notCached+p.unchecked?`${p.cached} of ${p.matched}${p.unchecked?`<span class="row-sub">${p.unchecked} not checked yet</span>`:''}`:'—'}</td><td class="tabular">${p.missing?`<a href="/admin/discovery?tab=overview&promotion=${encodeURIComponent(p.id)}#missing">${p.missing}</a>`:'0'}</td><td>${Object.entries(p.reasons).map(([reason,count])=>`<span class="row-sub">${count} · ${esc(reason)}</span>`).join('') || '<span class="chip" data-tone="ok">Complete</span>'}</td></tr>`);
  const byPromotion=`<section class="panel"><div class="panel-head"><div><h3>Coverage by promotion</h3><p>Select a Missing count to list those games.</p></div></div>${table(['Promotion','Games','Saved','Cached on TorBox','Missing','Why missing'],promoRows,'No past events in this window.')}</section>`;
  const missingRows=missing.map(e=>`<tr><td>${esc(e.name)}<span class="row-sub"><a href="/admin/discovery/manual?eventId=${encodeURIComponent(e.id)}">Match resources</a></span></td><td>${esc(e.date)}</td><td>${esc(e.reason)}</td><td>${esc(e.bitmagnet)}</td><td>${esc(e.sportVideo)}</td><td>${e.nextAt?esc(time(e.nextAt)):'—'}</td></tr>`);
  const missingPanel=`<section class="panel" id="missing"><div class="panel-head"><div><h3>Missing events</h3><p>${missing.length} game${missing.length===1?'':'s'} without a usable torrent${c.titleOnly?` · ${c.titleOnly} matched by title only`:''}</p></div></div><div class="panel-body">${promotionFilter('overview',c.promotions.map(p=>({id:p.id})),data.promotion,names)}</div>${table(['Event','Date','Prowlarr','Bitmagnet','Sport-Video','Next retry'],missingRows,'No missing events in this selection.')}</section>`;
  return `<div class="dv-stack">${summary}${byPromotion}${missingPanel}</div>`;
}

function eventsTab(data,rows) {
  const names=new Map(data.promotions.map(p=>[p.id,p.name]));
  const visible=[...rows.values()].filter(e=>!data.promotion || e.id.split(':')[0]===data.promotion).sort((a,b)=>String(b.date).localeCompare(String(a.date)));
  const body=visible.slice(0,250).map(e=>`<tr><td>${esc(e.name)}</td><td>${esc(e.date)}</td><td>${e.sources.length?e.sources.map(s=>`<span class="chip plain" data-tone="info">${esc(s)}</span>`).join(' '):'<span class="chip plain" data-tone="off">None</span>'}</td><td>${esc(e.state)}</td></tr>`);
  return `<section class="panel"><div class="panel-head"><div><h3>Events</h3><p>${visible.length} game${visible.length===1?'':'s'}${visible.length>250?', newest 250 shown':''}. A saved release still needs each account's TorBox check.</p></div></div><div class="panel-body">${promotionFilter('events',data.promotions,data.promotion,names)}</div>${table(['Event','Date','Saved from','Prowlarr status'],body,'No observations yet.')}</section>`;
}

function selectionFold(data) {
  const ids=data.selection.ids===null?data.promotions.map(p=>p.id):data.selection.ids;
  return fold('Promotions',`${ids.length} of ${data.promotions.length} selected for this source`,`<form method="POST" action="/admin/discovery/${data.selection.source}/promotions" class="dv-form"><div class="dv-picks">${data.promotions.map(p=>`<label class="sw"><input type="checkbox" name="promotions" value="${esc(p.id)}" ${ids.includes(p.id)?'checked':''}><i></i><b>${esc(p.name)}</b></label>`).join('')}</div><p class="hint">None selected pauses automatic work for this source.</p><div><button class="btn primary">Save promotions</button></div></form>`);
}

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
  if(tab==='overview' && data.coverage) body=overview(data);
  if(data.selection) body=selectionFold(data)+body;
  if(tab==='events') body=eventsTab(data,rows);
  const lede=`<div class="lede"><h2>Discovery</h2><p>${LEDES[tab]}</p></div>`;
  const nav=`<nav class="seg dv-tabs" aria-label="Discovery">${Object.entries(tabs).map(([id,label])=>`<a href="/admin/discovery?tab=${id}"${id===tab?' aria-current="true"':''}>${label}</a>`).join('')}</nav>`;
  return `${STYLE}${lede}${data.flash?`<div class="note" data-tone="info"><div><b>${esc(data.flash)}</b></div></div>`:''}${nav}<div id="discovery-content">${body}</div><script src="/assets/discovery-controls.js" defer></script>`;
}
module.exports={render,tabs};
