# AGENTS.md

Guidance for coding agents (and humans) working in this repo. Read it before changing anything.
`README.md` is the user-facing overview; `docs/decisions/` explains why things are built the way they are.

## What this is

PM Workbench is a macOS Electron app. It gives a product manager one product-centred view over
three GitHub repos:
- **Artifacts and skills**: briefs, specs, control books, executive communications, Claude skills.
- **CRM**: customer files with dated conversation sections.
- **PDR**: product decision records, approved through pull requests.

The PM creates products with an objective, links repo items to them, sees them on a five-stage
workflow board with flow metrics, and creates or edits items. Every change lands as a branch plus a
pull request.

It is built for a PM team on managed work Macs, so the security constraints below are product
requirements, not preferences.

## Non-negotiable constraints

Breaking any of these is a bug, whatever the feature. Each is enforced by tests or `npm run smoke`.
Keep it that way.

1. **The only network destination is the configured GitHub host.**
   - No telemetry, analytics, crash reporting, auto-update, backend or third-party service.
   - Every main-process request goes through `createGuardedFetch` (`src/main/github/allowlist.ts`).
   - The renderer is limited by its CSP (`connect-src 'self'`) and the `session.webRequest` guard
     in `src/main/index.ts`.
   - Never add a dependency that phones home.
2. **The GitHub token never leaves the main process.**
   - It is stored only encrypted (`safeStorage`, in `src/main/app/secrets.ts`).
   - It is never logged, never written to disk in plain text, and never returned over the bridge.
3. **Every write to GitHub is a branch plus a pull request. Never commit to a default branch.**
   - All writes go through the one engine, `src/main/write/engine.ts`: preview, then confirm by
     id, then one commit, then a branch, then a pull request.
   - The network write guard (`src/main/write/guard.ts`) refuses anything else before it is sent.
   - Don't add a write path that bypasses the engine, and don't widen the guard without a test that
     proves the default branch is still unreachable.
4. **Nothing is added to the three repos for the app to work.**
   - The product mapping (products, links, stages, history) lives in local SQLite (`products.db`).
   - No manifest files, frontmatter or app-specific conventions are written to the repos.
5. **Electron stays hardened:**
   - `contextIsolation`, `sandbox` and `app.enableSandbox()` on; `nodeIntegration` off;
   - no new windows, navigation or `<webview>`;
   - a strict CSP in the packaged build;
   - IPC accepted only from the app's own page;
   - every IPC argument validated in the main process.
6. **Develop and test only against throwaway repos.** The test repos are
   `gonzalovazquez/pm-artifacts`, `pm-crm` and `pm-pdr`. Never point a dev build or an end-to-end
   run at real work repos.

## Commands

```
npm install
npm run dev          # run from source with hot reload
npm run typecheck    # tsc --noEmit
npm test             # vitest: unit and integration tests
npm run smoke        # builds, launches the real app, runs 11 security and launch checks
npm run seed -- --assign-roles [--with-history]   # sample products against the test repos; set PMWORKBENCH_HOME
npm run package      # universal macOS .dmg/.zip; signs and notarizes only when CSC_*/APPLE_* are set (docs/release.md)
npm run licenses     # regenerate docs/security/dependencies.md after changing dependencies
```

**Before saying a change is done:** `npm run typecheck`, `npm test` and `npm run smoke` must all
pass.

Use `PMWORKBENCH_HOME=<temp dir>` for any manual or automated run, so it never touches the real
app data.

## Layout

| Path | What lives there |
|---|---|
| `src/main/index.ts` | Electron shell: window, hardening, network guard, file dialogs, appearance, smoke probe |
| `src/main/app/` | `AppService` (everything the bridge calls), settings, token store, IPC registration, sender trust |
| `src/main/github/` | Octokit client, host → API URL, host allow-list |
| `src/main/products/` | SQLite schema and migrations (`db.ts`), `ProductStore`, sync and response cache, export/import format, input validation |
| `src/main/write/` | Write engine, network write guard, unified diff |
| `src/preload/index.ts` | The bridge: the only thing the renderer can call |
| `src/shared/` | Types and pure logic shared by both sides: `ipc.ts` (the bridge contract), `products.ts`, `metrics.ts`, `writes.ts`, `pulse.ts` |
| `src/renderer/src/` | React UI. `viewmodel/` holds pure, tested logic; `components/` only draws |
| `test/` | Vitest. `fakeGitHub.ts` is an HTTP-level fake GitHub (ETags/304s, refs, trees, commits, PRs, reviews, GraphQL threads) that drives the real Octokit client |
| `scripts/` | smoke, seed, package, licences, icon |
| `docs/decisions/` | Why each phase is built the way it is. Update the relevant one when you change a design. |
| `docs/security/` | Evidence pack for the security review. Keep it true. |

## Conventions

- **Logic in tested pure functions; components only draw.** Put rules in `src/shared/` or
  `src/renderer/src/viewmodel/`, with tests, and keep React components thin.
- **The bridge is a contract.** Adding a call means updating all of these:
  - `PMWorkbenchApi` and `CHANNELS` in `src/shared/ipc.ts`;
  - `src/preload/index.ts`;
  - the handler in `src/main/app/ipc.ts`;
  - `AppService`;
  - the expected key list in `scripts/smoke.sh`, which asserts the bridge's exact shape.
- **Validate in the main process.** IPC handlers take `unknown`, and `AppService` validates before
  use (see `src/main/products/validate.ts`). All SQL uses bound parameters.
- **Migrations are append-only.** Add a new entry to `MIGRATIONS` in `src/main/products/db.ts`;
  never edit one that has shipped. Add a test that upgrades a database from the previous version.
- **GitHub reads are cached and conditional.** Board and metrics data goes through `syncLinks`
  (`src/main/products/sync.ts`) and its ETag cache. Keep refresh costs bounded, and update the
  measured costs in `docs/decisions/` if they change. Only a 404 marks a link broken; network errors
  and rate limits leave state alone.
- **Offline and rate limits.** Reads fall back to cache, and a rate limit puts the app into a
  cooldown until GitHub's reset time. A 401 for the session's token signs out and keeps local data.
- **Charts and colours.** Follow the data-viz method:
  - every chart has a legend for multiple series, a table view and keyboard tooltips;
  - text uses text tokens, never series colours;
  - any new palette, or a palette for a new theme, must pass the validator against that theme's
    card surface, recorded in `docs/chart-colors.md`;
  - every colour theme must define every token (`test/themes.test.ts` enforces this).
- **Flow metrics are flow metrics.** They don't measure whether the objective or KPIs moved, and
  the UI must not imply they do. There is no burnup or forecast, because there is no definition of
  done.
- **Copy:** plain, specific UI text. Error messages say what happened and what to do next.

## Testing

- Prefer HTTP-level fakes (`test/fakeGitHub.ts`) over mocking the client, so Octokit's real
  behaviour (304s, error wrapping) is exercised.
  - Octokit wraps errors thrown by its `fetch`: a guard refusal arrives as the `cause` of an
    `HttpError`.
- Writes must be tested for:
  - exactly one PR per write;
  - zero changes to `main` / `develop`;
  - each failure case (stale base, collision, permission, protected branch, PR creation failure);
  - no half-created branch left behind.
- End-to-end checks drive the source build with Playwright (`_electron.launch`). Things to know:
  - the packaged app's fuses refuse debugger attachment;
  - Playwright forces a light colour scheme unless you call `page.emulateMedia({ colorScheme: null })`;
  - "Synced" text can be left over from a previous session, so wait for the actual data.
- Real end-to-end writes go to the test repos only. Note the PRs they open, and how to close them.

## Workflow

- **Never commit to `main` directly**, unless the user explicitly asks for that specific change. Use
  a branch and a PR.
- **Stacked PRs:** don't delete a base branch before GitHub has retargeted the PR on top of it,
  because deleting it closes that PR. Merge the lower PR, retarget the upper one to `main`, then
  delete the branches.
- **Phases flagged for review** (token handling, writes to shared repos): stop and ask for human
  review before treating them as done.
- **Commit messages and PR descriptions** say what changed and why, how it was verified, and any
  deviation from the plan.
- **Open items** (see `docs/ship-checklist.md`):
  - Developer ID signing and notarization credentials;
  - a teammate install on a managed Mac against the company GitHub host;
  - whether that host is Enterprise Cloud or Server.
