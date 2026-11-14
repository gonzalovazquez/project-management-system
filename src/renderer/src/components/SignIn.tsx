import { useState } from 'react';
import type { AuthState } from '../../../shared/ipc.js';

interface Props {
  onSignedIn: (auth: AuthState) => void;
}

/** The only screen a signed-out PM sees. A host and a personal access token are all sign-in needs. */
export function SignIn({ onSignedIn }: Props) {
  const [host, setHost] = useState('github.com');
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
        <h1>Sign in to GitHub</h1>
        <p className="mut">
          Paste a personal access token with read access to your artifacts, CRM and PDR repos
          (and write access, once you're ready to open pull requests from here). It's encrypted
          with your Mac's keychain and never leaves this device except to call the GitHub API you
          name below.
        </p>
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
