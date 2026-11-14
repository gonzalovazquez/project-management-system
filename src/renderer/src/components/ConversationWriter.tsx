import { useEffect, useState } from 'react';
import { localDate } from '../../../shared/metrics.js';
import { slugify, STAGE_LABEL, STAGES, type Product, type WorkflowStage } from '../../../shared/products.js';
import { appendConversation, conversationHeading, type CrmLayout, type WritePreview, type WriteResult } from '../../../shared/writes.js';
import { Markdown } from './Markdown.js';
import { Sheet } from './Sheet.js';
import { WriteDone, WriteReview } from './WriteSheets.js';

const NEW = '__new__';

/**
 * Log a customer conversation for a product: pick the customer (or add one), then the date,
 * participants and notes. It's added to the customer's file in the CRM repo in the repo's own
 * heading style, through a pull request, and linked to the product in intake by default.
 */
export function ConversationWriter({ product, onClose, onDone }: { product: Product; onClose: () => void; onDone: (r: WriteResult) => void }) {
  const [layout, setLayout] = useState<CrmLayout>();
  const [customer, setCustomer] = useState('');
  const [newName, setNewName] = useState('');
  const [newPath, setNewPath] = useState('');
  const [pathTouched, setPathTouched] = useState(false);
  const [date, setDate] = useState(localDate(new Date()));
  const [topic, setTopic] = useState('');
  const [participants, setParticipants] = useState('');
  const [notes, setNotes] = useState('');
  const [stage, setStage] = useState<WorkflowStage | ''>('intake');
  const [description, setDescription] = useState('');
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [step, setStep] = useState<'edit' | 'review' | 'done'>('edit');
  const [preview, setPreview] = useState<WritePreview>();
  const [result, setResult] = useState<WriteResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void window.pmworkbench.crmLayout().then((r) => {
      if (!r.ok) { setError(r.message); return; }
      setLayout(r.value);
      setCustomer(r.value.customers[0]?.path ?? NEW);
    });
  }, []);

  useEffect(() => {
    if (layout && !pathTouched) setNewPath(`${layout.folder ? `${layout.folder}/` : ''}${slugify(newName) || 'new-customer'}.md`);
  }, [newName, layout, pathTouched]);

  const isNew = customer === NEW;
  const path = isNew ? newPath : customer;
  const sectionPreview = appendConversation(null, { customerName: isNew ? newName : '', date, topic: topic || 'Topic', participants, notes }, layout?.separator).replace(/^# .*\n\n/, '');

  const review = async () => {
    setBusy(true);
    setError(undefined);
    const r = await window.pmworkbench.previewWrite({
      kind: 'log-conversation', productId: product.id, customerPath: path, ...(isNew ? { customerName: newName } : {}),
      date, topic, participants, notes, description, stage: stage || null,
    });
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

  if (step === 'done' && result) return <WriteDone result={result} onClose={onClose} note="The conversation is linked to the product and shows as pending on the board until the pull request merges." />;
  if (step === 'review' && preview) return <WriteReview preview={preview} busy={busy} error={error} onClose={onClose} onBack={() => { setStep('edit'); setPreview(undefined); }} onSend={() => void send()} />;

  return (
    <Sheet name="conversation-writer" title={`Log a conversation for ${product.name}`} onClose={onClose} width={820}
      footer={<>
        {error && <span className="small" style={{ color: 'var(--red)', marginRight: 'auto' }}>{error}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !layout || !topic.trim() || !notes.trim() || (isNew && (!newName.trim() || !newPath.trim()))} onClick={() => void review()}>
          {busy ? 'Preparing…' : 'Review changes'}
        </button>
      </>}>
      {!layout && !error && <p className="mut small">Reading how your CRM repo is laid out…</p>}
      {layout && <p className="mut small">Customers live in <code className="mono">{layout.folder}/</code>; conversations are added as <code className="mono">## {conversationHeading('YYYY-MM-DD', 'topic', layout.separator)}</code> sections, like the existing ones.</p>}
      <div className="writer-fields conv">
        <label className="fld">Customer
          <select value={customer} onChange={(e) => setCustomer(e.target.value)} disabled={!layout} data-autofocus>
            {layout?.customers.map((c) => <option key={c.path} value={c.path}>{c.name}</option>)}
            <option value={NEW}>New customer…</option>
          </select>
        </label>
        <label className="fld">Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="fld grow">Topic<input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Retry countdown feedback" maxLength={200} /></label>
        <label className="fld">Board stage
          <select value={stage} onChange={(e) => setStage(e.target.value as WorkflowStage | '')}>
            <option value="">Unstaged</option>
            {STAGES.map((s, i) => <option key={s} value={s}>{i + 1}. {STAGE_LABEL[s]}</option>)}
          </select>
        </label>
      </div>
      {isNew && (
        <div className="writer-fields conv-new">
          <label className="fld grow">Customer name<input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Initech" /></label>
          <label className="fld grow">New file<input className="mono" value={newPath} onChange={(e) => { setNewPath(e.target.value); setPathTouched(true); }} /></label>
        </div>
      )}
      <label className="fld">Participants<input value={participants} onChange={(e) => setParticipants(e.target.value)} placeholder="Dana (Acme ops), me" /></label>
      <div className="seg small" role="tablist" aria-label="Notes">
        <button role="tab" aria-selected={tab === 'write'} onClick={() => setTab('write')}>Notes</button>
        <button role="tab" aria-selected={tab === 'preview'} onClick={() => setTab('preview')}>Preview section</button>
      </div>
      {tab === 'write'
        ? <textarea className="field editor short mono" value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Notes" placeholder="What they said, what they asked for, what you agreed." spellCheck />
        : <div className="card inner md-preview short"><Markdown source={sectionPreview} /></div>}
      <label className="fld">Pull request description <span className="mut small">(optional)</span>
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
    </Sheet>
  );
}
