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
  /** Commit dates on the PR's branch. */
  commits?: string[];
  createdAt?: string;
  reviews?: { login: string; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED'; at: string }[];
}

export interface FakeRepo {
  files: Record<string, string>;
  /** When each path last changed, and by whom; defaults to a fixed date. */
  changed?: Record<string, { at: string; by: string }>;
  pulls?: Record<number, FakePull>;
}

export const blobSha = (content: string) => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0${content}`).digest('hex');

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

export function fakeGitHub(owner: string, repos: Record<string, FakeRepo>) {
  const log: { path: string; status: number; method: string }[] = [];
  const state = { offline: false, rateLimited: false, readOnly: false, protectRefs: false, failOpenPull: false };

  // A tiny git model per repo: commits are file snapshots; the default branch "main" is always the
  // repo's `files`, and other branches point at commits.
  const commits = new Map<string, { files: Record<string, string>; parent?: string }>();
  const trees = new Map<string, Record<string, string>>();
  const branches = new Map<string, Map<string, string>>(); // repo -> branch -> commit sha
  const pulls = new Map<string, { number: number; head: string; base: string; title: string; body: string; state: 'open' | 'closed'; merged: boolean }[]>();
  const mainHead = (name: string) => {
    const files = { ...repos[name].files };
    const sha = sha1(`main:${JSON.stringify(files)}`);
    if (!commits.has(sha)) commits.set(sha, { files });
    return sha;
  };
  const headOf = (name: string, branch: string) => (branch === 'main' ? mainHead(name) : branches.get(name)?.get(branch));
  const filesAt = (name: string, ref: string | null) => {
    if (!ref || ref === 'main') return repos[name].files;
    const head = branches.get(name)?.get(ref) ?? (commits.has(ref) ? ref : undefined);
    return head ? commits.get(head)!.files : undefined;
  };
  /** Merges an app pull request: its branch's files become the default branch's. */
  const merge = (name: string, number: number) => {
    const pr = pulls.get(name)?.find((p) => p.number === number);
    if (!pr) throw new Error('no such PR');
    repos[name].files = { ...commits.get(branches.get(name)!.get(pr.head)!)!.files };
    pr.state = 'closed';
    pr.merged = true;
  };
  const appPulls = (name: string) => pulls.get(name) ?? [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    if (state.offline) throw new TypeError('fetch failed: getaddrinfo ENOTFOUND api.github.com');
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const method = (init?.method ?? 'GET').toUpperCase();
    const reply = (status: number, body: unknown, extra: Record<string, string> = {}) => {
      log.push({ path: url.pathname, status, method });
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
    const name = m[2];
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};

    if (method !== 'GET') {
      if (state.readOnly) return reply(403, { message: 'Resource not accessible by personal access token' });
      if (method === 'POST' && rest === 'git/trees') {
        const baseFiles = [...commits.values()].find((c) => sha1(`tree:${JSON.stringify(c.files)}`) === body.base_tree)?.files ?? trees.get(body.base_tree) ?? {};
        const files = { ...baseFiles };
        for (const e of body.tree as { path: string; content: string }[]) files[e.path] = e.content;
        const sha = sha1(`tree:${JSON.stringify(files)}`);
        trees.set(sha, files);
        return reply(201, { sha });
      }
      if (method === 'POST' && rest === 'git/commits') {
        const sha = sha1(`commit:${body.tree}:${body.parents.join(',')}:${body.message}`);
        commits.set(sha, { files: { ...trees.get(body.tree)! }, parent: body.parents[0] });
        return reply(201, { sha });
      }
      if (method === 'POST' && rest === 'git/refs') {
        const b = String(body.ref).replace('refs/heads/', '');
        if (headOf(name, b)) return reply(422, { message: 'Reference already exists' });
        if (!branches.has(name)) branches.set(name, new Map());
        branches.get(name)!.set(b, body.sha);
        return reply(201, { ref: body.ref, object: { sha: body.sha } });
      }
      let r;
      if ((r = /^git\/refs\/heads\/(.+)$/.exec(rest))) {
        const b = r[1];
        const cur = branches.get(name)?.get(b);
        if (!cur) return reply(422, { message: 'Reference does not exist' });
        if (method === 'DELETE') { branches.get(name)!.delete(b); return reply(204, null); }
        if (state.protectRefs) return reply(422, { message: 'Protected branch update failed for refs/heads/' + b });
        if (commits.get(body.sha)?.parent !== cur) return reply(422, { message: 'Update is not a fast forward' });
        branches.get(name)!.set(b, body.sha);
        return reply(200, { object: { sha: body.sha } });
      }
      if (method === 'POST' && rest === 'pulls') {
        if (state.failOpenPull) return reply(422, { message: 'Validation Failed: No commits between main and head' });
        const list = pulls.get(name) ?? [];
        const number = 100 + list.length + Object.keys(repo.pulls ?? {}).length;
        list.push({ number, head: body.head, base: body.base, title: body.title, body: body.body, state: 'open', merged: false });
        pulls.set(name, list);
        return reply(201, { number, html_url: `https://github.com/${owner}/${name}/pull/${number}` });
      }
      return reply(404, { message: 'Not Found' });
    }

    let g;
    if ((g = /^git\/ref\/heads\/(.+)$/.exec(rest))) {
      const head = headOf(name, g[1]);
      return head ? ok({ ref: `refs/heads/${g[1]}`, object: { sha: head } }) : notFound();
    }
    if ((g = /^git\/commits\/([0-9a-f]+)$/.exec(rest))) {
      const c = commits.get(g[1]);
      return c ? ok({ sha: g[1], tree: { sha: sha1(`tree:${JSON.stringify(c.files)}`) } }) : notFound();
    }
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
      const at = filesAt(name, url.searchParams.get('ref'));
      const content = at?.[x[1]];
      if (content === undefined) return notFound();
      return ok({ type: 'file', path: x[1], name: x[1].split('/').pop(), sha: blobSha(content), content: Buffer.from(content).toString('base64'), encoding: 'base64', html_url: `https://github.com/${owner}/${m[2]}/blob/main/${x[1]}` });
    }
    if ((x = /^pulls\/(\d+)(\/reviews|\/commits)?$/.exec(rest))) {
      const mine = appPulls(name).find((p) => p.number === Number(x![1]));
      if (mine && !x[2]) {
        return ok({
          number: mine.number, title: mine.title, state: mine.state, merged: mine.merged, merged_at: mine.merged ? '2026-11-14T13:00:00Z' : null, draft: false,
          created_at: '2026-11-14T12:00:00Z', updated_at: '2026-11-14T12:00:00Z', requested_reviewers: [], user: { login: 'gonzo' }, body: mine.body,
          html_url: `https://github.com/${owner}/${name}/pull/${mine.number}`, base: { ref: mine.base }, head: { ref: mine.head },
        });
      }
      if (mine) return ok([]);
      const pr = repo.pulls?.[Number(x[1])];
      if (!pr) return notFound();
      if (x[2] === '/commits') return ok((pr.commits ?? []).map((at, i) => ({ sha: `pc${x![1]}-${i}`, commit: { committer: { date: at }, author: { name: 'gonzo', date: at } }, author: { login: 'gonzo' } })));
      if (x[2]) return ok((pr.reviews ?? []).map((r, i) => ({ id: i, user: { login: r.login }, state: r.state, submitted_at: r.at })));
      return ok({
        number: Number(x[1]), title: pr.title, created_at: pr.createdAt ?? '2026-10-20T00:00:00Z', state: pr.state, merged: !!pr.merged, merged_at: pr.merged ? '2026-11-01T00:00:00Z' : null, draft: !!pr.draft,
        updated_at: pr.updatedAt ?? '2026-11-01T00:00:00Z', requested_reviewers: (pr.requested ?? []).map((login) => ({ login })),
        user: { login: 'gonzo' }, body: '', html_url: `https://github.com/${owner}/${m[2]}/pull/${x[1]}`, base: { ref: 'develop' }, head: { ref: 'spec' },
      });
    }
    return notFound();
  }) as typeof fetch;

  return { fetch: fetchImpl, log, state, repos, merge, appPulls, branchNames: (name: string) => [...(branches.get(name)?.keys() ?? [])], filesAt };
}
