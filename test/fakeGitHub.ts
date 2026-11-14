import { createHash } from 'node:crypto';

/**
 * An in-memory GitHub REST API, served through `fetch` so the real Octokit client (including its
 * 304 handling) runs against it. Covers what the app reads: the user, trees, commits for a path,
 * blobs, contents, pull requests and reviews. Every response carries an ETag and honours
 * If-None-Match, like GitHub.
 */
export interface FakePull {
  title: string;
  state: 'open' | 'closed';
  merged?: boolean;
  draft?: boolean;
  updatedAt?: string;
  requested?: string[];
  reviews?: { login: string; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED'; at: string }[];
}

export interface FakeRepo {
  files: Record<string, string>;
  /** When each path last changed, and by whom; defaults to a fixed date. */
  changed?: Record<string, { at: string; by: string }>;
  pulls?: Record<number, FakePull>;
}

export const blobSha = (content: string) => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0${content}`).digest('hex');

export function fakeGitHub(owner: string, repos: Record<string, FakeRepo>) {
  const log: { path: string; status: number }[] = [];
  const state = { offline: false, rateLimited: false };

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    if (state.offline) throw new TypeError('fetch failed: getaddrinfo ENOTFOUND api.github.com');
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const reply = (status: number, body: unknown, extra: Record<string, string> = {}) => {
      log.push({ path: url.pathname, status });
      return new Response(status === 304 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });
    };
    if (state.rateLimited) return reply(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1794700000' });
    const ok = (body: unknown) => {
      const etag = `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;
      if (headers.get('if-none-match') === etag) return reply(304, null, { etag });
      return reply(200, body, { etag });
    };
    const notFound = () => reply(404, { message: 'Not Found' });

    const p = url.pathname;
    if (p === '/user') return ok({ login: 'gonzo' });
    const m = /^\/repos\/([^/]+)\/([^/]+)\/(.*)$/.exec(p);
    if (!m || m[1] !== owner || !repos[m[2]]) return notFound();
    const repo = repos[m[2]];
    const rest = decodeURIComponent(m[3]);
    const changed = (path: string) => repo.changed?.[path] ?? { at: '2026-10-01T00:00:00Z', by: 'gonzo' };

    if (rest === 'git/trees/main') {
      return ok({ sha: 'tree', truncated: false, tree: Object.entries(repo.files).map(([path, c]) => ({ path, type: 'blob', sha: blobSha(c) })) });
    }
    if (rest === 'commits') {
      const path = url.searchParams.get('path') ?? '';
      if (!(path in repo.files)) return ok([]);
      const c = changed(path);
      return ok([{ sha: `c-${path}`, commit: { committer: { date: c.at }, author: { name: c.by, date: c.at } }, author: { login: c.by } }]);
    }
    let x;
    if ((x = /^git\/blobs\/([0-9a-f]+)$/.exec(rest))) {
      const content = Object.values(repo.files).find((c) => blobSha(c) === x![1]);
      return content === undefined ? notFound() : ok({ sha: x[1], content: Buffer.from(content).toString('base64'), encoding: 'base64' });
    }
    if ((x = /^contents\/(.+)$/.exec(rest))) {
      const content = repo.files[x[1]];
      if (content === undefined) return notFound();
      return ok({ type: 'file', path: x[1], name: x[1].split('/').pop(), sha: blobSha(content), content: Buffer.from(content).toString('base64'), encoding: 'base64', html_url: `https://github.com/${owner}/${m[2]}/blob/main/${x[1]}` });
    }
    if ((x = /^pulls\/(\d+)(\/reviews)?$/.exec(rest))) {
      const pr = repo.pulls?.[Number(x[1])];
      if (!pr) return notFound();
      if (x[2]) return ok((pr.reviews ?? []).map((r, i) => ({ id: i, user: { login: r.login }, state: r.state, submitted_at: r.at })));
      return ok({
        number: Number(x[1]), title: pr.title, state: pr.state, merged: !!pr.merged, merged_at: pr.merged ? '2026-11-01T00:00:00Z' : null, draft: !!pr.draft,
        updated_at: pr.updatedAt ?? '2026-11-01T00:00:00Z', requested_reviewers: (pr.requested ?? []).map((login) => ({ login })),
        user: { login: 'gonzo' }, body: '', html_url: `https://github.com/${owner}/${m[2]}/pull/${x[1]}`, base: { ref: 'develop' }, head: { ref: 'spec' },
      });
    }
    return notFound();
  }) as typeof fetch;

  return { fetch: fetchImpl, log, state, repos };
}
