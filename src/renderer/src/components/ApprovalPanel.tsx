import { PULL_STATUS_LABEL, type ItemState, type Link, type Reviewer } from '../../../shared/products.js';

const REVIEW_LABEL: Record<Reviewer['state'], string> = { requested: 'waiting', approved: 'approved', 'changes-requested': 'changes requested', commented: 'commented', dismissed: 'dismissed' };

/** The pull request a decision record is under review in: its own, or the app's pending one. */
export function prOf(l: Link, s: ItemState | undefined) {
  if (s?.kind === 'pull' && l.prNumber !== undefined) return { number: l.prNumber, ...s };
  if (s?.kind === 'pending') return { number: s.prNumber, ...s };
  return undefined;
}

/**
 * Review and approval state for a product's decision records, without opening GitHub: state,
 * each reviewer's latest review, and unresolved review comments, with a link out to the pull
 * request for the review itself.
 */
export function ApprovalPanel({ links, states, host }: { links: Link[]; states: Record<string, ItemState>; host: string }) {
  const rows = links.map((l) => ({ l, pr: prOf(l, states[l.id]) })).filter((x) => x.pr);
  if (!rows.length) return <p className="mut small approvals-empty">No decision records are in review. Link a PDR pull request, or raise one, to see its approval status here.</p>;
  return (
    <div className="approvals" aria-label="Approval status">
      <h4>Approval status</h4>
      <ul>
        {rows.map(({ l, pr }) => (
          <li key={l.id} data-status={pr!.status}>
            <div className="appr-hd">
              <b>{l.title}</b>
              <span className="tag" data-status={pr!.status}>{PULL_STATUS_LABEL[pr!.status]}</span>
            </div>
            <div className="small">
              {pr!.reviewers.length === 0 ? <span className="mut">No reviewers yet</span> : pr!.reviewers.map((r) => (
                <span key={r.login} className="reviewer" data-state={r.state}>{r.login} <span className="mut">{REVIEW_LABEL[r.state]}</span></span>
              ))}
              {pr!.unresolvedComments ? <span className="unresolved-n">{pr!.unresolvedComments} unresolved comment{pr!.unresolvedComments === 1 ? '' : 's'}</span> : null}
            </div>
            <button className="btn small-btn" onClick={() => void window.pmworkbench.openOnGitHub(`https://${host}/${l.repoFullName}/pull/${pr!.number}`)}>Review on GitHub · #{pr!.number}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
