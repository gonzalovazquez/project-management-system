# Product model: local SQLite, links by reference, export/import

Phase 2, per the PM Workbench plan (Technical approach → Product model and linking; Objectives).

## Decided before this phase

- The three repos carry no product convention and the app must not add one, so the mapping
  from a product to repo items lives in a local database. A manifest file and frontmatter tags were
  both rejected because they change the repos.
- The objective and optional KPIs are fields on the product.
- Sharing in v1 is export/import of one product's mapping as a file.
- Control books and executive communication are ordinary artifact types.

## Decided in this phase

### SQLite library: Node's built-in `node:sqlite`

Electron 44 ships Node 24.22, which includes `node:sqlite` (SQLite 3.53). Choosing it over
`better-sqlite3` means there is no native addon: nothing to rebuild per architecture in
electron-builder, nothing extra to sign and notarize in Phase 5, and nothing that can drift out of
step with Electron's ABI. Its API is synchronous like better-sqlite3's, which suits a small local
file. The tests run it under the system Node (26), and the smoke test and an end-to-end run
exercise it inside Electron.

### Schema (`src/main/products/db.ts`)

- `products` — id, name, objective, timestamps.
- `kpis` — product, position, name, target. Ordered; deleted with the product.
- `links` — one row per linked item:
  - `role` and `kind`: artifacts → `artifact`; CRM → `customer` (a whole customer file) or
    `conversation` (one `##` section of it); PDR → `decision`.
  - the repo as `repo_host` + `repo_full_name`, not as a role, so a link keeps meaning the same repo
    if roles are reassigned, and an export can be matched on another machine;
  - the target: `path` (+ `anchor` for a conversation), or `pr_number` for a PDR under review;
  - `title`, `artifact_type`, `blob_sha`;
  - `stage`, `stage_entered_at`: reserved for Phase 3;
  - `health`, `health_reason`, `moved_to`, `checked_at`: the last link check.
  - CHECK constraints require a target, and a section for a conversation. A unique index on
    (product, repo, kind, path, anchor, PR) stops the same item being linked twice.
- Migrations are an ordered list; `PRAGMA user_version` records how many have run. Each runs in a
  transaction, and a database from a newer build is refused rather than misread.

Repo roles stay in `settings.json`, where Phase 1 put them, rather than moving into SQLite. They are
a per-machine setting, not product data, and every link already records its repo by host and
full name.

### What the CRM and PDR repos look like, and how that is modelled

The test repos settled both open questions without needing a guess:

- **CRM:** `customers/<name>.md`, one file per customer, with dated `## YYYY-MM-DD — topic`
  sections for conversations. A customer link is the file; a conversation link is the file plus
  the section's GitHub-style slug. Nothing assumes the folder name or the date format: any `##`
  heading in any file in the CRM repo can be a conversation.
- **PDR:** spec files approved through git-flow pull requests. A decision link is either the file or
  the pull request, so a PDR still under review can be linked before it merges.

### How references survive renames and deletions

Links are stored by path (or PR number), and a link check runs each time a product home opens:

- a file that is gone (404) is marked broken. If its last known blob SHA now sits at another path
  on the default branch (one recursive tree read per repo, only when something there is missing),
  the new path is offered as a one-click relink;
- a conversation whose section heading is gone is marked broken;
- a pull request that 404s is marked broken;
- a link whose repo is no longer connected is marked broken;
- any failure other than a 404 (offline, rate limited, 5xx) leaves the stored health alone, so a
  network problem never marks everything broken.

Every successful check refreshes the stored blob SHA, so move detection compares against the
latest content. It cannot follow a move that also changed the file. The PM relinks or removes
those by hand.

### Export format

```json
{
  "format": "pm-workbench.product-mapping",
  "version": 1,
  "exportedAt": "2026-11-14T12:00:00.000Z",
  "product": { "name": "…", "objective": "…", "kpis": [{ "name": "…", "target": "…" }] },
  "links": [
    { "role": "crm", "kind": "conversation", "repo": { "host": "github.com", "fullName": "owner/pm-crm" },
      "path": "customers/acme-corp.md", "anchor": "2026-09-18--checkout-retry-friction",
      "title": "2026-09-18 — Checkout retry friction", "blobSha": "…" }
  ]
}
```

Import validates the whole file before writing anything. It always creates a new product, and it
matches each link by host and full name against the repo assigned to that link's role on the
importing Mac. Links that don't match are listed with the reason and left out; the rest are
imported.
