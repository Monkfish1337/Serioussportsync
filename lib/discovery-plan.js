'use strict';

function selectTorrentQueries(titles, event, promotion, maxQueries) {
  const cap = Math.max(1, Number(maxQueries) || 6);
  const unique = Array.from(new Set((titles || []).filter(Boolean)));
  if (!['mlb', 'nba', 'nfl'].includes(String(promotion && (promotion.teamAliasPreset || promotion.id)))) return unique.slice(0, cap);
  const parts = String(event && event.name || '').split(/\s+(?:vs\.?|v\.?|at|@)\s+/i);
  if (parts.length !== 2) return unique.slice(0, cap);
  const date = String(event.date || '');
  const [year, month, day] = date.split('-');
  const pair = parts.map(p => p.trim());
  const week = Number(event.week);
  const span = String(event.seasonSpan || '');
  const diverse = [unique[0], pair.join(' vs ') + ' ' + date.replace(/-/g, '.'),
    pair.join(' @ ') + ' ' + (day && month && year ? [day, month, year].join('.') : '')];
  if (promotion.id === 'nfl' && Number.isInteger(week) && week > 0 && /^\d{4}-\d{4}$/.test(span)) {
    diverse.push('NFL ' + span + ' W' + String(week).padStart(2, '0') + ' ' + pair.join(' '));
  }
  diverse.push(unique[1], pair.join(' @ ') + ' ' + date.replace(/-/g, '.'));
  return Array.from(new Set(diverse.concat(unique).filter(Boolean))).slice(0, cap);
}

// A fast request returns completed pipelines after the grace period. If no
// pipeline has any rows then, keep waiting for the first useful answer or all
// pipelines to finish. Remaining work keeps its existing bounded lifetime.
function collectPipelineRows(promises, graceMs) {
  if (!(Number(graceMs) > 0)) return Promise.all(promises);
  return new Promise(resolve => {
    const rows = promises.map(() => []);
    let pending = promises.length, expired = false, done = false;
    let timer;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(rows.slice());
    };
    const check = () => { if (!pending || (expired && rows.some(r => r.length))) finish(); };
    timer = setTimeout(() => { expired = true; check(); }, Number(graceMs));
    promises.forEach((promise, i) => Promise.resolve(promise).then(value => {
      rows[i] = Array.isArray(value) ? value : [];
    }, () => {}).then(() => { pending--; check(); }));
    check();
  });
}
module.exports = {selectTorrentQueries, collectPipelineRows};
