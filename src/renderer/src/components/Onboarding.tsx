import { useEffect, useState } from 'react';
import { REPO_ROLES, ROLE_LABEL, type PublicSettings, type RepoRef, type RepoRole } from '../../../shared/ipc.js';
import { ARTIFACT_TYPE_LABEL, ARTIFACT_TYPES, type ArtifactType } from '../../../shared/products.js';

interface Props {
  settings: PublicSettings;
  onSettings: (s: PublicSettings) => void;
  /** Done: open this product, or the products page when none was made. */
  onFinish: (productId?: string) => void;
}

type Step = 'repos' | 'templates' | 'product';
const STEPS: Step[] = ['repos', 'templates', 'product'];
const STEP_TITLE: Record<Step, string> = { repos: 'Connect your three repos', templates: 'Point at your templates', product: 'Your first product' };

/** A first guess at which repo plays which role, from its name. The PM confirms or changes it. */
export function guessRole(name: string): RepoRole | undefined {
  const n = name.toLowerCase();
  if (/(^|[-_.])crm([-_.]|$)|customer/.test(n)) return 'crm';
  if (/(^|[-_.])pdr([-_.]|$)|decision|spec-approval/.test(n)) return 'pdr';
  if (/artifact|skill/.test(n)) return 'artifacts';
  return undefined;
}

/**
 * First run, right after sign-in: the three repos and their roles, optional templates, and a first
 * product (made here or imported from a teammate's export). Each step says why it matters; only
 * the repos are required.
 */
export function Onboarding({ settings, onSettings, onFinish }: Props) {
  const [step, setStep] = useState<Step>('repos');
  const [repos, setRepos] = useState<RepoRef[]>();
  const [missingScope, setMissingScope] = useState(false);
  const [roles, setRoles] = useState<Partial<Record<RepoRole, string>>>(Object.fromEntries(REPO_ROLES.map((r) => [r, settings.repoRoles[r]?.fullName ?? ''])));
  const [templates, setTemplates] = useState<Partial<Record<ArtifactType, string>>>(settings.templates);
  const [name, setName] = useState('');
  const [objective, setObjective] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.pmworkbench.listAvailableRepos().then((r) => {
      if (!r.ok) { setError(r.message); return; }
      setRepos(r.value.repos);
      setMissingScope(r.value.missingPrivateScope);
      // Pre-select by name where nothing is chosen yet.
      setRoles((cur) => {
        const next = { ...cur };
        for (const repo of r.value.repos) {
          const g = guessRole(repo.name);
          if (g && !next[g]) next[g] = repo.fullName;
        }
        return next;
      });
    });
  }, []);

  const save = async (patch: Parameters<typeof window.pmworkbench.saveSettings>[0]) => {
    const r = await window.pmworkbench.saveSettings(patch);
    if (!r.ok) { setError(r.message); return false; }
    onSettings(r.value);
    return true;
  };

  const next = async () => {
    setError(undefined);
    setBusy(true);
    try {
      if (step === 'repos') {
        const chosen = Object.fromEntries(REPO_ROLES.map((role) => [role, repos?.find((x) => x.fullName === roles[role]) ?? null]));
        if (REPO_ROLES.some((role) => !chosen[role])) { setError('Pick a repo for each of the three roles.'); return; }
        if (await save({ repoRoles: chosen })) setStep('templates');
      } else if (step === 'templates') {
        for (const [t, p] of Object.entries(templates)) {
          if (!p?.trim()) continue;
          const r = await window.pmworkbench.readFile('artifacts', p.trim());
          if (!r.ok) { setError(`${ARTIFACT_TYPE_LABEL[t as ArtifactType]}: couldn't read ${p} — ${r.message}`); return; }
        }
        if (await save({ templates: Object.fromEntries(ARTIFACT_TYPES.map((t) => [t, templates[t]?.trim() || null])) })) setStep('product');
      }
    } finally {
      setBusy(false);
    }
  };

  const finish = async (how: 'create' | 'import' | 'skip') => {
    setError(undefined);
    setBusy(true);
    try {
      let productId: string | undefined;
      if (how === 'create') {
        const r = await window.pmworkbench.createProduct({ name, objective, kpis: [] });
        if (!r.ok) { setError(r.message); return; }
        productId = r.value.id;
      } else if (how === 'import') {
        const r = await window.pmworkbench.importProduct();
        if (!r.ok) { setError(r.message); return; }
        if (r.value.cancelled) return;
        productId = r.value.productId;
      }
      if (await save({ onboarded: true })) onFinish(productId);
    } finally {
      setBusy(false);
    }
  };

  const at = STEPS.indexOf(step);

  return (
    <div className="gate">
      <div className="card gate-card onboarding" data-step={step}>
        <span className="mut small">Step {at + 2} of {STEPS.length + 1} · signed in</span>
        <h1>{STEP_TITLE[step]}</h1>

        {step === 'repos' && (
          <>
            <p className="mut">
              PM Workbench brings your three repos together around the products you manage. Tell it which repo is which. Nothing is
              moved, copied or added to them; the app only remembers the choice on this Mac.
            </p>
            {missingScope && (
              <p className="banner warn small">Your token can't see private repos (a classic token needs the <code className="mono">repo</code> scope). Change it in Settings later if a repo is missing.</p>
            )}
            {REPO_ROLES.map((role) => (
              <label key={role} className="fld">
                {ROLE_LABEL[role]}
                <select value={roles[role] ?? ''} onChange={(e) => setRoles({ ...roles, [role]: e.target.value })} disabled={!repos}>
                  <option value="">{repos ? 'Choose a repo…' : 'Loading your repos…'}</option>
                  {repos?.map((r) => <option key={r.fullName} value={r.fullName}>{r.fullName}</option>)}
                </select>
                <span className="small mut">
                  {role === 'artifacts' && 'Your Claude skills and the artifacts they produce: briefs, specs, control books, executive updates.'}
                  {role === 'crm' && 'Customer files with dated conversation notes.'}
                  {role === 'pdr' && 'Product decision records and the pull requests they are approved through.'}
                </span>
              </label>
            ))}
          </>
        )}

        {step === 'templates' && (
          <>
            <p className="mut">
              When you create an artifact, it can start from a template that already lives in {settings.repoRoles.artifacts?.fullName ?? 'your artifacts repo'}.
              Point at the file for each type you have one for, or skip and start blank. You can change these in Settings.
            </p>
            <div className="tpl-grid">
              {ARTIFACT_TYPES.filter((t) => t !== 'other').map((t) => (
                <label key={t} className="fld">
                  {ARTIFACT_TYPE_LABEL[t]}
                  <input className="mono" value={templates[t] ?? ''} placeholder="path/to/template.md" onChange={(e) => setTemplates({ ...templates, [t]: e.target.value })} />
                </label>
              ))}
            </div>
          </>
        )}

        {step === 'product' && (
          <>
            <p className="mut">
              A product is what everything hangs off: an objective, then the customers, artifacts and decisions linked to it. Create one,
              or import a mapping a teammate exported.
            </p>
            <label className="fld">Product name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Checkout retry flow" data-autofocus /></label>
            <label className="fld">Objective<textarea rows={2} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="The outcome this product is driving." /></label>
          </>
        )}

        {error && <p className="small err">{error}</p>}

        <div className="sheet-foot spread">
          <span>{at > 0 && <button className="btn" onClick={() => setStep(STEPS[at - 1])} disabled={busy}>Back</button>}</span>
          <span className="pa">
            {step === 'templates' && <button className="btn" onClick={() => setStep('product')} disabled={busy}>Skip</button>}
            {step === 'product' && (
              <>
                <button className="btn" onClick={() => void finish('skip')} disabled={busy}>Skip for now</button>
                <button className="btn" onClick={() => void finish('import')} disabled={busy}>Import a mapping…</button>
                <button className="btn primary" onClick={() => void finish('create')} disabled={busy || !name.trim()}>Create product</button>
              </>
            )}
            {step !== 'product' && <button className="btn primary" onClick={() => void next()} disabled={busy}>{busy ? 'Checking…' : 'Continue'}</button>}
          </span>
        </div>
      </div>
    </div>
  );
}
