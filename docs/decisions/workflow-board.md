# Workflow board: stages, GitHub state, and the cache

Phase 3a, per the PM Workbench plan (Workflow stages; Phase 3) and ADR 001.

## Decided before this phase

- Five fixed stages that match the team's process: intake and triage, problem brief, solution
  (including journey analysis), specification (feature request handoff), release and feedback.
  Configurable stages are deferred.
- The repos have no convention, so the PM places each item. Inferring a stage from paths was
  rejected as unreliable.
- Moving a card is local. It writes nothing to GitHub.

## Stages

- `links.stage` and `links.stage_entered_at` were reserved in schema 1. Migration 2 adds
  `stage_events`, which records every placement, move and un-placement with from, to and when.
  Phase 3b's time-in-stage and stage-over-time views read it.
- `stage_entered_at` changes only when the stage actually changes. Re-selecting the same stage is
  a no-op.
- Existing links start unstaged and show in the tray.
- Suggested stages come from what the item is. They pre-fill the link picker and the tray's
  "Place in …" button, and can always be overridden:

  | Item | Suggested stage |
  |---|---|
  | CRM customer or conversation | Intake and triage |
  | Problem brief | Problem brief |
  | Solution brief | Solution |
  | Specification, PDR file or PDR pull request | Specification |
  | Executive communication | Release and feedback |
  | Control book, other | none (the PM decides) |

  In the picker, a stage the PM hasn't touched follows the artifact type if the type changes.

- Stages are part of the export file, and import validates them.

## How state is derived

One sync (`src/main/products/sync.ts`) produces both the board state and the link health, which
replaces Phase 2's per-link checks.

**Files** (artifacts, customers, conversations, PDR files):

1. One recursive tree read per repo at the default branch. This gives every file's blob SHA, so
   "does it exist" is answered for all of that repo's links at once. A missing file whose last
   known SHA appears at another path is reported as moved, at no extra cost.
2. When the file was last changed, and by whom: `GET /commits?path=…&per_page=1`. This is read
   only when the file's SHA differs from the last sync; otherwise the stored value is reused.
3. Conversations: the file's blob is read once per SHA (blobs are immutable, so it is never
   re-requested) and only its section anchors are kept, to check the linked section still exists.

**Pull requests:** `GET /pulls/{n}` plus `GET /pulls/{n}/reviews`. The status is:

- `merged`, `closed` or `draft` when GitHub says so;
- otherwise `changes-requested` if any reviewer's latest decisive review asks for changes;
- otherwise `approved` if any reviewer approved;
- otherwise `open`.

A comment after a decision doesn't undo the decision. A re-requested reviewer counts as waiting,
whatever they said before. The card lists who approved, who asked for changes, and who is still
waiting.

Only a 404 marks an item missing or a link broken. A network error, a 5xx or a rate limit
leaves the stored state alone.

## Cache and staleness

- `http_cache` (SQLite, same database) keeps each request's ETag and a trimmed body: the tree as
  path/SHA pairs, a commit's date and author, a blob's section anchors. Every request sends
  `If-None-Match`. A 304 reuses the cached body and doesn't count against GitHub's rate limit.
- `item_state` keeps each link's derived state. `sync_status` keeps per-product last success,
  last attempt, last error, and the request and 304 counts of the last sync.
- **Opening a product** renders from `item_state` straight away. It syncs on open, every 5 minutes
  while the window is visible, and on **Refresh**.
- **Staleness:** the board says "Synced N min ago". After a failed sync it says why ("Couldn't
  reach GitHub", "rate limit is used up until …", or a blocked request) and how old the shown
  data is.
- **Rate limits:** the first rate-limited response stops the sync from sending more requests.
- **Offline at launch:** if the stored token can't be re-checked because GitHub didn't answer at
  all, the app stays signed in, marked offline, using the last known login. A token GitHub rejects
  (any HTTP status) still signs out.

## Measured cost

Against `gonzalovazquez/pm-{artifacts,crm,pdr}` with the seeded "Checkout retry flow" product
(6 links: 2 artifacts, a customer, 2 conversations of that customer, a PDR file; no PR links):

| Sync | Requests | 304s |
|---|---|---|
| First (empty cache) | 8 (3 trees + 4 last-commit reads + 1 blob) | 0 |
| Refresh, nothing changed | 3 (3 trees) | 3 |

Each linked pull request adds 2 requests per sync, which are 304s when nothing changed. In
general, a refresh costs about 3 + 2 × (PR links) + (files whose content changed) + (changed
customer files with linked conversations). Unchanged requests are free. That is far inside the
5,000/hour limit even for products with hundreds of links.
