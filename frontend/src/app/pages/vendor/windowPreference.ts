/**
 * Does an offered window match the tenant's stated preference?
 *
 * The preference is a short phrase the intake AI normalised ("weekday
 * mornings", "after 5pm", "Saturday"). The window is matched by its LABEL,
 * which is written in the property's timezone ("Sat, Oct 3, 8:00 a.m. –
 * 12:00 p.m."), not by its timestamp: read in the vendor's browser a Regina
 * morning could land in a different part of the day. A phrase this can't read
 * matches nothing, and the vendor still sees the preference as text.
 */

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseLabel(label: string) {
  const day = DAYS.indexOf(label.trim().slice(0, 3).toLowerCase());
  const time = label.match(/(\d{1,2}):(\d{2})\s*([ap])\.?\s*m/i);
  if (!time) return { day, startHour: null as number | null };
  let hour = Number(time[1]) % 12;
  if (time[3].toLowerCase() === 'p') hour += 12;
  return { day, startHour: hour };
}

function phraseMatches(phrase: string, day: number, startHour: number | null) {
  const text = phrase.toLowerCase();
  const checks: boolean[] = [];

  if (/weekday/.test(text)) checks.push(day >= 1 && day <= 5);
  if (/weekend/.test(text)) checks.push(day === 0 || day === 6);
  const namedDays = DAYS.filter((name) => new RegExp(`\\b${name}`).test(text));
  if (namedDays.length) checks.push(namedDays.includes(DAYS[day]));

  if (startHour !== null) {
    if (/morning/.test(text)) checks.push(startHour < 12);
    if (/afternoon/.test(text)) checks.push(startHour >= 12 && startHour < 17);
    if (/evening|night/.test(text)) checks.push(startHour >= 17);
    const after = text.match(/after\s+(\d{1,2})\s*(am|pm)?/);
    if (after) {
      let hour = Number(after[1]) % 12;
      if (after[2] === 'pm' || (!after[2] && hour < 8)) hour += 12;
      checks.push(startHour >= hour);
    }
    const before = text.match(/before\s+(\d{1,2})\s*(am|pm)?/);
    if (before) {
      let hour = Number(before[1]) % 12;
      if (before[2] === 'pm' || (!before[2] && hour < 8)) hour += 12;
      checks.push(startHour < hour);
    }
  }

  // Nothing recognisable in the phrase: no claim either way.
  return checks.length > 0 && checks.every(Boolean);
}

export function windowMatchesPreference(label: string | undefined, preferredTimes: string[] | undefined) {
  if (!label || !preferredTimes?.length) return false;
  const { day, startHour } = parseLabel(label);
  if (day < 0) return false;
  return preferredTimes.some((phrase) => phraseMatches(phrase, day, startHour));
}
