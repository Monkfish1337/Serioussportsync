'use strict';
const HOUR=3600000;
// The instant an event starts, or NaN when only its day is known.
//
// event.date is the LOCAL calendar day and event.time is the UTC clock time, so
// joining them is wrong whenever the UTC start falls on the next day: a 7:10pm
// Pacific MLB game is dated the 23rd with time 02:10, and date+time read it as
// the 23rd 02:10Z, almost a day before first pitch. That is about a third of
// every MLB week (every evening game west of Eastern), and it opened discovery
// for those games before they were played. The source timestamp is the real
// instant; TheSportsDB's carries no zone designator but is UTC.
function startAt(event) {
  const stamp=String(event && event.timestamp || '').trim();
  if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(stamp)) {
    const at=Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(stamp)?stamp:stamp+'Z');
    if(Number.isFinite(at)) return at;
  }
  const time=event && (event.time || event.startTime);
  return time?Date.parse(event.date+'T'+String(time).slice(0,8)+'Z'):NaN;
}
// Expected playing time plus publication allowance. Unknown start times remain conservative.
function readyAt(event) {
  const start=startAt(event);
  if(!Number.isFinite(start)) return Date.parse(event.date+'T23:59:59Z')+6*HOUR;
  const promotion=String(event.id || '').split(':')[0];
  const hours={mlb:4,nfl:4,nba:3.5,ucl:3,epl:3,'match-of-the-day':3}[promotion] || 6;
  return start+hours*HOUR;
}
function retryDelay(event,now,completedCycle) {
  const age=now-readyAt(event);
  if(age<24*HOUR) return (completedCycle?6:1)*HOUR;
  if(age<3*24*HOUR) return (completedCycle?12:2)*HOUR;
  return (completedCycle?24:6)*HOUR;
}
function retryAfter(value,now=Date.now()) {
  if(!value) return 0;
  const seconds=Number(value);
  return Number.isFinite(seconds)?Math.max(0,seconds*1000):Math.max(0,Date.parse(value)-now) || 0;
}
module.exports={startAt,readyAt,retryDelay,retryAfter};
