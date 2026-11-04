import { Menu } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useLiveConnection } from '../hooks/useLiveTopic';
import LandlordSidebar from '../components/landlord/LandlordSidebar';
import BetaStatusBanner from '../components/landlord/BetaStatusBanner';
import { BetaStatusProvider, useBetaStatus } from '../hooks/landlord/useBetaStatus';
import NotificationBell, { type PinnedNotification } from '../components/notifications/NotificationBell';
import { notificationTarget } from '../components/landlord/notificationTarget';
import AstreloLogo from '../components/AstreloLogo';
import { Button } from '../components/ui/button';
import { useLandlordBadges } from '../hooks/landlord/useLandlordBadges';
import { DESKTOP_QUERY, useMediaQuery } from '../hooks/useMediaQuery';
import { isLichenLandlordPath } from '../lib/lichenRoutes';
import { IrisProvider, useIris } from '../components/iris/IrisProvider';
import { IrisLauncher, IrisPanel } from '../components/iris/IrisPanel';
import { DOCK } from '../components/iris/irisDock';
import { JudgeSandboxProvider, judgeIdentity } from '../components/judge/JudgeSandboxProvider';
import { JudgeBanner } from '../components/judge/JudgeViews';

/**
 * The beta state is provided HERE, one level above the shell that reads it, so
 * the sidebar, banner, bell and Wallet page share one source of truth and one
 * dialog (see hooks/landlord/useBetaStatus).
 */
export default function LandlordLayout() {
  const { user } = useAuth();
  return (
    <BetaStatusProvider>
      {/* One Iris for every landlord page: it lives in the shell, so the
          conversation survives navigation between child routes. */}
      <IrisProvider>
        {/* Off unless the server says this account is a judge sandbox pair. */}
        <JudgeSandboxProvider identity={judgeIdentity(user)}>
          <LandlordShell />
          <IrisPanel />
        </JudgeSandboxProvider>
      </IrisProvider>
    </BetaStatusProvider>
  );
}

function LandlordShell() {
  // One live stream for the whole signed-in shell; pages subscribe by topic.
  useLiveConnection();
  const { user, logout } = useAuth();
  const { beta, founding, openOffer } = useBetaStatus();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // This layout stays mounted across routes, so the menu would otherwise stay
  // open over the page it just navigated to. Keyed on location.key rather than
  // pathname so tapping the item for the current page closes it too.
  const { key: locationKey, pathname } = useLocation();
  useEffect(() => setMobileNavOpen(false), [locationKey]);
  // The page column joins the Lichen LIGHT scope only on migrated pages; see
  // lib/lichenRoutes. The sidebar and the phone bar are always dark Lichen.
  const lichenPage = isLichenLandlordPath(pathname);
  // Escape closes the phone menu and hands focus back to its button, which is
  // where a keyboard user opened it from.
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMobileNavOpen(false);
      menuButtonRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mobileNavOpen]);
  // Fetched once here and passed to both sidebars — the desktop and mobile
  // copies are the same nav, and calling the hook in the component would make
  // every navigation fetch twice.
  const { counts: badges } = useLandlordBadges();
  // A docked Iris takes its width plus the divider from the right of the page
  // column, so the page reflows beside it instead of being covered.
  const iris = useIris();
  const reserve = iris?.state.open && iris.dock.docked ? iris.dock.width + DOCK.divider : 0;
  // The bell polls, so exactly one copy is mounted — in the sidebar-side top
  // bar on desktop, in the mobile bar otherwise — never one hidden by CSS.
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  // While the founding offer is open the bell carries a pinned row for it. It is
  // derived from live state, so it cannot be deleted and vanishes the moment the
  // landlord accepts or declines.
  const pinned: PinnedNotification[] =
    beta?.offer === 'pending'
      ? [
          {
            id: 'founding-offer',
            title: 'Your founding offer is waiting',
            message:
              beta.active && (beta.daysLeft ?? 0) > 0
                ? `Your free beta ends in ${beta.daysLeft} day${beta.daysLeft === 1 ? '' : 's'}. Reviewing your founding terms takes a minute and starts no billing.`
                : 'Your beta has ended. You can still claim your founding terms.',
            onSelect: openOffer,
          },
        ]
      : [];
  const bell = (
    <NotificationBell
      // A new account or profile gets a fresh bell: nothing of the last one shows.
      key={judgeIdentity(user) ?? 'signed-out'}
      resolveTarget={notificationTarget}
      emptyHint="New requests, disputes and payment alerts will show up here."
      pinned={pinned}
      // The trigger takes the scope it sits in (the page column on desktop,
      // the dark phone bar otherwise). The portaled panel follows the page
      // content: light on a migrated page; elsewhere legacy on desktop and
      // dark Lichen from the phone bar, as before.
      panel={lichenPage ? 'light' : isDesktop ? undefined : 'dark'}
    />
  );

  return (
    <div className={lichenPage ? 'min-h-screen bg-white' : 'min-h-screen bg-slate-50'}>
      <LandlordSidebar userName={user?.name || 'Landlord'} founding={founding} onLogout={logout} badges={badges} />

      <div className="lichen border-b border-hairline bg-sidebar px-4 py-3 lg:hidden">
        {/* Wraps at large text sizes, so the actions move to a second row instead of widening the phone viewport.
            The brand sizes from its min-content, so at normal sizes it narrows first and the row stays single. */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-min flex-1 basis-0 items-center gap-2">
            <AstreloLogo className="h-6 w-6 shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-ink">Artrelo</div>
              <div className="text-xs text-sidebar-sub">Landlord Portal</div>
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
            {isDesktop ? null : <IrisLauncher placement="phone" />}
            {isDesktop ? null : bell}
            <Button
              ref={menuButtonRef}
              variant="outline"
              size="sm"
              aria-label="Menu"
              aria-expanded={mobileNavOpen}
              aria-controls="landlord-mobile-nav"
              data-testid="mobile-menu-btn"
              className="border-control-border"
              onClick={() => setMobileNavOpen((value) => !value)}
            >
              <Menu className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </div>
        {mobileNavOpen && (
          <div id="landlord-mobile-nav" className="mt-3 rounded-lg border border-border bg-sidebar p-3">
            <LandlordSidebar userName={user?.name || 'Landlord'} founding={founding} onLogout={logout} mobile badges={badges} />
          </div>
        )}
      </div>

      {/* Full width beside the sidebar, capped so tables and charts don't
          stretch into unreadable lines on an ultrawide screen. */}
      <main
        ref={iris?.mainRef}
        style={reserve ? { marginRight: reserve } : undefined}
        className={`px-4 pb-10 pt-4 lg:ml-64 lg:px-8 lg:pt-6 ${lichenPage ? 'lichen lichen-light' : ''}`}
      >
        {/* A named container: page grids follow the width the page really has,
            which docked Iris narrows without changing the viewport. */}
        <div className="@container/page mx-auto w-full max-w-[1600px]">
          {isDesktop ? (
            <div className="mb-4 flex items-center justify-end gap-2">
              <IrisLauncher placement="desktop" ownScope={!lichenPage} />
              {bell}
            </div>
          ) : null}
          <JudgeBanner />
          <BetaStatusBanner />
          <Outlet />
        </div>
      </main>
    </div>
  );
}
