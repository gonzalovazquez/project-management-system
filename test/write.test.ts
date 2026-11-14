import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RepoRef } from '../src/shared/ipc.js';
import { ARTIFACT_TYPES, type ArtifactType } from '../src/shared/products.js';
import type { WriteDraft } from '../src/shared/writes.js';
import { createGitHubClient } from '../src/main/github/client.js';
import { TokenStore, type SecretBox } from '../src/main/app/secrets.js';
import { AppService } from '../src/main/app/service.js';
import { createSettingsStore } from '../src/main/app/settings.js';
import { openDatabase } from '../src/main/products/db.js';
import { HttpCache } from '../src/main/products/httpcache.js';
import { ProductStore } from '../src/main/products/store.js';
import { unifiedDiff } from '../src/main/write/diff.js';
import { createWriteGuard, WriteBlockedError } from '../src/main/write/guard.js';
import { fakeGitHub, type FakeRepo } from './fakeGitHub.js';
import { tmp } from './helpers.js';

const OWNER = 'gonzalovazquez';
const repo = (name: string): RepoRef => ({ owner: OWNER, name, fullName: `${OWNER}/${name}`, defaultBranch: 'main', private: true, htmlUrl: '' });
const ROLES = { artifacts: repo('pm-artifacts'), crm: repo('pm-crm'), pdr: repo('pm-pdr') };
const CONTROL = '# Control Book\n\n## Scope\n- retry timing\n';

const repos = (): Record<string, FakeRepo> => ({
  'pm-artifacts': { files: { 'README.md': '# PM Artifacts\n', 'control-book/checkout-retry-flow.md': CONTROL } },
  'pm-crm': { files: { 'customers/acme.md': '# Acme\n' } },
  'pm-pdr': { files: { 'specs/spec-003.md': '# SPEC\n' } },
});

const box = (): SecretBox => { let s = ''; return { isAvailable: () => true, encrypt: (p) => { s = p; return Buffer.from(p); }, decrypt: () => s }; };
const must = <T>(r: { ok: true; value: T } | { ok: false; message: string }): T => {
  if (!r.ok) throw new Error(r.message);
  return r.value;
};

async function setup() {
  const dir = tmp();
  const settings = createSettingsStore(join(dir, 'settings.json'));
  await settings.save({ repoRoles: ROLES });
  const gh = fakeGitHub(OWNER, repos());
  const db = openDatabase(':memory:');
  const products = new ProductStore(db);
  const svc = new AppService({
    settings, tokens: new TokenStore(join(dir, 'token.bin'), box(), {}), products, cache: new HttpCache(db),
    createClient: (host, token, guard) => createGitHubClient(host, token, gh.fetch, guard),
    files: { saveText: async () => null, openText: async () => null },
  });
  must(await svc.signIn('github.com', 'ghp_x'));
  await svc.getSettings(); // primes the write guard's default-branch list
  const p = must(await svc.createProduct({ name: 'Checkout retry', objective: 'o', kpis: [] }));
  return { svc, gh, products, productId: p.id };
}

const writes = (gh: ReturnType<typeof fakeGitHub>) => gh.log.filter((r) => r.method !== 'GET');
const create = (productId: string, over: Partial<Extract<WriteDraft, { kind: 'create-artifact' }>> = {}): WriteDraft => ({
  kind: 'create-artifact', productId, artifactType: 'problem-brief', path: 'briefs/checkout-retry-problem.md', title: 'Checkout retry problem', content: '# Problem\n\nCustomers abandon checkout.\n', ...over,
});

describe('network write guard', () => {
  const opts = { defaultBranches: () => ({ 'o/r': 'trunk-ish' }) };
  const passed: string[] = [];
  const base = (async (input: RequestInfo | URL, init?: RequestInit) => { passed.push(`${init?.method ?? 'GET'} ${String(input)}`); return new Response('{}'); }) as typeof fetch;
  const g = createWriteGuard(opts, base);
  const call = (method: string, path: string, body?: unknown) => g(`https://api.github.com/repos/o/r/${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });

  it.each([
    ['POST', 'git/refs', { ref: 'refs/heads/main', sha: 'x' }],
    ['POST', 'git/refs', { ref: 'refs/heads/feature/x', sha: 'x' }],
    ['POST', 'git/refs', { ref: 'refs/tags/v1', sha: 'x' }],
    ['PATCH', 'git/refs/heads/main', { sha: 'x' }],
    ['PATCH', 'git/refs/heads/develop', { sha: 'x' }],
    ['PATCH', 'git/refs/heads/trunk-ish', { sha: 'x' }],
    ['PATCH', 'git/refs/heads/pmworkbench/x', { sha: 'x', force: true }],
    ['DELETE', 'git/refs/heads/main', undefined],
    ['PUT', 'contents/README.md', { content: 'x', branch: 'main' }],
    ['PUT', 'pulls/1/merge', {}],
    ['POST', 'merges', { base: 'main', head: 'x' }],
    ['POST', 'pulls', { head: 'main', base: 'develop', title: 't' }],
    ['DELETE', 'git/refs/heads/someone-elses-branch', undefined],
  ])('refuses %s %s %j', async (method, path, body) => {
    await expect(call(method, path, body)).rejects.toBeInstanceOf(WriteBlockedError);
  });

  it('lets reads through, and only the engine’s writes to its own branches', async () => {
    passed.length = 0;
    await call('GET', 'git/ref/heads/main');
    await call('POST', 'git/trees', { tree: [] });
    await call('POST', 'git/commits', { tree: 't', parents: [] });
    await call('POST', 'git/refs', { ref: 'refs/heads/pmworkbench/problem-brief/x-20261114', sha: 'x' });
    await call('PATCH', 'git/refs/heads/pmworkbench/problem-brief/x-20261114', { sha: 'y', force: false });
    await call('POST', 'pulls', { head: 'pmworkbench/problem-brief/x-20261114', base: 'main', title: 't' });
    await call('DELETE', 'git/refs/heads/pmworkbench/problem-brief/x-20261114');
    expect(passed).toHaveLength(7);
  });

  it('stops a direct attempt on the default branch before any request is sent, even from the client itself', async () => {
    const { gh } = await setup();
    const client = createGitHubClient('github.com', 't', gh.fetch, { defaultBranches: () => ({ [`${OWNER}/pm-artifacts`]: 'main' }) });
    gh.log.length = 0;
    // Octokit wraps what its fetch throws; the guard's error is the cause.
    const cause = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { cause?: unknown }).cause; } };
    expect(await cause(client.moveBranch(ROLES.artifacts, 'main', 'abc'))).toBeInstanceOf(WriteBlockedError);
    expect(await cause(client.createBranch(ROLES.artifacts, 'main', 'abc'))).toBeInstanceOf(WriteBlockedError);
    expect(await cause(client.openPull(ROLES.artifacts, { title: 't', body: '', head: 'main', base: 'develop' }))).toBeInstanceOf(WriteBlockedError);
    expect(gh.log).toEqual([]);
  });
});

describe('diff', () => {
  it('produces unified hunks with context', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n') + '\n';
    const after = ['a', 'b', 'c', 'd', 'E', 'f', 'g', 'h', 'i', 'j', 'k'].join('\n') + '\n';
    const d = unifiedDiff(before, after, 'x.md');
    expect(d).toMatchObject({ added: 2, removed: 1 });
    expect(d.diff.split('\n').slice(0, 3)).toEqual(['--- a/x.md', '+++ b/x.md', '@@ -2,9 +2,10 @@']);
    expect(d.diff).toContain('-e\n+E');
    expect(unifiedDiff(null, 'x\ny\n', 'n.md').diff).toBe('--- /dev/null\n+++ b/n.md\n@@ -0,0 +1,2 @@\n+x\n+y');
  });
});

describe('write engine', () => {
  it('previewing sends nothing to GitHub and shows the branch, diff and pull request', async () => {
    const { svc, gh, productId } = await setup();
    gh.log.length = 0;
    const pv = must(await svc.previewWrite(create(productId)));
    expect(writes(gh)).toEqual([]);
    expect(pv).toMatchObject({
      repo: `${OWNER}/pm-artifacts`, base: 'main', branch: expect.stringMatching(/^pmworkbench\/problem-brief\/checkout-retry-problem-\d{8}$/),
      files: [{ path: 'briefs/checkout-retry-problem.md', change: 'create', added: 3, removed: 0 }],
      title: 'Add problem brief: Checkout retry problem',
    });
    expect(pv.body).toContain('for the product **Checkout retry**');
  });

  it('creates one artifact of each type, each as exactly one pull request, never touching main', async () => {
    const { svc, gh, products, productId } = await setup();
    const mainBefore = { ...gh.repos['pm-artifacts'].files };
    for (const t of ARTIFACT_TYPES as readonly ArtifactType[]) {
      const pv = must(await svc.previewWrite(create(productId, { artifactType: t, path: `new/${t}.md`, title: `New ${t}` })));
      const r = must(await svc.confirmWrite(pv.id));
      expect(r.addedToExisting).toBe(false);
      expect(gh.filesAt('pm-artifacts', r.branch)?.[`new/${t}.md`]).toBeDefined();
    }
    expect(gh.appPulls('pm-artifacts')).toHaveLength(ARTIFACT_TYPES.length);
    expect(gh.appPulls('pm-artifacts').every((p) => p.base === 'main' && p.head.startsWith('pmworkbench/'))).toBe(true);
    expect(gh.repos['pm-artifacts'].files).toEqual(mainBefore);
    expect(writes(gh).filter((w) => /git\/refs\/heads\/main$/.test(w.path))).toEqual([]);
    // Each is linked to the product, pending, and placed in its type's stage.
    const links = products.links(productId);
    expect(links).toHaveLength(ARTIFACT_TYPES.length);
    expect(links.every((l) => l.pending && l.pending.branch.startsWith('pmworkbench/'))).toBe(true);
    expect(Object.fromEntries(links.map((l) => [l.artifactType, l.stage ?? null]))).toEqual({
      'problem-brief': 'problem', 'solution-brief': 'solution', specification: 'specification', 'control-book': null, 'exec-comm': 'release', other: null,
    });
    expect(products.writes()).toHaveLength(ARTIFACT_TYPES.length);
  });

  it('a preview is single use', async () => {
    const { svc, productId } = await setup();
    const pv = must(await svc.previewWrite(create(productId)));
    must(await svc.confirmWrite(pv.id));
    expect(await svc.confirmWrite(pv.id)).toMatchObject({ ok: false, message: expect.stringMatching(/expired or was already sent/) });
    expect(await svc.confirmWrite('made-up')).toMatchObject({ ok: false });
  });

  it('refuses to create over an existing file, or bad input', async () => {
    const { svc, productId } = await setup();
    expect(await svc.previewWrite(create(productId, { path: 'control-book/checkout-retry-flow.md' }))).toMatchObject({ ok: false, message: expect.stringMatching(/already exists/) });
    expect((await svc.previewWrite(create(productId, { path: '../escape.md' }))).ok).toBe(false);
    expect((await svc.previewWrite(create(productId, { path: 'notes.txt' }))).ok).toBe(false);
    expect((await svc.previewWrite(create(productId, { title: ' ' }))).ok).toBe(false);
    expect((await svc.previewWrite({ kind: 'delete-everything' } as unknown as WriteDraft)).ok).toBe(false);
  });

  it('edits open a pull request, and a second edit to the same file adds a commit to it instead of a second PR', async () => {
    const { svc, gh, products, productId } = await setup();
    must(await svc.addLinks(productId, [{ role: 'artifacts', kind: 'artifact', path: 'control-book/checkout-retry-flow.md', title: 'Control book', artifactType: 'control-book' }]));
    const [link] = products.links(productId);
    expect(must(await svc.editSource(link.id))).toMatchObject({ from: 'default-branch', content: CONTROL });

    const pv1 = must(await svc.previewWrite({ kind: 'edit-artifact', linkId: link.id, content: CONTROL + '- max retries\n' }));
    expect(pv1.files[0]).toMatchObject({ change: 'update', added: 1, removed: 0 });
    const r1 = must(await svc.confirmWrite(pv1.id));
    expect(r1.addedToExisting).toBe(false);

    const src = must(await svc.editSource(link.id));
    expect(src).toMatchObject({ from: 'pull-request', pr: { number: r1.prNumber }, content: CONTROL + '- max retries\n' });
    const pv2 = must(await svc.previewWrite({ kind: 'edit-artifact', linkId: link.id, content: src.content + '- countdown\n' }));
    expect(pv2.existingPr?.number).toBe(r1.prNumber);
    expect(pv2.branch).toBe(r1.branch);
    const r2 = must(await svc.confirmWrite(pv2.id));
    expect(r2).toMatchObject({ addedToExisting: true, prNumber: r1.prNumber, branch: r1.branch });
    expect(gh.appPulls('pm-artifacts')).toHaveLength(1);
    expect(gh.filesAt('pm-artifacts', r1.branch)?.['control-book/checkout-retry-flow.md']).toBe(CONTROL + '- max retries\n- countdown\n');
    expect(gh.repos['pm-artifacts'].files['control-book/checkout-retry-flow.md']).toBe(CONTROL);
    expect((await svc.previewWrite({ kind: 'edit-artifact', linkId: link.id, content: src.content + '- countdown\n' })).ok).toBe(false); // nothing changed
  });

  it('stale base: the file changed on main after the preview, so nothing is written', async () => {
    const { svc, gh, products, productId } = await setup();
    must(await svc.addLinks(productId, [{ role: 'artifacts', kind: 'artifact', path: 'control-book/checkout-retry-flow.md', title: 'CB', artifactType: 'control-book' }]));
    const [link] = products.links(productId);
    const pv = must(await svc.previewWrite({ kind: 'edit-artifact', linkId: link.id, content: 'mine\n' }));
    gh.repos['pm-artifacts'].files['control-book/checkout-retry-flow.md'] = 'someone else\n';
    gh.log.length = 0;
    expect(await svc.confirmWrite(pv.id)).toMatchObject({ ok: false, message: expect.stringMatching(/changed on main since the preview/) });
    expect(writes(gh)).toEqual([]);
    expect(gh.branchNames('pm-artifacts')).toEqual([]);
  });

  it('branch name collision after the preview: clear message, nothing left behind', async () => {
    const { svc, gh, productId } = await setup();
    const pv = must(await svc.previewWrite(create(productId)));
    // Someone (or another window) takes the name between preview and confirm.
    const other = must(await svc.previewWrite(create(productId, { path: 'briefs/other.md' })));
    expect(other.branch).toBe(pv.branch); // both previews saw the name free
    must(await svc.confirmWrite(other.id));
    expect(await svc.confirmWrite(pv.id)).toMatchObject({ ok: false, message: expect.stringMatching(/already exists/) });
    expect(gh.appPulls('pm-artifacts')).toHaveLength(1);
    expect(gh.branchNames('pm-artifacts')).toEqual([other.branch]);
  });

  it('missing write permission: clear message, no branch', async () => {
    const { svc, gh, productId } = await setup();
    const pv = must(await svc.previewWrite(create(productId)));
    gh.state.readOnly = true;
    expect(await svc.confirmWrite(pv.id)).toMatchObject({ ok: false, message: expect.stringMatching(/can't write to gonzalovazquez\/pm-artifacts/) });
    expect(gh.branchNames('pm-artifacts')).toEqual([]);
  });

  it('a protected-branch rejection is explained', async () => {
    const { svc, gh, products, productId } = await setup();
    must(await svc.addLinks(productId, [{ role: 'artifacts', kind: 'artifact', path: 'control-book/checkout-retry-flow.md', title: 'CB', artifactType: 'control-book' }]));
    const [link] = products.links(productId);
    must(await svc.confirmWrite(must(await svc.previewWrite({ kind: 'edit-artifact', linkId: link.id, content: 'v2\n' })).id));
    const pv = must(await svc.previewWrite({ kind: 'edit-artifact', linkId: link.id, content: 'v3\n' }));
    gh.state.protectRefs = true;
    expect(await svc.confirmWrite(pv.id)).toMatchObject({ ok: false, message: expect.stringMatching(/branch protection rule/) });
  });

  it('if the pull request can’t be opened, the new branch is deleted again', async () => {
    const { svc, gh, products, productId } = await setup();
    const pv = must(await svc.previewWrite(create(productId)));
    gh.state.failOpenPull = true;
    expect((await svc.confirmWrite(pv.id)).ok).toBe(false);
    expect(gh.branchNames('pm-artifacts')).toEqual([]);
    expect(gh.log.some((r) => r.method === 'DELETE')).toBe(true);
    expect(products.links(productId)).toEqual([]);
    expect(products.writes()).toEqual([]);
  });

  it('a new artifact is pending on the board until its pull request merges, then becomes a normal link', async () => {
    const { svc, gh, productId } = await setup();
    const r = must(await svc.confirmWrite(must(await svc.previewWrite(create(productId))).id));
    let home = must(await svc.syncProduct(productId));
    const id = r.linkId!;
    expect(home.links.find((l) => l.id === id)).toMatchObject({ pending: { prNumber: r.prNumber }, health: { state: 'ok' } });
    expect(home.states[id]).toMatchObject({ kind: 'pending', prNumber: r.prNumber, status: 'open' });
    gh.merge('pm-artifacts', r.prNumber);
    home = must(await svc.syncProduct(productId));
    const l = home.links.find((x) => x.id === id)!;
    expect(l.pending).toBeUndefined();
    expect(l.health.state).toBe('ok');
    expect(home.states[id]).toMatchObject({ kind: 'file', exists: true });
  });
});
