import { useEffect, useRef, useState } from 'react';
import type { PublicSettings } from '../../../shared/ipc.js';
import {
  ARTIFACT_TYPE_LABEL, ARTIFACT_TYPES, STAGE_LABEL, STAGES, suggestArtifactType, suggestStage,
  type ArtifactType, type Link, type Product, type WorkflowStage,
} from '../../../shared/products.js';
import { fillTemplate, suggestDestination, type EditSource, type WritePreview, type WriteResult } from '../../../shared/writes.js';
import { localDate } from '../../../shared/metrics.js';
import { Markdown } from './Markdown.js';
import { Sheet } from './Sheet.js';

type Mode = { kind: 'create'; product: Product; links: Link[] } | { kind: 'edit'; link: Link };

interface Props {
  mode: Mode;
  settings: PublicSettings;
  onClose: () => void;
  /** After a pull request was opened or a commit added to one. */
  onDone: (r: WriteResult) => void;
}

/**
 * Create or edit an artifact, then review exactly what will be sent — repo, branch, diff, pull
 * request — and confirm. Nothing reaches GitHub until "Open pull request" is pressed, and the main
 * process sends only what the review showed.
 */
export function ArtifactWriter({ mode, settings, onClose, onDone }: Props) {
  const [step, setStep] = useState<'edit' | 'review' | 'done'>('edit');
  const [type, setType] = useState<ArtifactType>('problem-brief');
  const [title, setTitle] = useState('');
  const [path, setPath] = useState('');
  const [pathTouched, setPathTouched] = useState(false);
  const [stage, setStage] = useState<WorkflowStage | ''>(suggestStage({ kind: 'artifact', artifactType: 'problem-brief' }) ?? '');
  const [stageTouched, setStageTouched] = useState(false);
  const [content, setContent] = useState('');
  const [description, setDescription] = useState('');
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [templateNote, setTemplateNote] = useState<string>();
  const [source, setSource] = useState<EditSource>();
  const [rootFolders, setRootFolders] = useState<string[]>([]);
  const [preview, setPreview] = useState<WritePreview>();
  const [result, setResult] = useState<WriteResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const edited = useRef(false);

  // Create: the artifacts repo's top-level folders, for suggesting where the file goes.
  useEffect(() => {
    if (mode.kind !== 'create') return;
    void window.pmworkbench.browseTree('artifacts', '').then((r) => { if (r.ok) setRootFolders(r.value.filter((e) => e.type === 'dir').map((e) => e.name)); });
  }, [mode.kind]);

  // Create: load the type's template (unless the PM already started writing).
  useEffect(() => {
    if (mode.kind !== 'create' || edited.current) return;
    const tpl = settings.templates[type];
    const values = { title: title || ARTIFACT_TYPE_LABEL[type], product: mode.product.name, date: localDate(new Date()) };
    if (!tpl) {
      setTemplateNote(`No template set for ${ARTIFACT_TYPE_LABEL[type].toLowerCase()}s. Starting blank; point to one in Settings.`);
      setContent(`# ${values.title}\n\n`);
      return;
    }
    setTemplateNote(`Loading the template from ${tpl}…`);
    let alive = true;
    void window.pmworkbench.readFile('artifacts', tpl).then((r) => {
      if (!alive || edited.current) return;
      if (r.ok) { setContent(fillTemplate(r.value.content, values)); setTemplateNote(`Started from the template at ${tpl}.`); }
      else { setContent(`# ${values.title}\n\n`); setTemplateNote(`Couldn't read the template at ${tpl}: ${r.message}. Starting blank.`); }
    });
    return () => { alive = false; };
  }, [type, settings.templates]); // eslint-disable-line react-hooks/exhaustive-deps

  // Create: keep the suggested path and stage in step with the type and title until the PM changes them.
  useEffect(() => {
    if (mode.kind !== 'create') return;
    if (!pathTouched) {
      const existingPaths = mode.links.filter((l) => l.kind === 'artifact' && (l.artifactType ?? 'other') === type && l.path).map((l) => l.path!);
      setPath(suggestDestination(type, title || ARTIFACT_TYPE_LABEL[type], { existingPaths, rootFolders, typeOf: suggestArtifactType }));
    }
    if (!stageTouched) setStage(suggestStage({ kind: 'artifact', artifactType: type }) ?? '');
  }, [type, title, rootFolders]); // eslint-disable-line react-hooks/exhaustive-deps

  // Edit: start from the latest version, which may be on the app's open pull request.
  useEffect(() => {
    if (mode.kind !== 'edit') return;
    void window.pmworkbench.editSource(mode.link.id).then((r) => {
      if (r.ok) { setSource(r.value); setContent(r.value.content); } else setError(r.message);
    });
  }, [mode]);

  const review = async () => {
    setBusy(true);
    setError(undefined);
    const r = await window.pmworkbench.previewWrite(mode.kind === 'create'
      ? { kind: 'create-artifact', productId: mode.product.id, artifactType: type, path, title, content, description, stage: stage || null }
      : { kind: 'edit-artifact', linkId: mode.link.id, content, description });
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

  const heading = mode.kind === 'create' ? `New artifact for ${mode.product.name}` : `Edit ${mode.link.title}`;

  if (step === 'done' && result) {
    return (
      <Sheet name="write-done" title={result.addedToExisting ? 'Commit added' : 'Pull request opened'} onClose={onClose} width={520}
        footer={<>
          {result.prUrl && <button className="btn" onClick={() => void window.pmworkbench.openOnGitHub(result.prUrl)}>Open on GitHub</button>}
          <button className="btn primary" data-autofocus onClick={onClose}>Done</button>
        </>}>
        <p>
          {result.addedToExisting ? `Your change was added as a new commit to pull request #${result.prNumber}.` : `Pull request #${result.prNumber} is open from ${result.branch}.`}
          {' '}Nothing was committed to the default branch; it lands when the pull request is reviewed and merged on GitHub.
        </p>
        {mode.kind === 'create' && <p className="mut small">The artifact is linked to the product and shows as pending on the board until the pull request merges.</p>}
      </Sheet>
    );
  }

  if (step === 'review' && preview) {
    return (
      <Sheet name="write-review" title="Review before sending" onClose={onClose} width={900}
        footer={<>
          {error && <span className="small" style={{ color: 'var(--red)', marginRight: 'auto' }}>{error}</span>}
          <button className="btn" onClick={() => { setStep('edit'); setPreview(undefined); }}>Back</button>
          <button className="btn primary" disabled={busy} onClick={() => void send()}>
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
        <p className="mut small">Nothing is written to the default branch. This creates the branch and one commit, then opens the pull request; review and merging stay on GitHub.</p>
      </Sheet>
    );
  }

  return (
    <Sheet name="artifact-writer" title={heading} onClose={onClose} width={900}
      footer={<>
        {error && <span className="small" style={{ color: 'var(--red)', marginRight: 'auto' }}>{error}</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !content.trim() || (mode.kind === 'create' && (!title.trim() || !path.trim()))} onClick={() => void review()}>
          {busy ? 'Preparing…' : 'Review changes'}
        </button>
      </>}>
      {mode.kind === 'create' && (
        <div className="writer-fields">
          <label className="fld">Type
            <select value={type} onChange={(e) => setType(e.target.value as ArtifactType)}>
              {ARTIFACT_TYPES.map((t) => <option key={t} value={t}>{ARTIFACT_TYPE_LABEL[t]}</option>)}
            </select>
          </label>
          <label className="fld grow">Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Checkout retry: problem brief" data-autofocus maxLength={200} />
          </label>
          <label className="fld grow">Destination in {settings.repoRoles.artifacts?.fullName ?? 'the artifacts repo'}
            <input className="mono" value={path} onChange={(e) => { setPath(e.target.value); setPathTouched(true); }} />
          </label>
          <label className="fld">Board stage
            <select value={stage} onChange={(e) => { setStage(e.target.value as WorkflowStage | ''); setStageTouched(true); }}>
              <option value="">Unstaged</option>
              {STAGES.map((s, i) => <option key={s} value={s}>{i + 1}. {STAGE_LABEL[s]}</option>)}
            </select>
          </label>
        </div>
      )}
      {mode.kind === 'create' && templateNote && <p className="mut small">{templateNote}</p>}
      {mode.kind === 'edit' && source && (
        <p className={`banner small ${source.from === 'pull-request' ? 'info' : ''}`}>
          {source.from === 'pull-request' && source.pr
            ? `Editing the version in pull request #${source.pr.number}. Your change is added to that pull request as a new commit.`
            : `Editing ${source.path} as it is on the default branch. Your change opens a new pull request.`}
        </p>
      )}
      <div className="seg small" role="tablist" aria-label="Editor">
        <button role="tab" aria-selected={tab === 'write'} onClick={() => setTab('write')}>Write</button>
        <button role="tab" aria-selected={tab === 'preview'} onClick={() => setTab('preview')}>Preview</button>
      </div>
      {tab === 'write'
        ? <textarea className="field editor mono" value={content} onChange={(e) => { edited.current = true; setContent(e.target.value); }} aria-label="Markdown" spellCheck />
        : <div className="card inner md-preview"><Markdown source={content} /></div>}
      <label className="fld">Pull request description <span className="mut small">(optional; the app adds which product it's for)</span>
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Why this change, and what reviewers should look at." />
      </label>
    </Sheet>
  );
}
