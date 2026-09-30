'use strict';

// Placeholder episodes for WWE's weekly shows (Discussions #59). TheSportsDB
// lists an NXT episode only after it airs, so today's episode had no event and
// its releases, posted overnight, had nothing to match. Raw, SmackDown and NXT
// air on a fixed weekday, so each refresh adds any episode from two days ago
// to seven days ahead that is not listed yet, named with the next episode
// number. When TheSportsDB lists the real episode (within a day of it), the
// placeholder is dropped; one it never lists goes after 14 days.

const DAY = 24 * 60 * 60 * 1000;
const TYPE = 'schedule';

function isoDay(t) { return new Date(t).toISOString().slice(0, 10); }
function dayMs(iso) { return Date.parse(iso + 'T00:00:00Z'); }
function isPlaceholder(ev) { return !!(ev && ev.source && ev.source.type === TYPE); }

// Today's date on the US East Coast, where these shows air.
function easternToday(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  return parts.year + '-' + parts.month + '-' + parts.day;
}

// Raw records (for transform.fromWiki) for episodes the source has not listed.
// `events`: this promotion's stored and fetched events.
function placeholders(events, promotion, now) {
  const airDay = promotion && promotion.weeklyAirDay;
  if (!Number.isInteger(airDay)) return [];
  const listed = (events || []).filter((e) => e && e.date && !isPlaceholder(e));
  const all = (events || []).filter((e) => e && e.date);
  const covered = (iso) => all.some((e) => Math.abs(dayMs(e.date) - dayMs(iso)) <= DAY);
  const numbered = listed.map((e) => ({ date: e.date, n: Number((/#(\d+)\b/.exec(e.name || '') || [])[1]) }))
    .filter((e) => Number.isFinite(e.n)).sort((a, b) => b.date.localeCompare(a.date))[0];
  const today = dayMs(easternToday(now));
  const out = [];
  for (let t = today - 2 * DAY; t <= today + 7 * DAY; t += DAY) {
    if (new Date(t).getUTCDay() !== airDay) continue;
    const date = isoDay(t);
    if (covered(date)) continue;
    const weeks = numbered ? Math.round((t - dayMs(numbered.date)) / (7 * DAY)) : 0;
    const name = promotion.weeklyTitle + (numbered && weeks > 0 ? ' #' + (numbered.n + weeks) : '');
    out.push({ sourceId: 'sched-' + date, name, date, dateLocal: date, source: { type: TYPE } });
  }
  return out;
}

// Drops placeholders the source now lists, and ones older than 14 days.
function dropPlaceholders(byId, promotion, now) {
  const listed = [];
  for (const ev of byId.values()) if (ev.promotion === promotion.id && ev.date && !isPlaceholder(ev)) listed.push(dayMs(ev.date));
  const cutoff = dayMs(easternToday(now)) - 14 * DAY;
  let dropped = 0;
  for (const [id, ev] of byId) {
    if (ev.promotion !== promotion.id || !isPlaceholder(ev)) continue;
    const t = dayMs(ev.date);
    if (t < cutoff || listed.some((d) => Math.abs(d - t) <= DAY)) { byId.delete(id); dropped++; }
  }
  return dropped;
}

module.exports = { placeholders, dropPlaceholders, isPlaceholder, TYPE };
