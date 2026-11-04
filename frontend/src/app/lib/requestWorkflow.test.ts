import { describe, expect, it } from 'vitest';
import { ApiError, type RequestQuota } from '../api/client';
import {
  activityTime,
  applyIntakeOptimistically,
  createSubmissionKey,
  creationGate,
  emptyIntakeDraft,
  incompleteTopics,
  intakeAnswersPayload,
  isTerminalRequest,
  mergeSimilarRequests,
  newSubmissionId,
  outreachEventAt,
  outreachLine,
  outreachState,
  outstandingQuestions,
  revisableQuestions,
  safetyPendingReview,
  sortActivityNewestFirst,
  stripAcknowledgment,
  tenantSafetyLabel,
  withOutreachActivity,
  workflowConflict,
} from './requestWorkflow';
import type { IntakeFollowUp, OutreachSummary } from '../types/requestWorkflow';

const windowOf = (used: number, limit: number) => ({ used, limit, remaining: limit - used, resetsAt: null });
const quota = (eligibility: RequestQuota['creationEligibility']): RequestQuota => ({
  daily: windowOf(0, 2),
  weekly: windowOf(0, 5),
  blocked: false,
  blockedBy: null,
  nextAvailableAt: null,
  creationEligibility: eligibility,
});
const eligibility = (over: Partial<NonNullable<RequestQuota['creationEligibility']>> = {}) => ({
  allowed: true,
  reasons: [],
  openCount: 0,
  openCap: 2,
  nextAvailableAt: null,
  evaluatedAt: '2026-10-21T10:00:00Z',
  ...over,
});

describe('creationGate', () => {
  it('stays closed while loading and after a failed load', () => {
    expect(creationGate(null, 'loading').status).toBe('loading');
    expect(creationGate(null, 'error').status).toBe('error');
  });

  it('treats a server that sends no eligibility as unknown, not allowed', () => {
    expect(creationGate(quota(undefined), 'ready').status).toBe('error');
  });

  it('opens only on a loaded allowed verdict', () => {
    expect(creationGate(quota(eligibility()), 'ready')).toEqual({ status: 'allowed' });
  });

  it('explains each block reason', () => {
    const cap = creationGate(quota(eligibility({ allowed: false, reasons: ['open_cap'], openCount: 2 })), 'ready');
    expect(cap.status).toBe('blocked');
    expect(cap.status === 'blocked' && cap.message).toContain('2 open requests');

    const daily = creationGate(
      quota(eligibility({ allowed: false, reasons: ['daily_limit'], nextAvailableAt: '2026-10-21T18:00:00Z' })),
      'ready'
    );
    expect(daily.status === 'blocked' && daily.message).toMatch(/daily request limit\. You can start a new request at/);

    const weekly = creationGate(quota(eligibility({ allowed: false, reasons: ['weekly_limit'] })), 'ready');
    expect(weekly.status === 'blocked' && weekly.message).toContain('weekly request limit');

    const unlinked = creationGate(quota(eligibility({ allowed: false, reasons: ['unit_unlinked'] })), 'ready');
    expect(unlinked.status === 'blocked' && unlinked.reasons).toEqual(['unit_unlinked']);
  });
});

describe('stripAcknowledgment', () => {
  it('removes a leading model acknowledgement paragraph', () => {
    expect(stripAcknowledgment('Sorry to hear about the leak.\n\nWhere is it dripping?', 'Sorry to hear about the leak.')).toBe(
      'Where is it dripping?'
    );
  });
  it('leaves the reply alone when there is no acknowledgement or it is not a prefix', () => {
    expect(stripAcknowledgment('  Where is it?  ', null)).toBe('Where is it?');
    expect(stripAcknowledgment('Where is it?', 'Thanks!')).toBe('Where is it?');
  });
});

describe('mergeSimilarRequests', () => {
  const s = (id: string) => ({ id, issueTitle: `T${id}`, reason: 'same unit', createdAt: '2026-10-20T00:00:00Z' });
  it('caps at three, dedupes, and keeps dismissed ones out', () => {
    expect(mergeSimilarRequests([s('a'), s('a'), s('b'), s('c'), s('d')], new Set()).map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(mergeSimilarRequests([s('a'), s('b'), s('c'), s('d')], new Set(['b'])).map((x) => x.id)).toEqual(['a', 'c', 'd']);
    expect(mergeSimilarRequests(undefined, new Set())).toEqual([]);
  });
});

const followUp: IntakeFollowUp = {
  revision: 3,
  state: 'awaiting_answers',
  questions: [
    { topicId: 'location', question: 'Where is the leak?', state: 'answered', value: 'Kitchen' },
    { topicId: 'timeline', question: 'When did it start?', state: 'missing', value: '' },
    { topicId: 'impact', question: 'Can you still use the sink?', state: 'missing', value: '' },
  ],
  answers: [],
  submittedAt: null,
  reviewedAt: null,
  remainingTopics: ['timeline', 'impact'],
};

describe('intake follow-up', () => {
  it('asks only for missing facts', () => {
    expect(outstandingQuestions(followUp).map((q) => q.topicId)).toEqual(['timeline', 'impact']);
    expect(outstandingQuestions({ ...followUp, state: 'ready_for_review' })).toEqual([]);
    expect(outstandingQuestions(null)).toEqual([]);
  });

  it('accepts unknown and declined as complete, but not an empty answer', () => {
    const qs = outstandingQuestions(followUp);
    const draft = emptyIntakeDraft(qs);
    expect(incompleteTopics(qs, draft)).toEqual(['timeline', 'impact']);
    draft.timeline = { state: 'answered', value: '  ' };
    draft.impact = { state: 'declined', value: '' };
    expect(incompleteTopics(qs, draft)).toEqual(['timeline']);
    draft.timeline = { state: 'unknown', value: '' };
    expect(incompleteTopics(qs, draft)).toEqual([]);
  });

  it('builds the payload and the optimistic review state', () => {
    const qs = outstandingQuestions(followUp);
    const answers = intakeAnswersPayload(qs, {
      timeline: { state: 'answered', value: ' Yesterday ' },
      impact: { state: 'unknown', value: 'ignored' },
    });
    expect(answers).toEqual([
      { topicId: 'timeline', state: 'answered', value: 'Yesterday' },
      { topicId: 'impact', state: 'unknown' },
    ]);
    const next = applyIntakeOptimistically(followUp, answers);
    expect(next.state).toBe('ready_for_review');
    expect(next.revision).toBe(4);
    expect(next.remainingTopics).toEqual(['impact']);
    expect(next.questions.find((q) => q.topicId === 'timeline')?.value).toBe('Yesterday');
    expect(next.questions.find((q) => q.topicId === 'location')?.state).toBe('answered');
  });
});

describe('workflowConflict', () => {
  it('reads the 409 code and latest record', () => {
    const err = new ApiError('stale', 409, { code: 'stale_revision', data: { _id: 'r1' } });
    expect(workflowConflict(err)).toEqual({ code: 'stale_revision', latest: { _id: 'r1' } });
    expect(workflowConflict(new ApiError('x', 409, { code: 'other' }))).toBeNull();
    expect(workflowConflict(new ApiError('x', 500, { code: 'stale_revision' }))).toBeNull();
    expect(workflowConflict(new Error('x'))).toBeNull();
  });
});

const summary = (over: Partial<OutreachSummary>): OutreachSummary => ({
  outreachId: 'o1',
  vendorName: 'Ace Plumbing',
  initiation: 'policy_auto_start',
  state: 'sent',
  scheduledFor: null,
  sentAt: '2026-10-21T09:00:00Z',
  updatedAt: '2026-10-21T09:00:00Z',
  responseStatus: null,
  ...over,
});

describe('outreachLine', () => {
  const now = new Date('2026-10-21T10:00:00Z');
  it('distinguishes scheduled, sent, failed, unconfirmed and responded', () => {
    expect(outreachLine(summary({ state: 'scheduled', scheduledFor: '2026-10-21T12:00:00Z' }), now)?.label).toMatch(
      /^Auto: outreach to Ace Plumbing scheduled for /
    );
    expect(outreachLine(summary({ state: 'scheduled', scheduledFor: '2026-10-21T08:00:00Z' }), now)?.label).toContain(
      'not yet confirmed sent'
    );
    const sent = outreachLine(summary({}), now)!;
    expect(sent.label).toContain('sent');
    expect(sent.label).toContain('awaiting reply');
    expect(sent.label).not.toMatch(/read|viewed|opened/i);
    expect(outreachLine(summary({ state: 'failed' }), now)).toMatchObject({ tone: 'danger', testState: 'failed' });
    expect(outreachLine(summary({ state: 'unconfirmed' }), now)?.label).toContain('delivery not verified');
    expect(outreachLine(summary({ state: 'responded', responseStatus: 'accepted' }), now)).toMatchObject({
      label: 'Auto: Ace Plumbing accepted',
      tone: 'success',
      testState: 'accepted',
    });
  });

  it('never reads a decline, expiry or closure as success', () => {
    const declined = outreachLine(summary({ state: 'responded', responseStatus: 'declined' }), now)!;
    expect(declined).toMatchObject({ label: 'Auto: Ace Plumbing declined', testState: 'declined' });
    expect(declined.tone).not.toBe('success');
    for (const state of ['responded', 'closed'] as const) {
      // Legacy servers send expiry/revocation/supersession as `responded`.
      const expired = outreachLine(summary({ state, responseStatus: 'expired' }), now)!;
      expect(expired).toMatchObject({ label: 'Auto: outreach to Ace Plumbing expired — no reply', tone: 'neutral', testState: 'expired' });
      expect(outreachLine(summary({ state, responseStatus: 'superseded' }), now)).toMatchObject({
        label: 'Auto: outreach to Ace Plumbing closed — replaced by a newer attempt',
        testState: 'closed',
      });
      expect(outreachLine(summary({ state, responseStatus: 'revoked' }), now)).toMatchObject({
        label: 'Auto: outreach to Ace Plumbing closed — withdrawn',
        testState: 'closed',
      });
      for (const status of ['expired', 'superseded', 'revoked']) {
        const line = outreachLine(summary({ state, responseStatus: status }), now)!;
        expect(line.tone).not.toBe('success');
        expect(line.label).not.toMatch(/responded/);
      }
    }
    expect(outreachState(summary({ state: 'responded', responseStatus: 'expired' }))).toBe('closed');
    expect(outreachState(summary({ state: 'responded', responseStatus: 'declined' }))).toBe('responded');
  });

  it('labels manual and legacy outreach without claiming automation', () => {
    expect(outreachLine(summary({ initiation: 'landlord' }), now)?.label).toMatch(/^Manual: /);
    expect(outreachLine(summary({ initiation: 'unknown', state: 'failed' }), now)?.label).toBe(
      'Outreach to Ace Plumbing failed to send'
    );
    expect(outreachLine(summary({ initiation: 'policy_auto_advance' }), now)?.label).toMatch(/^Auto \(next vendor\): /);
    expect(outreachLine(null, now)).toBeNull();
  });

  it('adds one entry, placed by its recorded time', () => {
    const items = [{ id: 'a', at: '2026-10-20T00:00:00Z' }];
    expect(withOutreachActivity(items, null)).toEqual(items);
    const merged = withOutreachActivity(items, summary({}));
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ id: 'outreach-summary-o1', title: 'Vendor outreach', at: '2026-10-21T09:00:00Z' });
  });
});

const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe('activity order', () => {
  it('puts an old decline below the payment and completion that followed it', () => {
    const decline = summary({
      state: 'responded',
      responseStatus: 'declined',
      sentAt: '2026-10-19T14:00:00Z',
      updatedAt: '2026-10-19T15:30:00Z',
      eventAt: '2026-10-19T15:30:00Z',
    });
    const items = [
      { id: 'completed', at: '2026-10-20T18:00:00.000Z' },
      { id: 'paid', at: '2026-10-20T17:45:00.000Z' },
      { id: 'assigned', at: '2026-10-19T20:00:00.000Z' },
    ];
    expect(ids(withOutreachActivity(items, decline))).toEqual(['completed', 'paid', 'assigned', 'outreach-summary-o1']);
  });

  it('puts a derived expiry at 00:49:08 below audits at 00:49:11, by milliseconds', () => {
    const expiry = summary({
      state: 'closed',
      responseStatus: 'expired',
      updatedAt: '2026-10-22T00:49:08.000Z',
      eventAt: '2026-10-22T00:49:08.000Z',
    });
    const audits = [
      { id: 'escalated', at: '2026-10-22T00:49:11.200Z' },
      { id: 'exhausted', at: '2026-10-22T00:49:11.100Z' },
    ];
    expect(ids(withOutreachActivity([...audits].reverse(), expiry))).toEqual([
      'escalated',
      'exhausted',
      'outreach-summary-o1',
    ]);
  });

  it('falls back to the state’s recorded field for a legacy envelope with no eventAt', () => {
    expect(outreachEventAt(summary({ state: 'responded', responseStatus: 'expired', sentAt: '2026-10-21T01:00:00Z', updatedAt: '2026-10-22T00:49:08Z' }))).toBe(
      '2026-10-22T00:49:08Z'
    );
    expect(outreachEventAt(summary({ state: 'responded', responseStatus: 'declined', respondedAt: '2026-10-19T15:00:00Z', updatedAt: '2026-10-20T00:00:00Z' }))).toBe(
      '2026-10-19T15:00:00Z'
    );
    expect(outreachEventAt(summary({ state: 'sent', sentAt: '2026-10-21T09:00:00Z', updatedAt: '2026-10-21T09:05:00Z' }))).toBe(
      '2026-10-21T09:00:00Z'
    );
    // A real reply with no respondedAt still falls back to updatedAt.
    expect(outreachEventAt(summary({ state: 'responded', responseStatus: 'accepted', respondedAt: null, updatedAt: '2026-10-20T00:00:00Z' }))).toBe(
      '2026-10-20T00:00:00Z'
    );
    // An invalid eventAt is ignored, not trusted.
    expect(outreachEventAt(summary({ eventAt: 'not-a-date', sentAt: '2026-10-21T09:00:00Z' }))).toBe('2026-10-21T09:00:00Z');
  });

  it('dates a closed attempt by updatedAt, not an older respondedAt left on the row', () => {
    const oldReply = '2026-10-19T15:30:00.000Z';
    const closedLater = '2026-10-21T09:00:00.000Z';
    const legacyRevoked = summary({ state: 'responded', responseStatus: 'revoked', respondedAt: oldReply, updatedAt: closedLater });
    const nativeSuperseded = summary({ state: 'closed', responseStatus: 'superseded', respondedAt: oldReply, updatedAt: closedLater });
    for (const closed of [legacyRevoked, nativeSuperseded]) {
      expect(outreachEventAt(closed)).toBe(closedLater);
      const items = [
        { id: 'between', at: '2026-10-20T12:00:00.000Z' },
        { id: 'before', at: '2026-10-19T12:00:00.000Z' },
      ];
      expect(ids(withOutreachActivity(items, closed))).toEqual(['outreach-summary-o1', 'between', 'before']);
    }
    // A valid eventAt still wins.
    expect(outreachEventAt({ ...nativeSuperseded, eventAt: '2026-10-21T10:00:00.000Z' })).toBe('2026-10-21T10:00:00.000Z');
    // With no updatedAt, a closed attempt has no recorded time rather than the stale reply.
    expect(outreachEventAt({ ...legacyRevoked, updatedAt: null })).toBeNull();
  });

  it('never dates an entry by a future schedule or the current time', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const scheduled = summary({ state: 'scheduled', scheduledFor: future, sentAt: null, updatedAt: '2026-10-21T08:00:00Z' });
    expect(outreachEventAt(scheduled)).toBe('2026-10-21T08:00:00Z');
    const items = [{ id: 'queued', at: '2026-10-21T09:00:00Z' }];
    expect(ids(withOutreachActivity(items, scheduled))).toEqual(['queued', 'outreach-summary-o1']);

    const unrecorded = summary({ state: 'scheduled', scheduledFor: future, sentAt: null, updatedAt: null });
    expect(outreachEventAt(unrecorded)).toBeNull();
    const merged = withOutreachActivity(items, unrecorded);
    expect(ids(merged)).toEqual(['queued', 'outreach-summary-o1']);
    expect(merged[1].at).toBe('');
  });

  it('sorts by millisecond, keeps equal times in input order, and puts missing/invalid times last', () => {
    const items = [
      { id: 'missing', at: '' },
      { id: 'tie-a', at: '2026-10-22T00:49:11.100Z' },
      { id: 'later-ms', at: '2026-10-22T00:49:11.101Z' },
      { id: 'invalid', at: 'garbage' },
      { id: 'tie-b', at: '2026-10-22T00:49:11.100Z' },
      { id: 'older', at: '2026-10-22T00:49:11Z' },
    ];
    const sorted = sortActivityNewestFirst(items);
    expect(ids(sorted)).toEqual(['later-ms', 'tie-a', 'tie-b', 'older', 'missing', 'invalid']);
    // Deterministic: the same input always gives the same output, and the input is untouched.
    expect(ids(sortActivityNewestFirst(items))).toEqual(ids(sorted));
    expect(items[0].id).toBe('missing');
    expect(activityTime('2026-10-22T00:49:11.101Z')! - activityTime('2026-10-22T00:49:11.100Z')!).toBe(1);
    expect(activityTime(null)).toBeNull();
    expect(activityTime('nope')).toBeNull();
  });
});

describe('terminal requests', () => {
  it('treats completed, rejected, cancelled and archived as terminal', () => {
    for (const status of ['completed', 'rejected', 'cancelled', 'archived']) expect(isTerminalRequest({ status })).toBe(true);
    expect(isTerminalRequest({ status: 'assigned', archivedAt: '2026-10-21T00:00:00Z' })).toBe(true);
    expect(isTerminalRequest({ status: 'in_progress', lifecycleStatus: 'completed' })).toBe(true);
    for (const status of ['queued', 'approved', 'needs_vendor', 'assigned', 'in_progress']) {
      expect(isTerminalRequest({ status })).toBe(false);
    }
  });
});

describe('newSubmissionId', () => {
  it('is uuid shaped and unique', () => {
    const a = newSubmissionId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newSubmissionId()).not.toBe(a);
  });
});

describe('createSubmissionKey', () => {
  it('reuses the id for an unchanged retry and rotates it when the content changes', () => {
    const key = createSubmissionKey();
    const first = key.idFor({ body: 'a' });
    expect(key.idFor({ body: 'a' })).toBe(first);
    const edited = key.idFor({ body: 'b' });
    expect(edited).not.toBe(first);
    expect(key.idFor({ body: 'b' })).toBe(edited);
    key.reset();
    expect(key.idFor({ body: 'b' })).not.toBe(edited);
  });

  it('keeps a seeded id while the seeded content is unchanged', () => {
    const key = createSubmissionKey({ id: 'seeded-id-123', payload: { body: 'carried' } });
    expect(key.idFor({ body: 'carried' })).toBe('seeded-id-123');
    expect(key.idFor({ body: 'carried, edited' })).not.toBe('seeded-id-123');
  });
});

describe('follow-up questions', () => {
  const fu = (questions: IntakeFollowUp['questions'], state: IntakeFollowUp['state'] = 'awaiting_answers'): IntakeFollowUp => ({
    revision: 1, state, questions, answers: [], submittedAt: null, reviewedAt: null, remainingTopics: [],
  });
  it('asks unknown/declined again only prefilled, never a known fact', () => {
    const f = fu([
      { topicId: 'location', question: 'Where?', state: 'answered', value: 'Kitchen' },
      { topicId: 'timeline', question: 'When?', state: 'unknown', value: '' },
      { topicId: 'impact', question: 'Impact?', state: 'missing', value: '' },
    ]);
    const qs = outstandingQuestions(f);
    expect(qs.map((q) => q.topicId)).toEqual(['timeline', 'impact']);
    expect(emptyIntakeDraft(qs)).toEqual({ timeline: { state: 'unknown', value: '' }, impact: { state: null, value: '' } });
    expect(incompleteTopics(qs, emptyIntakeDraft(qs))).toEqual(['impact']);
  });
  it('offers unknown/declined facts for voluntary revision in any state', () => {
    const f = fu(
      [
        { topicId: 'timeline', question: 'When?', state: 'unknown', value: '' },
        { topicId: 'impact', question: 'Impact?', state: 'declined', value: '' },
        { topicId: 'location', question: 'Where?', state: 'answered', value: 'Kitchen' },
      ],
      'reviewed'
    );
    expect(revisableQuestions(f).map((q) => q.topicId)).toEqual(['timeline', 'impact']);
    expect(revisableQuestions(null)).toEqual([]);
  });
});

describe('safety review state', () => {
  it('is pending until reviewedAt, even when kept urgent', () => {
    expect(safetyPendingReview({ state: 'needs_review', revision: 1 })).toBe(true);
    expect(safetyPendingReview({ state: 'confirmed_hazard', revision: 1 })).toBe(true);
    expect(safetyPendingReview({ state: 'needs_review', revision: 2, reviewedAt: '2026-10-21T10:00:00Z' })).toBe(false);
    expect(safetyPendingReview({ state: 'none', revision: 2 })).toBe(false);
  });
  it('labels a reviewed concern for the tenant without saying it is awaiting review', () => {
    expect(tenantSafetyLabel({ state: 'needs_review', revision: 1 })).toBe('Urgent safety concern — awaiting review');
    expect(tenantSafetyLabel({ state: 'needs_review', revision: 2, reviewedAt: '2026-10-21T10:00:00Z' })).toBe(
      'Urgent safety concern — reviewed by your property manager'
    );
    expect(tenantSafetyLabel({ state: 'none', revision: 2 })).toBeNull();
  });
});
