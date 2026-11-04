import { describe, expect, it } from 'vitest';
import { formatDuration, parseCustomDuration } from './durationOnSite';

describe('formatDuration', () => {
  it('reads naturally', () => {
    expect(formatDuration(45)).toBe('45 min');
    expect(formatDuration(120)).toBe('2h');
    expect(formatDuration(105)).toBe('1h 45m');
    expect(formatDuration(0)).toBe('');
  });
});

describe('parseCustomDuration', () => {
  it('accepts 15-minute steps between 15 minutes and 12 hours', () => {
    expect(parseCustomDuration('1', '45')).toEqual({ minutes: 105 });
    expect(parseCustomDuration('', '15')).toEqual({ minutes: 15 });
    expect(parseCustomDuration('12', '0')).toEqual({ minutes: 720 });
  });

  it('explains what is wrong', () => {
    expect(parseCustomDuration('0', '10')).toEqual({ error: 'At least 15 minutes.' });
    expect(parseCustomDuration('12', '15')).toHaveProperty('error');
    expect(parseCustomDuration('1', '20')).toEqual({ error: 'Use 15-minute steps (e.g. 1h 45m).' });
    expect(parseCustomDuration('1.5', '0')).toEqual({ error: 'Enter whole hours and minutes.' });
  });
});
