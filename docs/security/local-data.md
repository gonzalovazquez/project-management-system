# What PM Workbench stores on the Mac

All local state lives in the app's data folder:
- **Packaged app:** `~/Library/Application Support/PM Workbench/`
- **Override:** `PMWORKBENCH_HOME`

Nothing is written to the three repos except through reviewed pull requests, and nothing is sent
anywhere but the configured GitHub host.

| File | Contents | Sensitive? |
|---|---|---|
| `token.bin` | The GitHub token, **encrypted** with `safeStorage` (macOS Keychain key). | The credential, encrypted. Deleted on sign-out or when GitHub rejects the token. |
| `settings.json` | GitHub host; the three repos chosen for the roles (owner, name, default branch, URL); last signed-in login; appearance; review-point thresholds; template file paths. | No secrets. |
| `products.db` (+ `-wal`, `-shm`) | SQLite, in these tables: <ul><li>`products`, `kpis`, `links`: the product mapping (names, objectives, KPIs, and references to repo items by repo, path, section or PR number);</li><li>`stage_events`, `stage_snapshots`: board history;</li><li>`writes`: branches and pull requests the app opened;</li><li>`item_state`, `sync_status`: last-synced state;</li><li>`http_cache`: GitHub responses kept for offline use and conditional requests. That means repo trees as path/SHA pairs, commit dates and authors, section anchors, PR titles, status and reviewers, and the text of files the PM opened in the browser or previews.</li></ul> | Contains repo content the PM already has access to. No credentials. |
| Chromium folders (`Cache`, `Code Cache`, `GPUCache`, `Local Storage`, `Session Storage`, `DIPS`, `Preferences`, …) | Electron's own runtime data for the app's single window. | No credentials; the app uses no cookies or web storage for data. |

**Shared files.** An export (`*.pmworkbench.json`) is written only where the PM chooses. It holds
the product, its objective and KPIs, and its links (repo, path or PR, title, stage). It never
holds file contents or the token.

**Removal.** Quit the app and delete the data folder. Deleting a product removes only its local
rows; nothing changes on GitHub.
