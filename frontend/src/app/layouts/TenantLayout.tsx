import { Menu } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useLiveConnection } from '../hooks/useLiveTopic';
import TenantSidebar from '../components/tenant/TenantSidebar';
import TenantMoveOutBanner from '../components/tenant/TenantMoveOutBanner';
import AstreloLogo from '../components/AstreloLogo';
import { Button } from '../components/ui/button';
import { useTenantBadges } from '../hooks/tenant/useTenantBadges';
import { useTenantMoveOutState } from '../hooks/tenant/useTenantMoveOut';
import NotificationBell from '../components/notifications/NotificationBell';
import { tenantNotificationTarget } from '../components/tenant/tenantNotificationTarget';
import { DESKTOP_QUERY, useMediaQuery } from '../hooks/useMediaQuery';
import { JudgeSandboxProvider, judgeIdentity } from '../components/judge/JudgeSandboxProvider';
import { JudgeBanner } from '../components/judge/JudgeViews';
import { TenantPresentationProvider, useTenantPresentation } from '../components/tenant/tenantPresentation';
import { isLichenTenantPath } from '../lib/lichenRoutes';
import { useTenantRouteFocus } from '../components/tenant/useTenantRouteFocus';

export default function TenantLayout() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const active = isLichenTenantPath(pathname);
  // Off unless the server says this account is a judge sandbox pair.
  return (
    <JudgeSandboxProvider identity={judgeIdentity(user)}>
      <TenantPresentationProvider active={active}>
        <TenantShell />
      </TenantPresentationProvider>
    </JudgeSandboxProvider>
  );
}

function TenantShell() {
  // One live stream for the whole signed-in shell; pages subscribe by topic.
  useLiveConnection();
  const { user, logout } = useAuth();
  const active = useTenantPresentation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  // This layout stays mounted across routes, so the menu would otherwise stay
  // open over the page it just navigated to. Keyed on location.key rather than
  // pathname so tapping the item for the current page closes it too.
  const { key: locationKey, pathname } = useLocation();
  const previousLocationKey = useRef(locationKey);
  useEffect(() => {
    if (previousLocationKey.current === locationKey) return;
    previousLocationKey.current = locationKey;
    if (active && mobileNavOpen) menuButtonRef.current?.focus();
    setMobileNavOpen(false);
  }, [locationKey, active, mobileNavOpen]);
  useTenantRouteFocus(active, pathname, mainRef);
  // This remains an inline navigation disclosure, not a modal/menu widget.
  useEffect(() => {
    if (!active || !mobileNavOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      setMobileNavOpen(false);
      menuButtonRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, mobileNavOpen]);
  const userName = user?.name || 'Tenant';
  // Fetched once here and passed to both sidebars — the desktop and mobile
  // copies are the same nav, so calling the hook inside the component would
  // make every navigation fetch twice.
  const { counts: badges } = useTenantBadges();
  // Once here, shared with the pages through the outlet (useTenantMoveOut).
  const moveOut = useTenantMoveOutState();
  // The bell polls, so exactly one copy is mounted -- beside the menu button on
  // a phone, above the page on desktop -- as in the landlord layout.
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const bell = (
    <NotificationBell
      // A new account or profile gets a fresh bell: nothing of the last one shows.
      key={judgeIdentity(user) ?? 'signed-out'}
      resolveTarget={tenantNotificationTarget}
      emptyHint="Updates on your requests, visits and appeals will show up here."
      panel={active ? 'light' : undefined}
      tenantPresentation={active}
    />
  );

  return (
    <div
      className={active ? 'min-h-screen bg-white' : 'min-h-screen bg-slate-50'}
      style={active ? undefined : {
        backgroundImage:
          'linear-gradient(to right, rgba(15, 23, 42, 0.04) 1px, transparent 1px), linear-gradient(to bottom, rgba(15, 23, 42, 0.04) 1px, transparent 1px)',
        backgroundSize: '48px 48px',
      }}
    >
      <TenantSidebar userName={userName} onLogout={logout} badges={badges} />

      <div className={active ? 'lichen border-b border-hairline bg-sidebar px-[min(1rem,16px)] py-3 font-sans lg:hidden' : 'border-b border-slate-200 bg-white px-4 py-3 shadow-sm lg:hidden'}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-min flex-1 basis-0 items-center gap-2">
            <AstreloLogo className="h-6 w-6 shrink-0" />
            <div className="min-w-0">
              <div className={`text-sm font-semibold ${active ? 'text-ink' : 'text-slate-900'}`}>Artrelo</div>
              <div className={`text-xs ${active ? 'text-sidebar-sub' : 'text-slate-500'}`}>Tenant Portal</div>
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
            {isDesktop ? null : bell}
            <Button ref={menuButtonRef} variant="outline" size="sm" aria-label="Menu" aria-expanded={mobileNavOpen} aria-controls="tenant-mobile-nav" data-testid="tenant-menu-button" className={active ? 'border-control-border' : undefined} onClick={() => setMobileNavOpen((value) => !value)}>
              <Menu className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
        {mobileNavOpen && (
          <div id="tenant-mobile-nav" className={active ? 'mt-3 min-w-0 rounded-lg border border-hairline bg-sidebar p-[min(0.75rem,12px)]' : 'mt-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm'}>
            <TenantSidebar userName={userName} onLogout={logout} mobile badges={badges} />
          </div>
        )}
      </div>

      <main ref={mainRef} tabIndex={active ? -1 : undefined} aria-label={active ? 'Tenant portal' : undefined} className={`@container/page p-4 lg:ml-64 lg:p-8${active ? ' lichen lichen-light lichen-d5 min-w-0 font-sans text-ink focus:outline-solid focus:outline-2 focus:outline-offset-2 focus:outline-ring [&_h1]:focus:outline-solid [&_h1]:focus:outline-2 [&_h1]:focus:outline-offset-2 [&_h1]:focus:outline-ring' : ''}`}>
        {isDesktop ? <div className="-mt-4 mb-2 flex justify-end">{bell}</div> : null}
        <JudgeBanner />
        <TenantMoveOutBanner status={moveOut.status} onChanged={moveOut.reload} />
        <Outlet context={moveOut} />
      </main>
    </div>
  );
}
