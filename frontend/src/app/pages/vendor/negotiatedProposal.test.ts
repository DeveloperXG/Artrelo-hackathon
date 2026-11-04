import { describe, expect, it } from 'vitest';
import { emptyLine, type DraftLine } from '../../lib/itemization';
import { buildNegotiatedAccept } from './negotiatedProposal';

const proposal = { amount: 240, start: '2026-10-30T15:00:00.000Z', durationMinutes: 90 };
const line = (patch: Partial<DraftLine>): DraftLine => ({ ...emptyLine(), ...patch });

describe('accepting a negotiated proposal', () => {
  it('legacy outreach keeps sending the agreed amount as low = high, unchanged', () => {
    const result = buildNegotiatedAccept(proposal, false, [emptyLine()]);
    expect(result).toEqual({
      ok: true,
      body: { outcome: 'accepted', selectedSlotId: 'negotiated', quoteLow: 240, quoteHigh: 240, scheduledArrivalAt: proposal.start, durationMinutes: 90 },
    });
  });

  it('v2 with no itemization is refused before anything is sent (no breakdown is invented)', () => {
    const result = buildNegotiatedAccept(proposal, true, [emptyLine()]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.lineErrors)).toHaveLength(1);
  });

  it('v2 lines that do not add up to the agreed amount are refused, to the cent', () => {
    const lines = [
      line({ description: 'Labour', category: 'labour', amount: '200' }),
      line({ description: 'Parts', category: 'materials', amount: '39.99' }),
    ];
    const result = buildNegotiatedAccept(proposal, true, lines);
    expect(result).toMatchObject({ ok: false, message: 'Your lines add up to $239.99. They must add up to the agreed $240.00 exactly.' });
  });

  it('v2 exact itemization sends itemization + expectedRevision 0 + contract 2 with the proposed time, and no legacy totals', () => {
    const lines = [
      line({ description: 'Labour', category: 'labour', amount: '200' }),
      line({ description: 'Parts', category: 'materials', amount: '40.00' }),
    ];
    const result = buildNegotiatedAccept(proposal, true, lines);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toMatchObject({
      outcome: 'accepted',
      selectedSlotId: 'negotiated',
      scheduledArrivalAt: proposal.start,
      durationMinutes: 90,
      expectedRevision: 0,
      quoteContractVersion: 2,
    });
    expect(result.body).not.toHaveProperty('quoteLow');
    expect(result.body).not.toHaveProperty('quoteHigh');
    const { itemization } = result.body as { itemization: { pricingMode: string; totals: unknown; items: Array<Record<string, unknown>> } };
    expect(itemization.pricingMode).toBe('fixed');
    expect(itemization.totals).toEqual({ lowMinor: 24000, highMinor: 24000 });
    expect(itemization.items.map((item) => item.amountMinor)).toEqual([20000, 4000]);
    expect(itemization.items.every((item) => !('lineId' in item))).toBe(true);
  });
});
