import { describe, expect, it } from 'vitest';
import { windowMatchesPreference } from './windowPreference';

const SAT_MORNING = 'Sat, Oct 3, 8:00 a.m. – 12:00 p.m.';
const MON_AFTERNOON = 'Mon, Oct 5, 1:00 p.m. – 5:00 p.m.';
const TUE_EVENING = 'Tue, Oct 6, 6:00 p.m. – 9:00 p.m.';

describe('windowMatchesPreference', () => {
  it('matches part of day', () => {
    expect(windowMatchesPreference(SAT_MORNING, ['Mornings'])).toBe(true);
    expect(windowMatchesPreference(MON_AFTERNOON, ['Mornings'])).toBe(false);
    expect(windowMatchesPreference(TUE_EVENING, ['Evenings'])).toBe(true);
  });

  it('combines day and part of day', () => {
    expect(windowMatchesPreference(SAT_MORNING, ['Weekday mornings'])).toBe(false);
    expect(windowMatchesPreference('Mon, Oct 5, 8:00 a.m. – 12:00 p.m.', ['Weekday mornings'])).toBe(true);
    expect(windowMatchesPreference(SAT_MORNING, ['Weekends'])).toBe(true);
    expect(windowMatchesPreference(SAT_MORNING, ['Saturday'])).toBe(true);
  });

  it('reads after/before times', () => {
    expect(windowMatchesPreference(TUE_EVENING, ['After 5pm'])).toBe(true);
    expect(windowMatchesPreference(MON_AFTERNOON, ['After 5'])).toBe(false);
    expect(windowMatchesPreference(SAT_MORNING, ['Before noon', 'before 11am'])).toBe(true);
  });

  it('claims nothing for phrases it cannot read', () => {
    expect(windowMatchesPreference(SAT_MORNING, ['Whenever is fine'])).toBe(false);
    expect(windowMatchesPreference("Flexible — any day you're open", ['Mornings'])).toBe(false);
    expect(windowMatchesPreference(SAT_MORNING, [])).toBe(false);
  });
});
