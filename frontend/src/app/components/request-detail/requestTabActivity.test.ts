import { describe, expect, it } from 'vitest';
import {
  getTabActivity,
  getTabIndicators,
  isRoutingActionType,
  seenMarkFor,
} from './requestTabActivity';
import type { RequestAuditLog, RequestDetailRecord } from './requestDetailTypes';

const at = (iso: string) => Date.parse(iso);

const request = (overrides: Partial<RequestDetailRecord> = {}) =>
  ({
    _id: 'r1',
    status: 'approved',
    comments: [],
    timeline: [],
    vendorRecommendationSnapshot: null,
    ...overrides,
  }) as unknown as RequestDetailRecord;

const log = (actionType: string, createdAt: string) =>
  ({ _id: actionType, requestId: 'r1', actor: 'system', actionType, summary: '', createdAt }) as RequestAuditLog;

describe('isRoutingActionType', () => {
  it('counts vendor, outreach, booking and approval events as routing', () => {
    for (const type of ['vendor_outreach_closed', 'appointment_updated', 'manager_approved_contact', 'request_quota_increase']) {
      expect(isRoutingActionType(type)).toBe(true);
    }
  });

  it('leaves money and comments to the Activity tab', () => {
    for (const type of ['ledger_deposit', 'comment_added', 'request_triaged']) {
      expect(isRoutingActionType(type)).toBe(false);
    }
  });
});

describe('getTabActivity', () => {
  it('reads each tab from data the page already has', () => {
    const activity = getTabActivity(
      request({
        comments: [
          { authorId: 't', authorRole: 'tenant', body: 'Still leaking', at: '2026-10-05T10:00:00Z' },
          { authorId: 'l', authorRole: 'landlord', body: 'On it', at: '2026-10-05T11:00:00Z' },
        ],
        timeline: [{ status: 'approved', at: '2026-10-05T09:00:00Z' }],
        vendorRecommendationSnapshot: { lastRound: { at: '2026-10-05T12:00:00Z' } },
      }),
      [log('ledger_deposit', '2026-10-05T13:00:00Z'), log('vendor_outreach_viewed', '2026-10-05T08:00:00Z')]
    );
    expect(activity.messages).toEqual([at('2026-10-05T10:00:00Z')]);
    expect(activity.routing).toBe(at('2026-10-05T12:00:00Z'));
    expect(activity.activity).toBe(at('2026-10-05T13:00:00Z'));
  });
});

describe('getTabIndicators', () => {
  const activity = { routing: 200, messages: [100, 300, 400], activity: 50 };

  it('marks what changed since each tab was opened, and counts new messages', () => {
    expect(getTabIndicators(activity, { routing: 150, messages: 250, activity: 50 })).toEqual({
      routing: true,
      messages: 2,
      activity: false,
    });
  });

  it('shows nothing until the stored marks have loaded', () => {
    expect(getTabIndicators(activity, null)).toEqual({ routing: false, messages: 0, activity: false });
  });
});

describe('seenMarkFor', () => {
  it('never marks earlier than the newest item, whatever this clock says', () => {
    const activity = { routing: 5_000, messages: [9_000], activity: 0 };
    expect(seenMarkFor('routing', activity, 1_000)).toBe(5_000);
    expect(seenMarkFor('messages', activity, 1_000)).toBe(9_000);
    expect(seenMarkFor('activity', activity, 1_000)).toBe(1_000);
  });
});
