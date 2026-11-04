import { lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { AppToaster } from './components/ui/AppToaster';
import ExternalRedirect from './components/ExternalRedirect';
import RouteFallback from './components/RouteFallback';
import ScrollToTop from './components/ScrollToTop';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { REGISTRATION_ENABLED, SIGN_IN_ENABLED, TENANT_SIGNUP_ENABLED } from './config/features';
import { JudgeEntryDestination, signedInHome } from './components/judge/JudgeEntryDestination';

// Route-level code splitting.
//
// Every screen below is reached by exactly one of four audiences — a landlord, a
// tenant, a vendor, or someone signing in — and those sets do not overlap.
// Imported eagerly they all landed in a single ~1.27 MB bundle, so a contractor
// opening a magic link downloaded the entire landlord dashboard (recharts,
// Stripe.js, every dashboard page) just to render a job form.
//
// lazy() gives Rollup the split points; UI shared across areas is hoisted into
// common chunks on its own. What stays eagerly imported above is either on every
// path (the auth provider, the route guard, the redirect helper) or too small to
// be worth a separate request.

// Auth gates.
const TenantSignup = lazy(() => import('./components/TenantSignup'));
const LandlordSignup = lazy(() => import('./components/LandlordSignup'));
const LandlordSignIn = lazy(() => import('./components/LandlordSignIn'));
// Accepting a beta landlord invite. Under /login* so the production proxy needs
// no change, and gated on SIGN_IN_ENABLED rather than REGISTRATION_ENABLED —
// an invite is not public sign-up, and the registration flag is exactly what is
// meant to stay shut while invites work.
const LandlordInvitePage = lazy(() => import('./pages/auth/LandlordInvitePage'));
// Password reset. Gated with sign-in, not registration: an account that exists
// must stay recoverable whatever the registration flags say.
const ForgotPasswordPage = lazy(() => import('./pages/auth/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() => import('./pages/auth/ResetPasswordPage'));

// Reached from both the tenant portal and the landlord dashboard, so Rollup
// places it in a chunk shared by the two rather than duplicating it.
const RequestDetail = lazy(() => import('./components/RequestDetail'));

// Landlord dashboard. The heaviest area: OverviewPage pulls in recharts and
// WalletPage pulls in Stripe.js, neither of which any other audience touches.
const LandlordLayout = lazy(() => import('./layouts/LandlordLayout'));
const OverviewPage = lazy(() => import('./pages/landlord/OverviewPage'));
const RequestsPage = lazy(() => import('./pages/landlord/RequestsPage'));
const PropertiesPage = lazy(() => import('./pages/landlord/PropertiesPage'));
const PropertyHistoryPage = lazy(() => import('./pages/landlord/PropertyHistoryPage'));
const TenantsPage = lazy(() => import('./pages/landlord/TenantsPage'));
const VendorsPage = lazy(() => import('./pages/landlord/VendorsPage'));
const PolicyPage = lazy(() => import('./pages/landlord/PolicyPage'));
const GuidedDemoPage = lazy(() => import('./pages/landlord/GuidedDemoPage'));
const DecisionsNeededPage = lazy(() => import('./pages/landlord/DecisionsNeededPage'));
const IrisActivityPage = lazy(() => import('./pages/landlord/IrisActivityPage'));
const LandlordSchedulePage = lazy(() => import('./pages/landlord/SchedulePage'));
const WalletPage = lazy(() => import('./pages/landlord/WalletPage'));
const BillingPage = lazy(() => import('./pages/landlord/BillingPage'));
const ReportsPage = lazy(() => import('./pages/landlord/ReportsPage'));

// Tenant portal.
const TenantLayout = lazy(() => import('./layouts/TenantLayout'));
const TenantRequestsPage = lazy(() => import('./pages/tenant/RequestsPage'));
const NewRequestPage = lazy(() => import('./pages/tenant/NewRequestPage'));
const SafetyConcernPage = lazy(() => import('./pages/tenant/SafetyConcernPage'));
const TenantSchedulePage = lazy(() => import('./pages/tenant/SchedulePage'));
const TenantSettingsPage = lazy(() => import('./pages/tenant/SettingsPage'));

// Vendor surfaces. The ones that most needed splitting: a vendor arrives cold
// from an email link, often on a phone, and has no account of any kind.
const VendorResponsePage = lazy(() => import('./pages/vendor/VendorResponsePage'));
const VendorSchedulingPage = lazy(() => import('./pages/vendor/VendorSchedulingPage'));
const VendorJobPage = lazy(() => import('./pages/vendor/VendorJobPage'));
const VendorHubPage = lazy(() => import('./pages/vendor/VendorHubPage'));
const VendorHubLoginPage = lazy(() => import('./pages/vendor/VendorHubLoginPage'));

// Preserve any existing deep links to the old top-level tenant detail path by
// forwarding them to the layout-nested route (which keeps the side nav).
function TenantRequestRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/portal/requests/${id}`} replace />;
}

function RoleHome() {
  const { user, isAuthenticated, loading } = useAuth();
  // Marketing lives in the separate Next.js app now; the SPA no longer renders a
  // public landing page. Under the production reverse proxy "/" is served by the
  // marketing build and never reaches the SPA — this only runs in proxy-less dev
  // or as the client-side target of an in-app <Navigate to="/">.
  if (loading) return <RouteFallback />;
  if (!isAuthenticated)
    return SIGN_IN_ENABLED ? <Navigate to="/login" replace /> : <ExternalRedirect to="/" />;
  const destination = user ? signedInHome(user) : { pathname: '/dashboard', state: null };
  return <Navigate to={destination.pathname} state={destination.state} replace />;
}

function App() {
  return (
    <AuthProvider>
      <Router>
        <ScrollToTop />
        <AppToaster />
        {/* One boundary around the whole route table. Every lazy element below is
            a route target, so a navigation resolves at most one pending chunk and
            this fallback is what fills that gap. */}
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={<RoleHome />} />

            {/* Three gates, not one. A closed beta still has to let invited
                accounts in — an existing account signing in, and a tenant
                redeeming a code their landlord issued — while public landlord
                sign-up stays shut. Flagged separately in ./config/features.ts
                (mirrored in the marketing app's config/features.ts). A route
                behind a closed gate redirects to the marketing site, so it
                cannot be reached by direct URL either. */}
            <Route
              path="/signup"
              element={TENANT_SIGNUP_ENABLED ? <TenantSignup /> : <ExternalRedirect to="/" />}
            />
            <Route
              path="/landlord-signup"
              element={REGISTRATION_ENABLED ? <LandlordSignup /> : <ExternalRedirect to="/" />}
            />
            <Route
              path="/login"
              element={SIGN_IN_ENABLED ? <LandlordSignIn /> : <ExternalRedirect to="/" />}
            />
            {/* A sibling of /login, not a child: react-router v6 matches "/login"
                exactly, so this needs its own entry. The path matters beyond
                routing — the production proxy hands the whole /login* prefix to
                the SPA, so putting the invite page here needed no Caddy change. */}
            <Route
              path="/login/invite"
              element={SIGN_IN_ENABLED ? <LandlordInvitePage /> : <ExternalRedirect to="/" />}
            />
            <Route
              path="/login/forgot"
              element={SIGN_IN_ENABLED ? <ForgotPasswordPage /> : <ExternalRedirect to="/" />}
            />
            <Route
              path="/login/reset"
              element={SIGN_IN_ENABLED ? <ResetPasswordPage /> : <ExternalRedirect to="/" />}
            />

            <Route element={<ProtectedRoute allowedRoles={['tenant']} />}>
              <Route path="/portal" element={<TenantLayout />}>
                <Route index element={<TenantRequestsPage />} />
                <Route path="new" element={<NewRequestPage />} />
                <Route path="safety" element={<SafetyConcernPage />} />
                <Route path="schedule" element={<TenantSchedulePage />} />
                <Route path="settings" element={<TenantSettingsPage />} />
                <Route path="requests/:id" element={<RequestDetail />} />
              </Route>
              <Route path="/requests/:id" element={<TenantRequestRedirect />} />
            </Route>

            <Route element={<ProtectedRoute allowedRoles={['landlord']} />}>
              <Route path="/dashboard" element={<LandlordLayout />}>
                <Route index element={<JudgeEntryDestination><OverviewPage /></JudgeEntryDestination>} />
                <Route path="requests" element={<RequestsPage />} />
                <Route path="requests/:id" element={<RequestDetail />} />
                <Route path="properties" element={<PropertiesPage />} />
                <Route path="properties/:propertyId" element={<PropertyHistoryPage />} />
                <Route path="tenants" element={<TenantsPage />} />
                <Route path="vendors" element={<VendorsPage />} />
                <Route path="schedule" element={<LandlordSchedulePage />} />
                <Route path="wallet" element={<WalletPage />} />
                <Route path="billing" element={<BillingPage />} />
                <Route path="reports" element={<ReportsPage />} />
                <Route path="policy" element={<PolicyPage />} />
                <Route path="guided-demo" element={<GuidedDemoPage />} />
                <Route path="decisions" element={<DecisionsNeededPage />} />
                <Route path="activity" element={<IrisActivityPage />} />
              </Route>
            </Route>

            {/* Public vendor response form. Deliberately outside both
                ProtectedRoute blocks and outside the REGISTRATION_ENABLED gate:
                the magic-link token is the authorization, and a vendor answering
                a job is not registering. */}
            <Route path="/vendor-response/:token" element={<VendorResponsePage />} />
            <Route path="/vendor-scheduling/:token" element={<VendorSchedulingPage />} />
            {/* The post-visit surface. A different, job-scoped token that outlives
                the outreach row — see backend/models/JobToken.js. */}
            <Route path="/vendor-job/:token" element={<VendorJobPage />} />

            {/* The vendor hub. Outside both auth guards, like the job links:
                a contractor has no landlord or tenant account, and their session
                is a hub cookie that deliberately cannot satisfy those guards. */}
            <Route path="/vendor-hub" element={<VendorHubPage />} />
            <Route path="/vendor-hub/sign-in" element={<VendorHubLoginPage />} />
            <Route path="/vendor-hub/enter/:token" element={<VendorHubLoginPage />} />

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </Router>
    </AuthProvider>
  );
}

export default App;
