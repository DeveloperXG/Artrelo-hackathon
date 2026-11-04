import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Bell,
  CalendarClock,
  CheckCheck,
  CircleDollarSign,
  ClipboardCheck,
  Inbox,
  Loader2,
  MessageSquare,
  Pin,
  RotateCcw,
  Scale,
  SlidersHorizontal,
  Wrench,
  XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { NotificationsAPI, type AppNotification } from '../../api/client';
import { useJudgeSandboxEnabled } from '../judge/JudgeSandboxProvider';
import { NotificationFeed, bellPollMs, visiblePoll } from './notificationFeed';
import { useLiveTopic } from '../../hooks/useLiveTopic';
import { relativeTime } from '../../lib/relativeTime';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { cn } from '../ui/utils';
import { LICHEN_FOCUS } from '../ui/lichen';
import { formatBadgeCount } from '../../lib/badgeCount';

const LIMIT = 15;

/**
 * A row the bell shows ABOVE the stored list and that the user cannot remove.
 *
 * It is computed by the caller from live state rather than stored as a
 * notification: nothing exists to delete, it cannot go stale or scroll out of
 * the newest-15 window, and it disappears the instant the thing it points at is
 * resolved. It deliberately does not add to the unread badge -- a permanent
 * badge is a nag, and the banner already carries the weight.
 */
export type PinnedNotification = {
  id: string;
  title: string;
  message: string;
  onSelect: () => void;
};

function iconFor(type: string): { icon: LucideIcon; tone: string } {
  if (
    type.startsWith('payment') ||
    type === 'vendor_payout_sent' ||
    type === 'vendor_payout_clearing' ||
    type === 'vendor_payment_due'
  ) {
    return { icon: CircleDollarSign, tone: 'bg-emerald-50 text-emerald-600' };
  }
  if (type === 'request_rejected' || type === 'request_rejected_final' || type === 'maintenance_cancelled') {
    return { icon: XCircle, tone: 'bg-rose-50 text-rose-600' };
  }
  if (type === 'request_appeal_submitted') return { icon: Scale, tone: 'bg-fuchsia-50 text-fuchsia-600' };
  if (type === 'tenant_message_received' || type === 'landlord_message_received' || type === 'vendor_message_received') {
    return { icon: MessageSquare, tone: 'bg-sky-50 text-sky-600' };
  }
  if (type === 'policy_requests_reevaluated') return { icon: SlidersHorizontal, tone: 'bg-indigo-50 text-indigo-600' };
  if (type === 'request_reopened') return { icon: RotateCcw, tone: 'bg-emerald-50 text-emerald-600' };
  if (
    type === 'vendor_no_show_reported' ||
    type === 'maintenance_verification_disputed' ||
    type === 'vendor_outreach_exhausted'
  ) {
    return { icon: AlertTriangle, tone: 'bg-rose-50 text-rose-600' };
  }
  if (type.startsWith('appointment')) return { icon: CalendarClock, tone: 'bg-amber-50 text-amber-600' };
  if (type.startsWith('maintenance_verification') || type === 'maintenance_auto_confirmed') {
    return { icon: ClipboardCheck, tone: 'bg-violet-50 text-violet-600' };
  }
  return { icon: Wrench, tone: 'bg-[#137fec]/10 text-[#137fec]' };
}

/**
 * Whether a line-clamped element is hiding text. Measured, not guessed from
 * length: what fits in two lines depends on the popover's width (phone vs
 * desktop) and the words. Re-measured when the element resizes.
 */
function useIsClamped(text: string, active: boolean) {
  const ref = useRef<HTMLSpanElement>(null);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    // While expanded there is no clamp to measure; keep the last answer so the
    // "Show less" toggle stays.
    if (!el || !active) return undefined;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, active]);
  return { ref, clamped };
}

function NotificationRow({
  item,
  target,
  expanded,
  onOpen,
  onToggle,
  tenantPresentation = false,
}: {
  item: AppNotification;
  target: string | null;
  expanded: boolean;
  onOpen: () => void;
  onToggle: () => void;
  tenantPresentation?: boolean;
}) {
  const { icon: Icon, tone } = iconFor(item.type);
  const { ref, clamped } = useIsClamped(item.message, !expanded);
  // Only when there is more to read -- a two-line message gets no toggle.
  const canExpand = expanded || clamped;

  return (
    <li className={cn('transition hover:bg-slate-50 lichen:hover:bg-hairline', !item.read && 'bg-[#137fec]/[0.04] lichen:bg-new-row')}>
      <button
        type="button"
        onClick={onOpen}
        data-testid={`notification-${item._id}`}
        aria-expanded={target ? undefined : canExpand ? expanded : undefined}
        className={cn('flex w-full items-start gap-3 px-4 pt-3 text-left', tenantPresentation && 'flex-wrap sm:flex-nowrap')}
      >
        <span className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full', tone, 'lichen:bg-chip lichen:text-chip-icon')}>
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <span className={cn('min-w-0 flex-1', tenantPresentation && 'basis-full sm:basis-0')}>
          <span className={cn('flex items-start justify-between gap-2', tenantPresentation && 'min-w-0')}>
            <span className={cn('text-sm text-slate-900 lichen:text-ink', !item.read && 'font-semibold', tenantPresentation && 'min-w-0 [overflow-wrap:anywhere]')}>{item.title}</span>
            {!item.read ? <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[#137fec] lichen:bg-lichen-icon" aria-label="Unread" /> : null}
          </span>
          <span
            ref={ref}
            className={cn('mt-0.5 block text-xs text-slate-500 lichen:text-meta', expanded ? 'whitespace-pre-line leading-5' : 'line-clamp-2', tenantPresentation && '[overflow-wrap:anywhere]')}
          >
            {item.message}
          </span>
        </span>
      </button>
      {/* Outside the row's button: a notification that opens a page must be
          readable in full without leaving for it, and a button can't nest in
          a button. Indented to line up under the message (px-4 + icon + gap). */}
      <div className={cn('flex items-center gap-2 pb-3 pl-[60px] pr-4 pt-1 text-[11px] text-slate-400 lichen:text-meta', tenantPresentation && 'min-w-0 flex-wrap')}>
        {relativeTime(item.createdAt)}
        {canExpand ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            data-testid={`notification-readmore-${item._id}`}
            className="text-[11px] font-medium leading-none text-[#137fec] hover:underline lichen:text-lichen-text"
          >
            {expanded ? 'Show less' : 'Read more'}
          </button>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The bell in the top bar of both portals: the newest notifications the server
 * has already written for whoever is signed in. Read state lives on the
 * server, so it follows the user across devices.
 *
 * The portals differ only in where a click goes (`resolveTarget`) and what the
 * empty state says. A notification with nowhere to go -- a tenant's final
 * rejection, whose request has been deleted -- expands in place instead, since
 * its message is the only copy of what it says.
 */
export default function NotificationBell({
  resolveTarget,
  emptyHint,
  pinned = [],
  panel,
  tenantPresentation = false,
}: {
  resolveTarget: (notification: AppNotification) => string | null;
  emptyHint: string;
  /** Optional, so the tenant portal's bell is untouched. */
  pinned?: PinnedNotification[];
  /**
   * Lichen scope for the portaled panel (landlord shell); omitted, it stays
   * legacy. The trigger needs none: it inherits the scope it sits in.
   */
  panel?: 'dark' | 'light';
  /** Active D5 tenant layout only; other roles and legacy defaults stay unchanged. */
  tenantPresentation?: boolean;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // One feed per mount; the layouts key the bell by signed-in identity, so a
  // new account or profile starts empty and the old one's answers are dropped.
  const [feed] = useState(() => new NotificationFeed(NotificationsAPI, LIMIT));
  const { items, unread, loaded } = useSyncExternalStore(
    (listener) => feed.subscribe(listener),
    feed.getView,
    feed.getView
  );
  const judgeSandbox = useJudgeSandboxEnabled();

  useEffect(() => {
    feed.open();
    return () => feed.close();
  }, [feed]);

  useEffect(() => {
    void feed.load();
  }, [feed, location.pathname]);

  // The server nudges the moment it writes a notification for this user, and
  // a resync fires when the tab comes back into view. The visible-tab poll is
  // only the fallback for a dropped stream: 60 s, or 5 s in a judge sandbox
  // so a paired account's step shows up promptly.
  useEffect(() => visiblePoll(() => void feed.load(), bellPollMs(judgeSandbox)), [feed, judgeSandbox]);
  useLiveTopic('notifications', () => void feed.load());

  const markAllRead = () => feed.markAllRead();

  const openItem = (item: AppNotification) => {
    feed.markRead(item);
    const target = resolveTarget(item);
    if (target) {
      setOpen(false);
      navigate(target);
    } else {
      setExpandedId((current) => (current === item._id ? null : item._id));
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void feed.load();
        else setExpandedId(null);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="notification-bell"
          aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
          className={cn(
            'relative inline-flex h-10 w-10 items-center justify-center rounded-full text-slate-600 transition hover:bg-white hover:text-slate-900 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#137fec]/40',
            'lichen:text-nav lichen:hover:bg-hairline lichen:hover:text-ink lichen:hover:shadow-none',
            LICHEN_FOCUS
          )}
        >
          <Bell className="h-5 w-5" aria-hidden />
          {unread > 0 ? (
            <span
              data-testid="notification-bell-count"
              className="absolute right-1 top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold leading-none text-white ring-2 ring-slate-50 lichen:bg-lichen lichen:font-mono lichen:text-on-lichen lichen:ring-background"
            >
              {formatBadgeCount(unread)}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        // The panel is portaled to <body>, outside the shell, so it carries
        // the scope itself rather than inheriting it.
        className={cn(
          'w-[min(24rem,calc(100vw-2rem))] p-0',
          panel && 'lichen rounded-lg shadow-lichen-card',
          panel === 'light' && 'lichen-light',
          tenantPresentation && 'flex max-h-[var(--radix-popover-content-available-height,calc(100dvh-2rem))] flex-col',
          tenantPresentation && 'motion-reduce:animate-none! motion-reduce:transition-none! [&_*]:motion-reduce:animate-none! [&_*]:motion-reduce:transition-none!',
        )}
      >
        <div className={cn('flex items-center justify-between border-b border-slate-100 px-4 py-3 lichen:border-hairline', tenantPresentation && 'min-w-0 shrink-0 flex-wrap gap-x-3 gap-y-2')}>
          <div className={cn('text-sm font-semibold text-slate-900 lichen:text-ink', tenantPresentation && 'min-w-0 [overflow-wrap:anywhere]')}>Notifications</div>
          {unread > 0 ? (
            <button
              type="button"
              onClick={() => void markAllRead()}
              data-testid="notification-mark-all-read"
              className={cn('inline-flex items-center gap-1 text-xs font-medium text-[#137fec] hover:underline lichen:text-lichen-text', tenantPresentation && 'min-w-0 max-w-full flex-wrap text-left [overflow-wrap:anywhere]')}
            >
              <CheckCheck className="h-3.5 w-3.5" aria-hidden />
              Mark all read
            </button>
          ) : null}
        </div>

        <div className={cn('max-h-[26rem] overflow-y-auto', tenantPresentation && 'min-h-0')}>
          {pinned.length > 0 ? (
            <ul className="divide-y divide-[#137fec]/15 border-b border-[#137fec]/20 bg-[#137fec]/[0.06] lichen:divide-lichen-line lichen:border-lichen-line lichen:bg-lichen-wash" data-testid="notification-pinned">
              {pinned.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    data-testid={`notification-pinned-${item.id}`}
                    onClick={() => {
                      setOpen(false);
                      item.onSelect();
                    }}
                    className="flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-[#137fec]/[0.08] lichen:hover:bg-lichen-tint"
                  >
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#137fec]/10 text-[#137fec] lichen:bg-lichen-tint lichen:text-lichen-text">
                      <Pin className="h-4 w-4" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-slate-900 lichen:text-ink">{item.title}</span>
                      <span className="mt-0.5 block text-xs text-slate-600 lichen:text-meta">{item.message}</span>
                      <span className="mt-1 block text-[11px] font-medium text-[#137fec] lichen:text-lichen-text">Pinned until you decide</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {!loaded && pinned.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-sm text-slate-400 lichen:text-meta">
              <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
              Loading…
            </div>
          ) : !loaded ? (
            <div className="flex items-center justify-center py-6 text-sm text-slate-400 lichen:text-meta">
              <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
              Loading…
            </div>
          ) : items.length === 0 && pinned.length > 0 ? null : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-400 lichen:bg-chip lichen:text-chip-icon">
                <Inbox className="h-5 w-5" aria-hidden />
              </div>
              <p className="text-sm font-medium text-slate-600 lichen:text-ink">You&rsquo;re all caught up</p>
              <p className="text-xs text-slate-400 lichen:text-meta">{emptyHint}</p>
            </div>
          ) : (
            <ul className="divide-y divide-slate-100 lichen:divide-hairline">
              {items.map((item) => (
                <NotificationRow
                  key={item._id}
                  item={item}
                  target={resolveTarget(item)}
                  expanded={expandedId === item._id}
                  onOpen={() => openItem(item)}
                  onToggle={() => setExpandedId((current) => (current === item._id ? null : item._id))}
                  tenantPresentation={tenantPresentation}
                />
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
