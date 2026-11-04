// The Wallet's one line about Artrelo's service fee.
//
// The server (buildServiceFeeLine in backend/services/ledger/serviceFee.js)
// decides which case applies and words the rate with describeFee, the same
// wording the founding offer and the emails use. This only joins them into a
// sentence, so the line can never name a rate other than the one charged.

export type ServiceFeeLine = {
  kind: 'waived' | 'founding' | 'list';
  /** What would be charged (after the beta, when waived). Null: not set yet. */
  rate: { description: string } | null;
  waivedUntil: string | null;
  founding: boolean;
  /** The rate is a founding rate, not the list rate. */
  foundingRate: boolean;
  locked: boolean;
};

const fullDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * The service-fee sentence for this landlord. The server decides which case
 * applies and the rate's wording (describeFee); this only joins them up.
 */
export function serviceFeeText(line: ServiceFeeLine): string {
  const rate = line.rate?.description;
  if (line.kind === 'waived') {
    const until = line.waivedUntil ? fullDate(line.waivedUntil) : null;
    if (rate) {
      const after = `${rate}${line.foundingRate ? ' (your founding rate)' : ''}`;
      return until ? `Service fee: waived until ${until}. After that, ${after}.` : `Service fee: waived during your beta. After that, ${after}.`;
    }
    if (line.founding) {
      return `Service fee: waived${until ? ` until ${until}` : ' during your beta'}. Your founding rate will be confirmed before then.`;
    }
    return until ? `Service fee: waived during your beta (ends ${until}).` : 'Service fee: waived during your beta.';
  }
  if (line.kind === 'founding') return `Founding service fee: ${rate}${line.locked ? ' · locked in' : ''}`;
  return `Service fee: ${rate}`;
}
