/**
 * The network-level backstop for "every write is a branch plus a pull request; never commit to a
 * default branch". Every request the GitHub client sends passes through this before the host
 * allow-list. Reads go through untouched. A write is let through only if it is one of the few
 * calls the write engine makes, and only if any branch it creates, moves or deletes is one the app
 * owns (under APP_BRANCH_PREFIX) and is not a protected name. Anything else throws before it
 * leaves the process — including a bug in the engine itself.
 */
export const APP_BRANCH_PREFIX = 'pmworkbench/';

/** Never written to by name, whatever the repo's settings say. */
export const ALWAYS_PROTECTED = ['main', 'master', 'develop', 'trunk'];

export class WriteBlockedError extends Error {
  constructor(why: string) {
    super(`Blocked a write to GitHub: ${why}`);
    this.name = 'WriteBlockedError';
  }
}

const READ = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface WriteGuardOptions {
  /** Default branches of the connected repos, by "owner/name" (lowercase). */
  defaultBranches: () => Record<string, string>;
  /** Extra branch prefixes the PM confirmed for a repo (e.g. git-flow's "spec/"), by "owner/name" (lowercase). */
  prefixes?: () => Record<string, string[]>;
  /** Whether the app created this branch (it is in the app's own record of writes). */
  owns?: (repo: string, branch: string) => boolean;
}

export function isAppBranch(branch: string): boolean {
  return branch.startsWith(APP_BRANCH_PREFIX) && branch.length > APP_BRANCH_PREFIX.length && !branch.includes('..');
}

/**
 * Throws unless the app may touch `branch` in `repo`:
 * - never a default or protected name;
 * - "create": under the app prefix, or a prefix the PM confirmed for this repo;
 * - "modify" (move, delete, open a pull request from): under the app prefix, or a branch the app
 *   itself created — so a confirmed prefix never lets the app move someone else's branch.
 */
export function assertWritableBranch(repo: string, branch: string, opts: WriteGuardOptions, mode: 'create' | 'modify' = 'modify'): void {
  const key = repo.toLowerCase();
  const protectedNames = new Set([...ALWAYS_PROTECTED, opts.defaultBranches()[key]].filter(Boolean));
  if (protectedNames.has(branch) || branch.includes('..') || branch.startsWith('/') || branch.endsWith('/')) throw new WriteBlockedError(`"${branch}" is a default or protected branch of ${repo}.`);
  if (isAppBranch(branch)) return;
  const prefixes = (opts.prefixes?.()[key] ?? []).filter((p) => p.endsWith('/') && p.length > 1);
  const underPrefix = prefixes.some((p) => branch.startsWith(p) && branch.length > p.length);
  if (mode === 'create' && underPrefix) return;
  if (mode === 'modify' && underPrefix && opts.owns?.(repo, branch)) return;
  throw new WriteBlockedError(`"${branch}" is not a branch PM Workbench created (they start with ${[APP_BRANCH_PREFIX, ...prefixes].join(' or ')}).`);
}

export function createWriteGuard(opts: WriteGuardOptions, baseFetch: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (READ.has(method)) return baseFetch(input, init);
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    // GitHub Enterprise Server serves the API under /api/v3.
    const path = decodeURIComponent(url.pathname.replace(/^\/api\/v3/, ''));
    if (method === 'POST' && (path === '/graphql' || path === '/api/graphql')) {
      // Read-only GraphQL (review-thread state) is allowed; any mutation is not.
      let q = '';
      try { q = String(JSON.parse(String(init?.body ?? '{}')).query ?? ''); } catch { throw new WriteBlockedError('unreadable GraphQL body.'); }
      const ops = q.replace(/#[^\n]*/g, '').replace(/"(?:[^"\\]|\\.)*"/g, '""').trim();
      if (/\b(mutation|subscription)\b/.test(ops) || !/^(query\b|\{)/.test(ops)) throw new WriteBlockedError('only read-only GraphQL queries are allowed.');
      return baseFetch(input, init);
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(path);
    if (!m) throw new WriteBlockedError(`${method} ${path} is not a write the app makes.`);
    const repo = `${m[1]}/${m[2]}`;
    const rest = m[3];
    let body: Record<string, unknown> = {};
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body); } catch { throw new WriteBlockedError('unreadable request body.'); }
    }
    if (method === 'POST' && (rest === 'git/trees' || rest === 'git/commits' || rest === 'git/blobs')) {
      // Objects only; they change nothing until a ref points at them.
    } else if (method === 'POST' && rest === 'git/refs') {
      const ref = String(body.ref ?? '');
      if (!ref.startsWith('refs/heads/')) throw new WriteBlockedError(`only branches can be created, not ${ref}.`);
      assertWritableBranch(repo, ref.slice('refs/heads/'.length), opts, 'create');
    } else if ((method === 'PATCH' || method === 'DELETE') && rest.startsWith('git/refs/heads/')) {
      if (method === 'PATCH' && body.force === true) throw new WriteBlockedError('force-moving a branch is not allowed.');
      assertWritableBranch(repo, rest.slice('git/refs/heads/'.length), opts);
    } else if (method === 'POST' && rest === 'graphql') {
      throw new WriteBlockedError('GraphQL requests go to /graphql, not a repo path.');
    } else if (method === 'POST' && rest === 'pulls') {
      const head = String(body.head ?? '');
      assertWritableBranch(repo, head.includes(':') ? head.split(':')[1] : head, opts);
    } else {
      throw new WriteBlockedError(`${method} ${rest} is not a write the app makes.`);
    }
    return baseFetch(input, init);
  }) as typeof fetch;
}
