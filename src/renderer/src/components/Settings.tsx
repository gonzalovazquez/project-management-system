import { useEffect, useState } from 'react';
import { DEFAULT_METRIC_SETTINGS, type MetricSettings } from '../../../shared/metrics.js';
import { ARTIFACT_TYPE_LABEL, ARTIFACT_TYPES, STAGE_LABEL, STAGES, type ArtifactType } from '../../../shared/products.js';
import { APPEARANCES, ROLE_LABEL, REPO_ROLES, type Appearance, type AuthState, type PublicSettings, type RepoRef, type RepoRole } from '../../../shared/ipc.js';

const APPEARANCE_LABEL: Record<Appearance, string> = { system: 'Match system', light: 'Light', dark: 'Dark' };

type SignedIn = Extract<AuthState, { status: 'signed-in' }>;

interface Props {
  auth: SignedIn;
  onAuth: (a: SignedIn) => void;
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
export function Settings({ auth, onAuth, settings, first, onSettings, onSignedOut, onFinish }: Props) {
  const [repos, setRepos] = useState<RepoRef[]>();
  const [missingPrivateScope, setMissingPrivateScope] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<RepoRole>();

  const [newToken, setNewToken] = useState('');
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenMsg, setTokenMsg] = useState<{ ok: boolean; text: string }>();

  const loadRepos = () => {
    setRepos(undefined);
    setError(undefined);
    void window.pmworkbench.listAvailableRepos().then((r) => {
      if (r.ok) { setRepos(r.value.repos); setMissingPrivateScope(r.value.missingPrivateScope); } else setError(r.message);
    });
  };

  useEffect(loadRepos, []);

  // Swaps the token in place: same host, repo roles untouched. A token that fails validation
  // leaves the current one in use.
  const changeToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newToken.trim() || tokenBusy) return;
    setTokenBusy(true);
    setTokenMsg(undefined);
    const result = await window.pmworkbench.signIn(auth.host, newToken.trim());
    setTokenBusy(false);
    if (!result.ok || result.value.status !== 'signed-in') {
      setTokenMsg({ ok: false, text: result.ok ? 'Sign-in failed.' : result.message });
      return;
    }
    setNewToken('');
    setTokenMsg({ ok: true, text: `Token updated — signed in as ${result.value.login}.` });
    onAuth(result.value);
    loadRepos();
  };

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

  const [metrics, setMetrics] = useState<MetricSettings>(settings.metrics);
  const [metricsMsg, setMetricsMsg] = useState<{ ok: boolean; text: string }>();
  const metricsDirty = JSON.stringify(metrics) !== JSON.stringify(settings.metrics);
  const saveMetrics = async (next: MetricSettings) => {
    const r = await window.pmworkbench.saveSettings({ metrics: next });
    if (!r.ok) { setMetricsMsg({ ok: false, text: r.message }); return; }
    onSettings(r.value);
    setMetrics(r.value.metrics);
    setMetricsMsg({ ok: true, text: 'Review points saved.' });
  };
  const days = (v: string) => Math.round(Number(v));

  const [templates, setTemplates] = useState<Partial<Record<ArtifactType, string>>>(settings.templates);
  const [tplMsg, setTplMsg] = useState<{ ok: boolean; text: string }>();
  const templatesDirty = JSON.stringify(templates) !== JSON.stringify(settings.templates);
  const saveTemplates = async () => {
    setTplMsg(undefined);
    // Check each path really is a file in the artifacts repo before saving it.
    for (const [t, p] of Object.entries(templates)) {
      if (!p || p === settings.templates[t as ArtifactType]) continue;
      const r = await window.pmworkbench.readFile('artifacts', p.trim());
      if (!r.ok) { setTplMsg({ ok: false, text: `${ARTIFACT_TYPE_LABEL[t as ArtifactType]}: ${p} — ${r.message}` }); return; }
    }
    const patch = Object.fromEntries(ARTIFACT_TYPES.map((t) => [t, templates[t]?.trim() || null]));
    const r = await window.pmworkbench.saveSettings({ templates: patch });
    if (!r.ok) { setTplMsg({ ok: false, text: r.message }); return; }
    onSettings(r.value);
    setTemplates(r.value.templates);
    setTplMsg({ ok: true, text: 'Templates saved.' });
  };

  const ready = REPO_ROLES.every((r) => settings.repoRoles[r]);

  return (
    <div className="card">
      <div className="hd">
        <h3>{first ? 'Connect your three repos' : 'Repo roles'}</h3>
        <button className="btn danger" onClick={() => void window.pmworkbench.signOut().then(onSignedOut)}>Sign out</button>
      </div>
      <p className="mut">
        Point each role at the repo it already lives in. Nothing is moved or copied — the app just
        remembers which repo is which, so you can browse all three around one product instead of
        juggling tabs.
      </p>
      {error && <p className="err small" style={{ color: 'var(--red)' }}>{error}</p>}
      {missingPrivateScope ? (
        <p className="banner warn small">
          Your token is missing the <code className="mono">repo</code> scope, so GitHub hides your private
          repos from it. Create a classic token with <code className="mono">repo</code> checked (or a
          fine-grained one with access to these repos), then sign out and sign in again with it.
        </p>
      ) : (
        <p className="mut small">
          Don't see a private repo? Your token can't reach it: a classic token needs the{' '}
          <code className="mono">repo</code> scope; a fine-grained token needs that repo selected (and,
          for an organization's repo, the organization's approval). SSO-protected orgs also need the
          token authorized for SSO.
        </p>
      )}
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
      <form className="token-change" onSubmit={changeToken}>
        <span className="mut small">
          GitHub token — signed in as <b>{auth.login}</b> on {auth.host}
          {auth.tokenSource === 'env' ? ' (from GITHUB_TOKEN)' : ''}
        </span>
        <div className="setrow">
          <input
            className="field grow"
            type="password"
            value={newToken}
            onChange={(e) => setNewToken(e.target.value)}
            placeholder="Paste a new personal access token"
            autoComplete="off"
            aria-label="New personal access token"
          />
          <button className="btn" type="submit" disabled={tokenBusy || !newToken.trim()}>
            {tokenBusy ? 'Checking…' : 'Change token'}
          </button>
        </div>
        {tokenMsg && <p className="small" style={{ margin: 0, color: tokenMsg.ok ? 'var(--green)' : 'var(--red)' }}>{tokenMsg.text}</p>}
        {auth.tokenSource === 'env' && (
          <p className="mut small" style={{ margin: 0 }}>
            The <code className="mono">GITHUB_TOKEN</code> environment variable wins at launch, so a token changed here
            lasts only until you quit unless you unset or update that variable.
          </p>
        )}
      </form>
      {!first && (
        <form className="review-points" onSubmit={(e) => { e.preventDefault(); void saveTemplates(); }}>
          <span className="mut small">
            Artifact templates: the file in {settings.repoRoles.artifacts?.fullName ?? 'the artifacts repo'} that a new artifact of each type starts from.
            Leave one empty to start blank. <code className="mono">{'{{title}}'}</code>, <code className="mono">{'{{product}}'}</code> and <code className="mono">{'{{date}}'}</code> are filled in.
          </span>
          <div className="tpl-grid">
            {ARTIFACT_TYPES.map((t) => (
              <label key={t} className="fld">
                {ARTIFACT_TYPE_LABEL[t]}
                <input className="mono" value={templates[t] ?? ''} placeholder="templates/…md" onChange={(e) => setTemplates({ ...templates, [t]: e.target.value })} />
              </label>
            ))}
          </div>
          <div className="setrow">
            <button className="btn" type="submit" disabled={!templatesDirty}>Save templates</button>
            {tplMsg && <span className="small" style={{ color: tplMsg.ok ? 'var(--green)' : 'var(--red)' }}>{tplMsg.text}</span>}
          </div>
        </form>
      )}
      {!first && (
        <form className="review-points" onSubmit={(e) => { e.preventDefault(); void saveMetrics(metrics); }}>
          <span className="mut small">
            Flow metrics: days an item can sit in each stage before it's flagged for review, and days without any GitHub activity before it counts as quiet.
          </span>
          <div className="rp-grid">
            {STAGES.map((s) => (
              <label key={s} className="fld">
                {STAGE_LABEL[s]}
                <input type="number" min={1} max={365} step={1} value={metrics.stageThresholds[s]}
                  onChange={(e) => setMetrics({ ...metrics, stageThresholds: { ...metrics.stageThresholds, [s]: days(e.target.value) } })} />
              </label>
            ))}
            <label className="fld">
              Quiet after
              <input type="number" min={1} max={365} step={1} value={metrics.quietDays} onChange={(e) => setMetrics({ ...metrics, quietDays: days(e.target.value) })} />
            </label>
          </div>
          <div className="setrow">
            <button className="btn" type="submit" disabled={!metricsDirty}>Save review points</button>
            <button className="btn" type="button" onClick={() => void saveMetrics(structuredClone(DEFAULT_METRIC_SETTINGS))}>Reset to defaults</button>
            {metricsMsg && <span className="small" style={{ color: metricsMsg.ok ? 'var(--green)' : 'var(--red)' }}>{metricsMsg.text}</span>}
          </div>
        </form>
      )}
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
