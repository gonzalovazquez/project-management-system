import { useEffect, useState } from 'react';
import { ROLE_LABEL } from '../../../shared/ipc.js';
import { PULL_STATUS_LABEL } from '../../../shared/products.js';
import type { AppPullStatus } from '../../../shared/writes.js';
import { ago } from '../viewmodel/board.js';

const OPEN = new Set(['open', 'draft', 'changes-requested', 'approved']);

/** Pull requests opened from PM Workbench across the three repos, so a PM can see what's waiting on review. */
export function PullsPage({ host, onOpenProduct }: { host: string; onOpenProduct: (id: string) => void }) {
  const [pulls, setPulls] = useState<AppPullStatus[]>();
  const [error, setError] = useState<string>();
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    const r = await window.pmworkbench.listAppPulls();
    setBusy(false);
    if (r.ok) { setPulls(r.value); setError(undefined); } else setError(r.message);
  };
  useEffect(() => { void load(); }, []);

  const shown = (pulls ?? []).filter((p) => all || !p.status || OPEN.has(p.status));
  const now = new Date();

  return (
    <div className="pulls">
      <div className="setrow">
        <label className="setrow small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Include merged and closed</label>
        <span className="sp" />
        <button className="btn" disabled={busy} onClick={() => void load()}>{busy ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      {error && <p className="banner warn small">{error}</p>}
      {pulls && shown.length === 0 && (
        <div className="empty card"><b>{all ? 'No pull requests yet' : 'Nothing waiting on review'}</b><span>Pull requests the app opens for artifacts, conversations and decision records show up here.</span></div>
      )}
      {shown.length > 0 && (
        <div className="card tw">
          <table className="pull-table">
            <thead><tr><th>Pull request</th><th>Repo</th><th>Product</th><th>Status</th><th>Reviewers</th><th>Unresolved</th><th>Opened</th><th /></tr></thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id} data-status={p.status}>
                  <td><b>#{p.prNumber}</b> {p.title}<br /><span className="mut small mono">{p.branch} → {p.base}</span></td>
                  <td>{ROLE_LABEL[p.role]}<br /><span className="mut small">{p.repo}</span></td>
                  <td>{p.productId && p.productName ? <button className="btn small-btn" onClick={() => onOpenProduct(p.productId!)}>{p.productName}</button> : <span className="mut">–</span>}</td>
                  <td><span className="tag" data-status={p.status}>{p.status ? PULL_STATUS_LABEL[p.status] : 'Unknown'}</span></td>
                  <td className="small">{p.reviewers.length ? p.reviewers.map((r) => `${r.login} (${r.state.replace('-', ' ')})`).join(', ') : <span className="mut">none yet</span>}</td>
                  <td className="num">{p.unresolvedComments ?? '–'}</td>
                  <td className="small mut">{ago(p.createdAt, now)}</td>
                  <td>{p.prNumber && <button className="btn small-btn" onClick={() => void window.pmworkbench.openOnGitHub(p.prUrl ?? `https://${host}/${p.repo}/pull/${p.prNumber}`)}>Open</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
