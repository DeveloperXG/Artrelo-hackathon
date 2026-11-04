import { describe, expect, it } from 'vitest';
import { formatTime } from './irisFormat';

describe('canonical short Iris timestamps', () => {
  it('uses the same instant and labelled UTC independent of host timezone', () => {
    expect(formatTime('2026-11-03T15:04:00.000Z')).toBe('Nov 3, 2026, 3:04 PM UTC');
    expect(formatTime('2026-11-03T10:04:00-05:00')).toBe('Nov 3, 2026, 3:04 PM UTC');
  });
  it('uses a valid explicit record zone including DST rather than the browser zone', () => {
    expect(formatTime('2026-07-03T15:04:00Z', 'America/Toronto')).toBe('Jul 3, 2026, 11:04 AM America/Toronto');
    expect(formatTime('2026-11-03T15:04:00Z', 'America/Toronto')).toBe('Nov 3, 2026, 10:04 AM America/Toronto');
  });
  it('labels a missing or invalid zone UTC and never invents an unknown instant', () => {
    expect(formatTime('2026-11-03T00:00:00Z', 'invalid/zone')).toBe('Nov 3, 2026, 12:00 AM UTC');
    expect(formatTime('2026-11-03T00:00:00Z', null)).toBe('Nov 3, 2026, 12:00 AM UTC');
    for (const value of [null, '', 'invalid']) expect(formatTime(value)).toBe('Unknown time');
  });
});
