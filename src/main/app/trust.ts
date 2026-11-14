/**
 * The only two places IPC calls can legitimately come from: the dev server (dev only) or the
 * app's own packaged page. Anything else — a stray devtools frame, an injected iframe — is
 * rejected before it reaches the service.
 */
export function isTrustedUrl(url: string, opts: { devUrl?: string; indexFileUrl: string }): boolean {
  if (!url) return false;
  if (url === opts.indexFileUrl || url.startsWith(`${opts.indexFileUrl}#`) || url.startsWith(`${opts.indexFileUrl}?`)) return true;
  if (opts.devUrl) {
    try {
      return new URL(url).origin === new URL(opts.devUrl).origin;
    } catch {
      return false;
    }
  }
  return false;
}
