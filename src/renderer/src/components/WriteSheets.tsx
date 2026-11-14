import type { WritePreview, WriteResult } from '../../../shared/writes.js';
import { Sheet } from './Sheet.js';

/**
 * The two screens every write ends with, whatever it writes: review exactly what will be sent
 * (repo, branch, base, commit, diff, pull request), then the result. Shared by artifacts, CRM
 * conversations and PDRs so every write looks and behaves the same.
 */
export function WriteReview({ preview, busy, error, onClose, onBack, onSend }: {
  preview: WritePreview; busy: boolean; error?: string; onClose: () => void; onBack: () => void; onSend: () => void;
}) {
  return (
    <Sheet name="write-review" title="Review before sending" onClose={onClose} width={900}
      footer={<>
        {error && <span className="small" style={{ color: 'var(--red)', marginRight: 'auto' }}>{error}</span>}
        <button className="btn" onClick={onBack}>Back</button>
        <button className="btn primary" disabled={busy} onClick={onSend}>
          {busy ? 'Sending…' : preview.existingPr ? `Add commit to #${preview.existingPr.number}` : 'Open pull request'}
        </button>
      </>}>
      <dl className="review-meta">
        <dt>Repo</dt><dd className="mono">{preview.repo}</dd>
        <dt>Branch</dt><dd className="mono">{preview.branch} <span className="mut">{preview.existingPr ? `(already open as #${preview.existingPr.number})` : `(new, from ${preview.base})`}</span></dd>
        <dt>Into</dt><dd className="mono">{preview.base}</dd>
        <dt>Commit</dt><dd>{preview.commitMessage}</dd>
        {!preview.existingPr && <><dt>Pull request</dt><dd><b>{preview.title}</b></dd></>}
      </dl>
      {preview.files.map((f) => (
        <div key={f.path} className="diff-file">
          <div className="diff-head"><span className="mono">{f.path}</span><span className="small"><span className="good">+{f.added}</span> <span style={{ color: 'var(--red)' }}>−{f.removed}</span> · {f.change === 'create' ? 'new file' : 'changed'}</span></div>
          <pre className="diff mono small">{f.diff.split('\n').slice(2).map((line, i) => (
            <span key={i} data-t={line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : line[0] === '@' ? 'hunk' : 'ctx'}>{line}{'\n'}</span>
          ))}</pre>
        </div>
      ))}
      {!preview.existingPr && (
        <details className="tview" open>
          <summary>Pull request description</summary>
          <pre className="mono small pr-body">{preview.body}</pre>
        </details>
      )}
      <p className="mut small">Nothing is written to {preview.base} or any default branch. This creates the branch and one commit, then opens the pull request; review and merging stay on GitHub.</p>
    </Sheet>
  );
}

export function WriteDone({ result, onClose, note }: { result: WriteResult; onClose: () => void; note?: string }) {
  return (
    <Sheet name="write-done" title={result.addedToExisting ? 'Commit added' : 'Pull request opened'} onClose={onClose} width={520}
      footer={<>
        {result.prUrl && <button className="btn" onClick={() => void window.pmworkbench.openOnGitHub(result.prUrl)}>Open on GitHub</button>}
        <button className="btn primary" data-autofocus onClick={onClose}>Done</button>
      </>}>
      <p>
        {result.addedToExisting ? `Your change was added as a new commit to pull request #${result.prNumber}.` : `Pull request #${result.prNumber} is open from ${result.branch}.`}
        {' '}Nothing was committed to a default branch; it lands when the pull request is reviewed and merged on GitHub.
      </p>
      {note && <p className="mut small">{note}</p>}
    </Sheet>
  );
}
