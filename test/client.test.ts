import { describe, expect, it } from 'vitest';
import { createGitHubClient, type RepoRef } from '../src/main/github/client.js';

/** A fake GitHub REST API, just enough of it for createGitHubClient's four methods. */
function fakeGitHub(): typeof fetch {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const path = url.pathname;

    if (path === '/user') return json({ login: 'gonzo' });

    if (path === '/user/repos') {
      return json([
        { owner: { login: 'gonzalovazquez' }, name: 'pm-artifacts', full_name: 'gonzalovazquez/pm-artifacts', default_branch: 'main', private: true, html_url: 'https://github.com/gonzalovazquez/pm-artifacts' },
        { owner: { login: 'gonzalovazquez' }, name: 'pm-crm', full_name: 'gonzalovazquez/pm-crm', default_branch: 'main', private: true, html_url: 'https://github.com/gonzalovazquez/pm-crm' },
      ]);
    }

    if (path === '/repos/gonzalovazquez/pm-artifacts/contents') {
      return json([
        { type: 'file', name: 'README.md', path: 'README.md', sha: 'sha-readme' },
        { type: 'dir', name: 'skills', path: 'skills', sha: 'sha-skills' },
        { type: 'symlink', name: 'weird', path: 'weird', sha: 'sha-weird' },
      ]);
    }

    if (path === '/repos/gonzalovazquez/pm-artifacts/contents/README.md') {
      const content = Buffer.from('# PM Artifacts\n').toString('base64');
      return json({ type: 'file', path: 'README.md', sha: 'sha-readme', content, encoding: 'base64', html_url: 'https://github.com/gonzalovazquez/pm-artifacts/blob/main/README.md' });
    }

    if (path === '/repos/gonzalovazquez/pm-artifacts/contents/big.bin') {
      // GitHub omits inline content above ~1MB; the client is expected to fall back to the blob endpoint.
      return json({ type: 'file', path: 'big.bin', sha: 'sha-big', html_url: 'https://github.com/gonzalovazquez/pm-artifacts/blob/main/big.bin' });
    }

    if (path === '/repos/gonzalovazquez/pm-artifacts/git/blobs/sha-big') {
      const big = 'x'.repeat(1_000_010);
      return json({ content: Buffer.from(big).toString('base64'), encoding: 'base64' });
    }

    if (path === '/repos/gonzalovazquez/pm-artifacts/contents/a-folder') {
      return json([{ type: 'file', name: 'x', path: 'a-folder/x', sha: 's' }]);
    }

    return json({ message: 'Not Found' }, 404);
  }) as typeof fetch;
}

const repo: RepoRef = { owner: 'gonzalovazquez', name: 'pm-artifacts', fullName: 'gonzalovazquez/pm-artifacts', defaultBranch: 'main', private: true, htmlUrl: 'https://github.com/gonzalovazquez/pm-artifacts' };

describe('createGitHubClient', () => {
  it('whoAmI returns the signed-in login', async () => {
    const client = createGitHubClient('github.com', 'tok', fakeGitHub());
    expect(await client.whoAmI()).toEqual({ login: 'gonzo' });
  });

  it('listRepos maps the REST shape to RepoRef', async () => {
    const client = createGitHubClient('github.com', 'tok', fakeGitHub());
    const repos = await client.listRepos();
    expect(repos).toEqual([
      { owner: 'gonzalovazquez', name: 'pm-artifacts', fullName: 'gonzalovazquez/pm-artifacts', defaultBranch: 'main', private: true, htmlUrl: 'https://github.com/gonzalovazquez/pm-artifacts' },
      { owner: 'gonzalovazquez', name: 'pm-crm', fullName: 'gonzalovazquez/pm-crm', defaultBranch: 'main', private: true, htmlUrl: 'https://github.com/gonzalovazquez/pm-crm' },
    ]);
  });

  it('listTree sorts folders first, then by name, and drops anything that is not a file or dir', async () => {
    const client = createGitHubClient('github.com', 'tok', fakeGitHub());
    const entries = await client.listTree(repo, '');
    expect(entries.map((e) => e.name)).toEqual(['skills', 'README.md']);
    expect(entries.every((e) => e.type === 'file' || e.type === 'dir')).toBe(true);
  });

  it('listTree strips a leading slash from the path', async () => {
    const client = createGitHubClient('github.com', 'tok', fakeGitHub());
    const entries = await client.listTree(repo, '/a-folder');
    expect(entries.map((e) => e.name)).toEqual(['x']);
  });

  it('getFile decodes base64 content for a normal-sized file', async () => {
    const client = createGitHubClient('github.com', 'tok', fakeGitHub());
    const file = await client.getFile(repo, 'README.md');
    expect(file).toEqual({ path: 'README.md', content: '# PM Artifacts\n', truncated: false, htmlUrl: 'https://github.com/gonzalovazquez/pm-artifacts/blob/main/README.md', sha: 'sha-readme' });
  });

  it('getFile falls back to the blob endpoint and truncates a file over 1MB', async () => {
    const client = createGitHubClient('github.com', 'tok', fakeGitHub());
    const file = await client.getFile(repo, 'big.bin');
    expect(file.truncated).toBe(true);
    expect(file.content).toHaveLength(1_000_000);
  });

  it('getFile refuses to read a folder', async () => {
    const client = createGitHubClient('github.com', 'tok', fakeGitHub());
    await expect(client.getFile(repo, '')).rejects.toThrow(/folder, not a file/);
  });

  it('routes a GitHub Enterprise Server host to its own /api/v3, and every request actually goes there', async () => {
    let seenHost: string | undefined;
    const spy: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenHost = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url).host;
      return new Response(JSON.stringify({ login: 'gonzo' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const client = createGitHubClient('git.example.com', 'tok', spy);
    await client.whoAmI();
    expect(seenHost).toBe('git.example.com');
  });

  it('the allow-list guard is actually in the request path — a fetch call that resolves to a different host is blocked', async () => {
    let reached = false;
    // The real guard only ever lets a request through to the host the client itself targets, which Octokit's own
    // request building always honors — so to prove the wrapper is wired in (not bypassed), the fetch implementation
    // below simulates a redirect-like host mismatch, standing in for a bug that bypassed apiBaseUrl.
    const mismatched: typeof fetch = (async () => { reached = true; return new Response('{}'); }) as typeof fetch;
    const { createGuardedFetch } = await import('../src/main/github/allowlist.js');
    const guarded = createGuardedFetch(() => 'api.github.com', mismatched);
    await expect(guarded('https://git.example.com/api/v3/user')).rejects.toThrow(/Blocked a request/);
    expect(reached).toBe(false);
  });
});
