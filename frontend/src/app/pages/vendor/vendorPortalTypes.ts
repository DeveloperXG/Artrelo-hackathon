/** Shapes returned by the public vendor portal endpoints.
 *
 *  `revealed` is present ONLY once the vendor has accepted — the server omits
 *  it entirely beforehand, so there is no client-side gating to get wrong.
 *  See backend/services/vendor/vendorBrief.service.js. */

import type { Itemization } from '../../lib/itemization';

export interface OfferedWindow {
  slotId: string;
  label: string;
  start?: string | null;
  end?: string | null;
  kind?: 'asap' | 'window' | 'flexible';
  /** The zone the window and its label were built in (the property's). */
  timeZone?: string | null;
}

export interface VendorBriefPhoto {
  url: string;
  type: 'image' | 'video';
  label?: string | null;
}

export interface VendorBrief {
  jobReference: string;
  category: string;
  trade?: string | null;
  shortTitle: string;
  summary: string;
  impact?: string;
  timeline?: { started?: string; trend?: string };
  urgencyLabel: string;
  tier: 'emergency' | 'urgent' | 'normal' | 'low';
  tierLabel: string;
  riskType?: string | null;
  safetyRisk?: boolean;
  city: string;
  accessConstraints: string[];
  /** The tenant's timing preference, AI-normalised ("weekday mornings"). */
  preferredTimes?: string[];
  photos: VendorBriefPhoto[];
  photoCount: number;
  manager: { name: string; company?: string | null };
  messageBody: string;
  offeredWindows: OfferedWindow[];
  responseDeadlineAt?: string | null;
  quoteCurrency: string;
  /** 2 only on outreach opened under the itemized quote contract. The accept
   *  form then asks for line items instead of a low/high pair. */
  quoteContractVersion?: 2;
}

/**
 * Masked contact. The tenant's real number is never sent to a vendor, so there
 * is no `phone` here until the relay rail is live — and `phone` is the PROXY
 * number when it is, never the tenant's own.
 */
export interface VendorRelayContact {
  channel: 'relay' | 'direct';
  provider: string;
  phone?: string | null;
  extension?: string | null;
  available: boolean;
  label: string;
  fallback?: { kind: string; phone?: string | null } | null;
}

export interface VendorRevealedDetails {
  property: { name: string; address: string; unitNumber: string };
  tenant: { displayName: string; contact: VendorRelayContact };
  access: {
    permissionToEnter?: boolean | null;
    pets?: boolean | null;
    preferredTimes: string[];
    entryNotes?: string;
  };
  manager: { name: string; company?: string | null; phone?: string | null; email?: string | null };
  confirmedWindow?: OfferedWindow | null;
  /** The precise commitment the tenant confirms, not the broad window. */
  scheduledArrivalAt?: string | null;
  durationMinutes?: number | null;
  quote: { low?: number | null; high?: number | null; currency: string };
  nextSteps: string;
}

/** The price-confirmation round. Present only once a manager has authorized an
 *  amount BELOW what the vendor quoted; authorizing at or above their quote just
 *  books the job and this block never appears. `amount` is the only figure from
 *  the manager's authorization the vendor is ever shown. */
export interface VendorCounterOffer {
  status: 'pending' | 'confirmed' | 'declined' | 'expired' | 'withdrawn';
  amount: number | null;
  currency: string;
  deadlineAt?: string | null;
  note?: string | null;
  respondedAt?: string | null;
  declineReason?: string | null;
  originalQuote?: { low?: number | null; high?: number | null };
}

export interface VendorPortalPayload {
  negotiatedProposal?: { amount: number; start: string; durationMinutes: number; note: string } | null;
  brief: VendorBrief;
  status: string;
  alreadyResponded: boolean;
  /** Null whenever no round is running. There is no tsconfig in this app, so
   *  treat every field as possibly-undefined at runtime regardless of this type. */
  counterOffer?: VendorCounterOffer | null;
  decision?: 'accepted' | 'declined' | null;
  respondedAt?: string | null;
  quote?: {
    low?: number | null;
    high?: number | null;
    currency: string;
    notes?: string | null;
    /** Itemized outreach: the current stored revision, immutable once sent. */
    revision?: number | null;
    itemization?: Itemization | null;
  } | null;
  scheduledArrivalAt?: string | null;
  durationMinutes?: number | null;
  declineReason?: string | null;
  revealed?: VendorRevealedDetails;
}
