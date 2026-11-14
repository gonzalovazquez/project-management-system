import { useState } from 'react';
import type { AuthState } from '../../../shared/ipc.js';

interface Props {
  onSignedIn: (auth: AuthState) => void;
  /** Why the app signed out on its own, if it did (an expired or revoked token). */
  reason?: string;
  host?: string;
}

/** The only screen a signed-out PM sees. A host and a personal access token are all sign-in needs. */
export function SignIn({ onSignedIn, reason, host: lastHost }: Props) {
  const [host, setHost] = useState(lastHost || 'github.com');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!host.trim() || !token.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    const result = await window.pmworkbench.signIn(host.trim(), token.trim());
    setBusy(false);
    if (!result.ok) { setError(result.message); return; }
    onSignedIn(result.value);
  };

  return (
    <div className="gate">
      <form className="card gate-card" onSubmit={submit}>
        {!reason && <span className="mut small">Step 1 of 4</span>}
        <h1>{reason ? 'Sign in again' : 'Sign in to GitHub'}</h1>
        {reason && <p className="banner warn small">{reason}</p>}
        <p className="mut">
          PM Workbench works with your artifacts, CRM and PDR repos through a GitHub personal access
          token. The token is encrypted with your Mac's keychain, is only used by the app's main
          process, and is only ever sent to the GitHub host below.
        </p>
        <details className="scopes">
          <summary>What the token needs, and why</summary>
          <ul className="small">
            <li><b>Fine-grained token</b> (recommended): Repository access → only the three repos. Permissions → <b>Contents: read and write</b> (to read files and to commit to the branches the app opens), <b>Pull requests: read and write</b> (to open them and show their review state), <b>Metadata: read</b> (required by GitHub).</li>
            <li><b>Classic token</b>: the <code className="mono">repo</code> scope. Without it, private repos are invisible.</li>
            <li>If your organization uses SSO, authorize the token for it on GitHub after creating it.</li>
            <li>The app never commits to a default branch: every change is a new branch and a pull request you review on GitHub.</li>
          </ul>
        </details>
        <label className="fld">
          GitHub host
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="github.com" data-autofocus />
          <span className="small mut">Use your GitHub Enterprise Server hostname instead of github.com if that's where your repos live.</span>
        </label>
        <label className="fld">
          Personal access token
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ghp_…" autoComplete="off" />
        </label>
        {error && <p className="err small">{error}</p>}
        <div className="sheet-foot">
          <button className="btn primary" type="submit" disabled={busy || !host.trim() || !token.trim()}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>
    </div>
  );
}
