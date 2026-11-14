# PM Workbench

A macOS desktop app that connects a product manager's three GitHub repos — artifacts and Claude
skills, CRM (customer conversations), and PDR (spec approval via git flow) — around the product
they're managing, so there's one place to browse all three instead of three separate tabs.

This is adapted from [Project Dashboard](https://github.com/gonzalovazquez/project-dashboard),
reusing its Electron/React shell and security model; the scanning-and-Notion-focused features it
had are not what this app does. See [`docs/decisions/github-access.md`](docs/decisions/github-access.md)
for why the GitHub access layer is built the way it is, and the plan's ADR 001 (on the Notion page
this project was brainstormed on) for why the codebase was reused at all rather than starting
from scratch.

**Phase 1 (this PR)** is sign-in and read-only browsing: a GitHub personal access token, the three
repo roles assigned to real repos, and a tree/file browser for each. The product model, the
workflow board, flow metrics, and write-back via pull request are later phases — see the build
budget's kickoff prompts for the full plan.

## Install

There is no signed release. Build it yourself on the Mac you will use it on:

```
git clone https://github.com/gonzalovazquez/project-management-system.git
cd project-management-system
npm install
npm run package        # writes release/PM Workbench-<version>-arm64.dmg (and x64, and zips)
```

Open the `.dmg`, drag **PM Workbench** to Applications. The app is not signed or notarized (that
needs a paid Apple developer account), so macOS blocks the first launch. Either right-click the
app and choose **Open**, then **Open** again, or remove the quarantine flag once:

```
xattr -dr com.apple.quarantine "/Applications/PM Workbench.app"
```

`npm run package:dir` builds an unpacked app for the machine you are on, which is how packaging was
tested on Linux (the `.dmg` target needs macOS to build). To run from source instead: `npm run dev`.

## Using it

1. **Sign in.** Paste a GitHub personal access token (and the host, if you're on GitHub Enterprise
   Server rather than github.com). It's encrypted with the system keychain; if the keychain isn't
   available, set `GITHUB_TOKEN` in the environment instead and the app never tries to store it.
2. **Connect your three repos.** On first sign-in you land on Settings, where each role — Artifacts
   and skills, CRM, PDR — gets assigned to one of the repos your token can see. Nothing is moved or
   copied; the app just remembers which repo is which.
3. **Browse.** Each role in the sidebar opens a read-only tree-and-file view of that repo at its
   default branch.

## Commands

```
npm install
npm run dev                    # run the app with hot reload
npm run build                  # build main, preload and renderer into out/
npm run package                # macOS .dmg and .zip (run on a Mac); npm run package:dir for the current OS
npm run icon                   # redraw build/icon.png
npm test                       # unit and integration tests
npm run typecheck
npm run smoke                  # launch the real app under xvfb and check what it rendered (Linux); SMOKE_BIN=<app> tests a packaged build
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

| Piece | Where | What it does |
|---|---|---|
| GitHub access | `src/main/github` | Host → API base URL, the network allow-list wrapper, the Octokit-based client |
| App service | `src/main/app` | Sign-in/session, settings store, token storage (keychain-encrypted), IPC registration, sender-trust check |
| Shell | `src/main/index.ts`, `src/preload` | Window, security settings, the renderer-side network guard, bridge |
| Interface | `src/renderer` | React: sign-in, repo-role settings, the tree/file browser |

Safety properties, each covered by a test or `npm run smoke`:

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
- Browsing is read-only. Nothing here writes to GitHub — that's a later phase, and it will go
  through a pull request, never a direct commit.

App data (settings, encrypted token) lives in Electron's user data folder. Set
`PMWORKBENCH_HOME` to use another one, for example when experimenting or testing.

### Known limits (Phase 1)

- No product model yet — this is just sign-in and a file browser. The workflow board, objectives
  and flow metrics are Phase 2/3.
- No write-back. Opening a PR from the app is Phase 4.
- The 'Matrix' appearance theme from Project Dashboard was dropped rather than carried forward.
- The macOS look (sidebar blur, traffic lights) is built for macOS but was only checked in a
  browser and on Linux.
- Large files (over ~1MB) are truncated rather than paginated.
