import { useCallback, useEffect, useState } from 'react';
import type { AuthState, PublicSettings } from '../../shared/ipc.js';
import type { ProductSummary } from '../../shared/products.js';
import { REPO_ROLES, ROLE_LABEL } from '../../shared/ipc.js';
import { ProductForm } from './components/ProductForm.js';
import { ProductHome } from './components/ProductHome.js';
import { ProductsPage } from './components/ProductsPage.js';
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
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [creating, setCreating] = useState(false);
  useDark();

  const refreshProducts = useCallback(() => {
    void window.pmworkbench.listProducts().then((r) => { if (r.ok) setProducts(r.value); });
  }, []);

  const refresh = useCallback(() => {
    void window.pmworkbench.getAuth().then(setAuth);
    void window.pmworkbench.getSettings().then(setSettings);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { if (auth?.status === 'signed-in') refreshProducts(); }, [auth?.status, refreshProducts]);

  if (!auth || !settings) return <div className="loading" data-state="loading">Loading…</div>;

  if (auth.status === 'signed-out') {
    return <SignIn onSignedIn={(a) => { setAuth(a); void window.pmworkbench.getSettings().then(setSettings); }} />;
  }

  // Nothing else is useful until all three repo roles are set, so first run lands on Settings.
  const firstRun = !REPO_ROLES.every((r) => settings.repoRoles[r]);
  const current: Route = firstRun ? { view: 'settings' } : route;

  const productName = current.view === 'product' ? products.find((p) => p.id === current.id)?.name ?? 'Product' : '';
  const meta =
    current.view === 'settings' ? { title: firstRun ? 'Connect your repos' : 'Settings', subtitle: firstRun ? 'One-time setup' : 'Repo roles and appearance' }
    : current.view === 'products' ? { title: 'Products', subtitle: 'Stored on this Mac only' }
    : current.view === 'product' ? { title: productName, subtitle: current.tab === 'board' ? 'Workflow board' : current.tab === 'metrics' ? 'Flow metrics' : 'Product home' }
    : { title: ROLE_LABEL[current.role], subtitle: settings.repoRoles[current.role]?.fullName ?? 'Not set' };

  return (
    <div className="app">
      <Sidebar settings={settings} auth={auth} route={current} products={products} onNavigate={setRoute} />
      <div className="main">
        <div className="toolbar">
          <div className="ttl"><b>{meta.title}</b><span>{meta.subtitle}</span></div>
          <div className="sp" />
        </div>
        <div className="content" data-route={current.view}>
          {current.view === 'settings' && (
            <Settings
              auth={auth}
              onAuth={setAuth}
              settings={settings}
              first={firstRun}
              onSettings={setSettings}
              onSignedOut={() => { setAuth({ status: 'signed-out' }); setRoute(DEFAULT_ROUTE); }}
              onFinish={() => setRoute(DEFAULT_ROUTE)}
            />
          )}
          {current.view === 'products' && (
            <ProductsPage
              products={products}
              onNew={() => setCreating(true)}
              onOpen={(id) => setRoute({ view: 'product', id })}
              onImported={(id) => { refreshProducts(); setRoute({ view: 'product', id }); }}
            />
          )}
          {current.view === 'product' && (
            <ProductHome
              key={current.id}
              id={current.id}
              tab={current.tab ?? 'home'}
              onTab={(tab) => setRoute({ view: 'product', id: current.id, tab })}
              settings={settings}
              onChanged={refreshProducts}
              onDeleted={() => { refreshProducts(); setRoute(DEFAULT_ROUTE); }}
            />
          )}
          {current.view === 'browse' && <RepoBrowser role={current.role} settings={settings} />}
        </div>
      </div>
      {creating && (
        <ProductForm
          onClose={() => setCreating(false)}
          onSaved={(p) => { setCreating(false); refreshProducts(); setRoute({ view: 'product', id: p.id }); }}
        />
      )}
    </div>
  );
}
