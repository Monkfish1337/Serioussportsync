const { escapeHtml } = require('./tabler-chrome');

function queryOptions(q) {
  q = q || {};
  return {
    category: String(q.category || 'all'),
    user: String(q.user || ''),
    substring: String(q.substring || ''),
    level: String(q.level || 'all'),
    limit: Math.max(50, Math.min(5000, parseInt(q.limit, 10) || 500)),
    tail: q.tail !== 'off',
  };
}

function isoTime(ts) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 23);
}

function rowsToText(rows) {
  return (rows || []).map((entry) => {
    const identity = entry.user ? ' user=' + entry.user : '';
    return isoTime(entry.ts) + 'Z '
      + String(entry.level || 'log').toUpperCase().padEnd(5) + ' '
      + '[' + (entry.category || 'other') + identity + '] ' + entry.line;
  }).join('\n') + ((rows || []).length ? '\n' : '');
}

function rowHtml(entry) {
  const level = ['log', 'warn', 'error'].includes(entry.level) ? entry.level : 'log';
  const isReject = /\b(?:REJECT|noise drop)\b/i.test(entry.line || '');
  const isSummary = /\bSUMMARY:/i.test(entry.line || '');
  const classes = ['log-entry', 'level-' + level];
  if (isReject) classes.push('is-rejection');
  if (isSummary) classes.push('is-summary');
  return '<div class="' + classes.join(' ') + '" data-log-id="' + Number(entry.id || 0) + '">'
    + '<span class="log-time">' + escapeHtml(isoTime(entry.ts).slice(11)) + '</span>'
    + '<span class="log-level">' + escapeHtml(level.toUpperCase()) + '</span>'
    + '<span class="log-category">' + escapeHtml(entry.category || 'other') + '</span>'
    + '<span class="log-user">' + escapeHtml(entry.user || '') + '</span>'
    + '<span class="log-message">' + escapeHtml(entry.line) + '</span>'
    + '</div>';
}

function renderBody({ rows, stats, query, preferences }) {
  const o = queryOptions(query);
  const known = ['stream', 'resolve', 'warm', 'refresh', 'admin', 'server', 'availability',
    'denylist', 'positive-cache', 'dead-indexer', 'onefc', 'crypto-keys', 'users', 'other'];
  const cats = Array.from(new Set(known.concat(Object.keys(stats.byCategory || {})))).sort();
  const option = (value, selected) => '<option value="' + escapeHtml(value) + '"'
    + (value === selected ? ' selected' : '') + '>' + escapeHtml(value) + '</option>';
  const initialRows = rows.length
    ? rows.map(rowHtml).join('')
    : '<div class="log-empty">No entries match the current filters.</div>';
  const detailOn = Boolean(preferences && preferences.detailedRejections);

  return `
<style>
.log-shell{--console-bg:#080b10;--console-border:#242b36;--console-muted:#778397}
.log-heading{display:flex;gap:1rem;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}
.log-title-row{display:flex;align-items:center;gap:.75rem}.live-pill{display:inline-flex;align-items:center;gap:.45rem;border:1px solid #263140;border-radius:999px;padding:.28rem .65rem;font-size:.72rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase}.live-dot{width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 4px rgba(34,197,94,.12)}.live-pill.paused .live-dot{background:#f59e0b;box-shadow:none}
.log-kpis{display:grid;grid-template-columns:repeat(4,minmax(110px,1fr));gap:.65rem;margin:1rem 0}.log-kpi{background:linear-gradient(145deg,rgba(255,255,255,.035),rgba(255,255,255,.012));border:1px solid var(--tblr-border-color);border-radius:10px;padding:.7rem .85rem}.log-kpi strong{display:block;font-size:1.15rem}.log-kpi span{font-size:.72rem;color:var(--tblr-secondary);text-transform:uppercase;letter-spacing:.045em}
.log-toolbar{background:var(--tblr-bg-surface);border:1px solid var(--tblr-border-color);border-radius:10px;padding:.85rem;margin-bottom:.75rem}.log-toolbar-grid{display:grid;grid-template-columns:1.1fr .75fr 1.65fr .7fr .65fr auto;gap:.6rem;align-items:end}.log-toolbar .form-label{font-size:.68rem;text-transform:uppercase;letter-spacing:.045em;color:var(--tblr-secondary);margin-bottom:.3rem}.log-actions{display:flex;gap:.45rem;align-items:center;flex-wrap:wrap}
.log-console{background:var(--console-bg);border:1px solid var(--console-border);border-radius:10px;overflow:hidden;box-shadow:0 16px 42px rgba(0,0,0,.22)}.log-console-bar{display:flex;align-items:center;gap:.5rem;justify-content:space-between;padding:.55rem .75rem;background:#11161e;border-bottom:1px solid var(--console-border)}.console-lights{display:flex;gap:6px}.console-lights i{display:block;width:9px;height:9px;border-radius:50%;background:#ef4444}.console-lights i:nth-child(2){background:#f59e0b}.console-lights i:nth-child(3){background:#22c55e}.log-console-meta{font:11px ui-monospace,monospace;color:var(--console-muted)}
.log-output{height:62vh;min-height:390px;overflow:auto;padding:.35rem 0;font:12px/1.55 ui-monospace,"Cascadia Code","SFMono-Regular",Consolas,monospace;user-select:text;cursor:text;scrollbar-color:#3b4554 #0b0e13}.log-entry{display:grid;grid-template-columns:92px 52px 112px 92px minmax(380px,1fr);gap:.65rem;padding:.18rem .75rem;border-left:2px solid transparent;color:#cbd5e1}.log-entry:hover{background:rgba(148,163,184,.07)}.log-time{color:#667085}.log-level{font-weight:800}.level-log .log-level{color:#7dd3fc}.level-warn{border-left-color:#f59e0b}.level-warn .log-level{color:#fbbf24}.level-error{border-left-color:#ef4444;background:rgba(239,68,68,.045)}.level-error .log-level{color:#fb7185}.log-category{color:#c4b5fd}.log-user{color:#86efac;overflow:hidden;text-overflow:ellipsis}.log-message{white-space:pre;overflow:visible}.log-output.wrap .log-message{white-space:pre-wrap;overflow-wrap:anywhere}.log-entry.is-rejection{background:rgba(245,158,11,.035)}.log-entry.is-rejection .log-message{color:#fbbf24}.log-entry.is-summary{background:rgba(59,130,246,.065);border-left-color:#60a5fa}.log-entry.is-summary .log-message{color:#bfdbfe;font-weight:700}.log-empty{display:grid;place-items:center;height:100%;color:var(--console-muted)}
.diagnostic-note{display:flex;gap:.8rem;align-items:center;justify-content:space-between;background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.22);border-radius:10px;padding:.65rem .8rem;margin-bottom:.75rem}.diagnostic-note p{margin:0;font-size:.8rem;color:var(--tblr-secondary)}.diagnostic-note strong{color:var(--tblr-body-color)}
.copy-toast{position:fixed;right:1.25rem;bottom:1.25rem;z-index:2000;background:#18212d;border:1px solid #334155;border-radius:8px;padding:.65rem .9rem;box-shadow:0 10px 30px rgba(0,0,0,.35);opacity:0;transform:translateY(8px);pointer-events:none;transition:.18s}.copy-toast.show{opacity:1;transform:none}
@media(max-width:1100px){.log-toolbar-grid{grid-template-columns:repeat(3,1fr)}.log-kpis{grid-template-columns:repeat(2,1fr)}}@media(max-width:700px){.log-toolbar-grid{grid-template-columns:1fr 1fr}.log-entry{grid-template-columns:72px 46px 82px minmax(260px,1fr)}.log-user{display:none}.log-output{height:58vh}.log-kpis{grid-template-columns:1fr 1fr}}
</style>
<div class="log-shell">
  <div class="log-heading">
    <div><div class="log-title-row"><h2 class="page-title m-0">Logs</h2><span id="live-pill" class="live-pill${o.tail ? '' : ' paused'}"><i class="live-dot"></i><span>${o.tail ? 'Live' : 'Paused'}</span></span></div><div class="text-secondary mt-1">Search, inspect and export live SSS activity.</div></div>
    <div class="log-actions"><button id="pause-btn" class="btn btn-outline-secondary btn-sm" type="button">${o.tail ? 'Pause' : 'Resume'}</button><button id="copy-btn" class="btn btn-outline-secondary btn-sm" type="button">Copy visible</button><a id="download-btn" class="btn btn-outline-secondary btn-sm" href="#">Download .log</a></div>
  </div>
  <div class="log-kpis"><div class="log-kpi"><strong id="kpi-total">${stats.total}</strong><span>Buffered</span></div><div class="log-kpi"><strong id="kpi-visible">${rows.length}</strong><span>Visible</span></div><div class="log-kpi"><strong id="kpi-warn">${stats.byLevel.warn || 0}</strong><span>Warnings</span></div><div class="log-kpi"><strong id="kpi-error">${stats.byLevel.error || 0}</strong><span>Errors</span></div></div>
  <form id="log-filters" class="log-toolbar" method="GET" action="/admin/logs">
    <div class="log-toolbar-grid">
      <div><label class="form-label">Category</label><select class="form-select form-select-sm" name="category">${option('all', o.category)}${cats.map((c) => option(c, o.category)).join('')}</select></div>
      <div><label class="form-label">Level</label><select class="form-select form-select-sm" name="level">${['all', 'log', 'warn', 'error'].map((v) => option(v, o.level)).join('')}</select></div>
      <div><label class="form-label">Search entries</label><input id="log-search" class="form-control form-control-sm text-mono" name="substring" value="${escapeHtml(o.substring)}" placeholder="event, provider, reason…" autocomplete="off"></div>
      <div><label class="form-label">User</label><input class="form-control form-control-sm" name="user" value="${escapeHtml(o.user)}" placeholder="Any"></div>
      <div><label class="form-label">Lines</label><select class="form-select form-select-sm" name="limit">${['100', '500', '1000', '2500', '5000'].map((v) => option(v, String(o.limit))).join('')}</select></div>
      <div class="pb-1"><label class="form-check form-switch"><input id="wrap-toggle" class="form-check-input" type="checkbox" checked><span class="form-check-label">Wrap</span></label></div>
    </div>
  </form>
  <div class="diagnostic-note"><p id="diagnostic-copy"><strong>Rejection diagnostics ${detailOn ? 'enabled' : 'sampled'}.</strong> ${detailOn ? 'Every rejected candidate from new searches will be logged.' : 'New searches log a representative sample for each exclusion reason.'}</p><label class="form-check form-switch m-0"><input id="detail-toggle" class="form-check-input" type="checkbox"${detailOn ? ' checked' : ''}><span class="form-check-label">Show every rejected title</span></label></div>
  <div class="log-console"><div class="log-console-bar"><div class="console-lights"><i></i><i></i><i></i></div><div id="console-meta" class="log-console-meta">${rows.length} entries · UTC · newest at bottom</div></div><div id="log-output" class="log-output wrap" tabindex="0">${initialRows}</div></div>
</div>
<div id="copy-toast" class="copy-toast" role="status">Copied visible logs</div>
<script>(function(){
  var form=document.getElementById('log-filters'),output=document.getElementById('log-output'),paused=${o.tail ? 'false' : 'true'},timer=null,lastRows=[];
  function esc(s){return String(s==null?'':s).replace(/[&<>\"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c];});}
  function time(ts){return new Date(ts).toISOString().replace('T',' ').slice(11,23);}
  function selected(){var s=window.getSelection();return s&&!s.isCollapsed&&output.contains(s.anchorNode);}
  function row(e){var l=['log','warn','error'].indexOf(e.level)>=0?e.level:'log',x=/\\b(?:REJECT|noise drop)\\b/i.test(e.line||''),m=/\\bSUMMARY:/i.test(e.line||'');return '<div class="log-entry level-'+l+(x?' is-rejection':'')+(m?' is-summary':'')+'" data-log-id="'+Number(e.id||0)+'"><span class="log-time">'+esc(time(e.ts))+'</span><span class="log-level">'+esc(l.toUpperCase())+'</span><span class="log-category">'+esc(e.category||'other')+'</span><span class="log-user">'+esc(e.user||'')+'</span><span class="log-message">'+esc(e.line||'')+'</span></div>';}
  function params(){var p=new URLSearchParams(new FormData(form));p.set('tail',paused?'off':'on');return p;}
  function updateLinks(){var p=params();history.replaceState(null,'','/admin/logs?'+p);var d=new URLSearchParams(p);d.delete('tail');document.getElementById('download-btn').href='/admin/logs.txt?'+d;}
  function setLive(){var pill=document.getElementById('live-pill'),btn=document.getElementById('pause-btn');pill.classList.toggle('paused',paused);pill.querySelector('span').textContent=paused?'Paused':'Live';btn.textContent=paused?'Resume':'Pause';updateLinks();}
  function render(d){if(selected())return;var nearBottom=output.scrollHeight-output.scrollTop-output.clientHeight<80;lastRows=d.rows||[];output.innerHTML=lastRows.length?lastRows.map(row).join(''):'<div class="log-empty">No entries match the current filters.</div>';document.getElementById('kpi-total').textContent=d.stats.total;document.getElementById('kpi-visible').textContent=lastRows.length;document.getElementById('kpi-warn').textContent=d.stats.byLevel.warn||0;document.getElementById('kpi-error').textContent=d.stats.byLevel.error||0;document.getElementById('console-meta').textContent=lastRows.length+' entries · UTC · newest at bottom';if(nearBottom)output.scrollTop=output.scrollHeight;}
  function fetchRows(){var p=params();p.delete('tail');fetch('/admin/logs.json?'+p,{cache:'no-store'}).then(function(r){if(!r.ok)throw Error();return r.json();}).then(render).catch(function(){document.getElementById('console-meta').textContent='Connection lost · retrying';});}
  function schedule(){clearInterval(timer);if(!paused)timer=setInterval(fetchRows,2000);}
  function toast(text){var t=document.getElementById('copy-toast');t.textContent=text;t.classList.add('show');setTimeout(function(){t.classList.remove('show');},1600);}
  function text(){return Array.from(output.querySelectorAll('.log-entry')).map(function(r){return r.querySelector('.log-time').textContent+' '+r.querySelector('.log-level').textContent.padEnd(5)+' ['+r.querySelector('.log-category').textContent+(r.querySelector('.log-user').textContent?' user='+r.querySelector('.log-user').textContent:'')+'] '+r.querySelector('.log-message').textContent;}).join('\\n');}
  function copy(){var value=text(),fallback=function(){var a=document.createElement('textarea');a.value=value;a.style.position='fixed';a.style.opacity='0';document.body.appendChild(a);a.select();document.execCommand('copy');a.remove();toast('Copied '+lastRows.length+' entries');};if(navigator.clipboard&&window.isSecureContext)navigator.clipboard.writeText(value).then(function(){toast('Copied '+lastRows.length+' entries');},fallback);else fallback();}
  document.getElementById('pause-btn').addEventListener('click',function(){paused=!paused;setLive();schedule();if(!paused)fetchRows();});
  document.getElementById('copy-btn').addEventListener('click',copy);
  document.getElementById('wrap-toggle').addEventListener('change',function(){output.classList.toggle('wrap',this.checked);});
  document.getElementById('detail-toggle').addEventListener('change',function(){var on=this.checked;fetch('/admin/logs/preferences',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'detailedRejections='+(on?'on':'off')}).then(function(r){if(!r.ok)throw Error();document.getElementById('diagnostic-copy').innerHTML=on?'<strong>Rejection diagnostics enabled.</strong> Every rejected candidate from new searches will be logged.':'<strong>Rejection diagnostics sampled.</strong> New searches log a representative sample for each exclusion reason.';toast(on?'Full rejection detail enabled':'Rejection detail set to sampled');}).catch(function(){this.checked=!on;toast('Could not update diagnostics');}.bind(this));});
  form.addEventListener('submit',function(e){e.preventDefault();updateLinks();fetchRows();});
  form.addEventListener('change',function(){updateLinks();fetchRows();});
  var debounce;document.getElementById('log-search').addEventListener('input',function(){clearTimeout(debounce);debounce=setTimeout(function(){updateLinks();fetchRows();},300);});
  document.addEventListener('keydown',function(e){if(e.key==='/'&&!/input|select|textarea/i.test(document.activeElement.tagName)){e.preventDefault();document.getElementById('log-search').focus();}if((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key.toLowerCase()==='c'){e.preventDefault();copy();}});
  output.scrollTop=output.scrollHeight;lastRows=Array.from(output.querySelectorAll('.log-entry'));setLive();schedule();updateLinks();
})();</script>`;
}

module.exports = { queryOptions, renderBody, rowHtml, rowsToText };
