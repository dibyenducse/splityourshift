import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { authLanding, configured, landingTokens, supabase } from './lib/supabase';
import { whoAmI, type Me } from './lib/api';
import { Loading, ToastProvider } from './components/ui';
import Home from './pages/Home';
import { Login, SetPassword, Signup } from './pages/Auth';
import AppShell from './pages/AppShell';

interface AuthState { me: Me | null | undefined; refresh: () => Promise<void>; signOut: () => Promise<void> }
const AuthCtx = createContext<AuthState>({ me: undefined, refresh: async () => {}, signOut: async () => {} });
export const useAuth = () => useContext(AuthCtx);

function Tracker() {
  const loc = useLocation();
  useEffect(() => {
    if (loc.pathname === '/set-password') return;
    supabase.rpc('track_view', { p_path: loc.pathname, p_ref: document.referrer || null }).then(() => {}, () => {});
  }, [loc.pathname]);
  return null;
}

function Routed() {
  const { me } = useAuth();
  return (
    <>
      <Tracker />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={me ? <Navigate to="/app" replace /> : <Login />} />
        <Route path="/signup" element={me ? <Navigate to="/app" replace /> : <Signup />} />
        <Route path="/set-password" element={<SetPassword />} />
        <Route path="/app/*" element={me === undefined ? <Loading /> : me ? <AppShell /> : <Navigate to="/login" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}

function SetupNeeded() {
  return (
    <div className="wrap"><div className="card setup">
      <h2>Almost there: connect the database</h2>
      <p className="hint" style={{ margin: 0 }}>This site is built but not connected to Supabase yet. Add two repository variables on GitHub and run the deploy again:</p>
      <ul className="plain" style={{ fontFamily: 'var(--f-body)', fontSize: 14 }}>
        <li><code>VITE_SUPABASE_URL</code>: your Supabase Project URL</li>
        <li><code>VITE_SUPABASE_ANON_KEY</code>: your Supabase anon public key</li>
      </ul>
      <p className="hint" style={{ margin: 0 }}>GitHub → Settings → Secrets and variables → Actions → Variables. Full steps are in SETUP.md in the repository.</p>
    </div></div>
  );
}

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const refresh = useCallback(async () => { setMe(await whoAmI().catch(() => null)); }, []);
  const signOut = useCallback(async () => { await supabase.auth.signOut(); setMe(null); }, []);
  useEffect(() => {
    if (!configured) return;
    // A sign-up confirmation link brings a session in the URL; store it, then load the user.
    (async () => { if (authLanding === 'session' && landingTokens) await supabase.auth.setSession(landingTokens); await refresh(); })();
    // Don't call Supabase inside the callback itself (it can deadlock); defer it.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((evt) => {
      if (evt === 'SIGNED_IN' || evt === 'SIGNED_OUT' || evt === 'USER_UPDATED') setTimeout(refresh, 0);
    });
    return () => subscription.unsubscribe();
  }, [refresh]);
  if (!configured) return <SetupNeeded />;
  return (
    <AuthCtx.Provider value={{ me, refresh, signOut }}>
      <ToastProvider>
        <HashRouter><Routed /></HashRouter>
      </ToastProvider>
    </AuthCtx.Provider>
  );
}
