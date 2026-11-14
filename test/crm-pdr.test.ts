import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RepoRef } from '../src/shared/ipc.js';
import { appendConversation, detectCrmLayout, detectPdrLayout, pdrPath, suggestConvention, type WriteDraft } from '../src/shared/writes.js';
import { createGitHubClient } from '../src/main/github/client.js';
import { TokenStore, type SecretBox } from '../src/main/app/secrets.js';
import { AppService } from '../src/main/app/service.js';
import { createSettingsStore } from '../src/main/app/settings.js';
import { openDatabase } from '../src/main/products/db.js';
import { HttpCache } from '../src/main/products/httpcache.js';
import { ProductStore } from '../src/main/products/store.js';
import { WriteBlockedError } from '../src/main/write/guard.js';
import { fakeGitHub, type FakeRepo } from './fakeGitHub.js';
import { tmp } from './helpers.js';

const OWNER = 'gonzalovazquez';
const repo = (name: string): RepoRef => ({ owner: OWNER, name, fullName: `${OWNER}/${name}`, defaultBranch: 'main', private: true, htmlUrl: '' });
const ROLES = { artifacts: repo('pm-artifacts'), crm: repo('pm-crm'), pdr: repo('pm-pdr') };
const ACME = '# Acme Corp\n\n**Segment:** Mid-market\n\n## 2026-09-18 — Checkout retry friction\nCalled in.\n';
const GLOBEX = '# Globex Industries\n\n## 2026-08-30 — QBR notes\nSlow dashboards.\n';
const SPEC = '# SPEC-003: Checkout Retry Flow\n\n**Status:** Approved\n';

const repos = (): Record<string, FakeRepo> => ({
  'pm-artifacts': { files: { 'README.md': '# A\n' } },
  'pm-crm': { files: { 'README.md': '# CRM\n', 'customers/acme-corp.md': ACME, 'customers/globex.md': GLOBEX } },
  'pm-pdr': { files: { 'README.md': '# PDR\n', 'specs/spec-003-checkout-retry.md': SPEC }, branches: ['develop'] },
});
const box = (): SecretBox => { let s = ''; return { isAvailable: () => true, encrypt: (p) => { s = p; return Buffer.from(p); }, decrypt: () => s }; };
const must = <T>(r: { ok: true; value: T } | { ok: false; message: string }): T => { if (!r.ok) throw new Error(r.message); return r.value; };

async function setup() {
  const dir = tmp();
  const settings = createSettingsStore(join(dir, 'settings.json'));
  await settings.save({ repoRoles: ROLES });
  const gh = fakeGitHub(OWNER, repos());
  const db = openDatabase(':memory:');
  const products = new ProductStore(db);
  const svc = new AppService({
    settings, tokens: new TokenStore(join(dir, 'token.bin'), box(), {}), products, cache: new HttpCache(db),
    createClient: (host, token, guard, hooks) => createGitHubClient(host, token, gh.fetch, guard, hooks),
    files: { saveText: async () => null, openText: async () => null },
  });
  must(await svc.signIn('github.com', 'ghp_x'));
  await svc.getSettings();
  const p = must(await svc.createProduct({ name: 'Checkout retry', objective: 'o', kpis: [] }));
  return { svc, gh, products, settings, productId: p.id };
}

const conv = (productId: string, over: Partial<Extract<WriteDraft, { kind: 'log-conversation' }>> = {}): WriteDraft => ({
  kind: 'log-conversation', productId, customerPath: 'customers/acme-corp.md', date: '2026-11-14', topic: 'Retry countdown feedback', participants: 'Dana (Acme ops), me', notes: 'Countdown tested well.', ...over,
});
const pdr = (productId: string, over: Partial<Extract<WriteDraft, { kind: 'create-pdr' }>> = {}): WriteDraft => ({
  kind: 'create-pdr', productId, path: 'specs/spec-004-retry-limits.md', title: 'SPEC-004: Retry limits', content: '# SPEC-004: Retry limits\n\n## Problem\n', convention: { prefix: 'spec/', base: 'develop' }, ...over,
});

describe('layout detection', () => {
  it('finds the customers folder, its customers and its heading style', () => {
    const l = detectCrmLayout([
      { path: 'README.md', content: '# CRM\n\n## 2026-01-01 — not a customer\n' },
      { path: 'customers/acme-corp.md', content: ACME },
      { path: 'customers/globex.md', content: GLOBEX },
      { path: 'notes/misc.md', content: '# Misc\n' },
    ]);
    expect(l).toEqual({ folder: 'customers', separator: ' — ', customers: [{ path: 'customers/acme-corp.md', name: 'Acme Corp' }, { path: 'customers/globex.md', name: 'Globex Industries' }] });
  });

  it('appends a conversation in the file’s style, or starts a new customer file', () => {
    expect(appendConversation(ACME, { date: '2026-11-14', topic: 'Follow-up', participants: 'Dana', notes: 'Good.' })).toBe(
      `${ACME.trimEnd()}\n\n## 2026-11-14 — Follow-up\n**Participants:** Dana\n\nGood.\n`,
    );
    expect(appendConversation(null, { customerName: 'Initech', date: '2026-11-14', topic: 'Intro', participants: '', notes: 'Hi.' })).toBe('# Initech\n\n## 2026-11-14 — Intro\nHi.\n');
  });

  it('continues the PDR numbering and suggests a branch convention from history', () => {
    const l = detectPdrLayout(['README.md', 'specs/spec-001-a.md', 'specs/spec-003-checkout-retry.md', 'templates/pdr-template.md']);
    expect(l).toEqual({ folder: 'specs', numberPrefix: 'spec-', nextNumber: 4, numberWidth: 3 });
    expect(pdrPath(l, 'Retry limits')).toBe('specs/spec-004-retry-limits.md');
    expect(pdrPath(l, 'SPEC-004: Retry limits')).toBe('specs/spec-004-retry-limits.md');
    expect(suggestConvention({ branches: ['main', 'develop'], pulls: [], defaultBranch: 'main', folder: 'specs' })).toMatchObject({ prefix: 'spec/', base: 'develop' });
    expect(suggestConvention({ branches: ['main', 'develop', 'pdr/a', 'pdr/b', 'feature/x'], pulls: [{ head: 'pdr/c', base: 'develop' }, { head: 'pdr/d', base: 'develop' }], defaultBranch: 'main', folder: 'specs' }))
      .toMatchObject({ prefix: 'pdr/', base: 'develop', evidence: '2 pull requests target develop; 4 branches start with pdr/' });
    expect(suggestConvention({ branches: ['main'], pulls: [], defaultBranch: 'main', folder: 'decisions' })).toMatchObject({ prefix: 'decision/', base: 'main' });
  });
});

describe('logging a CRM conversation', () => {
  it('appends to the customer file in one pull request, links the conversation pending in intake, and leaves main alone', async () => {
    const { svc, gh, products, productId } = await setup();
    expect(must(await svc.crmLayout())).toMatchObject({ folder: 'customers', customers: [{ name: 'Acme Corp' }, { name: 'Globex Industries' }] });
    const pv = must(await svc.previewWrite(conv(productId)));
    expect(pv).toMatchObject({ repo: `${OWNER}/pm-crm`, base: 'main', branch: expect.stringMatching(/^pmworkbench\/crm\/acme-corp-\d{8}$/), files: [{ path: 'customers/acme-corp.md', change: 'update', added: 5, removed: 0 }] });
    const r = must(await svc.confirmWrite(pv.id));
    expect(gh.repos['pm-crm'].files['customers/acme-corp.md']).toBe(ACME);
    expect(gh.filesAt('pm-crm', r.branch)!['customers/acme-corp.md']).toContain('## 2026-11-14 — Retry countdown feedback\n**Participants:** Dana (Acme ops), me');
    const [link] = products.links(productId);
    expect(link).toMatchObject({ kind: 'conversation', role: 'crm', anchor: '2026-11-14--retry-countdown-feedback', stage: 'intake', pending: { prNumber: r.prNumber } });
  });

  it('a second conversation for the same customer goes onto the open pull request', async () => {
    const { svc, gh, productId } = await setup();
    const r1 = must(await svc.confirmWrite(must(await svc.previewWrite(conv(productId))).id));
    const pv2 = must(await svc.previewWrite(conv(productId, { date: '2026-11-15', topic: 'Pricing question' })));
    expect(pv2.existingPr?.number).toBe(r1.prNumber);
    const r2 = must(await svc.confirmWrite(pv2.id));
    expect(r2).toMatchObject({ addedToExisting: true, prNumber: r1.prNumber });
    expect(gh.appPulls('pm-crm')).toHaveLength(1);
    const text = gh.filesAt('pm-crm', r1.branch)!['customers/acme-corp.md'];
    expect(text.indexOf('Retry countdown feedback')).toBeLessThan(text.indexOf('Pricing question'));
  });

  it('a new customer gets a file, and both the customer and the conversation are linked', async () => {
    const { svc, gh, products, productId } = await setup();
    expect((await svc.previewWrite(conv(productId, { customerPath: 'customers/initech.md' }))).ok).toBe(false); // needs a name
    const r = must(await svc.confirmWrite(must(await svc.previewWrite(conv(productId, { customerPath: 'customers/initech.md', customerName: 'Initech' }))).id));
    expect(gh.filesAt('pm-crm', r.branch)!['customers/initech.md']).toMatch(/^# Initech\n\n## 2026-11-14 — Retry countdown feedback/);
    expect(products.links(productId).map((l) => [l.kind, l.title])).toEqual([['customer', 'Initech'], ['conversation', '2026-11-14 — Retry countdown feedback']]);
  });

  it('when the pull request merges, the conversation becomes a normal, healthy link', async () => {
    const { svc, gh, products, productId } = await setup();
    const r = must(await svc.confirmWrite(must(await svc.previewWrite(conv(productId))).id));
    gh.merge('pm-crm', r.prNumber);
    const home = must(await svc.syncProduct(productId));
    const l = home.links[0];
    expect(l.pending).toBeUndefined();
    expect(l.health.state).toBe('ok');
    expect(products.links(productId)[0].anchor).toBe('2026-11-14--retry-countdown-feedback');
  });
});

describe('raising a PDR', () => {
  it('detects git-flow from the repo and the next spec number', async () => {
    const { svc } = await setup();
    const l = must(await svc.pdrLayout());
    expect(l).toMatchObject({ folder: 'specs', numberPrefix: 'spec-', nextNumber: 4, detected: { prefix: 'spec/', base: 'develop', evidence: expect.stringMatching(/develop branch exists/) } });
    expect(l.confirmed).toBeUndefined();
  });

  it('opens a pull request from spec/… into develop, touching neither develop nor main, and remembers the convention', async () => {
    const { svc, gh, products, settings, productId } = await setup();
    const developBefore = gh.filesAt('pm-pdr', 'develop');
    const pv = must(await svc.previewWrite(pdr(productId)));
    expect(pv).toMatchObject({ repo: `${OWNER}/pm-pdr`, base: 'develop', branch: 'spec/spec-004-retry-limits', title: 'Add decision record: SPEC-004: Retry limits' });
    const r = must(await svc.confirmWrite(pv.id));
    expect(gh.appPulls('pm-pdr')).toEqual([expect.objectContaining({ head: 'spec/spec-004-retry-limits', base: 'develop' })]);
    expect(gh.filesAt('pm-pdr', 'develop')).toEqual(developBefore);
    expect(gh.repos['pm-pdr'].files['specs/spec-004-retry-limits.md']).toBeUndefined();
    expect(products.links(productId)[0]).toMatchObject({ kind: 'decision', path: 'specs/spec-004-retry-limits.md', stage: 'specification', pending: { prNumber: r.prNumber } });
    expect((await settings.load()).branchConventions[`${OWNER}/pm-pdr`]).toEqual({ prefix: 'spec/', base: 'develop' });
    expect(must(await svc.pdrLayout()).confirmed).toEqual({ prefix: 'spec/', base: 'develop' });
  });

  it('refuses an existing path, a missing base branch, or a protected prefix', async () => {
    const { svc, productId } = await setup();
    expect(await svc.previewWrite(pdr(productId, { path: 'specs/spec-003-checkout-retry.md' }))).toMatchObject({ ok: false, message: expect.stringMatching(/already exists/) });
    expect(await svc.previewWrite(pdr(productId, { convention: { prefix: 'spec/', base: 'release' } }))).toMatchObject({ ok: false, message: expect.stringMatching(/no release branch/) });
    expect((await svc.previewWrite(pdr(productId, { convention: { prefix: 'main/', base: 'develop' } }))).ok).toBe(false);
    expect((await svc.previewWrite(pdr(productId, { convention: { prefix: 'refs/', base: 'develop' } }))).ok).toBe(false);
  });

  it('the guard lets a confirmed prefix create branches, but never move or delete one the app didn’t create', async () => {
    const { svc, gh, productId } = await setup();
    must(await svc.confirmWrite(must(await svc.previewWrite(pdr(productId))).id)); // confirms spec/
    const guard = { defaultBranches: () => ({}), prefixes: () => ({ [`${OWNER}/pm-pdr`]: ['spec/'] }), owns: () => false };
    const c = createGitHubClient('github.com', 't', gh.fetch, guard);
    const cause = async (p: Promise<unknown>) => { try { await p; return undefined; } catch (e) { return (e as { cause?: unknown }).cause; } };
    expect(await cause(c.moveBranch(ROLES.pdr, 'spec/someone-elses', 'abc'))).toBeInstanceOf(WriteBlockedError);
    expect(await cause(c.deleteBranch(ROLES.pdr, 'spec/spec-004-retry-limits'))).toBeInstanceOf(WriteBlockedError);
    expect(await cause(c.createBranch(ROLES.pdr, 'feature/x', 'abc'))).toBeInstanceOf(WriteBlockedError);
    expect(await cause(c.createBranch(ROLES.pdr, 'develop', 'abc'))).toBeInstanceOf(WriteBlockedError);
  });
});

describe('approval status', () => {
  it('shows a raised PDR’s state, reviewers and unresolved comments through review, then converts it on merge', async () => {
    const { svc, gh, productId } = await setup();
    const r = must(await svc.confirmWrite(must(await svc.previewWrite(pdr(productId))).id));
    const state = async () => { const h = must(await svc.syncProduct(productId)); return { s: h.states[h.links[0].id], l: h.links[0] }; };
    expect((await state()).s).toMatchObject({ kind: 'pending', status: 'open', reviewers: [], unresolvedComments: 0 });

    gh.review('pm-pdr', r.prNumber, { at: '2026-11-14T13:00:00Z', requested: ['design'], reviews: [{ login: 'payments-eng', state: 'CHANGES_REQUESTED', at: '2026-11-14T13:00:00Z' }], threads: [{ resolved: false }, { resolved: false }, { resolved: true }] });
    expect((await state()).s).toMatchObject({ status: 'changes-requested', unresolvedComments: 2, reviewers: [{ login: 'design', state: 'requested' }, { login: 'payments-eng', state: 'changes-requested' }] });

    // Nothing changed on GitHub: the thread count is reused, no GraphQL call.
    gh.log.length = 0;
    await state();
    expect(gh.log.some((x) => x.path === '/graphql')).toBe(false);

    gh.review('pm-pdr', r.prNumber, { at: '2026-11-14T13:30:00Z', requested: [], reviews: [{ login: 'payments-eng', state: 'CHANGES_REQUESTED', at: '2026-11-14T13:00:00Z' }, { login: 'payments-eng', state: 'APPROVED', at: '2026-11-14T13:30:00Z' }, { login: 'design', state: 'APPROVED', at: '2026-11-14T13:31:00Z' }], threads: [{ resolved: true }, { resolved: true }, { resolved: true }] });
    expect((await state()).s).toMatchObject({ status: 'approved', unresolvedComments: 0 });

    gh.merge('pm-pdr', r.prNumber);
    // Merged into develop (git-flow), not yet released to main: still pending, shown as merged, not broken.
    const merged = await state();
    expect(merged.l.pending).toBeDefined();
    expect(merged.l.health.state).toBe('ok');
    expect(merged.s).toMatchObject({ kind: 'pending', status: 'merged' });
    // The release merges develop into main; now it's an ordinary link to the file on main.
    gh.repos['pm-pdr'].files = { ...gh.filesAt('pm-pdr', 'develop')! };
    const released = await state();
    expect(released.l.pending).toBeUndefined();
    expect(released.s).toMatchObject({ kind: 'file', exists: true });
  });

  it('lists every pull request the app opened, across repos, with live state and product', async () => {
    const { svc, gh, productId } = await setup();
    const a = must(await svc.confirmWrite(must(await svc.previewWrite(conv(productId))).id));
    const b = must(await svc.confirmWrite(must(await svc.previewWrite(pdr(productId))).id));
    gh.review('pm-pdr', b.prNumber, { at: '2026-11-14T13:00:00Z', reviews: [{ login: 'eng', state: 'APPROVED', at: '2026-11-14T13:00:00Z' }], threads: [{ resolved: false }] });
    const list = must(await svc.listAppPulls());
    expect(list.map((p) => [p.repo, p.prNumber, p.status, p.unresolvedComments, p.productName])).toEqual([
      [`${OWNER}/pm-pdr`, b.prNumber, 'approved', 1, 'Checkout retry'],
      [`${OWNER}/pm-crm`, a.prNumber, 'open', 0, 'Checkout retry'],
    ]);
  });
});
