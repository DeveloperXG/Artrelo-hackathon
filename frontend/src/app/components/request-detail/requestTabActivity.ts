import type { RequestAuditLog, RequestDetailRecord, RequestDetailTab } from './requestDetailTypes';

/** The tabs that can show "something new here". Overview is the report itself. */
export type ActivityTab = Exclude<RequestDetailTab, 'overview' | 'work'>;

export type TabSeen = Record<ActivityTab, number>;

export interface TabActivity {
  /** Latest routing change: a search, a vendor's answer, a booking, an approval. */
  routing: number;
  /** When each message from someone other than the landlord arrived. */
  messages: number[];
  /** Latest entry of any kind on the Activity tab. */
  activity: number;
}

export interface TabIndicators {
  routing: boolean;
  /** Messages arrived since the landlord last opened the tab. */
  messages: number;
  activity: boolean;
}

// Audit entries that change what the Vendor Routing tab shows. Prefixes cover
// the families (vendor_outreach_*, appointment_*, manager_* ...); the set is
// the routing approvals, whose names don't share one.
const ROUTING_ACTION_PREFIXES = ['vendor_', 'vendors_', 'manager_', 'manual_vendor_', 'appointment_', 'routing_', 'recommend'];
const ROUTING_ACTION_TYPES = new Set([
  'approval_requested',
  'request_vendor_contact_approval',
  'request_first_time_vendor_approval',
  'request_quota_increase',
  'quota_change',
]);

export function isRoutingActionType(actionType = '') {
  return ROUTING_ACTION_TYPES.has(actionType) || ROUTING_ACTION_PREFIXES.some((prefix) => actionType.startsWith(prefix));
}

const time = (value?: string | null) => {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : 0;
};

/**
 * When each tab last changed, from data the page already loads: comments,
 * the lifecycle timeline, the audit log, and the routing snapshot's own
 * timestamps. No new endpoint -- the dots are as fresh as the page's data.
 */
export function getTabActivity(request: RequestDetailRecord, auditLogs: RequestAuditLog[]): TabActivity {
  const snapshot = request.vendorRecommendationSnapshot;
  const routing = Math.max(
    0,
    time(snapshot?.generatedAt),
    time(snapshot?.lastRound?.at),
    time(snapshot?.lastManagerAction?.at),
    ...auditLogs.filter((log) => isRoutingActionType(log.actionType)).map((log) => time(log.createdAt))
  );
  const messages = (request.comments || [])
    .filter((comment) => comment.authorRole !== 'landlord')
    .map((comment) => time(comment.at))
    .filter(Boolean);
  const activity = Math.max(
    0,
    ...(request.timeline || []).map((event) => time(event.at)),
    ...auditLogs.map((log) => time(log.createdAt))
  );
  return { routing, messages, activity };
}

/** What is new on each tab since it was last opened. */
export function getTabIndicators(activity: TabActivity, seen: TabSeen | null): TabIndicators {
  if (!seen) return { routing: false, messages: 0, activity: false };
  return {
    routing: activity.routing > seen.routing,
    messages: activity.messages.filter((at) => at > seen.messages).length,
    activity: activity.activity > seen.activity,
  };
}

/**
 * The "seen" mark for a tab being opened now. Never earlier than the newest
 * thing on it: server timestamps can run ahead of this browser's clock, and a
 * mark of Date.now() would then leave a dot on the tab the landlord is looking at.
 */
export function seenMarkFor(tab: ActivityTab, activity: TabActivity, now = Date.now()) {
  const latest = tab === 'messages' ? Math.max(0, ...activity.messages) : activity[tab];
  return Math.max(now, latest);
}
