import type { RepoRole, TreeEntry } from '../../../shared/ipc.js';
import { suggestArtifactType, suggestStage, type ArtifactType, type LinkInput, type PullSummary, type Section, type WorkflowStage } from '../../../shared/products.js';

/**
 * The link picker's selection: what the PM has ticked across the three repos, keyed so the same
 * item can't be picked twice. Pure so it can be tested without rendering.
 */
export type Selection = Map<string, LinkInput>;

export const keyOf = (l: Pick<LinkInput, 'role' | 'kind' | 'path' | 'anchor' | 'prNumber'>): string =>
  `${l.role}|${l.kind}|${l.path ?? ''}|${l.anchor ?? ''}|${l.prNumber ?? ''}`;

const titleFromPath = (path: string) => path.split('/').pop()!.replace(/\.(md|markdown|txt)$/i, '');

/** Pre-fills the suggested stage, which the PM can change before linking (or clear to leave it unstaged). */
const withStage = (l: LinkInput): LinkInput => {
  const stage = suggestStage(l);
  return stage ? { ...l, stage } : l;
};

/** The link a ticked file becomes, by role: an artifact (with a suggested type), a customer, or a decision record. */
export function fileToLink(role: RepoRole, entry: Pick<TreeEntry, 'path' | 'sha'>): LinkInput {
  const base = { role, path: entry.path, title: titleFromPath(entry.path), blobSha: entry.sha || undefined };
  if (role === 'artifacts') return withStage({ ...base, kind: 'artifact', artifactType: suggestArtifactType(entry.path) });
  if (role === 'crm') return withStage({ ...base, kind: 'customer' });
  return withStage({ ...base, kind: 'decision' });
}

export const sectionToLink = (path: string, sha: string, s: Section): LinkInput =>
  withStage({ role: 'crm', kind: 'conversation', path, anchor: s.anchor, title: s.heading, blobSha: sha || undefined });

export const pullToLink = (p: PullSummary): LinkInput =>
  withStage({ role: 'pdr', kind: 'decision', prNumber: p.number, title: `#${p.number} ${p.title}` });

export function setStage(sel: Selection, key: string, stage: WorkflowStage | undefined): Selection {
  const cur = sel.get(key);
  if (!cur) return sel;
  const { stage: _old, ...rest } = cur;
  return new Map(sel).set(key, stage ? { ...rest, stage } : rest);
}

export function toggle(sel: Selection, link: LinkInput): Selection {
  const next = new Map(sel);
  const k = keyOf(link);
  if (next.has(k)) next.delete(k); else next.set(k, link);
  return next;
}

export function setType(sel: Selection, key: string, artifactType: ArtifactType): Selection {
  const cur = sel.get(key);
  if (!cur || cur.kind !== 'artifact') return sel;
  // A stage the PM hasn't touched follows the new type's suggestion.
  const followed = cur.stage === suggestStage(cur);
  const next: LinkInput = { ...cur, artifactType };
  if (followed) {
    const s = suggestStage(next);
    if (s) next.stage = s; else delete next.stage;
  }
  return new Map(sel).set(key, next);
}

/** Leaves out anything the product already links, so the picker can show those as already linked. */
export function linkable(sel: Selection, alreadyLinked: Set<string>): LinkInput[] {
  return [...sel.values()].filter((l) => !alreadyLinked.has(keyOf(l)));
}
