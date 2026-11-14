import { Octokit } from '@octokit/rest';
import { apiBaseUrl } from './host.js';
import { createGuardedFetch } from './allowlist.js';
import { createWriteGuard, type WriteGuardOptions } from '../write/guard.js';
import type { PullDetail, PullSummary } from '../../shared/products.js';

export interface RepoRef {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  htmlUrl: string;
}

export interface RepoList {
  repos: RepoRef[];
  /**
   * True when the token is a classic PAT without the `repo` scope, so GitHub hides every private
   * repo from it. Fine-grained tokens don't report scopes, so this stays false for them.
   */
  missingPrivateScope: boolean;
}

export interface TreeEntry {
  path: string;
  name: string;
  type: 'file' | 'dir';
  sha: string;
}

export interface FileContent {
  path: string;
  content: string;
  truncated: boolean;
  htmlUrl: string;
  sha: string;
}

export interface GitHubClient {
  /** Confirms the token works and returns who it belongs to. Throws on failure. */
  whoAmI(): Promise<{ login: string }>;
  /** Every repo the token can see (all pages, up to MAX_REPOS), most recently pushed first. */
  listRepos(): Promise<RepoList>;
  /** The entries of one folder (not recursive) in a repo at its default branch. */
  listTree(repo: RepoRef, path: string): Promise<TreeEntry[]>;
  /** One file's decoded text content. Files over 1 MB come back truncated rather than failing. */
  getFile(repo: RepoRef, path: string): Promise<FileContent>;
  /**
   * One GET against the REST API with an optional ETag. A 304 (unchanged, and free against the rate
   * limit) and a 404 come back as results rather than errors; running out of rate limit throws
   * RateLimitedError. Used by the board sync through its response cache (src/main/products/sync.ts).
   */
  conditionalGet(route: string, params: Record<string, string | number>, etag?: string): Promise<ConditionalResult>;
  /** Pull requests, most recently updated first, open and closed, capped at 100. */
  listPulls(repo: RepoRef): Promise<PullSummary[]>;
  /** One pull request, or null when it doesn't exist (404). */
  getPull(repo: RepoRef, number: number): Promise<PullDetail | null>;

  // Writes. Only the write engine (src/main/write/engine.ts) calls these, and every one also passes
  // the network write guard (src/main/write/guard.ts).
  /** A branch's head commit SHA, or null when the branch doesn't exist. */
  branchHead(repo: RepoRef, branch: string): Promise<string | null>;
  /** A file's text and blob SHA at a ref, or null when it isn't there. */
  fileAt(repo: RepoRef, path: string, ref: string): Promise<{ content: string; sha: string } | null>;
  /** One commit on top of `parent` that writes each file (create or replace). Returns the new commit's SHA. */
  commitFiles(repo: RepoRef, parent: string, files: { path: string; content: string }[], message: string): Promise<string>;
  createBranch(repo: RepoRef, branch: string, sha: string): Promise<void>;
  /** Fast-forwards an app branch to `sha`; never forced. */
  moveBranch(repo: RepoRef, branch: string, sha: string): Promise<void>;
  deleteBranch(repo: RepoRef, branch: string): Promise<void>;
  openPull(repo: RepoRef, p: { title: string; body: string; head: string; base: string }): Promise<{ number: number; url: string }>;
  /** Branch names, up to 100, for detecting a repo's branch convention. */
  listBranches(repo: RepoRef): Promise<string[]>;
  /** Unresolved review threads on a pull request (GraphQL; GitHub's REST API doesn't expose resolution). */
  unresolvedThreads(repo: RepoRef, number: number): Promise<number>;
  /** A pull request (any state) whose head is this branch of the same repo, if one exists. */
  pullForBranch(repo: RepoRef, branch: string): Promise<{ number: number; url: string } | null>;
}

export type ConditionalResult = { status: 200; data: unknown; etag?: string } | { status: 304 } | { status: 404 };

export class RateLimitedError extends Error {
  constructor(public resetAt?: string) {
    super(resetAt ? `GitHub's rate limit is used up until ${new Date(resetAt).toLocaleTimeString()}.` : "GitHub's rate limit is used up for now.");
    this.name = 'RateLimitedError';
  }
}

type ErrorShape = { status?: number; response?: { headers?: Record<string, string | number | undefined> } };
const header = (e: ErrorShape, name: string) => e.response?.headers?.[name];

const isNotFound = (e: unknown) => typeof e === 'object' && e !== null && (e as { status?: number }).status === 404;

type RestPull = { number: number; title: string; state: string; merged_at: string | null; draft?: boolean; user: { login: string } | null; updated_at: string };
const toPullSummary = (p: RestPull): PullSummary => ({
  number: p.number, title: p.title, state: p.state === 'open' ? 'open' : 'closed', merged: !!p.merged_at, draft: !!p.draft, author: p.user?.login ?? '', updatedAt: p.updated_at,
});

const MAX_FILE_BYTES = 1_000_000;
const MAX_REPOS = 1000;

function toRepoRef(r: { owner: { login: string }; name: string; full_name: string; default_branch: string; private: boolean; html_url: string }): RepoRef {
  return { owner: r.owner.login, name: r.name, fullName: r.full_name, defaultBranch: r.default_branch, private: r.private, htmlUrl: r.html_url };
}

/**
 * Talks to the GitHub REST API through Octokit, with every request forced through the network
 * allow-list so nothing but the configured host is ever reached. See
 * docs/decisions/github-access.md for why this is the API rather than a local clone.
 */
/** What the app wants to hear about every response, whichever call made it. */
export interface ClientHooks {
  /** GitHub answered 401: the token expired or was revoked. */
  onUnauthorized?: () => void;
  /** GitHub answered with a primary or secondary rate limit; `until` is when to try again. */
  onRateLimited?: (until: Date) => void;
}

/** Watches responses for a dead token or a rate limit, so the app can react however the call was made. */
export function observeResponses(hooks: ClientHooks, baseFetch: typeof fetch, now: () => Date = () => new Date()): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await baseFetch(input, init);
    if (res.status === 401) hooks.onUnauthorized?.();
    if (res.status === 429 || res.status === 403) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      const retryAfter = Number(res.headers.get('retry-after'));
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      if (remaining === '0' && reset > 0) hooks.onRateLimited?.(new Date(reset * 1000));
      else if (retryAfter > 0) hooks.onRateLimited?.(new Date(now().getTime() + retryAfter * 1000)); // secondary limit
      else if (res.status === 429) hooks.onRateLimited?.(new Date(now().getTime() + 60_000));
    }
    return res;
  }) as typeof fetch;
}

export function createGitHubClient(host: string, token: string, fetchImpl: typeof fetch = fetch, writeGuard: WriteGuardOptions = { defaultBranches: () => ({}) }, hooks: ClientHooks = {}): GitHubClient {
  const baseUrl = apiBaseUrl(host);
  const allowedHostname = new URL(baseUrl).hostname;
  // Write guard first, then the host allow-list: a write must pass both before anything is sent.
  const guarded = createWriteGuard(writeGuard, createGuardedFetch(() => allowedHostname, observeResponses(hooks, fetchImpl)));
  const octokit = new Octokit({ auth: token, baseUrl, request: { fetch: guarded } });

  return {
    async whoAmI() {
      const { data } = await octokit.request('GET /user');
      return { login: data.login };
    },

    async listRepos() {
      const repos: RepoRef[] = [];
      let scopes: string | undefined;
      for await (const page of octokit.paginate.iterator('GET /user/repos', { per_page: 100, sort: 'pushed', affiliation: 'owner,collaborator,organization_member' })) {
        scopes ??= page.headers['x-oauth-scopes'] as string | undefined;
        repos.push(...page.data.map(toRepoRef));
        if (repos.length >= MAX_REPOS) break;
      }
      // Classic PATs list their scopes in this header; fine-grained tokens omit it entirely.
      const missingPrivateScope = scopes !== undefined && !scopes.split(',').map((s) => s.trim()).includes('repo');
      return { repos: repos.slice(0, MAX_REPOS), missingPrivateScope };
    },

    async listTree(repo, path) {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: repo.owner, repo: repo.name, path: path.replace(/^\/+/, ''), ref: repo.defaultBranch,
      });
      const entries = Array.isArray(data) ? data : [data];
      return entries
        .filter((e): e is typeof e & { type: 'file' | 'dir' } => e.type === 'file' || e.type === 'dir')
        .map((e) => ({ path: e.path, name: e.name, type: e.type as 'file' | 'dir', sha: e.sha }))
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    },

    async getFile(repo, path) {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: repo.owner, repo: repo.name, path: path.replace(/^\/+/, ''), ref: repo.defaultBranch,
      });
      if (Array.isArray(data) || data.type !== 'file') throw new Error(`"${path}" is a folder, not a file.`);
      if (data.content === undefined || data.encoding !== 'base64') {
        // Files over ~1MB come back without inline content; fetch the raw blob instead.
        const blob = await octokit.request('GET /repos/{owner}/{repo}/git/blobs/{file_sha}', { owner: repo.owner, repo: repo.name, file_sha: data.sha });
        const bytes = Buffer.from(blob.data.content, blob.data.encoding as BufferEncoding);
        const truncated = bytes.byteLength > MAX_FILE_BYTES;
        return { path, content: bytes.subarray(0, MAX_FILE_BYTES).toString('utf8'), truncated, htmlUrl: data.html_url ?? '', sha: data.sha };
      }
      const bytes = Buffer.from(data.content, 'base64');
      const truncated = bytes.byteLength > MAX_FILE_BYTES;
      return { path, content: bytes.subarray(0, MAX_FILE_BYTES).toString('utf8'), truncated, htmlUrl: data.html_url ?? '', sha: data.sha };
    },

    async conditionalGet(route, params, etag) {
      if (!route.startsWith('GET /')) throw new Error('conditionalGet only sends GET requests.');
      try {
        const r = await octokit.request(route, { ...params, headers: etag ? { 'if-none-match': etag } : {} });
        const tag = r.headers.etag;
        return { status: 200, data: r.data, ...(tag ? { etag: String(tag) } : {}) };
      } catch (e) {
        const err = e as ErrorShape;
        if (err.status === 304) return { status: 304 };
        // 409 is GitHub's answer for the tree of an empty repo: nothing there, same as a 404 for our purposes.
        if (err.status === 404 || err.status === 409) return { status: 404 };
        if (err.status === 429 || (err.status === 403 && String(header(err, 'x-ratelimit-remaining')) === '0')) {
          const reset = Number(header(err, 'x-ratelimit-reset'));
          throw new RateLimitedError(Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : undefined);
        }
        throw e;
      }
    },

    async listPulls(repo) {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
        owner: repo.owner, repo: repo.name, state: 'all', sort: 'updated', direction: 'desc', per_page: 100,
      });
      return data.map((p) => toPullSummary(p as RestPull));
    },

    async getPull(repo, number) {
      try {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner: repo.owner, repo: repo.name, pull_number: number });
        return { ...toPullSummary(data as RestPull), body: data.body ?? '', htmlUrl: data.html_url, baseRef: data.base.ref, headRef: data.head.ref };
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },

    async branchHead(repo, branch) {
      try {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', { owner: repo.owner, repo: repo.name, ref: `heads/${branch}` });
        return data.object.sha;
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },

    async fileAt(repo, path, ref) {
      try {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', { owner: repo.owner, repo: repo.name, path, ref });
        if (Array.isArray(data) || data.type !== 'file') return null;
        if (data.content !== undefined && data.encoding === 'base64') return { content: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha };
        const blob = await octokit.request('GET /repos/{owner}/{repo}/git/blobs/{file_sha}', { owner: repo.owner, repo: repo.name, file_sha: data.sha });
        return { content: Buffer.from(blob.data.content, blob.data.encoding as BufferEncoding).toString('utf8'), sha: data.sha };
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },

    async commitFiles(repo, parent, files, message) {
      const o = { owner: repo.owner, repo: repo.name };
      const { data: base } = await octokit.request('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', { ...o, commit_sha: parent });
      const { data: tree } = await octokit.request('POST /repos/{owner}/{repo}/git/trees', {
        ...o, base_tree: base.tree.sha, tree: files.map((f) => ({ path: f.path, mode: '100644' as const, type: 'blob' as const, content: f.content })),
      });
      const { data: commit } = await octokit.request('POST /repos/{owner}/{repo}/git/commits', { ...o, message, tree: tree.sha, parents: [parent] });
      return commit.sha;
    },

    async createBranch(repo, branch, sha) {
      await octokit.request('POST /repos/{owner}/{repo}/git/refs', { owner: repo.owner, repo: repo.name, ref: `refs/heads/${branch}`, sha });
    },

    async moveBranch(repo, branch, sha) {
      await octokit.request('PATCH /repos/{owner}/{repo}/git/refs/{ref}', { owner: repo.owner, repo: repo.name, ref: `heads/${branch}`, sha, force: false });
    },

    async deleteBranch(repo, branch) {
      await octokit.request('DELETE /repos/{owner}/{repo}/git/refs/{ref}', { owner: repo.owner, repo: repo.name, ref: `heads/${branch}` });
    },

    async openPull(repo, p) {
      const { data } = await octokit.request('POST /repos/{owner}/{repo}/pulls', { owner: repo.owner, repo: repo.name, title: p.title, body: p.body, head: p.head, base: p.base });
      return { number: data.number, url: data.html_url };
    },

    async pullForBranch(repo, branch) {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls', { owner: repo.owner, repo: repo.name, head: `${repo.owner}:${branch}`, state: 'all', per_page: 1 });
      return data[0] ? { number: data[0].number, url: data[0].html_url } : null;
    },

    async listBranches(repo) {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/branches', { owner: repo.owner, repo: repo.name, per_page: 100 });
      return data.map((b) => b.name);
    },

    async unresolvedThreads(repo, number) {
      const r = await octokit.graphql<{ repository: { pullRequest: { reviewThreads: { nodes: { isResolved: boolean }[] } } | null } }>(
        `query ($owner: String!, $name: String!, $n: Int!) {
          repository(owner: $owner, name: $name) { pullRequest(number: $n) { reviewThreads(first: 100) { nodes { isResolved } } } }
        }`,
        { owner: repo.owner, name: repo.name, n: number },
      );
      return (r.repository.pullRequest?.reviewThreads.nodes ?? []).filter((t) => !t.isResolved).length;
    },
  };
}
