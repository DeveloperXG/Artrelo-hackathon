import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COST_REVIEW_COPY,
  DELIVERY_LABELS,
  RECOMMENDATION_LABELS,
  REVIEW_STATE_LABELS,
  analysisHeading,
  costReviewDecisionBody,
  costReviewExpectation,
  isStaleDecision,
  otherDecisionKind,
  quoteDecisionExpectation,
  type CostAnalysis,
  eligibleScopeReopen,
  scopeReviewReopenBody,
  ScopeReviewReopenController,
  canReopenScope,
  scopeReopenAttempt,
  SCOPE_REOPEN_RECEIPT,
  CostReviewReadOrder,
  SupersededCostReviewRead,
  type ScopeReviewReopenTarget,
  type QuoteReviews,
} from './costReview';
import { ApiError, LandlordAPI, VendorPortalAPI } from '../api/client';

const HASH = 'a'.repeat(64);
const costPayload = (purpose: string) => ({
  source: 'iris_cost_review',
  purpose,
  stage: 'quote',
  subjectId: 's1',
  quoteRevision: 2,
  quoteHash: HASH,
  contextHash: 'c'.repeat(64),
  analysisId: 'an1',
});
const analysis = (patch: Partial<CostAnalysis>): CostAnalysis => ({
  status: 'ready',
  source: 'meta',
  simulated: false,
  result: null,
  errorCode: null,
  provider: null,
  model: null,
  durationMs: null,
  ...patch,
});

describe('advisory analysis labels never read as approval', () => {
  it('distinguishes an actual model from a development simulation', () => {
    expect(analysisHeading(analysis({ source: 'meta', model: 'muse-spark-1.3' }))).toMatchObject({ label: 'Model analysis', kind: 'model' });
    expect(analysisHeading(analysis({ source: 'meta' })).detail).toMatch(/Advisory only\. It never approves costs/);
    const sim = analysisHeading(analysis({ source: 'development_stub', simulated: true }));
    expect(sim).toMatchObject({ label: 'Development simulation', kind: 'simulation' });
    expect(sim.detail).toMatch(/not a model result/);
    // simulated wins even if a source were mislabelled
    expect(analysisHeading(analysis({ source: 'meta', simulated: true })).kind).toBe('simulation');
  });

  it.each([
    ['pending', 'Analysis pending'],
    ['running', 'Analysis pending'],
    ['unavailable', 'Analysis unavailable'],
    ['stale', 'Analysis out of date'],
  ] as const)('%s reads %s and nothing approved', (status, label) => {
    const heading = analysisHeading(analysis({ status }));
    expect(heading.label).toBe(label);
    expect(heading.label).not.toMatch(/approv|clear|pass|complete/i);
    expect(heading.kind).toBe('none');
  });

  it('a disabled source and a missing analysis are honest, not a pass', () => {
    expect(analysisHeading(analysis({ source: 'disabled' })).label).toBe('Automated analysis off');
    expect(analysisHeading(null).label).toBe('No analysis recorded');
  });

  it('no recommendation or review state claims approval', () => {
    for (const label of Object.values(RECOMMENDATION_LABELS)) expect(label).not.toMatch(/approv/i);
    expect(REVIEW_STATE_LABELS.cleared.detail).toMatch(/Quota, funds, scheduling and tenant checks still apply/);
    for (const state of ['pending', 'needs_review', 'waiting_clarification'] as const) {
      expect(REVIEW_STATE_LABELS[state].label).not.toMatch(/approv|complete|clear/i);
    }
  });

  it('only a sent delivery says sent', () => {
    for (const [delivery, label] of Object.entries(DELIVERY_LABELS)) {
      if (delivery === 'sent') expect(label).toBe('Sent to the vendor');
      else expect(label).not.toMatch(/^Sent/);
    }
    expect(DELIVERY_LABELS.development_preview).toMatch(/not sent/);
    expect(DELIVERY_LABELS.unknown).toMatch(/not confirmed sent/);
  });
});

describe('cost review Decisions echo the exact stored preconditions', () => {
  it('sends status with the stored revision and hash, never an amount', () => {
    for (const purpose of ['clarification_permission', 'scope_review', 'analysis_unavailable']) {
      for (const status of ['approved', 'rejected'] as const) {
        const body = costReviewDecisionBody(costPayload(purpose), status);
        expect(body).toEqual({ status, expectedQuoteRevision: 2, expectedQuoteHash: HASH });
        expect(body).not.toHaveProperty('approvedAmount');
      }
    }
  });

  it('refuses to build a decision when the stored context is missing or foreign', () => {
    expect(costReviewExpectation({ ...costPayload('scope_review'), quoteHash: undefined })).toBeNull();
    expect(costReviewExpectation({ ...costPayload('scope_review'), quoteRevision: undefined })).toBeNull();
    expect(costReviewExpectation({ ...costPayload('scope_review'), source: 'vendor_quote' })).toBeNull();
    expect(costReviewExpectation(costPayload('approve_everything'))).toBeNull();
    expect(costReviewDecisionBody(undefined, 'approved')).toBeNull();
  });

  it('uses the exact question and button labels', () => {
    expect(COST_REVIEW_COPY.clarification_permission).toMatchObject({ approve: 'Allow one follow-up', reject: 'Decline follow-up' });
    expect(COST_REVIEW_COPY.clarification_permission.note).toMatch(/one question only\. It does not approve any cost/);
    expect(COST_REVIEW_COPY.scope_review).toMatchObject({ approve: 'Confirm scope review', reject: 'Decline scope review' });
    expect(COST_REVIEW_COPY.analysis_unavailable).toMatchObject({ approve: 'Confirm scope review', reject: 'Decline scope review' });
    expect(COST_REVIEW_COPY.scope_review.note).toMatch(/Quota, overage and tenant checks still apply/);
  });

  it('an itemized quota decision carries the revision it was raised on; a legacy one carries nothing', () => {
    expect(quoteDecisionExpectation({ source: 'vendor_quote', quoteRevision: 3, quoteHash: HASH })).toEqual({
      expectedQuoteRevision: 3,
      expectedQuoteHash: HASH,
    });
    expect(quoteDecisionExpectation({ source: 'vendor_quote' })).toEqual({});
  });

  it('a 409 is a stale decision to refresh, other failures are not', () => {
    expect(isStaleDecision(new ApiError('changed', 409, {}))).toBe(true);
    expect(isStaleDecision(new ApiError('bad', 400, {}))).toBe(false);
    expect(isStaleDecision(null)).toBe(false);
  });
});

describe('Other decisions name a coordination step or nothing', () => {
  it('recognises only the server-owned step', () => {
    expect(otherDecisionKind({ actionScope: 'coordination_step', stepId: 'review_coordination', question: 'Ask the tenant?' })).toBe('coordination_step');
    expect(otherDecisionKind({ actionScope: 'coordination_step', stepId: 'cancel_request' })).toBe('unknown');
    expect(otherDecisionKind({})).toBe('unknown');
    expect(otherDecisionKind(undefined)).toBe('unknown');
  });
});

describe('explicit scope-review reopening contract and uncertain attempts', () => {
  const target = (): ScopeReviewReopenTarget => ({ stage: 'quote', subjectId: 'b'.repeat(24), label: 'Synthetic quote', review: { state: 'rejected', approvalId: 'a'.repeat(24), resumePending: false, reopen: { expectedReviewRevision: 0, expectedQuoteRevision: 1, expectedQuoteHash: HASH, expectedContextHash: 'c'.repeat(64), declinedApprovalId: 'a'.repeat(24) } }, statement: { quoteContractVersion: 2, revision: 1, hash: HASH, itemization: { pricingMode: 'fixed', currency: 'CAD', items: [{ lineId: 'labour', description: 'Synthetic labour', category: 'labour', amountMinor: 10000 }], totals: { lowMinor: 10000, highMinor: 10000 } } } });
  const reviews = (t: ScopeReviewReopenTarget): QuoteReviews => t.stage === 'quote' ? { quotes: [{ id: t.subjectId, vendorName: 'Synthetic vendor', status: 'accepted', revision: 1, original: null, current: t.statement, approved: null, review: t.review, analysis: null, clarification: null }], invoices: [] } : { quotes: [], invoices: [{ id: t.subjectId, status: 'awaiting_tenant', finalStatement: t.statement, invoiceReference: 'SYNTHETIC', originalQuote: null, agreedAmount: 100, invoicedAmount: 100, approvedPayable: null, review: t.review, analysis: null, clarification: null }] };
  const receipt = (t: ScopeReviewReopenTarget, replayed = false) => ({ stage: t.stage, subjectId: t.subjectId, approvalId: 'd'.repeat(24), reviewRevision: 1, state: 'needs_review', replayed, message: SCOPE_REOPEN_RECEIPT });
  it('supports legacy revision0 but hides missing/malformed/changed descriptor and statement bindings', () => {
    const t = target();expect(eligibleScopeReopen(t)?.expectedReviewRevision).toBe(0);
    for (const review of [{ ...t.review, reopen: undefined }, { ...t.review, state: 'cleared' }, { ...t.review, revision: 1 }, { ...t.review, reopen: { ...t.review.reopen, amount: 100 } }, { ...t.review, reopen: { ...t.review.reopen, expectedQuoteHash: 'bad' } }]) expect(eligibleScopeReopen({ ...t, review } as any)).toBeNull();
    expect(eligibleScopeReopen({ ...t, statement: { ...t.statement!, revision: 2 } })).toBeNull();expect(eligibleScopeReopen({ ...t, statement: null })).toBeNull();
    expect(scopeReviewReopenBody({ ...t.review.reopen, idempotencyKey: 'short' })).toBeNull();
  });
  it.each(['quote', 'invoice'] as const)('sends %s only on explicit action, blocks same-frame duplicates, then reads without optimistic scope approval', async stage => {
    const t = { ...target(), stage };let resolve!: (value: { data: unknown }) => void;const post = vi.fn(() => new Promise<{ data: unknown }>(r => { resolve = r; })), read = vi.fn(async () => reviews({ ...t, review: { ...t.review, state: 'needs_review', revision: 1, reopen: null } })), onRead = vi.fn(), newKey = vi.fn(() => 'scope_attempt_0001');
    const c = new ScopeReviewReopenController({ requestId: 'request_owned', post, read, onRead, newKey });expect(post).not.toHaveBeenCalled();
    const first = c.reopen(t);await c.reopen(t);await c.refresh();expect(read).not.toHaveBeenCalled();expect(post).toHaveBeenCalledTimes(1);expect(newKey).toHaveBeenCalledTimes(1);expect(canReopenScope(c.getView(), t)).toBe(false);
    expect(post.mock.calls[0].slice(0, 3)).toEqual(['request_owned', stage, t.subjectId]);expect(post.mock.calls[0][3]).toEqual({ ...t.review.reopen, idempotencyKey: 'scope_attempt_0001' });
    resolve({ data: receipt(t) });await first;expect(read).toHaveBeenCalledTimes(1);expect(onRead.mock.calls[0][0]).toEqual(await read.mock.results[0].value);expect(scopeReopenAttempt(c.getView(), t)?.phase).toBe('receipt');expect(scopeReopenAttempt(c.getView(), t)?.receipt?.state).toBe('needs_review');expect(canReopenScope(c.getView(), t)).toBe(false);expect(t.review.state).toBe('rejected');
  });
  it('keeps the exact key/body after an unknown response; failed readback blocks retry until a successful explicit read', async () => {
    const t = target(), post = vi.fn().mockRejectedValueOnce(Error('response lost')).mockResolvedValue({ data: receipt(t, true) }), read = vi.fn().mockRejectedValueOnce(Error('offline read')).mockResolvedValue(reviews(t)), newKey = vi.fn(() => 'scope_attempt_0001'), c = new ScopeReviewReopenController({ requestId: 'r1', post, read, newKey });
    await c.reopen(t);expect(scopeReopenAttempt(c.getView(), t)?.phase).toBe('unknown');await c.reopen(t);expect(post).toHaveBeenCalledTimes(1);expect(canReopenScope(c.getView(), t)).toBe(false);
    await c.refresh();expect(post).toHaveBeenCalledTimes(1);expect(canReopenScope(c.getView(), t)).toBe(true);await c.reopen(t);expect(post).toHaveBeenCalledTimes(2);expect(post.mock.calls[0][3]).toEqual(post.mock.calls[1][3]);expect(newKey).toHaveBeenCalledTimes(1);expect(scopeReopenAttempt(c.getView(), t)?.receipt?.replayed).toBe(true);
  });
  it.each([400, 403, 404, 409, 503])('never treats HTTP%s as success or automatically resends', async status => {
    const t = target(), post = vi.fn().mockRejectedValue(new ApiError('Backend text must not be rendered', status, { code: status === 409 ? 'stale_cost_review' : 'review_reopen_unavailable' })), read = vi.fn(async () => reviews({ ...t, review: { ...t.review, reopen: null } })), c = new ScopeReviewReopenController({ requestId: 'r1', post, read, newKey: () => 'scope_attempt_0001' });
    await c.reopen(t);expect(post).toHaveBeenCalledTimes(1);expect(read).toHaveBeenCalledTimes(1);expect(scopeReopenAttempt(c.getView(), t)?.receipt).toBeNull();expect(scopeReopenAttempt(c.getView(), t)?.phase).toBe(status === 503 ? 'unknown' : 'refused');expect(scopeReopenAttempt(c.getView(), t)?.message).not.toContain('Backend text');expect(canReopenScope(c.getView(), t)).toBe(false);
  });
  it('keeps replay receipt as history and renders current cleared state from readback, never fabricated pending', async () => {
    const t = target(), current = reviews({ ...t, review: { ...t.review, state: 'cleared', revision: 1, reopen: null } }), onRead = vi.fn(), c = new ScopeReviewReopenController({ requestId: 'r1', post: vi.fn(async () => ({ data: receipt(t, true) })), read: async () => current, onRead, newKey: () => 'scope_attempt_0001' });
    await c.reopen(t);expect(onRead).toHaveBeenCalledWith(current);expect(current.quotes[0].review.state).toBe('cleared');expect(scopeReopenAttempt(c.getView(), t)?.receipt?.replayed).toBe(true);expect(canReopenScope(c.getView(), t)).toBe(false);
  });
  it('treats malformed/mismatched success as unknown and drops late outcomes after scope disposal', async () => {
    const t = target(), post = vi.fn(async () => ({ data: { ...receipt(t), subjectId: 'foreign' } })), c = new ScopeReviewReopenController({ requestId: 'r1', post, read: async () => reviews(t), newKey: () => 'scope_attempt_0001' });await c.reopen(t);expect(scopeReopenAttempt(c.getView(), t)?.phase).toBe('unknown');
    let resolve!: (value: { data: unknown }) => void;const read = vi.fn(), old = new ScopeReviewReopenController({ requestId: 'old_request', post: () => new Promise(r => { resolve = r; }), read, newKey: () => 'scope_attempt_0001' });const pending = old.reopen(t);old.dispose();resolve({ data: receipt(t) });await pending;expect(read).not.toHaveBeenCalled();expect(scopeReopenAttempt(old.getView(), t)?.receipt).toBeNull();
  });
  it('requires a refreshed new descriptor for a new human attempt and never reuses an unknown key for changed input', async () => {
    const t = target(), changed = { ...t, review: { ...t.review, revision: 1, reopen: { ...t.review.reopen!, expectedReviewRevision: 1, expectedContextHash: 'e'.repeat(64), declinedApprovalId: 'e'.repeat(24) } } }, post = vi.fn().mockRejectedValue(Error('unknown response')), read = vi.fn(async () => reviews(changed)), newKey = vi.fn().mockReturnValueOnce('scope_attempt_0001').mockReturnValueOnce('scope_attempt_0002'), c = new ScopeReviewReopenController({ requestId: 'r1', post, read, newKey });
    await c.reopen(t);expect(canReopenScope(c.getView(), t)).toBe(false);expect(canReopenScope(c.getView(), changed)).toBe(true);expect(post).toHaveBeenCalledTimes(1);await c.reopen(changed);expect(post.mock.calls[0][3].idempotencyKey).toBe('scope_attempt_0001');expect(post.mock.calls[1][3].idempotencyKey).toBe('scope_attempt_0002');expect(post.mock.calls[1][3].expectedContextHash).toBe('e'.repeat(64));
  });
  it('blocks retry on malformed readback and exposes key-generation failure without sending', async () => {
    const t = target(), post = vi.fn().mockRejectedValue(Error('lost')), c = new ScopeReviewReopenController({ requestId: 'r1', post, read: vi.fn(async () => ({} as QuoteReviews)), newKey: () => 'scope_attempt_0001' });await c.reopen(t);expect(scopeReopenAttempt(c.getView(), t)?.readback).toBe('failed');expect(canReopenScope(c.getView(), t)).toBe(false);
    const noKey = new ScopeReviewReopenController({ requestId: 'r1', post, read: async () => reviews(t), newKey: () => { throw Error('No secure generator'); } });await noKey.reopen(t);expect(noKey.getView().localError).toContain('Nothing was sent');expect(post).toHaveBeenCalledTimes(1);
  });
  it('prevents a slow reopen readback overwriting a later normal/live read which already returned cleared', async () => {
    const t = target(), order = new CostReviewReadOrder(), applied: QuoteReviews[] = [];let releaseOld!: (value: QuoteReviews) => void;
    const oldResponse = new Promise<QuoteReviews>(resolve => { releaseOld = resolve; }), post = vi.fn(async () => ({ data: receipt(t) })), read = vi.fn(() => order.read(() => oldResponse, data => applied.push(data))), c = new ScopeReviewReopenController({ requestId: 'r1', post, read, newKey: () => 'scope_attempt_0001' });
    const attempt = c.reopen(t);await Promise.resolve();expect(read).toHaveBeenCalledTimes(1);
    const cleared = reviews({ ...t, review: { state: 'cleared', approvalId: 'd'.repeat(24), resumePending: false, revision: 1, reopen: null } });
    await order.read(async () => cleared, data => applied.push(data));releaseOld(reviews(t));await attempt;
    expect(applied).toEqual([cleared]);expect(scopeReopenAttempt(c.getView(), t)?.receipt).not.toBeNull();expect(scopeReopenAttempt(c.getView(), t)?.readback).toBe('failed');expect(canReopenScope(c.getView(), t)).toBe(false);expect(post).toHaveBeenCalledTimes(1);
  });
  it('also prevents a slow normal read overwriting a newer readback and invalidates pending reads on request cleanup', async () => {
    const t = target(), order = new CostReviewReadOrder(), applied: QuoteReviews[] = [];let resolve!: (value: QuoteReviews) => void;
    const old = order.read(() => new Promise<QuoteReviews>(r => { resolve = r; }), data => applied.push(data));const rejected = expect(old).rejects.toBeInstanceOf(SupersededCostReviewRead);
    const current = reviews({ ...t, review: { ...t.review, revision: 1, state: 'needs_review', reopen: null } });await order.read(async () => current, data => applied.push(data));resolve(reviews(t));await rejected;expect(applied).toEqual([current]);
    const pending = order.read(() => new Promise<QuoteReviews>(r => { resolve = r; }), data => applied.push(data));const abandoned = expect(pending).rejects.toBeInstanceOf(SupersededCostReviewRead);order.invalidate();resolve(reviews(t));await abandoned;expect(applied).toEqual([current]);
  });
  it('suppresses an old rejected GET error after a newer normal/readback success but retains a current failure', async () => {
    const t = target(), order = new CostReviewReadOrder();let rejectOld!: (error: Error) => void;let visible: QuoteReviews | null = null, error = '';
    const old = order.read(() => new Promise<QuoteReviews>((_, reject) => { rejectOld = reject; }), data => { visible = data; }).catch(reason => { if (!(reason instanceof SupersededCostReviewRead)) error = 'Itemized costs could not be loaded.'; });
    const cleared = reviews({ ...t, review: { ...t.review, state: 'cleared', revision: 1, reopen: null } });await order.read(async () => cleared, data => { visible = data;error = ''; });rejectOld(Error('Old request failed after newer success'));await old;
    expect(visible).toBe(cleared);expect(error).toBe('');
    await expect(order.read(async () => { throw Error('Current read failed'); }, () => {})).rejects.toThrow('Current read failed');
  });
});

describe('API client bodies (no network: fetch is stubbed)', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const stub = (status = 200, payload: unknown = { success: true, data: {} }) =>
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
    }));
  afterEach(() => {
    calls.length = 0;
    vi.unstubAllGlobals();
  });

  it('a cost review decision sends exactly status and the expected revision/hash', async () => {
    stub();
    await LandlordAPI.decideApprovalRequest('ap1', 'approved', undefined, { expectedQuoteRevision: 2, expectedQuoteHash: HASH });
    expect(calls[0].url).toMatch(/\/landlords\/approval-requests\/ap1\/decision$/);
    expect(calls[0].init.method).toBe('PUT');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ status: 'approved', expectedQuoteRevision: 2, expectedQuoteHash: HASH });
  });

  it('a legacy decision body is unchanged', async () => {
    stub();
    await LandlordAPI.decideApprovalRequest('ap2', 'approved', 240.5);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ status: 'approved', approvedAmount: 240.5 });
  });

  it('reads cost reviews from the landlord-only endpoint', async () => {
    stub(200, { success: true, data: { quotes: [], invoices: [] } });
    await LandlordAPI.getQuoteReviews('req 1');
    expect(calls[0].url).toMatch(/\/landlords\/requests\/req%201\/quote-reviews$/);
  });
  it('posts only the frozen reopen descriptor/key to the stage/subject path', async () => {
    stub();const body = { expectedReviewRevision: 0, expectedQuoteRevision: 1, expectedQuoteHash: HASH, expectedContextHash: 'c'.repeat(64), declinedApprovalId: 'a'.repeat(24), idempotencyKey: 'scope_attempt_0001' };
    await LandlordAPI.reopenScopeReview('req 1', 'invoice', 'subject/1', body);
    expect(calls[0].url).toMatch(/\/landlords\/requests\/req%201\/quote-reviews\/invoice\/subject%2F1\/reopen$/);expect(calls[0].init.method).toBe('POST');expect(JSON.parse(String(calls[0].init.body))).toEqual(body);
    expect(() => LandlordAPI.reopenScopeReview('r', 'quote', 's', { ...body, approvedAmount: 240 } as any)).toThrow(ApiError);expect(calls).toHaveLength(1);
  });

  it('clarification calls use their own path and never carry a session', async () => {
    stub();
    await VendorPortalAPI.getQuoteClarification('qc_tok');
    await VendorPortalAPI.submitQuoteClarification('qc_tok', {
      expectedQuoteRevision: 1,
      expectedQuoteHash: HASH,
      answers: [{ questionId: 'q1', answer: 'It covers the trap.' }],
    });
    expect(calls.map((call) => call.url)).toEqual([
      expect.stringMatching(/\/vendor-portal\/qc_tok\/quote-clarification$/),
      expect.stringMatching(/\/vendor-portal\/qc_tok\/quote-clarification$/),
    ]);
    for (const call of calls) expect((call.init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(calls.some((call) => /\/respond$|\/vendor-portal\/qc_tok$/.test(call.url))).toBe(false);
  });

  it('a stale decision surfaces as a 409 ApiError for the page to refresh', async () => {
    stub(409, { success: false, code: 'stale_cost_review', message: 'This cost review changed. Refresh the current decision.' });
    const error = await LandlordAPI.decideApprovalRequest('ap3', 'approved', undefined, { expectedQuoteRevision: 1, expectedQuoteHash: HASH }).catch((err) => err);
    expect(isStaleDecision(error)).toBe(true);
    expect((error as ApiError).payload).toMatchObject({ code: 'stale_cost_review' });
  });
});
