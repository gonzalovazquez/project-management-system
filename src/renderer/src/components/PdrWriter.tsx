import { useEffect, useState } from 'react';
import type { AuthState } from '../../../shared/ipc.js';
import { localDate } from '../../../shared/metrics.js';
import type { Product } from '../../../shared/products.js';
import { fillTemplate, pdrPath, type BranchConvention, type PdrLayout, type WritePreview, type WriteResult } from '../../../shared/writes.js';
import { Markdown } from './Markdown.js';
import { Sheet } from './Sheet.js';
import { WriteDone, WriteReview } from './WriteSheets.js';

/** The structure offered when the PDR repo has no template; the PM confirms or edits it. */
export function minimalPdr(title: string, login: string, product: string): string {
  return `# ${title}

**Status:** Draft · **Owner:** ${login} · **Reviewers:**
**Product:** ${product}

## Problem

## Options considered

## Proposed decision

## Consequences
`;
}

/**
 * Raise a product decision record: from the PDR repo's template if it has one, otherwise from a
 * minimal structure the PM confirms. The pull request follows the repo's own branch convention
 * (e.g. git-flow: spec/… into develop), detected from its history and confirmed once.
 */
export function PdrWriter({ product, auth, onClose, onDone }: { product: Product; auth: Extract<AuthState, { status: 'signed-in' }>; onClose: () => void; onDone: (r: WriteResult) => void }) {
  const [layout, setLayout] = useState<PdrLayout>();
  const [title, setTitle] = useState('');
  const [path, setPath] = useState('');
  const [pathTouched, setPathTouched] = useState(false);
  const [content, setContent] = useState('');
  const [edited, setEdited] = useState(false);
  const [conv, setConv] = useState<BranchConvention>({ prefix: '', base: '' });
  const [editConv, setEditConv] = useState(false);
  const [description, setDescription] = useState('');
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [step, setStep] = useState<'edit' | 'review' | 'done'>('edit');
  const [preview, setPreview] = useState<WritePreview>();
  const [result, setResult] = useState<WriteResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void window.pmworkbench.pdrLayout().then((r) => {
      if (!r.ok) { setError(r.message); return; }
      setLayout(r.value);
      const c = r.value.confirmed ?? r.value.detected;
      setConv({ prefix: c.prefix, base: c.base });
      setEditConv(!r.value.confirmed);
    });
  }, []);

  useEffect(() => {
    if (!layout) return;
    const t = title.trim() || 'New decision';
    if (!pathTouched) setPath(pdrPath(layout, title.trim() || 'decision'));
    if (!edited) setContent(layout.template ? fillTemplate(layout.template.content, { title: t, product: product.name, date: localDate(new Date()) }) : minimalPdr(t, auth.login, product.name));
  }, [title, layout, pathTouched, edited, product.name, auth.login]);

  const review = async () => {
    setBusy(true);
    setError(undefined);
    const r = await window.pmworkbench.previewWrite({ kind: 'create-pdr', productId: product.id, path, title, content, description, convention: conv });
    setBusy(false);
    if (!r.ok) { setError(r.message); return; }
    setPreview(r.value);
    setStep('review');
  };

  const send = async () => {
    if (!preview) return;
    setBusy(true);
    setError(undefined);
    const r = await window.pmworkbench.confirmWrite(preview.id);
    setBusy(false);
    if (!r.ok) { setError(r.message); setStep('edit'); setPreview(undefined); return; }
    setResult(r.value);
    setStep('done');
    onDone(r.value);
  };

  if (step === 'done' && result) return <WriteDone result={result} onClose={onClose} note="The decision record is linked to the product in Specification, with its review status on the board and product home." />;
  if (step === 'review' && preview) return <WriteReview preview={preview} busy={busy} error={error} onClose={onClose} onBack={() => { setStep('edit'); setPreview(undefined); }} onSend={() => void send()} />;

  return (
    <Sheet name="pdr-writer" title={`Raise a decision record for ${product.name}`} onClose={onClose} width={900}
      footer={<>
        {error && <span className="small" style={{ color: 'var(--red)', marginRight: 'auto' }}>{error}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !layout || !title.trim() || !path.trim() || !conv.prefix || !conv.base} onClick={() => void review()}>
          {busy ? 'Preparing…' : 'Review changes'}
        </button>
      </>}>
      {!layout && !error && <p className="mut small">Reading the PDR repo's layout and branch history…</p>}
      {layout && (
        <div className={`banner small ${layout.confirmed ? 'info' : 'warn'} convention`}>
          {layout.confirmed && !editConv ? (
            <p>Branches follow your confirmed convention: <code className="mono">{conv.prefix}…</code> into <code className="mono">{conv.base}</code>. <button className="btn small-btn" onClick={() => setEditConv(true)}>Change</button></p>
          ) : (
            <>
              <p><b>Confirm the PDR repo's branch convention</b> (asked once). Detected: {layout.detected.evidence}.</p>
              <div className="setrow">
                <label className="setrow">Branch prefix <input className="field mono" style={{ width: 110 }} value={conv.prefix} onChange={(e) => setConv({ ...conv, prefix: e.target.value })} /></label>
                <label className="setrow">Pull requests into <input className="field mono" style={{ width: 110 }} value={conv.base} onChange={(e) => setConv({ ...conv, base: e.target.value })} /></label>
              </div>
            </>
          )}
        </div>
      )}
      <div className="writer-fields pdr">
        <label className="fld grow">Title<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="SPEC-004: Retry limits" data-autofocus maxLength={200} /></label>
        <label className="fld grow">File<input className="mono" value={path} onChange={(e) => { setPath(e.target.value); setPathTouched(true); }} /></label>
      </div>
      {layout && <p className="mut small">{layout.template ? `Started from the template at ${layout.template.path}.` : 'No template found in the PDR repo, so this starts from a minimal structure. Check it fits before sending.'}</p>}
      <div className="seg small" role="tablist" aria-label="Editor">
        <button role="tab" aria-selected={tab === 'write'} onClick={() => setTab('write')}>Write</button>
        <button role="tab" aria-selected={tab === 'preview'} onClick={() => setTab('preview')}>Preview</button>
      </div>
      {tab === 'write'
        ? <textarea className="field editor mono" value={content} onChange={(e) => { setEdited(true); setContent(e.target.value); }} aria-label="Markdown" spellCheck />
        : <div className="card inner md-preview"><Markdown source={content} /></div>}
      <label className="fld">Pull request description <span className="mut small">(optional)</span>
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What needs deciding, and by when." />
      </label>
    </Sheet>
  );
}
