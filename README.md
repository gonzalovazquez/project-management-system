# PM Workbench

A macOS desktop app that connects a product manager's three GitHub repos — artifacts and Claude
skills, CRM (customer conversations), and PDR (spec approval via git flow) — around the product
they're managing: create a product with an objective, link the artifacts, customers and decision
records that belong to it, and see them together on one product home.

This is adapted from [Project Dashboard](https://github.com/gonzalovazquez/project-dashboard),
reusing its Electron/React shell and security model; the scanning-and-Notion-focused features it
had are not what this app does. See [`docs/decisions/github-access.md`](docs/decisions/github-access.md)
for why the GitHub access layer is built the way it is, and the plan's ADR 001 (on the Notion page
this project was brainstormed on) for why the codebase was reused at all rather than starting
from scratch.

**Phase 1** is sign-in and read-only browsing: a GitHub personal access token, the three repo roles
assigned to real repos, and a tree/file browser for each. **Phase 2** adds the product model:
products with an objective and KPIs, links into the three repos kept in a local SQLite database,
a product home, broken-link detection, and export/import of a product's mapping. See
[`docs/decisions/product-model.md`](docs/decisions/product-model.md). The workflow board, flow
metrics, and write-back via pull request are later phases.

**Phase 3a** adds the per-product workflow board: five fixed stages, an unstaged tray, each item's
live GitHub state, and a local cache so it opens instantly and works offline. See
[`docs/decisions/workflow-board.md`](docs/decisions/workflow-board.md).

**Phase 3b** adds flow metrics per product: activity per week across the three repos, items by
stage over time, time in stage against review points, stall flags, and an explainable health score.
These are flow metrics: they show how work moves, not whether the objective moved. See
[`docs/decisions/flow-metrics.md`](docs/decisions/flow-metrics.md).

**Phase 4a** adds write-back: create an artifact from a template, or edit a linked one, and it
lands as a branch plus a pull request in the artifacts repo after a preview you confirm. Nothing is
ever committed to a default branch. **Phase 4b** extends that to logging CRM conversations and
raising PDRs (following the PDR repo's branch convention, such as git-flow's `spec/…` into
`develop`), and shows each PDR's approval status and unresolved comments, plus a page of every pull
request the app opened. See [`docs/decisions/write-back.md`](docs/decisions/write-back.md).

## Install

Build it on a Mac (see [`docs/release.md`](docs/release.md) for signing and notarization):

```
git clone https://github.com/gonzalovazquez/project-management-system.git
cd project-management-system
npm install
npm run package        # release/PM Workbench-<version>-universal.dmg and .zip (Apple silicon + Intel)
```

Open the `.dmg` and drag **PM Workbench** to Applications. A build made with Developer ID
credentials is signed and notarized, and opens normally. Without them the build is unsigned, so
right-click the app and choose **Open** the first time, or run
`xattr -dr com.apple.quarantine "/Applications/PM Workbench.app"`.

To run from source instead: `npm run dev`.

The first launch walks through setup: sign in, then connect the three repos, then templates, then
a first product.

## Using it

1. **Sign in.** Paste a GitHub personal access token (and the host, if you're on GitHub Enterprise
   Server rather than github.com). It's encrypted with the system keychain; if the keychain isn't
   available, set `GITHUB_TOKEN` in the environment instead and the app never tries to store it.
2. **Connect your three repos.** On first sign-in you land on Settings, where each role — Artifacts
   and skills, CRM, PDR — gets assigned to one of the repos your token can see. Nothing is moved or
   copied; the app just remembers which repo is which.
3. **Create a product.** Products → New product: a name, the objective it is driving, and optional
   KPIs. Products live only on this Mac.
4. **Link items.** On the product home, **Link items** opens a picker across all three repos: tick
   artifacts (and set each one's type — problem brief, solution brief, specification, control book,
   executive communication), tick a CRM customer file or open it to pick individual dated
   conversations, and tick PDR files or pick a pull request under review.
5. **Product home.** The objective and KPIs on top; customers (with their conversations),
   artifacts grouped by type, and decisions below, each opening a preview. Links are checked
   against GitHub when the page opens; a moved or deleted target shows as broken, with **Relink**
   (one click when the same content was found at a new path) or **Remove**.
6. **Share.** **Export mapping** writes the product to a `.pmworkbench.json` file; a teammate uses
   **Import mapping…** on the Products page. Links whose repo isn't connected on their Mac are
   listed and left out rather than failing the import. Stages travel with the mapping.
7. **Workflow board.** The product's **Board** tab lays every linked item across the five stages —
   intake and triage, problem brief, solution, specification, release and feedback — with
   anything not yet placed in an **Unstaged** tray. Drag a card between columns, or use its stage
   menu. Each card shows its GitHub state: a file's last change and who made it, or a pull
   request's status (draft, open, changes requested, approved, merged, closed) and reviewers.
   Filter by artifact type or customer. Moving a card only changes this Mac's mapping. Cards past
   their stage's review point, or gone quiet, say so.
8. **Flow metrics.** The product's **Metrics** tab shows its activity pulse, stall flags and flow
   health, then charts for activity per week (by repo), items by stage over time, time in stage, a
   daily activity heatmap, and the health breakdown. Every chart has a table view. The review
   points are set in Settings. The product home shows a compact pulse / flags / health strip.
9. **Write.** **New artifact** on a product opens an editor with Write and Preview tabs. It starts
   from the type's template (set paths in Settings → Artifact templates). Pick the type, title,
   destination path and board stage. To change an existing artifact, use **Edit** on a linked one.
   **Review changes** shows the repo, branch, diff and pull request text; nothing is sent until
   **Open pull request**. A new artifact is linked straight away and shows as pending until its
   pull request merges. Editing a file the app already has an open pull request for adds a commit
   to that pull request instead of opening another.
10. **CRM and PDRs.** **Log conversation** adds a dated section to a customer's file (or a new
    customer), in the CRM repo's own style. **Raise PDR** starts from the PDR repo's template (or a
    minimal structure), numbers it after the existing records, and opens the pull request on the
    repo's branch convention, which you confirm the first time. Each PDR's review status, reviewers
    and unresolved comments show under Decisions, on its board card, and on **Pull requests**.
11. **Browse.** Each repo role in the sidebar still opens a read-only tree-and-file view.

## Commands

```
npm install
npm run dev                    # run the app with hot reload
npm run build                  # build main, preload and renderer into out/
npm run package                # macOS .dmg and .zip (run on a Mac); npm run package:dir for the current OS
npm run icon                   # redraw build/icon.png
npm test                       # unit and integration tests
npm run typecheck
npm run smoke                  # launch the real app and run 11 security and launch checks; SMOKE_BIN=<app> tests a packaged build
npm run licenses               # regenerate docs/security/dependencies.md
npm run seed -- --assign-roles # add --with-history for sample stage history and an empty product; two sample products against <owner>/pm-{artifacts,crm,pdr}; set PMWORKBENCH_HOME to keep it out of your real data
```

## How it is built

Electron 44 with React and Vite, built by `electron-vite` 5. The main process owns GitHub access,
settings and token storage. The interface reaches it only through the bridge in
`src/preload/index.ts`, typed by `src/shared/ipc.ts`.

| Call | What it does |
|---|---|
| `getAuth`, `signIn`, `signOut` | Session state and a GitHub personal access token sign-in |
| `listAvailableRepos` | Every repo the signed-in token can see, for assigning to a role |
| `getSettings`, `saveSettings` | The host, the three repo-role assignments, appearance, onboarded |
| `browseTree`, `readFile` | Read-only browsing of one role's repo at its default branch |
| `listPulls`, `readPull` | Pull requests in a role's repo, for linking and previewing PDRs under review |
| `listProducts`, `getProduct`, `createProduct`, `updateProduct`, `deleteProduct` | The local product records (delete is local only) |
| `addLinks`, `updateLink`, `removeLink` | Link items to a product, relink or relabel one, unlink |
| `syncProduct` | Sync a product's items with GitHub: link health (broken, moved) and board state, through the response cache |
| `moveLink` | Place an item in a workflow stage, or back in the unstaged tray |
| `exportProduct`, `importProduct` | Save a product's mapping to a file, or import one as a new product |
| `previewWrite`, `confirmWrite` | Build a branch, diff and pull request without sending anything; then send exactly that preview |
| `editSource` | The current text of a linked artifact, from the app's open pull request touching it if there is one |
| `openOnGitHub` | Open a page on the configured GitHub host in the browser; any other URL is refused |
| `crmLayout`, `pdrLayout` | Where the CRM repo keeps customers and conversations; where PDRs live, their numbering, template and branch convention |
| `listAppPulls` | Every pull request the app opened, with live review state |

| Piece | Where | What it does |
|---|---|---|
| GitHub access | `src/main/github` | Host → API base URL, the network allow-list wrapper, the Octokit-based client |
| App service | `src/main/app` | Sign-in/session, settings store, token storage (keychain-encrypted), IPC registration, sender-trust check |
| Product model | `src/main/products`, `src/shared/products.ts` | SQLite schema and migrations, the product store, IPC input validation, the export format |
| Write-back | `src/main/write` | The write engine, the network write guard, the diff |
| Sync | `src/main/products/sync.ts`, `httpcache.ts` | Board state and link health from GitHub, conditional requests through a local response cache |
| Shell | `src/main/index.ts`, `src/preload` | Window, security settings, the renderer-side network guard, bridge |
| Flow metrics | `src/shared/metrics.ts`, `src/shared/pulse.ts`, `src/renderer/src/viewmodel/charts.ts` | Activity buckets and pulse, time in stage, stall flags, health; chart view models |
| Interface | `src/renderer` | React: sign-in, repo-role settings, the tree/file browser, products, product home, link picker, workflow board, metrics and charts |

The security evidence pack is in [`docs/security/`](docs/security/README.md), and the ship-criteria
results are in [`docs/ship-checklist.md`](docs/ship-checklist.md). Safety properties, each covered
by a test or `npm run smoke`:

- The GitHub token is encrypted with the system keychain (`safeStorage`). If encryption is
  unavailable the app refuses to save it instead of writing plain text. `GITHUB_TOKEN` in the
  environment always takes precedence and is never written to disk.
- Every GitHub request goes through a network allow-list that only lets the currently configured
  host through (`src/main/github/allowlist.ts`); the renderer's own content security policy
  (`connect-src 'self'`) and a `session.webRequest` guard in the main process block everything else.
- `contextIsolation` on, `nodeIntegration` off, sandboxed renderer, no navigation or new windows,
  a strict CSP in the built app, and a crashed window process is reloaded.
- IPC calls are checked against the sender's frame URL; a call from anything other than the app's
  own page is rejected before it reaches the service.
- Writes go through one engine and are always a new `pmworkbench/…` branch plus a pull request,
  or a commit on such a branch, after a preview the PM confirms. A network-level write guard
  refuses any other write, including anything touching a default branch, before it is sent.
- Every product call from the window is validated in the main process before it reaches SQL
  (`src/main/products/validate.ts`), and all SQL uses bound parameters.
- An exported mapping holds references and titles only: no file contents, no token.

App data (settings, encrypted token, `products.db`) lives in Electron's user data folder. Set
`PMWORKBENCH_HOME` to use another one, for example when experimenting or testing.

### Known limits

- Stage history starts the day a product is set up (GitHub keeps none), and weeks the app wasn't
  opened stay empty in the stage chart.
- Activity per file is capped at its last 100 commits.
- Unresolved review comments are re-counted when a pull request changes. Resolving a thread may
  not count as a change, so the count can lag until the next change.
- A sync reads one tree per repo, plus a commit lookup or blob read only for files whose content
  changed, plus two reads per linked pull request. Unchanged data comes back as free 304s. See
  the decision doc for measured costs.
- If GitHub can't be reached at launch, the app opens signed in but marked offline, showing cached
  data. A token GitHub rejects still signs you out.
- Move detection matches unchanged content only. A CRM customer file usually changes as
  conversations are added, so a moved customer file shows as broken without a suggestion.
- The 'Matrix' appearance theme from Project Dashboard was dropped rather than carried forward.
- The macOS look (sidebar blur, traffic lights) is built for macOS but was only checked in a
  browser and on Linux.
- Large files (over ~1MB) are truncated rather than paginated.
