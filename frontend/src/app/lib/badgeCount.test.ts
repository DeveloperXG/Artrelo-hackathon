import { describe, expect, it } from 'vitest';
import { formatBadgeCount } from './badgeCount';

describe('formatBadgeCount', () => {
  it('is exact up to nine', () => {
    expect(formatBadgeCount(1)).toBe('1');
    expect(formatBadgeCount(9)).toBe('9');
  });

  it('caps at 9+', () => {
    expect(formatBadgeCount(10)).toBe('9+');
    expect(formatBadgeCount(250)).toBe('9+');
  });

  it('writes nothing for nothing', () => {
    expect(formatBadgeCount(0)).toBe('');
    expect(formatBadgeCount(-3)).toBe('');
    expect(formatBadgeCount(Number.NaN)).toBe('');
  });
});
