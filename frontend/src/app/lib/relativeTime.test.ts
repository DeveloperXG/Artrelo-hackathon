import { describe, expect, it } from 'vitest';
import { relativeTime } from './relativeTime';

const now = new Date(2026, 9, 5, 9, 0); // 5 Oct 2026, 9:00 a.m.
const ago = (ms: number) => new Date(now.getTime() - ms);
const MIN = 60_000;

describe('relativeTime', () => {
  it('reads the last minute as just now', () => {
    expect(relativeTime(ago(20_000), now)).toBe('Just now');
  });

  it('counts minutes and hours', () => {
    expect(relativeTime(ago(5 * MIN), now)).toBe('5 min ago');
    expect(relativeTime(ago(60 * MIN), now)).toBe('1 hour ago');
    expect(relativeTime(ago(5 * 60 * MIN), now)).toBe('5 hours ago');
  });

  it('calls last night yesterday, by calendar day', () => {
    expect(relativeTime(new Date(2026, 9, 4, 8, 0), now)).toBe('Yesterday');
  });

  it('counts days within the week, then shows a date', () => {
    expect(relativeTime(new Date(2026, 9, 1, 12, 0), now)).toBe('4 days ago');
    expect(relativeTime(new Date(2026, 8, 20, 12, 0), now)).not.toMatch(/ago/);
  });

  it('returns nothing for an unparseable date', () => {
    expect(relativeTime('not a date', now)).toBe('');
  });
});
