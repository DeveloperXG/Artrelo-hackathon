// Accepting a negotiated proposal on the vendor response page.
//
// Legacy outreach confirms the agreed amount as quoteLow = quoteHigh. Quote
// contract v2 refuses legacy totals, so there the vendor itemizes the agreed
// amount: exact lines whose total must equal it to the cent. The breakdown is
// always the vendor's own -- nothing is pre-filled or invented here -- and the
// time and duration are sent exactly as proposed (the server refuses any
// change to price or time).

import { buildItemization, dollarsToMinor, formatCAD, type DraftLine, type ItemizationInput, type LineErrors } from '../../lib/itemization';

export interface NegotiatedProposal {
  amount: number;
  start: string;
  durationMinutes: number;
}

type Common = { outcome: 'accepted'; selectedSlotId: 'negotiated'; scheduledArrivalAt: string; durationMinutes: number };
export type NegotiatedAcceptBody =
  | (Common & { quoteLow: number; quoteHigh: number })
  | (Common & { itemization: ItemizationInput; expectedRevision: 0; quoteContractVersion: 2 });

export type NegotiatedAcceptCheck =
  | { ok: true; body: NegotiatedAcceptBody }
  | { ok: false; lineErrors: Record<string, LineErrors>; message: string };

export function buildNegotiatedAccept(
  proposal: NegotiatedProposal,
  itemized: boolean,
  lines: DraftLine[]
): NegotiatedAcceptCheck {
  const common: Common = {
    outcome: 'accepted',
    selectedSlotId: 'negotiated',
    scheduledArrivalAt: proposal.start,
    durationMinutes: proposal.durationMinutes,
  };
  if (!itemized) return { ok: true, body: { ...common, quoteLow: proposal.amount, quoteHigh: proposal.amount } };

  const agreedMinor = dollarsToMinor(proposal.amount);
  if (agreedMinor === null) return { ok: false, lineErrors: {}, message: 'The agreed amount could not be read. Decline and ask for a new proposal.' };
  const built = buildItemization('fixed', lines);
  if (!built.ok) return { ok: false, lineErrors: built.lineErrors, message: built.message };
  const total = built.itemization.totals.highMinor;
  if (total !== agreedMinor) {
    return {
      ok: false,
      lineErrors: {},
      message: `Your lines add up to ${formatCAD(total)}. They must add up to the agreed ${formatCAD(agreedMinor)} exactly.`,
    };
  }
  return { ok: true, body: { ...common, itemization: built.itemization, expectedRevision: 0, quoteContractVersion: 2 } };
}
