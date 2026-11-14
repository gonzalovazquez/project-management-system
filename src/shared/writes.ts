/**
 * Write-back (Phase 4): every change the app makes to a repo is a branch plus a pull request, built
 * by one engine in the main process (src/main/write/engine.ts). The PM sees a preview of exactly
 * what will be sent and confirms it; nothing is written before that. See docs/decisions/write-back.md.
 */
import type { RepoRole } from './ipc.js';
import type { ArtifactType, WorkflowStage } from './products.js';

/** A new artifact for a product, from a template or blank. */
export interface CreateArtifactDraft {
  kind: 'create-artifact';
  productId: string;
  artifactType: ArtifactType;
  /** Destination in the artifacts repo; must not exist yet. */
  path: string;
  title: string;
  content: string;
  /** Pull request description. Optional; the app adds a footer naming the product. */
  description?: string;
  /** The board stage to place it in; defaults to the suggestion for its type. */
  stage?: WorkflowStage | null;
}

/** New content for a file already linked to a product. */
export interface EditArtifactDraft {
  kind: 'edit-artifact';
  linkId: string;
  content: string;
  description?: string;
}

export type WriteDraft = CreateArtifactDraft | EditArtifactDraft;

export interface FileDiff {
  path: string;
  change: 'create' | 'update';
  /** Unified diff against the file as it is on the branch the commit will sit on top of. */
  diff: string;
  added: number;
  removed: number;
}

export interface WritePreview {
  /** Pass to confirmWrite. Valid for a few minutes and only once. */
  id: string;
  role: RepoRole;
  repo: string;
  base: string;
  branch: string;
  /** Set when the change will be added as a commit to a pull request the app already opened. */
  existingPr?: { number: number; url: string };
  files: FileDiff[];
  commitMessage: string;
  title: string;
  body: string;
}

export interface WriteResult {
  prNumber: number;
  prUrl: string;
  branch: string;
  addedToExisting: boolean;
  /** The product link created or updated for the item. */
  linkId?: string;
}

/** What the editor starts from when editing a linked file. */
export interface EditSource {
  path: string;
  content: string;
  /** Where the content came from: the default branch, or the branch of an open app pull request touching the file. */
  from: 'default-branch' | 'pull-request';
  pr?: { number: number; url: string; branch: string };
}

/** A branch and pull request the app opened. */
export interface AppPull {
  id: string;
  productId?: string;
  role: RepoRole;
  repo: string;
  base: string;
  branch: string;
  prNumber?: number;
  prUrl?: string;
  title: string;
  paths: string[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

const DEFAULT_FOLDER: Record<ArtifactType, string> = {
  'problem-brief': 'problem-briefs', 'solution-brief': 'solution-briefs', specification: 'specs',
  'control-book': 'control-book', 'exec-comm': 'exec-comms', other: '',
};

const dirname = (p: string) => p.split('/').slice(0, -1).join('/');

/**
 * Where a new artifact should go, as a suggestion the PM edits: the folder most of this type's
 * linked artifacts already sit in; else a top-level folder whose name says it holds this type;
 * else a conventional folder name. The file name comes from the title.
 */
export function suggestDestination(type: ArtifactType, title: string, opts: { existingPaths: string[]; rootFolders: string[]; typeOf: (path: string) => ArtifactType }): string {
  const counts = new Map<string, number>();
  for (const p of opts.existingPaths) counts.set(dirname(p), (counts.get(dirname(p)) ?? 0) + 1);
  const fromLinks = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const fromRepo = opts.rootFolders.find((d) => opts.typeOf(`${d}/x.md`) === type);
  const folder = fromLinks ?? fromRepo ?? DEFAULT_FOLDER[type];
  const file = `${title.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'untitled'}.md`;
  return folder ? `${folder}/${file}` : file;
}

/** Fills the simple placeholders a template might use. Unknown placeholders are left as they are. */
export function fillTemplate(template: string, values: { title: string; product: string; date: string }): string {
  return template
    .replace(/\{\{\s*title\s*\}\}/gi, values.title)
    .replace(/\{\{\s*product\s*\}\}/gi, values.product)
    .replace(/\{\{\s*date\s*\}\}/gi, values.date);
}
