import { describe, expect, it } from 'vitest';
import {
  arrivalTimeBounds,
  buildArrivalIso,
  currentWindows,
  isArrivalInsideWindow,
  isWindowBookable,
  toDateInputValue,
  toTimeInputValue,
  validateAcceptForm,
  zonedWallClockToIso,
} from './acceptForm';
import type { OfferedWindow } from './vendorPortalTypes';

const window: OfferedWindow = {
  slotId: 's1',
  label: 'Mon, Oct 5, 8:00 a.m. – 12:00 p.m.',
  start: new Date(2026, 9, 5, 8, 0).toISOString(),
  end: new Date(2026, 9, 5, 12, 0).toISOString(),
  kind: 'window',
} as OfferedWindow;

const valid = {
  slot: window,
  quoteLow: '150',
  quoteHigh: '200',
  arrivalDate: '',
  arrivalTime: '09:30',
  durationMinutes: '120',
  customHours: '',
  customMinutes: '0',
};

describe('validateAcceptForm', () => {
  it('passes a complete form and returns what is sent', () => {
    const result = validateAcceptForm(valid);
    expect(result.errors).toBeNull();
    if (!result.errors) {
      expect(new Date(result.arrivalIso).getHours()).toBe(9);
      expect(result.onSiteMinutes).toBe(120);
    }
  });

  it('reports every problem at once, not just the first', () => {
    const result = validateAcceptForm({
      ...valid,
      quoteLow: '',
      arrivalTime: '',
      durationMinutes: 'custom',
      customHours: '13',
    });
    expect(result.errors).toEqual({
      quote: 'Enter both a low and a high estimate.',
      arrival: 'Enter the time you expect to arrive.',
      duration: 'At most 12 hours — book a second visit for longer jobs.',
    });
  });

  it('asks for a window first, and only then for an arrival', () => {
    const result = validateAcceptForm({ ...valid, slot: undefined });
    expect(result.errors).toEqual({ window: 'Choose one of the offered time windows.' });
  });

  it('keeps the arrival inside the chosen window', () => {
    const result = validateAcceptForm({ ...valid, arrivalTime: '13:00' });
    expect(result.errors?.arrival).toMatch(/outside Mon, Oct 5/);
  });

  it('rejects a high estimate below the low one', () => {
    const result = validateAcceptForm({ ...valid, quoteLow: '300', quoteHigh: '200' });
    expect(result.errors).toEqual({ quote: 'The high estimate must be at least the low estimate.' });
  });
});

// Windows are built in the property's zone; the vendor's phone may be anywhere.
const REGINA = 'America/Regina'; // UTC-6 all year
const reginaWindow: OfferedWindow = {
  slotId: 'r1',
  label: 'Tue, Oct 13, 8:00 a.m. – 12:00 p.m.',
  start: '2026-10-13T14:00:00.000Z',
  end: '2026-10-13T18:00:00.000Z',
  kind: 'window',
  timeZone: REGINA,
};

describe('arrival in the window zone', () => {
  it('reads the typed time on the window clock, whatever the phone says', () => {
    expect(buildArrivalIso(reginaWindow, '', '09:30')).toBe('2026-10-13T15:30:00.000Z');
    expect(isArrivalInsideWindow(reginaWindow, buildArrivalIso(reginaWindow, '', '09:30'))).toBe(true);
  });

  it('converts across a DST change', () => {
    // Toronto falls back on Nov 1 2026: 09:00 is UTC-5 after, UTC-4 before.
    expect(zonedWallClockToIso('2026-11-02', '09:00', 'America/Toronto')).toBe('2026-11-02T14:00:00.000Z');
    expect(zonedWallClockToIso('2026-10-30', '09:00', 'America/Toronto')).toBe('2026-10-30T13:00:00.000Z');
  });

  it('puts an after-midnight arrival on the next day of an overnight window', () => {
    const overnight: OfferedWindow = {
      ...reginaWindow,
      start: '2026-10-14T05:00:00.000Z', // 11 p.m. Oct 13
      end: '2026-10-14T07:00:00.000Z', // 1 a.m. Oct 14
      kind: 'asap',
    };
    expect(buildArrivalIso(overnight, '', '00:30')).toBe('2026-10-14T06:30:00.000Z');
  });

  it('formats dates and times in the window zone', () => {
    expect(toDateInputValue('2026-10-14T05:30:00.000Z', REGINA)).toBe('2026-10-13');
    expect(toTimeInputValue('2026-10-14T05:30:00.000Z', REGINA)).toBe('23:30');
  });
});

describe('windows that age while the page is open', () => {
  const now = new Date('2026-10-13T15:07:00.000Z'); // 9:07 a.m. Regina

  it('drops a window with no time left and clamps one under way', () => {
    const gone: OfferedWindow = { ...reginaWindow, slotId: 'gone', end: '2026-10-13T15:20:00.000Z' };
    const result = currentWindows([gone, reginaWindow], now);
    expect(result.map((slot) => slot.slotId)).toEqual(['r1']);
    expect(result[0].start).toBe('2026-10-13T15:15:00.000Z');
    expect(result[0].label).toMatch(/9:15 a\.m\. – 12:00 p\.m\./);
  });

  it('keeps the flexible slot and untouched future windows as they are', () => {
    const flexible: OfferedWindow = { slotId: 'f', label: 'Flexible', kind: 'flexible', start: null, end: null };
    const later: OfferedWindow = { ...reginaWindow, slotId: 'later', start: '2026-10-13T19:00:00.000Z', end: '2026-10-13T23:00:00.000Z' };
    expect(currentWindows([later, flexible], now)).toEqual([later, flexible]);
    expect(isWindowBookable(flexible, now)).toBe(true);
  });

  it('bounds the time input to the window on its own clock', () => {
    expect(arrivalTimeBounds(reginaWindow)).toEqual({ min: '08:00', max: '11:59' });
    expect(arrivalTimeBounds(undefined)).toEqual({});
  });
});
