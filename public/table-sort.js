'use strict';
(() => {
  const tables=new WeakMap(),collator=new Intl.Collator('en-GB',{numeric:true,sensitivity:'base'});
  const style=document.createElement('style');
  style.textContent='.sss-sort{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;text-align:inherit;display:inline-flex;align-items:center;gap:.35em}.sss-sort:focus-visible{outline:2px solid currentColor;outline-offset:4px}.sss-sort-direction{opacity:.65}';
  document.head.append(style);
  function value(cell,type) {
    if(!cell) return null;
    const raw=cell.dataset.sortValue ?? cell.querySelector('time[datetime]')?.getAttribute('datetime') ?? cell.textContent.trim();
    if(!raw || /^(?:—|–|-|n\/a|never|not yet|unknown|ready)$/i.test(raw)) return null;
    if(type==='date') {
      const clock=raw.match(/^(\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?$/);
      if(clock) return ((+clock[1]*60+ +clock[2])*60+ +(clock[3] || 0))*1000+Number('0.'+(clock[4] || 0))*1000;
      let m=raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
      if(m) return Date.UTC(+m[1],+m[2]-1,+m[3],+(m[4] || 0),+(m[5] || 0),+(m[6] || 0));
      m=raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,?\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
      if(m) return Date.UTC(+m[3],+m[2]-1,+m[1],+(m[4] || 0),+(m[5] || 0),+(m[6] || 0));
      if(cell.dataset.sortValue && Number.isFinite(Number(raw))) return Number(raw);
      const parsed=Date.parse(raw);return Number.isFinite(parsed)?parsed:null;
    }
    if(type==='number') {
      const m=raw.replace(/,/g,'').match(/^\s*(-?\d+(?:\.\d+)?)\s*([a-z%]*)/i);if(!m) return null;
      const units={b:1,kb:1000,mb:1e6,gb:1e9,tb:1e12,kib:1024,mib:1024**2,gib:1024**3,tib:1024**4,ms:1,s:1000,sec:1000,seconds:1000,min:60000,minutes:60000,h:3600000,hours:3600000};
      return Number(m[1])*(units[m[2].toLowerCase()] || 1);
    }
    return raw;
  }
  function initialise(table) {
    if(tables.has(table) || table.dataset.sortDisabled!==undefined) return;
    const header=table.tHead?.rows[table.tHead.rows.length-1] || [...table.rows].find(row=>row.querySelector('th'));
    if(!header || [...header.cells].some(cell=>cell.tagName!=='TH' || cell.colSpan!==1 || cell.rowSpan!==1)) return;
    const state={column:null,direction:1,headers:[],observer:null};tables.set(table,state);
    const observe=()=>state.observer.observe(table,{childList:true,subtree:true,characterData:true});
    const sort=()=>{
      if(state.column===null) return;
      state.observer.disconnect();
      const key=state.headers.find(h=>h.column===state.column);
      for(const body of table.tBodies) {
        const all=[...body.rows],rows=all.filter(row=>row!==header && row.cells.length===header.cells.length && [...row.cells].every(cell=>cell.colSpan===1));
        const sorted=rows.map((row,index)=>({row,index,key:value(row.cells[state.column],key.type)})).sort((a,b)=>{
          if(a.key===null || b.key===null) return a.key===b.key?a.index-b.index:a.key===null?1:-1;
          const compared=typeof a.key==='number' && typeof b.key==='number'?a.key-b.key:collator.compare(String(a.key),String(b.key));
          return compared*state.direction || a.index-b.index;
        }).map(item=>item.row);
        if(rows.some((row,index)=>row!==sorted[index])) {
          let index=0;const fragment=document.createDocumentFragment();
          for(const row of all) fragment.append(rows.includes(row)?sorted[index++]:row);
          body.append(fragment);
        }
      }
      for(const item of state.headers) {
        const active=item.column===state.column;item.cell.setAttribute('aria-sort',active?(state.direction===1?'ascending':'descending'):'none');
        item.indicator.textContent=active?(state.direction===1?'↑':'↓'):'↕';
        item.button.title='Sort '+item.label+(active && state.direction===1?' descending':' ascending');
      }
      observe();table.dispatchEvent(new CustomEvent('sss:table-sorted'));
    };
    state.observer=new MutationObserver(()=>sort());
    [...header.cells].forEach((cell,column)=>{
      const label=cell.textContent.trim();
      if(!label || /^(?:actions?|control|review|cooldown)$/i.test(label) || cell.querySelector('input,button,a,select') || cell.dataset.sortDisabled!==undefined) return;
      const samples=[...table.tBodies].flatMap(body=>[...body.rows]).filter(row=>row!==header && row.cells.length===header.cells.length).map(row=>row.cells[column]?.textContent.trim()).filter(text=>text && !/^[—–-]$/.test(text));
      const counts=samples.length>0 && samples.every(text=>/^\d[\d,.]*$/.test(text));
      const type=cell.dataset.sortType || (counts?'number':/event|title|name|query/i.test(label)?'text':/date|requested|expires|^time(?:\s*\(|$)|created|updated|^next|^last.*(?:saved|seen|success|completed)|^searched$/i.test(label)?'date':/total|requests|success|failures|eligible|matched|missing|releases|results|completed|attempts|latency|time and value|rows|size|duration|budget|ready|hits|coverage|count/i.test(label)?'number':'text');
      const button=document.createElement('button'),indicator=document.createElement('span');button.type='button';button.className='sss-sort';button.setAttribute('aria-label','Sort '+label);indicator.className='sss-sort-direction';indicator.setAttribute('aria-hidden','true');indicator.textContent='↕';
      while(cell.firstChild) button.append(cell.firstChild);button.append(indicator);cell.append(button);cell.setAttribute('aria-sort','none');
      state.headers.push({cell,column,type,button,indicator,label});
      button.addEventListener('click',()=>{state.direction=state.column===column?-state.direction:1;state.column=column;sort();});
    });observe();
  }
  document.querySelectorAll('table').forEach(initialise);
  new MutationObserver(records=>{
    for(const record of records) for(const node of record.addedNodes) if(node.nodeType===1) {
      if(node.matches('table')) initialise(node);node.querySelectorAll('table').forEach(initialise);
    }
  }).observe(document.body,{childList:true,subtree:true});
})();
