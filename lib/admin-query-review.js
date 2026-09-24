'use strict';
const review = require('./query-review');
// A league's team catalogs ("epl-mun" for EPL) search the same fixtures under
// their own promotion id. Their measurements belong on the league's page.
function teamCatalogs(promotion) {
  try {
    return require('./promotions').all.filter(p => p.reviewParent === promotion.id);
  } catch (_) { return []; }
}
function relatedIds(promotion) { return teamCatalogs(promotion).map(p => p.id); }
const esc = value => String(value || '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function render(promotion, options = {}) {
  const teams = teamCatalogs(promotion);
  const teamNames = new Map(teams.map(p => [p.id, p.name]));
  const all = review.getDefault().rows(promotion.id, teams.map(p => p.id));
  const source = String(options.source || '');
  const search = String(options.search || '').trim().slice(0,200);
  const filtered = all.filter(row => (!source || row.source===source) && (!search || row.pattern.includes(search.toLowerCase())));
  const pages = Math.max(1, Math.ceil(filtered.length/50));
  const page = Math.max(1, Math.min(pages, Number.parseInt(options.page,10) || 1));
  const rows = filtered.slice((page-1)*50, page*50);
  const base = '/admin/promotions/' + encodeURIComponent(promotion.id) + '/aliases';
  const link = number => base + '?' + new URLSearchParams({source,search,page:String(number)}).toString();
  const filters = `<form method="GET" class="row g-2 mb-3"><div class="col-md-4"><label class="form-label">Source</label><select class="form-select" name="source"><option value="">All sources</option>${Array.from(new Set(all.map(row=>row.source))).map(value=>`<option value="${esc(value)}" ${value===source?'selected':''}>${esc(value)}</option>`).join('')}</select></div><div class="col-md-6"><label class="form-label">Query contains</label><input class="form-control" name="search" value="${esc(search)}"></div><div class="col-md-2 align-self-end"><button class="btn btn-primary">Filter</button></div></form><div class="mb-3">${filtered.length} query patterns · Page ${page} of ${pages} ${page>1?`<a href="${esc(link(page-1))}">Previous</a>`:''} ${page<pages?`<a href="${esc(link(page+1))}">Next</a>`:''}</div>`;
  const body = rows.map(row => {
    const attempts = row.completed + row.timeouts + row.errors;
    const action = ['active','demoted','disabled'].map(value => `<button class="btn btn-sm ${value===row.action?'btn-primary':'btn-outline-secondary'}" name="action" value="${value}">${value==='active'?'Enable':value==='demoted'?'Demote':'Disable'}</button>`).join(' ');
    const last = row.lastHit ? new Date(row.lastHit).toISOString().slice(0,10) : 'None yet';
    return `<tr><td><div class="text-mono text-break">${esc(row.pattern)}</div><small class="text-secondary">${esc(row.coverage)} ${esc(row.flag)}</small>${row.promotion && row.promotion !== promotion.id ? `<div><span class="badge bg-secondary-lt">via ${esc(teamNames.get(row.promotion) || row.promotion)} team catalog</span></div>` : ''}<details><summary>Example query</summary>${esc(row.example || row.pattern)}</details></td><td>${esc(row.source)}</td><td>${row.completed}<br><small>${row.zeros} zero hits</small></td><td>${row.timeouts} timeouts<br>${row.errors} errors<br>${row.unattempted} unattempted</td><td>${row.hits} hits<br>${row.matched} matched<br>${row.uniqueMatches} unique</td><td>${attempts ? (row.duration/attempts/1000).toFixed(2) : '0'}s average<br>${row.duration ? (row.uniqueMatches/(row.duration/1000)).toFixed(2) : '0'} unique/s</td><td>${row.pastFixtures}<br><small>Last hit: ${last}</small></td><td><div class="mb-2">${esc(row.action)}</div><form method="POST" action="/admin/promotions/${encodeURIComponent(promotion.id)}/aliases"><input type="hidden" name="key" value="${esc(row.key)}">${action}</form></td></tr>`;
  }).join('');
  return `<div class="page-header"><h2 class="page-title">Review aliases · ${esc(promotion.name)}</h2><a href="/admin/promotions">Back to promotions</a></div><div class="card"><div class="card-body"><p>Review the queries generated from aliases and search patterns. Dates, seasons and weeks are grouped so the same query can be compared across fixtures. Disabling affects this query pattern for this promotion and source; it can be enabled again.</p>${teams.length ? `<p>Includes searches made from ${teams.length} team catalog${teams.length === 1 ? '' : 's'} (${teams.map(p => esc(p.name)).join(', ')}), labelled on each row. Rules set here also apply when the same fixture is opened from a team catalog.</p>` : ''}${promotion.reviewParent ? `<p>This is a team catalog. Its searches are also shown on the <a href="/admin/promotions/${encodeURIComponent(promotion.reviewParent)}/aliases">${esc(promotion.reviewParent.toUpperCase())} page</a>, and that page's rules apply here too.</p>` : ''}<p class="text-secondary">Tracked sources: Prowlarr, Bitmagnet, Easynews and native Usenet indexers. Only real provider searches are measured. Cached answers do not count as new attempts. Timeouts and unattempted queries do not count as zero hits. Repeated zero hits requires at least 10 completed searches across 5 past fixtures, excluding bulk preparation. Unique matches are new within that source search, rather than duplicates from its earlier queries. Measurements are kept for 90 days, up to 50,000 samples. Tracking adds no searches. Measured Prowlarr discovery contributes its existing search evidence, separated by indexer.</p>${filters}<p>Demote keeps a query available but tries it later. Disable removes it from offered queries. Rare @ matchup and week formats are labelled for coverage review; nothing is disabled automatically.</p></div><div class="table-responsive"><table class="table"><thead><tr><th>Query pattern</th><th>Source</th><th>Completed</th><th>Other outcomes</th><th>Results</th><th>Time and value</th><th>Past fixtures</th><th>Control</th></tr></thead><tbody>${body || '<tr><td colspan="8">No measurements yet. Live searches and measured Prowlarr discovery will populate this page.</td></tr>'}</tbody></table></div></div>`;
}
module.exports = {render, relatedIds};
