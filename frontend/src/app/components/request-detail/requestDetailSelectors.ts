import type {
  AvailabilitySlot,
  CostDisplay,
  HeroMetric,
  PriceEstimate,
  RequestActivityItem,
  RequestAuditLog,
  RequestDetailRecord,
  TimelineEvent,
  RequestWorkflowStage,
  RequestWorkflowStageKey,
  RoutingGuidance,
  VendorRecommendationCandidate,
  VendorRecommendationSnapshot,
} from './requestDetailTypes';
import { WORKFLOW_STEPS } from './requestDetailTypes';
import { sortActivityNewestFirst } from '../../lib/requestWorkflow';

// Values are DETAIL_STATUS_COLORS keys, not colours.
const AUDIT_ACTION_COLORS: Record<string, string> = {
  vendor_contact_approved: 'approved',
  quota_increase_approved: 'approved',
  first_time_vendor_approved: 'approved',
  manual_vendor_selected: 'assigned',
  request_rejected: 'rejected',
  request_appealed: 'appeal_pending',
  request_appeal_accepted: 'approved',
  request_rejection_withdrawn: 'queued',
  request_approved: 'approved',
  request_completed: 'completed',
  // The outreach fallback loop. Uncoloured until now, which made a decline and
  // the re-approval it triggers indistinguishable from routine chatter in the
  // activity feed.
  vendor_response_declined: 'rejected',
  vendor_outreach_closed: 'rejected',
  vendor_outreach_expired: 'cancelled',
  vendor_outreach_exhausted: 'rejected',
  vendor_outreach_escalated: 'rejected',
  vendor_outreach_reapproval_requested: 'queued',
  vendor_outreach_advanced: 'approved',
};

/** Outreach statuses that close a round for a vendor. Mirrors
 *  CLOSED_OUTREACH_STATUSES in backend/controllers/request.controller.js. */
const CLOSED_OUTREACH_STATUSES = new Set(['declined', 'expired', 'superseded', 'revoked']);

const ELIGIBLE_VENDOR_STATES = new Set([
  'recommended',
  'pending',
  'held',
  'approved_for_contact',
  'selected',
]);

const LANDLORD_HEADLINE_LIMIT = 70;
const DEFAULT_ESTIMATE_CURRENCY = 'default';

export function getTimelineActivityItems(timeline: TimelineEvent[] = []): RequestActivityItem[] {
  return timeline.map((event, index) => ({
    id: `timeline-${event.at}-${index}`,
    source: 'lifecycle',
    title: event.status.replace(/_/g, ' '),
    description: event.note,
    actor: event.actorRole,
    at: event.at,
    colorKey: event.status,
  }));
}

export function getLandlordActivityItems(
  timeline: TimelineEvent[] = [],
  auditLogs: RequestAuditLog[] = []
): RequestActivityItem[] {
  const auditItems: RequestActivityItem[] = auditLogs.map((log) => ({
    id: `audit-${log._id}`,
    source: 'audit',
    title: log.actionType.replace(/_/g, ' '),
    description: log.summary,
    actor: log.actor,
    at: log.createdAt,
    colorKey: AUDIT_ACTION_COLORS[log.actionType],
  }));

  // The timeline is stored oldest first and the logs arrive newest first, so
  // reverse the timeline: equal timestamps then keep a newest-first order.
  return sortActivityNewestFirst([...getTimelineActivityItems(timeline).reverse(), ...auditItems]);
}

export function shortenText(text = '', maxLength = 96) {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 3).trim()}...`;
}

/**
 * Condense a summary to whole sentences that fit within maxChars, so the
 * displayed text reads as complete instead of being cut mid-sentence.
 * Falls back to a shortened first sentence when even that exceeds the budget.
 */
export function condenseSummary(text = '', maxChars = 240) {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  const sentences = compact.split(/(?<=[.!?])\s+/);
  let result = '';
  for (const sentence of sentences) {
    const next = result ? `${result} ${sentence}` : sentence;
    if (next.length > maxChars) break;
    result = next;
  }
  return result || shortenText(compact, maxChars);
}

export function getRequestHeadline(request: RequestDetailRecord, isLandlord: boolean | null) {
  if (!isLandlord) {
    if (request.ai?.shortTitle) {
      return `I reported: ${request.ai.shortTitle}`;
    }
    const source =
      request.ai?.summary || request.issueTitle || request.issueDescription || 'Maintenance request';
    // The hero h1 is CSS line-clamped, so a wider viewport shows more of this
    // text before clipping; keep the hard cut generous.
    return `I reported: ${shortenText(source, 160)}`;
  }

  if (request.ai?.shortTitle) {
    const suffix = getLandlordHeadlineSuffix(request);
    return truncateAtWordBoundary(
      `${request.ai.shortTitle} ${suffix}`.trim(),
      LANDLORD_HEADLINE_LIMIT
    );
  }

  const baseSource =
    request.ai?.summary || request.issueTitle || request.issueDescription || 'Maintenance request';
  const normalized = trimHeadlinePunctuation(
    removeHeadlineBoilerplate(
      baseSource
        .split(/(?<=[.!?])\s+/)[0]
        .replace(/\b(indicating a potential)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
    )
  );
  const concise = trimHeadlinePunctuation(
    normalized.replace(
      /\b(since|started|began|about|for|from|when|while)\b[\s\S]*$/i,
      ''
    )
  );
  const suffix = getLandlordHeadlineSuffix(request);
  const headlineBase = concise || trimHeadlinePunctuation(normalized) || 'Maintenance request';
  return truncateAtWordBoundary(`${headlineBase} ${suffix}`.trim(), LANDLORD_HEADLINE_LIMIT);
}

export function getPropertyLabel(request: RequestDetailRecord) {
  return typeof request.propertyId === 'object' ? request.propertyId?.name || '' : '';
}

export function getPropertyAddress(request: RequestDetailRecord) {
  return typeof request.propertyId === 'object' ? request.propertyId?.address || '' : '';
}

export function getUnitLabel(request: RequestDetailRecord) {
  return typeof request.unitId === 'object' && request.unitId?.unitNumber
    ? `Unit ${request.unitId.unitNumber}`
    : '';
}

export function getRequestCostDisplay(request: RequestDetailRecord): CostDisplay {
  return getRequestCostDisplayWithOptions(request);
}

export function getRequestCostDisplayWithOptions(
  request: RequestDetailRecord,
  options: { preferEligibleAverage?: boolean } = {}
): CostDisplay {
  // Requests default to finalCost: 0 before work is verified. Only a completed
  // request owns a final cost; zero remains valid for completed warranty work.
  if (request.status === 'completed' && typeof request.finalCost === 'number' && Number.isFinite(request.finalCost)) {
    return { label: 'Final cost', value: `$${request.finalCost.toFixed(2)}` };
  }
  if (options.preferEligibleAverage) {
    const averageEligibleEstimate = getAverageEligibleVendorEstimate(
      request.vendorRecommendationSnapshot
    );
    if (averageEligibleEstimate) {
      return {
        label: 'Average estimated cost',
        value: formatCurrencyAmount(averageEligibleEstimate.amount),
      };
    }
  }
  if (typeof request.estimatedCost === 'number' && Number.isFinite(request.estimatedCost) && request.estimatedCost > 0) {
    return { label: 'Estimated cost', value: `$${request.estimatedCost.toFixed(2)}` };
  }
  return { label: 'Estimated cost', value: 'Pending' };
}

/** A network vendor has no estimate until they've been paid for this trade —
 *  shown as an em dash, not a made-up range. */
export function formatPriceEstimate(priceEstimate?: { amountLow?: number; amountHigh?: number } | null) {
  if (!priceEstimate) return '—';
  const low = Number(priceEstimate.amountLow || 0);
  const high = Number(priceEstimate.amountHigh || 0);
  if (!low && !high) return '—';
  if (low === high) return `$${low}`;
  return `$${low}-${high}`;
}

/** The line under the Estimate value: where the number comes from. */
export function getEstimateHint(priceEstimate?: PriceEstimate | null) {
  if (!priceEstimate) return 'No paid jobs for this trade yet';
  if (priceEstimate.basis === 'paid_job_average' && priceEstimate.sampleSize) {
    return `Avg of ${priceEstimate.sampleSize} paid job${priceEstimate.sampleSize === 1 ? '' : 's'}`;
  }
  return null;
}

export function formatSlotLabel(slot: AvailabilitySlot) {
  if (slot.label) return slot.label;
  if (slot.start) return new Date(slot.start).toLocaleString();
  return 'Availability pending';
}

/**
 * The Availability pill. Slots are previewed when recommendations are
 * generated and the snapshot can be days old, so a slot that has already
 * started is skipped; with none left, the vendor's hours stand in.
 */
export function getAvailabilityDisplay(
  candidate: Pick<VendorRecommendationCandidate, 'availabilitySlots' | 'hoursLabel' | 'sendTiming'>,
  now: Date = new Date()
): { value: string; hint: string | null } {
  // Live from the server: is the vendor open right now, and if not, when? This
  // is what decides whether Approve contact sends now or schedules, so it leads.
  // The first offered window used to lead instead, which for a 24/7 vendor read
  // as a narrow slot rather than "available any time".
  const timing = candidate.sendTiming;
  const hours = timing?.hoursLabel || candidate.hoursLabel || null;
  if (timing) {
    if (timing.openNow) return { value: 'Open now', hint: hours };
    return { value: timing.nextOpenLabel ? `Opens ${timing.nextOpenLabel}` : 'Closed now', hint: hours };
  }

  // No live timing (no vendor row behind the candidate): the generate-time
  // preview, skipping slots that have already started.
  const upcoming = (candidate.availabilitySlots || []).find(
    (slot) => !slot.start || new Date(slot.start).getTime() > now.getTime()
  );
  if (upcoming) return { value: formatSlotLabel(upcoming), hint: hours };
  if (hours) return { value: hours, hint: 'Regenerate for fresh time slots' };
  return { value: 'Pending', hint: null };
}

/** The windows a vendor would likely be offered, for the Approve dialog. Only
 *  meaningful for an immediate send — a scheduled one recomputes at delivery. */
export function getOfferPreview(
  candidate: Pick<VendorRecommendationCandidate, 'availabilitySlots'>,
  now: Date = new Date(),
  limit = 3
) {
  return (candidate.availabilitySlots || [])
    .filter((slot) => slot.start && new Date(slot.start).getTime() > now.getTime())
    .slice(0, limit)
    .map(formatSlotLabel);
}

export function formatDecisionLabel(value = '') {
  return value.replace(/_/g, ' ') || 'pending';
}

export interface LiveRoutingAction {
  label: string;
  summary: string;
  /** True only while a decision is genuinely outstanding. */
  approvalPending: boolean;
  tone: 'neutral' | 'pending' | 'good' | 'bad';
  quotaLimit: number | null;
}

/**
 * The routing action as it stands RIGHT NOW.
 *
 * `snapshot.decision` is written once when recommendations are generated and is
 * never updated again — not on contact approval, vendor acceptance, decline,
 * timeout, or quota approval. Rendering it directly means `approvalRequired`
 * stays true forever, so the "Approval needed" badge and "Review in Decisions"
 * button persist long after the decision was resolved.
 *
 * We derive instead of writing back, because the snapshot is a cache and must
 * not become the source of truth (see the outreach architecture notes). Live
 * signals — candidate state, outreach status, quota check, approvalRequest
 * status — take priority over the frozen decision, which is the last resort.
 */
// What vendorQuoteDismissal records when the manager gives no reason. Not a
// reason worth repeating back to them.
const DEFAULT_DISMISS_REASON = 'Dismissed by the property manager';

/**
 * How the round that just closed reads, by why it closed. Everything used to
 * read "X declined", including a quote the MANAGER turned down ("X declined
 * this request -- Dismissed by the property manager"). `verbLong` is the
 * banner's fuller form.
 */
export function describeClosedRound(snapshot?: VendorRecommendationSnapshot | null) {
  const lastRound = snapshot?.lastRound;
  const lastClosed = getLastClosedOutreach(snapshot);
  const name = lastRound?.vendorName || lastClosed?.name || '';
  const rawWhy = lastRound?.detail || lastClosed?.outreach?.decision?.declineReason || '';
  const why = rawWhy === DEFAULT_DISMISS_REASON ? '' : rawWhy;
  // A fresh search carries no lastRound; the outreach row is all there is.
  const reason =
    lastRound?.reason ||
    (lastClosed?.outreach?.status === 'expired'
      ? 'timeout'
      : rawWhy === DEFAULT_DISMISS_REASON
        ? 'manager_dismissed'
        : 'declined');
  const vendor = name || 'The vendor';

  switch (reason) {
    case 'timeout':
    case 'counter_offer_timeout':
      return { name, subject: vendor, verb: 'did not respond in time', verbLong: 'did not respond in time', why };
    case 'manager_dismissed':
      return { name, subject: `${vendor}’s quote`, verb: 'was turned down', verbLong: 'was turned down', why };
    case 'counter_offer_declined':
      return { name, subject: vendor, verb: 'turned down the authorized amount', verbLong: 'turned down the authorized amount', why };
    case 'no_show':
      return { name, subject: vendor, verb: "didn't show up", verbLong: "didn't show up", why };
    case 'tenant_unconfirmed':
      return {
        name,
        subject: `${vendor}’s booking`,
        verb: "wasn't confirmed by the tenant in time",
        verbLong: "wasn't confirmed by the tenant in time",
        why,
      };
    case 'delivery_failed':
      return { name, subject: vendor, verb: "couldn't be emailed", verbLong: "couldn't be emailed", why };
    default:
      return { name, subject: vendor, verb: 'declined', verbLong: 'declined this request', why };
  }
}

export function getLiveRoutingAction(request: RequestDetailRecord): LiveRoutingAction {
  const snapshot = request.vendorRecommendationSnapshot;
  const decision = snapshot?.decision;
  const candidate = getActiveVendorCandidate(request);
  const outreach = candidate?.outreach;
  const quotaLimit = request.quotaOverride ?? decision?.quotaLimit ?? null;

  const base = (
    label: string,
    summary: string,
    tone: LiveRoutingAction['tone'] = 'neutral',
    approvalPending = false
  ): LiveRoutingAction => ({ label, summary, tone, approvalPending, quotaLimit });

  if (request.status === 'completed') {
    return base('Completed', 'This request is closed. No further routing is needed.', 'good');
  }
  if (request.status === 'rejected' && request.appeal?.state === 'pending') {
    return base(
      'Appeal pending',
      'The tenant appealed the rejection. Accept or decline it on the Overview tab.',
      'pending',
      true
    );
  }
  if (request.status === 'rejected') {
    return base('Rejected', 'The request was rejected. Routing is halted.', 'bad');
  }
  if (request.status === 'cancelled') {
    return base('Cancelled', 'The request was cancelled. Routing is halted.', 'bad');
  }

  // The visit happened and the job is in its evidence phase.
  //
  // This outranks every routing branch below, because routing is settled and
  // what the manager needs to know is where the proof stands. Keyed on
  // appointmentStatus rather than the candidate: a manually assigned vendor has
  // no ledger entry to read, and would otherwise fall through to "Vendor
  // selected" for a job whose work is already done and submitted.
  const jobVendorName = getAssignedVendorName(request) || candidate?.name || 'The vendor';
  switch (request.appointmentStatus) {
    case 'work_verifying':
      return base(
        'Completion proof submitted — with the tenant',
        `${jobVendorName} submitted their completion evidence and it passed the automatic checks. The tenant has been asked to confirm the work; if they don't answer in time it auto-confirms, and the payout follows.`,
        'pending'
      );
    case 'in_review':
      // Reached only via completionSweeper's escalation pass, which needs BOTH
      // weak evidence and a tenant who never answered. The tenant has therefore
      // already been asked — saying otherwise (as this did when the review was
      // raised at submit) describes a flow that no longer exists.
      return base(
        'Completion needs your review',
        `${jobVendorName} submitted completion evidence that did not pass the automatic checks, and the tenant's review window elapsed without an answer. Nothing is paid until you decide.`,
        'pending',
        true
      );
    case 'disputed':
      // Deliberately not approvalPending: a dispute raises no ApprovalRequest,
      // so pointing at Decisions would send the manager to an empty page.
      return base(
        'Completion disputed',
        `The tenant rejected the completion evidence from ${jobVendorName}. The job is stalled and the payout stays held until this is settled with the vendor.`,
        'bad'
      );
    default:
      break;
  }

  if (candidate?.state === 'selected') {
    const vendor = candidate.name;
    if (request.appointmentStatus === 'scheduled') {
      return base('Scheduled', `${vendor} is booked and the tenant has confirmed the time.`, 'good');
    }
    if (request.appointmentStatus === 'awaiting_tenant') {
      return base(
        'Awaiting tenant confirmation',
        `${vendor} committed to a time. The tenant needs to confirm access before it's final.`,
        'pending'
      );
    }
    if (request.appointmentStatus === 'completed') {
      return base('Visit completed', `${vendor} completed the visit.`, 'good');
    }
    return base('Vendor selected', `${vendor} is assigned to this request.`, 'good');
  }

  // A counter-offer round outranks the over-quota check below: quotaCheck.overQuota
  // stays true forever once set, so without this the banner keeps demanding an
  // approval the manager has already given.
  if (outreach?.counterOffer?.status === 'pending') {
    const amount = outreach.counterOffer.amount;
    return base(
      'Awaiting vendor confirmation',
      `You authorized $${amount ?? '?'}. ${
        candidate?.name ?? 'The vendor'
      } needs to confirm they can do it for that before it books. If they decline we'll move to the next vendor.`,
      'pending'
    );
  }
  if (outreach?.counterOffer?.status === 'declined') {
    return base(
      'Vendor declined the amount — routing on',
      `${candidate?.name ?? 'The vendor'} would not take the authorized $${
        outreach.counterOffer.amount ?? '?'
      }${outreach.counterOffer.declineReason ? `: ${outreach.counterOffer.declineReason}` : ''}.`,
      'bad'
    );
  }

  // An over-quota quote is the one genuinely outstanding decision after outreach.
  if (outreach?.quotaCheck?.overQuota && outreach.decision?.outcome === 'accepted') {
    const quote = outreach.decision.quoteHigh;
    const limit = outreach.quotaCheck.limit ?? quotaLimit;
    // No quota at all is its own sentence — "above the $null limit" is not one.
    if (limit === null || limit === undefined) {
      return base(
        'Quote needs your approval',
        `${candidate?.name ?? 'The vendor'} quoted $${quote ?? '?'}. You haven't set a spending quota, so every quote needs your approval to book.`,
        'pending',
        true
      );
    }
    return base(
      'Quote over quota — approval needed',
      `${candidate?.name ?? 'The vendor'} quoted $${quote ?? '?'}, above the $${limit} limit. Approve the increase to book the appointment.`,
      'pending',
      true
    );
  }

  switch (outreach?.status) {
    case 'accepted':
      return base(
        'Vendor accepted — booking',
        `${candidate?.name ?? 'The vendor'} accepted. Creating the appointment.`,
        'good'
      );
    case 'declined':
      return base(
        'Vendor declined — routing on',
        `${candidate?.name ?? 'The vendor'} declined${
          outreach.decision?.declineReason ? `: ${outreach.decision.declineReason}` : ''
        }.`,
        'bad'
      );
    case 'expired':
      return base(
        'No response — routing on',
        `${candidate?.name ?? 'The vendor'} did not respond in time.`,
        'bad'
      );
    case 'delivery_failed':
      return base(
        'Outreach failed to send',
        `The email to ${candidate?.name ?? 'the vendor'} could not be delivered. Try resending.`,
        'bad'
      );
    case 'scheduled':
      // Nothing has gone to the vendor yet, so "outreach pending" (below)
      // would read as stuck. Say when it goes and that it can be cancelled.
      return base(
        'Outreach scheduled',
        `${candidate?.name ?? 'The vendor'} is closed now. We'll email them${
          candidate?.sendTiming?.scheduledForLabel ? ` ${candidate.sendTiming.scheduledForLabel}` : ' when they open'
        } — cancel the scheduled send below to change plans.`,
        'pending'
      );
    case 'sent':
    case 'viewed':
      return base(
        'Awaiting vendor response',
        `Outreach sent to ${candidate?.name ?? 'the vendor'}. Waiting for them to accept or decline.`,
        'pending'
      );
    default:
      break;
  }

  if (candidate?.state === 'approved_for_contact') {
    return base(
      'Contact approved — outreach pending',
      `Approved to contact ${candidate.name}, but no outreach has been sent yet.`,
      'pending'
    );
  }

  // A round closed and nothing is active yet.
  //
  // retireCandidate moves the answering vendor to `excluded`, which clears
  // activeCandidateKey — so `candidate` is null and every branch above falls
  // through, including the `declined` case, which is therefore unreachable on
  // the normal fallback path. Without this the tile drops to the FROZEN
  // snapshot.decision, or to the resolved first-round approval below, and tells
  // the manager an approval was already granted for a round that is over.
  const lastRound = snapshot?.lastRound;
  const lastClosed = getLastClosedOutreach(snapshot);
  if (!candidate && (lastRound || lastClosed)) {
    const closed = describeClosedRound(snapshot);
    const previousName = closed.subject;
    const verb = closed.verb;
    const because = closed.why ? ` (${closed.why})` : '';

    const nextCandidate = getNextQueuedVendorCandidate(snapshot);
    const nextName = lastRound?.nextVendorName || nextCandidate?.name || null;
    const resolution = lastRound?.resolution || (nextName ? 'awaiting_approval' : 'exhausted');

    const contacted = lastRound?.vendorsContacted;
    const budget = getRoundVendorBudget(lastRound);
    const budgetNote =
      typeof contacted === 'number' && typeof budget === 'number'
        ? ` Vendor ${Math.min(contacted + 1, budget)} of ${budget}.`
        : '';

    if (resolution === 'exhausted') {
      return base(
        // The ways forward live in the Next steps card below, which only offers
        // Assign manually when someone is assignable -- so this doesn't promise it.
        'No vendor left in line',
        `${previousName} ${verb}${because}, and no vendor is left to contact for this request. Use Next steps below to add a vendor or search again.`,
        'bad'
      );
    }
    if (resolution === 'escalated') {
      const pendingApproval = snapshot?.approvalRequest?.status === 'pending' && Boolean(snapshot.approvalRequest.approvalRequestId);
      return base(
        'Emergency outreach closed — needs your attention',
        `${previousName} ${verb}${because}. Emergency requests never auto-advance. Review the escalation in Activity and the ordinary routing options.${pendingApproval ? ' A recorded Decision is awaiting review.' : ' No pending Decision has been identified.'}`,
        'bad',
        pendingApproval
      );
    }
    return base(
      nextName
        ? `${previousName} ${verb} — approve ${nextName} to continue`
        : `${previousName} ${verb} — routing on`,
      `${previousName} ${verb}${because}.${
        nextName
          ? ` ${nextName} is now the top recommendation — approve contact to send the next outreach.`
          : ''
      }${budgetNote}`,
      'pending',
      true
    );
  }

  // The approval that produced this decision has since been resolved, so show
  // the decision without claiming a decision is still outstanding.
  const approvalStatus = snapshot?.approvalRequest?.status;
  if (approvalStatus === 'approved' || approvalStatus === 'rejected') {
    return base(
      formatDecisionLabel(decision?.actionType || 'pending'),
      `${decision?.managerSummary || 'Routing decision recorded.'} (Approval ${approvalStatus}.)`,
      approvalStatus === 'approved' ? 'good' : 'bad'
    );
  }

  return base(
    formatDecisionLabel(decision?.actionType || 'pending'),
    decision?.managerSummary || 'No routing summary available yet.',
    decision?.approvalRequired ? 'pending' : 'neutral',
    Boolean(decision?.approvalRequired)
  );
}

/** Mirrors the server-side outreach SLA in
 *  backend/services/vendor/vendorOutreachPolicy.service.js. Display only —
 *  the authoritative deadline always comes back on the outreach record. */
export function getResponseSlaLabel(urgency = '') {
  const labels: Record<string, string> = {
    emergency: '15 minutes',
    high: '20 minutes',
    medium: '4 business hours',
    low: 'the next business day',
  };
  return labels[urgency] || '4 business hours';
}

export function getSourceLabel(source = '', fallback = 'Vendor option') {
  const labels: Record<string, string> = {
    preset: 'Your network',
    // Only in snapshots written before mock vendors were removed.
    mock_external: 'External vendor',
    manual_dispatch: 'Manual dispatch',
    taskrabbit: 'Taskrabbit',
    thumbtack: 'Thumbtack',
  };
  return labels[source] || source || fallback;
}

export function getAllVendorCandidates(snapshot?: VendorRecommendationSnapshot | null) {
  if (!snapshot) return [] as VendorRecommendationCandidate[];
  const source = snapshot.candidateLedger?.length
    ? snapshot.candidateLedger
    : [
        ...(snapshot.recommendations || []),
        ...(snapshot.eligibleButNotTopCandidates || []),
        ...(snapshot.heldCandidates || []),
        ...(snapshot.excludedCandidates || []),
      ];

  const seen = new Set<string>();
  return source.filter((candidate, index) => {
    const key = getCandidateIdentityKey(candidate, index);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function getEligibleVendorCandidates(snapshot?: VendorRecommendationSnapshot | null) {
  return getAllVendorCandidates(snapshot).filter((candidate) =>
    ELIGIBLE_VENDOR_STATES.has(candidate.state || '')
  );
}

/**
 * The outreach round that most recently closed without a booking.
 *
 * Derivable at all because advanceOutreach retires the vendor to `excluded`
 * with their outreach block intact. Used as the fallback for snapshots written
 * before `lastRound` shipped, and as the signal that a routing loop is running
 * even when no candidate is active.
 */
export function getLastClosedOutreach(snapshot?: VendorRecommendationSnapshot | null) {
  const closed = getAllVendorCandidates(snapshot).filter((candidate) =>
    CLOSED_OUTREACH_STATUSES.has(candidate.outreach?.status || '')
  );
  if (!closed.length) return null;

  const closedAt = (candidate: VendorRecommendationCandidate) =>
    new Date(candidate.outreach?.respondedAt || candidate.outreach?.lastAttemptAt || 0).getTime();

  return [...closed].sort((left, right) => closedAt(right) - closedAt(left))[0];
}

/** The vendor the loop would contact next: top of the requeued recommendations,
 *  falling back to any eligible candidate that has not been contacted yet. */
export function getNextQueuedVendorCandidate(snapshot?: VendorRecommendationSnapshot | null) {
  const notYetContacted = (candidate: VendorRecommendationCandidate) =>
    (candidate.outreach?.status || 'not_sent') === 'not_sent';

  return (
    (snapshot?.recommendations || []).find(notYetContacted) ||
    getEligibleVendorCandidates(snapshot).find(notYetContacted) ||
    null
  );
}

export function getActiveVendorCandidate(
  requestOrSnapshot?: RequestDetailRecord | VendorRecommendationSnapshot | null
) {
  const snapshot =
    requestOrSnapshot && 'vendorRecommendationSnapshot' in requestOrSnapshot
      ? requestOrSnapshot.vendorRecommendationSnapshot
      : requestOrSnapshot;
  if (!snapshot) return null;

  const candidates = getAllVendorCandidates(snapshot);
  // Guarded so an unset key never matches a candidate whose key is also unset.
  const activeKey = snapshot.activeCandidateKey || snapshot.selectedCandidateKey;
  return (
    (activeKey ? candidates.find((candidate) => candidate.candidateKey === activeKey) : null) ||
    candidates.find((candidate) => ['approved_for_contact', 'selected'].includes(candidate.state || '')) ||
    null
  );
}


/**
 * How many vendors this request's outreach could contact in total: the policy
 * cap, lowered to the vendors who were actually reachable. Rounds recorded
 * before effectiveMaxVendors existed fall back to the raw cap.
 */
export function getRoundVendorBudget(
  lastRound: VendorRecommendationSnapshot['lastRound'] | null | undefined
): number | undefined {
  if (typeof lastRound?.effectiveMaxVendors === 'number') return lastRound.effectiveMaxVendors;
  return typeof lastRound?.maxVendors === 'number' ? lastRound.maxVendors : undefined;
}

export function getRequestWorkflowStage(request: RequestDetailRecord): RequestWorkflowStage {
  if (request.status === 'rejected') {
    return {
      key: deriveNonTerminalStage(request).key,
      stepIndex: deriveNonTerminalStage(request).stepIndex,
      terminalStatus: 'rejected',
    };
  }
  if (request.status === 'cancelled') {
    return {
      key: deriveNonTerminalStage(request).key,
      stepIndex: deriveNonTerminalStage(request).stepIndex,
      terminalStatus: 'cancelled',
    };
  }
  return deriveNonTerminalStage(request);
}

// Indexes come from WORKFLOW_STEPS rather than being written out, so removing
// or reordering a step cannot leave the bar pointing at the wrong one.
function stageAt(key: Exclude<RequestWorkflowStageKey, 'not_started'>): RequestWorkflowStage {
  return { key, stepIndex: WORKFLOW_STEPS.findIndex((step) => step.key === key) };
}

function deriveNonTerminalStage(request: RequestDetailRecord): RequestWorkflowStage {
  const activeCandidate = getActiveVendorCandidate(request);
  const snapshot = request.vendorRecommendationSnapshot;

  if (request.completedAt || request.status === 'completed') {
    return stageAt('completed');
  }
  if (
    request.status === 'assigned' ||
    request.status === 'in_progress' ||
    Boolean(request.vendorId) ||
    // The post-visit states belong here too. Without them the workflow bar
    // falls back to `vendor_review` AFTER the visit has already happened —
    // a visible regression the moment a vendor submits proof.
    ['scheduled', 'awaiting_tenant', 'work_verifying', 'in_review', 'disputed'].includes(
      request.appointmentStatus || ''
    )
  ) {
    return stageAt('selected_or_scheduled');
  }
  if (activeCandidate?.state === 'selected' || snapshot?.manualAssignment?.status === 'selected') {
    return stageAt('selected_or_scheduled');
  }
  // Only an actually approved candidate reaches this step. A closed outreach
  // round (`lastRound`) is not one: after a decline, an escalation, or on a
  // snapshot with no eligible vendor at all, nobody is approved for contact and
  // the manager is still at vendor review.
  if (activeCandidate?.state === 'approved_for_contact') {
    return stageAt('contact_approved');
  }
  if (
    snapshot?.generatedAt ||
    getAllVendorCandidates(snapshot).length > 0 ||
    snapshot?.decision?.actionType
  ) {
    return stageAt('vendor_review');
  }
  return { key: 'not_started', stepIndex: -1 };
}

export function getFastestEstimatedResponse(snapshot?: VendorRecommendationSnapshot | null) {
  const fastest = getEligibleVendorCandidates(snapshot)
    .filter(
      (candidate) =>
        typeof candidate.avgResponseMinutes === 'number' && candidate.avgResponseMinutes > 0
    )
    .sort((left, right) => Number(left.avgResponseMinutes) - Number(right.avgResponseMinutes))[0];

  return fastest ? `${fastest.avgResponseMinutes} min` : 'Pending';
}

export function getAverageEligibleVendorEstimate(snapshot?: VendorRecommendationSnapshot | null) {
  const eligibleCandidates = getEligibleVendorCandidates(snapshot);
  let expectedCurrency: string | null = null;
  let total = 0;
  let count = 0;

  for (const candidate of eligibleCandidates) {
    const normalizedEstimate = getNormalizedCandidateEstimate(candidate);
    if (!normalizedEstimate) continue;

    if (!expectedCurrency) expectedCurrency = normalizedEstimate.currency;
    if (normalizedEstimate.currency !== expectedCurrency) continue;

    total += normalizedEstimate.amount;
    count += 1;
  }

  if (!count) return null;

  return {
    amount: Math.round(total / count),
    currency: expectedCurrency || DEFAULT_ESTIMATE_CURRENCY,
    vendorCount: count,
  };
}

export function getCandidateActionBlockReason(
  candidate: VendorRecommendationCandidate,
  snapshot: VendorRecommendationSnapshot | null | undefined
) {
  const activeCandidateKey = snapshot?.activeCandidateKey || snapshot?.selectedCandidateKey || '';
  // A vendor who already answered cannot be approved again: the send would
  // collide with the unique index on { requestId, candidateKey, attempt } and
  // strand the request behind a dead outreach. The server refuses this too.
  const outreachStatus = candidate.outreach?.status || '';
  if (CLOSED_OUTREACH_STATUSES.has(outreachStatus)) {
    return outreachStatus === 'declined'
      ? `${candidate.name} already declined this request.`
      : `Outreach to ${candidate.name} already closed as ${outreachStatus}.`;
  }
  if (candidate.state === 'held') {
    return candidate.holdReason || 'This candidate is on hold while another vendor is active.';
  }
  if (candidate.state === 'manager_rejected') {
    return 'This candidate has already been rejected.';
  }
  if (activeCandidateKey && activeCandidateKey !== candidate.candidateKey) {
    return 'Another vendor candidate is already active for this request.';
  }
  return '';
}

export type RoutingPauseKind = NonNullable<RoutingGuidance['pauseKind']>;

/**
 * Whether a candidate can be picked in the manual assignment dialog. Shared by
 * the dialog and the routing panel, so "Assign manually" is only offered when
 * the dialog would have someone to offer.
 */
export function isManuallySelectable(
  candidate: VendorRecommendationCandidate,
  snapshot: VendorRecommendationSnapshot | null | undefined
) {
  return (
    candidate.state !== 'held' &&
    candidate.state !== 'approved_for_contact' &&
    candidate.state !== 'selected' &&
    candidate.state !== 'manager_rejected' &&
    !getCandidateActionBlockReason(candidate, snapshot)
  );
}

/**
 * Why a fresh vendor search is refused, or '' when it can run. The server's
 * own answer (routingGuidance.regenerateBlockReason) from the same function
 * the generate endpoint enforces, so the button and the endpoint can't
 * disagree. Missing guidance leaves the button enabled; the server still decides.
 */
export function getRouteabilityBlockReason(request: RequestDetailRecord) {
  return request.routingGuidance?.regenerateBlockReason || '';
}

export function getVisibleLandlordMetrics(request: RequestDetailRecord) {
  const snapshot = request.vendorRecommendationSnapshot;
  const costDisplay = getRequestCostDisplayWithOptions(request, {
    preferEligibleAverage: true,
  });
  const submittedAt = new Date(request.createdAt);
  const submittedDate = submittedAt.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const submittedTime = submittedAt.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  const eligibleCount = getEligibleVendorCandidates(snapshot).length;

  return [
    { label: costDisplay.label, value: costDisplay.value },
    {
      label: 'Eligible vendors',
      value: snapshot ? String(eligibleCount) : 'Pending',
    },
    { label: 'Fastest estimated response', value: getFastestEstimatedResponse(snapshot) },
    {
      label: 'Submitted',
      value: submittedDate,
      secondaryValue: submittedTime,
    },
  ] as HeroMetric[];
}

export function getTenantSafeRequestSummary(request: RequestDetailRecord) {
  return {
    headline: getRequestHeadline(request, false),
    summary: request.ai?.summary || request.issueTitle || 'Maintenance request',
    additionalNotes: request.ai?.additionalNotes || '',
    safetyWarning: request.ai?.safetyWarning || '',
    statusLabel: lifecycleOf(request).replace(/_/g, ' '),
    propertyLabel: getPropertyLabel(request),
    unitLabel: getUnitLabel(request),
  };
}

export function getCandidateStateLabel(candidate: VendorRecommendationCandidate) {
  const labels: Record<string, string> = {
    recommended: 'Recommended',
    pending: 'Eligible',
    approved_for_contact: 'Approved for contact',
    selected: 'Selected manually',
    held: 'On hold',
    manager_rejected: 'Rejected',
    excluded: 'Excluded',
  };
  return labels[candidate.state || ''] || candidate.state || 'Candidate';
}

export function getCandidateStateBadge(candidate: VendorRecommendationCandidate) {
  const badges: Record<string, string> = {
    recommended: 'bg-emerald-100 text-emerald-700',
    pending: 'bg-sky-100 text-sky-700',
    approved_for_contact: 'bg-indigo-100 text-indigo-700',
    selected: 'bg-violet-100 text-violet-700',
    held: 'bg-amber-100 text-amber-700',
    manager_rejected: 'bg-rose-100 text-rose-700',
    excluded: 'bg-slate-200 text-slate-700',
  };
  return badges[candidate.state || ''] || 'bg-slate-100 text-slate-700';
}

export function getRecommendationCollections(snapshot?: VendorRecommendationSnapshot | null) {
  return {
    recommended: snapshot?.recommendations || [],
    eligible: snapshot?.eligibleButNotTopCandidates || [],
    held: snapshot?.heldCandidates || [],
    excluded: snapshot?.excludedCandidates || [],
  };
}

/**
 * The vendor actually doing the job, for states after routing has finished.
 *
 * `vendorId` and `selectedVendorId` come back populated on the landlord detail
 * endpoint but are typed as `string | object | null`, because other callers
 * receive the bare id. Falling back through both covers a manual assignment,
 * which never produces a ledger candidate to read a name from.
 */
function getAssignedVendorName(request: RequestDetailRecord) {
  const named = [request.vendorId, request.selectedVendorId].find(
    (value) => value && typeof value === 'object' && 'name' in value && value.name
  );
  return named && typeof named === 'object' ? named.name || '' : '';
}

function getCandidateIdentityKey(candidate: VendorRecommendationCandidate, index: number) {
  return (
    candidate.candidateKey ||
    candidate.vendorId ||
    `${candidate.providerName || 'provider'}:${candidate.providerVendorId || index}`
  );
}

// The server's lifecycle label (requestLifecycle.service); raw status only for
// a payload that predates it.
const lifecycleOf = (request: RequestDetailRecord) => request.lifecycleStatus || request.status;

function getLandlordHeadlineSuffix(request: RequestDetailRecord) {
  const lifecycleStatus = lifecycleOf(request);
  const activeCandidate = getActiveVendorCandidate(request);

  if (lifecycleStatus === 'completed') return 'completed';
  if (lifecycleStatus === 'rejected') return 'rejected';
  if (lifecycleStatus === 'appeal_pending') return 'appeal pending';
  if (lifecycleStatus === 'cancelled') return 'cancelled';
  if (
    lifecycleStatus === 'assigned' ||
    request.status === 'in_progress' ||
    Boolean(request.vendorId) ||
    // The post-visit states belong here too. Without them the workflow bar
    // falls back to `vendor_review` AFTER the visit has already happened —
    // a visible regression the moment a vendor submits proof.
    ['scheduled', 'awaiting_tenant', 'work_verifying', 'in_review', 'disputed'].includes(
      request.appointmentStatus || ''
    )
  ) {
    return 'vendor assigned';
  }
  // Before "awaiting vendor response": a vendor whose over-quota quote is
  // waiting on the manager has answered -- the next move is the manager's.
  if (lifecycleStatus === 'needs_approval') return 'needs your approval';
  if (activeCandidate?.state === 'approved_for_contact') {
    if (activeCandidate.outreach?.status === 'scheduled') return 'outreach scheduled';
    return 'awaiting vendor response';
  }
  // Every vendor declined or was turned down, or none could take it.
  if (lifecycleStatus === 'needs_vendor') return 'needs a vendor';
  return 'requires vendor review';
}

function removeHeadlineBoilerplate(text: string) {
  return text
    .replace(
      /^(the tenant reports that|tenant reports that|the tenant reported|tenant reported)\s+/i,
      ''
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function trimHeadlinePunctuation(text: string) {
  return text.replace(/^[\s:;,-]+|[\s:;,.!?-]+$/g, '').trim();
}

function truncateAtWordBoundary(text: string, maxLength: number) {
  if (text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength + 1);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLength * 0.6) {
    return trimHeadlinePunctuation(truncated.slice(0, lastSpace));
  }
  return trimHeadlinePunctuation(text.slice(0, maxLength));
}

function getNormalizedCandidateEstimate(candidate: VendorRecommendationCandidate) {
  const priceEstimate = candidate.priceEstimate;
  if (!priceEstimate) return null;

  const low = Number(priceEstimate.amountLow);
  const high = Number(priceEstimate.amountHigh);
  const hasLow = Number.isFinite(low) && low > 0;
  const hasHigh = Number.isFinite(high) && high > 0;
  if (!hasLow && !hasHigh) return null;

  const amount = hasLow && hasHigh ? (low + high) / 2 : hasLow ? low : high;
  return {
    amount,
    currency: normalizeEstimateCurrency(priceEstimate.currency),
  };
}

function normalizeEstimateCurrency(currency?: string | null) {
  const normalized = String(currency || '')
    .trim()
    .toUpperCase();
  return normalized || DEFAULT_ESTIMATE_CURRENCY;
}

function formatCurrencyAmount(amount: number) {
  return `$${Math.round(amount)}`;
}
