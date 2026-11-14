import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { RepoRole } from '../../shared/ipc.js';
import type { ArtifactType, Kpi, Link, LinkHealth, LinkKind, Product, ProductHome, ProductInput, ProductSummary } from '../../shared/products.js';

/** A link ready to store: the repo already resolved from its role. */
export interface NewLink {
  role: RepoRole;
  kind: LinkKind;
  repoHost: string;
  repoFullName: string;
  path?: string;
  anchor?: string;
  prNumber?: number;
  title: string;
  artifactType?: ArtifactType;
  blobSha?: string;
  stage?: string;
  stageEnteredAt?: string;
}

export interface LinkPatch {
  path?: string;
  anchor?: string | null;
  prNumber?: number | null;
  title?: string;
  artifactType?: ArtifactType;
  blobSha?: string | null;
}

interface LinkRow {
  id: string; product_id: string; role: RepoRole; kind: LinkKind; repo_host: string; repo_full_name: string;
  path: string | null; anchor: string | null; pr_number: number | null; title: string; artifact_type: ArtifactType | null;
  blob_sha: string | null; stage: string | null; stage_entered_at: string | null;
  health: 'ok' | 'broken' | null; health_reason: string | null; moved_to: string | null; checked_at: string | null; created_at: string;
}


function toLink(r: LinkRow): Link {
  const health: LinkHealth = r.health === 'ok'
    ? { state: 'ok', checkedAt: r.checked_at ?? '' }
    : r.health === 'broken'
      ? { state: 'broken', checkedAt: r.checked_at ?? '', reason: r.health_reason ?? 'Not found', ...(r.moved_to ? { movedTo: r.moved_to } : {}) }
      : { state: 'unchecked' };
  const l: Link = {
    id: r.id, productId: r.product_id, role: r.role, kind: r.kind, repoHost: r.repo_host, repoFullName: r.repo_full_name,
    title: r.title, health, createdAt: r.created_at,
  };
  if (r.path !== null) l.path = r.path;
  if (r.anchor !== null) l.anchor = r.anchor;
  if (r.pr_number !== null) l.prNumber = Number(r.pr_number);
  if (r.artifact_type !== null) l.artifactType = r.artifact_type;
  if (r.blob_sha !== null) l.blobSha = r.blob_sha;
  if (r.stage !== null) l.stage = r.stage;
  if (r.stage_entered_at !== null) l.stageEnteredAt = r.stage_entered_at;
  return l;
}

/**
 * Products, their KPIs and their links, in the local SQLite database. Synchronous because
 * node:sqlite is; every call is a handful of indexed statements against a small local file.
 */
export class ProductStore {
  constructor(private db: DatabaseSync, private now: () => Date = () => new Date()) {}

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  listProducts(): ProductSummary[] {
    const rows = this.db.prepare(`
      SELECT p.id, p.name, p.objective,
             count(l.id) AS link_count,
             coalesce(sum(l.health = 'broken'), 0) AS broken_count
      FROM products p LEFT JOIN links l ON l.product_id = p.id
      GROUP BY p.id ORDER BY p.name COLLATE NOCASE, p.created_at
    `).all() as { id: string; name: string; objective: string; link_count: number; broken_count: number }[];
    return rows.map((r) => ({ id: r.id, name: r.name, objective: r.objective, linkCount: Number(r.link_count), brokenCount: Number(r.broken_count) }));
  }

  getProduct(id: string): Product | undefined {
    const p = this.db.prepare('SELECT * FROM products WHERE id = ?').get(id) as
      | { id: string; name: string; objective: string; created_at: string; updated_at: string } | undefined;
    if (!p) return undefined;
    const kpis = this.db.prepare('SELECT name, target FROM kpis WHERE product_id = ? ORDER BY position').all(id) as unknown as Kpi[];
    return { id: p.id, name: p.name, objective: p.objective, kpis: kpis.map((k) => ({ name: k.name, target: k.target })), createdAt: p.created_at, updatedAt: p.updated_at };
  }

  home(id: string): ProductHome | undefined {
    const product = this.getProduct(id);
    if (!product) return undefined;
    return { product, links: this.links(id) };
  }

  links(productId: string): Link[] {
    return (this.db.prepare('SELECT * FROM links WHERE product_id = ? ORDER BY created_at, rowid').all(productId) as unknown as LinkRow[]).map(toLink);
  }

  getLink(id: string): Link | undefined {
    const r = this.db.prepare('SELECT * FROM links WHERE id = ?').get(id) as unknown as LinkRow | undefined;
    return r ? toLink(r) : undefined;
  }

  createProduct(input: ProductInput): Product {
    const id = randomUUID();
    const at = this.now().toISOString();
    this.tx(() => {
      this.db.prepare('INSERT INTO products (id, name, objective, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, input.name, input.objective, at, at);
      this.writeKpis(id, input.kpis);
    });
    return this.getProduct(id)!;
  }

  updateProduct(id: string, input: ProductInput): Product | undefined {
    const changed = this.tx(() => {
      const r = this.db.prepare('UPDATE products SET name = ?, objective = ?, updated_at = ? WHERE id = ?').run(input.name, input.objective, this.now().toISOString(), id);
      if (Number(r.changes) === 0) return false;
      this.db.prepare('DELETE FROM kpis WHERE product_id = ?').run(id);
      this.writeKpis(id, input.kpis);
      return true;
    });
    return changed ? this.getProduct(id) : undefined;
  }

  /** Removes the product and, by cascade, its KPIs and links. Local data only. */
  deleteProduct(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM products WHERE id = ?').run(id).changes) > 0;
  }

  private writeKpis(productId: string, kpis: Kpi[]) {
    const ins = this.db.prepare('INSERT INTO kpis (product_id, position, name, target) VALUES (?, ?, ?, ?)');
    kpis.forEach((k, i) => ins.run(productId, i, k.name, k.target));
  }

  /** Adds links in one transaction, skipping any already linked to this product. */
  addLinks(productId: string, links: NewLink[]): { added: number; duplicates: number } {
    const ins = this.db.prepare(`
      INSERT INTO links (id, product_id, role, kind, repo_host, repo_full_name, path, anchor, pr_number, title, artifact_type, blob_sha, stage, stage_entered_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `);
    // ON CONFLICT (not INSERT OR IGNORE) so only an already-linked target is skipped; a CHECK failure still throws.
    return this.tx(() => {
      let added = 0;
      const at = this.now().toISOString();
      for (const l of links) {
        const r = ins.run(
          randomUUID(), productId, l.role, l.kind, l.repoHost, l.repoFullName, l.path ?? null, l.anchor ?? null, l.prNumber ?? null,
          l.title, l.artifactType ?? null, l.blobSha ?? null, l.stage ?? null, l.stageEnteredAt ?? null, at,
        );
        added += Number(r.changes);
      }
      if (added) this.touch(productId);
      return { added, duplicates: links.length - added };
    });
  }

  removeLink(id: string): boolean {
    const l = this.getLink(id);
    if (!l) return false;
    this.db.prepare('DELETE FROM links WHERE id = ?').run(id);
    this.touch(l.productId);
    return true;
  }

  /** Changes what a link points at (relinking) or how it is labelled. A changed target resets its health. */
  updateLink(id: string, patch: LinkPatch): Link | undefined {
    const cur = this.getLink(id);
    if (!cur) return undefined;
    const retarget = patch.path !== undefined || patch.anchor !== undefined || patch.prNumber !== undefined;
    const next = {
      path: patch.path ?? cur.path ?? null,
      anchor: patch.anchor === undefined ? cur.anchor ?? null : patch.anchor,
      prNumber: patch.prNumber === undefined ? cur.prNumber ?? null : patch.prNumber,
      title: patch.title ?? cur.title,
      artifactType: patch.artifactType ?? cur.artifactType ?? null,
      blobSha: patch.blobSha === undefined ? cur.blobSha ?? null : patch.blobSha,
    };
    this.db.prepare(`
      UPDATE links SET path = ?, anchor = ?, pr_number = ?, title = ?, artifact_type = ?, blob_sha = ?
        ${retarget ? ", health = NULL, health_reason = NULL, moved_to = NULL, checked_at = NULL" : ''}
      WHERE id = ?
    `).run(next.path, next.anchor, next.prNumber, next.title, next.artifactType, next.blobSha, id);
    this.touch(cur.productId);
    return this.getLink(id);
  }

  setHealth(id: string, health: LinkHealth): void {
    if (health.state === 'unchecked') {
      this.db.prepare('UPDATE links SET health = NULL, health_reason = NULL, moved_to = NULL, checked_at = NULL WHERE id = ?').run(id);
      return;
    }
    this.db.prepare('UPDATE links SET health = ?, health_reason = ?, moved_to = ?, checked_at = ? WHERE id = ?').run(
      health.state, health.state === 'broken' ? health.reason : null, health.state === 'broken' ? health.movedTo ?? null : null, health.checkedAt, id,
    );
  }

  private touch(productId: string) {
    this.db.prepare('UPDATE products SET updated_at = ? WHERE id = ?').run(this.now().toISOString(), productId);
  }
}
