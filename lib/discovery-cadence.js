'use strict';
const HOUR=3600000;
// Expected playing time plus publication allowance. Unknown start times remain conservative.
function readyAt(event) {
  const time=event.time || event.startTime;
  if(!time) return Date.parse(event.date+'T23:59:59Z')+6*HOUR;
  const promotion=String(event.id || '').split(':')[0];
  const hours={mlb:4,nfl:4,nba:3.5,ucl:3,epl:3,'match-of-the-day':3}[promotion] || 6;
  return Date.parse(event.date+'T'+String(time).slice(0,8)+'Z')+hours*HOUR;
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
module.exports={readyAt,retryDelay,retryAfter};
