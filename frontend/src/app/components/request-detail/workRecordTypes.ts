import type { Itemization } from '../../lib/itemization';

export interface PresenceStamp {
  source: string; at: string | null; lat: number | null; lng: number | null;
  accuracyMeters: number | null; distanceMeters: number | null; verdict: string | null;
}
export interface WorkVisit {
  id: string; status: string; vendorName: string; vendorId?: string | null; scheduledStart: string | null; scheduledEnd: string | null;
  createdAt: string | null; completedAt: string | null; failureReason: string | null;
  noShow: { status: string; reportedAt: string | null; note: string | null; resolvedAt: string | null } | null;
  payment: { mode: 'direct' | 'platform'; status: string; amountCents: number | null; paidAt: string | null;
    payouts: { id: string; amountCents: number; status: string; clearsOn: string | null }[] };
  report: {
    id: string; status: string; source: string; submittedAt: string | null; completedAt: string | null;
    workPerformed: string; partsUsed: string; followUpNeeded: boolean; followUpNotes: string;
    reportedCost: number | null; finalCost: number | null; currency: string; approvedCeiling: number | null; approvedOverage: number | null;
    /** Itemized jobs (quote contract v2) only: the immutable final statement,
     *  the agreed quote it is measured against, and the invoice review state. */
    itemization?: Itemization | null; originalQuote?: Itemization | null; invoiceReference?: string | null; invoiceReviewState?: string;
    closedAt: string | null; closeReason: string | null; needsReview: boolean; checkIn: PresenceStamp | null; checkOut: PresenceStamp | null;
    evidenceVerdict: string; evidenceReasons: string[]; evidenceReviewedAt: string | null;
    photos: { url: string; type: string; stage: string; label: string | null; receivedAt: string | null; exifTakenAt: string | null }[];
    confirmation: { outcome: string; rating: number | null; comment: string | null; respondedAt: string; autoConfirmed: boolean } | null;
  } | null;
}
export interface WorkRecord {
  requestId: string; status: string; archivedAt: string | null; finalCost: number | null; visits: WorkVisit[];
}
