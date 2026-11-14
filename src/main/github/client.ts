import { Octokit } from '@octokit/rest';
import { apiBaseUrl } from './host.js';
import { createGuardedFetch } from './allowlist.js';

export interface RepoRef {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  htmlUrl: string;
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
  /** Repos the token can see, most recently pushed first, capped at 100. */
  listRepos(): Promise<RepoRef[]>;
  /** The entries of one folder (not recursive) in a repo at its default branch. */
  listTree(repo: RepoRef, path: string): Promise<TreeEntry[]>;
  /** One file's decoded text content. Files over 1 MB come back truncated rather than failing. */
  getFile(repo: RepoRef, path: string): Promise<FileContent>;
}

const MAX_FILE_BYTES = 1_000_000;

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
      const { data } = await octokit.request('GET /user/repos', { per_page: 100, sort: 'pushed', affiliation: 'owner,collaborator,organization_member' });
      return data.map(toRepoRef);
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
  };
}
