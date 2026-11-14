import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { RepoRole } from '../../shared/ipc.js';
import { localDate, MAX_POINTS, stageCounts, type StagePoint } from '../../shared/metrics.js';
import type { AppPull } from '../../shared/writes.js';
import { isStage, type ArtifactType, type ItemState, type Kpi, type Link, type LinkHealth, type LinkKind, type Product, type ProductHome, type ProductInput, type ProductSummary, type SyncStatus, type WorkflowStage } from '../../shared/products.js';

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
  stage?: WorkflowStage;
  stageEnteredAt?: string;
  pending?: { prNumber: number; branch: string };
}

export interface StageEvent {
  linkId: string;
  from?: WorkflowStage;
  to?: WorkflowStage;
  at: string;
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
  pending_pr: number | null; pending_branch: string | null;
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
  if (r.stage !== null && isStage(r.stage)) l.stage = r.stage;
  if (r.stage_entered_at !== null) l.stageEnteredAt = r.stage_entered_at;
  if (r.pending_pr !== null && r.pending_branch !== null) l.pending = { prNumber: Number(r.pending_pr), branch: r.pending_branch };
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
    return { product, links: this.links(id), states: this.states(id), sync: this.syncStatus(id), history: this.history(id) };
  }

  /**
   * Records today's stage counts for a product, replacing any earlier point from the same local day,
   * and keeps at most MAX_POINTS days. Called after every sync and every stage change.
   */
  snapshot(productId: string): void {
    const date = localDate(this.now());
    const counts = stageCounts(this.links(productId));
    this.tx(() => {
      this.db.prepare(`
        INSERT INTO stage_snapshots (product_id, date, counts) VALUES (?, ?, ?)
        ON CONFLICT (product_id, date) DO UPDATE SET counts = excluded.counts
      `).run(productId, date, JSON.stringify(counts));
      this.db.prepare(`
        DELETE FROM stage_snapshots WHERE product_id = ? AND date NOT IN
          (SELECT date FROM stage_snapshots WHERE product_id = ? ORDER BY date DESC LIMIT ?)
      `).run(productId, productId, MAX_POINTS);
    });
  }

  history(productId: string): StagePoint[] {
    const rows = this.db.prepare('SELECT date, counts FROM stage_snapshots WHERE product_id = ? ORDER BY date').all(productId) as { date: string; counts: string }[];
    return rows.map((r) => ({ date: r.date, counts: { ...stageCounts([]), ...JSON.parse(r.counts) } }));
  }

  states(productId: string): Record<string, ItemState> {
    const rows = this.db.prepare('SELECT s.link_id, s.state FROM item_state s JOIN links l ON l.id = s.link_id WHERE l.product_id = ?').all(productId) as { link_id: string; state: string }[];
    return Object.fromEntries(rows.map((r) => [r.link_id, JSON.parse(r.state) as ItemState]));
  }

  setItemState(linkId: string, state: ItemState): void {
    this.db.prepare(`
      INSERT INTO item_state (link_id, state, synced_at) VALUES (?, ?, ?)
      ON CONFLICT (link_id) DO UPDATE SET state = excluded.state, synced_at = excluded.synced_at
    `).run(linkId, JSON.stringify(state), this.now().toISOString());
  }

  syncStatus(productId: string): SyncStatus {
    const r = this.db.prepare('SELECT * FROM sync_status WHERE product_id = ?').get(productId) as
      | { last_success_at: string | null; last_attempt_at: string | null; last_error: string | null; requests: number | null; not_modified: number | null } | undefined;
    if (!r) return {};
    const s: SyncStatus = {};
    if (r.last_success_at) s.lastSuccessAt = r.last_success_at;
    if (r.last_attempt_at) s.lastAttemptAt = r.last_attempt_at;
    if (r.last_error) s.lastError = r.last_error;
    if (r.requests !== null) s.requests = Number(r.requests);
    if (r.not_modified !== null) s.notModified = Number(r.not_modified);
    return s;
  }

  /** Records a sync attempt. A failed attempt keeps the last success time, so the board can say how old its data is. */
  recordSync(productId: string, r: { ok: boolean; error?: string; requests: number; notModified: number }): void {
    const at = this.now().toISOString();
    this.db.prepare(`
      INSERT INTO sync_status (product_id, last_success_at, last_attempt_at, last_error, requests, not_modified) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (product_id) DO UPDATE SET
        last_success_at = coalesce(excluded.last_success_at, sync_status.last_success_at),
        last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error,
        requests = excluded.requests, not_modified = excluded.not_modified
    `).run(productId, r.ok ? at : null, at, r.error ?? null, r.requests, r.notModified);
  }

  /**
   * Places an item in a stage (or back in the unstaged tray with null). The entered-at date only
   * changes when the stage does, and every change is recorded for Phase 3b's metrics.
   */
  moveLink(id: string, stage: WorkflowStage | null): Link | undefined {
    const cur = this.getLink(id);
    if (!cur) return undefined;
    if ((cur.stage ?? null) === stage) return cur;
    const at = this.now().toISOString();
    this.tx(() => {
      this.db.prepare('UPDATE links SET stage = ?, stage_entered_at = ? WHERE id = ?').run(stage, stage ? at : null, id);
      this.db.prepare('INSERT INTO stage_events (link_id, product_id, from_stage, to_stage, at) VALUES (?, ?, ?, ?, ?)').run(id, cur.productId, cur.stage ?? null, stage, at);
      this.touch(cur.productId);
    });
    this.snapshot(cur.productId);
    return this.getLink(id);
  }

  stageEvents(productId: string): StageEvent[] {
    const rows = this.db.prepare('SELECT link_id, from_stage, to_stage, at FROM stage_events WHERE product_id = ? ORDER BY at, id').all(productId) as
      { link_id: string; from_stage: string | null; to_stage: string | null; at: string }[];
    return rows.map((r) => {
      const e: StageEvent = { linkId: r.link_id, at: r.at };
      if (isStage(r.from_stage)) e.from = r.from_stage;
      if (isStage(r.to_stage)) e.to = r.to_stage;
      return e;
    });
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
  /** Ids of the links inserted by the last addLinks call, in order (duplicates skipped). */
  lastAddedIds: string[] = [];

  addLinks(productId: string, links: NewLink[]): { added: number; duplicates: number } {
    const ins = this.db.prepare(`
      INSERT INTO links (id, product_id, role, kind, repo_host, repo_full_name, path, anchor, pr_number, title, artifact_type, blob_sha, stage, stage_entered_at, created_at, pending_pr, pending_branch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `);
    // ON CONFLICT (not INSERT OR IGNORE) so only an already-linked target is skipped; a CHECK failure still throws.
    this.lastAddedIds = [];
    return this.tx(() => {
      let added = 0;
      const at = this.now().toISOString();
      const ev = this.db.prepare('INSERT INTO stage_events (link_id, product_id, from_stage, to_stage, at) VALUES (?, ?, NULL, ?, ?)');
      for (const l of links) {
        const id = randomUUID();
        const stageAt = l.stage ? l.stageEnteredAt ?? at : null;
        const r = ins.run(
          id, productId, l.role, l.kind, l.repoHost, l.repoFullName, l.path ?? null, l.anchor ?? null, l.prNumber ?? null,
          l.title, l.artifactType ?? null, l.blobSha ?? null, l.stage ?? null, stageAt, at, l.pending?.prNumber ?? null, l.pending?.branch ?? null,
        );
        added += Number(r.changes);
        if (Number(r.changes)) this.lastAddedIds.push(id);
        if (Number(r.changes) && l.stage) ev.run(id, productId, l.stage, stageAt);
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

  /** The item's pull request merged: the link now points at a normal file on the default branch. */
  clearPending(linkId: string): void {
    this.db.prepare('UPDATE links SET pending_pr = NULL, pending_branch = NULL WHERE id = ?').run(linkId);
  }

  // ------------------------------------------------------------------ branches and PRs the app opened

  /** Records a write. Without a PR number it is "in flight": its branch may exist but its pull request isn't confirmed yet. */
  recordWrite(w: Omit<AppPull, 'id' | 'createdAt' | 'updatedAt'> & { repoHost: string; linkPlan?: NewLink }): AppPull {
    const id = randomUUID();
    const at = this.now().toISOString();
    this.db.prepare(`
      INSERT INTO writes (id, product_id, role, repo_host, repo_full_name, base, branch, pr_number, pr_url, title, paths, created_at, updated_at, link_plan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, w.productId ?? null, w.role, w.repoHost, w.repo, w.base, w.branch, w.prNumber ?? null, w.prUrl ?? null, w.title, JSON.stringify(w.paths), at, at, w.linkPlan ? JSON.stringify(w.linkPlan) : null);
    return this.writes().find((x) => x.id === id)!;
  }

  /** The pull request for an in-flight write was opened. */
  completeWrite(id: string, prNumber: number, prUrl: string): void {
    this.db.prepare('UPDATE writes SET pr_number = ?, pr_url = ?, link_plan = NULL, updated_at = ? WHERE id = ?').run(prNumber, prUrl, this.now().toISOString(), id);
  }

  deleteWrite(id: string): void {
    this.db.prepare('DELETE FROM writes WHERE id = ?').run(id);
  }

  /** Writes recorded before their pull request was confirmed, with the link each meant to add. */
  inFlightWrites(): (AppPull & { repoHost: string; linkPlan?: NewLink })[] {
    const rows = this.db.prepare('SELECT id, repo_host, link_plan FROM writes WHERE pr_number IS NULL').all() as { id: string; repo_host: string; link_plan: string | null }[];
    const all = new Map(this.writes().map((w) => [w.id, w]));
    return rows.map((r) => ({ ...all.get(r.id)!, repoHost: r.repo_host, ...(r.link_plan ? { linkPlan: JSON.parse(r.link_plan) as NewLink } : {}) }));
  }

  /** Adds paths to a write after another commit went onto its branch. */
  touchWrite(id: string, paths: string[]): void {
    const cur = this.writes().find((w) => w.id === id);
    if (!cur) return;
    const all = [...new Set([...cur.paths, ...paths])];
    this.db.prepare('UPDATE writes SET paths = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(all), this.now().toISOString(), id);
  }

  writes(): AppPull[] {
    const rows = this.db.prepare('SELECT * FROM writes ORDER BY created_at DESC').all() as {
      id: string; product_id: string | null; role: AppPull['role']; repo_full_name: string; base: string; branch: string; pr_number: number | null; pr_url: string | null;
      title: string; paths: string; created_at: string; updated_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id, ...(r.product_id ? { productId: r.product_id } : {}), role: r.role, repo: r.repo_full_name, base: r.base, branch: r.branch,
      ...(r.pr_number !== null ? { prNumber: Number(r.pr_number) } : {}), ...(r.pr_url ? { prUrl: r.pr_url } : {}),
      title: r.title, paths: JSON.parse(r.paths) as string[], createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  }

  /** App writes in a repo whose branch touches `path`, newest first. */
  writesTouching(repo: string, path: string): AppPull[] {
    return this.writes().filter((w) => w.repo.toLowerCase() === repo.toLowerCase() && w.paths.includes(path));
  }
}
