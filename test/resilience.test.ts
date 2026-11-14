import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RepoRef } from '../src/shared/ipc.js';
import { createGitHubClient } from '../src/main/github/client.js';
import { TokenStore, type SecretBox } from '../src/main/app/secrets.js';
import { AppService, type ServiceDeps } from '../src/main/app/service.js';
import { createSettingsStore } from '../src/main/app/settings.js';
import { openDatabase } from '../src/main/products/db.js';
import { HttpCache } from '../src/main/products/httpcache.js';
import { ProductStore } from '../src/main/products/store.js';
import { fakeGitHub } from './fakeGitHub.js';
import { tmp } from './helpers.js';

const OWNER = 'gonzalovazquez';
const repo = (name: string): RepoRef => ({ owner: OWNER, name, fullName: `${OWNER}/${name}`, defaultBranch: 'main', private: true, htmlUrl: '' });
const ROLES = { artifacts: repo('pm-artifacts'), crm: repo('pm-crm'), pdr: repo('pm-pdr') };
const must = <T>(r: { ok: true; value: T } | { ok: false; message: string }): T => { if (!r.ok) throw new Error(r.message); return r.value; };

function box(): SecretBox { let s = ''; return { isAvailable: () => true, encrypt: (p) => { s = p; return Buffer.from(p); }, decrypt: () => s }; }

async function setup() {
  const dir = tmp();
  let clock = new Date('2026-11-14T12:00:00Z');
  const gh = fakeGitHub(OWNER, {
    'pm-artifacts': { files: { 'README.md': '# A\n', 'control-book/cb.md': '# CB\n' } },
    'pm-crm': { files: { 'customers/acme.md': '# Acme\n\n## Call\nHi.\n' } },
    'pm-pdr': { files: { 'specs/s.md': '# S\n' } },
  });
  // Tokens GitHub accepts; anything else gets a 401, like a revoked token.
  const valid = new Set(['ghp_good', 'ghp_new']);
  const fetchFor = (token: string) => (async (input: RequestInfo | URL, init?: RequestInit) =>
    (valid.has(token) ? gh.fetch(input, init) : new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401, headers: { 'content-type': 'application/json' } }))) as typeof fetch;
  const db = openDatabase(join(dir, 'products.db'));
  const deps: ServiceDeps = {
    settings: createSettingsStore(join(dir, 'settings.json')),
    tokens: new TokenStore(join(dir, 'token.bin'), box(), {}),
    products: new ProductStore(db, () => clock),
    cache: new HttpCache(db, () => clock),
    createClient: (host, token, guard, hooks) => createGitHubClient(host, token, fetchFor(token), guard, hooks),
    files: { saveText: async () => null, openText: async () => null },
    now: () => clock,
  };
  await deps.settings.save({ repoRoles: ROLES });
  const svc = new AppService(deps);
  must(await svc.signIn('github.com', 'ghp_good'));
  await svc.getSettings();
  const p = must(await svc.createProduct({ name: 'Checkout', objective: 'o', kpis: [] }));
  must(await svc.addLinks(p.id, [{ role: 'artifacts', kind: 'artifact', path: 'control-book/cb.md', title: 'CB', artifactType: 'control-book', stage: 'solution' }]));
  return { svc, deps, gh, valid, productId: p.id, setClock: (d: Date) => { clock = d; } };
}

describe('an expired or revoked token', () => {
  it('sends the PM to sign-in, forgets the dead token and keeps every product, link and setting', async () => {
    const { svc, deps, valid, productId } = await setup();
    must(await svc.syncProduct(productId));
    valid.delete('ghp_good'); // revoked on GitHub
    await svc.syncProduct(productId);
    await new Promise((r) => setTimeout(r, 10)); // the dead token is forgotten just after sign-out
    expect(svc.getAuth()).toMatchObject({ status: 'signed-out', host: 'github.com', reason: expect.stringMatching(/no longer accepts your token/) });
    expect((await deps.tokens.get()).token).toBeUndefined();
    // Local data is untouched and still readable while signed out.
    const home = must(await svc.getProduct(productId));
    expect(home.links.map((l) => [l.title, l.stage])).toEqual([['CB', 'solution']]);
    expect((await svc.getSettings()).repoRoles.artifacts?.fullName).toBe(`${OWNER}/pm-artifacts`);
    // A new token picks up where it left off.
    must(await svc.signIn('github.com', 'ghp_new'));
    expect(must(await svc.syncProduct(productId)).links[0].health.state).toBe('ok');
  });

  it('a bad token typed into "change token" does not sign out the working session', async () => {
    const { svc } = await setup();
    expect((await svc.signIn('github.com', 'ghp_typo')).ok).toBe(false);
    expect(svc.getAuth()).toMatchObject({ status: 'signed-in' });
  });
});

describe('rate limits', () => {
  it('backs off until GitHub’s reset time: no requests, cached data, a reason; then resumes', async () => {
    const { svc, gh, productId, setClock } = await setup();
    must(await svc.syncProduct(productId));
    const browsed = must(await svc.browseTree('artifacts', ''));
    gh.state.rateLimited = true; // the fake's reset is 1794700000 = 2026-11-14T23:46:40Z
    let home = must(await svc.syncProduct(productId));
    expect(home.sync.lastError).toMatch(/rate limit/);
    gh.log.length = 0;
    home = must(await svc.syncProduct(productId));
    expect(gh.log).toEqual([]); // backing off: nothing sent
    expect(home.sync.lastError).toMatch(/waiting rather than retrying/);
    expect(home.links[0].health.state).toBe('ok');
    expect(must(await svc.browseTree('artifacts', ''))).toEqual(browsed); // from cache
    expect((await svc.previewWrite({ kind: 'edit-artifact', linkId: home.links[0].id, content: 'x' })).ok).toBe(false);
    expect(gh.log).toEqual([]);
    gh.state.rateLimited = false;
    setClock(new Date('2026-11-14T23:50:00Z'));
    home = must(await svc.syncProduct(productId));
    expect(gh.log.length).toBeGreaterThan(0);
    expect(home.sync.lastError).toBeUndefined();
  });
});

describe('offline', () => {
  it('the repo browser and previews keep working from their last good answer', async () => {
    const { svc, gh } = await setup();
    const tree = must(await svc.browseTree('artifacts', ''));
    const file = must(await svc.readFile('artifacts', 'control-book/cb.md'));
    gh.state.offline = true;
    expect(must(await svc.browseTree('artifacts', ''))).toEqual(tree);
    expect(must(await svc.readFile('artifacts', 'control-book/cb.md'))).toEqual(file);
    expect((await svc.readFile('artifacts', 'README.md')).ok).toBe(false); // never seen, nothing to show
  });
});

describe('a write interrupted mid-flight', () => {
  it('leaves no orphan branch: one with no pull request is deleted on the next run', async () => {
    const { deps, gh } = await setup();
    // State as a crash right after the branch was created would leave it.
    deps.products.recordWrite({ role: 'artifacts', repoHost: 'github.com', repo: `${OWNER}/pm-artifacts`, base: 'main', branch: 'pmworkbench/problem-brief/x-20261114', title: 't', paths: ['x.md'] });
    const c = createGitHubClient('github.com', 'ghp_good', gh.fetch, { defaultBranches: () => ({}) });
    await c.createBranch(ROLES.artifacts, 'pmworkbench/problem-brief/x-20261114', (await c.branchHead(ROLES.artifacts, 'main'))!);
    expect(gh.branchNames('pm-artifacts')).toEqual(['pmworkbench/problem-brief/x-20261114']);
    await new AppService(deps).init();
    expect(gh.branchNames('pm-artifacts')).toEqual([]);
    expect(deps.products.writes()).toEqual([]);
  });

  it('one whose pull request did open is completed, and its item linked as planned', async () => {
    const { deps, gh, productId } = await setup();
    const branch = 'pmworkbench/specification/y-20261114';
    deps.products.recordWrite({
      productId, role: 'artifacts', repoHost: 'github.com', repo: `${OWNER}/pm-artifacts`, base: 'main', branch, title: 'Add spec', paths: ['specs/y.md'],
      linkPlan: { role: 'artifacts', kind: 'artifact', repoHost: 'github.com', repoFullName: `${OWNER}/pm-artifacts`, path: 'specs/y.md', title: 'Y', artifactType: 'specification', stage: 'specification' },
    });
    const c = createGitHubClient('github.com', 'ghp_good', gh.fetch, { defaultBranches: () => ({}) });
    await c.createBranch(ROLES.artifacts, branch, (await c.branchHead(ROLES.artifacts, 'main'))!);
    const pr = await c.openPull(ROLES.artifacts, { title: 'Add spec', body: '', head: branch, base: 'main' });
    await new AppService(deps).init();
    expect(deps.products.writes()[0]).toMatchObject({ branch, prNumber: pr.number });
    expect(deps.products.links(productId).find((l) => l.path === 'specs/y.md')).toMatchObject({ pending: { prNumber: pr.number, branch }, stage: 'specification' });
    expect(gh.branchNames('pm-artifacts')).toEqual([branch]);
  });
});
