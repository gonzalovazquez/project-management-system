/**
 * The product model shared by the main process and the interface: products with an objective and
 * optional KPIs, and links from a product to items in the three connected repos. The mapping lives
 * only in the local SQLite database (src/main/products/db.ts); nothing here is written to the repos.
 * See docs/decisions/product-model.md.
 */
import type { RepoRole } from './ipc.js';

export const ARTIFACT_TYPES = ['problem-brief', 'solution-brief', 'specification', 'control-book', 'exec-comm', 'other'] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
export const ARTIFACT_TYPE_LABEL: Record<ArtifactType, string> = {
  'problem-brief': 'Problem brief',
  'solution-brief': 'Solution brief',
  specification: 'Specification',
  'control-book': 'Control book',
  'exec-comm': 'Executive communication',
  other: 'Other artifact',
};

/**
 * What a link points at. Which kinds a role allows is fixed: artifacts are files in the artifacts
 * repo; the CRM repo holds one file per customer with dated conversation sections inside it, so a
 * CRM link is either the whole customer file or one section of it; a PDR link is a decision record
 * file or the pull request it is being reviewed in.
 */
export type LinkKind = 'artifact' | 'customer' | 'conversation' | 'decision';
export const KINDS_FOR_ROLE: Record<RepoRole, LinkKind[]> = {
  artifacts: ['artifact'],
  crm: ['customer', 'conversation'],
  pdr: ['decision'],
};

/** A link's target. `path` for files, `anchor` (a section slug) for a conversation, `prNumber` for a pull request. */
export interface LinkTarget {
  path?: string;
  anchor?: string;
  prNumber?: number;
}

/** What the interface sends to add a link. The repo is the one assigned to `role` at the time. */
export interface LinkInput extends LinkTarget {
  role: RepoRole;
  kind: LinkKind;
  title: string;
  artifactType?: ArtifactType;
  /** Blob SHA of the file when it was linked, so a later move with unchanged content can be found again. */
  blobSha?: string;
}

/** The link health last seen on GitHub. 'unchecked' until the first check after linking. */
export type LinkHealth =
  | { state: 'ok'; checkedAt: string }
  | { state: 'broken'; checkedAt: string; reason: string; movedTo?: string }
  | { state: 'unchecked' };

export interface Link extends LinkTarget {
  id: string;
  productId: string;
  role: RepoRole;
  kind: LinkKind;
  repoHost: string;
  repoFullName: string;
  title: string;
  artifactType?: ArtifactType;
  blobSha?: string;
  /** Reserved for Phase 3's workflow board: the stage the PM placed this item in, and since when. */
  stage?: string;
  stageEnteredAt?: string;
  health: LinkHealth;
  createdAt: string;
}

export interface Kpi {
  name: string;
  target: string;
}

export interface Product {
  id: string;
  name: string;
  objective: string;
  kpis: Kpi[];
  createdAt: string;
  updatedAt: string;
}

export interface ProductSummary {
  id: string;
  name: string;
  objective: string;
  linkCount: number;
  brokenCount: number;
}

export interface ProductInput {
  name: string;
  objective: string;
  kpis: Kpi[];
}

export interface ProductHome {
  product: Product;
  links: Link[];
}

export interface PullSummary {
  number: number;
  title: string;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  author: string;
  updatedAt: string;
}

export interface PullDetail extends PullSummary {
  body: string;
  htmlUrl: string;
  baseRef: string;
  headRef: string;
}

export interface AddLinksResult {
  added: number;
  /** Already linked to this product. */
  duplicates: number;
}

export interface ImportReport {
  productId: string;
  productName: string;
  imported: number;
  /** Links that could not be matched to a connected repo on this machine, with why. */
  unresolved: { title: string; repo: string; reason: string }[];
}

export type FileDialogResult<T> = { cancelled: true } | ({ cancelled: false } & T);

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

/** A first guess at an artifact's type from where it sits in the repo. The PM can always change it. */
export function suggestArtifactType(path: string): ArtifactType {
  const p = path.toLowerCase();
  if (/(^|\/)control[-_ ]?books?\//.test(p) || /control[-_ ]?book/.test(p)) return 'control-book';
  if (/(^|\/)exec[-_ ]?comms?\//.test(p) || /exec(utive)?[-_ ]?(comm|update)/.test(p)) return 'exec-comm';
  if (/problem[-_ ]?brief/.test(p)) return 'problem-brief';
  if (/solution[-_ ]?brief/.test(p)) return 'solution-brief';
  if (/(^|\/)specs?\//.test(p) || /spec(ification)?[-_]/.test(p)) return 'specification';
  return 'other';
}

/** GitHub-style heading slug: lowercase, punctuation dropped, spaces to dashes. */
export function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

export interface Section {
  heading: string;
  anchor: string;
  /** Markdown under the heading, up to the next heading of the same or a higher level. */
  body: string;
}

/**
 * The `##` sections of a Markdown file, which is how the CRM repo stores dated conversations
 * inside a customer file. Headings inside fenced code are ignored; repeated slugs get GitHub's
 * `-1`, `-2` suffixes so every anchor is unique within the file.
 */
export function markdownSections(markdown: string, level = 2): Section[] {
  const lines = markdown.split(/\r?\n/);
  const out: Section[] = [];
  const seen = new Map<string, number>();
  let fence = false;
  let current: { heading: string; anchor: string; start: number } | undefined;
  const close = (end: number) => {
    if (current) out.push({ heading: current.heading, anchor: current.anchor, body: lines.slice(current.start, end).join('\n').trim() });
  };
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) return;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) return;
    const depth = m[1].length;
    if (depth > level) return;
    close(i);
    current = undefined;
    if (depth !== level) return;
    const base = slugify(m[2]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    current = { heading: m[2], anchor: n ? `${base}-${n}` : base, start: i + 1 };
  });
  close(lines.length);
  return out;
}

/** Groups a product's links the way the product home shows them. */
export function groupLinks(links: Link[]) {
  const byTitle = (a: Link, b: Link) => a.title.localeCompare(b.title);
  const artifacts = new Map<ArtifactType, Link[]>();
  for (const l of links.filter((x) => x.kind === 'artifact').sort(byTitle)) {
    const t = l.artifactType ?? 'other';
    artifacts.set(t, [...(artifacts.get(t) ?? []), l]);
  }
  // Conversations sit under their customer file; a conversation whose customer isn't linked on its own still shows, under its file.
  const customers = new Map<string, { customer?: Link; conversations: Link[] }>();
  for (const l of links.filter((x) => x.kind === 'customer' || x.kind === 'conversation')) {
    const key = `${l.repoFullName}:${l.path ?? ''}`;
    const entry = customers.get(key) ?? { conversations: [] };
    if (l.kind === 'customer') entry.customer = l; else entry.conversations.push(l);
    customers.set(key, entry);
  }
  return {
    artifacts: ARTIFACT_TYPES.filter((t) => artifacts.has(t)).map((type) => ({ type, links: artifacts.get(type)! })),
    customers: [...customers.entries()]
      .map(([key, v]) => ({ key, path: key.split(':').slice(1).join(':'), ...v, conversations: v.conversations.sort(byTitle) }))
      .sort((a, b) => (a.customer?.title ?? a.path).localeCompare(b.customer?.title ?? b.path)),
    decisions: links.filter((x) => x.kind === 'decision').sort(byTitle),
  };
}

/** Where a link points, for display: "path#anchor" or "PR #12". */
export function describeTarget(l: LinkTarget): string {
  if (l.prNumber !== undefined) return `Pull request #${l.prNumber}`;
  return l.anchor ? `${l.path}#${l.anchor}` : l.path ?? '';
}
