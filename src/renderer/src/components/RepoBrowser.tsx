import { useEffect, useState } from 'react';
import type { FileContent, PublicSettings, RepoRole, TreeEntry } from '../../../shared/ipc.js';
import { ROLE_LABEL } from '../../../shared/ipc.js';
import { Icon } from './Icon.js';

interface Props {
  role: RepoRole;
  settings: PublicSettings;
}

/**
 * Browses one of the three connected repos by role, so a PM can see the artifacts, CRM notes or
 * PDR for the product they're on without leaving the app. Read-only in Phase 1 — write-back
 * through a pull request is a later phase.
 */
export function RepoBrowser({ role, settings }: Props) {
  const repo = settings.repoRoles[role];
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<TreeEntry[]>();
  const [file, setFile] = useState<FileContent>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setPath('');
    setFile(undefined);
  }, [role]);

  useEffect(() => {
    if (!repo) return;
    let alive = true;
    setLoading(true);
    setError(undefined);
    void window.pmworkbench.browseTree(role, path).then((r) => {
      if (!alive) return;
      setLoading(false);
      if (r.ok) setEntries(r.value); else setError(r.message);
    });
    return () => { alive = false; };
  }, [role, path, repo]);

  const open = async (entry: TreeEntry) => {
    if (entry.type === 'dir') { setPath(entry.path); setFile(undefined); return; }
    setLoading(true);
    setError(undefined);
    const r = await window.pmworkbench.readFile(role, entry.path);
    setLoading(false);
    if (r.ok) setFile(r.value); else setError(r.message);
  };

  if (!repo) {
    return (
      <div className="empty card">
        <b>No repo assigned to {ROLE_LABEL[role]} yet</b>
        <span>Set it up in Settings before browsing.</span>
      </div>
    );
  }

  const crumbs = path ? path.split('/') : [];

  return (
    <div className="browser">
      <div className="card tree">
        <div className="crumbs">
          <button onClick={() => setPath('')}>{repo.name}</button>
          {crumbs.map((c, i) => (
            <span key={i}>
              {' / '}
              <button onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}>{c}</button>
            </span>
          ))}
        </div>
        {loading && !entries && <p className="mut small">Loading…</p>}
        {error && <p className="small" style={{ color: 'var(--red)' }}>{error}</p>}
        <ul>
          {entries?.map((entry) => (
            <li key={entry.path}>
              <button aria-current={file?.path === entry.path} onClick={() => void open(entry)}>
                <Icon name={entry.type === 'dir' ? 'folder' : 'grid'} className="ic" />
                <span>{entry.name}</span>
              </button>
            </li>
          ))}
          {entries && entries.length === 0 && <li className="mut small" style={{ padding: '4px 6px' }}>Empty folder.</li>}
        </ul>
      </div>
      <div className="card viewer">
        {!file && <p className="mut">Pick a file on the left to preview it.</p>}
        {file && (
          <>
            <div className="hd">
              <h3 className="mono small">{file.path}</h3>
              {/* No external-link affordance yet: the window's open handler denies new windows, and
                  opening the system browser from here is Phase 1 scope the kickoff prompt didn't ask for. */}
              <span className="mut small">{file.htmlUrl}</span>
            </div>
            {file.truncated && <p className="banner warn small">This file is large; showing what GitHub returned, which may be truncated.</p>}
            <pre className="mono small">{file.content}</pre>
          </>
        )}
      </div>
    </div>
  );
}
