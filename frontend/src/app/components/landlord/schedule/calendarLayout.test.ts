import { describe, expect, it } from 'vitest';
import {
  eventEnd,
  hourRange,
  layoutDay,
  monthGrid,
  startOfWeek,
  weekDays,
  type CalEvent,
} from './calendarLayout';

const t = (hh: number, mm = 0) => new Date(2026, 9, 6, hh, mm); // Tue 6 Oct 2026
const ev = (id: string, from: [number, number], to: [number, number]): CalEvent => ({
  id,
  start: t(...from),
  end: t(...to),
});
const byId = (placed: { id: string; lane: number; lanes: number }[]) =>
  Object.fromEntries(placed.map((p) => [p.id, [p.lane, p.lanes]]));

describe('layoutDay', () => {
  it('gives non-overlapping visits the full width', () => {
    const { placed, overflow } = layoutDay([ev('a', [9, 0], [10, 0]), ev('b', [13, 0], [14, 0])], 3);
    expect(byId(placed)).toEqual({ a: [0, 1], b: [0, 1] });
    expect(overflow).toEqual([]);
  });

  it('treats back-to-back visits as separate, not overlapping', () => {
    const { placed } = layoutDay([ev('a', [10, 0], [11, 0]), ev('b', [11, 0], [12, 0])], 3);
    expect(byId(placed)).toEqual({ a: [0, 1], b: [0, 1] });
  });

  it('splits three units booked into the same slot into three lanes', () => {
    const { placed, overflow } = layoutDay(
      [ev('a', [10, 0], [11, 0]), ev('b', [10, 0], [11, 0]), ev('c', [10, 0], [11, 0])],
      3
    );
    expect(byId(placed)).toEqual({ a: [0, 3], b: [1, 3], c: [2, 3] });
    expect(overflow).toEqual([]);
  });

  it('puts staggered overlaps side by side', () => {
    const { placed } = layoutDay([ev('a', [10, 0], [11, 0]), ev('b', [10, 30], [12, 0])], 3);
    expect(byId(placed)).toEqual({ a: [0, 2], b: [1, 2] });
  });

  it('reuses a lane once its visit has ended, within a chained cluster', () => {
    // a overlaps b, b overlaps c, but a has ended before c starts.
    const { placed } = layoutDay(
      [ev('a', [9, 0], [10, 30]), ev('b', [10, 0], [11, 0]), ev('c', [10, 45], [12, 0])],
      3
    );
    expect(byId(placed)).toEqual({ a: [0, 2], b: [1, 2], c: [0, 2] });
  });

  it('does not squeeze a visit that only shares the day with a busy slot', () => {
    const { placed } = layoutDay(
      [ev('early', [8, 0], [9, 0]), ev('a', [10, 0], [11, 0]), ev('b', [10, 0], [11, 0])],
      3
    );
    expect(byId(placed).early).toEqual([0, 1]);
  });

  it('folds lanes past the cap into a "+N more" chip on the last visible lane', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ev(id, [10, 0], [11, i * 10]));
    const { placed, overflow } = layoutDay(five, 3);
    // Longest first at a shared start: e, d take lanes 0 and 1.
    expect(placed.map((p) => p.id).sort()).toEqual(['d', 'e']);
    expect(placed.every((p) => p.lanes === 3 && p.lane < 2)).toBe(true);
    expect(overflow).toHaveLength(1);
    expect(overflow[0]).toMatchObject({ lane: 2, lanes: 3 });
    expect(overflow[0].ids.sort()).toEqual(['a', 'b', 'c']);
    expect(overflow[0].start).toEqual(t(10, 0));
    expect(overflow[0].end).toEqual(t(11, 20));
  });

  it('shows more before folding when given more lanes, as Day view is', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((id) => ev(id, [10, 0], [11, 0]));
    const { placed, overflow } = layoutDay(five, 6);
    expect(placed).toHaveLength(5);
    expect(overflow).toEqual([]);
  });

  it('never loses an event: placed plus folded is everything', () => {
    const many = Array.from({ length: 9 }, (_, i) => ev(`e${i}`, [9 + (i % 3), 0], [11, 0]));
    const { placed, overflow } = layoutDay(many, 3);
    const seen = [...placed.map((p) => p.id), ...overflow.flatMap((o) => o.ids)].sort();
    expect(seen).toEqual(many.map((e) => e.id).sort());
  });
});

describe('eventEnd', () => {
  it('assumes an hour when no end was recorded', () => {
    expect(eventEnd(t(10, 0), null)).toEqual(t(11, 0));
    expect(eventEnd(t(10, 0), t(9, 0))).toEqual(t(11, 0));
    expect(eventEnd(t(10, 0), t(12, 30))).toEqual(t(12, 30));
  });
});

describe('hourRange', () => {
  it('defaults to 8 a.m. – 6 p.m.', () => {
    expect(hourRange([])).toEqual([8, 18]);
  });

  it('stretches to fit an early or late visit', () => {
    expect(hourRange([ev('a', [7, 30], [8, 30]), ev('b', [18, 0], [19, 15])])).toEqual([7, 20]);
  });

  it('ends exactly on the hour when a visit does', () => {
    expect(hourRange([ev('a', [18, 0], [19, 0])])).toEqual([8, 19]);
  });
});

describe('weeks and months', () => {
  it('starts weeks on Monday, including from a Sunday', () => {
    expect(startOfWeek(new Date(2026, 9, 6))).toEqual(new Date(2026, 9, 5));
    expect(startOfWeek(new Date(2026, 9, 11))).toEqual(new Date(2026, 9, 5));
    expect(weekDays(new Date(2026, 9, 6)).map((d) => d.getDate())).toEqual([5, 6, 7, 8, 9, 10, 11]);
  });

  it('builds a six-week month grid starting the Monday on or before the 1st', () => {
    const grid = monthGrid(new Date(2026, 9, 20)); // Oct 2026; the 1st is a Thursday
    expect(grid).toHaveLength(42);
    expect(grid[0]).toEqual(new Date(2026, 8, 28));
    expect(grid[3]).toEqual(new Date(2026, 9, 1));
  });
});
