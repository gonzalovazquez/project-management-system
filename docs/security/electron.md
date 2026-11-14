# Electron hardening

PM Workbench is Electron 44, React 19 and Vite. Most of the hardening was inherited from Project
Dashboard (ADR 001). Phase 5 verified it, tightened it, and moved the checks into `npm run smoke`,
which launches the real app and inspects it.

## Window and process settings (`src/main/index.ts`)

**For the main window:**
- `contextIsolation: true`;
- `nodeIntegration: false` and `nodeIntegrationInWorker: false`;
- `sandbox: true`;
- `webSecurity: true`;
- `webviewTag: false`;
- `allowRunningInsecureContent: false`;
- `navigateOnDragDrop: false`;
- `spellcheck: false`;
- `devTools` only when running from source.

**For the whole app:**
- `app.enableSandbox()`, so every renderer is sandboxed whatever its own settings say.
- For every web contents ever created: new windows are denied, and navigation, redirects and
  `<webview>` attachment are prevented.
- Permission requests and permission checks are both denied (no camera, microphone, location,
  notifications, clipboard and so on).
- There is no `remote` module (removed from Electron).
- IPC calls are accepted only from the app's own page (`src/main/app/trust.ts`;
  `test/trust.test.ts`), and every argument is validated in the main process before use.
- **Content security policy (packaged build):** `default-src 'self'; script-src 'self';
  connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`.

## `npm run smoke` (run against source, or a packaged build with `SMOKE_BIN`)

1. no launch error
2. signed out with no token configured
3. bridge exposes exactly the intended methods
4. Node is not reachable from the page
5. strict script policy
6. renderer has no connect-src escape hatch
7. renderer cannot reach any other host (a real `fetch` to an outside host is refused)
8. new windows are refused
9. navigation away from the app is refused
10. renderer process is OS-sandboxed (from the OS process metrics, not the settings)
11. no `<webview>` tag

## Packaged build

**Electron fuses**, set by electron-builder and verified with `npx @electron/fuses read`:

| Fuse | Setting | Effect |
|---|---|---|
| RunAsNode | Disabled | The app binary can't be used as a Node interpreter. |
| EnableNodeOptionsEnvironmentVariable | Disabled | `NODE_OPTIONS` is ignored. |
| EnableNodeCliInspectArguments | Disabled | `--inspect` is ignored, so no debugger can attach. (This is also why end-to-end automation runs against the source build, not the packaged app.) |
| EnableEmbeddedAsarIntegrityValidation | Enabled | The app archive is checked at load time. |
| OnlyLoadAppFromAsar | Enabled | Code is loaded only from the archive. |
| EnableCookieEncryption | Enabled | Cookies are encrypted. |

**Hardened runtime** is on. The signed build's entitlements are only
`com.apple.security.cs.allow-jit`, which V8 needs (`build/entitlements.mac.plist`).

The unsigned test build alone adds `com.apple.security.cs.disable-library-validation`
(`build/entitlements.adhoc.plist`). An ad-hoc signature has no Team ID, so without it the app
can't load its own Electron framework. A Developer ID build never gets this entitlement. See
`docs/release.md`.

## Changed in Phase 5

The following were added: `app.enableSandbox()`, the per-web-contents rules, the
permission-check handler, `devTools` limited to source builds, the explicit `webPreferences`
lock-down, the fuses, the hardened runtime and entitlements, `publish: null`, and five new smoke
checks (items 7–11).
