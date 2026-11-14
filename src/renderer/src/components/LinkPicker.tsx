import { useEffect, useMemo, useState } from 'react';
import { REPO_ROLES, ROLE_LABEL, type LinkUpdate, type PublicSettings, type RepoRole, type TreeEntry } from '../../../shared/ipc.js';
import { ARTIFACT_TYPE_LABEL, ARTIFACT_TYPES, markdownSections, STAGE_LABEL, STAGES, type WorkflowStage, type ArtifactType, type Link, type PullSummary, type Section } from '../../../shared/products.js';
import { fileToLink, keyOf, linkable, pullToLink, sectionToLink, setStage, setType, toggle, type Selection } from '../viewmodel/picker.js';
import { Icon } from './Icon.js';
import { Sheet } from './Sheet.js';

type Mode = { kind: 'add' } | { kind: 'relink'; link: Link };

interface Props {
  settings: PublicSettings;
  existing: Link[];
  mode: Mode;
  onClose: () => void;
  /** Add mode: the items to link. Relink mode: the new target for the link. */
  onPick: (r: { add: ReturnType<typeof linkable> } | { relink: LinkUpdate }) => Promise<string | undefined>;
}

const KIND_HINT: Record<RepoRole, string> = {
  artifacts: 'Tick artifacts to link. Pick each one’s type on the right.',
  crm: 'Tick a customer file to link the customer, or open it to pick individual conversations.',
  pdr: 'Tick decision record files, or switch to pull requests to link one under review.',
};

/**
 * Browse a connected repo and tick items to link to a product, across all three repos in one go.
 * Also used to relink a broken link, where it picks exactly one target of the same kind.
 */
export function LinkPicker({ settings, existing, mode, onClose, onPick }: Props) {
  const relink = mode.kind === 'relink' ? mode.link : undefined;
  const [role, setRole] = useState<RepoRole>(relink?.role ?? 'artifacts');
  const [pdrView, setPdrView] = useState<'files' | 'pulls'>(relink?.prNumber !== undefined ? 'pulls' : 'files');
  const [path, setPath] = useState(relink?.path?.split('/').slice(0, -1).join('/') ?? '');
  const [entries, setEntries] = useState<TreeEntry[]>();
  const [pulls, setPulls] = useState<PullSummary[]>();
  const [sections, setSections] = useState<Record<string, { sha: string; list: Section[] } | 'loading'>>({});
  const [selection, setSelection] = useState<Selection>(new Map());
  const [target, setTarget] = useState<LinkUpdate & { label: string }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const linked = useMemo(() => new Set(existing.map(keyOf)), [existing]);
  const showPulls = role === 'pdr' && pdrView === 'pulls';

  useEffect(() => {
    if (!settings.repoRoles[role] || showPulls) return;
    let alive = true;
    setEntries(undefined);
    setError(undefined);
    void window.pmworkbench.browseTree(role, path).then((r) => {
      if (!alive) return;
      if (r.ok) setEntries(r.value); else setError(r.message);
    });
    return () => { alive = false; };
  }, [role, path, showPulls, settings.repoRoles]);

  useEffect(() => {
    if (!showPulls || pulls) return;
    void window.pmworkbench.listPulls('pdr').then((r) => { if (r.ok) setPulls(r.value); else setError(r.message); });
  }, [showPulls, pulls]);

  const switchRole = (r: RepoRole) => { setRole(r); setPath(''); setSections({}); };

  const openSections = async (entry: TreeEntry) => {
    if (sections[entry.path]) { const { [entry.path]: _, ...rest } = sections; setSections(rest); return; }
    setSections({ ...sections, [entry.path]: 'loading' });
    const r = await window.pmworkbench.readFile('crm', entry.path);
    if (!r.ok) { setError(r.message); setSections((s) => { const { [entry.path]: _, ...rest } = s; return rest; }); return; }
    setSections((s) => ({ ...s, [entry.path]: { sha: r.value.sha, list: markdownSections(r.value.content) } }));
  };

  // In relink mode a click picks the one new target; in add mode it ticks.
  const pickFile = (entry: TreeEntry) => {
    if (relink) {
      if (relink.kind === 'conversation') { void openSections(entry); return; }
      setTarget({ path: entry.path, blobSha: entry.sha, label: entry.path });
      return;
    }
    setSelection(toggle(selection, fileToLink(role, entry)));
  };

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    const message = relink
      ? target ? await onPick({ relink: { path: target.path, anchor: target.anchor, prNumber: target.prNumber, blobSha: target.blobSha, title: target.title } }) : 'Pick the new target first.'
      : await onPick({ add: linkable(selection, linked) });
    setBusy(false);
    if (message) setError(message);
  };

  const count = linkable(selection, linked).length;
  const crumbs = path ? path.split('/') : [];
  const repo = settings.repoRoles[role];

  return (
    <Sheet
      name="link-picker"
      title={relink ? `Relink “${relink.title}”` : 'Link items to this product'}
      onClose={onClose}
      width={860}
      footer={
        <>
          {error && <span className="small" style={{ color: 'var(--red)', marginRight: 'auto' }}>{error}</span>}
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || (relink ? !target : count === 0)} onClick={() => void submit()}>
            {busy ? 'Saving…' : relink ? 'Relink' : `Link ${count || ''} item${count === 1 ? '' : 's'}`}
          </button>
        </>
      }
    >
      {!relink && (
        <div className="seg" role="tablist" aria-label="Repo">
          {REPO_ROLES.map((r) => (
            <button key={r} role="tab" aria-selected={role === r} onClick={() => switchRole(r)}>{ROLE_LABEL[r]}</button>
          ))}
        </div>
      )}
      <p className="mut small">{relink ? `Pick the new ${relink.prNumber !== undefined ? 'pull request' : relink.kind === 'conversation' ? 'conversation section' : 'file'} for this link.` : KIND_HINT[role]}</p>
      {role === 'pdr' && !relink && (
        <div className="seg small" role="tablist" aria-label="Decision records">
          <button role="tab" aria-selected={pdrView === 'files'} onClick={() => setPdrView('files')}>Files</button>
          <button role="tab" aria-selected={pdrView === 'pulls'} onClick={() => setPdrView('pulls')}>Pull requests</button>
        </div>
      )}
      <div className="picker">
        <div className="card tree inner">
          {!repo && <p className="mut small">No repo is assigned to {ROLE_LABEL[role]} yet. Set it up in Settings.</p>}
          {repo && showPulls && (
            <ul>
              {!pulls && <li className="mut small">Loading pull requests…</li>}
              {pulls?.length === 0 && <li className="mut small">No pull requests in {repo.fullName}.</li>}
              {pulls?.map((p) => {
                const l = pullToLink(p);
                const k = keyOf(l);
                const already = linked.has(k);
                const checked = relink ? target?.prNumber === p.number : selection.has(k);
                return (
                  <li key={p.number}>
                    <label className="pick">
                      <input type={relink ? 'radio' : 'checkbox'} name="pr" checked={checked || already} disabled={already}
                        onChange={() => (relink ? setTarget({ prNumber: p.number, title: l.title, label: l.title }) : setSelection(toggle(selection, l)))} />
                      <span>#{p.number} {p.title}</span>
                      <span className="tag">{p.merged ? 'merged' : p.draft ? 'draft' : p.state}</span>
                      {already && <span className="mut small">linked</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {repo && !showPulls && (
            <>
              <div className="crumbs">
                <button onClick={() => setPath('')}>{repo.name}</button>
                {crumbs.map((c, i) => <span key={i}>{' / '}<button onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}>{c}</button></span>)}
              </div>
              <ul>
                {!entries && !error && <li className="mut small">Loading…</li>}
                {entries?.length === 0 && <li className="mut small">Empty folder.</li>}
                {entries?.map((entry) => {
                  if (entry.type === 'dir') {
                    return (
                      <li key={entry.path}>
                        <button onClick={() => setPath(entry.path)}><Icon name="folder" className="ic" /><span>{entry.name}</span></button>
                      </li>
                    );
                  }
                  const l = fileToLink(role, entry);
                  const k = keyOf(l);
                  const already = linked.has(k);
                  const secs = sections[entry.path];
                  const fileTicked = relink ? target?.path === entry.path && !target.anchor : selection.has(k);
                  const wantsFile = !relink || relink.kind !== 'conversation';
                  return (
                    <li key={entry.path} className="col">
                      <div className="pick">
                        {wantsFile && (
                          <input type={relink ? 'radio' : 'checkbox'} name="file" aria-label={`Link ${entry.name}`} checked={fileTicked || already} disabled={already} onChange={() => pickFile(entry)} />
                        )}
                        <button className="pick-name" onClick={() => pickFile(entry)}><Icon name="grid" className="ic" /><span>{entry.name}</span></button>
                        {already && <span className="mut small">linked</span>}
                        {role === 'crm' && (
                          <button className="btn small-btn" aria-expanded={!!secs} onClick={() => void openSections(entry)}>{secs ? 'Hide conversations' : 'Conversations'}</button>
                        )}
                      </div>
                      {secs === 'loading' && <span className="mut small sub">Reading…</span>}
                      {secs && secs !== 'loading' && (
                        <ul className="sub">
                          {secs.list.length === 0 && <li className="mut small">No ## sections in this file.</li>}
                          {secs.list.map((s) => {
                            const sl = sectionToLink(entry.path, secs.sha, s);
                            const sk = keyOf(sl);
                            const sAlready = linked.has(sk);
                            const sChecked = relink ? target?.path === entry.path && target.anchor === s.anchor : selection.has(sk);
                            return (
                              <li key={s.anchor}>
                                <label className="pick">
                                  <input type={relink ? 'radio' : 'checkbox'} name="section" checked={sChecked || sAlready} disabled={sAlready}
                                    onChange={() => (relink ? setTarget({ path: entry.path, anchor: s.anchor, blobSha: secs.sha, title: s.heading, label: `${entry.path} › ${s.heading}` }) : setSelection(toggle(selection, sl)))} />
                                  <span>{s.heading}</span>
                                  {sAlready && <span className="mut small">linked</span>}
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
        <div className="card inner picked">
          <h3>{relink ? 'New target' : `Selected (${count})`}</h3>
          {relink && (target ? <p className="mono small">{target.label}</p> : <p className="mut small">Nothing picked yet.</p>)}
          {relink?.health.state === 'broken' && relink.health.movedTo && !target && (
            <button className="btn" onClick={() => setTarget({ path: (relink.health as { movedTo: string }).movedTo, label: (relink.health as { movedTo: string }).movedTo })}>
              Use {relink.health.movedTo}
            </button>
          )}
          {!relink && count === 0 && <p className="mut small">Nothing selected yet. Items from all three repos can be linked in one go.</p>}
          {!relink && (
            <ul className="picked-list">
              {linkable(selection, linked).map((l) => {
                const k = keyOf(l);
                return (
                  <li key={k}>
                    <div>
                      <b>{l.title}</b>
                      <span className="mut small">{ROLE_LABEL[l.role]} · {l.kind}{l.prNumber ? '' : ` · ${l.path}`}</span>
                    </div>
                    <div className="picked-fields">
                      {l.kind === 'artifact' && (
                        <select aria-label={`Type of ${l.title}`} value={l.artifactType} onChange={(e) => setSelection(setType(selection, k, e.target.value as ArtifactType))}>
                          {ARTIFACT_TYPES.map((t) => <option key={t} value={t}>{ARTIFACT_TYPE_LABEL[t]}</option>)}
                        </select>
                      )}
                      <select aria-label={`Stage of ${l.title}`} value={l.stage ?? ''} onChange={(e) => setSelection(setStage(selection, k, (e.target.value || undefined) as WorkflowStage | undefined))}>
                        <option value="">Unstaged</option>
                        {STAGES.map((st, i) => <option key={st} value={st}>{i + 1}. {STAGE_LABEL[st]}</option>)}
                      </select>
                    </div>
                    <button className="btn icon" aria-label={`Unselect ${l.title}`} onClick={() => setSelection(toggle(selection, l))}>×</button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Sheet>
  );
}
