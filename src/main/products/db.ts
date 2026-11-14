import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The local product-mapping database. SQLite through Node's built-in `node:sqlite` module, which
 * ships inside Electron's Node runtime, so there is no native addon to rebuild per architecture
 * and nothing extra to sign. See docs/decisions/product-model.md.
 *
 * Migrations run in order and the applied count is kept in `PRAGMA user_version`. Never edit a
 * migration that has shipped; add a new one.
 */
export const MIGRATIONS: string[] = [
  // 1: products, KPIs and links.
  `
  CREATE TABLE products (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
    objective   TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE kpis (
    product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    name        TEXT NOT NULL,
    target      TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (product_id, position)
  );

  -- One row per item linked to a product. The repo is stored by host and full name rather than by
  -- role, so a link keeps meaning the same repo if the role is later reassigned, and so an export
  -- can be matched to repos on another machine.
  CREATE TABLE links (
    id                TEXT PRIMARY KEY,
    product_id        TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    role              TEXT NOT NULL CHECK (role IN ('artifacts', 'crm', 'pdr')),
    kind              TEXT NOT NULL CHECK (kind IN ('artifact', 'customer', 'conversation', 'decision')),
    repo_host         TEXT NOT NULL,
    repo_full_name    TEXT NOT NULL,
    path              TEXT,
    anchor            TEXT,
    pr_number         INTEGER,
    title             TEXT NOT NULL,
    artifact_type     TEXT,
    blob_sha          TEXT,
    -- Reserved for Phase 3's workflow board.
    stage             TEXT,
    stage_entered_at  TEXT,
    -- Last link check against GitHub: NULL = never checked, 'ok', or 'broken'.
    health            TEXT CHECK (health IS NULL OR health IN ('ok', 'broken')),
    health_reason     TEXT,
    moved_to          TEXT,
    checked_at        TEXT,
    created_at        TEXT NOT NULL,
    CHECK (path IS NOT NULL OR pr_number IS NOT NULL),
    CHECK (kind <> 'conversation' OR anchor IS NOT NULL)
  );

  CREATE INDEX links_by_product ON links(product_id);
  CREATE UNIQUE INDEX links_unique_target ON links(
    product_id, repo_host, repo_full_name, kind, coalesce(path, ''), coalesce(anchor, ''), coalesce(pr_number, 0)
  );
  `,
  // 2: workflow board (Phase 3a). Stages already have columns on links (reserved in 1); this adds
  // the move history, the GitHub response cache, each item's derived state, and per-product sync status.
  `
  -- Every time an item is placed in, moved between or taken out of a stage. Phase 3b's
  -- time-in-stage and stage-over-time views read this.
  CREATE TABLE stage_events (
    id          INTEGER PRIMARY KEY,
    link_id     TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    from_stage  TEXT,
    to_stage    TEXT,
    at          TEXT NOT NULL
  );
  CREATE INDEX stage_events_by_product ON stage_events(product_id, at);

  -- Conditional-request cache: the last body and ETag per GitHub request, shared across products.
  CREATE TABLE http_cache (
    key         TEXT PRIMARY KEY,
    etag        TEXT,
    status      INTEGER NOT NULL CHECK (status IN (200, 404)),
    body        TEXT NOT NULL,
    fetched_at  TEXT NOT NULL
  );

  -- What the last successful sync learned about each linked item.
  CREATE TABLE item_state (
    link_id    TEXT PRIMARY KEY REFERENCES links(id) ON DELETE CASCADE,
    state      TEXT NOT NULL,
    synced_at  TEXT NOT NULL
  );

  CREATE TABLE sync_status (
    product_id       TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
    last_success_at  TEXT,
    last_attempt_at  TEXT,
    last_error       TEXT,
    requests         INTEGER,
    not_modified     INTEGER
  );
  `,
  // 3: flow metrics (Phase 3b). One row per product per local day: how many items sat in each stage.
  `
  CREATE TABLE stage_snapshots (
    product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    date        TEXT NOT NULL,
    counts      TEXT NOT NULL,
    PRIMARY KEY (product_id, date)
  );
  `,
];

export function openDatabase(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

export function schemaVersion(db: DatabaseSync): number {
  return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
}

export function migrate(db: DatabaseSync, migrations = MIGRATIONS): void {
  const from = schemaVersion(db);
  if (from > migrations.length) {
    throw new Error(`The product database is from a newer version of PM Workbench (schema ${from}; this build knows ${migrations.length}).`);
  }
  for (let v = from; v < migrations.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(migrations[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
