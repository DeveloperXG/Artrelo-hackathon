// The itemized final statement on the vendor's job page (quote contract v2).
//
// Always exact amounts: a final statement is what was charged, not a range.
// actualCost is still sent for the existing completion flow (overage gate,
// ledger), and the server refuses it unless it equals the lines' total to the
// cent -- so it is derived from that total here, never typed separately.

import {
  MAX_INVOICE_REFERENCE,
  buildItemization,
  minorToDollars,
  type DraftLine,
  type ItemizationInput,
  type LineErrors,
} from '../../lib/itemization';

export type FinalStatementCheck =
  | {
      ok: true;
      fields: {
        itemization: ItemizationInput;
        expectedRevision: 0;
        quoteContractVersion: 2;
        actualCost: number;
        invoiceReference?: string;
      };
    }
  | { ok: false; lineErrors: Record<string, LineErrors>; message: string; referenceError?: string };

export function buildFinalStatement(lines: DraftLine[], invoiceReference: string): FinalStatementCheck {
  const built = buildItemization('fixed', lines);
  const reference = invoiceReference.trim();
  const referenceError =
    reference.length > MAX_INVOICE_REFERENCE ? `Keep the invoice reference under ${MAX_INVOICE_REFERENCE} characters.` : undefined;
  if (!built.ok) return { ok: false, lineErrors: built.lineErrors, message: built.message, referenceError };
  if (referenceError) return { ok: false, lineErrors: {}, message: referenceError, referenceError };
  return {
    ok: true,
    fields: {
      itemization: built.itemization,
      expectedRevision: 0,
      quoteContractVersion: 2,
      actualCost: minorToDollars(built.itemization.totals.highMinor),
      ...(reference ? { invoiceReference: reference } : {}),
    },
  };
}
