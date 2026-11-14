# Network: the configured GitHub host, and nothing else

**The requirement:** no network calls except to the GitHub host the PM configured at sign-in.
There is no backend, no telemetry and no third-party service.

## Every path a request could take

| Path | Control | Enforced by |
|---|---|---|
| Main process → GitHub (all API calls) | Octokit's `fetch` is wrapped by `createGuardedFetch` (`src/main/github/allowlist.ts`), which refuses any hostname other than the configured host's API hostname. With no host configured, it refuses everything. | `test/allowlist.test.ts`. `test/product-service.test.ts` runs a sync with the guard pointed elsewhere and asserts **zero requests** were sent and the board still renders from cache. |
| Main process → GitHub (writes) | Additionally, the network write guard (`src/main/write/guard.ts`) allows only the engine's write calls. Branch creation is allowed only for app branches or a PM-confirmed prefix; moving or deleting a branch, or opening a PR from it, only for branches the app created. GraphQL is allowed only for read-only queries (review-thread state). | `test/write.test.ts`, `test/crm-pdr.test.ts` |
| Window (renderer) → anywhere | The content security policy has `connect-src 'self'` and `default-src 'self'`, and no inline script in the packaged build. | `npm run smoke`: "renderer cannot reach any other host" (a real `fetch('https://example.com')` from the page is refused) and "strict script policy". |
| Window → anywhere via Electron networking | `session.webRequest.onBeforeRequest` in `src/main/index.ts` cancels every request except the app's own files, the dev server when running from source, and the configured API host. | `npm run smoke` |
| New windows or navigation | `setWindowOpenHandler` → deny, and `will-navigate` / `will-redirect` → prevented, for **every** web contents. | `npm run smoke`: "new windows are refused", "navigation away from the app is refused" |
| Links the PM opens | `openOnGitHub` opens a URL in the system browser only if it is `https://` on the configured GitHub host; anything else is refused. That is the user's browser, not the app. | `src/main/app/service.ts` `openOnGitHub` |
| Updates | **There is no auto-update.** It would add a second destination, so it is deferred by plan. The build sets `publish: null`, so no update feed is generated. | `package.json` → `build.publish` |
| Crash reports, telemetry | None. `crashReporter` is never started, and no analytics SDK is a dependency. | [telemetry.md](telemetry.md), [dependencies.md](dependencies.md) |

## GitHub Enterprise

For GitHub Enterprise Server, the API host is the same hostname (`https://<host>/api/v3`). For
github.com and Enterprise Cloud it is `api.github.com` (`src/main/github/host.ts`). The allow-list
follows whichever host the PM signed in to.

## Request volume

The board and metrics sync uses conditional requests, so unchanged data comes back as 304s, which
don't count against GitHub's rate limit. When GitHub does rate-limit, the app waits until the
reset time GitHub gives instead of retrying (`test/resilience.test.ts`). Measured costs are in
`docs/decisions/workflow-board.md` and `docs/decisions/flow-metrics.md`.
