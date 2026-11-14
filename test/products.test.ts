import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate, openDatabase, schemaVersion } from '../src/main/products/db.js';
import { ProductStore, type NewLink } from '../src/main/products/store.js';
import { validateLinkInput, validateProductInput } from '../src/main/products/validate.js';
import { describeTarget, groupLinks, markdownSections, slugify, suggestArtifactType } from '../src/shared/products.js';
import { tmp } from './helpers.js';

const NOW = new Date('2026-11-14T12:00:00Z');
const store = () => new ProductStore(openDatabase(':memory:'), () => NOW);
const link = (over: Partial<NewLink> = {}): NewLink => ({
  role: 'artifacts', kind: 'artifact', repoHost: 'github.com', repoFullName: 'o/pm-artifacts', path: 'control-book/a.md', title: 'A', artifactType: 'control-book', ...over,
});

describe('product database migrations', () => {
  it('brings a fresh database to the latest schema', () => {
    const db = openDatabase(':memory:');
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(['kpis', 'links', 'products']);
  });

  it('is a no-op on a database that is already current, and keeps its data', () => {
    const file = join(tmp(), 'products.db');
    const s1 = new ProductStore(openDatabase(file));
    s1.createProduct({ name: 'Checkout', objective: 'x', kpis: [] });
    const db2 = openDatabase(file);
    expect(schemaVersion(db2)).toBe(MIGRATIONS.length);
    expect(new ProductStore(db2).listProducts().map((p) => p.name)).toEqual(['Checkout']);
  });

  it('applies only the migrations a database is missing, in order', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, ['CREATE TABLE a (x)']);
    expect(schemaVersion(db)).toBe(1);
    migrate(db, ['CREATE TABLE a (x)', 'CREATE TABLE b (y)']);
    expect(schemaVersion(db)).toBe(2);
  });

  it('rolls back a failing migration and leaves the version alone', () => {
    const db = new DatabaseSync(':memory:');
    expect(() => migrate(db, ['CREATE TABLE a (x); CREATE TABLE a (x)'])).toThrow();
    expect(schemaVersion(db)).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'a'").get()).toEqual({ n: 0 });
  });

  it('refuses a database written by a newer build', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    expect(() => migrate(db)).toThrow(/newer version/);
  });

  it('enforces a link target at the schema level', () => {
    const db = openDatabase(':memory:');
    const s = new ProductStore(db);
    const p = s.createProduct({ name: 'P', objective: '', kpis: [] });
    expect(() => s.addLinks(p.id, [link({ path: undefined })])).toThrow(/CHECK/);
    expect(() => s.addLinks(p.id, [link({ role: 'crm', kind: 'conversation', anchor: undefined })])).toThrow(/CHECK/);
  });
});

describe('ProductStore', () => {
  it('creates, reads, updates and deletes a product with ordered KPIs', () => {
    const s = store();
    const p = s.createProduct({ name: 'Checkout retry', objective: 'Cut abandonment 20%', kpis: [{ name: 'Abandonment', target: '-20%' }, { name: 'Retries', target: '≤3' }] });
    expect(s.getProduct(p.id)).toMatchObject({ name: 'Checkout retry', objective: 'Cut abandonment 20%', kpis: [{ name: 'Abandonment', target: '-20%' }, { name: 'Retries', target: '≤3' }] });
    s.updateProduct(p.id, { name: 'Checkout', objective: 'y', kpis: [{ name: 'Retries', target: '≤3' }] });
    expect(s.getProduct(p.id)).toMatchObject({ name: 'Checkout', objective: 'y', kpis: [{ name: 'Retries', target: '≤3' }] });
    expect(s.updateProduct('00000000-0000-0000-0000-000000000000', { name: 'x', objective: '', kpis: [] })).toBeUndefined();
    expect(s.deleteProduct(p.id)).toBe(true);
    expect(s.getProduct(p.id)).toBeUndefined();
  });

  it('deleting a product removes its links and KPIs too (local data only)', () => {
    const s = store();
    const p = s.createProduct({ name: 'P', objective: '', kpis: [{ name: 'k', target: '' }] });
    s.addLinks(p.id, [link()]);
    s.deleteProduct(p.id);
    expect(s.links(p.id)).toEqual([]);
  });

  it('skips links that are already on the product and counts them', () => {
    const s = store();
    const p = s.createProduct({ name: 'P', objective: '', kpis: [] });
    expect(s.addLinks(p.id, [link(), link({ path: 'b.md' })])).toEqual({ added: 2, duplicates: 0 });
    expect(s.addLinks(p.id, [link(), link({ path: 'c.md' })])).toEqual({ added: 1, duplicates: 1 });
    // The same file as a customer and as one of its conversations are two different links.
    expect(s.addLinks(p.id, [
      link({ role: 'crm', kind: 'customer', repoFullName: 'o/pm-crm', path: 'customers/acme.md', artifactType: undefined }),
      link({ role: 'crm', kind: 'conversation', repoFullName: 'o/pm-crm', path: 'customers/acme.md', anchor: '2026-09-18--checkout', artifactType: undefined }),
      link({ role: 'pdr', kind: 'decision', repoFullName: 'o/pm-pdr', path: undefined, prNumber: 7, artifactType: undefined }),
      link({ role: 'pdr', kind: 'decision', repoFullName: 'o/pm-pdr', path: undefined, prNumber: 7, artifactType: undefined }),
    ])).toEqual({ added: 3, duplicates: 1 });
  });

  it('summarises products with link and broken counts', () => {
    const s = store();
    const p = s.createProduct({ name: 'b', objective: '', kpis: [] });
    s.createProduct({ name: 'A', objective: '', kpis: [] });
    s.addLinks(p.id, [link(), link({ path: 'x.md' })]);
    s.setHealth(s.links(p.id)[0].id, { state: 'broken', checkedAt: NOW.toISOString(), reason: 'gone' });
    expect(s.listProducts().map((x) => [x.name, x.linkCount, x.brokenCount])).toEqual([['A', 0, 0], ['b', 2, 1]]);
  });

  it('a relink changes the target and clears the old health; a relabel keeps it', () => {
    const s = store();
    const p = s.createProduct({ name: 'P', objective: '', kpis: [] });
    s.addLinks(p.id, [link()]);
    const [l] = s.links(p.id);
    s.setHealth(l.id, { state: 'broken', checkedAt: NOW.toISOString(), reason: 'gone', movedTo: 'moved/a.md' });
    expect(s.getLink(l.id)?.health).toEqual({ state: 'broken', checkedAt: NOW.toISOString(), reason: 'gone', movedTo: 'moved/a.md' });
    s.updateLink(l.id, { artifactType: 'exec-comm' });
    expect(s.getLink(l.id)?.health.state).toBe('broken');
    const moved = s.updateLink(l.id, { path: 'moved/a.md' });
    expect(moved).toMatchObject({ path: 'moved/a.md', artifactType: 'exec-comm', health: { state: 'unchecked' } });
  });

  it('round-trips the reserved Phase 3 stage fields', () => {
    const s = store();
    const p = s.createProduct({ name: 'P', objective: '', kpis: [] });
    s.addLinks(p.id, [link({ stage: 'problem-brief', stageEnteredAt: '2026-11-01T00:00:00.000Z' })]);
    expect(s.links(p.id)[0]).toMatchObject({ stage: 'problem-brief', stageEnteredAt: '2026-11-01T00:00:00.000Z' });
  });
});

describe('Markdown sections (CRM conversations)', () => {
  const md = [
    '# Acme Corp', '', 'Intro', '',
    '## 2026-09-18 — Checkout retry friction', 'Called in.', '### Detail', 'More.', '',
    '```', '## not a heading', '```', '',
    '## 2026-10-02 — Follow-up', 'Confirmed.',
    '## 2026-10-02 — Follow-up', 'Again.',
  ].join('\n');

  it('finds each ## section with a GitHub-style anchor and its body', () => {
    const s = markdownSections(md);
    expect(s.map((x) => x.anchor)).toEqual(['2026-09-18--checkout-retry-friction', '2026-10-02--follow-up', '2026-10-02--follow-up-1']);
    expect(s[0].body).toContain('### Detail');
    expect(s[0].body).toContain('## not a heading');
    expect(s[1].body).toBe('Confirmed.');
  });

  it('slugifies like GitHub', () => {
    expect(slugify('Hello, World! (v2)')).toBe('hello-world-v2');
  });
});

describe('artifact type suggestion and grouping', () => {
  it('suggests a type from the folder or name', () => {
    expect(suggestArtifactType('control-book/checkout-retry-flow.md')).toBe('control-book');
    expect(suggestArtifactType('exec-comms/2026-10-weekly-update.md')).toBe('exec-comm');
    expect(suggestArtifactType('briefs/problem-brief-checkout.md')).toBe('problem-brief');
    expect(suggestArtifactType('README.md')).toBe('other');
  });

  it('groups artifacts by type, conversations under their customer, and decisions', () => {
    const s = store();
    const p = s.createProduct({ name: 'P', objective: '', kpis: [] });
    s.addLinks(p.id, [
      link({ path: 'exec-comms/u.md', title: 'Update', artifactType: 'exec-comm' }),
      link({ title: 'Control', path: 'control-book/c.md' }),
      link({ role: 'crm', kind: 'conversation', repoFullName: 'o/pm-crm', path: 'customers/globex.md', anchor: 'call', title: 'Globex call', artifactType: undefined }),
      link({ role: 'crm', kind: 'customer', repoFullName: 'o/pm-crm', path: 'customers/acme.md', title: 'Acme', artifactType: undefined }),
      link({ role: 'crm', kind: 'conversation', repoFullName: 'o/pm-crm', path: 'customers/acme.md', anchor: 'b', title: 'B call', artifactType: undefined }),
      link({ role: 'pdr', kind: 'decision', repoFullName: 'o/pm-pdr', path: undefined, prNumber: 3, title: 'SPEC-003 PR', artifactType: undefined }),
    ]);
    const g = groupLinks(s.links(p.id));
    expect(g.artifacts.map((x) => [x.type, x.links.map((l) => l.title)])).toEqual([['control-book', ['Control']], ['exec-comm', ['Update']]]);
    expect(g.customers.map((c) => [c.customer?.title ?? c.path, c.conversations.map((x) => x.title)])).toEqual([['Acme', ['B call']], ['customers/globex.md', ['Globex call']]]);
    expect(g.decisions.map((d) => describeTarget(d))).toEqual(['Pull request #3']);
  });
});

describe('input validation', () => {
  it('trims product input and drops blank KPI rows', () => {
    expect(validateProductInput({ name: '  P ', objective: ' o ', kpis: [{ name: '', target: '' }, { name: 'k', target: ' 1 ' }] }))
      .toEqual({ ok: true, value: { name: 'P', objective: 'o', kpis: [{ name: 'k', target: '1' }] } });
    expect(validateProductInput({ name: ' ', objective: '' }).ok).toBe(false);
    expect(validateProductInput({ name: 'P', kpis: [{ name: '', target: '5' }] }).ok).toBe(false);
  });

  it('rejects links whose kind does not belong to the role, or whose path escapes the repo', () => {
    expect(validateLinkInput({ role: 'artifacts', kind: 'decision', path: 'a.md', title: 'x' }).ok).toBe(false);
    expect(validateLinkInput({ role: 'artifacts', kind: 'artifact', path: '../etc/passwd', title: 'x' }).ok).toBe(false);
    expect(validateLinkInput({ role: 'artifacts', kind: 'artifact', path: '/abs.md', title: 'x' }).ok).toBe(false);
    expect(validateLinkInput({ role: 'artifacts', kind: 'artifact', prNumber: 3, title: 'x' }).ok).toBe(false);
    expect(validateLinkInput({ role: 'crm', kind: 'conversation', path: 'c.md', title: 'x' }).ok).toBe(false);
    expect(validateLinkInput({ role: 'crm', kind: 'customer', path: 'c.md', anchor: 'a', title: 'x' }).ok).toBe(false);
    expect(validateLinkInput({ role: 'pdr', kind: 'decision', path: 'a.md', prNumber: 3, title: 'x' }).ok).toBe(false);
    expect(validateLinkInput({ role: 'artifacts', kind: 'artifact', path: 'a.md', title: 'x' })).toEqual({ ok: true, value: { role: 'artifacts', kind: 'artifact', path: 'a.md', title: 'x', artifactType: 'other' } });
    expect(validateLinkInput({ role: 'pdr', kind: 'decision', prNumber: 3, title: 'x' }).ok).toBe(true);
  });
});
