import { REPO_ROLES, ROLE_LABEL, type AuthState, type PublicSettings } from '../../../shared/ipc.js';
import { sameRoute, type Route } from '../route.js';
import { Icon, type IconName } from './Icon.js';

interface Props {
  settings: PublicSettings;
  auth: AuthState;
  route: Route;
  onNavigate: (r: Route) => void;
}

export function Sidebar({ settings, auth, route, onNavigate }: Props) {
  const Item = ({ to, icon, label }: { to: Route; icon: IconName; label: string }) => (
    <button className="item" aria-current={sameRoute(route, to) ? 'page' : undefined} onClick={() => onNavigate(to)}>
      <Icon name={icon} />
      <span className="t">{label}</span>
    </button>
  );

  return (
    <aside className="side" aria-label="Sidebar">
      <div className="side-drag" />
      <nav className="sec" aria-label="Repos">
        <h6>Repos</h6>
        {REPO_ROLES.map((role) => (
          <Item key={role} to={{ view: 'browse', role }} icon="folder" label={ROLE_LABEL[role]} />
        ))}
      </nav>
      <nav className="sec" aria-label="App">
        <h6>App</h6>
        <Item to={{ view: 'settings' }} icon="gear" label="Settings" />
      </nav>
      <div className="sidefoot">
        {auth.status === 'signed-in' && (
          <>
            <span><span className="dot" style={{ background: 'var(--green)' }} />{auth.login}</span>
            <span className="path">{auth.host}</span>
          </>
        )}
        {!settings.secureStorageAvailable && <span style={{ color: 'var(--orange)' }}>Keychain unavailable</span>}
      </div>
    </aside>
  );
}
