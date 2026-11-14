import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RepoRef } from '../src/shared/ipc.js';
import { createGuardedFetch } from '../src/main/github/allowlist.js';
import { createGitHubClient } from '../src/main/github/client.js';
import { TokenStore, type SecretBox } from '../src/main/app/secrets.js';
import { AppService } from '../src/main/app/service.js';
import { createSettingsStore } from '../src/main/app/settings.js';
import { openDatabase } from '../src/main/products/db.js';
import { HttpCache } from '../src/main/products/httpcache.js';
import { MAPPING_FORMAT, parseMapping } from '../src/main/products/mapping.js';
import { ProductStore } from '../src/main/products/store.js';
import { pullStatus } from '../src/main/products/sync.js';
import type { LinkInput, ProductHome } from '../src/shared/products.js';
import { blobSha, fakeGitHub, type FakeRepo } from './fakeGitHub.js';
import { tmp } from './helpers.js';

const OWNER = 'gonzalovazquez';
let clock = new Date('2026-11-14T12:00:00Z');
const repo = (name: string): RepoRef => ({ owner: OWNER, name, fullName: `${OWNER}/${name}`, defaultBranch: 'main', private: true, htmlUrl: `https://github.com/${OWNER}/${name}` });
const ROLES = { artifacts: repo('pm-artifacts'), crm: repo('pm-crm'), pdr: repo('pm-pdr') };

const ACME = '# Acme Corp\n\n## 2026-09-18 — Checkout retry friction\nCalled in.\n\n## 2026-10-02 — Follow-up\nConfirmed.\n';
const CONTROL = '# Control Book\n';

function testRepos(): Record<string, FakeRepo> {
  return {
    'pm-artifacts': { files: { 'control-book/checkout-retry-flow.md': CONTROL, 'exec-comms/update.md': '# Update\n' }, changed: { 'control-book/checkout-retry-flow.md': { at: '2026-10-05T09:00:00Z', by: 'gonzo' } } },
    'pm-crm': { files: { 'customers/acme-corp.md': ACME } },
    'pm-pdr': { files: { 'specs/spec-003-checkout-retry.md': '# SPEC-003\n' }, pulls: { 3: { title: 'SPEC-003', state: 'open', requested: ['design'], reviews: [{ login: 'payments', state: 'APPROVED', at: '2026-11-02T00:00:00Z' }] } } },
  };
}

const box = (): SecretBox => { let s = ''; return { isAvailable: () => true, encrypt: (p) => { s = p; return Buffer.from(p); }, decrypt: () => s }; };

async function signedInService(opts: { gh?: ReturnType<typeof fakeGitHub>; fetchImpl?: typeof fetch; dbFile?: string; saved?: { text?: string }; open?: () => string | null } = {}) {
  const dir = tmp();
  const settings = createSettingsStore(join(dir, 'settings.json'));
  await settings.save({ repoRoles: ROLES });
  const gh = opts.gh ?? fakeGitHub(OWNER, testRepos());
  const db = openDatabase(opts.dbFile ?? ':memory:');
  const now = () => clock;
  const products = new ProductStore(db, now);
  let fetchImpl = opts.fetchImpl ?? gh.fetch;
  const svc = new AppService({
    settings, tokens: new TokenStore(join(dir, 'token.bin'), box(), {}), products, cache: new HttpCache(db, now), now,
    createClient: (host, token) => createGitHubClient(host, token, (...a) => fetchImpl(...a)),
    files: {
      saveText: async (_name, text) => { if (opts.saved) opts.saved.text = text; return '/tmp/out.json'; },
      openText: async () => opts.open?.() ?? null,
    },
  });
  must(await svc.signIn('github.com', 'ghp_x'));
  return { svc, products, gh, setFetch: (f: typeof fetch) => { fetchImpl = f; } };
}

const must = <T>(r: { ok: true; value: T } | { ok: false; message: string }): T => {
  if (!r.ok) throw new Error(r.message);
  return r.value;
};

const SEED: LinkInput[] = [
  { role: 'artifacts', kind: 'artifact', path: 'control-book/checkout-retry-flow.md', title: 'Control book — Checkout retry', artifactType: 'control-book', blobSha: blobSha(CONTROL) },
  { role: 'crm', kind: 'customer', path: 'customers/acme-corp.md', title: 'Acme Corp', stage: 'intake' },
  { role: 'crm', kind: 'conversation', path: 'customers/acme-corp.md', anchor: '2026-09-18--checkout-retry-friction', title: '2026-09-18 — Checkout retry friction', stage: 'intake' },
  { role: 'pdr', kind: 'decision', path: 'specs/spec-003-checkout-retry.md', title: 'SPEC-003' },
  { role: 'pdr', kind: 'decision', prNumber: 3, title: 'SPEC-003 review', stage: 'specification' },
];

async function seedProduct(svc: AppService) {
  const p = must(await svc.createProduct({ name: 'Checkout retry', objective: 'Cut failed-payment abandonment 20% this quarter', kpis: [{ name: 'Abandonment', target: '-20%' }] }));
  must(await svc.addLinks(p.id, SEED));
  return p;
}

const byTitle = (h: ProductHome, title: string) => h.links.find((l) => l.title === title)!;

/** The product home without ids, timestamps and GitHub-derived fields, which legitimately differ after an import. */
const comparable = (h: ProductHome) => ({
  product: { name: h.product.name, objective: h.product.objective, kpis: h.product.kpis },
  links: h.links
    .map(({ id: _i, productId: _p, createdAt: _c, health: _h, ...rest }) => rest)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
});

describe('products through AppService', () => {
  it('links items from the repo assigned to each role, placing those given a stage', async () => {
    const { svc } = await signedInService();
    const p = await seedProduct(svc);
    const home = must(await svc.getProduct(p.id));
    expect(home.links.map((l) => [l.kind, l.repoFullName, l.stage ?? null])).toEqual([
      ['artifact', `${OWNER}/pm-artifacts`, null],
      ['customer', `${OWNER}/pm-crm`, 'intake'],
      ['conversation', `${OWNER}/pm-crm`, 'intake'],
      ['decision', `${OWNER}/pm-pdr`, null],
      ['decision', `${OWNER}/pm-pdr`, 'specification'],
    ]);
    expect(byTitle(home, 'Acme Corp').stageEnteredAt).toBe(clock.toISOString());
  });

  it('rejects malformed input from the window without touching the database', async () => {
    const { svc, products } = await signedInService();
    expect((await svc.createProduct({ name: '' })).ok).toBe(false);
    expect((await svc.getProduct("1' OR '1'='1")).ok).toBe(false);
    const p = must(await svc.createProduct({ name: 'P', objective: '', kpis: [] }));
    expect((await svc.addLinks(p.id, [{ role: 'crm', kind: 'artifact', path: 'a.md', title: 'x' }])).ok).toBe(false);
    expect((await svc.addLinks(p.id, [{ role: 'crm', kind: 'customer', path: 'a.md', title: 'x', stage: 'shipping' }])).ok).toBe(false);
    expect((await svc.addLinks(p.id, 'nope')).ok).toBe(false);
    expect(products.links(p.id)).toEqual([]);
  });

  it('a relink keeps the link kind: a file link cannot become a pull request', async () => {
    const { svc } = await signedInService();
    const p = await seedProduct(svc);
    const file = must(await svc.getProduct(p.id)).links.find((l) => l.kind === 'artifact')!;
    expect((await svc.updateLink(file.id, { prNumber: 4 })).ok).toBe(false);
    expect(must(await svc.updateLink(file.id, { path: 'control-book/renamed.md' })).path).toBe('control-book/renamed.md');
  });

  it('deleting a product is local only and removes it from the list', async () => {
    const { svc } = await signedInService();
    const p = await seedProduct(svc);
    must(await svc.deleteProduct(p.id));
    expect(must(await svc.listProducts())).toEqual([]);
  });
});

describe('moving items between stages', () => {
  it('records when an item entered its stage, only changes it on a real move, and keeps the history', async () => {
    const { svc, products } = await signedInService();
    const p = await seedProduct(svc);
    const art = byTitle(must(await svc.getProduct(p.id)), 'Control book — Checkout retry');
    expect(art.stage).toBeUndefined();

    clock = new Date('2026-11-15T09:00:00Z');
    expect(must(await svc.moveLink(art.id, 'problem'))).toMatchObject({ stage: 'problem', stageEnteredAt: '2026-11-15T09:00:00.000Z' });
    clock = new Date('2026-11-16T09:00:00Z');
    expect(must(await svc.moveLink(art.id, 'problem')).stageEnteredAt).toBe('2026-11-15T09:00:00.000Z');
    expect(must(await svc.moveLink(art.id, 'solution')).stageEnteredAt).toBe('2026-11-16T09:00:00.000Z');
    const back = must(await svc.moveLink(art.id, null));
    expect(back.stage).toBeUndefined();
    expect(back.stageEnteredAt).toBeUndefined();

    expect(products.stageEvents(p.id).filter((e) => e.linkId === art.id).map((e) => [e.from ?? null, e.to ?? null])).toEqual([
      [null, 'problem'], ['problem', 'solution'], ['solution', null],
    ]);
    expect((await svc.moveLink(art.id, 'shipping')).ok).toBe(false);
    clock = new Date('2026-11-14T12:00:00Z');
  });
});

describe('export and import', () => {
  it('round-trips: export, wipe the database, import, and the product home is identical', async () => {
    const saved: { text?: string } = {};
    const first = await signedInService({ dbFile: join(tmp(), 'a.db'), saved });
    const p = await seedProduct(first.svc);
    const before = must(await first.svc.getProduct(p.id));
    expect(must(await first.svc.exportProduct(p.id))).toEqual({ cancelled: false, path: '/tmp/out.json' });
    expect(parseMapping(saved.text!).format).toBe(MAPPING_FORMAT);
    expect(saved.text).not.toMatch(/ghp_|token/i);

    const second = await signedInService({ dbFile: join(tmp(), 'b.db'), open: () => saved.text! });
    expect(must(await second.svc.listProducts())).toEqual([]);
    const report = must(await second.svc.importProduct());
    if (report.cancelled) throw new Error('cancelled');
    expect(report).toMatchObject({ imported: 5, unresolved: [] });
    expect(comparable(must(await second.svc.getProduct(report.productId)))).toEqual(comparable(before));
  });

  it('reports links it cannot match to a connected repo instead of failing the import', async () => {
    const saved: { text?: string } = {};
    const first = await signedInService({ saved });
    const p = await seedProduct(first.svc);
    await first.svc.exportProduct(p.id);
    const m = JSON.parse(saved.text!);
    m.links[0].repo.fullName = 'someone-else/pm-artifacts';
    m.links[1].repo.host = 'github.acme.internal';
    const second = await signedInService();
    const report = must(await second.svc.importMappingText(JSON.stringify(m)));
    expect(report.imported).toBe(3);
    expect(report.unresolved.map((u) => u.reason)).toEqual([
      `Your artifacts role points at ${OWNER}/pm-artifacts, not someone-else/pm-artifacts.`,
      'It is on github.acme.internal, but you are signed in to github.com.',
    ]);
  });

  it('rejects files that are not a product mapping, and writes nothing', async () => {
    const { svc } = await signedInService();
    for (const bad of ['not json', '{}', JSON.stringify({ format: MAPPING_FORMAT, version: 99 }),
      JSON.stringify({ format: MAPPING_FORMAT, version: 1, product: { name: 'x', objective: '', kpis: [] }, links: [{ role: 'crm', kind: 'decision', repo: { host: 'github.com', fullName: 'a/b' }, path: 'x', title: 't' }] }),
      JSON.stringify({ format: MAPPING_FORMAT, version: 1, product: { name: 'x', objective: '', kpis: [] }, links: [{ role: 'crm', kind: 'customer', repo: { host: 'github.com', fullName: 'a/b' }, path: 'x', title: 't', stage: 'shipping' }] })]) {
      expect((await svc.importMappingText(bad)).ok).toBe(false);
    }
    expect(must(await svc.listProducts())).toEqual([]);
  });

  it('a cancelled dialog is not an error', async () => {
    const { svc } = await signedInService();
    expect(must(await svc.importProduct())).toEqual({ cancelled: true });
  });
});

describe('sync: board state and link health', () => {
  it('derives each item’s state and marks everything ok, at a known request cost', async () => {
    const { svc, gh } = await signedInService();
    const p = await seedProduct(svc);
    gh.log.length = 0;
    const home = must(await svc.syncProduct(p.id));
    expect(home.links.map((l) => l.health.state)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(home.states[byTitle(home, 'Control book — Checkout retry').id]).toEqual({
      kind: 'file', exists: true, sha: blobSha(CONTROL), lastChangedAt: '2026-10-05T09:00:00Z', lastChangedBy: 'gonzo',
      activity: [{ id: 'commit:c-control-book/checkout-retry-flow.md', at: '2026-10-05T09:00:00Z', type: 'commit' }],
    });
    expect(home.states[byTitle(home, 'SPEC-003 review').id]).toMatchObject({ kind: 'pull', status: 'approved', reviewers: [{ login: 'design', state: 'requested' }, { login: 'payments', state: 'approved' }] });
    // 3 trees + 3 commit-history reads (one per distinct file) + 1 blob for the conversation + 4 for the PR (PR, reviews, commits, unresolved threads).
    expect(gh.log.length).toBe(11);
    expect(home.sync).toMatchObject({ requests: 11, notModified: 0, lastSuccessAt: clock.toISOString() });
    expect(home.sync.lastError).toBeUndefined();
  });

  it('a second sync with nothing changed is all 304s and skips commit and blob reads', async () => {
    const { svc, gh } = await signedInService();
    const p = await seedProduct(svc);
    await svc.syncProduct(p.id);
    gh.log.length = 0;
    const home = must(await svc.syncProduct(p.id));
    expect(gh.log.map((r) => r.status)).toEqual([304, 304, 304, 304, 304, 304]); // 3 trees + PR, reviews, commits; the thread count is reused because the PR didn't change
    expect(home.sync).toMatchObject({ requests: 6, notModified: 6 });
    expect(home.links.every((l) => l.health.state === 'ok')).toBe(true);
  });

  it('reads a changed file’s new last-commit, and finds a moved file, a removed section and a missing PR', async () => {
    const { svc, gh } = await signedInService();
    const p = await seedProduct(svc);
    await svc.syncProduct(p.id);
    const repos = gh.repos;
    delete repos['pm-artifacts'].files['control-book/checkout-retry-flow.md'];
    repos['pm-artifacts'].files['archive/checkout-retry-flow.md'] = CONTROL;
    repos['pm-crm'].files['customers/acme-corp.md'] = '# Acme Corp\n\n## 2026-10-02 — Follow-up\nOnly this.\n';
    repos['pm-crm'].changed = { 'customers/acme-corp.md': { at: '2026-11-10T00:00:00Z', by: 'dana' } };
    delete repos['pm-pdr'].pulls![3];
    const home = must(await svc.syncProduct(p.id));
    expect(byTitle(home, 'Control book — Checkout retry').health).toMatchObject({ state: 'broken', movedTo: 'archive/checkout-retry-flow.md' });
    expect(home.states[byTitle(home, 'Control book — Checkout retry').id]).toEqual({ kind: 'file', exists: false });
    expect(byTitle(home, 'Acme Corp').health.state).toBe('ok');
    expect(home.states[byTitle(home, 'Acme Corp').id]).toMatchObject({ lastChangedAt: '2026-11-10T00:00:00Z', lastChangedBy: 'dana' });
    expect(byTitle(home, '2026-09-18 — Checkout retry friction').health).toMatchObject({ state: 'broken', reason: expect.stringMatching(/no longer in customers\/acme-corp\.md/) });
    expect(byTitle(home, 'SPEC-003 review').health).toMatchObject({ state: 'broken', reason: `Pull request #3 no longer exists in ${OWNER}/pm-pdr.` });
    expect(must(await svc.listProducts())[0].brokenCount).toBe(3);

    const art = byTitle(home, 'Control book — Checkout retry');
    must(await svc.updateLink(art.id, { path: 'archive/checkout-retry-flow.md' }));
    expect(byTitle(must(await svc.syncProduct(p.id)), 'Control book — Checkout retry').health.state).toBe('ok');
  });

  it('when GitHub is unreachable, the board still has the last synced state and says why', async () => {
    const { svc, gh } = await signedInService();
    const p = await seedProduct(svc);
    const synced = must(await svc.syncProduct(p.id));
    clock = new Date('2026-11-14T13:00:00Z');
    gh.state.offline = true;
    const home = must(await svc.syncProduct(p.id));
    expect(home.sync.lastError).toMatch(/Couldn't reach GitHub/);
    expect(home.sync.lastSuccessAt).toBe('2026-11-14T12:00:00.000Z');
    expect(home.sync.lastAttemptAt).toBe('2026-11-14T13:00:00.000Z');
    expect(home.states).toEqual(synced.states);
    expect(home.links.every((l) => l.health.state === 'ok')).toBe(true);
    clock = new Date('2026-11-14T12:00:00Z');
  });

  it('renders from cache with the network allow-list blocking every request', async () => {
    const { svc, gh, setFetch } = await signedInService();
    const p = await seedProduct(svc);
    const synced = must(await svc.syncProduct(p.id));
    gh.log.length = 0;
    setFetch(createGuardedFetch(() => 'nothing-is-allowed.invalid', gh.fetch));
    const home = must(await svc.syncProduct(p.id));
    expect(gh.log).toEqual([]);
    expect(home.sync.lastError).toMatch(/Blocked a request/);
    expect(home.states).toEqual(synced.states);
    expect(must(await svc.getProduct(p.id)).states).toEqual(synced.states);
  });

  it('stops at the first rate-limited response instead of burning more requests', async () => {
    const { svc, gh } = await signedInService();
    const p = await seedProduct(svc);
    gh.state.rateLimited = true;
    gh.log.length = 0;
    const home = must(await svc.syncProduct(p.id));
    expect(home.sync.lastError).toMatch(/rate limit/);
    expect(gh.log.length).toBeLessThanOrEqual(4); // the requests already in flight across the 4 workers
    expect(home.links.every((l) => l.health.state === 'unchecked')).toBe(true);
  });
});

describe('pull request status', () => {
  const pr = (over: Partial<Parameters<typeof pullStatus>[0]> = {}) => ({ title: 't', state: 'open', merged: false, draft: false, updatedAt: '', requested: [], ...over });
  const r = (login: string, state: string, at: string) => ({ login, state, at });

  it.each([
    ['open with no reviews', pr(), [], 'open'],
    ['draft', pr({ draft: true }), [r('a', 'APPROVED', '1')], 'draft'],
    ['approved', pr(), [r('a', 'APPROVED', '1')], 'approved'],
    ['changes requested beats an approval', pr(), [r('a', 'APPROVED', '1'), r('b', 'CHANGES_REQUESTED', '2')], 'changes-requested'],
    ['a later approval clears that reviewer’s changes request', pr(), [r('a', 'CHANGES_REQUESTED', '1'), r('a', 'APPROVED', '2')], 'approved'],
    ['a comment after approving keeps the approval', pr(), [r('a', 'APPROVED', '1'), r('a', 'COMMENTED', '2')], 'approved'],
    ['re-requested review resets the approval', pr({ requested: ['a'] }), [r('a', 'APPROVED', '1')], 'open'],
    ['merged', pr({ state: 'closed', merged: true }), [], 'merged'],
    ['closed unmerged', pr({ state: 'closed' }), [r('a', 'APPROVED', '1')], 'closed'],
  ])('%s', (_name, p, reviews, status) => {
    expect(pullStatus(p, reviews).status).toBe(status);
  });

  it('a PR link on the board shows each status the fake GitHub serves', async () => {
    const { svc, gh } = await signedInService();
    const p = await seedProduct(svc);
    const id = byTitle(must(await svc.getProduct(p.id)), 'SPEC-003 review').id;
    const set = (x: Partial<NonNullable<FakeRepo['pulls']>[number]>) => { gh.repos['pm-pdr'].pulls![3] = { title: 'SPEC-003', state: 'open', ...x }; };
    const status = async () => { const s = must(await svc.syncProduct(p.id)).states[id]; return s?.kind === 'pull' ? s.status : undefined; };
    set({}); expect(await status()).toBe('open');
    set({ reviews: [{ login: 'eng', state: 'CHANGES_REQUESTED', at: '2026-11-03T00:00:00Z' }] }); expect(await status()).toBe('changes-requested');
    set({ reviews: [{ login: 'eng', state: 'APPROVED', at: '2026-11-04T00:00:00Z' }] }); expect(await status()).toBe('approved');
    set({ state: 'closed', merged: true }); expect(await status()).toBe('merged');
  });
});
