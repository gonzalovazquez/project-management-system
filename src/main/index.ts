import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, session, shell } from 'electron';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHANNELS } from '../shared/ipc.js';
import { registerIpc } from './app/ipc.js';
import { TokenStore } from './app/secrets.js';
import { AppService } from './app/service.js';
import { createSettingsStore } from './app/settings.js';
import { isTrustedUrl } from './app/trust.js';
import { apiHostname } from './github/host.js';
import { createGitHubClient } from './github/client.js';
import { openDatabase } from './products/db.js';
import { HttpCache } from './products/httpcache.js';
import { ProductStore } from './products/store.js';

const here = dirname(fileURLToPath(import.meta.url));
const devUrl = process.env.ELECTRON_RENDERER_URL;

// A separate data folder keeps tests and experiments away from the real settings and token.
if (process.env.PMWORKBENCH_HOME) app.setPath('userData', process.env.PMWORKBENCH_HOME);

// Every renderer is sandboxed, whatever its own webPreferences say.
app.enableSandbox();

// The same rules for every web contents the app ever creates, not just the main window: no new
// windows, no navigation away from the app's page, no <webview>.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (ev) => ev.preventDefault());
  contents.on('will-redirect', (ev) => ev.preventDefault());
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
});

function createService(): AppService {
  const data = app.getPath('userData');
  const db = openDatabase(join(data, 'products.db'));
  return new AppService({
    settings: createSettingsStore(join(data, 'settings.json')),
    tokens: new TokenStore(join(data, 'token.bin'), {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (s) => safeStorage.encryptString(s),
      decrypt: (b) => safeStorage.decryptString(b),
    }),
    createClient: (host, token, guard) => createGitHubClient(host, token, fetch, guard),
    openExternal: (url) => shell.openExternal(url),
    // 'system' follows macOS; 'light' / 'dark' override it for the window, its styles and its title bar.
    applyAppearance: (a) => { nativeTheme.themeSource = a; },
    // The product mapping: local only, next to settings in the app's data folder.
    products: new ProductStore(db),
    cache: new HttpCache(db),
    files: {
      async saveText(suggestedName, text) {
        const win = BrowserWindow.getFocusedWindow();
        const opts = { title: 'Export product mapping', defaultPath: join(app.getPath('documents'), suggestedName), filters: [{ name: 'PM Workbench mapping', extensions: ['json'] }] };
        const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
        if (r.canceled || !r.filePath) return null;
        await writeFile(r.filePath, text, 'utf8');
        return r.filePath;
      },
      async openText() {
        const win = BrowserWindow.getFocusedWindow();
        const opts = { title: 'Import product mapping', properties: ['openFile' as const], filters: [{ name: 'PM Workbench mapping', extensions: ['json'] }] };
        const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
        const file = r.filePaths[0];
        if (r.canceled || !file) return null;
        if ((await stat(file)).size > 5_000_000) throw new Error('That file is over 5 MB, which is far larger than any product mapping.');
        return readFile(file, 'utf8');
      },
    },
  });
}

/**
 * Blocks every network request that is not the app loading its own page, the dev server (only
 * when ELECTRON_RENDERER_URL is set, i.e. never in a packaged build), or the currently configured
 * GitHub API host. This is the renderer-side half of the "no network calls other than the
 * configured GitHub host" requirement; the main-process half is the guarded fetch every GitHub
 * request goes through (src/main/github/allowlist.ts). The renderer's content security policy
 * (connect-src 'self') already blocks fetch/XHR/WebSocket from the page itself — this is
 * defense in depth against anything using Electron's own networking instead.
 */
function installNetworkGuard(getAllowedHostname: () => string | undefined): void {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let u: URL;
    try {
      u = new URL(details.url);
    } catch {
      callback({ cancel: true });
      return;
    }
    if (u.protocol === 'file:' || u.protocol === 'devtools:' || u.protocol === 'chrome-extension:' || u.protocol === 'data:') {
      callback({ cancel: false });
      return;
    }
    if (devUrl && (u.origin === new URL(devUrl).origin || (u.protocol === 'ws:' && u.hostname === new URL(devUrl).hostname))) {
      callback({ cancel: false });
      return;
    }
    const allowed = getAllowedHostname();
    callback({ cancel: !(allowed && u.hostname === allowed) });
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 900, minHeight: 600,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e20' : '#ffffff',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 17 }, vibrancy: 'sidebar' as const, visualEffectState: 'followWindow' as const } : {}),
    webPreferences: {
      preload: join(here, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, sandbox: true,
      webSecurity: true, webviewTag: false, allowRunningInsecureContent: false, navigateOnDragDrop: false, spellcheck: false,
      // Developer tools only when running from source.
      devTools: !app.isPackaged,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // A crashed or killed renderer is reloaded once; the interface is stateless apart from what the main process holds.
  let reloads = 0;
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('The window process ended:', details.reason);
    if (details.reason !== 'clean-exit' && reloads++ < 2 && !win.isDestroyed()) win.webContents.reload();
  });
  win.webContents.on('unresponsive', () => console.error('The window stopped responding.'));
  if (devUrl) void win.loadURL(devUrl); else void win.loadFile(join(here, '../renderer/index.html'));
  return win;
}

/** Only our own window may call the IPC handlers. */
const indexFileUrl = pathToFileURL(join(here, '../renderer/index.html')).href;
const trustedUrl = (url: string) => isTrustedUrl(url, { devUrl, indexFileUrl });

/**
 * PMWORKBENCH_SMOKE-only: once the window has loaded, inspects it for a few invariants
 * (the preload bridge's exact shape, that Node globals didn't leak into the page, the CSP) and
 * writes one JSON line to stdout for scripts/smoke.sh to assert on, plus a screenshot next to it.
 */
async function runSmokeCheck(win: BrowserWindow, auth: { status: string }, out: string): Promise<void> {
  let result: Record<string, unknown>;
  try {
    const probe = await win.webContents.executeJavaScript(`(async () => ({
      bridgeKeys: Object.keys(window.pmworkbench ?? {}).sort(),
      nodeLeaked: typeof require !== 'undefined' || typeof process !== 'undefined',
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? null,
      externalFetchBlocked: await fetch('https://example.com/').then(() => false, () => true),
      windowOpenBlocked: window.open('https://example.com/') === null,
      urlBefore: location.href,
    }))()`);
    // Try to navigate away; the window must stay on the app's page.
    await win.webContents.executeJavaScript(`location.href = 'https://example.com/'; true`).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
    // The OS-level view of the renderer process: is it actually sandboxed?
    const pid = win.webContents.getOSProcessId();
    const metric = app.getAppMetrics().find((m) => m.pid === pid);
    result = {
      error: null, authStatus: auth.status, ...probe,
      navigationBlocked: win.webContents.getURL() === probe.urlBefore,
      rendererSandboxed: metric?.sandboxed ?? null,
      webviewAvailable: await win.webContents.executeJavaScript(`typeof customElements.get('webview') !== 'undefined' || 'WebView' in window`),
    };
  } catch (e) {
    result = { error: e instanceof Error ? e.message : String(e), authStatus: auth.status, bridgeKeys: [], nodeLeaked: null, csp: null };
  }
  try {
    const png = await win.webContents.capturePage();
    await writeFile(`${out}.png`, png.toPNG());
  } catch { /* best-effort; the JSON result is what the checks run against */ }
  console.log(`SMOKE_RESULT ${JSON.stringify(result)}`);
}

void app.whenReady().then(async () => {
  // Deny every permission request; this app has no use for the clipboard, camera, location, etc.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const service = createService();
  installNetworkGuard(() => {
    const auth = service.getAuth();
    return auth.status === 'signed-in' ? apiHostname(auth.host) : undefined;
  });
  await service.init();
  registerIpc(ipcMain, service, {
    isTrusted: (e) => trustedUrl(e.senderFrame?.url ?? ''),
    log: (m, err) => console.error(m, err),
  });
  const win = createWindow();
  const smokeOut = process.env.PMWORKBENCH_SMOKE;
  if (smokeOut) {
    win.webContents.once('did-finish-load', () => {
      void runSmokeCheck(win, service.getAuth(), smokeOut).finally(() => app.quit());
    });
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

export { CHANNELS };
