import type { ApiEnvelope } from '../api/client';
import type { SimilarRequest } from '../types/requestWorkflow';

export type TriageResult = {
  summary: string;
  shortTitle?: string;
  additionalNotes?: string;
  /** Legacy: an older server still sends it (and prepends it to the reply).
   *  It is never rendered; see stripAcknowledgment. */
  acknowledgment?: string | null;
  category: string;
  urgency: string;
  severity?: number;
  suggestedResponsibility?: string;
  suggestedVendorType?: string | null;
  followUpQuestions?: string[];
  safetyWarning?: string;
  emergencyServicesRecommended?: boolean;
  readyToSubmit?: boolean;
  intakeStatus?: 'needs_more_info' | 'ready_to_submit';
  missingFields?: string[];
  confidence?: 'low' | 'medium' | 'high';
  source?: string;
  access?: { permissionToEnter: boolean | null; pets: boolean | null; preferredTimes: string[] };
  intakeState?: {
    version: number;
    askedIds: string[];
    answers: { topicId: string; state: 'answered' | 'unknown' | 'declined' }[];
    selectedQuestion: { id: string; topicId: string; question: string } | null;
    followUpCount: number;
    needsManagerReview: boolean;
  };
};

type TriageMetadata = {
  tenantResponse?: {
    nextAction: 'ask_follow_up' | 'submit_request' | 'emergency_guidance' | 'needs_more_info' | 'issue_resolved';
    message: string;
  };
  workflow?: {
    actionType: 'ask_follow_up' | 'submit_request' | 'emergency_guidance' | 'resolved_closed';
    shouldCreateTicket: boolean;
    shouldSearchVendor: boolean;
    shouldEscalateEmergency: boolean;
    vendorCategory: string | null;
  };
  triageReceipt?: string | null;
  /** At most three of the tenant's open requests that may be the same issue. */
  similarRequests?: SimilarRequest[];
};

// The API keeps `data` as the triage itself and metadata as siblings. Older
// clients/fixtures also use data: { triage, tenantResponse, workflow }.
export function adaptTriageResponse(response: ApiEnvelope<unknown>) {
  const envelope = response as ApiEnvelope<unknown> & TriageMetadata;
  const data = response.data as (TriageResult & Partial<{ triage: TriageResult }> & TriageMetadata) | undefined;
  const triage = data?.triage || data;
  if (!triage || typeof triage.summary !== 'string' || typeof triage.category !== 'string') {
    throw new Error('The triage response was incomplete. Please send your details again.');
  }
  return {
    triage,
    tenantResponse: envelope.tenantResponse ?? data?.tenantResponse,
    workflow: envelope.workflow ?? data?.workflow,
    triageReceipt: envelope.triageReceipt ?? data?.triageReceipt ?? null,
    // Undefined (not []) when the server said nothing, so the page keeps the
    // suggestions it already shows.
    similarRequests: envelope.similarRequests ?? data?.similarRequests,
  };
}
