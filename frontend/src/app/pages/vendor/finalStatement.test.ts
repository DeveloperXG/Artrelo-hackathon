import { describe, expect, it } from 'vitest';
import { buildFinalStatement } from './finalStatement';
import { emptyLine, type DraftLine } from '../../lib/itemization';

const line = (patch: Partial<DraftLine>): DraftLine => ({ ...emptyLine(), ...patch });

describe('itemized final statement', () => {
  it('sends a fixed itemization with the contract fields and an actualCost equal to its total', () => {
    const result = buildFinalStatement(
      [line({ description: 'Labour 2h', category: 'labour', amount: '180' }), line({ description: 'Valve', category: 'materials', amount: '42.37' })],
      ' INV-1042 '
    );
    expect(result).toEqual({
      ok: true,
      fields: {
        itemization: {
          pricingMode: 'fixed',
          currency: 'CAD',
          items: [
            { description: 'Labour 2h', category: 'labour', amountMinor: 18000 },
            { description: 'Valve', category: 'materials', amountMinor: 4237 },
          ],
          totals: { lowMinor: 22237, highMinor: 22237 },
        },
        expectedRevision: 0,
        quoteContractVersion: 2,
        actualCost: 222.37,
        invoiceReference: 'INV-1042',
      },
    });
  });

  it('omits an empty invoice reference and refuses one over 120 characters', () => {
    const lines = [line({ description: 'Labour', category: 'labour', amount: '10' })];
    const ok = buildFinalStatement(lines, '   ');
    expect(ok.ok && 'invoiceReference' in ok.fields).toBe(false);
    const long = buildFinalStatement(lines, 'x'.repeat(121));
    expect(long).toMatchObject({ ok: false, referenceError: expect.stringContaining('120') });
  });

  it('never accepts a range or a missing amount for final charges', () => {
    const a = line({ description: 'Labour', category: 'labour', low: '10', high: '20' });
    const result = buildFinalStatement([a], '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.lineErrors[a.key].amount).toBeTruthy();
  });
});
