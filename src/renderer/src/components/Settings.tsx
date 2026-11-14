import { useEffect, useState } from 'react';
import { APPEARANCES, ROLE_LABEL, REPO_ROLES, type Appearance, type PublicSettings, type RepoRef, type RepoRole } from '../../../shared/ipc.js';

const APPEARANCE_LABEL: Record<Appearance, string> = { system: 'Match system', light: 'Light', dark: 'Dark' };

interface Props {
  settings: PublicSettings;
  first: boolean;
  onSettings: (s: PublicSettings) => void;
  onSignedOut: () => void;
  onFinish: () => void;
}

/**
 * Assigns the three repo roles (artifacts+skills, CRM, PDR) a real GitHub repo each, and holds
 * the appearance preference and sign-out. On first run this is what a PM sees right after signing
 * in, since nothing else in the app works until the roles are set.
 */
export function Settings({ settings, first, onSettings, onSignedOut, onFinish }: Props) {
  const [repos, setRepos] = useState<RepoRef[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<RepoRole>();

  useEffect(() => {
    void window.pmworkbench.listAvailableRepos().then((r) => {
      if (r.ok) setRepos(r.value); else setError(r.message);
    });
  }, []);

  const assign = async (role: RepoRole, fullName: string) => {
    const repo = repos?.find((r) => r.fullName === fullName);
    setBusy(role);
    const result = await window.pmworkbench.saveSettings({ repoRoles: { [role]: repo ?? null } });
    setBusy(undefined);
    if (!result.ok) { setError(result.message); return; }
    onSettings(result.value);
  };

  const setAppearance = async (appearance: Appearance) => {
    const result = await window.pmworkbench.saveSettings({ appearance });
    if (result.ok) onSettings(result.value);
  };

  const ready = REPO_ROLES.every((r) => settings.repoRoles[r]);

  return (
    <div className="card">
      <div className="hd">
        <h3>{first ? 'Connect your three repos' : 'Repo roles'}</h3>
        {!first && <button className="btn danger" onClick={() => void window.pmworkbench.signOut().then(onSignedOut)}>Sign out</button>}
      </div>
      <p className="mut">
        Point each role at the repo it already lives in. Nothing is moved or copied — the app just
        remembers which repo is which, so you can browse all three around one product instead of
        juggling tabs.
      </p>
      {error && <p className="err small" style={{ color: 'var(--red)' }}>{error}</p>}
      <div className="roles">
        {REPO_ROLES.map((role) => (
          <div className="role-row" key={role}>
            <div className="label">
              <b>{ROLE_LABEL[role]}</b>
              <span>{settings.repoRoles[role]?.fullName ?? 'Not set'}</span>
            </div>
            <select
              value={settings.repoRoles[role]?.fullName ?? ''}
              disabled={!repos || busy === role}
              onChange={(e) => void assign(role, e.target.value)}
            >
              <option value="">{repos ? 'Choose a repo…' : 'Loading your repos…'}</option>
              {repos?.map((r) => <option key={r.fullName} value={r.fullName}>{r.fullName}</option>)}
            </select>
          </div>
        ))}
      </div>
      <div className="setrow">
        <span className="mut small">Appearance</span>
        <select value={settings.appearance} onChange={(e) => void setAppearance(e.target.value as Appearance)}>
          {APPEARANCES.map((a) => <option key={a} value={a}>{APPEARANCE_LABEL[a]}</option>)}
        </select>
      </div>
      {!settings.secureStorageAvailable && (
        <p className="banner warn small">
          Your system keychain isn't available, so the token can't be saved — set the{' '}
          <code className="mono">GITHUB_TOKEN</code> environment variable instead if you want to skip signing in every launch.
        </p>
      )}
      {first && (
        <div className="sheet-foot">
          <button className="btn primary" disabled={!ready} onClick={onFinish}>Done</button>
        </div>
      )}
    </div>
  );
}
