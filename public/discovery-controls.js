'use strict';
(() => {
  const root=document.getElementById('discovery-content');if(!root) return;
  for(const h of [...root.querySelectorAll('h3')]) {
    if(!['Event discovery status','Prioritise a missing game','Next retries','Successfully matched events'].includes(h.textContent.trim())) continue;
    const fold=document.createElement('details'),summary=document.createElement('summary');
    fold.className='card my-3';summary.className='card-header';summary.textContent=h.textContent;h.before(fold);fold.append(summary);
    let node=h.nextSibling;
    while(node && !(node.nodeType===1 && /^H[23]$/.test(node.tagName))) {const next=node.nextSibling;fold.append(node);node=next;}
    h.remove();
  }
  const form=root.querySelector('form[action="/admin/prowlarr-discovery"]');
  if(form) {
    const fold=document.createElement('details'),summary=document.createElement('summary');fold.className='card my-3';summary.className='card-header';
    summary.textContent='Prowlarr settings · '+(form.querySelector('[name="enabled"]').checked?'Enabled':'Disabled');form.before(fold);fold.append(summary,form);form.classList.add('card-body');
    form.addEventListener('invalid',()=>{fold.open=true;},true);
  }
  for(const card of root.querySelectorAll('div.card')) {
    const header=card.querySelector(':scope > .card-header'),title=header?.querySelector('.card-title')?.textContent.trim();
    if(!['Source controls','Bitmagnet preparation settings','Preparation diagnostics','Catalog availability gate'].includes(title)) continue;
    const children=[...card.children].filter(child=>child!==header),button=document.createElement('button');button.type='button';button.className='btn btn-sm btn-outline-secondary ms-auto';
    const set=open=>{children.forEach(child=>child.hidden=!open);button.textContent=open?'Hide':'Show';button.setAttribute('aria-expanded',String(open));};
    button.addEventListener('click',()=>set(button.getAttribute('aria-expanded')!=='true'));header.append(button);set(false);card.addEventListener('invalid',()=>set(true),true);
  }
  for(const table of root.querySelectorAll('table')) {
    const body=table.tBodies[0];if(!body || body.rows.length<=15) continue;
    const controls=document.createElement('div');controls.className='d-flex gap-2 flex-wrap align-items-center p-2';
    const search=document.createElement('input');search.className='form-control';search.style.maxWidth='260px';search.placeholder='Filter this table';search.setAttribute('aria-label','Filter table');
    const previous=document.createElement('button'),next=document.createElement('button'),count=document.createElement('span');
    previous.type=next.type='button';previous.className=next.className='btn btn-outline-secondary btn-sm';previous.textContent='Previous';next.textContent='Next';count.setAttribute('aria-live','polite');
    const sport=body.id==='sv-rows';controls.append(...(sport?[]:[search]),previous,count,next);(table.closest('.table-responsive') || table).before(controls);
    let page=0;
    const render=()=>{
      const rows=[...body.rows],q=sport?document.getElementById('sv-search').value.toLowerCase():search.value.toLowerCase();
      const state=sport?document.getElementById('sv-state').value:'',category=sport?document.getElementById('sv-category').value:'';
      const matches=rows.filter(row=>(sport?row.dataset.search || '':row.textContent.toLowerCase()).includes(q) && (!state || row.dataset.state===state) && (!category || row.dataset.category===category));
      page=Math.min(page,Math.max(0,Math.ceil(matches.length/15)-1));const visible=new Set(matches.slice(page*15,page*15+15));rows.forEach(row=>row.hidden=!visible.has(row));
      count.textContent=matches.length?`${page*15+1}–${Math.min(matches.length,page*15+15)} of ${matches.length}`:'No matching rows';previous.disabled=page===0;next.disabled=(page+1)*15>=matches.length;
      if(sport) document.getElementById('sv-count').textContent=matches.length+' matching';
    };
    previous.addEventListener('click',()=>{page--;render();});next.addEventListener('click',()=>{page++;render();});
    table.addEventListener('sss:table-sorted',()=>{page=0;render();});
    for(const input of sport?['sv-search','sv-state','sv-category'].map(id=>document.getElementById(id)):[search]) input.addEventListener(input.tagName==='SELECT'?'change':'input',()=>{page=0;render();});
    new MutationObserver(render).observe(body,{childList:true});render();
  }
})();
