// How a count is written inside a badge, everywhere in the app.
//
// Exact up to 9, then "9+". A badge is a nudge, not a ledger: past nine the
// exact number changes nothing about what to do (open the page), and a single
// digit keeps the pill one size. The notification bell already did this; the
// sidebar tabs used to go up to "99+", which in practice meant no cap.

export const BADGE_MAX = 9;

export function formatBadgeCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '';
  const whole = Math.floor(count);
  return whole > BADGE_MAX ? `${BADGE_MAX}+` : String(whole);
}
