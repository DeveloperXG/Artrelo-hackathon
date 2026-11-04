import { describe, expect, it } from 'vitest';
import { getVendorContactActionState } from './vendorContactAction';

describe('getVendorContactActionState', () => {
  it('does not treat a vendor who declined as the approved contact', () => {
    // Retiring a vendor keeps its old contactApproval. Read as "approved", it
    // hid Reject for good once any vendor had ever been approved.
    const state = getVendorContactActionState({
      candidateLedger: [
        { candidateKey: 'reads', name: 'Reads', state: 'excluded', contactApproval: { status: 'approved' } },
      ],
      recommendations: [],
    });
    expect(state.kind).toBe('none');
  });

  it('still reports a vendor who is approved and in play', () => {
    const state = getVendorContactActionState({
      candidateLedger: [
        { candidateKey: 'next', name: 'Next', state: 'approved_for_contact', contactApproval: { status: 'approved' } },
      ],
    });
    expect(state.kind).toBe('approved');
  });
});
