export type BookingPhase = 'preparing' | 'awaiting_approval' | 'awaiting_funds' | 'awaiting_vendor'
  | 'awaiting_tenant' | 'scheduled' | 'paused' | 'expired' | 'closed';
export type TimeWindow = { start: string; end: string };
export type BookingState = {
  phase: BookingPhase; revision: number; rounds: number; deadlineAt: string;
  arrivalAt?: string | null; durationMinutes?: number | null;
  proposedBy?: 'tenant' | 'vendor' | 'landlord' | null; proposals: TimeWindow[];
  /** These three fields are present only in the landlord projection. */
  amount?: number | null; shortfall?: number; reasonCode?: string | null;
  capabilities?: BookingCapabilities;
};
export type BookingPayload = { coordination: BookingState | null; vendorName: string; vendorId?: string | null;
  history?: import('../components/NegotiatedReturnPanel').ClosedOffer[];
  deliveryIssues?: { ref: string; audience: string; status: string }[];
  reschedules?: RescheduleView[]; receipt?: RescheduleReceipt };
/** The vendor projection; the scheduling-purpose token decides the vendor. */
export type VendorBookingPayload = { coordination: BookingState | null;
  /** Present on GET; a change POST omits it. */
  brief: { shortTitle: string; summary: string };
  reschedules?: RescheduleView[]; receipt?: RescheduleReceipt };
/** Authoritative booking state from the server. Actual request, appointment and
 * completion records beat the retained preparation phase, so controls come from
 * these flags only. */
export type BookingCapabilityState = 'unavailable' | 'closed' | 'unbooked' | 'confirmed' | 'confirmation_unknown'
  | 'awaiting_confirmation' | 'completion_submitted' | 'work_started';
export type BookingCapabilities = { state: BookingCapabilityState; reasonCode: string | null;
  canConfirmInitial: boolean; canSuggestInitialAlternatives: boolean; canProposeInitialTime: boolean;
  canRequestReschedule: boolean; requiresRescheduleReason: boolean };
export type RescheduleStatus = 'awaiting_vendor' | 'awaiting_tenant' | 'ready_to_commit' | 'committed'
  | 'declined' | 'expired' | 'conflict' | 'invalidated';
export type PartyResponse = 'pending' | 'accepted' | 'declined';
export type RescheduleActor = 'landlord' | 'tenant' | 'vendor' | 'system';
export type RescheduleEvent = { type: string; revision: number; actor: RescheduleActor; at: string; reason?: string;
  original?: TimeWindow | null; proposed?: TimeWindow | null; vendorResponse?: PartyResponse; tenantResponse?: PartyResponse;
  /** Present when the server moved the answer deadline (never later). */
  deadlineAt?: string; previousDeadlineAt?: string; responseBufferMinutes?: number };
export type RescheduleDelivery = { audience: 'landlord' | 'tenant' | 'vendor'; status: string; inAppRecorded: boolean };
export type RescheduleView = { ref: string; revision: number; status: RescheduleStatus; active: boolean; reason: string;
  original: TimeWindow; proposed: TimeWindow | null; outsideSuggestedWindows: boolean;
  /** Exact candidate digest. Submitted with a tenant response, never displayed. */
  slotKey: string | null; windows: TimeWindow[]; expiresAt: string;
  vendorResponse: PartyResponse; tenantResponse: PartyResponse;
  canVendorConfirm: boolean; canTenantRespond: boolean; canDecline: boolean;
  delivery: RescheduleDelivery[]; events: RescheduleEvent[] };
export type RescheduleReceipt = { proposalRef: string; revision: number; status: RescheduleStatus; duplicate: boolean };
export type AvailabilityPreview = { source: 'local_rules' | 'development_stub'; timeZone: string | null; asOf: string;
  windows: TimeWindow[]; needsClarification: boolean; question: string | null; modelStatus?: 'unavailable'; explanation?: string };
export type BusyTime = TimeWindow & { ref: string; note: string };
