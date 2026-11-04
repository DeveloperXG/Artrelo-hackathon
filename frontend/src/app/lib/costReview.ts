// Iris cost review: the landlord's view of an itemized quote or final statement
// (GET /landlords/requests/:id/quote-reviews) and the existing Decisions that
// resolve it. Advisory analysis never approves a cost, and these labels are
// written so that nothing pending, unavailable or stale can read as approved.

import type { Itemization, QuoteSnapshot } from './itemization';

export type ReviewState = 'pending' | 'needs_review' | 'waiting_clarification' | 'cleared' | 'rejected';
export type AnalysisStatus = 'pending' | 'running' | 'ready' | 'unavailable' | 'stale';
export type AnalysisSource = 'disabled' | 'development_stub' | 'meta';
export type FlagCode = 'unclear' | 'possible_duplicate' | 'unsupported_basis' | 'scope_mismatch' | 'estimate_invoice_delta';

export interface AnalysisResult {
  schemaVersion: number;
  summary: string;
  flags: { code: FlagCode; lineIds: string[]; sourceRefs: string[]; explanation: string }[];
  questions: { code: FlagCode; lineIds: string[]; suggestedQuestion: string }[];
  reviewRecommendation: 'clarify' | 'landlord_review' | 'no_additional_flags';
}
export interface CostAnalysis {
  status: AnalysisStatus;
  source: AnalysisSource;
  simulated: boolean;
  result: AnalysisResult | null;
  errorCode: string | null;
  provider: string | null;
  model: string | null;
  durationMs: number | null;
}
export type ClarificationState = 'draft' | 'ready' | 'delivery_unknown' | 'answered' | 'expired' | 'failed';
export type ClarificationDelivery = 'disabled' | 'delivering' | 'sent' | 'development_preview' | 'failed' | 'unknown';
export interface ClarificationProjection {
  state: ClarificationState;
  delivery: ClarificationDelivery;
  questions: { id: string; code: string; lineIds: string[]; text: string }[];
  answers: { questionId: string; answer: string }[];
  expiresAt: string | null;
  quoteRevision: number;
  quoteHash: string;
}
export interface ReviewStatus {
  state: ReviewState;
  approvalId: string | null;
  resumePending: boolean;
  /** Absent on legacy rows means revision0. Eligibility remains server-owned. */
  revision?: number;
  reopen?: ScopeReviewReopenDescriptor | null;
}
export interface QuoteReviewRow {
  id: string;
  vendorName: string;
  /** Additive: lets the judge sandbox label the pair's simulated vendors. */
  vendorId?: string | null;
  status: string;
  revision: number | null;
  original: QuoteSnapshot | null;
  current: QuoteSnapshot | null;
  approved: QuoteSnapshot | null;
  review: ReviewStatus;
  analysis: CostAnalysis | null;
  clarification: ClarificationProjection | null;
}
export interface InvoiceReviewRow {
  id: string;
  status: string;
  finalStatement: QuoteSnapshot | null;
  invoiceReference: string | null;
  originalQuote: QuoteSnapshot | null;
  /** The booking amount (a cap), in dollars. Not the invoice. */
  agreedAmount: number | null;
  /** What the vendor invoiced, in dollars. */
  invoicedAmount: number | null;
  /** What was approved to pay, in dollars, once decided. Not the invoice. */
  approvedPayable: number | null;
  review: ReviewStatus;
  analysis: CostAnalysis | null;
  clarification: ClarificationProjection | null;
}
export interface QuoteReviews {
  quotes: QuoteReviewRow[];
  invoices: InvoiceReviewRow[];
}

type Tone = 'neutral' | 'attention' | 'done' | 'stopped';

export const REVIEW_STATE_LABELS: Record<ReviewState, { label: string; detail: string; tone: Tone }> = {
  pending: { label: 'Review pending', detail: 'The cost review has not finished yet.', tone: 'neutral' },
  needs_review: { label: 'Needs your review', detail: 'Decide in Decisions before this can move on.', tone: 'attention' },
  waiting_clarification: {
    label: 'Waiting for the vendor',
    detail: 'A follow-up question is open. The review resumes when it is answered or expires.',
    tone: 'neutral',
  },
  cleared: {
    label: 'Cost review complete',
    detail: 'This settles the review only. Quota, funds, scheduling and tenant checks still apply.',
    tone: 'done',
  },
  rejected: { label: 'Review declined', detail: 'The review remains unresolved. Reopen it explicitly before confirming scope review. This is separate from Guide Pause.', tone: 'stopped' },
};

export function reviewStateLabel(state: string | null | undefined) {
  return REVIEW_STATE_LABELS[state as ReviewState] || { label: 'Review status unknown', detail: '', tone: 'neutral' as Tone };
}

export const FLAG_LABELS: Record<FlagCode, string> = {
  unclear: 'Unclear line',
  possible_duplicate: 'Possible duplicate',
  unsupported_basis: 'No basis given',
  scope_mismatch: 'Outside the recorded scope',
  estimate_invoice_delta: 'Differs from the estimate',
};

export const RECOMMENDATION_LABELS: Record<AnalysisResult['reviewRecommendation'], string> = {
  clarify: 'Suggests asking the vendor',
  landlord_review: 'Suggests your review',
  // Deliberately not "approved" or "clear": the model only reports what it saw.
  no_additional_flags: 'No additional flags raised',
};

/**
 * Who produced the analysis, in words a landlord can't misread: a development
 * simulation is never presented as a model, and an off switch is never a pass.
 */
export function analysisHeading(analysis: CostAnalysis | null): { label: string; detail: string; kind: 'model' | 'simulation' | 'none' } {
  if (!analysis) return { label: 'No analysis recorded', detail: 'Review the itemized costs yourself.', kind: 'none' };
  const source =
    analysis.simulated || analysis.source === 'development_stub'
      ? { label: 'Development simulation', kind: 'simulation' as const }
      : analysis.source === 'meta'
        ? { label: 'Model analysis', kind: 'model' as const }
        : { label: 'Automated analysis off', kind: 'none' as const };
  switch (analysis.status) {
    case 'ready':
      return {
        label: source.label,
        detail:
          source.kind === 'simulation'
            ? 'A fixed development fixture, not a model result. Advisory only.'
            : source.kind === 'model'
              ? `Advisory only. It never approves costs.${analysis.model ? ` ${analysis.model}` : ''}`
              : 'No model ran. Review the itemized costs yourself.',
        kind: source.kind,
      };
    case 'pending':
    case 'running':
      return { label: 'Analysis pending', detail: 'Not finished. Nothing has been approved.', kind: 'none' };
    case 'stale':
      return { label: 'Analysis out of date', detail: 'The costs changed after it ran. It no longer applies.', kind: 'none' };
    default:
      return {
        label: 'Analysis unavailable',
        detail: 'No analysis could be recorded. Review the itemized costs yourself.',
        kind: 'none',
      };
  }
}

export const CLARIFICATION_STATE_LABELS: Record<ClarificationState, string> = {
  draft: 'Prepared, not yet delivered',
  ready: 'Waiting for the vendor’s answer',
  delivery_unknown: 'Delivery not confirmed',
  answered: 'Vendor answered',
  expired: 'Expired without an answer',
  failed: 'Could not be delivered',
};

/** Only `sent` says sent. Off, preview and unknown never do. */
export const DELIVERY_LABELS: Record<ClarificationDelivery, string> = {
  disabled: 'Not sent: delivery is off',
  delivering: 'Sending',
  sent: 'Sent to the vendor',
  development_preview: 'Development preview, not sent',
  failed: 'Delivery failed',
  unknown: 'Delivery unknown, not confirmed sent',
};

/** lineId to the line's description, for flags and questions that cite lines. */
export function lineDescriptions(itemization: Itemization | null | undefined): Map<string, string> {
  return new Map((itemization?.items || []).map((item) => [item.lineId, item.description]));
}

/* ---------------- Decisions ---------------- */

export type CostReviewPurpose = 'clarification_permission' | 'scope_review' | 'analysis_unavailable';

export interface CostReviewPayload {
  source?: string;
  purpose?: string;
  stage?: string;
  subjectId?: string;
  quoteRevision?: number;
  quoteHash?: string;
  contextHash?: string;
  analysisId?: string;
}

export const COST_REVIEW_COPY: Record<CostReviewPurpose, { question: string; approve: string; reject: string; note: string }> = {
  clarification_permission: {
    question: 'Allow one routine follow-up question to the vendor?',
    approve: 'Allow one follow-up',
    reject: 'Decline follow-up',
    note: 'This permits one question only. It does not approve any cost.',
  },
  scope_review: {
    question: 'Have you reviewed the itemized costs and scope?',
    approve: 'Confirm scope review',
    reject: 'Decline scope review',
    note: 'Confirming authorizes no spending or payment. Quota, overage and tenant checks still apply. Declining leaves review unresolved and requires explicit reopening; it is separate from Guide Pause.',
  },
  analysis_unavailable: {
    question: 'Analysis is unavailable. Have you reviewed the itemized costs and scope yourself?',
    approve: 'Confirm scope review',
    reject: 'Decline scope review',
    note: 'Confirming authorizes no spending or payment. Quota, overage and tenant checks still apply. Declining leaves review unresolved and requires explicit reopening; it is separate from Guide Pause.',
  },
};

/**
 * The exact stored preconditions a cost-review decision must echo, or null
 * when the stored Decision doesn't carry them (then it can't be decided here).
 */
export function costReviewExpectation(payload: CostReviewPayload | undefined | null) {
  if (payload?.source !== 'iris_cost_review') return null;
  if (!['clarification_permission', 'scope_review', 'analysis_unavailable'].includes(payload.purpose || '')) return null;
  if (!Number.isInteger(payload.quoteRevision) || typeof payload.quoteHash !== 'string' || !payload.quoteHash) return null;
  return {
    purpose: payload.purpose as CostReviewPurpose,
    expectedQuoteRevision: payload.quoteRevision as number,
    expectedQuoteHash: payload.quoteHash,
  };
}

/** The body for a cost review. Never an approvedAmount: a review is not a price. */
export function costReviewDecisionBody(payload: CostReviewPayload | undefined | null, status: 'approved' | 'rejected') {
  const expected = costReviewExpectation(payload);
  if (!expected) return null;
  return { status, expectedQuoteRevision: expected.expectedQuoteRevision, expectedQuoteHash: expected.expectedQuoteHash };
}

/** An itemized vendor-quote quota decision echoes the revision it was raised on. */
export function quoteDecisionExpectation(payload: CostReviewPayload | undefined | null) {
  if (!payload || !Number.isInteger(payload.quoteRevision) || typeof payload.quoteHash !== 'string' || !payload.quoteHash) return {};
  return { expectedQuoteRevision: payload.quoteRevision as number, expectedQuoteHash: payload.quoteHash };
}

export interface CoordinationPayload {
  actionScope?: string;
  stepId?: string;
  question?: string;
}

/** A server-owned coordination step, or an older Other with no named step. */
export function otherDecisionKind(payload: CoordinationPayload | undefined | null): 'coordination_step' | 'unknown' {
  return payload?.actionScope === 'coordination_step' && payload.stepId === 'review_coordination' ? 'coordination_step' : 'unknown';
}

/** A 409 means the stored Decision moved on: refresh it, never claim success. */
export function isStaleDecision(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { status?: number }).status === 409);
}

/* P0 frozen scope-review reopening v1. No amount, policy or decision override. */
export interface ScopeReviewReopenDescriptor {
  expectedReviewRevision: number;
  expectedQuoteRevision: number;
  expectedQuoteHash: string;
  expectedContextHash: string;
  declinedApprovalId: string;
}
export type ScopeReviewStage = 'quote' | 'invoice';
export type ScopeReviewReopenInput = ScopeReviewReopenDescriptor & { idempotencyKey: string };
export interface ScopeReviewReopenReceipt {
  stage: ScopeReviewStage; subjectId: string; approvalId: string;
  reviewRevision: number; state: 'needs_review'; replayed: boolean; message: string;
}
export const SCOPE_REOPEN_RECEIPT = 'Scope review reopened. Confirm scope review in Decisions. Reopening does not authorize spending or payment.';
const descriptorKeys = ['expectedReviewRevision', 'expectedQuoteRevision', 'expectedQuoteHash', 'expectedContextHash', 'declinedApprovalId'];
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && Object.keys(value).every(k => keys.includes(k));
const whole = (value: unknown, min: number) => Number.isSafeInteger(value) && (value as number) >= min;
export function parseScopeReopenDescriptor(value: unknown): ScopeReviewReopenDescriptor | null {
  if (!record(value) || !exactKeys(value, descriptorKeys) || !whole(value.expectedReviewRevision, 0) || !whole(value.expectedQuoteRevision, 1) ||
    typeof value.expectedQuoteHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.expectedQuoteHash) || typeof value.expectedContextHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.expectedContextHash) ||
    typeof value.declinedApprovalId !== 'string' || !/^[a-fA-F0-9]{24}$/.test(value.declinedApprovalId)) return null;
  return { expectedReviewRevision: value.expectedReviewRevision as number, expectedQuoteRevision: value.expectedQuoteRevision as number, expectedQuoteHash: value.expectedQuoteHash, expectedContextHash: value.expectedContextHash, declinedApprovalId: value.declinedApprovalId };
}
export function scopeReviewReopenBody(value: unknown): ScopeReviewReopenInput | null {
  if (!record(value) || !exactKeys(value, [...descriptorKeys, 'idempotencyKey']) || typeof value.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value.idempotencyKey)) return null;
  const { idempotencyKey, ...rest } = value;const descriptor = parseScopeReopenDescriptor(rest);
  return descriptor ? { ...descriptor, idempotencyKey } : null;
}
export interface ScopeReviewReopenTarget {
  stage: ScopeReviewStage; subjectId: string; label: string; review: ReviewStatus; statement: QuoteSnapshot | null;
}
export function eligibleScopeReopen(target: ScopeReviewReopenTarget): ScopeReviewReopenDescriptor | null {
  const d = parseScopeReopenDescriptor(target.review.reopen), revision = target.review.revision === undefined ? 0 : target.review.revision;
  return target.review.state === 'rejected' && d && whole(revision, 0) && d.expectedReviewRevision === revision &&
    target.statement?.quoteContractVersion === 2 && target.statement.revision === d.expectedQuoteRevision && target.statement.hash === d.expectedQuoteHash ? d : null;
}
export function parseScopeReopenReceipt(value: unknown, target: ScopeReviewReopenTarget, input: ScopeReviewReopenInput): ScopeReviewReopenReceipt | null {
  if (!record(value) || !exactKeys(value, ['stage', 'subjectId', 'approvalId', 'reviewRevision', 'state', 'replayed', 'message']) || value.stage !== target.stage || value.subjectId !== target.subjectId ||
    typeof value.approvalId !== 'string' || !/^[a-fA-F0-9]{24}$/.test(value.approvalId) || !whole(value.reviewRevision, 1) || value.reviewRevision !== input.expectedReviewRevision + 1 || value.state !== 'needs_review' || typeof value.replayed !== 'boolean' || value.message !== SCOPE_REOPEN_RECEIPT) return null;
  return value as unknown as ScopeReviewReopenReceipt;
}
export interface ScopeReopenAttempt {
  target: ScopeReviewReopenTarget; input: ScopeReviewReopenInput; basis: string;
  phase: 'sending' | 'unknown' | 'refused' | 'receipt'; receipt: ScopeReviewReopenReceipt | null;
  message: string; readback: 'pending' | 'ok' | 'failed'; verifiedBasis: string | null;
}
export interface ScopeReopenView { attempts: Record<string, ScopeReopenAttempt>; reading: boolean; localError?: string }
const targetKey = (target: Pick<ScopeReviewReopenTarget, 'stage' | 'subjectId'>) => JSON.stringify([target.stage, target.subjectId]);
export function scopeReopenAttempt(view: ScopeReopenView, target: ScopeReviewReopenTarget) { return view.attempts[targetKey(target)]; }
export function canReopenScope(view: ScopeReopenView, target: ScopeReviewReopenTarget): boolean {
  const d = eligibleScopeReopen(target);if (!d || view.reading || Object.values(view.attempts).some(a => a.phase === 'sending')) return false;
  const old = scopeReopenAttempt(view, target), basis = JSON.stringify(d);if (!old) return true;
  if (old.phase === 'receipt' && old.basis === basis) return false;
  return old.readback === 'ok' && old.verifiedBasis === basis;
}
export class SupersededCostReviewRead extends Error {}
/** Shared by normal/live GET and reopen readback. Check and apply together,
 * before resolving the read, so an older response cannot overwrite a newer one. */
export class CostReviewReadOrder {
  private generation = 0;
  invalidate() { this.generation++; }
  async read(fetchReviews: () => Promise<QuoteReviews>, apply: (reviews: QuoteReviews) => void): Promise<QuoteReviews> {
    const generation = ++this.generation;let reviews: QuoteReviews;
    try { reviews = await fetchReviews(); }
    catch (error) { if (generation !== this.generation) throw new SupersededCostReviewRead('A newer cost-review read superseded this failure');throw error; }
    if (generation !== this.generation) throw new SupersededCostReviewRead('A newer cost-review read superseded this response');
    if (!reviews || !Array.isArray(reviews.quotes) || !Array.isArray(reviews.invoices)) throw Error('Unconfirmed cost review readback');
    apply(reviews);return reviews;
  }
}
/** One panel/request owns attempt keys and receipts, above row refresh/unmounts.
 * All writes are explicit; the only automatic follow-up is an authoritative read. */
export class ScopeReviewReopenController {
  private view: ScopeReopenView = { attempts: {}, reading: false };
  private listeners = new Set<() => void>();private active = true;private epoch = 0;
  constructor(private options: { requestId: string; post: (requestId: string, stage: ScopeReviewStage, subjectId: string, input: ScopeReviewReopenInput) => Promise<{ data?: unknown }>; read: (requestId: string) => Promise<QuoteReviews>; onRead?: (reviews: QuoteReviews) => void; newKey?: () => string }) {}
  getView = () => this.view;
  subscribe = (fn: () => void) => { this.listeners.add(fn);return () => this.listeners.delete(fn); };
  activate() { this.active = true; }
  dispose() { this.active = false;this.epoch++;this.view = { ...this.view, reading: false, attempts: Object.fromEntries(Object.entries(this.view.attempts).map(([key, a]) => [key, a.phase === 'sending' ? { ...a, phase: 'unknown' as const, message: 'The previous attempt is unconfirmed. Refresh before explicitly retrying the same attempt.', readback: 'failed' as const, verifiedBasis: null } : a])) }; }
  private set(patch: Partial<ScopeReopenView>) { if (!this.active) return;this.view = { ...this.view, ...patch };this.listeners.forEach(fn => fn()); }
  private put(key: string, attempt: ScopeReopenAttempt) { this.set({ attempts: { ...this.view.attempts, [key]: attempt } }); }
  async reopen(target: ScopeReviewReopenTarget) {
    if (!this.active || !canReopenScope(this.view, target)) return;
    const d = eligibleScopeReopen(target)!, basis = JSON.stringify(d), key = targetKey(target), old = this.view.attempts[key];
    let input: ScopeReviewReopenInput | null;
    try { input = old?.phase === 'unknown' && old.basis === basis ? old.input : scopeReviewReopenBody({ ...d, idempotencyKey: this.options.newKey?.() ?? `scope-reopen-${crypto.randomUUID()}` }); }
    catch { this.set({ localError: 'A reopen attempt could not be created. Nothing was sent.' });return; }
    if (!input) { this.set({ localError: 'A valid reopen attempt could not be created. Nothing was sent.' });return; }
    this.set({ localError: '' });
    const generation = this.epoch;
    this.put(key, { target, input, basis, phase: 'sending', receipt: null, message: '', readback: 'pending', verifiedBasis: null });
    try {
      const response = await this.options.post(this.options.requestId, target.stage, target.subjectId, input);
      if (!this.active || generation !== this.epoch) return;
      const receipt = parseScopeReopenReceipt(response.data, target, input);if (!receipt) throw Error('Unconfirmed reopen receipt');
      this.put(key, { ...this.view.attempts[key], phase: 'receipt', receipt, message: SCOPE_REOPEN_RECEIPT });
    } catch (error) {
      if (!this.active || generation !== this.epoch) return;
      const status = record(error) ? error.status : null, knownRefusal = [400, 403, 404, 409].includes(status as number);
      this.put(key, { ...this.view.attempts[key], phase: knownRefusal ? 'refused' : 'unknown', message: status === 409 ? 'The recorded review changed or is no longer reopenable. Refresh its current state before another explicit attempt.' : knownRefusal ? 'The server refused reopening. Nothing here authorizes a scope confirmation or payment. Read the current review.' : 'Reopening outcome is unconfirmed. Nothing was resent. Check the current review before explicitly retrying the same attempt.' });
    }
    await this.refresh();
  }
  async refresh() {
    if (!this.active || this.view.reading || Object.values(this.view.attempts).some(a => a.phase === 'sending')) return;const generation = this.epoch;this.set({ reading: true });
    try {
      const reviews = await this.options.read(this.options.requestId);if (!this.active || generation !== this.epoch) return;
      if (!reviews || !Array.isArray(reviews.quotes) || !Array.isArray(reviews.invoices)) throw Error('Unconfirmed cost review readback');
      const attempts = Object.fromEntries(Object.entries(this.view.attempts).map(([key, a]) => { const row = a.target.stage === 'quote' ? reviews.quotes.find(r => r.id === a.target.subjectId) : reviews.invoices.find(r => r.id === a.target.subjectId);const statement = row && ('current' in row ? row.current : row.finalStatement);const d = row ? eligibleScopeReopen({ ...a.target, review: row.review, statement: statement || null }) : null;return [key, { ...a, readback: 'ok' as const, verifiedBasis: d ? JSON.stringify(d) : null }]; }));
      this.set({ attempts });this.options.onRead?.(reviews);
    } catch {
      if (!this.active || generation !== this.epoch) return;
      this.set({ attempts: Object.fromEntries(Object.entries(this.view.attempts).map(([key, a]) => [key, { ...a, readback: 'failed' as const, verifiedBasis: null }])) });
    } finally { if (this.active && generation === this.epoch) this.set({ reading: false }); }
  }
}
