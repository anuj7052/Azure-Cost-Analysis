import { useEffect, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, RequireAuth } from './auth/AuthProvider';
import Sidebar from './components/Layout/Sidebar';
import Topbar from './components/Layout/Topbar';
import { useAppStore } from './store/useAppStore';
import { useTheme } from './store/useTheme';
import { useIsAuthenticated, useMsal } from '@azure/msal-react';

// Lazy load pages — only loaded when user navigates to them
const Dashboard      = lazy(() => import('./pages/Dashboard'));
const CostTrends     = lazy(() => import('./pages/CostTrends'));
const ServiceAnalysis = lazy(() => import('./pages/ServiceAnalysis'));
const Anomalies      = lazy(() => import('./pages/Anomalies'));
const Settings       = lazy(() => import('./pages/Settings'));
const ResourceGroups = lazy(() => import('./pages/ResourceGroups'));
const Bandwidth      = lazy(() => import('./pages/Bandwidth'));
const Boq            = lazy(() => import('./pages/Boq'));

const PageLoader = () => (
  <div className="flex h-[60vh] items-center justify-center">
    <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    <div
      className="w-8 h-8 rounded-full border-[3px] border-blue-500"
      style={{ borderTopColor: 'transparent', animation: 'spin 0.7s linear infinite' }}
    />
  </div>
);

function AppShell() {
  const isAuthenticated = useIsAuthenticated();
  const { accounts } = useMsal();
  const loadTenants     = useAppStore(s => s.loadTenants);
  const addTenantToList = useAppStore(s => s.addTenantToList);

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

  return (
    <div className="flex min-h-screen bg-slate-950">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar />
        <main className="flex-1 overflow-y-auto">
          <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/trends" element={<CostTrends />} />
            <Route path="/services" element={<ServiceAnalysis />} />
            <Route path="/anomalies" element={<Anomalies />} />
            <Route path="/resource-groups" element={<ResourceGroups />} />
            <Route path="/bandwidth" element={<Bandwidth />} />
            <Route path="/boq" element={<Boq />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
          </Suspense>
        </main>
      </div>
    </div>
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
        <RequireAuth>
          <AppShell />
        </RequireAuth>
      </BrowserRouter>
    </AuthProvider>
  );
}
