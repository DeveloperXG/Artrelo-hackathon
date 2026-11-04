import { describe, expect, it } from 'vitest';
import { dailyResetHint, weeklyResetHint } from './RequestQuotaMeter';

const now = new Date(2026, 9, 12, 9, 0); // Mon Oct 12, 9:00 a.m. local
const win = (used: number, resetsAt: Date | null) => ({ used, limit: 3, remaining: 3 - used, resetsAt: resetsAt?.toISOString() ?? null });

describe('dailyResetHint', () => {
  it('says the full limit is there when nothing counts', () => {
    expect(dailyResetHint(win(0, null), now)).toBe('Full limit available');
  });
  it('rounds hours up so the reset never comes early', () => {
    expect(dailyResetHint(win(1, new Date(now.getTime() + 4.2 * 3600_000)), now)).toBe('Resets in 5 hours');
    expect(dailyResetHint(win(1, new Date(now.getTime() + 3600_000)), now)).toBe('Resets in 1 hour');
  });
  it('counts minutes in the last hour', () => {
    expect(dailyResetHint(win(2, new Date(now.getTime() + 25 * 60_000)), now)).toBe('Resets in 25 min');
  });
});

describe('weeklyResetHint', () => {
  it('names the weekday and time', () => {
    const hint = weeklyResetHint(win(1, new Date(2026, 9, 15, 16, 12)), now);
    expect(hint).toMatch(/^Resets \S+ at /);
    expect(hint).toContain(new Date(2026, 9, 15).toLocaleDateString(undefined, { weekday: 'short' }));
  });
  it('says today for a reset later today', () => {
    expect(weeklyResetHint(win(1, new Date(2026, 9, 12, 17, 0)), now)).toMatch(/^Resets today at /);
  });
});
