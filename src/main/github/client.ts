import { Octokit } from '@octokit/rest';
import { apiBaseUrl } from './host.js';
import { createGuardedFetch } from './allowlist.js';
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
  /** A path's current blob SHA on the default branch, or null when nothing is there (404). */
  statPath(repo: RepoRef, path: string): Promise<{ sha: string; type: 'file' | 'dir' } | null>;
  /** The path of a file with this blob SHA anywhere on the default branch, or null. One call per repo. */
  findBlob(repo: RepoRef, sha: string): Promise<string | null>;
  /** Pull requests, most recently updated first, open and closed, capped at 100. */
  listPulls(repo: RepoRef): Promise<PullSummary[]>;
  /** One pull request, or null when it doesn't exist (404). */
  getPull(repo: RepoRef, number: number): Promise<PullDetail | null>;
}

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
export function createGitHubClient(host: string, token: string, fetchImpl: typeof fetch = fetch): GitHubClient {
  const baseUrl = apiBaseUrl(host);
  const allowedHostname = new URL(baseUrl).hostname;
  const guarded = createGuardedFetch(() => allowedHostname, fetchImpl);
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

    async statPath(repo, path) {
      try {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
          owner: repo.owner, repo: repo.name, path: path.replace(/^\/+/, ''), ref: repo.defaultBranch,
        });
        if (Array.isArray(data)) return { sha: '', type: 'dir' };
        return data.type === 'file' ? { sha: data.sha, type: 'file' } : null;
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },

    async findBlob(repo, sha) {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
        owner: repo.owner, repo: repo.name, tree_sha: repo.defaultBranch, recursive: '1',
      });
      return data.tree.find((e) => e.type === 'blob' && e.sha === sha)?.path ?? null;
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
  };
}
