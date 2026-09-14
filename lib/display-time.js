'use strict';
function formatTimestamp(value, zone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-GB', {timeZone:zone,
    year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',fractionalSecondDigits:3}).formatToParts(date);
  const fields = Object.fromEntries(parts.map(p=>[p.type,p.value]));
  return fields.year+'-'+fields.month+'-'+fields.day+' '+fields.hour+':'+fields.minute+':'+fields.second+'.'+fields.fractionalSecond;
}
function displayTime(value) {
  return formatTimestamp(value, require('./settings').getDisplayTimeZone());
}
module.exports = {formatTimestamp, displayTime};
