import { useCallback, useEffect, useState } from 'react';
import type { AuthState, PublicSettings } from '../../shared/ipc.js';
import type { ProductSummary } from '../../shared/products.js';
import { REPO_ROLES, ROLE_LABEL } from '../../shared/ipc.js';
import { ProductForm } from './components/ProductForm.js';
import { ProductHome } from './components/ProductHome.js';
import { ProductsPage } from './components/ProductsPage.js';
import { PullsPage } from './components/PullsPage.js';
import { RepoBrowser } from './components/RepoBrowser.js';
import { Settings } from './components/Settings.js';
import { Sidebar } from './components/Sidebar.js';
import { SignIn } from './components/SignIn.js';
import { Onboarding } from './components/Onboarding.js';
import { DEFAULT_ROUTE, type Route } from './route.js';

export function App() {
  const [auth, setAuth] = useState<AuthState>();
  const [settings, setSettings] = useState<PublicSettings>();
  const [route, setRoute] = useState<Route>(DEFAULT_ROUTE);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [creating, setCreating] = useState(false);

  const refreshProducts = useCallback(() => {
    void window.pmworkbench.listProducts().then((r) => { if (r.ok) setProducts(r.value); });
  }, []);

  const refresh = useCallback(() => {
    void window.pmworkbench.getAuth().then(setAuth);
    void window.pmworkbench.getSettings().then(setSettings);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // The main process signs out on its own if GitHub stops accepting the token; notice promptly.
  useEffect(() => {
    const check = () => void window.pmworkbench.getAuth().then((a) => setAuth((cur) => (cur && cur.status === a.status ? cur : a)));
    const t = setInterval(check, 15_000);
    window.addEventListener('focus', check);
    return () => { clearInterval(t); window.removeEventListener('focus', check); };
  }, []);
  useEffect(() => { if (auth?.status === 'signed-in') refreshProducts(); }, [auth?.status, refreshProducts]);

  if (!auth || !settings) return <div className="loading" data-state="loading">Loading…</div>;

  if (auth.status === 'signed-out') {
    return <SignIn reason={auth.reason} host={auth.host || settings.host} onSignedIn={(a) => { setAuth(a); void window.pmworkbench.getSettings().then(setSettings); }} />;
  }

  // First run: guided setup. Someone already set up (roles chosen and a product made) skips it.
  const setUp = REPO_ROLES.every((r) => settings.repoRoles[r]) && products.length > 0;
  if (!settings.onboarded && !setUp) {
    return (
      <Onboarding
        settings={settings}
        onSettings={setSettings}
        onFinish={(id) => { refreshProducts(); setRoute(id ? { view: 'product', id } : DEFAULT_ROUTE); }}
      />
    );
  }

  // Nothing else is useful until all three repo roles are set, so first run lands on Settings.
  const firstRun = !REPO_ROLES.every((r) => settings.repoRoles[r]);
  const current: Route = firstRun ? { view: 'settings' } : route;

  const productName = current.view === 'product' ? products.find((p) => p.id === current.id)?.name ?? 'Product' : '';
  const meta =
    current.view === 'settings' ? { title: firstRun ? 'Connect your repos' : 'Settings', subtitle: firstRun ? 'One-time setup' : 'Repo roles and appearance' }
    : current.view === 'products' ? { title: 'Products', subtitle: 'Stored on this Mac only' }
    : current.view === 'pulls' ? { title: 'Pull requests', subtitle: 'Opened from PM Workbench, across your three repos' }
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
          {current.view === 'pulls' && <PullsPage host={auth.host} onOpenProduct={(id) => setRoute({ view: 'product', id })} />}
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
              auth={auth}
              tab={current.tab ?? 'home'}
              onTab={(tab) => setRoute({ view: 'product', id: current.id, tab })}
              settings={settings}
              onChanged={refreshProducts}
              onDeleted={() => { refreshProducts(); setRoute(DEFAULT_ROUTE); }}
            />
          )}
          {current.view === 'browse' && <RepoBrowser key={current.role} role={current.role} settings={settings} />}
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
