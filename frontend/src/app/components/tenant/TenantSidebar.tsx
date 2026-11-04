import { motion } from 'motion/react';
import { CalendarDays, FileText, LogOut, Settings } from 'lucide-react';
import FeedbackButton from '../FeedbackButton';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '../ui/button';
import AstreloLogo from '../AstreloLogo';
import type { TenantBadgeCounts } from '../../hooks/tenant/useTenantBadges';
import { formatBadgeCount } from '../../lib/badgeCount';
import { useTenantPresentation } from './tenantPresentation';

// The Requests tab also owns the new-request flow and the request detail view,
// so keep it highlighted across all of those paths (but not on Settings).
//
// `badge` names the count that belongs to a tab. Only Schedule carries one:
// it is the only place the tenant is ever the one being asked — for an arrival
// time, or for a verdict on finished work.
const navItems: Array<{
  to: string;
  label: string;
  icon: typeof FileText;
  testId: string;
  match: (path: string) => boolean;
  badge?: keyof TenantBadgeCounts;
}> = [
  {
    to: '/portal',
    label: 'Requests',
    icon: FileText,
    testId: 'tenant-nav-requests',
    match: (path: string) =>
      path === '/portal' || path.startsWith('/portal/requests') || path.startsWith('/portal/new') || path.startsWith('/portal/safety'),
  },
  {
    to: '/portal/schedule',
    label: 'Schedule',
    icon: CalendarDays,
    testId: 'tenant-nav-schedule',
    match: (path: string) => path.startsWith('/portal/schedule'),
    badge: 'schedule',
  },
  {
    to: '/portal/settings',
    label: 'Settings',
    icon: Settings,
    testId: 'tenant-nav-settings',
    match: (path: string) => path.startsWith('/portal/settings'),
  },
];

export default function TenantSidebar({
  userName,
  onLogout,
  mobile = false,
  badges,
}: {
  userName: string;
  onLogout: () => void;
  mobile?: boolean;
  /** Optional so any other caller keeps rendering a plain sidebar. */
  badges?: TenantBadgeCounts;
}) {
  const { pathname } = useLocation();
  const active = useTenantPresentation();
  return (
    <aside
      className={
        active
          ? `lichen min-w-0 font-sans text-ink ${mobile ? 'flex max-w-full flex-col gap-3' : 'fixed inset-y-0 left-0 hidden w-64 flex-col overflow-y-auto border-r border-hairline bg-sidebar p-[min(1rem,16px)] lg:flex'}`
          : mobile
          ? 'flex flex-col gap-3'
          : 'fixed inset-y-0 left-0 hidden w-64 flex-col border-r border-slate-200 bg-white p-4 shadow-sm lg:flex'
      }
    >
      <div className={`mb-8 flex items-center gap-2${active ? ' min-w-0' : ''}`}>
        <AstreloLogo className={`h-9 w-9${active ? ' shrink-0' : ''}`} />
        <div className={active ? 'min-w-0 [overflow-wrap:anywhere]' : undefined}>
          <h1 className="text-base font-bold tracking-tight">Artrelo</h1>
          <p className={`text-[10px] ${active ? 'text-sidebar-sub' : 'text-slate-500'}`}>Tenant Portal</p>
        </div>
      </div>

      <nav aria-label={active ? 'Tenant' : undefined} className="space-y-1.5">
        {navItems.map(({ to, label, icon: Icon, testId, match, badge }) => {
          const isActive = match(pathname);
          const count = badge && badges ? badges[badge] : 0;
          if (active) return (
            <Link key={to} to={to} data-testid={testId} aria-current={isActive ? 'page' : undefined}
              className={`relative flex min-w-0 max-w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-md px-[min(0.75rem,12px)] py-2 text-sm font-medium transition-colors motion-reduce:transition-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${isActive ? "bg-hairline text-ink before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:rounded-l-md before:bg-lichen before:content-[''] forced-colors:border forced-colors:border-[Highlight]" : 'text-nav hover:bg-hairline/60 hover:text-ink'}`}>
              <Icon className={`h-[min(1rem,16px)] w-[min(1rem,16px)] shrink-0 ${isActive ? 'text-lichen' : ''}`} aria-hidden="true" />
              <span className="min-w-0 flex-auto shrink-0 text-left [overflow-wrap:anywhere]">{label}</span>
              {count > 0 && !isActive ? <span data-testid={`${testId}-badge`} aria-label={`${count} waiting on you`}
                className="ml-auto inline-flex min-h-5 min-w-5 max-w-full shrink-0 items-center justify-center rounded-full bg-lichen px-[min(0.375rem,6px)] font-mono text-[11px] font-semibold tabular-nums text-on-lichen">{formatBadgeCount(count)}</span> : null}
            </Link>
          );
          return (
            <Link key={to} to={to}>
              <motion.div
                whileHover={{ x: 4 }}
                whileTap={{ scale: 0.98 }}
                data-testid={testId}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all ${
                  isActive
                    ? 'bg-[#137fec] text-white shadow-sm'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="flex-1 truncate text-left">{label}</span>
                {/* Not on the tab you are on: that page is showing it already. */}
                {count > 0 && !isActive ? (
                  <span
                    data-testid={`${testId}-badge`}
                    aria-label={`${count} waiting on you`}
                    className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-rose-500 px-1.5 text-[11px] font-semibold tabular-nums text-white"
                  >
                    {formatBadgeCount(count)}
                  </span>
                ) : null}
              </motion.div>
            </Link>
          );
        })}
      </nav>

      <div className={active ? `${mobile ? '' : 'mt-auto'} min-w-0 border-t border-hairline pt-3` : mobile ? '' : 'mt-auto'}>
        <div className={`mb-3 px-2 text-xs ${active ? 'min-w-0 text-meta [overflow-wrap:anywhere]' : 'text-slate-500'}`}>
          <div className={`font-semibold ${active ? 'text-ink' : 'text-slate-700'}`}>{userName}</div>
          <div>Tenant</div>
        </div>
        <FeedbackButton variant={active ? 'row' : 'outline'} />
        <Button data-testid="tenant-logout-btn" onClick={onLogout} variant={active ? 'ghost' : 'outline'} className={`w-full justify-start gap-2${active ? ' h-auto min-h-9 max-w-full whitespace-normal rounded-md px-[min(0.75rem,12px)] text-nav [overflow-wrap:anywhere] hover:bg-hairline/60 hover:text-ink' : ''}`}>
          <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
          Logout
        </Button>
      </div>
    </aside>
  );
}
