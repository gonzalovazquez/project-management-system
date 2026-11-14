import { REPO_ROLES, ROLE_LABEL, type AuthState, type PublicSettings } from '../../../shared/ipc.js';
import type { ProductSummary } from '../../../shared/products.js';
import { sameRoute, type Route } from '../route.js';
import { Icon, type IconName } from './Icon.js';

interface Props {
  settings: PublicSettings;
  auth: AuthState;
  route: Route;
  products: ProductSummary[];
  onNavigate: (r: Route) => void;
}

export function Sidebar({ settings, auth, route, products, onNavigate }: Props) {
  const Item = ({ to, icon, label, count, warn }: { to: Route; icon: IconName; label: string; count?: number; warn?: boolean }) => (
    <button className="item" aria-current={sameRoute(route, to) ? 'page' : undefined} onClick={() => onNavigate(to)}>
      <Icon name={icon} />
      <span className="t">{label}</span>
      {count !== undefined && <span className="c" style={warn ? { color: 'var(--red)' } : undefined}>{count}</span>}
    </button>
  );

  return (
    <aside className="side" aria-label="Sidebar">
      <div className="side-drag" />
      <nav className="sec" aria-label="Products">
        <h6>Products</h6>
        <Item to={{ view: 'products' }} icon="tray" label="All products" count={products.length} />
        {products.map((p) => (
          <Item key={p.id} to={{ view: 'product', id: p.id }} icon="flag" label={p.name} count={p.brokenCount || undefined} warn />
        ))}
      </nav>
      <nav className="sec" aria-label="Repos">
        <h6>Repos</h6>
        {REPO_ROLES.map((role) => (
          <Item key={role} to={{ view: 'browse', role }} icon="folder" label={ROLE_LABEL[role]} />
        ))}
      </nav>
      <nav className="sec" aria-label="App">
        <h6>App</h6>
        <Item to={{ view: 'pulls' }} icon="refresh" label="Pull requests" />
        <Item to={{ view: 'settings' }} icon="gear" label="Settings" />
      </nav>
      <div className="sidefoot">
        {auth.status === 'signed-in' && (
          <>
            <span title={auth.offline ? "GitHub couldn't be reached at launch; showing cached data" : undefined}>
              <span className="dot" style={{ background: auth.offline ? 'var(--orange)' : 'var(--green)' }} />{auth.login}{auth.offline ? ' · offline' : ''}
            </span>
            <span className="path">{auth.host}</span>
          </>
        )}
        {!settings.secureStorageAvailable && <span style={{ color: 'var(--orange)' }}>Keychain unavailable</span>}
      </div>
    </aside>
  );
}
