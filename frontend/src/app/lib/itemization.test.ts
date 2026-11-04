import { describe, expect, it } from 'vitest';
import {
  MAX_ITEMS,
  MAX_MINOR,
  addLine,
  buildItemization,
  dollarsToMinor,
  draftTotals,
  emptyLine,
  formatCAD,
  formatSignedCAD,
  formatTotals,
  lineErrorFromServer,
  linesFromItemization,
  minorToDollars,
  minorToInput,
  parseMinor,
  quoteDeltas,
  removeLine,
  type DraftLine,
} from './itemization';

const line = (patch: Partial<DraftLine>): DraftLine => ({ ...emptyLine(), ...patch });

// The server's dollarToMinor, verbatim in behaviour, so the projection we send
// (actualCost = total / 100) is checked against the rule that will judge it.
function serverDollarToMinor(value: number) {
  if (!Number.isFinite(value) || value < 0) throw new Error('invalid_money');
  if (Number(value.toFixed(2)) !== value) throw new Error('invalid_money');
  return Math.round(value * 100);
}

describe('parseMinor: typed dollars to integer cents, never through a float', () => {
  it.each([
    ['120', 12000],
    ['120.5', 12050],
    ['120.50', 12050],
    ['0.10', 10],
    ['0.01', 1],
    ['0', 0],
    ['$1,200.50', 120050],
    ['  19.99 ', 1999],
    ['1000000', MAX_MINOR],
  ])('%s -> %i', (input, expected) => {
    expect(parseMinor(input)).toBe(expected);
  });

  it.each(['', '-1', '1.005', '1e3', 'abc', '12.', '.5', '1000000.01', '99999999', '1,20'])('refuses %j rather than rounding', (input) => {
    expect(parseMinor(input)).toBeNull();
  });

  it('sums cents exactly where floats would drift', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    const totals = draftTotals('fixed', [line({ amount: '0.10' }), line({ amount: '0.20' })]);
    expect(totals).toEqual({ lowMinor: 30, highMinor: 30, complete: true });
  });
});

describe('add and remove lines', () => {
  it('adds up to 50 lines and keeps the last line', () => {
    let lines = [emptyLine()];
    for (let i = 0; i < 60; i += 1) lines = addLine(lines);
    expect(lines).toHaveLength(MAX_ITEMS);
    expect(new Set(lines.map((row) => row.key)).size).toBe(MAX_ITEMS);
    const one = [emptyLine()];
    expect(removeLine(one, one[0].key)).toBe(one);
  });

  it('recomputes the exact total after a removal', () => {
    const a = line({ amount: '100.25' });
    const b = line({ amount: '49.75' });
    const c = line({ amount: '0.01' });
    expect(draftTotals('fixed', [a, b, c]).highMinor).toBe(15001);
    expect(draftTotals('fixed', removeLine([a, b, c], b.key)).highMinor).toBe(10026);
  });

  it('ranges total both ends, and an unreadable line marks the total incomplete', () => {
    const totals = draftTotals('range', [line({ low: '100', high: '150.50' }), line({ low: '20', high: '' })]);
    expect(totals).toEqual({ lowMinor: 10000, highMinor: 15050, complete: false });
  });
});

describe('buildItemization: the exact v2 body', () => {
  it('builds a fixed itemization with integer cents and server-owned totals', () => {
    const result = buildItemization('fixed', [
      line({ description: ' Replace cartridge ', category: 'labour', amount: '120' }),
      line({ description: 'Cartridge', category: 'materials', amount: '35.99' }),
    ]);
    expect(result).toEqual({
      ok: true,
      itemization: {
        pricingMode: 'fixed',
        currency: 'CAD',
        items: [
          { description: 'Replace cartridge', category: 'labour', amountMinor: 12000 },
          { description: 'Cartridge', category: 'materials', amountMinor: 3599 },
        ],
        totals: { lowMinor: 15599, highMinor: 15599 },
      },
    });
  });

  it('builds a range itemization; new lines carry no lineId', () => {
    const result = buildItemization('range', [line({ description: 'Diagnose', category: 'callout', low: '80', high: '120' })]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.itemization.items[0]).toEqual({ description: 'Diagnose', category: 'callout', lowMinor: 8000, highMinor: 12000 });
    expect('lineId' in result.itemization.items[0]).toBe(false);
    expect(result.itemization.totals).toEqual({ lowMinor: 8000, highMinor: 12000 });
  });

  it('keeps an owned lineId on an existing line (clarification revision)', () => {
    const result = buildItemization('fixed', [
      line({ lineId: 'srv-1', description: 'Labour', category: 'labour', amount: '10' }),
      line({ description: 'New part', category: 'materials', amount: '5' }),
    ]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.itemization.items.map((item) => item.lineId)).toEqual(['srv-1', undefined]);
  });

  it('reports every missing required input at once, per line', () => {
    const a = line({});
    const b = line({ description: 'x'.repeat(241), category: 'tax', amount: '1.005' });
    const result = buildItemization('fixed', [a, b]);
    if (result.ok) throw new Error('expected errors');
    expect(result.lineErrors[a.key]).toEqual({
      description: 'Describe this line.',
      category: 'Choose a category.',
      amount: expect.stringContaining('dollars and cents'),
    });
    expect(Object.keys(result.lineErrors[b.key])).toEqual(['description', 'amount']);
  });

  it('refuses an inverted range on the line, not the total', () => {
    const a = line({ description: 'Work', category: 'labour', low: '200', high: '100' });
    const result = buildItemization('range', [a]);
    if (result.ok) throw new Error('expected errors');
    expect(result.lineErrors[a.key].high).toMatch(/at least the low/);
  });

  it('refuses a total above the per-job limit', () => {
    const lines = [line({ description: 'A', category: 'labour', amount: '1000000' }), line({ description: 'B', category: 'labour', amount: '0.01' })];
    const result = buildItemization('fixed', lines);
    expect(result.ok).toBe(false);
  });

  it('accepts zero as a real price', () => {
    const result = buildItemization('fixed', [line({ description: 'Warranty', category: 'other', amount: '0' })]);
    expect(result.ok && result.itemization.totals).toEqual({ lowMinor: 0, highMinor: 0 });
  });
});

describe('legacy projections round-trip exactly through the server rule', () => {
  it('total / 100 is accepted by dollarToMinor for every cent value sampled', () => {
    const samples = [0, 1, 7, 10, 99, 101, 1999, 12345, 15599, 99999, 1000001, 33333333, 99999999, MAX_MINOR];
    for (let i = 0; i < 2000; i += 1) samples.push((i * 7919) % 100000 + i * 1000);
    for (const minor of samples) expect(serverDollarToMinor(minorToDollars(minor))).toBe(minor);
  });

  it('dollarsToMinor reads stored whole-cent dollars and refuses fractional cents', () => {
    expect(dollarsToMinor(240.5)).toBe(24050);
    expect(dollarsToMinor(0)).toBe(0);
    expect(dollarsToMinor(1.005)).toBeNull();
    expect(dollarsToMinor(null)).toBeNull();
    expect(dollarsToMinor(-1)).toBeNull();
  });
});

describe('display', () => {
  it('formats CAD from integers', () => {
    expect(formatCAD(120050)).toBe('$1,200.50');
    expect(formatCAD(5)).toBe('$0.05');
    expect(formatSignedCAD(-2500)).toBe('−$25.00');
    expect(formatSignedCAD(2500)).toBe('+$25.00');
    expect(formatTotals({ pricingMode: 'range', totals: { lowMinor: 10000, highMinor: 15000 } })).toBe('$100.00–$150.00');
    expect(formatTotals({ pricingMode: 'fixed', totals: { lowMinor: 15000, highMinor: 15000 } })).toBe('$150.00');
    expect(minorToInput(12345)).toBe('123.45');
    expect(minorToInput(5)).toBe('0.05');
  });
});

describe('server field paths and stored lines', () => {
  it('maps items.N.field to the right line and input', () => {
    const lines = [emptyLine(), emptyLine()];
    expect(lineErrorFromServer('items.1.amountMinor', lines, 'fixed')).toEqual({ key: lines[1].key, field: 'amount' });
    expect(lineErrorFromServer('items.0.highMinor', lines, 'range')).toEqual({ key: lines[0].key, field: 'high' });
    expect(lineErrorFromServer('items.0', lines, 'range')).toEqual({ key: lines[0].key, field: 'high' });
    expect(lineErrorFromServer('totals', lines, 'fixed')).toBeNull();
    expect(lineErrorFromServer('items.9.amountMinor', lines, 'fixed')).toBeNull();
  });

  it('prefills editable lines from a stored itemization, keeping lineIds', () => {
    const lines = linesFromItemization({
      pricingMode: 'range',
      currency: 'CAD',
      items: [{ lineId: 'a1', description: 'Labour', category: 'labour', lowMinor: 1000, highMinor: 2050 }],
      totals: { lowMinor: 1000, highMinor: 2050 },
    });
    expect(lines[0]).toMatchObject({ lineId: 'a1', description: 'Labour', category: 'labour', low: '10.00', high: '20.50' });
  });
});

describe('quoteDeltas mirrors the server: no midpoint, null is unknown, zero is real', () => {
  it('compares a final amount with both ends of the estimate and the agreed amount', () => {
    expect(quoteDeltas({ originalLowMinor: 10000, originalHighMinor: 15000, agreedMinor: 14000, finalMinor: 16100 })).toEqual({
      originalEstimate: { lowMinor: 10000, highMinor: 15000 },
      agreedMinor: 14000,
      finalMinor: 16100,
      agreedVsEstimate: { versusLowMinor: 4000, versusHighMinor: -1000 },
      finalVsEstimate: { versusLowMinor: 6100, versusHighMinor: 1100 },
      finalVsAgreed: { amountMinor: 2100, percent: 15 },
    });
  });

  it('leaves unknown bases null rather than inventing one', () => {
    const deltas = quoteDeltas({ finalMinor: 5000 });
    expect(deltas.originalEstimate).toBeNull();
    expect(deltas.finalVsEstimate).toBeNull();
    expect(deltas.finalVsAgreed).toBeNull();
    expect(quoteDeltas({ agreedMinor: 0, finalMinor: 100 }).finalVsAgreed).toEqual({ amountMinor: 100, percent: null });
  });
});
