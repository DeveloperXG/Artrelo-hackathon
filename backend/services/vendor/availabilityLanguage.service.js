// Availability interpretation is a preview, never consent or a scheduling
// mutation. Default path is explicit local rules; no network/provider fallback.
const { validateWindows } = require('./bookingReschedule.contract');
function formatter(timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}
const parts = (format, value) => Object.fromEntries(format.formatToParts(value).filter(row => row.type !== 'literal').map(row => [row.type, Number(row.value)]));
function localInstant(day, clock, format) {
  const guess = Date.UTC(day.year, day.month - 1, day.day, clock.hour, clock.minute);
  const matches = [];
  // Modern IANA offsets include half/quarter hours. Enumerating offsets also
  // detects repeated/nonexistent local times instead of silently picking DST.
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
    const instant = new Date(guess - offset * 60000), p = parts(format, instant);
    if (p.year === day.year && p.month === day.month && p.day === day.day && p.hour === clock.hour && p.minute === clock.minute) matches.push(instant);
  }
  if (matches.length !== 1) throw new Error(matches.length ? 'That local time occurs twice. Use an unambiguous time or an exact UTC offset.' : 'That local time does not exist. Choose another time.');
  return matches[0].toISOString();
}
function clock(value) {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(value.trim());
  if (!match || (!match[3] && match[2] === undefined)) throw new Error('Include am/pm for both times, or use 24-hour times such as 14:00 to 16:00.');
  let hour = Number(match[1]), minute = Number(match[2] || 0);
  if (minute > 59 || (match[3] ? hour < 1 || hour > 12 : hour > 23)) throw new Error('Use valid clock times.');
  if (match[3]) hour = hour % 12 + (match[3].toLowerCase() === 'pm' ? 12 : 0);
  return { hour, minute };
}
const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
function dayOf(token, today) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(token)) {
    const [year, month, day] = token.split('-').map(Number), check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) throw new Error('Use a valid calendar date.');
    return { year, month, day };
  }
  const date = new Date(Date.UTC(today.year, today.month - 1, today.day));
  const increment = token === 'today' ? 0 : token === 'tomorrow' ? 1 : (weekdays.indexOf(token) - date.getUTCDay() + 7) % 7;
  date.setUTCDate(date.getUTCDate() + increment);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}
function base({ timeZone, now, source = 'local_rules' }) { return { source, timeZone: typeof timeZone === 'string' ? timeZone.slice(0, 80) : null, asOf: now.toISOString(), windows: [], needsClarification: false, question: null }; }
function interpretLocally({ text, timeZone, now = new Date() }) {
  const result = base({ timeZone, now });
  try {
    if (typeof text !== 'string' || !text.trim() || text.length > 800) throw new Error('Describe up to three availability windows in 800 characters or fewer.');
    if (typeof timeZone !== 'string' || timeZone.length > 80) throw new Error('Choose the time zone for these times.');
    let format; try { format = formatter(timeZone); } catch (_) { throw new Error('Choose a valid IANA time zone such as America/Regina.'); }
    const today = parts(format, now), segments = text.trim().split(';');
    if (segments.length > 3) throw new Error('Use up to three availability windows.');
    const windows = segments.map(segment => {
      const match = /^(?:(?:i am|i'm|we are|we're)\s+)?(?:(?:available|free|can do)\s+)?(today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday|\d{4}-\d{2}-\d{2})\s+(?:from\s+|between\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:to|and|[-–])\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)[.!]?$/i.exec(segment.trim());
      if (!match) throw new Error('Use a specific date or tomorrow and both start/end times, for example: tomorrow 2pm to 4pm. Separate windows with semicolons.');
      const day = dayOf(match[1].toLowerCase(), today);
      return { start: localInstant(day, clock(match[2]), format), end: localInstant(day, clock(match[3]), format) };
    });
    result.windows = validateWindows(windows, now);
  } catch (failure) { result.needsClarification = true; result.question = failure.code ? 'Choose future windows of at least 15 minutes within the next 60 days. The proposed visit duration is separate.' : failure.message; }
  return result;
}
async function interpret({ text, timeZone, now = new Date(), complete }) {
  const local = interpretLocally({ text, timeZone, now });
  if (!complete) return local;
  // Injectable for separately budgeted live qualification or explicit offline
  // tests. Runtime HTTP handlers never accept a provider/function from callers.
  try {
    if (typeof text !== 'string' || text.length > 800 || typeof timeZone !== 'string') return local;
    formatter(timeZone);
    const output = await complete({ schemaVersion: 1, text, timeZone, asOf: now.toISOString(), maxWindows: 3 });
    if (!output || Array.isArray(output) || Object.keys(output).sort().join(',') !== 'needsClarification,question,windows' || typeof output.needsClarification !== 'boolean') throw new Error('invalid interpretation');
    if (output.needsClarification) {
      if (output.windows?.length || typeof output.question !== 'string' || !output.question.trim() || output.question.length > 300) throw new Error('invalid question');
      return { ...base({ timeZone, now, source: 'development_stub' }), needsClarification: true, question: output.question };
    }
    if (output.question !== null) throw new Error('invalid interpretation');
    return { ...base({ timeZone, now, source: 'development_stub' }), windows: validateWindows(output.windows, now) };
  } catch (_) { return { ...local, modelStatus: 'unavailable', explanation: 'The interpretation service is unavailable. Review the local preview or enter exact times; nothing was scheduled.' }; }
}
module.exports = { interpret, interpretLocally };
