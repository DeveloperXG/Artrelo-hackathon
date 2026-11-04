import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { CreationGateNotice, NewRequestButton } from './tenant/NewRequestGate';
import IntakeFollowUpForm from './tenant/IntakeFollowUpForm';
import IntakeSafetyReviewPanel from './request-detail/IntakeSafetyReviewPanel';
import RequestWorkflowLines from './landlord/RequestWorkflowLines';
import type { RequestDetailRecord } from './request-detail/requestDetailTypes';
import type { IntakeFollowUp } from '../types/requestWorkflow';

const noop = () => {};
const inRouter = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

describe('New Request gate', () => {
  it('greys the button unless the server allowed a routine request', () => {
    for (const gate of [{ status: 'loading' as const }, { status: 'error' as const }]) {
      expect(renderToStaticMarkup(<NewRequestButton gate={gate} linked onClick={noop} />)).toContain('disabled=""');
    }
    const blocked = { status: 'blocked' as const, reasons: ['open_cap' as const], message: 'At cap' };
    expect(renderToStaticMarkup(<NewRequestButton gate={blocked} linked onClick={noop} />)).toContain('disabled=""');
    expect(renderToStaticMarkup(<NewRequestButton gate={{ status: 'allowed' }} linked={false} onClick={noop} />)).toContain(
      'disabled=""'
    );
    expect(renderToStaticMarkup(<NewRequestButton gate={{ status: 'allowed' }} linked onClick={noop} />)).not.toContain(
      'disabled=""'
    );
  });

  it('offers Retry on a failed check and the safety form when blocked', () => {
    expect(inRouter(<CreationGateNotice gate={{ status: 'error' }} onRetry={noop} />)).toContain('creation-gate-retry');
    const html = inRouter(
      <CreationGateNotice gate={{ status: 'blocked', reasons: ['daily_limit'], message: 'Daily limit.' }} onRetry={noop} />
    );
    expect(html).toContain('Daily limit.');
    expect(html).toContain('href="/portal/safety"');
    // No unit, no safety form either: the server requires a linked unit.
    expect(
      inRouter(<CreationGateNotice gate={{ status: 'blocked', reasons: ['unit_unlinked'], message: 'x' }} onRetry={noop} />)
    ).not.toContain('/portal/safety');
    expect(inRouter(<CreationGateNotice gate={{ status: 'allowed' }} onRetry={noop} />)).toBe('');
  });

  it('can leave the safety link to a page that already shows one', () => {
    for (const reason of ['open_cap', 'daily_limit', 'weekly_limit'] as const) {
      const html = inRouter(
        <CreationGateNotice gate={{ status: 'blocked', reasons: [reason], message: 'Limit.' }} onRetry={noop} showSafetyLink={false} />
      );
      expect(html).toContain('Limit.');
      expect(html).not.toContain('safety-concern-link');
    }
  });
});

const followUp = (over: Partial<IntakeFollowUp> = {}): IntakeFollowUp => ({
  revision: 1,
  state: 'awaiting_answers',
  questions: [
    { topicId: 'location', question: 'Where is it?', state: 'answered', value: 'Bathroom' },
    { topicId: 'timeline', question: 'When did it start?', state: 'missing', value: '' },
  ],
  answers: [],
  submittedAt: null,
  reviewedAt: null,
  remainingTopics: ['timeline'],
  ...over,
});

const record = (over: Partial<RequestDetailRecord> = {}): RequestDetailRecord => ({
  _id: 'req1',
  issueTitle: 'Leak',
  issueDescription: 'Water under sink',
  status: 'queued',
  urgency: 'medium',
  category: 'Plumbing',
  createdAt: '2026-10-21T00:00:00Z',
  vendorRecommendationSnapshot: null,
  ...over,
});

describe('Add missing details', () => {
  it('asks only the missing questions with unknown/declined choices', () => {
    const html = renderToStaticMarkup(<IntakeFollowUpForm request={record({ intakeFollowUp: followUp() })} onRequestReplaced={noop} />);
    expect(html).toContain('Add missing details');
    expect(html).toContain('When did it start?');
    expect(html).not.toContain('Where is it?');
    expect(html).toContain('intake-timeline-unknown');
    expect(html).toContain('intake-timeline-declined');
    expect(html).toContain('Send details');
  });

  it('shows the waiting-for-review state after sending, and nothing when none are owed', () => {
    const unknownTimeline = [{ topicId: 'timeline' as const, question: 'When?', state: 'unknown' as const, value: '' }];
    const sent = renderToStaticMarkup(
      <IntakeFollowUpForm
        request={record({ intakeFollowUp: followUp({ state: 'ready_for_review', submittedAt: '2026-10-21T10:00:00Z', questions: unknownTimeline }) })}
        onRequestReplaced={noop}
      />
    );
    expect(sent).toContain('Details sent');
    expect(sent).toContain('review them before anything else happens');
    expect(sent).toContain('Not sure');
    // An unknown fact can still be supplied voluntarily before vendor contact.
    expect(sent).toContain('intake-followup-revise');
    // Ready without the tenant ever sending (intake already settled every topic as unknown).
    const fromReport = renderToStaticMarkup(
      <IntakeFollowUpForm
        request={record({ intakeFollowUp: followUp({ state: 'ready_for_review', submittedAt: null, questions: unknownTimeline }) })}
        onRequestReplaced={noop}
      />
    );
    expect(fromReport).toContain('Details from your report');
    expect(fromReport).not.toContain('Details sent');
    expect(renderToStaticMarkup(<IntakeFollowUpForm request={record({ intakeFollowUp: null })} onRequestReplaced={noop} />)).toBe('');
  });
});

describe('Landlord review panel', () => {
  it('works with no vendor snapshot and requires a reason for uncertain details', () => {
    const html = renderToStaticMarkup(
      <IntakeSafetyReviewPanel
        request={record({
          intakeFollowUp: followUp({ state: 'ready_for_review', remainingTopics: ['timeline'], questions: [{ topicId: 'timeline', question: 'When?', state: 'declined', value: '' }] }),
        })}
        onRequestReplaced={noop}
      />
    );
    expect(html).toContain('intake-review');
    expect(html).toContain('intake-review-reason');
    expect(html).toContain('Can’t safely check / prefer not to say');
  });

  it('holds a safety concern for a human decision with both dispositions', () => {
    const html = renderToStaticMarkup(
      <IntakeSafetyReviewPanel
        request={record({ safetyAssessment: { state: 'needs_review', revision: 2, provenance: ['tenant', 'model'], ruleCodes: [] } })}
        onRequestReplaced={noop}
      />
    );
    expect(html).toContain('Urgent safety concern — needs your review');
    expect(html).toContain('Raised by the tenant, the AI intake');
    expect(html).toContain('safety-retain-urgent');
    expect(html).toContain('safety-classify-routine');
    expect(html).toContain('Nothing is sent to a vendor until you decide');
  });

  it('renders nothing when nothing is held', () => {
    expect(renderToStaticMarkup(<IntakeSafetyReviewPanel request={record()} onRequestReplaced={noop} />)).toBe('');
  });
});

describe('Row workflow lines', () => {
  it('shows safety, details and outreach quietly', () => {
    const html = renderToStaticMarkup(
      <RequestWorkflowLines
        request={{
          _id: 'r1',
          safetyAssessment: { state: 'needs_review', revision: 1, provenance: ['model'], ruleCodes: [] },
          intakeFollowUp: followUp({ state: 'ready_for_review' }),
          outreachSummary: {
            outreachId: 'o1',
            vendorName: 'Ace',
            initiation: 'landlord',
            state: 'failed',
            scheduledFor: null,
            sentAt: null,
            updatedAt: null,
            responseStatus: null,
          },
        }}
      />
    );
    expect(html).toContain('Safety concern — needs your review');
    expect(html).toContain('Tenant details to review');
    expect(html).toContain('Manual: outreach to Ace failed to send');
    expect(renderToStaticMarkup(<RequestWorkflowLines request={{ _id: 'r2' }} />)).toBe('');
  });

  it('drops the outreach line on finished requests but keeps the rest', () => {
    const declined = {
      outreachId: 'o1',
      vendorName: 'Ace',
      initiation: 'policy_auto_start' as const,
      state: 'responded' as const,
      scheduledFor: null,
      sentAt: '2026-10-19T14:00:00Z',
      updatedAt: '2026-10-19T15:30:00Z',
      responseStatus: 'declined',
    };
    for (const over of [{ status: 'completed' }, { status: 'rejected' }, { status: 'cancelled' }, { status: 'queued', archivedAt: '2026-10-21T00:00:00Z' }]) {
      expect(renderToStaticMarkup(<RequestWorkflowLines request={{ _id: 'r1', outreachSummary: declined, ...over }} />)).toBe('');
      const withSafety = renderToStaticMarkup(
        <RequestWorkflowLines
          request={{ _id: 'r1', outreachSummary: declined, safetyAssessment: { state: 'needs_review', revision: 1, provenance: ['model'], ruleCodes: [] }, ...over }}
        />
      );
      expect(withSafety).toContain('Safety concern');
      expect(withSafety).not.toContain('row-outreach-r1');
    }
    const live = renderToStaticMarkup(<RequestWorkflowLines request={{ _id: 'r1', status: 'needs_vendor', outreachSummary: declined }} />);
    expect(live).toContain('Auto: Ace declined');
    expect(live).not.toContain('text-emerald');
  });
});
