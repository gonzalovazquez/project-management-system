import { useCallback, useEffect, useState } from 'react';
import type { AuthState, PublicSettings } from '../../shared/ipc.js';
import { REPO_ROLES, ROLE_LABEL } from '../../shared/ipc.js';
import { RepoBrowser } from './components/RepoBrowser.js';
import { Settings } from './components/Settings.js';
import { Sidebar } from './components/Sidebar.js';
import { SignIn } from './components/SignIn.js';
import { DEFAULT_ROUTE, type Route } from './route.js';

function useDark(): boolean {
  const query = '(prefers-color-scheme: dark)';
  const [dark, setDark] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setDark(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return dark;
}

export function App() {
  const [auth, setAuth] = useState<AuthState>();
  const [settings, setSettings] = useState<PublicSettings>();
  const [route, setRoute] = useState<Route>(DEFAULT_ROUTE);
  useDark();

  const refresh = useCallback(() => {
    void window.pmworkbench.getAuth().then(setAuth);
    void window.pmworkbench.getSettings().then(setSettings);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  if (!auth || !settings) return <div className="loading" data-state="loading">Loading…</div>;

  if (auth.status === 'signed-out') {
    return <SignIn onSignedIn={(a) => { setAuth(a); void window.pmworkbench.getSettings().then(setSettings); }} />;
  }

  // Nothing else is useful until all three repo roles are set, so first run lands on Settings.
  const firstRun = !REPO_ROLES.every((r) => settings.repoRoles[r]);
  const current: Route = firstRun ? { view: 'settings' } : route;

  const meta = current.view === 'settings'
    ? { title: firstRun ? 'Connect your repos' : 'Settings', subtitle: firstRun ? 'One-time setup' : 'Repo roles and appearance' }
    : { title: ROLE_LABEL[current.role], subtitle: settings.repoRoles[current.role]?.fullName ?? 'Not set' };

  return (
    <div className="app">
      <Sidebar settings={settings} auth={auth} route={current} onNavigate={setRoute} />
      <div className="main">
        <div className="toolbar">
          <div className="ttl"><b>{meta.title}</b><span>{meta.subtitle}</span></div>
          <div className="sp" />
        </div>
        <div className="content" data-route={current.view}>
          {current.view === 'settings' && (
            <Settings
              settings={settings}
              first={firstRun}
              onSettings={setSettings}
              onSignedOut={() => { setAuth({ status: 'signed-out' }); setRoute(DEFAULT_ROUTE); }}
              onFinish={() => setRoute({ view: 'browse', role: 'artifacts' })}
            />
          )}
          {current.view === 'browse' && <RepoBrowser role={current.role} settings={settings} />}
        </div>
      </div>
    </div>
  );
}
