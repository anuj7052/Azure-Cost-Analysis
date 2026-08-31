import { useEffect, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, useLocation, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, RequireAuth, LoginScreen } from './auth/AuthProvider';
import Sidebar from './components/Layout/Sidebar';
import Topbar from './components/Layout/Topbar';
import AssistantWidget from './components/Assistant/AssistantWidget';
import { useAppStore } from './store/useAppStore';
import { useTheme } from './store/useTheme';
import { useIsAuthenticated, useMsal } from '@azure/msal-react';
import { clearSecurityCache } from './components/Security/securityData';

// Lazy load pages — only loaded when user navigates to them
const Dashboard      = lazy(() => import('./pages/Dashboard'));
const CostExplorer   = lazy(() => import('./pages/CostExplorer'));
const Compare        = lazy(() => import('./pages/Compare'));
const Anomalies      = lazy(() => import('./pages/Anomalies'));
const Settings       = lazy(() => import('./pages/Settings'));
const ResourceGroups = lazy(() => import('./pages/ResourceGroups'));
const Provision = lazy(() => import('./pages/Provision'));
const Orphaned       = lazy(() => import('./pages/Orphaned'));
const Compute        = lazy(() => import('./pages/Compute'));
const GlobalSearch   = lazy(() => import('./pages/GlobalSearch'));
const Changes        = lazy(() => import('./pages/Changes'));
const ActivityLog    = lazy(() => import('./pages/ActivityExplorer'));
const Bandwidth      = lazy(() => import('./pages/Bandwidth'));
const Boq            = lazy(() => import('./pages/Boq'));
const Commitments    = lazy(() => import('./pages/Commitments'));
const Deploy         = lazy(() => import('./pages/Deploy'));
const Admin          = lazy(() => import('./pages/Admin'));
const Onboarding     = lazy(() => import('./pages/Onboarding'));
const AccessIdentity     = lazy(() => import('./pages/AccessIdentity'));
const NetworkVisualizer  = lazy(() => import('./pages/NetworkVisualizer'));
const AccessHistory      = lazy(() => import('./pages/AccessHistory'));
const Advisor            = lazy(() => import('./pages/Advisor'));
const Defender           = lazy(() => import('./pages/Defender'));
const PolicyGovernance   = lazy(() => import('./pages/PolicyGovernance'));
const Estate             = lazy(() => import('./pages/Estate'));
const SecurityHome       = lazy(() => import('./pages/SecurityHome'));
const AccountHome        = lazy(() => import('./pages/AccountHome'));
const ApiCatalog         = lazy(() => import('./pages/ApiCatalog'));
const Team               = lazy(() => import('./pages/Team'));
// Kept out of the authenticated bundle: it is the one page that is only ever
// seen by people who have not signed in.
const Landing            = lazy(() => import('./pages/Landing'));

/**
 * Send an old access URL to the merged page, keeping whatever it was pointing at.
 *
 * A bare `<Navigate>` would drop the query string, which is where the
 * interesting part of these links lives: `?principal=<id>` is the whole reason
 * somebody was sent the link in the first place.
 */
function LegacyAccessRedirect({ view }) {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  params.set('view', view);
  return <Navigate to={`/access-identity?${params}`} replace />;
}

const PageLoader = () => (
  <div className="flex h-[60vh] items-center justify-center">
    <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    <div
      className="w-8 h-8 rounded-full border-[3px] border-blue-500"
      style={{ borderTopColor: 'transparent', animation: 'spin 0.7s linear infinite' }}
    />
  </div>
);

/**
 * Shown when the account lookup fails.
 *
 * The two realistic causes need different actions, so both are offered rather
 * than guessing: the session may simply need re-establishing (sign in again),
 * or the backend may have been unreachable for one request (retry).
 */
function AccountLoadFailed({ error, onRetry }) {
  const { instance } = useMsal();

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-6">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 text-center">
        <h1 className="text-lg font-semibold text-white">Could not load your account</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">{error}</p>

        <div className="mt-6 flex gap-3">
          <button
            onClick={onRetry}
            className="flex-1 rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500"
          >
            Try again
          </button>
          <button
            onClick={() => { clearSecurityCache(); instance.clearCache(); instance.logoutRedirect(); }}
            className="flex-1 rounded-xl border border-slate-700 py-2.5 text-sm font-medium text-slate-300 transition hover:text-white"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Shown to someone who was added to a workspace that has no Azure tenant
 * connected yet.
 *
 * They cannot fix this themselves — connecting a tenant is the owner's right,
 * not theirs — so the screen does not offer a form. It names the one person
 * who can act and lets them re-check, which is the only two things that are
 * actually true here.
 */
function WorkspaceNotReady({ ownerEmail, onRetry }) {
  const { instance } = useMsal();

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-6">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 text-center">
        <h1 className="text-lg font-semibold text-white">Nothing to show yet</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          You have been added to{' '}
          {ownerEmail
            ? <span className="text-slate-200">{ownerEmail}</span>
            : 'this'}
          {ownerEmail ? "'s workspace" : ' workspace'}, but no Azure tenant has been
          connected to it yet. Once the workspace owner connects one, everything
          here fills in for you automatically — there is nothing for you to set up.
        </p>

        <div className="mt-6 flex gap-3">
          <button
            onClick={onRetry}
            className="flex-1 rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500"
          >
            Check again
          </button>
          <button
            onClick={() => { clearSecurityCache(); instance.clearCache(); instance.logoutRedirect(); }}
            className="flex-1 rounded-xl border border-slate-700 py-2.5 text-sm font-medium text-slate-300 transition hover:text-white"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

function AppShell() {
  const isAuthenticated = useIsAuthenticated();
  const { accounts } = useMsal();
  // Keying the page wrapper on the path re-mounts it on navigation, which is
  // what lets a plain CSS entrance play on every route change — no animation
  // library, and `prefers-reduced-motion` still switches it off globally.
  const location = useLocation();
  const loadTenants     = useAppStore(s => s.loadTenants);
  const addTenantToList = useAppStore(s => s.addTenantToList);
  const loadMe          = useAppStore(s => s.loadMe);
  const me              = useAppStore(s => s.me);
  const meError         = useAppStore(s => s.meError);

  useEffect(() => {
    if (isAuthenticated) loadMe();
  }, [isAuthenticated, loadMe]);

  useEffect(() => {
    if (!isAuthenticated) return;
    // Immediately seed tenant from MSAL account so dropdown is never empty
    const account = accounts[0];
    if (account?.tenantId) {
      const displayName =
        account.idTokenClaims?.tid_displayName ||
        account.idTokenClaims?.domain_hint ||
        account.username?.split('@')[1] ||
        account.tenantId;
      addTenantToList({ tenant_id: account.tenantId, tenant_name: displayName, source: 'delegated' });
    }
    // Then load full list from backend (which will enrich the display name)
    loadTenants();
  }, [isAuthenticated]); // eslint-disable-line react-hooks/exhaustive-deps

  // A failed account lookup must not read as "still loading". Spinning forever
  // gives the user nothing to act on and hides the actual cause, which is
  // almost always a consent or sign-in problem they can resolve themselves.
  if (!me && meError) return <AccountLoadFailed error={meError} onRetry={loadMe} />;

  // Wait for the account before deciding what to show, otherwise a returning
  // user sees the onboarding screen flash before their dashboard.
  if (!me) return <PageLoader />;

  // Registering a tenant is how a customer subscribes to the product, so it is
  // mandatory rather than skippable. Who that applies to is decided by the
  // server -- see `needs_onboarding` -- because the rule turns on who owns the
  // workspace, and the copy that used to live here sent invited members to a
  // screen they were never allowed to answer.
  if (me.needs_onboarding) {
    return (
      <Suspense fallback={<PageLoader />}>
        <Onboarding />
      </Suspense>
    );
  }

  // A member of a workspace that has nothing connected yet. Every page would
  // render empty, which reads as a broken product rather than as a wait, so it
  // is named for what it is and points at the one person who can end it.
  if (!me.is_owner && me.tenant_count === 0) {
    return <WorkspaceNotReady ownerEmail={me.owner_email} onRetry={loadMe} />;
  }

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar />
        <main className="flex-1 overflow-y-auto">
          <div key={location.pathname} className="animate-fade-up">
          <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/explorer" element={<CostExplorer />} />
            {/* Cost Trends and Services merged into the explorer. Kept as
                redirects so existing links and bookmarks still land. */}
            <Route path="/trends" element={<Navigate to="/explorer" replace />} />
            <Route path="/services" element={<Navigate to="/explorer" replace />} />
            <Route path="/compare" element={<Compare />} />
            <Route path="/anomalies" element={<Anomalies />} />
            <Route path="/resource-groups" element={<ResourceGroups />} />
            <Route path="/provision" element={<Provision />} />
            <Route path="/orphaned" element={<Orphaned />} />
            <Route path="/compute" element={<Compute />} />
            <Route path="/search" element={<GlobalSearch />} />
            <Route path="/changes" element={<Changes />} />
            <Route path="/activity" element={<ActivityLog />} />
            <Route path="/bandwidth" element={<Bandwidth />} />
            <Route path="/boq" element={<Boq />} />
            <Route path="/commitments" element={<Commitments />} />
            <Route path="/deploy" element={<Deploy />} />
              <Route path="/estate" element={<Estate />} />
              <Route path="/security" element={<SecurityHome />} />
              <Route path="/account" element={<AccountHome />} />
              <Route path="/apis" element={<ApiCatalog />} />
              <Route path="/access-identity" element={<AccessIdentity />} />
              <Route path="/network" element={<NetworkVisualizer />} />
              {/* The two pages these paths used to serve are now tabs. The
                  redirects stay because links to them exist outside this app --
                  in bookmarks, in tickets, in messages -- and those should not
                  break just because the navigation was reorganised. The query
                  string is preserved so `?principal=...` still lands on the
                  right account. */}
              <Route path="/access-optimization" element={<LegacyAccessRedirect view="optimization" />} />
              <Route path="/role-assignments" element={<LegacyAccessRedirect view="assignments" />} />
              <Route path="/access-history" element={<AccessHistory />} />
              <Route path="/advisor" element={<Advisor />} />
              <Route path="/defender" element={<Defender />} />
              <Route path="/policy" element={<PolicyGovernance />} />            <Route path="/settings" element={<Settings />} />
            <Route path="/team" element={<Team />} />
            {/* Rendered only for admins. The backend enforces this too, so
                hiding the route is convenience, not the security boundary. */}
            {me?.is_admin && <Route path="/admin" element={<Admin />} />}
          </Routes>
          </Suspense>
          </div>
        </main>
      </div>
      {/* Outside <main> so it stays put while the page behind it scrolls. */}
      <AssistantWidget />
    </div>
  );
}

/**
 * What an anonymous visitor sees.
 *
 * The root is the landing page, because someone arriving at the bare domain
 * has not decided anything yet and a sign-in form asks them to. Every other
 * path goes straight to sign-in: a person following a link to /explorer or
 * /team already knows what this is, and making them read a pitch first would
 * be an obstacle rather than an introduction.
 */
function PublicSite() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="*" element={<LoginScreen />} />
      </Routes>
    </Suspense>
  );
}

export default function App() {
  const theme = useTheme(s => s.theme);
  const light = theme === 'light';
  return (
    <AuthProvider>
      <BrowserRouter>
        <Toaster
          position="top-right"
          toastOptions={{
            style: light
              ? { background: '#ffffff', color: '#0f172a', border: '1px solid #e2e8f0', boxShadow: '0 12px 28px -14px rgb(15 23 42 / 0.28)' }
              : { background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155' },
          }}
        />
        <RequireAuth signedOut={<PublicSite />}>
          <AppShell />
        </RequireAuth>
      </BrowserRouter>
    </AuthProvider>
  );
}
