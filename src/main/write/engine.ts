import { randomUUID } from 'node:crypto';
import type { RepoRef, RepoRole } from '../../shared/ipc.js';
import { ARTIFACT_TYPE_LABEL, ARTIFACT_TYPES, isStage, slugify, suggestStage, type ArtifactType, type WorkflowStage } from '../../shared/products.js';
import { appendConversation, detectCrmLayout, detectPdrLayout, suggestConvention, type AppPull, type BranchConvention, type CrmLayout, type EditSource, type FileDiff, type PdrLayout, type WriteDraft, type WritePreview, type WriteResult } from '../../shared/writes.js';
import { markdownSections } from '../../shared/products.js';
import type { GitHubClient } from '../github/client.js';
import type { NewLink, ProductStore } from '../products/store.js';
import { isId, isRepoPath } from '../products/validate.js';
import { unifiedDiff } from './diff.js';
import { APP_BRANCH_PREFIX, assertWritableBranch, WriteBlockedError, type WriteGuardOptions } from './guard.js';

/**
 * The one write path. Every change the app makes to a repo goes through here as:
 *
 *   preview  — read what's there now, work out the branch, the diff, the commit and the pull
 *              request, and hold that plan in the main process under a single-use id;
 *   confirm  — re-check nothing moved underneath, then: one commit on top of the base (or on top
 *              of the app's existing pull-request branch), a new branch pointing at it, and a pull
 *              request. If any step after the branch exists fails, the branch is deleted again.
 *
 * Nothing reaches GitHub between the two, and the window can't change the plan after seeing it:
 * confirm takes only the id. Commits only ever land on branches under `pmworkbench/`, checked
 * here and again by the network write guard (guard.ts), so nothing can reach a default branch.
 */

const PREVIEW_TTL_MS = 10 * 60_000;
const MAX_FILE_BYTES = 1_000_000;

export class WriteError extends Error {
  constructor(public code: 'invalid' | 'not-found' | 'stale' | 'collision' | 'permission' | 'protected' | 'network', message: string) {
    super(message);
    this.name = 'WriteError';
  }
}

interface Plan {
  preview: WritePreview;
  repo: RepoRef;
  role: RepoRole;
  /** The commit the new commit goes on top of: the base head, or the existing PR branch head. */
  parent: string;
  /** The blob SHA each path had on the parent when previewed (null = must not exist). */
  expect: Record<string, string | null>;
  files: { path: string; content: string }[];
  existing?: AppPull;
  productId?: string;
  /** Items to link to the product once the pull request exists (pending until it merges), or the link being edited. */
  link?: { create: Omit<NewLink, 'pending'>[] } | { linkId: string };
  /** A branch convention to remember for this repo once the write succeeds. */
  saveConvention?: BranchConvention;
  expiresAt: number;
}

export interface EngineDeps {
  client: () => GitHubClient;
  products: ProductStore;
  host: () => string;
  roles: () => Promise<Partial<Record<RepoRole, RepoRef>>>;
  guard: WriteGuardOptions;
  now?: () => Date;
  /** Stores a branch convention the PM confirmed for a repo. */
  saveConvention?: (repoFullName: string, c: BranchConvention) => Promise<void>;
  /** The convention the PM confirmed before for a repo, if any. */
  convention?: (repoFullName: string) => Promise<BranchConvention | undefined>;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const status = (e: unknown) => (e as { status?: number }).status;

/** Turns a GitHub failure into something a PM can act on. */
export function explain(e: unknown, repo: string, branch: string): WriteError {
  if (e instanceof WriteError) return e;
  // Octokit wraps whatever its fetch throws, so a guard refusal arrives as the cause of an HttpError.
  const blocked = e instanceof WriteBlockedError ? e : (e as { cause?: unknown }).cause instanceof WriteBlockedError ? (e as { cause: WriteBlockedError }).cause : undefined;
  if (blocked) return new WriteError('protected', blocked.message);
  const s = status(e);
  const text = msg(e);
  if (s === 401) return new WriteError('permission', 'GitHub rejected the token. Sign in again in Settings.');
  if (s === 403 || s === 404) return new WriteError('permission', `Your token can't write to ${repo}. It needs read and write access to the repo's contents and pull requests.`);
  if (s === 422 && /already exists/i.test(text)) return new WriteError('collision', `A branch named ${branch} already exists in ${repo}. Preview again to get a fresh name.`);
  if (s === 422 && /protected|status check|review/i.test(text)) return new WriteError('protected', `${repo} refused the change because of a branch protection rule: ${text}`);
  if (s === 422 && /fast forward|not a fast/i.test(text)) return new WriteError('stale', `The branch ${branch} moved on GitHub since the preview. Preview again.`);
  if (s === 409) return new WriteError('stale', `${repo} changed while the write was in progress. Preview again.`);
  return new WriteError('network', `Couldn't write to ${repo}: ${text}`);
}

export class WriteEngine {
  private plans = new Map<string, Plan>();

  constructor(private d: EngineDeps) {}

  private now() {
    return this.d.now?.() ?? new Date();
  }

  private async repoFor(role: RepoRole): Promise<RepoRef> {
    const r = (await this.d.roles())[role];
    if (!r) throw new WriteError('invalid', `No repo is assigned to the ${role} role.`);
    return r;
  }

  /** A branch name under the app prefix that doesn't exist yet in the repo. */
  private async freshBranch(repo: RepoRef, stem: string, prefix = APP_BRANCH_PREFIX, dated = true): Promise<string> {
    const day = this.now().toISOString().slice(0, 10).replace(/-/g, '');
    const base = `${prefix}${stem}${dated ? `-${day}` : ''}`.replace(/[^A-Za-z0-9/_.-]+/g, '-').replace(/-+/g, '-');
    const c = this.d.client();
    for (let n = 1; n <= 20; n++) {
      const name = n === 1 ? base : `${base}-${n}`;
      if ((await c.branchHead(repo, name)) === null) return name;
    }
    throw new WriteError('collision', `Too many branches named ${base}-* already exist in ${repo.fullName}.`);
  }

  /** An open pull request the app opened in this repo whose branch already touches `path`. */
  private async openAppPullFor(repo: RepoRef, path: string): Promise<AppPull | undefined> {
    for (const w of this.d.products.writesTouching(repo.fullName, path)) {
      if (w.prNumber === undefined) continue;
      const pr = await this.d.client().getPull(repo, w.prNumber);
      if (pr && pr.state === 'open' && !pr.merged && pr.headRef === w.branch) return w;
    }
    return undefined;
  }

  /** What to start editing from: the open app pull request touching the file if there is one, else the default branch. */
  async editSource(linkId: unknown): Promise<EditSource> {
    if (!isId(linkId)) throw new WriteError('invalid', 'Unknown link.');
    const link = this.d.products.getLink(linkId);
    if (!link) throw new WriteError('not-found', 'That link no longer exists.');
    if (link.kind !== 'artifact' || !link.path) throw new WriteError('invalid', 'Only linked artifact files can be edited here.');
    const repo = await this.repoFor(link.role);
    if (repo.fullName.toLowerCase() !== link.repoFullName.toLowerCase()) throw new WriteError('invalid', `This link points at ${link.repoFullName}, which is no longer the ${link.role} repo.`);
    const c = this.d.client();
    const open = await this.openAppPullFor(repo, link.path);
    const ref = open?.branch ?? link.pending?.branch ?? repo.defaultBranch;
    const file = await c.fileAt(repo, link.path, ref);
    if (!file) throw new WriteError('not-found', `${link.path} isn't on ${ref}.`);
    return {
      path: link.path, content: file.content, from: open || link.pending ? 'pull-request' : 'default-branch',
      ...(open?.prNumber ? { pr: { number: open.prNumber, url: open.prUrl ?? '', branch: open.branch } } : {}),
    };
  }

  async preview(draft: unknown): Promise<WritePreview> {
    this.sweep();
    const d = draft as WriteDraft;
    if (!d || typeof d !== 'object') throw new WriteError('invalid', 'Nothing to write.');
    const plan = d.kind === 'create-artifact' ? await this.planCreate(d)
      : d.kind === 'edit-artifact' ? await this.planEdit(d)
      : d.kind === 'log-conversation' ? await this.planConversation(d)
      : d.kind === 'create-pdr' ? await this.planPdr(d)
      : undefined;
    if (!plan) throw new WriteError('invalid', 'Unknown kind of write.');
    this.plans.set(plan.preview.id, plan);
    return plan.preview;
  }

  private checkContent(content: unknown): string {
    if (typeof content !== 'string') throw new WriteError('invalid', 'The content is missing.');
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new WriteError('invalid', 'That file is over 1 MB.');
    return content.endsWith('\n') ? content : `${content}\n`;
  }

  private body(description: unknown, productName: string | undefined, paths: string[]): string {
    const text = typeof description === 'string' ? description.trim().slice(0, 20_000) : '';
    return [
      ...(text ? [text, ''] : []),
      '---',
      `Opened from PM Workbench${productName ? ` for the product **${productName}**` : ''}.`,
      `Files: ${paths.map((p) => `\`${p}\``).join(', ')}`,
    ].join('\n');
  }

  private async planCreate(d: Extract<WriteDraft, { kind: 'create-artifact' }>): Promise<Plan> {
    if (!isId(d.productId)) throw new WriteError('invalid', 'Pick a product.');
    const product = this.d.products.getProduct(d.productId);
    if (!product) throw new WriteError('not-found', 'That product no longer exists.');
    if (!ARTIFACT_TYPES.includes(d.artifactType)) throw new WriteError('invalid', 'Pick an artifact type.');
    if (!isRepoPath(d.path) || !/\.(md|markdown)$/i.test(d.path)) throw new WriteError('invalid', 'The destination must be a Markdown file path inside the repo, like control-book/new-flow.md.');
    const title = typeof d.title === 'string' ? d.title.trim().slice(0, 200) : '';
    if (!title) throw new WriteError('invalid', 'Give the artifact a title.');
    if (d.stage !== undefined && d.stage !== null && !isStage(d.stage)) throw new WriteError('invalid', 'Unknown stage.');
    const content = this.checkContent(d.content);

    const repo = await this.repoFor('artifacts');
    const c = this.d.client();
    const parent = await c.branchHead(repo, repo.defaultBranch);
    if (!parent) throw new WriteError('not-found', `${repo.fullName} has no ${repo.defaultBranch} branch.`);
    if (await c.fileAt(repo, d.path, repo.defaultBranch)) throw new WriteError('invalid', `${d.path} already exists in ${repo.fullName}. Pick another path, or link and edit the existing file.`);
    const clash = await this.openAppPullFor(repo, d.path);
    if (clash) throw new WriteError('invalid', `Pull request #${clash.prNumber} from PM Workbench already adds ${d.path}. Edit it from there instead.`);

    const branch = await this.freshBranch(repo, `${d.artifactType}/${slugify(title).slice(0, 40) || 'artifact'}`);
    const label = ARTIFACT_TYPE_LABEL[d.artifactType];
    const { diff, added, removed } = unifiedDiff(null, content, d.path);
    const stage: WorkflowStage | undefined = d.stage === null ? undefined : d.stage ?? suggestStage({ kind: 'artifact', artifactType: d.artifactType });
    const preview: WritePreview = {
      id: randomUUID(), role: 'artifacts', repo: repo.fullName, base: repo.defaultBranch, branch,
      files: [{ path: d.path, change: 'create', diff, added, removed }],
      commitMessage: `Add ${label.toLowerCase()}: ${title}`, title: `Add ${label.toLowerCase()}: ${title}`,
      body: this.body(d.description, product.name, [d.path]),
    };
    return {
      preview, repo, role: 'artifacts', parent, expect: { [d.path]: null }, files: [{ path: d.path, content }], productId: product.id,
      link: { create: [{ role: 'artifacts', kind: 'artifact', repoHost: this.d.host(), repoFullName: repo.fullName, path: d.path, title, artifactType: d.artifactType, ...(stage ? { stage } : {}) }] },
      expiresAt: Date.now() + PREVIEW_TTL_MS,
    };
  }

  private async planEdit(d: Extract<WriteDraft, { kind: 'edit-artifact' }>): Promise<Plan> {
    if (!isId(d.linkId)) throw new WriteError('invalid', 'Unknown link.');
    const link = this.d.products.getLink(d.linkId);
    if (!link) throw new WriteError('not-found', 'That link no longer exists.');
    if (link.kind !== 'artifact' || !link.path) throw new WriteError('invalid', 'Only linked artifact files can be edited here.');
    const content = this.checkContent(d.content);
    const repo = await this.repoFor(link.role);
    if (repo.fullName.toLowerCase() !== link.repoFullName.toLowerCase()) throw new WriteError('invalid', `This link points at ${link.repoFullName}, which is no longer the ${link.role} repo.`);
    const c = this.d.client();
    const product = this.d.products.getProduct(link.productId);

    // An open pull request from the app already touching this file gets the new commit, rather than a second PR.
    const existing = await this.openAppPullFor(repo, link.path);
    const onBranch = existing?.branch ?? repo.defaultBranch;
    const parent = await c.branchHead(repo, onBranch);
    if (!parent) throw new WriteError('not-found', `${repo.fullName} has no ${onBranch} branch.`);
    const before = await c.fileAt(repo, link.path, onBranch);
    if (!before) throw new WriteError('not-found', `${link.path} isn't on ${onBranch} any more. Check links, then relink it.`);
    if (before.content === content) throw new WriteError('invalid', 'Nothing changed.');

    const branch = existing?.branch ?? await this.freshBranch(repo, `edit/${slugify(link.path.replace(/\.(md|markdown)$/i, '').split('/').pop()!).slice(0, 40) || 'artifact'}`);
    const { diff, added, removed } = unifiedDiff(before.content, content, link.path);
    const preview: WritePreview = {
      id: randomUUID(), role: link.role, repo: repo.fullName, base: existing?.base ?? repo.defaultBranch, branch,
      ...(existing?.prNumber ? { existingPr: { number: existing.prNumber, url: existing.prUrl ?? '' } } : {}),
      files: [{ path: link.path, change: 'update', diff, added, removed } satisfies FileDiff],
      commitMessage: `Update ${link.title}`, title: existing?.title ?? `Update ${link.title}`,
      body: this.body(d.description, product?.name, [link.path]),
    };
    return {
      preview, repo, role: link.role, parent, expect: { [link.path]: before.sha }, files: [{ path: link.path, content }], existing,
      productId: link.productId, link: { linkId: link.id }, expiresAt: Date.now() + PREVIEW_TTL_MS,
    };
  }

  /** Sends exactly what was previewed. Single use: a second confirm of the same id is refused. */
  async confirm(previewId: unknown): Promise<WriteResult> {
    this.sweep();
    const plan = typeof previewId === 'string' ? this.plans.get(previewId) : undefined;
    if (!plan) throw new WriteError('stale', 'That preview has expired or was already sent. Preview again.');
    this.plans.delete(plan.preview.id);
    const { repo, preview } = plan;
    const branch = preview.branch;
    const c = this.d.client();

    // The engine-level guard; the network guard checks the same again on the way out.
    assertWritableBranch(repo.fullName, branch, this.d.guard, plan.existing ? 'modify' : 'create');
    if (branch === preview.base || branch === repo.defaultBranch) throw new WriteError('protected', 'Refusing to commit to the base branch.');

    let createdBranch = false;
    let inFlight: string | undefined;
    await this.recoverInterrupted();
    try {
      // Stale check: the branch we build on hasn't moved in a way that touches our files.
      const onBranch = plan.existing ? branch : preview.base;
      const head = await c.branchHead(repo, onBranch);
      if (!head) throw new WriteError('stale', `${onBranch} no longer exists in ${repo.fullName}.`);
      if (plan.existing && head !== plan.parent) throw new WriteError('stale', `Pull request #${plan.existing.prNumber}'s branch changed on GitHub since the preview. Preview again.`);
      for (const [path, sha] of Object.entries(plan.expect)) {
        const now = await c.fileAt(repo, path, onBranch);
        if ((now?.sha ?? null) !== sha) {
          throw new WriteError('stale', sha === null ? `${path} was created on ${onBranch} since the preview.` : `${path} changed on ${onBranch} since the preview. Reopen it to see the latest, then preview again.`);
        }
      }

      const commit = await c.commitFiles(repo, head, plan.files, preview.commitMessage);
      if (plan.existing) {
        assertWritableBranch(repo.fullName, branch, this.d.guard, 'modify');
        await c.moveBranch(repo, branch, commit);
        this.d.products.touchWrite(plan.existing.id, plan.files.map((f) => f.path));
        return { prNumber: plan.existing.prNumber!, prUrl: plan.existing.prUrl ?? '', branch, addedToExisting: true, ...this.applyLink(plan, plan.existing.prNumber!) };
      }
      if (this.d.products.writes().some((w) => w.repo.toLowerCase() === repo.fullName.toLowerCase() && w.branch === branch)) {
        throw new WriteError('collision', `A branch named ${branch} already exists in ${repo.fullName}. Preview again to get a fresh name.`);
      }
      // Recorded as in flight before the branch exists, so an interruption from here on (quit,
      // crash, power loss) is finished or cleaned up by recoverInterrupted on the next run.
      inFlight = this.d.products.recordWrite({
        productId: plan.productId, role: plan.role, repoHost: this.d.host(), repo: repo.fullName, base: preview.base, branch,
        title: preview.title, paths: plan.files.map((f) => f.path),
        ...(plan.link && 'create' in plan.link ? { linkPlan: plan.link.create.map((l) => ({ ...l, pending: { prNumber: 0, branch } })) } : {}),
      }).id;
      await c.createBranch(repo, branch, commit);
      createdBranch = true;
      const pr = await c.openPull(repo, { title: preview.title, body: preview.body, head: branch, base: preview.base });
      this.d.products.completeWrite(inFlight, pr.number, pr.url);
      if (plan.saveConvention) await this.d.saveConvention?.(repo.fullName, plan.saveConvention).catch(() => undefined);
      return { prNumber: pr.number, prUrl: pr.url, branch, addedToExisting: false, ...this.applyLink(plan, pr.number) };
    } catch (e) {
      // Leave nothing half-made: a branch without its pull request is removed again.
      if (createdBranch) await c.deleteBranch(repo, branch).catch(() => undefined);
      if (inFlight) this.d.products.deleteWrite(inFlight);
      throw explain(e, repo.fullName, branch);
    }
  }

  // ---------------------------------------------------------------- CRM conversations and PDRs (Phase 4b)

  /** Where the CRM repo keeps customers and how it writes conversation headings, read from the repo itself. */
  async crmLayout(): Promise<CrmLayout> {
    const repo = await this.repoFor('crm');
    const c = this.d.client();
    const head = await c.branchHead(repo, repo.defaultBranch);
    if (!head) throw new WriteError('not-found', `${repo.fullName} has no ${repo.defaultBranch} branch.`);
    // Read the top two folder levels' Markdown files (bounded), enough to see the pattern.
    const files: { path: string; content: string }[] = [];
    const visit = async (path: string, depth: number) => {
      for (const e of await c.listTree(repo, path)) {
        if (files.length >= 60) return;
        if (e.type === 'dir' && depth < 1) await visit(e.path, depth + 1);
        else if (e.type === 'file' && /\.md$/i.test(e.name)) {
          const f = await c.fileAt(repo, e.path, repo.defaultBranch);
          if (f) files.push({ path: e.path, content: f.content });
        }
      }
    };
    await visit('', 0);
    return detectCrmLayout(files);
  }

  /** Where PDRs live, how they're numbered, any template, and the branch convention (detected, and confirmed if it was). */
  async pdrLayout(): Promise<PdrLayout> {
    const repo = await this.repoFor('pdr');
    const c = this.d.client();
    const paths: string[] = [];
    const visit = async (path: string, depth: number) => {
      for (const e of await c.listTree(repo, path)) {
        if (paths.length >= 300) return;
        if (e.type === 'dir' && depth < 1) await visit(e.path, depth + 1);
        else if (e.type === 'file') paths.push(e.path);
      }
    };
    await visit('', 0);
    const layout = detectPdrLayout(paths);
    const templatePath = paths.find((p) => /template/i.test(p) && /\.md$/i.test(p));
    const template = templatePath ? await c.fileAt(repo, templatePath, repo.defaultBranch) : null;
    const [branches, pulls] = await Promise.all([c.listBranches(repo), c.listPulls(repo)]);
    const pullDetails = await Promise.all(pulls.slice(0, 30).map((p) => c.getPull(repo, p.number)));
    const detected = suggestConvention({
      branches, defaultBranch: repo.defaultBranch, folder: layout.folder,
      pulls: pullDetails.filter((p): p is NonNullable<typeof p> => !!p).map((p) => ({ head: p.headRef, base: p.baseRef })),
    });
    const confirmed = await this.d.convention?.(repo.fullName);
    return { ...layout, ...(template && templatePath ? { template: { path: templatePath, content: template.content } } : {}), detected, ...(confirmed ? { confirmed } : {}) };
  }

  /** The app's open pull request touching `path` in `repo` if there is one, else a fresh branch off `base`. */
  private async target(repo: RepoRef, path: string, base: string, stem: () => Promise<string>) {
    const c = this.d.client();
    const existing = await this.openAppPullFor(repo, path);
    const onBranch = existing?.branch ?? base;
    const parent = await c.branchHead(repo, onBranch);
    if (!parent) throw new WriteError('not-found', `${repo.fullName} has no ${onBranch} branch.`);
    const before = await c.fileAt(repo, path, onBranch);
    const branch = existing?.branch ?? await stem();
    return { existing, parent, before, branch, base: existing?.base ?? base };
  }

  private async planConversation(d: Extract<WriteDraft, { kind: 'log-conversation' }>): Promise<Plan> {
    if (!isId(d.productId)) throw new WriteError('invalid', 'Pick a product.');
    const product = this.d.products.getProduct(d.productId);
    if (!product) throw new WriteError('not-found', 'That product no longer exists.');
    if (!isRepoPath(d.customerPath) || !/\.md$/i.test(d.customerPath)) throw new WriteError('invalid', 'The customer file must be a Markdown path in the CRM repo.');
    if (typeof d.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.date) || Number.isNaN(Date.parse(d.date))) throw new WriteError('invalid', 'The date must be YYYY-MM-DD.');
    const topic = typeof d.topic === 'string' ? d.topic.trim().replace(/\s+/g, ' ').slice(0, 200) : '';
    if (!topic) throw new WriteError('invalid', 'Give the conversation a topic.');
    const notes = typeof d.notes === 'string' ? d.notes : '';
    if (!notes.trim()) throw new WriteError('invalid', 'Add your notes from the conversation.');
    const participants = typeof d.participants === 'string' ? d.participants.slice(0, 500) : '';
    if (d.stage !== undefined && d.stage !== null && !isStage(d.stage)) throw new WriteError('invalid', 'Unknown stage.');

    const repo = await this.repoFor('crm');
    const layout = await this.crmLayout();
    const slug = slugify(d.customerPath.split('/').pop()!.replace(/\.md$/i, '')).slice(0, 40) || 'customer';
    const t = await this.target(repo, d.customerPath, repo.defaultBranch, () => this.freshBranch(repo, `crm/${slug}`));
    const isNew = !t.before;
    const customerName = typeof d.customerName === 'string' ? d.customerName.trim().slice(0, 200) : '';
    if (isNew && !customerName) throw new WriteError('invalid', `${d.customerPath} doesn't exist yet. Give the new customer a name.`);
    const content = this.checkContent(appendConversation(t.before?.content ?? null, { customerName, date: d.date, topic, participants, notes }, layout.separator));
    const heading = `${d.date}${layout.separator}${topic}`;
    const anchor = markdownSections(content).filter((s) => s.heading === heading).at(-1)?.anchor;
    if (!anchor) throw new WriteError('invalid', 'Could not place the conversation section.');

    const stage: WorkflowStage | undefined = d.stage === null ? undefined : d.stage ?? 'intake';
    const { diff, added, removed } = unifiedDiff(t.before?.content ?? null, content, d.customerPath);
    const who = isNew ? customerName : layout.customers.find((x) => x.path === d.customerPath)?.name ?? slug;
    const host = this.d.host();
    const links: Omit<NewLink, 'pending'>[] = [
      ...(isNew ? [{ role: 'crm' as const, kind: 'customer' as const, repoHost: host, repoFullName: repo.fullName, path: d.customerPath, title: customerName, ...(stage ? { stage } : {}) }] : []),
      { role: 'crm', kind: 'conversation', repoHost: host, repoFullName: repo.fullName, path: d.customerPath, anchor, title: heading, ...(stage ? { stage } : {}) },
    ];
    const preview: WritePreview = {
      id: randomUUID(), role: 'crm', repo: repo.fullName, base: t.base, branch: t.branch,
      ...(t.existing?.prNumber ? { existingPr: { number: t.existing.prNumber, url: t.existing.prUrl ?? '' } } : {}),
      files: [{ path: d.customerPath, change: isNew ? 'create' : 'update', diff, added, removed }],
      commitMessage: `Log conversation with ${who}: ${d.date} ${topic}`, title: t.existing?.title ?? `Log conversation with ${who}: ${topic}`,
      body: this.body(d.description, product.name, [d.customerPath]),
    };
    return {
      preview, repo, role: 'crm', parent: t.parent, expect: { [d.customerPath]: t.before?.sha ?? null }, files: [{ path: d.customerPath, content }],
      existing: t.existing, productId: product.id, link: { create: links }, expiresAt: Date.now() + PREVIEW_TTL_MS,
    };
  }

  private async planPdr(d: Extract<WriteDraft, { kind: 'create-pdr' }>): Promise<Plan> {
    if (!isId(d.productId)) throw new WriteError('invalid', 'Pick a product.');
    const product = this.d.products.getProduct(d.productId);
    if (!product) throw new WriteError('not-found', 'That product no longer exists.');
    if (!isRepoPath(d.path) || !/\.(md|markdown)$/i.test(d.path)) throw new WriteError('invalid', 'The destination must be a Markdown file path in the PDR repo.');
    const title = typeof d.title === 'string' ? d.title.trim().slice(0, 200) : '';
    if (!title) throw new WriteError('invalid', 'Give the decision record a title.');
    const conv = d.convention;
    if (!conv || typeof conv.prefix !== 'string' || !/^[A-Za-z0-9._-]+\/$/.test(conv.prefix) || /^(refs|heads|main|master|develop|trunk)\/$/.test(conv.prefix)) {
      throw new WriteError('invalid', 'Confirm a branch prefix like spec/ for the PDR repo.');
    }
    if (typeof conv.base !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(conv.base) || conv.base.includes('..')) throw new WriteError('invalid', 'Confirm the branch PDR pull requests target.');
    const content = this.checkContent(d.content);

    const repo = await this.repoFor('pdr');
    const c = this.d.client();
    const parent = await c.branchHead(repo, conv.base);
    if (!parent) throw new WriteError('not-found', `${repo.fullName} has no ${conv.base} branch to open the pull request against.`);
    if (await c.fileAt(repo, d.path, conv.base)) throw new WriteError('invalid', `${d.path} already exists on ${conv.base} in ${repo.fullName}.`);
    if (conv.base !== repo.defaultBranch && await c.fileAt(repo, d.path, repo.defaultBranch)) throw new WriteError('invalid', `${d.path} already exists on ${repo.defaultBranch} in ${repo.fullName}.`);
    const clash = await this.openAppPullFor(repo, d.path);
    if (clash) throw new WriteError('invalid', `Pull request #${clash.prNumber} from PM Workbench already adds ${d.path}.`);

    // The branch follows the repo's convention, e.g. spec/spec-004-checkout-limits.
    const stem = d.path.split('/').pop()!.replace(/\.(md|markdown)$/i, '');
    // The guard only allows a confirmed prefix; make this one allowed for the duration of the write.
    this.pendingPrefixes.set(repo.fullName.toLowerCase(), conv.prefix);
    const branch = await this.freshBranch(repo, slugify(stem).slice(0, 60) || 'decision', conv.prefix, false);
    const { diff, added, removed } = unifiedDiff(null, content, d.path);
    const preview: WritePreview = {
      id: randomUUID(), role: 'pdr', repo: repo.fullName, base: conv.base, branch,
      files: [{ path: d.path, change: 'create', diff, added, removed }],
      commitMessage: `Add decision record: ${title}`, title: `Add decision record: ${title}`,
      body: this.body(d.description, product.name, [d.path]),
    };
    return {
      preview, repo, role: 'pdr', parent, expect: { [d.path]: null }, files: [{ path: d.path, content }], productId: product.id,
      link: { create: [{ role: 'pdr', kind: 'decision', repoHost: this.d.host(), repoFullName: repo.fullName, path: d.path, title, stage: 'specification' }] },
      saveConvention: { prefix: conv.prefix, base: conv.base }, expiresAt: Date.now() + PREVIEW_TTL_MS,
    };
  }

  /** A prefix the PM is confirming in a preview, allowed by the guard alongside saved ones. */
  readonly pendingPrefixes = new Map<string, string>();

  /**
   * Finishes or cleans up writes interrupted between recording and confirming their pull request:
   * if GitHub has a pull request for the branch, it is recorded and the item linked as planned;
   * otherwise the orphan branch (always an app branch) is deleted. Safe to run any time; a write
   * whose repo can't be reached right now is left for the next run.
   */
  async recoverInterrupted(): Promise<{ completed: number; cleaned: number }> {
    let completed = 0;
    let cleaned = 0;
    const roles = await this.d.roles();
    for (const w of this.d.products.inFlightWrites()) {
      const repo = Object.values(roles).find((r) => r && r.fullName.toLowerCase() === w.repo.toLowerCase());
      if (!repo || w.repoHost.toLowerCase() !== this.d.host().toLowerCase()) continue;
      try {
        const c = this.d.client();
        const pr = await c.pullForBranch(repo, w.branch);
        if (pr) {
          this.d.products.completeWrite(w.id, pr.number, pr.url);
          if (w.linkPlan && w.productId) {
            const plans = Array.isArray(w.linkPlan) ? w.linkPlan : [w.linkPlan];
            this.d.products.addLinks(w.productId, plans.map((l) => ({ ...l, pending: { prNumber: pr.number, branch: w.branch } })));
            this.d.products.snapshot(w.productId);
          }
          completed++;
        } else {
          assertWritableBranch(repo.fullName, w.branch, this.d.guard, 'modify');
          if (await c.branchHead(repo, w.branch)) await c.deleteBranch(repo, w.branch);
          this.d.products.deleteWrite(w.id);
          cleaned++;
        }
      } catch {
        // Offline or not allowed right now: try again next time.
      }
    }
    return { completed, cleaned };
  }

  /** Links a newly created item to its product, pending until the pull request merges. */
  private applyLink(plan: Plan, prNumber: number): { linkId?: string } {
    if (!plan.link || !plan.productId) return {};
    if ('linkId' in plan.link) return { linkId: plan.link.linkId };
    this.d.products.addLinks(plan.productId, plan.link.create.map((l) => ({ ...l, pending: { prNumber, branch: plan.preview.branch } })));
    this.d.products.snapshot(plan.productId);
    // The last one is the item the write was for (a conversation after its new customer).
    return { linkId: this.d.products.lastAddedIds.at(-1) };
  }

  private sweep() {
    const t = Date.now();
    for (const [id, p] of this.plans) if (p.expiresAt < t) this.plans.delete(id);
  }
}
