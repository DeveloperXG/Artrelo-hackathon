import { describe, expect, it } from 'vitest';
import { splitMessageParagraphs } from '../MessageParagraphs';
import { formatPriceEstimate, getAvailabilityDisplay, getEstimateHint } from './requestDetailSelectors';

describe('splitMessageParagraphs', () => {
  it('splits on blank lines and drops indentation', () => {
    const text = 'First line\n   indented second\n\n\n  Second paragraph  \n';
    expect(splitMessageParagraphs(text)).toEqual([['First line', 'indented second'], ['Second paragraph']]);
  });

  it('handles CRLF and empty input', () => {
    expect(splitMessageParagraphs('a\r\n\r\nb')).toEqual([['a'], ['b']]);
    expect(splitMessageParagraphs('   ')).toEqual([]);
  });
});

describe('estimate display', () => {
  it('shows a dash, not an invented range, with no paid history', () => {
    expect(formatPriceEstimate(null)).toBe('—');
    expect(getEstimateHint(null)).toBe('No paid jobs for this trade yet');
  });

  it('shows the paid-job average and where it comes from', () => {
    const estimate = { amountLow: 250, amountHigh: 250, basis: 'paid_job_average', sampleSize: 3 };
    expect(formatPriceEstimate(estimate)).toBe('$250');
    expect(getEstimateHint(estimate)).toBe('Avg of 3 paid jobs');
    expect(getEstimateHint({ ...estimate, sampleSize: 1 })).toBe('Avg of 1 paid job');
  });
});

describe('getAvailabilityDisplay', () => {
  const now = new Date('2026-07-28T15:00:00.000Z');
  const past = { slotId: 'p', label: 'Mon morning', start: '2026-07-27T14:00:00.000Z' };
  const future = { slotId: 'f', label: 'Wed morning', start: '2026-07-29T14:00:00.000Z' };

  it('skips slots that have already started (the snapshot can be days old)', () => {
    expect(getAvailabilityDisplay({ availabilitySlots: [past, future], hoursLabel: '24/7' }, now)).toEqual({
      value: 'Wed morning',
      hint: '24/7',
    });
  });

  it('falls back to the hours when every slot is stale', () => {
    expect(getAvailabilityDisplay({ availabilitySlots: [past], hoursLabel: 'Mon–Fri 9:00–17:00' }, now)).toEqual({
      value: 'Mon–Fri 9:00–17:00',
      hint: 'Regenerate for fresh time slots',
    });
  });

  it('keeps a flexible slot (no start)', () => {
    const flexible = { slotId: 'x', label: "Flexible — any day you're open", start: null };
    expect(getAvailabilityDisplay({ availabilitySlots: [past, flexible] }, now).value).toBe(
      "Flexible — any day you're open"
    );
  });

  it('says pending with neither slots nor hours', () => {
    expect(getAvailabilityDisplay({ availabilitySlots: [] }, now)).toEqual({ value: 'Pending', hint: null });
  });

  // Live timing leads: it decides whether Approve sends now or schedules.
  const timing = (overrides: Record<string, unknown>) => ({
    openNow: false,
    nextOpenAt: null,
    nextOpenLabel: null,
    hoursLabel: null,
    sendNow: true,
    scheduledFor: null,
    scheduledForLabel: null,
    ...overrides,
  });

  it('shows a 24/7 vendor as open now, not as a narrow slot', () => {
    expect(
      getAvailabilityDisplay(
        { availabilitySlots: [future], sendTiming: timing({ openNow: true, hoursLabel: '24/7' }) },
        now
      )
    ).toEqual({ value: 'Open now', hint: '24/7' });
  });

  it('shows when a closed vendor opens', () => {
    expect(
      getAvailabilityDisplay(
        {
          availabilitySlots: [future],
          sendTiming: timing({ nextOpenLabel: 'Mon, Aug 3, 8:00 a.m.', hoursLabel: 'Mon–Fri 8:00–15:00' }),
        },
        now
      )
    ).toEqual({ value: 'Opens Mon, Aug 3, 8:00 a.m.', hint: 'Mon–Fri 8:00–15:00' });
  });
});
