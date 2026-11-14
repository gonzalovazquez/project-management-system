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

/** A dated conversation logged under a customer in the CRM repo (Phase 4b). */
export interface LogConversationDraft {
  kind: 'log-conversation';
  productId: string;
  /** An existing customer file, or a new one to create with `customerName`. */
  customerPath: string;
  customerName?: string;
  /** YYYY-MM-DD */
  date: string;
  topic: string;
  participants: string;
  notes: string;
  description?: string;
  stage?: WorkflowStage | null;
}

/** A new product decision record in the PDR repo (Phase 4b). */
export interface CreatePdrDraft {
  kind: 'create-pdr';
  productId: string;
  path: string;
  title: string;
  content: string;
  description?: string;
  /** The PDR repo's branch convention, as the PM confirmed it. Saved for next time. */
  convention: BranchConvention;
}

export type WriteDraft = CreateArtifactDraft | EditArtifactDraft | LogConversationDraft | CreatePdrDraft;

/** How a repo names its pull-request branches and where they merge into, e.g. git-flow's spec/… into develop. */
export interface BranchConvention {
  /** Branch-name prefix the app uses for new branches, ending in "/", e.g. "spec/". */
  prefix: string;
  /** The branch pull requests target, e.g. "develop". */
  base: string;
}

/** What the app learned about a repo's layout, to propose where a new record goes. */
export interface CrmLayout {
  /** Folder holding one file per customer. */
  folder: string;
  customers: { path: string; name: string }[];
  /** How existing conversation headings separate date and topic, e.g. " — ". */
  separator: string;
}

export interface PdrLayout {
  folder: string;
  /** e.g. "spec-" for spec-003-…md; the next number continues the sequence. */
  numberPrefix?: string;
  nextNumber?: number;
  numberWidth?: number;
  /** A template found in the repo, or undefined to start from a minimal structure the PM confirms. */
  template?: { path: string; content: string };
  /** What the repo's branches and pull requests suggest. */
  detected: BranchConvention & { evidence: string };
  /** What the PM confirmed before, if they did. */
  confirmed?: BranchConvention;
}

/** An app-opened pull request with its live review state, for the "my open pull requests" view. */
export interface AppPullStatus extends AppPull {
  status?: import('./products.js').PullStatus;
  reviewers: import('./products.js').Reviewer[];
  unresolvedComments?: number;
  productName?: string;
}

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

// ------------------------------------------------------------------ CRM and PDR layout (Phase 4b)

const SECTION = /^##\s+(\d{4}-\d{2}-\d{2})(\s*[—–-]\s*)(.+)$/m;

/**
 * Finds the folder of customer files: the one whose Markdown files most often carry dated
 * "## YYYY-MM-DD — topic" sections, and the separator they use. Falls back to a "customers" folder.
 */
export function detectCrmLayout(files: { path: string; content: string }[]): CrmLayout {
  const score = new Map<string, number>();
  const seps = new Map<string, number>();
  for (const f of files) {
    if (!/\.md$/i.test(f.path) || /(^|\/)readme\.md$/i.test(f.path)) continue;
    const m = SECTION.exec(f.content);
    if (!m) continue;
    const dir = dirname(f.path);
    score.set(dir, (score.get(dir) ?? 0) + 1);
    seps.set(m[2], (seps.get(m[2]) ?? 0) + 1);
  }
  const folder = [...score.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'customers';
  const separator = [...seps.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ' — ';
  const customers = files
    .filter((f) => dirname(f.path) === folder && /\.md$/i.test(f.path) && !/readme\.md$/i.test(f.path))
    .map((f) => ({ path: f.path, name: /^#\s+(.+)$/m.exec(f.content)?.[1]?.trim() ?? f.path.split('/').pop()!.replace(/\.md$/i, '') }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { folder, customers, separator };
}

/** The conversation's heading text, in the repo's own style. */
export const conversationHeading = (date: string, topic: string, separator = ' — ') => `${date}${separator}${topic.trim()}`;

/** A conversation section appended to a customer file (or the start of a new one). */
export function appendConversation(existing: string | null, d: { customerName?: string; date: string; topic: string; participants: string; notes: string }, separator = ' — '): string {
  const section = [
    `## ${conversationHeading(d.date, d.topic, separator)}`,
    ...(d.participants.trim() ? [`**Participants:** ${d.participants.trim()}`, ''] : []),
    d.notes.trim(),
  ].join('\n');
  if (existing === null) return `# ${(d.customerName ?? '').trim()}\n\n${section}\n`;
  return `${existing.replace(/\s*$/, '')}\n\n${section}\n`;
}

/**
 * Where PDRs live and how they're numbered: the folder with the most Markdown records, and a
 * "<prefix>-<NNN>-" naming pattern if the files follow one, so a new record continues the sequence.
 */
export function detectPdrLayout(paths: string[]): Pick<PdrLayout, 'folder' | 'numberPrefix' | 'nextNumber' | 'numberWidth'> {
  const md = paths.filter((p) => /\.md$/i.test(p) && !/(^|\/)readme\.md$/i.test(p) && !/template/i.test(p));
  const counts = new Map<string, number>();
  for (const p of md) counts.set(dirname(p), (counts.get(dirname(p)) ?? 0) + 1);
  const folder = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'pdr';
  const numbered = md.filter((p) => dirname(p) === folder).map((p) => /^([a-z]+-)(\d+)-/i.exec(p.split('/').pop()!)).filter((m): m is RegExpExecArray => !!m);
  if (!numbered.length) return { folder };
  const width = numbered[0][2].length;
  const next = Math.max(...numbered.map((m) => Number(m[2]))) + 1;
  return { folder, numberPrefix: numbered[0][1].toLowerCase(), nextNumber: next, numberWidth: width };
}

export function pdrPath(layout: Pick<PdrLayout, 'folder' | 'numberPrefix' | 'nextNumber' | 'numberWidth'>, title: string): string {
  let slug = title.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-').slice(0, 50) || 'decision';
  const num = layout.numberPrefix && layout.nextNumber !== undefined ? `${layout.numberPrefix}${String(layout.nextNumber).padStart(layout.numberWidth ?? 3, '0')}-` : '';
  // A title that already carries the number ("SPEC-004: Retry limits") shouldn't repeat it in the file name.
  if (layout.numberPrefix) slug = slug.replace(new RegExp(`^${layout.numberPrefix.replace(/[-]/g, '\\-')}\\d+-?`), '') || 'decision';
  return `${layout.folder ? `${layout.folder}/` : ''}${num}${slug}.md`;
}

/**
 * The branch convention a repo's history suggests: the most common "prefix/" among its branches
 * and pull-request heads, and the most common base its pull requests target. With no history, a
 * develop branch means git-flow (target develop), and the prefix comes from the records folder
 * ("specs" → "spec/").
 */
export function suggestConvention(input: { branches: string[]; pulls: { head: string; base: string }[]; defaultBranch: string; folder: string }): BranchConvention & { evidence: string } {
  const prefixes = new Map<string, number>();
  for (const h of [...input.branches, ...input.pulls.map((p) => p.head)]) {
    const m = /^([^/]+\/)/.exec(h);
    if (m && !/^(pmworkbench|dependabot|renovate|release|hotfix)\/$/.test(m[1])) prefixes.set(m[1], (prefixes.get(m[1]) ?? 0) + 1);
  }
  const bases = new Map<string, number>();
  for (const p of input.pulls) bases.set(p.base, (bases.get(p.base) ?? 0) + 1);
  const topPrefix = [...prefixes.entries()].sort((a, b) => b[1] - a[1])[0];
  const topBase = [...bases.entries()].sort((a, b) => b[1] - a[1])[0];
  const hasDevelop = input.branches.includes('develop');
  const base = topBase?.[0] ?? (hasDevelop ? 'develop' : input.defaultBranch);
  const folderWord = input.folder.split('/').pop()!.replace(/s$/, '') || 'pdr';
  const prefix = topPrefix?.[0] ?? `${folderWord}/`;
  const evidence = [
    topBase ? `${topBase[1]} pull request${topBase[1] === 1 ? '' : 's'} target ${topBase[0]}` : hasDevelop ? 'a develop branch exists (git-flow)' : `no develop branch, so ${input.defaultBranch}`,
    topPrefix ? `${topPrefix[1]} branch${topPrefix[1] === 1 ? '' : 'es'} start with ${topPrefix[0]}` : `no branch history, so ${prefix} from the ${input.folder || 'repo'} folder`,
  ].join('; ');
  return { prefix, base, evidence };
}
