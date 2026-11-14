import type { RepoRef, RepoRole } from '../../shared/ipc.js';
import { markdownSections, type ActivityEvent, type ItemState, type Link, type LinkHealth, type PullStatus, type Reviewer } from '../../shared/products.js';
import { RateLimitedError, type GitHubClient } from '../github/client.js';
import type { HttpCache } from './httpcache.js';

/**
 * Brings a product's linked items up to date with GitHub: whether each target still exists (link
 * health), and its current state for the workflow board (when a file last changed; a pull
 * request's status and reviewers). Replaces Phase 2's per-link checks with a cheaper plan:
 *
 * - one recursive tree read per repo answers "does it exist, and what is its blob SHA" for every
 *   file link in that repo at once, and finds a moved file by its old SHA for free;
 * - a file's recent commits (its last change, and the activity the flow metrics count) are fetched
 *   only when its SHA differs from the last sync, in one request;
 * - a conversation's sections are read from the blob, which is immutable, so it's fetched once per
 *   version of the file and only its section anchors are kept;
 * - a pull request costs three reads (the PR, its reviews, its commits).
 *
 * Every read goes through the response cache with its ETag, so anything unchanged comes back as a
 * 304, which GitHub doesn't count against the rate limit. Only a 404 marks a link broken; any other
 * failure leaves the item's stored state and health alone.
 */

export interface SyncOutcome {
  linkId: string;
  health?: LinkHealth;
  state?: ItemState;
  blobSha?: string;
  error?: string;
  /** The item's app pull request merged: the link should stop being pending. */
  clearPending?: boolean;
}

export interface SyncResult {
  outcomes: SyncOutcome[];
  /** Requests actually sent, and how many came back 304 Not Modified. */
  requests: number;
  notModified: number;
  /** Set when the sync as a whole couldn't run: rate limited, or every request failed. */
  error?: string;
}

type Got<T> = { status: 200; body: T } | { status: 404 };
interface TreeBody { truncated: boolean; blobs: [string, string][] }
interface CommitBody { date?: string; by?: string; commits: ActivityEvent[] }
interface PullBody { title: string; state: string; merged: boolean; draft: boolean; updatedAt: string; requested: string[]; createdAt?: string; mergedAt?: string }

/** How much commit history per file is kept for the activity metrics: the last 100 commits touching it. */
export const COMMITS_PER_FILE = 100;
type ReviewsBody = { login: string; state: string; at: string }[];

const CONCURRENCY = 4;

export async function syncLinks(
  links: Link[],
  host: string,
  roles: Partial<Record<RepoRole, RepoRef>>,
  client: Pick<GitHubClient, 'conditionalGet'>,
  cache: HttpCache,
  previous: Record<string, ItemState>,
  now: Date,
): Promise<SyncResult> {
  let requests = 0;
  let notModified = 0;
  let rateLimited: RateLimitedError | undefined;
  const inflight = new Map<string, Promise<Got<unknown>>>();

  /**
   * One cached, conditional GET. `shrink` reduces the response to what the board needs before it is
   * cached; `immutable` skips the network entirely once something is cached (blobs by SHA).
   */
  function get<T>(route: string, params: Record<string, string | number>, shrink: (data: unknown) => T, immutable = false): Promise<Got<T>> {
    const key = `${host}|${route}|${JSON.stringify(params)}`;
    const existing = inflight.get(key);
    if (existing) return existing as Promise<Got<T>>;
    const run = (async (): Promise<Got<T>> => {
      const cached = cache.get(key);
      if (immutable && cached?.status === 200) return { status: 200, body: cached.body as T };
      if (rateLimited) throw rateLimited;
      requests++;
      let r;
      try {
        r = await client.conditionalGet(route, params, cached?.status === 200 ? cached.etag : undefined);
      } catch (e) {
        if (e instanceof RateLimitedError) rateLimited = e;
        throw e;
      }
      if (r.status === 304 && cached) {
        notModified++;
        cache.touch(key);
        return cached.status === 200 ? { status: 200, body: cached.body as T } : { status: 404 };
      }
      if (r.status === 404 || r.status === 304) {
        cache.put(key, 404, null);
        return { status: 404 };
      }
      const body = shrink(r.data);
      cache.put(key, 200, body, r.etag);
      return { status: 200, body };
    })();
    inflight.set(key, run);
    return run;
  }

  const checkedAt = now.toISOString();
  const ok: LinkHealth = { state: 'ok', checkedAt };
  const broken = (reason: string, movedTo?: string): LinkHealth => ({ state: 'broken', checkedAt, reason, ...(movedTo ? { movedTo } : {}) });

  const repoFor = (l: Link): RepoRef | undefined => {
    if (l.repoHost.toLowerCase() !== host.toLowerCase()) return undefined;
    return Object.values(roles).find((r) => r && r.fullName.toLowerCase() === l.repoFullName.toLowerCase());
  };

  const tree = (repo: RepoRef) => get<TreeBody>(
    'GET /repos/{owner}/{repo}/git/trees/{tree_sha}',
    { owner: repo.owner, repo: repo.name, tree_sha: repo.defaultBranch, recursive: 1 },
    (d) => {
      const t = d as { truncated?: boolean; tree: { path: string; type: string; sha: string }[] };
      return { truncated: !!t.truncated, blobs: t.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha] as [string, string]) };
    },
  );

  // A path's blob SHA: from the tree, or, when GitHub truncated a very large tree, from the contents API.
  const shaOf = async (repo: RepoRef, path: string): Promise<{ sha?: string; shaToPath?: Map<string, string> }> => {
    const t = await tree(repo);
    if (t.status === 404) return {};
    const byPath = new Map(t.body.blobs);
    const sha = byPath.get(path);
    if (sha || !t.body.truncated) return { sha, shaToPath: t.body.truncated ? undefined : new Map(t.body.blobs.map(([p, s]) => [s, p])) };
    const c = await get<{ sha?: string }>('GET /repos/{owner}/{repo}/contents/{path}', { owner: repo.owner, repo: repo.name, path, ref: repo.defaultBranch },
      (d) => (Array.isArray(d) ? {} : { sha: (d as { type: string; sha: string }).type === 'file' ? (d as { sha: string }).sha : undefined }));
    return { sha: c.status === 200 ? c.body.sha : undefined };
  };

  type RestCommit = { sha: string; commit: { committer?: { date?: string }; author?: { date?: string; name?: string } }; author?: { login?: string } | null };
  const commitAt = (c: RestCommit) => c.commit.committer?.date ?? c.commit.author?.date ?? '';

  const fileCommits = (repo: RepoRef, path: string) => get<CommitBody>(
    'GET /repos/{owner}/{repo}/commits',
    { owner: repo.owner, repo: repo.name, sha: repo.defaultBranch, path, per_page: COMMITS_PER_FILE },
    (d) => {
      const list = d as RestCommit[];
      const c = list[0];
      const commits = list.map((x) => ({ id: `commit:${x.sha}`, at: commitAt(x), type: 'commit' as const })).filter((x) => x.at);
      if (!c) return { commits };
      return { date: commitAt(c) || undefined, by: c.author?.login ?? c.commit.author?.name, commits };
    },
  );

  const anchorsOf = (repo: RepoRef, sha: string) => get<string[]>(
    'GET /repos/{owner}/{repo}/git/blobs/{file_sha}',
    { owner: repo.owner, repo: repo.name, file_sha: sha },
    (d) => {
      const b = d as { content: string; encoding: string };
      const text = Buffer.from(b.content, b.encoding as BufferEncoding).toString('utf8');
      return markdownSections(text).map((s) => s.anchor);
    },
    true,
  );

  const fileItem = async (l: Link, repo: RepoRef): Promise<SyncOutcome> => {
    const path = l.path!;
    const { sha, shaToPath } = await shaOf(repo, path);
    if (!sha) {
      const movedTo = l.blobSha ? shaToPath?.get(l.blobSha) : undefined;
      return { linkId: l.id, state: { kind: 'file', exists: false }, health: broken(`${path} is no longer on ${repo.defaultBranch}.`, movedTo) };
    }
    const prev = previous[l.id];
    let lastChangedAt: string | undefined;
    let lastChangedBy: string | undefined;
    let activity: ActivityEvent[] | undefined;
    // Same content as last time means no new commits touched it, so the stored history still holds.
    if (prev?.kind === 'file' && prev.exists && prev.sha === sha && prev.lastChangedAt && prev.activity) {
      ({ lastChangedAt, lastChangedBy, activity } = prev);
    } else {
      const c = await fileCommits(repo, path);
      if (c.status === 200) ({ date: lastChangedAt, by: lastChangedBy, commits: activity } = c.body);
    }
    const state: ItemState = {
      kind: 'file', exists: true, sha, ...(lastChangedAt ? { lastChangedAt } : {}), ...(lastChangedBy ? { lastChangedBy } : {}), ...(activity ? { activity } : {}),
    };
    if (l.kind === 'conversation' && l.anchor) {
      const a = await anchorsOf(repo, sha);
      if (a.status === 200 && !a.body.includes(l.anchor)) return { linkId: l.id, state, blobSha: sha, health: broken(`The section "${l.title}" is no longer in ${path}.`) };
    }
    return { linkId: l.id, state, blobSha: sha, health: ok };
  };

  const pullItem = async (l: Link, repo: RepoRef): Promise<SyncOutcome> => {
    const n = l.prNumber!;
    const params = { owner: repo.owner, repo: repo.name, pull_number: n };
    const pr = await get<PullBody>('GET /repos/{owner}/{repo}/pulls/{pull_number}', params, (d) => {
      const p = d as { title: string; state: string; merged?: boolean; merged_at?: string | null; draft?: boolean; updated_at: string; requested_reviewers?: { login: string }[] };
      const q = p as typeof p & { created_at?: string };
      return {
        title: p.title, state: p.state, merged: !!(p.merged || p.merged_at), draft: !!p.draft, updatedAt: p.updated_at, requested: (p.requested_reviewers ?? []).map((r) => r.login),
        ...(q.created_at ? { createdAt: q.created_at } : {}), ...(p.merged_at ? { mergedAt: p.merged_at } : {}),
      };
    });
    if (pr.status === 404) return { linkId: l.id, health: broken(`Pull request #${n} no longer exists in ${repo.fullName}.`) };
    const rv = await get<ReviewsBody>('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', { ...params, per_page: 100 }, (d) =>
      (d as { user: { login: string } | null; state: string; submitted_at?: string }[]).map((r) => ({ login: r.user?.login ?? '', state: r.state, at: r.submitted_at ?? '' })));
    const cm = await get<ActivityEvent[]>('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', { ...params, per_page: 100 }, (d) =>
      (d as RestCommit[]).map((x) => ({ id: `commit:${x.sha}`, at: commitAt(x), type: 'commit' as const })).filter((x) => x.at));
    const reviews = rv.status === 200 ? rv.body : [];
    const { status, reviewers } = pullStatus(pr.body, reviews);
    const activity: ActivityEvent[] = [
      ...(pr.body.createdAt ? [{ id: `pr:${repo.fullName}#${n}:opened`, at: pr.body.createdAt, type: 'opened' as const }] : []),
      ...reviews.filter((r) => r.at).map((r, i) => ({ id: `pr:${repo.fullName}#${n}:review:${i}:${r.at}`, at: r.at, type: 'review' as const })),
      ...(cm.status === 200 ? cm.body : []),
      ...(pr.body.mergedAt ? [{ id: `pr:${repo.fullName}#${n}:merged`, at: pr.body.mergedAt, type: 'merged' as const }] : []),
    ];
    return { linkId: l.id, health: ok, state: { kind: 'pull', status, title: pr.body.title, updatedAt: pr.body.updatedAt, reviewers, activity } };
  };

  /**
   * A new item still on an app branch: its state is its pull request's. Once merged it becomes an
   * ordinary file link (and is checked as one straight away); closed unmerged, the link is broken.
   */
  const pendingItem = async (l: Link, repo: RepoRef): Promise<SyncOutcome> => {
    const { prNumber } = l.pending!;
    const pr = await pullItem({ ...l, prNumber }, repo);
    if (!pr.state || pr.state.kind !== 'pull') return { ...pr, health: broken(`Pull request #${prNumber}, which adds this item, no longer exists in ${repo.fullName}.`) };
    if (pr.state.status === 'merged') return { ...(await fileItem(l, repo)), clearPending: true };
    if (pr.state.status === 'closed') return { linkId: l.id, health: broken(`Pull request #${prNumber}, which adds this item, was closed without merging.`) };
    const { status, reviewers, updatedAt, activity } = pr.state;
    return { linkId: l.id, health: ok, state: { kind: 'pending', prNumber, status, reviewers, updatedAt, ...(activity ? { activity } : {}) } };
  };

  const one = async (l: Link): Promise<SyncOutcome> => {
    const repo = repoFor(l);
    if (!repo) return { linkId: l.id, health: broken(`${l.repoFullName} on ${l.repoHost} is not one of your connected repos.`) };
    try {
      if (l.pending) return await pendingItem(l, repo);
      return l.prNumber !== undefined ? await pullItem(l, repo) : await fileItem(l, repo);
    } catch (e) {
      return { linkId: l.id, error: e instanceof Error ? e.message : String(e) };
    }
  };

  const outcomes: SyncOutcome[] = new Array(links.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, links.length) }, async () => {
    while (next < links.length) {
      const i = next++;
      outcomes[i] = await one(links[i]);
    }
  }));

  const failed = outcomes.filter((o) => o.error);
  const error = rateLimited?.message ?? (failed.length && failed.length === outcomes.length ? `Couldn't reach GitHub: ${failed[0].error}` : undefined);
  return { outcomes, requests, notModified, ...(error ? { error } : {}) };
}

/**
 * A pull request's board status from GitHub's data. Each reviewer's latest decisive review counts
 * (comments don't change it): any outstanding "changes requested" wins over approvals.
 */
export function pullStatus(pr: PullBody, reviews: ReviewsBody): { status: PullStatus; reviewers: Reviewer[] } {
  const latest = new Map<string, Reviewer['state']>();
  for (const r of [...reviews].sort((a, b) => a.at.localeCompare(b.at))) {
    if (!r.login) continue;
    const s = r.state === 'APPROVED' ? 'approved' : r.state === 'CHANGES_REQUESTED' ? 'changes-requested' : r.state === 'DISMISSED' ? 'dismissed' : r.state === 'COMMENTED' ? 'commented' : undefined;
    if (!s) continue;
    // A comment after a decision doesn't undo the decision.
    if (s === 'commented' && latest.has(r.login) && latest.get(r.login) !== 'commented') continue;
    latest.set(r.login, s);
  }
  // Re-requested reviewers are waiting on a fresh review, whatever they said before.
  for (const login of pr.requested) latest.set(login, 'requested');
  const reviewers = [...latest.entries()].map(([login, state]) => ({ login, state })).sort((a, b) => a.login.localeCompare(b.login));
  const states = reviewers.map((r) => r.state);
  const status: PullStatus = pr.merged ? 'merged'
    : pr.state === 'closed' ? 'closed'
    : pr.draft ? 'draft'
    : states.includes('changes-requested') ? 'changes-requested'
    : states.includes('approved') ? 'approved'
    : 'open';
  return { status, reviewers };
}
