'use strict';
const DAY=86400000;
function recentEvents(events,now=Date.now(),promotions) {
  // My Teams promotions are account-specific catalog views over fixtures that
  // already belong to their parent league. Counting them here duplicates the
  // same games and turns an account preference into a global coverage gap.
  const current=promotions && new Set(promotions.filter(p=>p.enabled!==false
    && !p.releaseDerived && !p.autoTeam).map(p=>p.id));
  return [...new Map(events.filter(e=>{
    if(!e.id || /cancel|postpon/i.test(e.status || '')) return false;
    if(current && !current.has(e.id.split(':')[0])) return false;
    const start=require('./discovery-cadence').startAt(e);
    const at=Number.isFinite(start)?start:Date.parse(e.date+'T23:59:59Z');
    return Number.isFinite(at) && at<=now && at>=now-7*DAY;
  }).map(e=>[e.id,e])).values()];
}
function coverage(data,now=Date.now()) {
  const events=recentEvents(data.events,now,data.promotions),byId=new Map(events.map(e=>[e.id,e]));
  const sources=new Map(events.map(e=>[e.id,new Set()]));
  // Playable coverage (issue #65): every saved torrent hash per event, from
  // the Prowlarr queue, Sport-Video and the availability database, checked
  // against what TorBox has confirmed as cached.
  const hashes=new Map(events.map(e=>[e.id,new Set()]));
  const addHash=(id,hash)=>{const h=String(hash || '').toLowerCase();if(hashes.has(id) && /^[a-f0-9]{40}$/.test(h)) hashes.get(id).add(h);};
  const titles=new Set();
  const states=new Map((data.queue.eventStates || []).map(e=>[e.id,e]));
  for(const e of data.queue.eventStates || []) if(/Matching titles found/.test(e.state || '')) titles.add(e.id);
  for(const e of data.queue.eventStates || []) if(e.matched && sources.has(e.id)) {titles.add(e.id);sources.get(e.id).add('Prowlarr');}
  for(const e of data.queue.matchedEvents || []) if(sources.has(e.event || e.id)) {titles.add(e.event || e.id);sources.get(e.event || e.id).add('Prowlarr');}
  for(const r of data.releases || []) for(const m of r.matches || []) if(sources.has(m.eventId)) {
    titles.add(m.eventId);
    if(/^[a-f0-9]{40}$/i.test(String(r.infoHash || ''))) {sources.get(m.eventId).add('Sport-Video');addHash(m.eventId,r.infoHash);}
  }
  for(const row of data.indexTitles || []) {
    const event=byId.get(row.eventId);if(!event) continue;
    try {if(data.relevant(row.title,event)) {titles.add(event.id);if(row.usable) {sources.get(event.id).add('Availability database');addHash(event.id,row.hash);}}} catch (_) { /* no verified match */ }
  }
  if(data.queueHashes) for(const event of events) {
    try {for(const hash of data.queueHashes(event) || []) addHash(event.id,hash);} catch (_) { /* queue unavailable */ }
  }
  let torbox=null;
  if(data.torboxStates) {
    try {torbox=data.torboxStates([...hashes.values()].flatMap(set=>[...set]));} catch (_) { torbox=null; }
  }
  const torboxOf=id=>{
    if(!torbox) return null;
    const states=[...hashes.get(id)].map(h=>torbox.get(h));
    if(!states.length) return null;
    return states.includes('cached') ? 'cached' : states.includes('not-cached') ? 'not-cached' : 'unchecked';
  };
  const rows=events.map(event=>{
    const promotion=event.id.split(':')[0],state=states.get(event.id),saved=[...sources.get(event.id)];
    const p=data.promotions.find(p=>p.id===promotion);
    let reason;
    if(saved.length) reason='Usable release identity — account playback check required';
    else if(data.coverageError) reason='Coverage incomplete — availability database could not be read';
    else if(state) reason=state.state;
    else if(titles.has(event.id)) reason='Title matched — usable torrent hash not retained';
    else if(!data.queue.options.enabled) reason='Prowlarr queue disabled; no saved match recorded';
    else if(!(data.queue.options.promotions || []).includes(promotion)) reason='Not selected for Prowlarr; no saved match recorded';
    else reason='Awaiting eligibility or outside Prowlarr window; no saved match recorded';
    const policy=name=>{
      const source=data.background?.[name];
      if(!source) return 'No background status recorded';
      if(!source.enabled) return 'Automatic work disabled or source not configured';
      if(source.selected && !source.selected.includes(promotion)) return 'Promotion not selected';
      return 'Enabled — no saved match recorded';
    };
    return {...event,promotion,sources:saved,matched:saved.length>0,titleOnly:!saved.length && titles.has(event.id),reason,nextAt:state?.nextAt || null,
      torbox:saved.length ? torboxOf(event.id) : null,
      bitmagnet:policy('bitmagnet'),sportVideo:policy('sportVideo')};
  });
  const groups=new Map();
  for(const row of rows) {
    if(!groups.has(row.promotion)) groups.set(row.promotion,{id:row.promotion,total:0,matched:0,missing:0,reasons:{},cached:0,notCached:0,unchecked:0});
    const group=groups.get(row.promotion);group.total++;group[row.matched?'matched':'missing']++;
    if(row.torbox==='cached') group.cached++; else if(row.torbox==='not-cached') group.notCached++; else if(row.torbox==='unchecked') group.unchecked++;
    if(!row.matched) group.reasons[row.reason]=(group.reasons[row.reason] || 0)+1;
  }
  return {total:rows.length,matched:rows.filter(e=>e.matched).length,missing:rows.filter(e=>!e.matched).length,
    titleOnly:rows.filter(e=>e.titleOnly).length,
    playable:torbox ? {cached:rows.filter(e=>e.torbox==='cached').length,notCached:rows.filter(e=>e.torbox==='not-cached').length,
      unchecked:rows.filter(e=>e.torbox==='unchecked').length} : null,promotions:[...groups.values()].sort((a,b)=>a.id.localeCompare(b.id)),rows,from:now-7*DAY,to:now};
}
module.exports={recentEvents,coverage};
