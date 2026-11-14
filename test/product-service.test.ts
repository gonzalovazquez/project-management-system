import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RepoRef } from '../src/shared/ipc.js';
import type { GitHubClient } from '../src/main/github/client.js';
import { TokenStore, type SecretBox } from '../src/main/app/secrets.js';
import { AppService } from '../src/main/app/service.js';
import { createSettingsStore } from '../src/main/app/settings.js';
import { openDatabase } from '../src/main/products/db.js';
import { checkLinks } from '../src/main/products/linkcheck.js';
import { MAPPING_FORMAT, parseMapping } from '../src/main/products/mapping.js';
import { ProductStore } from '../src/main/products/store.js';
import type { Link, ProductHome } from '../src/shared/products.js';
import { tmp } from './helpers.js';

const NOW = new Date('2026-11-14T12:00:00Z');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const repo = (name: string, owner = 'gonzalovazquez'): RepoRef => ({ owner, name, fullName: `${owner}/${name}`, defaultBranch: 'main', private: true, htmlUrl: `https://github.com/${owner}/${name}` });
const ROLES = { artifacts: repo('pm-artifacts'), crm: repo('pm-crm'), pdr: repo('pm-pdr') };

const ACME = '# Acme Corp\n\n## 2026-09-18 — Checkout retry friction\nCalled in.\n\n## 2026-10-02 — Follow-up\nConfirmed.\n';

/** A fake GitHub holding the test repos' files and one pull request. */
function fakeClient(files: Record<string, { sha: string; content: string }>, pulls: number[] = [3]): GitHubClient {
  const key = (r: RepoRef, p: string) => `${r.name}/${p}`;
  return {
    whoAmI: async () => ({ login: 'gonzo' }),
    listRepos: async () => ({ repos: Object.values(ROLES), missingPrivateScope: false }),
    listTree: async () => [],
    getFile: async (r, p) => {
      const f = files[key(r, p)];
      if (!f) throw Object.assign(new Error('Not Found'), { status: 404 });
      return { path: p, content: f.content, truncated: false, htmlUrl: '', sha: f.sha };
    },
    statPath: async (r, p) => (files[key(r, p)] ? { sha: files[key(r, p)].sha, type: 'file' } : null),
    findBlob: async (r, sha) => Object.entries(files).find(([k, f]) => k.startsWith(`${r.name}/`) && f.sha === sha)?.[0].slice(r.name.length + 1) ?? null,
    listPulls: async () => [],
    getPull: async (_r, n) => (pulls.includes(n) ? { number: n, title: `PR ${n}`, state: 'open', merged: false, draft: false, author: 'g', updatedAt: '', body: '', htmlUrl: '', baseRef: 'develop', headRef: 'spec' } : null),
  };
}

const box = (): SecretBox => { let s = ''; return { isAvailable: () => true, encrypt: (p) => { s = p; return Buffer.from(p); }, decrypt: () => s }; };

async function signedInService(opts: { client?: GitHubClient; dbFile?: string; dir?: string; saved?: { text?: string }; open?: () => string | null } = {}) {
  const dir = opts.dir ?? tmp();
  const settings = createSettingsStore(join(dir, 'settings.json'));
  await settings.save({ repoRoles: ROLES });
  const client = opts.client ?? fakeClient({});
  const products = new ProductStore(openDatabase(opts.dbFile ?? ':memory:'), () => NOW);
  const svc = new AppService({
    settings, tokens: new TokenStore(join(dir, 'token.bin'), box(), {}), createClient: () => client, products, now: () => NOW,
    files: {
      saveText: async (_name, text) => { if (opts.saved) opts.saved.text = text; return '/tmp/out.json'; },
      openText: async () => opts.open?.() ?? null,
    },
  });
  await svc.signIn('github.com', 'ghp_x');
  return { svc, products, dir };
}

const must = <T>(r: { ok: true; value: T } | { ok: false; message: string }): T => {
  if (!r.ok) throw new Error(r.message);
  return r.value;
};

async function seedProduct(svc: AppService) {
  const p = must(await svc.createProduct({ name: 'Checkout retry', objective: 'Cut failed-payment abandonment 20% this quarter', kpis: [{ name: 'Abandonment', target: '-20%' }] }));
  must(await svc.addLinks(p.id, [
    { role: 'artifacts', kind: 'artifact', path: 'control-book/checkout-retry-flow.md', title: 'Control book — Checkout retry', artifactType: 'control-book', blobSha: SHA_A },
    { role: 'crm', kind: 'customer', path: 'customers/acme-corp.md', title: 'Acme Corp' },
    { role: 'crm', kind: 'conversation', path: 'customers/acme-corp.md', anchor: '2026-09-18--checkout-retry-friction', title: '2026-09-18 — Checkout retry friction' },
    { role: 'pdr', kind: 'decision', path: 'specs/spec-003-checkout-retry.md', title: 'SPEC-003' },
    { role: 'pdr', kind: 'decision', prNumber: 3, title: 'SPEC-003 review' },
  ]));
  return p;
}

/** The product home without ids and timestamps, which legitimately differ after an import. */
const comparable = (h: ProductHome) => ({
  product: { name: h.product.name, objective: h.product.objective, kpis: h.product.kpis },
  links: h.links
    .map(({ id: _i, productId: _p, createdAt: _c, health: _h, ...rest }) => rest)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
});

describe('products through AppService', () => {
  it('links items from the repo assigned to each role, recording host and full name', async () => {
    const { svc } = await signedInService();
    const p = await seedProduct(svc);
    const home = must(await svc.getProduct(p.id));
    expect(home.product.objective).toMatch(/abandonment/);
    expect(home.links.map((l) => [l.kind, l.repoHost, l.repoFullName])).toEqual([
      ['artifact', 'github.com', 'gonzalovazquez/pm-artifacts'],
      ['customer', 'github.com', 'gonzalovazquez/pm-crm'],
      ['conversation', 'github.com', 'gonzalovazquez/pm-crm'],
      ['decision', 'github.com', 'gonzalovazquez/pm-pdr'],
      ['decision', 'github.com', 'gonzalovazquez/pm-pdr'],
    ]);
  });

  it('rejects malformed input from the window without touching the database', async () => {
    const { svc, products } = await signedInService();
    expect((await svc.createProduct({ name: '' })).ok).toBe(false);
    expect((await svc.getProduct("1' OR '1'='1")).ok).toBe(false);
    const p = must(await svc.createProduct({ name: 'P', objective: '', kpis: [] }));
    expect((await svc.addLinks(p.id, [{ role: 'crm', kind: 'artifact', path: 'a.md', title: 'x' }])).ok).toBe(false);
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

describe('export and import', () => {
  it('round-trips: export, wipe the database, import, and the product home is identical', async () => {
    const dir = tmp();
    const saved: { text?: string } = {};
    const first = await signedInService({ dir, dbFile: join(dir, 'a.db'), saved });
    const p = await seedProduct(first.svc);
    const before = must(await first.svc.getProduct(p.id));
    expect(must(await first.svc.exportProduct(p.id))).toEqual({ cancelled: false, path: '/tmp/out.json' });

    const file = parseMapping(saved.text!);
    expect(file.format).toBe(MAPPING_FORMAT);
    expect(saved.text).not.toMatch(/ghp_|token/i);

    // A fresh database, as on a teammate's Mac.
    const second = await signedInService({ dir: tmp(), dbFile: join(tmp(), 'b.db'), open: () => saved.text! });
    expect(must(await second.svc.listProducts())).toEqual([]);
    const report = must(await second.svc.importProduct());
    if (report.cancelled) throw new Error('cancelled');
    expect(report).toMatchObject({ imported: 5, unresolved: [] });
    const after = must(await second.svc.getProduct(report.productId));
    expect(comparable(after)).toEqual(comparable(before));
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
      'Your artifacts role points at gonzalovazquez/pm-artifacts, not someone-else/pm-artifacts.',
      'It is on github.acme.internal, but you are signed in to github.com.',
    ]);
  });

  it('rejects files that are not a product mapping, and writes nothing', async () => {
    const { svc } = await signedInService();
    for (const bad of ['not json', '{}', JSON.stringify({ format: MAPPING_FORMAT, version: 99 }),
      JSON.stringify({ format: MAPPING_FORMAT, version: 1, product: { name: 'x', objective: '', kpis: [] }, links: [{ role: 'crm', kind: 'decision', repo: { host: 'github.com', fullName: 'a/b' }, path: 'x', title: 't' }] })]) {
      const r = await svc.importMappingText(bad);
      expect(r.ok).toBe(false);
    }
    expect(must(await svc.listProducts())).toEqual([]);
  });

  it('a cancelled dialog is not an error', async () => {
    const { svc } = await signedInService();
    expect(must(await svc.importProduct())).toEqual({ cancelled: true });
  });
});

describe('broken-link detection', () => {
  const files = {
    'pm-artifacts/control-book/checkout-retry-flow.md': { sha: SHA_A, content: '# CB' },
    'pm-crm/customers/acme-corp.md': { sha: SHA_B, content: ACME },
    'pm-pdr/specs/spec-003-checkout-retry.md': { sha: 'c'.repeat(40), content: '# SPEC' },
  };

  it('marks everything ok when every target exists', async () => {
    const { svc } = await signedInService({ client: fakeClient(files) });
    const p = await seedProduct(svc);
    const home = must(await svc.checkLinks(p.id));
    expect(home.links.map((l) => l.health.state)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(must(await svc.listProducts())[0].brokenCount).toBe(0);
  });

  it('finds a moved file by its content, a removed section, and a missing pull request', async () => {
    const moved = { ...files } as Record<string, { sha: string; content: string }>;
    delete moved['pm-artifacts/control-book/checkout-retry-flow.md'];
    moved['pm-artifacts/archive/checkout-retry-flow.md'] = { sha: SHA_A, content: '# CB' };
    moved['pm-crm/customers/acme-corp.md'] = { sha: SHA_B, content: '# Acme Corp\n\n## 2026-10-02 — Follow-up\nOnly this.\n' };
    const { svc } = await signedInService({ client: fakeClient(moved, []) });
    const p = await seedProduct(svc);
    const home = must(await svc.checkLinks(p.id));
    const by = (kind: string, pr = false) => home.links.find((l) => l.kind === kind && (l.prNumber !== undefined) === pr)!.health;
    expect(by('artifact')).toMatchObject({ state: 'broken', movedTo: 'archive/checkout-retry-flow.md' });
    expect(by('customer').state).toBe('ok');
    expect(by('conversation')).toMatchObject({ state: 'broken', reason: expect.stringMatching(/no longer in customers\/acme-corp\.md/) });
    expect(by('decision', true)).toMatchObject({ state: 'broken', reason: 'Pull request #3 no longer exists in gonzalovazquez/pm-pdr.' });
    expect(must(await svc.listProducts())[0].brokenCount).toBe(3);

    // Relinking to the suggested path fixes it on the next check.
    const art = home.links.find((l) => l.kind === 'artifact')!;
    must(await svc.updateLink(art.id, { path: 'archive/checkout-retry-flow.md' }));
    expect(must(await svc.checkLinks(p.id)).links.find((l) => l.id === art.id)!.health.state).toBe('ok');
  });

  it('never marks links broken because GitHub was unreachable', async () => {
    const offline = { ...fakeClient(files), statPath: async () => { throw new Error('getaddrinfo ENOTFOUND'); }, getPull: async () => { throw new Error('ENOTFOUND'); } };
    const { svc, products } = await signedInService({ client: offline });
    const p = await seedProduct(svc);
    const r = await svc.checkLinks(p.id);
    expect(r).toMatchObject({ ok: false, error: 'network' });
    expect(products.links(p.id).every((l) => l.health.state === 'unchecked')).toBe(true);
  });

  it('flags a link whose repo is no longer connected', async () => {
    const l = { id: 'x', productId: 'p', role: 'artifacts', kind: 'artifact', repoHost: 'github.com', repoFullName: 'old/repo', path: 'a.md', title: 'A', health: { state: 'unchecked' }, createdAt: '' } as Link;
    const [o] = await checkLinks([l], 'github.com', ROLES, fakeClient(files), NOW);
    expect(o.health).toMatchObject({ state: 'broken', reason: expect.stringMatching(/not one of your connected repos/) });
  });
});
