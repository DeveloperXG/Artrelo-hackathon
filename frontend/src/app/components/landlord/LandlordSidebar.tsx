import {
  Activity,
  AlertTriangle,
  BarChart3,
  Building,
  CalendarDays,
  DollarSign,
  Home,
  LogOut,
  Package,
  Users,
  Wallet,
  Wrench,
} from 'lucide-react';
import { NavLink } from 'react-router-dom';
import AstreloLogo from '../AstreloLogo';
import { useLandlordPaymentMode, type LandlordBadgeCounts } from '../../hooks/landlord/useLandlordBadges';
import FeedbackButton from '../FeedbackButton';
import { formatBadgeCount } from '../../lib/badgeCount';

// `badge` names the count that belongs to this tab.
//
// Two kinds live here, and the difference is whether the PAGE can resolve what
// the badge counts:
//
//   Decisions  — WORK. Cleared by deciding, never by looking, so it can never
//                read 0 over approvals that are still pending.
//   Requests,  — UNREAD. Cleared by opening, because those pages are where you
//   Schedule,    READ what changed rather than act on it. The landlord schedule
//   Wallet       in particular has no controls at all (AppointmentCard renders
//                its actions only for `audience === "tenant"`), so a work count
//                there survived every visit.
//
// Wallet is the hybrid: stuck money persists, ledger activity clears on open.
//
// NO BADGE ON THE TAB YOU ARE ON. The page itself is showing whatever the
// badge would count, so a number beside its own highlighted tab is noise; it
// reappears only if there is still something once you leave. (The unread pages
// also mark everything seen as you leave, so what changed while you were
// looking at it does not badge the tab behind you.)
const navItems: Array<{
  to: string;
  label: string;
  icon: typeof Home;
  testId: string;
  end?: boolean;
  badge?: keyof LandlordBadgeCounts;
}> = [
  { to: '/dashboard', label: 'Overview', icon: Home, testId: 'nav-overview-btn', end: true },
  { to: '/dashboard/requests', label: 'Requests', icon: Package, testId: 'nav-requests-btn', badge: 'requests' },
  { to: '/dashboard/activity', label: 'Activity', icon: Activity, testId: 'nav-activity-btn' },
  { to: '/dashboard/properties', label: 'Properties', icon: Building, testId: 'nav-properties-btn' },
  { to: '/dashboard/tenants', label: 'Tenants', icon: Users, testId: 'nav-tenants-btn' },
  { to: '/dashboard/vendors', label: 'Vendors', icon: Wrench, testId: 'nav-vendors-btn' },
  { to: '/dashboard/schedule', label: 'Schedule', icon: CalendarDays, testId: 'nav-schedule-btn', badge: 'schedule' },
  { to: '/dashboard/wallet', label: 'Wallet', icon: Wallet, testId: 'nav-wallet-btn', badge: 'wallet' },
  { to: '/dashboard/billing', label: 'Artrelo billing', icon: DollarSign, testId: 'nav-billing-btn' },
  { to: '/dashboard/reports', label: 'Reports', icon: BarChart3, testId: 'nav-reports-btn' },
  { to: '/dashboard/policy', label: 'Policy', icon: DollarSign, testId: 'nav-policy-btn' },
  { to: '/dashboard/decisions', label: 'Decisions Needed', icon: AlertTriangle, testId: 'nav-approvals-btn', badge: 'decisions' },
];

const BADGE_LABELS: Record<keyof LandlordBadgeCounts, string> = {
  decisions: 'needing a decision',
  schedule: 'changed since you last looked',
  requests: 'new since you last looked',
  wallet: 'needing attention',
};

function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] || '?').slice(0, 2);
  return letters.toUpperCase();
}

export default function LandlordSidebar({
  userName,
  founding,
  onLogout,
  mobile = false,
  badges,
}: {
  userName: string;
  /** Present when this landlord has accepted the founding offer. */
  founding?: { since: string | null } | null;
  onLogout: () => void;
  mobile?: boolean;
  /** Optional so any other caller keeps rendering a plain sidebar. */
  badges?: LandlordBadgeCounts;
}) {
  // A direct-pay landlord's wallet page is a list of payments they make
  // themselves, so it is named for that. Same route either way.
  const paymentMode = useLandlordPaymentMode();
  return (
    <aside
      className={
        // Always the Lichen shell (D2): the deepest layer, set off from the page
        // by a hairline rather than a shadow.
        mobile
          ? 'lichen flex flex-col gap-3'
          : 'lichen fixed inset-y-0 left-0 hidden w-64 flex-col overflow-y-auto border-r border-hairline bg-sidebar p-4 lg:flex'
      }
    >
      {/* The phone bar above the menu already shows the logo and name. */}
      {mobile ? null : (
        <div className="mb-8 flex items-center gap-2">
          <AstreloLogo className="h-8 w-8" />
          <div>
            <h1 className="text-base font-bold tracking-[-0.025em] text-ink">Artrelo</h1>
            <p className="text-xs text-sidebar-sub">Landlord Portal</p>
          </div>
        </div>
      )}

      <nav aria-label="Landlord" className="space-y-1">
        {navItems.map(({ to, label: navLabel, icon: Icon, testId, end, badge }) => {
          const label = badge === 'wallet' && paymentMode !== 'platform' ? 'Payments' : navLabel;
          const count = badge && badges ? badges[badge] : 0;
          return (
            // One tab stop per item: the link itself carries focus and
            // aria-current. (The animated wrapper this replaced was a second,
            // unlabelled tab stop on every item.)
            <NavLink
              key={to}
              to={to}
              end={end}
              data-testid={testId}
              className={({ isActive }) =>
                `relative flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors motion-reduce:transition-none ${
                  isActive
                    ? // Active: hairline ground, Ink label and a Lichen rule at the
                      // edge, so the cue is shape plus colour, never colour alone.
                      "bg-hairline text-ink before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:rounded-l-md before:bg-lichen before:content-[''] forced-colors:border forced-colors:border-[Highlight]"
                    : 'text-nav hover:bg-hairline/60 hover:text-ink'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon className={`h-4 w-4 shrink-0 ${isActive ? 'text-lichen' : ''}`} aria-hidden />
                  <span className="flex-1 truncate text-left">{label}</span>
                  {count > 0 && !isActive ? (
                    <span
                      data-testid={`${testId}-badge`}
                      // Read aloud as a quantity of work, not a bare number --
                      // and the real one, even when the pill says "9+".
                      aria-label={`${count} ${badge ? BADGE_LABELS[badge] : 'needing attention'}`}
                      // Lichen: "needs you". The count, not the colour, carries it.
                      className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-lichen px-1.5 font-mono text-[11px] font-semibold tabular-nums text-on-lichen"
                    >
                      {formatBadgeCount(count)}
                    </span>
                  ) : null}
                </>
              )}
            </NavLink>
          );
        })}
      </nav>

      <div className={mobile ? 'border-t border-hairline pt-3' : 'mt-auto border-t border-hairline pt-4'}>
        <div className="mb-2 flex items-center gap-3 px-2">
          <div
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
              // A founding landlord's avatar carries a Lichen ring: recognisable
              // at a glance, and quiet enough not to shout.
              founding
                ? 'bg-lichen-tint text-lichen-text ring-2 ring-lichen-line'
                : 'bg-hairline text-chip-icon'
            }`}
            aria-hidden
          >
            {initialsOf(userName)}
          </div>
          <div className="min-w-0 text-xs text-meta">
            <div className="truncate text-sm font-semibold text-ink">{userName}</div>
            {founding ? (
              <div
                data-testid="founding-label"
                className="truncate font-medium text-lichen-text"
                title={
                  founding.since
                    ? `Founding landlord since ${new Date(founding.since).toLocaleDateString(undefined, { dateStyle: 'long' })}`
                    : 'Founding landlord'
                }
              >
                Founding Landlord
              </div>
            ) : (
              <div>Property Owner</div>
            )}
          </div>
        </div>
        <FeedbackButton />
        <button
          type="button"
          data-testid="logout-btn"
          onClick={onLogout}
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-nav transition-colors hover:bg-hairline/60 hover:text-ink motion-reduce:transition-none"
        >
          <LogOut className="h-4 w-4" aria-hidden />
          Logout
        </button>
      </div>
    </aside>
  );
}
