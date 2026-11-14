/**
 * Enforces the plan's "no network calls other than the configured GitHub host" requirement for
 * every request the main process makes. Wrap the fetch implementation Octokit uses with this
 * before any request leaves the process; nothing else in the main process is allowed to call the
 * network directly (see src/main/index.ts for the renderer-side half of the guard).
 */
export class DisallowedHostError extends Error {
  constructor(hostname: string) {
    super(`Blocked a request to "${hostname}": only the configured GitHub host may be reached.`);
    this.name = 'DisallowedHostError';
  }
}

export function createGuardedFetch(getAllowedHostname: () => string | undefined, baseFetch: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const allowed = getAllowedHostname();
    if (!allowed) throw new DisallowedHostError('(no GitHub host configured yet)');
    let hostname: string;
    try {
      hostname = new URL(raw).hostname;
    } catch {
      throw new DisallowedHostError(raw);
    }
    if (hostname.toLowerCase() !== allowed.toLowerCase()) throw new DisallowedHostError(hostname);
    return baseFetch(input, init);
  }) as typeof fetch;
}
