import type { DatabaseSync } from 'node:sqlite';

export interface CachedResponse {
  etag?: string;
  status: 200 | 404;
  body: unknown;
  fetchedAt: string;
}

/**
 * The GitHub response cache: the last body and ETag for each request, in the product database.
 * The sync sends the ETag back as If-None-Match, so an unchanged resource costs a 304 (which
 * GitHub doesn't count against the rate limit), and the board can render entirely from here when
 * GitHub can't be reached. Holds repo metadata and file contents the PM has linked — the same
 * kind of data the app already shows — and never the token.
 */
export class HttpCache {
  constructor(private db: DatabaseSync, private now: () => Date = () => new Date()) {}

  get(key: string): CachedResponse | undefined {
    const r = this.db.prepare('SELECT etag, status, body, fetched_at FROM http_cache WHERE key = ?').get(key) as
      | { etag: string | null; status: number; body: string; fetched_at: string } | undefined;
    if (!r) return undefined;
    return { ...(r.etag ? { etag: r.etag } : {}), status: r.status === 404 ? 404 : 200, body: JSON.parse(r.body), fetchedAt: r.fetched_at };
  }

  put(key: string, status: 200 | 404, body: unknown, etag?: string): void {
    this.db.prepare(`
      INSERT INTO http_cache (key, etag, status, body, fetched_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET etag = excluded.etag, status = excluded.status, body = excluded.body, fetched_at = excluded.fetched_at
    `).run(key, etag ?? null, status, JSON.stringify(body), this.now().toISOString());
  }

  /** Marks a cached entry as confirmed fresh by a 304. */
  touch(key: string): void {
    this.db.prepare('UPDATE http_cache SET fetched_at = ? WHERE key = ?').run(this.now().toISOString(), key);
  }
}
