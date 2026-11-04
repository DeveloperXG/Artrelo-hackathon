import { describe, expect, it } from 'vitest';
import { serviceFeeText, type ServiceFeeLine } from './serviceFeeText';

const ENDS = '2026-10-30T12:00:00.000Z';
// The date is formatted in the reader's locale; build the expectation the same way.
const ends = new Date(ENDS).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

const base: ServiceFeeLine = {
  kind: 'list',
  rate: { description: '$5.00 per completed job' },
  waivedUntil: null,
  founding: false,
  foundingRate: false,
  locked: false,
};

describe('serviceFeeText', () => {
  it('in the beta: waived until the end date, then the rate', () => {
    expect(serviceFeeText({ ...base, kind: 'waived', waivedUntil: ENDS })).toBe(
      `Service fee: waived until ${ends}. After that, $5.00 per completed job.`
    );
  });

  it('marks a founding rate as theirs', () => {
    const line = {
      ...base,
      kind: 'waived' as const,
      waivedUntil: ENDS,
      founding: true,
      foundingRate: true,
      rate: { description: '$4.00 per completed job' },
    };
    expect(serviceFeeText(line)).toBe(`Service fee: waived until ${ends}. After that, $4.00 per completed job (your founding rate).`);
  });

  it('a founding landlord with no founding rate yet is told it will be confirmed, not quoted the list rate', () => {
    const text = serviceFeeText({ ...base, kind: 'waived', waivedUntil: ENDS, founding: true, rate: null });
    expect(text).toBe(`Service fee: waived until ${ends}. Your founding rate will be confirmed before then.`);
    expect(text).not.toContain('$');
  });

  it('no fee configured during the beta: just the waiver', () => {
    expect(serviceFeeText({ ...base, kind: 'waived', waivedUntil: ENDS, rate: null })).toBe(
      `Service fee: waived during your beta (ends ${ends}).`
    );
  });

  it('founding, after the beta: locked or not', () => {
    const founding = { ...base, kind: 'founding' as const, founding: true, foundingRate: true };
    expect(serviceFeeText({ ...founding, locked: true })).toBe('Founding service fee: $5.00 per completed job · locked in');
    expect(serviceFeeText(founding)).toBe('Founding service fee: $5.00 per completed job');
  });

  it('everyone else: the list fee', () => {
    expect(serviceFeeText(base)).toBe('Service fee: $5.00 per completed job');
  });
});
