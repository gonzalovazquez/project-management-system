import type { RepoRole, TreeEntry } from '../../../shared/ipc.js';
import { suggestArtifactType, type ArtifactType, type LinkInput, type PullSummary, type Section } from '../../../shared/products.js';

/**
 * The link picker's selection: what the PM has ticked across the three repos, keyed so the same
 * item can't be picked twice. Pure so it can be tested without rendering.
 */
export type Selection = Map<string, LinkInput>;

export const keyOf = (l: Pick<LinkInput, 'role' | 'kind' | 'path' | 'anchor' | 'prNumber'>): string =>
  `${l.role}|${l.kind}|${l.path ?? ''}|${l.anchor ?? ''}|${l.prNumber ?? ''}`;

const titleFromPath = (path: string) => path.split('/').pop()!.replace(/\.(md|markdown|txt)$/i, '');

/** The link a ticked file becomes, by role: an artifact (with a suggested type), a customer, or a decision record. */
export function fileToLink(role: RepoRole, entry: Pick<TreeEntry, 'path' | 'sha'>): LinkInput {
  const base = { role, path: entry.path, title: titleFromPath(entry.path), blobSha: entry.sha || undefined };
  if (role === 'artifacts') return { ...base, kind: 'artifact', artifactType: suggestArtifactType(entry.path) };
  if (role === 'crm') return { ...base, kind: 'customer' };
  return { ...base, kind: 'decision' };
}

export const sectionToLink = (path: string, sha: string, s: Section): LinkInput =>
  ({ role: 'crm', kind: 'conversation', path, anchor: s.anchor, title: s.heading, blobSha: sha || undefined });

export const pullToLink = (p: PullSummary): LinkInput =>
  ({ role: 'pdr', kind: 'decision', prNumber: p.number, title: `#${p.number} ${p.title}` });

export function toggle(sel: Selection, link: LinkInput): Selection {
  const next = new Map(sel);
  const k = keyOf(link);
  if (next.has(k)) next.delete(k); else next.set(k, link);
  return next;
}

export function setType(sel: Selection, key: string, artifactType: ArtifactType): Selection {
  const cur = sel.get(key);
  if (!cur || cur.kind !== 'artifact') return sel;
  return new Map(sel).set(key, { ...cur, artifactType });
}

/** Leaves out anything the product already links, so the picker can show those as already linked. */
export function linkable(sel: Selection, alreadyLinked: Set<string>): LinkInput[] {
  return [...sel.values()].filter((l) => !alreadyLinked.has(keyOf(l)));
}
