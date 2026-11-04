import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  FileText,
  Gauge,
  HelpCircle,
  Loader2,
  PhoneCall,
  Receipt,
  RotateCcw,
  Scale,
  Search,
  ShieldAlert,
  UserPlus,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import PageHeader from '../../components/landlord/PageHeader';
import StatCard, { StatGrid } from '../../components/landlord/StatCard';
import { relativeTime } from '../../lib/relativeTime';
import { Button } from '../../components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog';
import {
  EmptyState,
  FieldLabel,
  LandlordError,
  LandlordLoading,
  SectionCard,
  useLandlordEntrance,
} from '../../components/landlord/landlordUi';
import { useLandlordRequests } from '../../hooks/landlord/useLandlordRequests';
import { usePendingDecisions } from '../../hooks/landlord/usePendingDecisions';
import { useRequestActions } from '../../hooks/landlord/useRequestActions';
import { useBackgroundRefresh } from '../../hooks/useBackgroundRefresh';
import {
  adjustLandlordBadge,
  refreshLandlordBadges,
} from '../../hooks/landlord/useLandlordBadges';
import { LandlordAPI, BookingAPI } from '../../api/client';
import type { ApprovalRequestItem, RequestItem, RoutingDecisionItem } from '../../types/landlord';
import { canRejectRequest, getContactCandidate } from '../../components/landlord/requestHelpers';
import { decisionHref } from '../../components/landlord/decisionHref';
import RequestIdentity from '../../components/landlord/RequestIdentity';
import {
  CoordinationStepActions,
  CoordinationStepContext,
  CostReviewActions,
  CostReviewContext,
} from '../../components/landlord/CostReviewDecision';
import { isStaleDecision, quoteDecisionExpectation } from '../../lib/costReview';
import { minorToDollars, parseMinor } from '../../lib/itemization';
import {
  type AppealDecisionTarget,
  DeclineAppealDialog,
  ReopenRequestDialog,
} from '../../components/RequestActionDialogs';
import { D3AlertDialogContent, D3_FIELD, D3Page, D3State, d3PriorityClass, useD3PageActive } from '../../components/request-detail/d3Presentation';

// What a paused card says, by why it paused (decisionQueue.getPauseKind). Every
// pause used to read "No vendor is left in line", which was false for an empty
// network -- nobody was ever in line -- and for a manager who said no.
const PAUSE_COPY: Record<
  NonNullable<RoutingDecisionItem['pauseKind']>,
  { detail: string; nextStep: string; button: string }
> = {
  vendors_exhausted: {
    detail: 'No vendor is left in line — add a vendor or search again.',
    nextStep: 'Add a vendor or search again.',
    button: 'Choose vendor',
  },
  no_eligible_vendors: {
    detail: 'No vendor in your network covers this job yet.',
    nextStep: 'Add a vendor who does this work.',
    button: 'Add vendor',
  },
  manager_rejected: {
    detail: 'You turned down the recommended vendor.',
    nextStep: 'Pick another vendor or search again.',
    button: 'Choose vendor',
  },
  paused: {
    detail: 'Routing is paused.',
    nextStep: 'Choose a vendor to continue routing.',
    button: 'Choose vendor',
  },
};

/**
 * A decision with no ApprovalRequest behind it, read from the request itself:
 * "Approve contact" for the recommended vendor, or routing that paused because
 * every vendor declined. These used to be missing from this page entirely.
 */
function RoutingDecisionCard({
  item,
  request,
  pulse,
  onApproveContact,
  onOpen,
}: {
  item: RoutingDecisionItem;
  request: RequestItem | undefined;
  pulse: boolean;
  onApproveContact: (request: RequestItem) => void;
  onOpen: () => void;
}) {
  const paused = item.type === 'routing_paused';
  const pause = PAUSE_COPY[item.pauseKind || 'paused'];
  const where = [item.propertyName, item.unitNumber ? `Unit ${item.unitNumber}` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <DecisionRow
      requestId={item.requestId}
      id={`decision-card-${item.requestId}`}
      testId={`routing-decision-${item.type}-${item.requestId}`}
      pulse={pulse}
      eyebrow={paused ? 'Routing paused' : 'Approve contact'}
      title={item.title}
      where={where}
      detail={
        paused
          ? `${item.reason && item.pauseKind === 'vendors_exhausted' ? `${item.reason}. ` : ''}${pause.detail}`
          : `${item.candidate?.name || 'The recommended vendor'} is ready to be contacted.`
      }
      urgency={item.urgency}
      since={item.createdAt}
      nextStep={
        paused
          ? pause.nextStep
          : `Approve contacting ${item.candidate?.name || 'the recommended vendor'}.`
      }
      actions={
        <>
          {!paused && request ? (
            <Button
              className="bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d3]:text-primary-foreground"
              onClick={() => onApproveContact(request)}
              data-testid={`routing-decision-approve-${item.requestId}`}
            >
              Approve contact
            </Button>
          ) : null}
          <Button
            variant={paused ? 'default' : 'outline'}
            className={paused ? "bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d3]:text-primary-foreground" : "border-slate-200 in-[.lichen-d3]:border-border"}
            onClick={onOpen}
          >
            {paused ? pause.button : 'Review request'}
          </Button>
        </>
      }
    />
  );
}

/** "Since 2 hours ago", "Since yesterday", "Since Sep 20" — never "since sep 20". */
function sinceLabel(iso: string) {
  const rt = relativeTime(iso);
  if (!rt) return '';
  if (rt === 'Just now') return rt;
  return `Since ${rt === 'Yesterday' ? 'yesterday' : rt}`;
}

const URGENCY_PILLS: Record<string, { label: string; className: string; dot: string }> = {
  emergency: { label: 'Emergency', className: 'bg-rose-50 text-rose-700', dot: 'bg-rose-500' },
  high: { label: 'High', className: 'bg-rose-50 text-rose-700', dot: 'bg-rose-500' },
  medium: { label: 'Medium', className: 'bg-amber-50 text-amber-700', dot: 'bg-amber-500' },
  low: { label: 'Low', className: 'bg-sky-50 text-sky-700', dot: 'bg-sky-500' },
};

/**
 * One decision, laid out like the mockup: what and where on the left, how
 * urgent and how long it has waited in the middle, the suggested next step
 * and its buttons on the right. Deliberately no icon tile — the section
 * header already says what kind of decision these are.
 */
function DecisionRow({
  requestId,
  id,
  testId,
  pulse,
  eyebrow,
  title,
  where,
  detail,
  extra,
  urgency,
  since,
  nextStep,
  actions,
}: {
  requestId: string;
  id: string;
  testId: string;
  pulse: boolean;
  eyebrow: string;
  title: string;
  where: string;
  detail: string;
  extra?: ReactNode;
  urgency: string | null;
  since: string | null;
  nextStep: string;
  actions: ReactNode;
}) {
  const pill = urgency ? URGENCY_PILLS[urgency] : null;
  return (
    <div
      id={id}
      data-testid={testId}
      className={`d3-decision-row grid scroll-mt-24 gap-4 rounded-xl border border-slate-200 bg-white p-4 transition hover:border-slate-300 lg:grid-cols-[minmax(0,1.6fr)_8.5rem_minmax(0,1fr)_auto] lg:items-center in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card in-[.lichen-d3]:hover:border-control-border ${
        pulse ? 'decision-pulse' : ''
      }`}
    >
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400 in-[.lichen-d3]:text-meta">{eyebrow}</div>
        <div className="truncate font-semibold text-slate-900 in-[.lichen-d3]:text-ink in-[.lichen-d3]:whitespace-normal in-[.lichen-d3]:overflow-visible">{title}</div>
        <RequestIdentity id={requestId} />
        {where ? <div className="text-sm text-slate-500 in-[.lichen-d3]:text-meta">{where}</div> : null}
        <div className="mt-0.5 text-xs text-slate-500 in-[.lichen-d3]:text-meta">{detail}</div>
        {extra}
      </div>
      <div className="d3-decision-timing flex flex-wrap items-center gap-2 lg:flex-col lg:items-start lg:gap-1">
        {pill ? (
          <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-semibold in-[.lichen-d3]:rounded-full ${pill.className} ${d3PriorityClass(urgency || '')}`}>
            <span className={`h-1.5 w-1.5 rounded-full in-[.lichen-d3]:bg-current ${pill.dot}`} />
            {pill.label}
          </span>
        ) : null}
        {since ? <span className="text-xs text-slate-400 in-[.lichen-d3]:text-meta">{sinceLabel(since)}</span> : null}
      </div>
      <div className="d3-decision-next min-w-0 lg:border-l lg:border-slate-100 lg:pl-4">
        <div className="text-xs font-semibold text-slate-700 in-[.lichen-d3]:text-ink">Suggested next step</div>
        <div className="text-xs text-slate-500 in-[.lichen-d3]:text-meta">{nextStep}</div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2 lg:justify-end">{actions}</div>
    </div>
  );
}

const BOOKING_DECISION_TYPES = new Set<RoutingDecisionItem['type']>(['tenant_time_unconfirmed', 'vendor_no_show']);

// Each decision list scrolls inside its own card, so a long queue never pushes
// the next section off the page — and there is no separate "View all" page to
// send the landlord to. The ?request= deep link reaches into them with
// revealDecisionCard below.
const SCROLL_LIST = 'max-h-[30rem] space-y-3 overflow-y-auto overscroll-contain pr-1';

/**
 * Bring a decision card into view when it may sit inside one of the scrolling
 * lists. A single smooth scrollIntoView can't be trusted to move both the list
 * and the page at once — Chrome scrolled the page and left the list at the
 * top — so it is done in two explicit steps: centre the card within its list,
 * then centre the list's card on the page.
 */
function revealDecisionCard(card: HTMLElement) {
  const list = card.parentElement;
  if (list && list.scrollHeight > list.clientHeight) {
    // Rects, not offsetTop: they don't depend on which ancestor is positioned.
    const listRect = list.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const offset = list.scrollTop + (cardRect.top - listRect.top) - (listRect.height - cardRect.height) / 2;
    list.scrollTop = Math.max(0, offset);
  }
  card.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
}

function PendingChip({ count }: { count: number }) {
  return (
    <span className="rounded-full bg-[#137fec]/10 px-3 py-1 text-xs font-semibold text-[#137fec] in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-text">
      {count} pending
    </span>
  );
}

function formatWhen(value?: string | null) {
  if (!value) return null;
  return new Date(value).toLocaleString('en-CA', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * A tenant appealed a rejection. Nothing else moves an appealed request, so it
 * waits here until the landlord accepts (reopens) or declines (removes) it.
 */
function AppealDecisionCard({
  item,
  pulse,
  onAccept,
  onDecline,
  onOpen,
}: {
  item: RoutingDecisionItem;
  pulse: boolean;
  onAccept: () => void;
  onDecline: () => void;
  onOpen: () => void;
}) {
  const where = [item.propertyName, item.unitNumber ? `Unit ${item.unitNumber}` : null].filter(Boolean).join(' · ');
  return (
    <DecisionRow
      requestId={item.requestId}
      id={`decision-card-${item.requestId}`}
      testId={`routing-decision-appeal_review-${item.requestId}`}
      pulse={pulse}
      eyebrow="Tenant appealed a rejection"
      title={item.title}
      where={where}
      detail={item.reason ? `You rejected it: ${item.reason}` : 'You rejected this request.'}
      extra={item.note ? <div className="mt-1 text-sm italic text-slate-500 in-[.lichen-d3]:text-meta">“{item.note}”</div> : null}
      urgency={item.urgency}
      since={item.reportedAt || item.createdAt}
      nextStep="Reopen it, or decline the appeal. Declining is final and removes the request."
      actions={
        <>
          <Button
            className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d3]:text-primary-foreground"
            onClick={onAccept}
            data-testid={`appeal-accept-${item.requestId}`}
          >
            <RotateCcw className="h-4 w-4" /> Accept &amp; reopen
          </Button>
          <Button
            variant="outline"
            className="border-rose-200 text-rose-700 hover:bg-rose-50 in-[.lichen-d3]:border-alert-line in-[.lichen-d3]:text-alert-text in-[.lichen-d3]:hover:bg-alert-tint"
            onClick={onDecline}
            data-testid={`appeal-decline-${item.requestId}`}
          >
            Decline
          </Button>
          <Button variant="ghost" onClick={onOpen}>
            Review
          </Button>
        </>
      }
    />
  );
}

/**
 * A request held for a person: tenant follow-up details to review, or a safety
 * concern to assess. Derived from request state, so it shows whether or not
 * any vendor was ever recommended. Deciding happens on the request, where the
 * answers and the reason field are; nothing here contacts a vendor.
 */
function ReviewDecisionCard({
  item,
  pulse,
  onOpen,
}: {
  item: RoutingDecisionItem;
  pulse: boolean;
  onOpen: () => void;
}) {
  const safety = item.type === 'safety_review';
  const where = [item.propertyName, item.unitNumber ? `Unit ${item.unitNumber}` : null].filter(Boolean).join(' · ');
  return (
    <DecisionRow
      requestId={item.requestId}
      id={`decision-card-${item.requestId}`}
      testId={`routing-decision-${item.type}-${item.requestId}`}
      pulse={pulse}
      eyebrow={safety ? 'Urgent safety concern' : 'Tenant sent details'}
      title={item.title}
      where={where}
      detail={item.reason || (safety ? 'Raised for urgent human review.' : 'Follow-up answers are waiting for you.')}
      // A concern stays urgent until a person says otherwise.
      urgency={safety ? 'emergency' : item.urgency}
      since={item.createdAt}
      nextStep={
        safety
          ? 'Assess it: keep it urgent or classify it routine, with a reason. No vendor is contacted until you do.'
          : 'Review the answers. Routing stays on hold until you do.'
      }
      actions={
        <Button
          className={safety ? "bg-rose-600 text-white hover:bg-rose-700 in-[.lichen-d3]:bg-destructive in-[.lichen-d3]:hover:bg-destructive/90 in-[.lichen-d3]:text-destructive-foreground" : "bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d3]:text-primary-foreground"}
          onClick={onOpen}
          data-testid={`review-decision-open-${item.requestId}`}
        >
          {safety ? 'Assess concern' : 'Review details'}
        </Button>
      }
    />
  );
}

const REVIEW_DECISION_TYPES = new Set<RoutingDecisionItem['type']>(['intake_review', 'safety_review']);

type BookingAction = 'confirm_time' | 'reroute' | 'dismiss_no_show';

/**
 * A booking that went wrong after a vendor accepted: the tenant never confirmed
 * the arrival time, or reported that nobody came. Both are resolved here
 * rather than on the request, because both are time-sensitive.
 */
function BookingDecisionCard({
  item,
  pulse,
  busy,
  onAction,
  onOpen,
}: {
  item: RoutingDecisionItem;
  pulse: boolean;
  busy: BookingAction | null;
  onAction: (item: RoutingDecisionItem, action: BookingAction) => void;
  onOpen: () => void;
}) {
  const noShow = item.type === 'vendor_no_show';
  const vendor = item.vendorName || 'The vendor';
  const arrival = formatWhen(item.arrivalAt);
  const where = [item.propertyName, item.unitNumber ? `Unit ${item.unitNumber}` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <DecisionRow
      requestId={item.requestId}
      id={`decision-card-${item.requestId}`}
      testId={`routing-decision-${item.type}-${item.requestId}`}
      pulse={pulse}
      eyebrow={noShow ? 'Vendor no-show reported' : "Tenant hasn't confirmed"}
      title={item.title}
      where={where}
      detail={
        noShow
          ? // Never end on the time: en-CA writes "11:40 a.m." and a
            // closing period printed "a.m..".
            `The tenant says ${vendor} didn't arrive${arrival ? ` — booked for ${arrival}` : '.'}`
          : `${vendor} is booked${arrival ? ` for ${arrival}` : ''}, but the tenant hasn't confirmed the time.`
      }
      extra={noShow && item.note ? <div className="mt-1 text-sm italic text-slate-500 in-[.lichen-d3]:text-meta">“{item.note}”</div> : null}
      urgency={item.urgency}
      since={noShow ? item.reportedAt || item.createdAt : item.deadline || item.createdAt}
      nextStep={
        noShow
          ? 'Confirm the vendor came, or send the job to another vendor.'
          : 'Confirm the time for the tenant, or find another vendor.'
      }
      actions={
        <>
        {noShow ? (
          <Button
            variant="outline"
            className="border-slate-200 in-[.lichen-d3]:border-border"
            disabled={Boolean(busy)}
            onClick={() => onAction(item, 'dismiss_no_show')}
            data-testid={`booking-dismiss-${item.requestId}`}
          >
            {busy === 'dismiss_no_show' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Vendor came
          </Button>
        ) : (
          <Button
            className="bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d3]:text-primary-foreground"
            disabled={Boolean(busy)}
            onClick={() => onAction(item, 'confirm_time')}
            data-testid={`booking-confirm-${item.requestId}`}
          >
            {busy === 'confirm_time' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Confirm for tenant
          </Button>
        )}
        <Button
          variant="outline"
          className="border-rose-200 text-rose-700 hover:bg-rose-50 in-[.lichen-d3]:border-alert-line in-[.lichen-d3]:text-alert-text in-[.lichen-d3]:hover:bg-alert-tint"
          disabled={Boolean(busy)}
          onClick={() => onAction(item, 'reroute')}
          data-testid={`booking-reroute-${item.requestId}`}
        >
          {busy === 'reroute' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Find another vendor
        </Button>
        <Button variant="ghost" onClick={onOpen}>
          Review
        </Button>
        </>
      }
    />
  );
}

function formatType(type: string) {
  const clean = type.replaceAll('_', ' ');
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

// The evidence checker emits machine codes; a manager needs a sentence. Codes
// with no entry fall through to the raw string rather than disappearing.
const EVIDENCE_REASON_LABELS: Record<string, string> = {
  no_after_photo: 'No photo of the finished work was attached',
  uploads_not_configured: 'Photo uploads were unavailable at the time',
  photo_timestamp_mismatch: 'Photo was taken well before it was uploaded',
  checkin_geo_denied: 'Vendor did not share their location on arrival',
  checkin_geo_unavailable: 'No arrival location was recorded',
  checkin_geo_outside_radius: 'Vendor was recorded away from the property',
  checkin_geo_unparseable: 'Arrival location could not be read',
  geofence_not_configured: 'Property has no coordinates set, so location could not be checked',
};

const APPROVAL_TYPE_META: Record<
  string,
  { label: string; icon: LucideIcon; chip: string; badge: string }
> = {
  external_vendor_search: {
    label: 'External vendor search',
    icon: Search,
    chip: 'bg-sky-50 text-sky-600',
    badge: 'bg-sky-50 text-sky-700',
  },
  completion_review: {
    label: 'Completion review',
    icon: ClipboardCheck,
    chip: 'bg-sky-50 text-sky-600',
    badge: 'bg-sky-50 text-sky-700',
  },
  cost_review: {
    label: 'Cost review',
    icon: Receipt,
    chip: 'bg-slate-100 text-slate-700',
    badge: 'bg-slate-100 text-slate-700',
  },
  quota_increase: {
    label: 'Quota increase',
    icon: Gauge,
    chip: 'bg-amber-50 text-amber-600',
    badge: 'bg-amber-50 text-amber-700',
  },
  first_time_vendor: {
    label: 'First-time vendor',
    icon: UserPlus,
    chip: 'bg-violet-50 text-violet-600',
    badge: 'bg-violet-50 text-violet-700',
  },
  vendor_contact_approval: {
    label: 'Vendor contact',
    icon: PhoneCall,
    chip: 'bg-emerald-50 text-emerald-600',
    badge: 'bg-emerald-50 text-emerald-700',
  },
  high_severity: {
    label: 'High severity',
    icon: AlertTriangle,
    chip: 'bg-rose-50 text-rose-600',
    badge: 'bg-rose-50 text-rose-700',
  },
  tenant_caused_cost: {
    label: 'Tenant-caused cost',
    icon: Receipt,
    chip: 'bg-orange-50 text-orange-600',
    badge: 'bg-orange-50 text-orange-700',
  },
  other: {
    label: 'Other',
    icon: HelpCircle,
    chip: 'bg-slate-100 text-slate-600',
    badge: 'bg-slate-100 text-slate-600',
  },
};

const APPROVAL_TYPE_ORDER = Object.keys(APPROVAL_TYPE_META);

function approvalTypeMeta(type: string) {
  return (
    APPROVAL_TYPE_META[type] || {
      label: formatType(type),
      icon: HelpCircle,
      chip: 'bg-slate-100 text-slate-600',
      badge: 'bg-slate-100 text-slate-600',
    }
  );
}

function expiryInfo(expiresAt: string) {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(diff)) return null;
  if (diff <= 0) return { label: 'Expired', urgent: true };
  const hours = Math.max(1, Math.round(diff / 3_600_000));
  if (hours < 24) return { label: `Expires in ${hours}h`, urgent: true };
  const days = Math.round(hours / 24);
  return { label: `Expires in ${days}d`, urgent: days <= 2 };
}

function requestMetaParts(request?: RequestItem) {
  if (!request) return [];
  const parts: string[] = [];
  if (typeof request.propertyId === 'object' && request.propertyId?.name) {
    parts.push(request.propertyId.name);
  }
  if (typeof request.unitId === 'object' && request.unitId?.unitNumber) {
    parts.push(`Unit ${request.unitId.unitNumber}`);
  }
  if (request.category) parts.push(formatType(request.category));
  return parts;
}

function QuotaDecisionActions({
  approval,
  onDecide,
}: {
  approval: ApprovalRequestItem;
  onDecide: (
    id: string,
    status: 'approved' | 'rejected',
    approvedAmount?: number,
    outcome?: 'counter_offer' | 'booked' | 'completion_review',
    expected?: { expectedQuoteRevision?: number; expectedQuoteHash?: string }
  ) => Promise<void>;
}) {
  const quota = approval.payload?.quota;
  const isVendorQuote = approval.payload?.source === 'vendor_quote';
  // A completion the evidence check couldn't clear. The manager is being asked
  // to vouch for the gap, not to confirm the work — approving hands it to the
  // tenant, who is still the real signal.
  const completion = approval.type === 'completion_review' ? approval.payload?.completion : null;
  const quotedLow = quota?.quotedLow;
  const quotedHigh = quota?.quotedAmount;
  const suggested = quota?.suggestedQuota;

  // Prefill with the SUGGESTED amount, not the in-force limit. Prefilling the old
  // limit made "Approve increase" a one-click no-op that authorized nothing while
  // the job still booked at the vendor's high quote — the amount was decorative.
  // It is now enforced, so the default has to be a number that actually books.
  const [amount, setAmount] = useState(
    suggested != null ? String(suggested) : quota?.limit != null ? String(quota.limit) : ''
  );
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const showSuggestion = suggested != null && String(suggested) !== amount;

  const parsedAmount = Number(amount);
  // The vendor's own floor. Authorizing under it can't be met, so the server
  // refuses it — mirror that here rather than letting them submit into a 400.
  const belowFloor =
    isVendorQuote &&
    quotedLow != null &&
    Number.isFinite(parsedAmount) &&
    parsedAmount > 0 &&
    parsedAmount < quotedLow;
  // Between the vendor's floor and their ceiling: we ask them to accept it
  // rather than booking at a number they never agreed to.
  const willCounterOffer =
    isVendorQuote &&
    quotedHigh != null &&
    Number.isFinite(parsedAmount) &&
    parsedAmount > 0 &&
    !belowFloor &&
    parsedAmount < quotedHigh;

  const [amountError, setAmountError] = useState('');
  const submit = async (status: 'approved' | 'rejected') => {
    // Whole cents only: the server refuses a fractional cent, and rounding
    // it here would authorize an amount nobody typed.
    const minor = amount.trim() ? parseMinor(amount) : null;
    if (status === 'approved' && amount.trim() && minor === null) {
      setAmountError('Use dollars and cents, like 240 or 240.50.');
      return;
    }
    setAmountError('');
    setBusy(status === 'approved' ? 'approve' : 'reject');
    try {
      const approvedAmount = status === 'approved' && minor !== null && minor > 0 ? minorToDollars(minor) : undefined;
      await onDecide(
        approval._id,
        status,
        approvedAmount,
        status === 'approved' && willCounterOffer ? 'counter_offer' : 'booked',
        // An itemized vendor quote: echo the exact revision this was raised on.
        quoteDecisionExpectation(approval.payload)
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-2 sm:items-end">
      <div className="text-xs text-slate-500 sm:text-right in-[.lichen-d3]:text-meta">
        {quota?.limit != null ? (
          <div>
            Current limit:{' '}
            <span className="font-semibold text-slate-700 in-[.lichen-d3]:text-ink">${quota.limit.toLocaleString()}</span>
          </div>
        ) : quota ? (
          <div>
            Current limit: <span className="font-semibold text-slate-700 in-[.lichen-d3]:text-ink">Not set</span>
          </div>
        ) : null}
        {quotedLow != null && quotedHigh != null ? (
          <div>
            Vendor quoted:{' '}
            <span className="font-semibold text-slate-700 in-[.lichen-d3]:text-ink">
              ${quotedLow.toLocaleString()}–${quotedHigh.toLocaleString()}
            </span>
          </div>
        ) : null}
        {quota?.lowestEligibleCost != null ? (
          <div>
            Lowest likely cost:{' '}
            <span className="font-semibold text-slate-700 in-[.lichen-d3]:text-ink">
              ${quota.lowestEligibleCost.toLocaleString()}
            </span>
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 sm:items-end">
        <label className="flex items-center gap-1.5 in-[.lichen-d3]:flex-wrap">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 in-[.lichen-d3]:text-meta">
            {isVendorQuote ? 'Authorize up to' : 'New quota'}
          </span>
          <span className="text-sm font-medium text-slate-400 in-[.lichen-d3]:text-meta">$</span>
          <input
            type="number"
            min={isVendorQuote && quotedLow != null ? quotedLow : 0}
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
              setAmountError('');
            }}
            aria-label={isVendorQuote ? 'Amount to authorize' : 'New quota amount'}
            aria-invalid={belowFloor || Boolean(amountError) || undefined}
            aria-describedby={amountError ? `quota-amount-error-${approval._id}` : undefined}
            className={[`h-8 w-24 rounded-lg border bg-white px-2 text-sm text-slate-900 focus:outline-none focus:ring-1 in-[.lichen-d3]:bg-card in-[.lichen-d3]:text-ink ${
              belowFloor
                ? "border-rose-300 focus:border-rose-400 focus:ring-rose-300/40 in-[.lichen-d3]:border-alert-line in-[.lichen-d3]:focus:border-alert-line"
                : "border-slate-200 focus:border-[#137fec] focus:ring-[#137fec]/40 in-[.lichen-d3]:border-border in-[.lichen-d3]:focus:border-control-border"
            }`, D3_FIELD].join(' ')}
          />
        </label>
        {showSuggestion ? (
          <button
            type="button"
            onClick={() => setAmount(String(suggested))}
            className="text-[11px] font-medium text-[#137fec] hover:underline in-[.lichen-d3]:text-lichen-text"
          >
            Use suggested (${suggested.toLocaleString()})
          </button>
        ) : null}
        {amountError ? (
          <p id={`quota-amount-error-${approval._id}`} role="alert" className="max-w-[15rem] text-[11px] leading-4 text-rose-600 sm:text-right in-[.lichen-d3]:text-alert-text">
            {amountError}
          </p>
        ) : null}
        {belowFloor ? (
          <p className="max-w-[15rem] text-[11px] leading-4 text-rose-600 sm:text-right in-[.lichen-d3]:text-alert-text">
            Below the vendor&rsquo;s ${quotedLow?.toLocaleString()} floor. Reject instead to try
            the next vendor.
          </p>
        ) : willCounterOffer ? (
          <p className="max-w-[15rem] text-[11px] leading-4 text-amber-700 sm:text-right in-[.lichen-d3]:text-lichen-text">
            We&rsquo;ll ask {approval.payload?.vendorName || 'the vendor'} to confirm this amount
            before booking.
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5 sm:justify-end">
        <Button
          size="sm"
          disabled={busy !== null || belowFloor}
          className="h-8 bg-[#137fec] px-3 text-xs text-white hover:bg-[#137fec]/90 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d3]:text-primary-foreground"
          onClick={() => void submit('approved')}
        >
          {busy === 'approve' ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
          {isVendorQuote ? (willCounterOffer ? 'Send for confirmation' : 'Authorize') : 'Approve increase'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          className="h-8 border-rose-200 px-3 text-xs text-rose-600 hover:bg-rose-50 in-[.lichen-d3]:border-alert-line in-[.lichen-d3]:text-alert-text in-[.lichen-d3]:hover:bg-alert-tint"
          onClick={() => void submit('rejected')}
        >
          Reject
        </Button>
      </div>
    </div>
  );
}

/**
 * Approve or reject a parked completion.
 *
 * Deliberately worded as "Looks right — ask the tenant" rather than "Approve".
 * Approving does not pay the vendor: it moves the job to awaiting_tenant and
 * asks the tenant to confirm. The manager is vouching that the evidence gap is
 * acceptable, not that the work happened, and a button labelled "Approve" next
 * to a dollar figure reads like authorising a payment.
 */
function CompletionReviewActions({
  approval,
  onDecide,
}: {
  approval: ApprovalRequestItem;
  onDecide: (
    id: string,
    status: 'approved' | 'rejected',
    approvedAmount?: number,
    outcome?: 'counter_offer' | 'booked' | 'completion_review'
  ) => Promise<void>;
}) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const cost = approval.payload?.completion?.actualCost;

  const submit = async (status: 'approved' | 'rejected') => {
    setBusy(status === 'approved' ? 'approve' : 'reject');
    try {
      await onDecide(approval._id, status, undefined, 'completion_review');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-2 sm:items-end">
      {typeof cost === 'number' ? (
        <div className="sm:text-right">
          <div className="text-base font-bold text-slate-900 in-[.lichen-d3]:text-ink">${cost.toLocaleString()}</div>
          <FieldLabel className="in-[.lichen-d3]:text-meta">Vendor invoiced</FieldLabel>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1.5 sm:justify-end">
        <Button
          size="sm"
          disabled={busy !== null}
          onClick={() => void submit('approved')}
          className="h-8 bg-[#137fec] px-3 text-xs text-white hover:bg-[#137fec]/90 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d3]:text-primary-foreground"
          data-testid={`completion-review-approve-${approval._id}`}
        >
          Looks right — ask the tenant
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void submit('rejected')}
          className="h-8 border-rose-200 px-3 text-xs text-rose-600 hover:bg-rose-50 in-[.lichen-d3]:border-alert-line in-[.lichen-d3]:text-alert-text in-[.lichen-d3]:hover:bg-alert-tint"
          data-testid={`completion-review-reject-${approval._id}`}
        >
          Reject
        </Button>
      </div>
      <p className="max-w-[15rem] text-[11px] leading-4 text-slate-400 sm:text-right in-[.lichen-d3]:text-meta">
        Approving asks the tenant to confirm. The vendor isn&rsquo;t paid until they do.
      </p>
    </div>
  );
}

export default function DecisionsNeededPage() {
  const d3 = useD3PageActive();
  useLandlordEntrance();
  const navigate = useNavigate();
  const {
    pendingApprovals,
    filteredApprovals,
    routingDecisions,
    typeCounts,
    typeFilter,
    setTypeFilter,
    loading: approvalsLoading,
    error: approvalsError,
    reload: reloadApprovals,
  } = usePendingDecisions();
  const { requests, loading: requestsLoading, error: requestsError, reload: reloadRequests } =
    useLandlordRequests();
  const [searchParams] = useSearchParams();
  const focusRequestId = searchParams.get('request');
  const [pulseRequestId, setPulseRequestId] = useState<string | null>(null);
  const [busyApprovalId, setBusyApprovalId] = useState<string | null>(null);
  const handledFocusRef = useRef<string | null>(null);

  // Inject the deep-link pulse animation (used when arriving from a request's
  // "Review in Decisions" button). Two glow pulses, then it settles.
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `
      @keyframes decisionPulse {
        0%   { box-shadow: 0 0 0 0 rgba(19, 127, 236, 0); }
        16%  { box-shadow: 0 0 18px 4px rgba(19, 127, 236, 0.5); }
        32%  { box-shadow: 0 0 0 0 rgba(19, 127, 236, 0); }
        68%  { box-shadow: 0 0 0 0 rgba(19, 127, 236, 0); }
        84%  { box-shadow: 0 0 18px 4px rgba(19, 127, 236, 0.5); }
        100% { box-shadow: 0 0 0 0 rgba(19, 127, 236, 0); }
      }
      .decision-pulse { animation: decisionPulse 2.8s ease-in-out both; border-color: rgba(19, 127, 236, 0.5) !important; }
      @media (prefers-reduced-motion: reduce) { .decision-pulse { animation: none; } }
    `;
    document.head.appendChild(style);
    return () => {
      document.head.removeChild(style);
    };
  }, []);

  // When arriving with ?request=<id>, scroll to that request's approval card and
  // pulse it. handledFocusRef prevents re-pulsing on unrelated re-renders.
  //
  // Waits for BOTH lists: the page shows a spinner until requests have loaded
  // too, so with approvals alone the card wasn't in the DOM yet — the lookup
  // found nothing, the effect still marked itself handled, and the page never
  // scrolled.
  useEffect(() => {
    if (!focusRequestId || approvalsLoading || requestsLoading) return;
    if (handledFocusRef.current === focusRequestId) return;
    const match =
      pendingApprovals.find((approval) => approval.requestId === focusRequestId) ||
      routingDecisions.find((item) => item.requestId === focusRequestId);
    if (!match) return;
    handledFocusRef.current = focusRequestId;
    const card = document.getElementById(`decision-card-${focusRequestId}`);
    if (card) revealDecisionCard(card);
    setPulseRequestId(focusRequestId);
    const timer = window.setTimeout(() => setPulseRequestId(null), 3000);
    return () => window.clearTimeout(timer);
  }, [focusRequestId, approvalsLoading, requestsLoading, pendingApprovals, routingDecisions]);

  const refresh = useCallback(async () => {
    await Promise.all([reloadApprovals(), reloadRequests()]);
    // Approving contact from here resolves a routing decision, which the badge
    // counts too.
    void refreshLandlordBadges();
  }, [reloadApprovals, reloadRequests]);

  const { openApproveContact, openRejectRequest, dialogs } = useRequestActions({
    vendors: [],
    onAfterMutation: refresh,
  });

  const bookingDecisions = useMemo(
    () => routingDecisions.filter((item) => BOOKING_DECISION_TYPES.has(item.type)),
    [routingDecisions]
  );
  const vendorRoutingDecisions = useMemo(
    () =>
      routingDecisions.filter(
        (item) =>
          !BOOKING_DECISION_TYPES.has(item.type) && !REVIEW_DECISION_TYPES.has(item.type) && item.type !== 'appeal_review'
      ),
    [routingDecisions]
  );
  // Safety first: an unassessed concern outranks follow-up details.
  const reviewDecisions = useMemo(
    () =>
      routingDecisions
        .filter((item) => REVIEW_DECISION_TYPES.has(item.type))
        .sort((a, b) => Number(b.type === 'safety_review') - Number(a.type === 'safety_review')),
    [routingDecisions]
  );
  const appealDecisions = useMemo(
    () => routingDecisions.filter((item) => item.type === 'appeal_review'),
    [routingDecisions]
  );
  const [reopenTarget, setReopenTarget] = useState<AppealDecisionTarget | null>(null);
  const [declineTarget, setDeclineTarget] = useState<AppealDecisionTarget | null>(null);
  const [appealBusy, setAppealBusy] = useState(false);
  const appealTargetOf = (item: RoutingDecisionItem): AppealDecisionTarget => ({
    requestId: item.requestId,
    issueTitle: item.title,
    rejectionReason: item.reason,
    appealNote: item.note,
  });
  const decideAppeal = async (run: () => Promise<unknown>, done: string) => {
    setAppealBusy(true);
    adjustLandlordBadge('decisions', -1);
    try {
      await run();
      setReopenTarget(null);
      setDeclineTarget(null);
      toast.success(done);
      await refresh();
    } catch (err) {
      adjustLandlordBadge('decisions', 1);
      toast.error(err instanceof Error ? err.message : 'Could not decide the appeal');
      await refresh();
    } finally {
      setAppealBusy(false);
    }
  };
  // Pending approvals due within a day, or already past due. (The mockup's
  // "SLA at risk": an approval that lapses stops the job waiting on it.)
  const expiringSoon = useMemo(() => {
    const cutoff = Date.now() + 24 * 3_600_000;
    return pendingApprovals.filter((approval) => {
      const due = new Date(approval.expiresAt).getTime();
      return Number.isFinite(due) && due <= cutoff;
    }).length;
  }, [pendingApprovals]);
  const [bookingBusy, setBookingBusy] = useState<{ id: string; action: BookingAction } | null>(null);
  // Re-routing cancels a booking and returns the held money, so it is
  // confirmed first. The other two actions are cheap to undo.
  const [rerouteTarget, setRerouteTarget] = useState<RoutingDecisionItem | null>(null);

  const runBookingAction = useCallback(
    async (item: RoutingDecisionItem, action: BookingAction) => {
      if (!item.appointmentId) return;
      setBookingBusy({ id: item.appointmentId, action });
      try {
        if (action === 'confirm_time') {
          const current = await BookingAPI.get(item.requestId);
          if (current.data?.coordination) { navigate(`/dashboard/requests/${item.requestId}#visit-coordination`); return; }
        }
        await LandlordAPI.resolveAppointment(item.appointmentId, action);
        // The card disappearing says the rest; these say what can't be seen.
        if (action === 'confirm_time') toast.success('Confirmed — the vendor has their job link');
        if (action === 'reroute') toast.success('Booking cancelled — finding another vendor');
        await refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not update the booking');
      } finally {
        setBookingBusy(null);
      }
    },
    [refresh]
  );

  const handleBookingAction = useCallback(
    (item: RoutingDecisionItem, action: BookingAction) => {
      if (action === 'reroute') setRerouteTarget(item);
      else void runBookingAction(item, action);
    },
    [runBookingAction]
  );

  const decideApproval = useCallback(
    async (
      id: string,
      status: 'approved' | 'rejected',
      approvedAmount?: number,
      outcome?: 'counter_offer' | 'booked' | 'completion_review' | 'contact' | 'cost_permission' | 'cost_review' | 'step',
      expected?: { expectedQuoteRevision?: number; expectedQuoteHash?: string }
    ) => {
      // Optimistic, and it has to happen BEFORE the request rather than after.
      // The work behind a decision runs for seconds — finalizeVendorAcceptance
      // books the appointment and sends email through Resend, a routing quota
      // approval re-runs the entire vendor search, a completion overage writes
      // the ledger and moves money — and the badge must not sit on the old
      // number for the whole of it. Decrementing after the await is what made
      // it linger.
      adjustLandlordBadge('decisions', -1);
      setBusyApprovalId(id);
      try {
        await LandlordAPI.decideApprovalRequest(id, status, approvedAmount, expected);
        toast.success(
          outcome === 'cost_permission'
            ? status === 'approved'
              ? 'Follow-up allowed. One question will be prepared for the vendor.'
              : 'Follow-up declined. The cost review stays with you.'
            : outcome === 'cost_review'
              ? status === 'approved'
                ? 'Scope review confirmed. Other checks still apply.'
                : 'Kept paused for review'
            : outcome === 'step'
              ? status === 'approved'
                ? 'Step allowed'
                : 'Step paused'
            : status !== 'approved'
            ? 'Approval rejected'
            : outcome === 'contact'
              ? 'Vendor contact approved — check routing for delivery status'
            : outcome === 'counter_offer'
              ? 'Sent to the vendor for confirmation'
              : outcome === 'completion_review'
                ? // Approving a completion review does NOT pay the vendor — it
                  // asks the tenant to confirm. Saying "authorized" here would
                  // misdescribe what just happened.
                  'Sent to the tenant to confirm'
                : 'Authorized — booking the appointment'
        );
        await refresh();
        // Reconcile against committed state now the server is finished. One
        // decision can raise the next (an overage approval raises the completion
        // review), so the count is not always simply one lower.
        void refreshLandlordBadges();
      } catch (err) {
        // The decision did not land, so put it back on the badge.
        adjustLandlordBadge('decisions', 1);
        if (isStaleDecision(err)) {
          // The quote, review or step changed underneath this card. Show the
          // current Decision rather than pretending this one went through.
          toast.info(err instanceof Error && err.message ? err.message : 'This decision changed. Showing the current one.');
          await refresh();
          void refreshLandlordBadges();
          return;
        }
        // The server refuses a ceiling below the vendor's floor with a 400 whose
        // message names the minimum, so surfacing it verbatim is the useful thing.
        toast.error(err instanceof Error ? err.message : 'Failed to update approval');
      } finally {
        setBusyApprovalId(null);
      }
    },
    [refresh]
  );

  const presentTypes = useMemo(() => {
    const known = APPROVAL_TYPE_ORDER.filter((type) => typeCounts[type]);
    const unknown = Object.keys(typeCounts).filter((type) => !APPROVAL_TYPE_META[type]);
    return [...known, ...unknown];
  }, [typeCounts]);
  // Decided elsewhere (the request page, another tab, Iris resuming after an
  // approval): the server nudges `requests` and `request:<id>`, and an
  // emergency alert can arrive as a notification before its search finishes.
  // These refetch SILENTLY -- no spinner, open dialogs stay mounted -- and wait
  // while a decision of the landlord's own is in flight, whose own refresh
  // follows. Polling and focus are covered by useBackgroundRefresh.
  const busyRef = useRef(false);
  busyRef.current = Boolean(busyApprovalId || bookingBusy || appealBusy);
  useBackgroundRefresh(
    focusRequestId ? ['notifications', 'requests', `request:${focusRequestId}`] : ['notifications', 'requests'],
    async () => {
      await Promise.all([reloadApprovals({ silent: true }), reloadRequests({ silent: true })]);
      void refreshLandlordBadges();
    },
    () => busyRef.current
  );

  const loading = approvalsLoading || requestsLoading;
  const error = approvalsError || requestsError;

  if (loading) {
    return <D3State><LandlordLoading label="Loading decisions..." /></D3State>;
  }

  if (error) {
    return <D3State><LandlordError title="Decisions unavailable" message={error} onRetry={() => void refresh()} /></D3State>;
  }

  return (
    <D3Page>
      <PageHeader
        title="Decisions Needed"
        description="Review pending approvals, routing exceptions, and bookings that need you."
      />

      {/* Summary only — every list is on this page, so the tiles don't link. */}
      <StatGrid className="mb-6">
        <StatCard
          wrap={d3}
          icon={FileText}
          tone="blue"
          label="Pending decisions"
          value={pendingApprovals.length + routingDecisions.length}
          sub="Require your review"
          testId="decisions-stat-total"
        />
        <StatCard
          wrap={d3}
          icon={AlertTriangle}
          tone={vendorRoutingDecisions.length ? 'rose' : 'slate'}
          label="Routing exceptions"
          value={vendorRoutingDecisions.length}
          sub="Waiting on a vendor choice"
          delay={60}
        />
        <StatCard
          wrap={d3}
          icon={Users}
          tone="violet"
          label="Approval requests"
          value={pendingApprovals.length}
          sub="Awaiting sign-off"
          delay={120}
        />
        <StatCard
          wrap={d3}
          icon={Clock}
          tone={expiringSoon ? 'amber' : 'slate'}
          label="Expiring soon"
          value={expiringSoon}
          sub="Approvals due within 24 hours"
          delay={180}
          testId="decisions-stat-expiring"
        />
      </StatGrid>

      <div className="space-y-6">
        {appealDecisions.length > 0 ? (
          <SectionCard
            className="d3-section-card"
            icon={Scale}
            title="Appeals"
            description="Tenants asking you to reconsider a rejection. Each request gets one appeal."
            action={<PendingChip count={appealDecisions.length} />}
          >
            <div className={SCROLL_LIST} data-testid="decisions-appeal-list">
              {appealDecisions.map((item) => (
                <AppealDecisionCard
                  key={`appeal-${item.requestId}`}
                  item={item}
                  pulse={pulseRequestId === item.requestId}
                  onAccept={() => setReopenTarget(appealTargetOf(item))}
                  onDecline={() => setDeclineTarget(appealTargetOf(item))}
                  onOpen={() => navigate(`/dashboard/requests/${item.requestId}`)}
                />
              ))}
            </div>
          </SectionCard>
        ) : null}

        {reviewDecisions.length > 0 ? (
          <SectionCard
            className="d3-section-card"
            icon={ShieldAlert}
            title="Needs your review"
            description="Requests on hold for a person: a safety concern to assess, or details the tenant sent."
            action={<PendingChip count={reviewDecisions.length} />}
          >
            <div className={SCROLL_LIST} data-testid="decisions-review-list">
              {reviewDecisions.map((item) => (
                <ReviewDecisionCard
                  key={`${item.type}-${item.requestId}`}
                  item={item}
                  pulse={pulseRequestId === item.requestId}
                  // Safety and intake reviews are about the tenant's report, not a
                  // vendor, so these land on Overview (decisionHref is for vendor work).
                  onOpen={() => navigate(`/dashboard/requests/${item.requestId}?tab=overview`)}
                />
              ))}
            </div>
          </SectionCard>
        ) : null}

        {bookingDecisions.length > 0 ? (
          <SectionCard
            className="d3-section-card"
            icon={Clock}
            title="Bookings"
            description="Visits that need you: a time the tenant hasn't confirmed, or a vendor who didn't arrive."
            action={<PendingChip count={bookingDecisions.length} />}
          >
            <div className={SCROLL_LIST}>
              {bookingDecisions.map((item) => (
                <BookingDecisionCard
                  key={`${item.type}-${item.appointmentId}`}
                  item={item}
                  pulse={pulseRequestId === item.requestId}
                  busy={bookingBusy?.id === item.appointmentId ? bookingBusy.action : null}
                  onAction={handleBookingAction}
                  onOpen={() => navigate(decisionHref(item.requestId))}
                />
              ))}
            </div>
          </SectionCard>
        ) : null}

        {vendorRoutingDecisions.length > 0 ? (
          <SectionCard
            className="d3-section-card"
            icon={UserPlus}
            title="Vendor routing"
            description="Requests waiting on you to contact a vendor."
            action={<PendingChip count={vendorRoutingDecisions.length} />}
          >
            <div className={SCROLL_LIST} data-testid="decisions-routing-list">
              {vendorRoutingDecisions.map((item) => (
                <RoutingDecisionCard
                  key={`${item.type}-${item.requestId}`}
                  item={item}
                  request={requests.find((row) => row._id === item.requestId)}
                  pulse={pulseRequestId === item.requestId}
                  onApproveContact={openApproveContact}
                  onOpen={() => navigate(decisionHref(item.requestId, { paused: item.type === 'routing_paused' }))}
                />
              ))}
            </div>
          </SectionCard>
        ) : null}

        <SectionCard
            className="d3-section-card"
          icon={ClipboardCheck}
          title="Pending approvals"
          description="Actions waiting on your sign-off."
          action={pendingApprovals.length ? <PendingChip count={pendingApprovals.length} /> : undefined}
        >
          {pendingApprovals.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title="You're all caught up"
              description="There are no approvals waiting for your review right now."
            />
          ) : (
            <>
              <div className="mb-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setTypeFilter('all')}
                  aria-pressed={typeFilter === 'all'}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                    typeFilter === 'all'
                      ? 'bg-slate-900 text-white in-[.lichen-d3]:bg-primary in-[.lichen-d3]:text-primary-foreground'
                      : "border border-slate-200 bg-white text-slate-600 hover:border-slate-300 in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card in-[.lichen-d3]:text-meta in-[.lichen-d3]:hover:border-control-border"
                  }`}
                >
                  All ({pendingApprovals.length})
                </button>
                {presentTypes.map((type) => {
                  const meta = approvalTypeMeta(type);
                  const active = typeFilter === type;
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setTypeFilter(active ? 'all' : type)}
                      aria-pressed={active}
                      className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                        active
                          ? 'bg-slate-900 text-white in-[.lichen-d3]:bg-primary in-[.lichen-d3]:text-primary-foreground'
                          : "border border-slate-200 bg-white text-slate-600 hover:border-slate-300 in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card in-[.lichen-d3]:text-meta in-[.lichen-d3]:hover:border-control-border"
                      }`}
                    >
                      {meta.label} ({typeCounts[type]})
                    </button>
                  );
                })}
              </div>

              {filteredApprovals.length === 0 ? (
                <EmptyState
                  icon={ClipboardCheck}
                  title="No matching approvals"
                  description="No pending approvals match this filter."
                />
              ) : (
                <div className={SCROLL_LIST} data-testid="decisions-approvals-list">
                  {filteredApprovals.map((approval) => {
                    const request = requests.find((row) => row._id === approval.requestId);
                    const meta = approvalTypeMeta(approval.type);
                    const expiry = expiryInfo(approval.expiresAt);
                    const metaParts = requestMetaParts(request);
                    return (
                      <div
                        key={approval._id}
                        id={`decision-card-${approval.requestId}`}
                        className={`d3-approval-row flex scroll-mt-24 flex-col gap-3 rounded-xl border p-4 transition sm:flex-row sm:items-start sm:justify-between in-[.lichen-d3]:rounded-lg ${
                          pulseRequestId === approval.requestId ? 'decision-pulse ' : ''
                        }border-slate-200 bg-white hover:border-slate-300 in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card in-[.lichen-d3]:hover:border-control-border`}
                      >
                        <div className="flex min-w-0 flex-1 gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink">
                                {request?.ai?.shortTitle || request?.issueTitle || 'Maintenance request'}
                              </span>
                              <span
                                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${meta.badge} in-[.lichen-d3]:bg-pill-neutral in-[.lichen-d3]:text-chip-icon`}
                              >
                                {meta.label}
                              </span>
                              {expiry ? (
                                <span
                                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                                    expiry.urgent
                                      ? "bg-amber-50 text-amber-700 in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-text"
                                      : "bg-slate-100 text-slate-500 in-[.lichen-d3]:bg-chip in-[.lichen-d3]:text-meta"
                                  }`}
                                >
                                  <Clock className="h-3 w-3" />
                                  {expiry.label}
                                </span>
                              ) : null}
                            </div>
                            {metaParts.length > 0 ? (
                              <p className="mt-1 text-xs text-slate-500 in-[.lichen-d3]:text-meta">{metaParts.join(' • ')}</p>
                            ) : null}
                            <RequestIdentity id={approval.requestId} createdAt={request?.createdAt} />
                            <p className="mt-1.5 line-clamp-2 text-sm text-slate-600 in-[.lichen-d3]:text-meta">
                              {approval.reason || 'No reason provided.'}
                            </p>
                            {approval.type === 'cost_review' ? <CostReviewContext approval={approval} /> : null}
                            {approval.type === 'other' ? <CoordinationStepContext approval={approval} /> : null}
                            {approval.payload?.priority === 'emergency' || request?.urgency === 'emergency' ? (
                              <span className="mt-1 inline-flex rounded-md bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-700 in-[.lichen-d3]:bg-alert-tint in-[.lichen-d3]:text-alert-text">Emergency</span>
                            ) : null}
                            {approval.payload?.vendorName && ['vendor_contact_approval', 'first_time_vendor'].includes(approval.type) ? (
                              <p className="mt-1 text-sm font-medium text-slate-700 in-[.lichen-d3]:text-ink">Contact {approval.payload.vendorName}</p>
                            ) : null}
                            {/* Waiting only because no quota exists. Approving
                                handles this one job; the quota fixes every job
                                after it, so offer the way there too. */}
                            {approval.payload?.reason === 'quota_not_set' ? (
                              <button
                                type="button"
                                onClick={() => navigate('/dashboard/policy')}
                                className="mt-1 text-xs font-medium text-[#137fec] hover:underline in-[.lichen-d3]:text-lichen-text"
                                data-testid="approval-set-quota"
                              >
                                Set your spending quota
                              </button>
                            ) : null}
                            {/* THE COMPLETION REPORT. Without this the manager
                                was asked to rule on a job they could not see —
                                which is how the first end-to-end run stalled. */}
                            {approval.type === 'completion_review' &&
                            approval.payload?.completion ? (
                              <div
                                className="mt-3 rounded-lg border border-slate-200 bg-slate-50/70 p-3 in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-well"
                                data-testid="approval-completion-report"
                              >
                                <div className="flex flex-wrap items-baseline justify-between gap-2">
                                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 in-[.lichen-d3]:text-meta">
                                    What the vendor reported
                                  </span>
                                  <span className="text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink">
                                    ${Number(
                                      approval.payload.completion.actualCost ?? 0
                                    ).toLocaleString()}{' '}
                                    {approval.payload.completion.currency || 'CAD'}
                                    {approval.payload.completion.approvedCeiling != null ? (
                                      <span className="ml-1 text-xs font-normal text-slate-400 in-[.lichen-d3]:text-meta">
                                        of $
                                        {Number(
                                          approval.payload.completion.approvedCeiling
                                        ).toLocaleString()}{' '}
                                        approved
                                      </span>
                                    ) : null}
                                  </span>
                                </div>

                                <p className="mt-2 text-sm leading-6 text-slate-700 in-[.lichen-d3]:text-ink">
                                  {approval.payload.completion.workPerformed ||
                                    'No description given.'}
                                </p>

                                {approval.payload.completion.partsUsed ? (
                                  <p className="mt-1 text-xs text-slate-500 in-[.lichen-d3]:text-meta">
                                    Parts: {approval.payload.completion.partsUsed}
                                  </p>
                                ) : null}

                                {approval.payload.completion.followUpNeeded ? (
                                  <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-900 in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-text">
                                    Vendor flagged more work needed
                                    {approval.payload.completion.followUpNotes
                                      ? `: ${approval.payload.completion.followUpNotes}`
                                      : '.'}
                                  </p>
                                ) : null}

                                {approval.payload.completion.photos?.length ? (
                                  <div className="mt-3 flex flex-wrap gap-2">
                                    {approval.payload.completion.photos.map(
                                      (photo: { url: string; label?: string | null }) => (
                                        <a
                                          key={photo.url}
                                          href={photo.url}
                                          target="_blank"
                                          rel="noreferrer"
                                          className="block h-16 w-16 overflow-hidden rounded border border-slate-200 bg-white in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card"
                                        >
                                          <img
                                            src={photo.url}
                                            alt={photo.label || 'Completed work'}
                                            className="h-full w-full object-cover"
                                            loading="lazy"
                                          />
                                        </a>
                                      )
                                    )}
                                  </div>
                                ) : null}

                                {/* WHY this needs a human. Without naming the gap
                                    the manager is guessing at what to check. */}
                                {approval.payload.completion.evidenceReasons?.length ? (
                                  <div className="mt-3 border-t border-slate-200 pt-2 in-[.lichen-d3]:border-border">
                                    <span className="text-xs font-medium text-slate-500 in-[.lichen-d3]:text-meta">
                                      Couldn&rsquo;t verify automatically:
                                    </span>
                                    <ul className="mt-1 space-y-0.5">
                                      {approval.payload.completion.evidenceReasons.map(
                                        (reason: string) => (
                                          <li key={reason} className="text-xs text-slate-600 in-[.lichen-d3]:text-meta">
                                            • {EVIDENCE_REASON_LABELS[reason] || reason}
                                          </li>
                                        )
                                      )}
                                    </ul>
                                  </div>
                                ) : null}
                              </div>
                            ) : null}

                            {/* The vendor's own words, captured at submit. This is
                                the difference between ruling on a number and
                                ruling on a reason — render it in full, not clamped. */}
                            {approval.payload?.overageReason ? (
                              <blockquote
                                className="mt-2 border-l-2 border-slate-300 pl-3 text-sm leading-6 text-slate-700 in-[.lichen-d3]:border-control-border in-[.lichen-d3]:text-ink"
                                data-testid="approval-overage-reason"
                              >
                                {approval.payload.overageReason}
                                {approval.payload.vendorName ? (
                                  <span className="mt-0.5 block text-xs text-slate-400 in-[.lichen-d3]:text-meta">
                                    — {approval.payload.vendorName}
                                  </span>
                                ) : null}
                              </blockquote>
                            ) : null}
                          </div>
                        </div>

                        <div className="flex shrink-0 flex-col gap-2 sm:items-end">
                          {approval.type === 'quota_increase' ? (
                            <QuotaDecisionActions approval={approval} onDecide={decideApproval} />
                          ) : approval.type === 'completion_review' ? (
                            <CompletionReviewActions
                              approval={approval}
                              onDecide={decideApproval}
                            />
                          ) : approval.type === 'cost_review' ? (
                            <CostReviewActions approval={approval} onDecide={decideApproval} busy={busyApprovalId !== null} />
                          ) : approval.type === 'other' ? (
                            // A named step, or (older Other) only the link
                            // above: never the whole-request buttons below.
                            <CoordinationStepActions approval={approval} onDecide={decideApproval} busy={busyApprovalId !== null} />
                          ) : (
                            <>
                              {typeof approval.amountRequested === 'number' ? (
                                <div className="sm:text-right">
                                  <div className="text-base font-bold text-slate-900 in-[.lichen-d3]:text-ink">
                                    ${approval.amountRequested.toLocaleString()}
                                  </div>
                                  <FieldLabel className="in-[.lichen-d3]:text-meta">Requested</FieldLabel>
                                </div>
                              ) : null}
                              <div className="flex flex-wrap gap-1.5 sm:justify-end">
                                {request && getContactCandidate(request) ? (
                                  <Button
                                    size="sm"
                                    className="h-8 bg-emerald-600 px-3 text-xs text-white hover:bg-emerald-700 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d3]:text-primary-foreground"
                                    disabled={busyApprovalId !== null}
                                    onClick={() => {
                                      if (['vendor_contact_approval', 'first_time_vendor'].includes(approval.type) && approval.payload?.candidateKey) {
                                        void decideApproval(approval._id, 'approved', undefined, 'contact');
                                      } else openApproveContact(request);
                                    }}
                                    data-testid={`approval-approve-${approval._id}`}
                                  >
                                    {busyApprovalId === approval._id ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                                    Approve contact
                                  </Button>
                                ) : null}
                                {request && canRejectRequest(request) ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-8 border-rose-200 px-3 text-xs text-rose-600 hover:bg-rose-50 in-[.lichen-d3]:border-alert-line in-[.lichen-d3]:text-alert-text in-[.lichen-d3]:hover:bg-alert-tint"
                                    onClick={() => openRejectRequest(request)}
                                  >
                                    Reject
                                  </Button>
                                ) : null}
                                {/* Neither contact action applies once a request
                                    is past routing, which left approvals of any
                                    other type rendering with NO buttons at all —
                                    the completion review was just the first type
                                    to expose it. Fall back to deciding the
                                    approval itself, which is always valid. */}
                                {!(request && getContactCandidate(request)) &&
                                !(request && canRejectRequest(request)) ? (
                                  <>
                                    <Button
                                      size="sm"
                                      className="h-8 bg-emerald-600 px-3 text-xs text-white hover:bg-emerald-700 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d3]:text-primary-foreground"
                                      onClick={() =>
                                        void decideApproval(approval._id, 'approved')
                                      }
                                      data-testid={`approval-approve-${approval._id}`}
                                    >
                                      Approve
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-8 border-rose-200 px-3 text-xs text-rose-600 hover:bg-rose-50 in-[.lichen-d3]:border-alert-line in-[.lichen-d3]:text-alert-text in-[.lichen-d3]:hover:bg-alert-tint"
                                      onClick={() =>
                                        void decideApproval(approval._id, 'rejected')
                                      }
                                      data-testid={`approval-reject-${approval._id}`}
                                    >
                                      Reject
                                    </Button>
                                  </>
                                ) : null}
                              </div>
                            </>
                          )}
                          <div className="flex flex-wrap gap-1.5 sm:justify-end">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 px-3 text-xs text-slate-600 hover:bg-slate-100 in-[.lichen-d3]:text-meta in-[.lichen-d3]:hover:bg-chip"
                              onClick={() => navigate(decisionHref(approval.requestId))}
                            >
                              View
                            </Button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </SectionCard>
      </div>
      {dialogs}
      <ReopenRequestDialog
        target={reopenTarget}
        busy={appealBusy}
        onClose={() => setReopenTarget(null)}
        onConfirm={(note) =>
          decideAppeal(
            () => LandlordAPI.reopenRequest(reopenTarget!.requestId, note),
            'Appeal accepted. The request is back in your queue.'
          )
        }
      />
      <DeclineAppealDialog
        target={declineTarget}
        busy={appealBusy}
        onClose={() => setDeclineTarget(null)}
        onConfirm={(reason) =>
          decideAppeal(
            () => LandlordAPI.declineAppeal(declineTarget!.requestId, reason),
            'Appeal declined. The tenant has been told.'
          )
        }
      />
      <AlertDialog open={Boolean(rerouteTarget)} onOpenChange={(open) => !open && setRerouteTarget(null)}>
        <D3AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Find another vendor?</AlertDialogTitle>
            <AlertDialogDescription>
              {rerouteTarget?.type === 'vendor_no_show'
                ? `This cancels ${rerouteTarget?.vendorName || 'the vendor'}'s booking, returns the held payment and records the no-show against them. The job goes to the next vendor in line.`
                : `This cancels ${rerouteTarget?.vendorName || 'the vendor'}'s booking and returns the held payment. It isn't counted against the vendor. The job goes to the next vendor in line.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the booking</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 hover:bg-rose-600/90 in-[.lichen-d3]:bg-destructive in-[.lichen-d3]:hover:bg-destructive/90 in-[.lichen-d3]:text-destructive-foreground"
              data-testid="booking-reroute-confirm"
              onClick={() => {
                const target = rerouteTarget;
                setRerouteTarget(null);
                if (target) void runBookingAction(target, 'reroute');
              }}
            >
              Cancel booking and re-route
            </AlertDialogAction>
          </AlertDialogFooter>
        </D3AlertDialogContent>
      </AlertDialog>
    </D3Page>
  );
}
