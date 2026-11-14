import { REPO_ROLES, type RepoRole } from '../../shared/ipc.js';
import { ARTIFACT_TYPES, isStage, KINDS_FOR_ROLE, type ArtifactType, type LinkInput, type LinkKind, type ProductInput } from '../../shared/products.js';
import type { LinkPatch } from './store.js';

/**
 * Everything arriving over IPC is untrusted shape-wise, even from our own trusted window, so the
 * service checks it here before it reaches SQL. Each validator returns the cleaned value or a
 * message for the PM.
 */
type V<T> = { ok: true; value: T } | { ok: false; message: string };
const good = <T>(value: T): V<T> => ({ ok: true, value });
const bad = (message: string): V<never> => ({ ok: false, message });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const isId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
export const isRole = (v: unknown): v is RepoRole => REPO_ROLES.includes(v as RepoRole);
export const isPrNumber = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0 && (v as number) < 1e9;

/** A repo-relative path: no leading slash, no `..` segments, no NULs. */
export const isRepoPath = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 1024 && !v.startsWith('/') && !v.includes('\0') && !v.split('/').some((s) => s === '..' || s === '');

export function validateProductInput(v: unknown): V<ProductInput> {
  if (!isObj(v)) return bad('Product details are missing.');
  const name = typeof v.name === 'string' ? v.name.trim() : '';
  if (!name) return bad('Give the product a name.');
  if (name.length > 200) return bad('Keep the product name under 200 characters.');
  const objective = typeof v.objective === 'string' ? v.objective.trim() : '';
  if (objective.length > 10_000) return bad('The objective is too long.');
  if (v.kpis !== undefined && !Array.isArray(v.kpis)) return bad('KPIs must be a list.');
  const kpis = [];
  for (const k of (v.kpis as unknown[] | undefined) ?? []) {
    if (!isObj(k) || typeof k.name !== 'string' || (k.target !== undefined && typeof k.target !== 'string')) return bad('A KPI is malformed.');
    const kn = k.name.trim();
    const kt = typeof k.target === 'string' ? k.target.trim() : '';
    if (!kn && !kt) continue; // blank rows in the form are dropped, not an error
    if (!kn) return bad('Every KPI needs a name.');
    if (kn.length > 200 || kt.length > 500) return bad('A KPI is too long.');
    kpis.push({ name: kn, target: kt });
  }
  if (kpis.length > 50) return bad('Keep it to 50 KPIs or fewer.');
  return good({ name, objective, kpis });
}

export function validateLinkInput(v: unknown): V<LinkInput> {
  if (!isObj(v)) return bad('Link details are missing.');
  if (!isRole(v.role)) return bad('Unknown repo role.');
  if (!KINDS_FOR_ROLE[v.role].includes(v.kind as LinkKind)) return bad(`A ${String(v.kind)} link can't come from the ${v.role} repo.`);
  const kind = v.kind as LinkKind;
  const title = typeof v.title === 'string' ? v.title.trim().slice(0, 500) : '';
  if (!title) return bad('A link needs a title.');
  const out: LinkInput = { role: v.role, kind, title };
  if (v.path !== undefined) { if (!isRepoPath(v.path)) return bad('That file path is not valid.'); out.path = v.path; }
  if (v.anchor !== undefined) { if (typeof v.anchor !== 'string' || !v.anchor || v.anchor.length > 500) return bad('That section is not valid.'); out.anchor = v.anchor; }
  if (v.prNumber !== undefined) { if (!isPrNumber(v.prNumber)) return bad('That pull request number is not valid.'); out.prNumber = v.prNumber; }
  if (v.blobSha !== undefined) { if (typeof v.blobSha !== 'string' || !/^[0-9a-f]{40,64}$/.test(v.blobSha)) return bad('Bad file reference.'); out.blobSha = v.blobSha; }
  if (v.artifactType !== undefined) { if (!ARTIFACT_TYPES.includes(v.artifactType as ArtifactType)) return bad('Unknown artifact type.'); out.artifactType = v.artifactType as ArtifactType; }
  if (v.stage !== undefined) { if (!isStage(v.stage)) return bad('Unknown stage.'); out.stage = v.stage; }

  if (out.path === undefined && out.prNumber === undefined) return bad('A link needs a file or a pull request.');
  if (out.path !== undefined && out.prNumber !== undefined) return bad('A link points at a file or a pull request, not both.');
  if (out.prNumber !== undefined && kind !== 'decision') return bad('Only decision records can be pull requests.');
  if (kind === 'conversation' && (!out.anchor || !out.path)) return bad('Pick the conversation section within a customer file.');
  if (kind !== 'conversation' && out.anchor !== undefined) return bad('Only a conversation points at a section.');
  if (kind === 'artifact') out.artifactType ??= 'other';
  else if (out.artifactType !== undefined) return bad('Only artifacts have an artifact type.');
  return good(out);
}

/** A relink or relabel. The link's kind and repo never change; pick a new target within them. */
export function validateLinkPatch(v: unknown): V<LinkPatch> {
  if (!isObj(v)) return bad('Nothing to change.');
  const out: LinkPatch = {};
  if (v.path !== undefined) { if (!isRepoPath(v.path)) return bad('That file path is not valid.'); out.path = v.path; }
  if (v.anchor !== undefined) { if (v.anchor !== null && (typeof v.anchor !== 'string' || !v.anchor || v.anchor.length > 500)) return bad('That section is not valid.'); out.anchor = v.anchor as string | null; }
  if (v.prNumber !== undefined) { if (v.prNumber !== null && !isPrNumber(v.prNumber)) return bad('That pull request number is not valid.'); out.prNumber = v.prNumber as number | null; }
  if (v.title !== undefined) { if (typeof v.title !== 'string' || !v.title.trim()) return bad('A link needs a title.'); out.title = v.title.trim().slice(0, 500); }
  if (v.artifactType !== undefined) { if (!ARTIFACT_TYPES.includes(v.artifactType as ArtifactType)) return bad('Unknown artifact type.'); out.artifactType = v.artifactType as ArtifactType; }
  if (v.blobSha !== undefined) { if (v.blobSha !== null && (typeof v.blobSha !== 'string' || !/^[0-9a-f]{40,64}$/.test(v.blobSha))) return bad('Bad file reference.'); out.blobSha = v.blobSha as string | null; }
  return good(out);
}
