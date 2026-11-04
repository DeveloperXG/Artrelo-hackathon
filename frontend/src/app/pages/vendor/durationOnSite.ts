// Time on site. Mirrors the server rule in vendorPortal.controller.js
// (validateDurationMinutes): 15 minutes to 12 hours, in 15-minute steps.

export const MIN_DURATION_MINUTES = 15;
export const MAX_DURATION_MINUTES = 12 * 60;
export const DURATION_STEP_MINUTES = 15;

export const DURATION_PRESETS = [
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
  { value: 120, label: '2 hours' },
  { value: 240, label: 'Half a day' },
];

/** "45 min", "2h", "1h 45m". */
export function formatDuration(minutes: number) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** Hours + minutes from the custom fields -> total minutes, or an error. */
export function parseCustomDuration(hours: string, minutes: string): { minutes: number } | { error: string } {
  const h = hours.trim() === '' ? 0 : Number(hours);
  const m = minutes.trim() === '' ? 0 : Number(minutes);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0) {
    return { error: 'Enter whole hours and minutes.' };
  }
  const total = h * 60 + m;
  if (total < MIN_DURATION_MINUTES) return { error: 'At least 15 minutes.' };
  if (total > MAX_DURATION_MINUTES) return { error: 'At most 12 hours — book a second visit for longer jobs.' };
  if (total % DURATION_STEP_MINUTES !== 0) return { error: 'Use 15-minute steps (e.g. 1h 45m).' };
  return { minutes: total };
}
