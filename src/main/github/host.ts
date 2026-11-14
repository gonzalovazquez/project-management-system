/**
 * The GitHub host a PM is working against. "github.com" is the public host, where the API lives
 * at a different hostname (api.github.com). Any other value is a GitHub Enterprise Server
 * instance, where the API lives under /api/v3 on the same hostname.
 *
 * See docs/decisions/github-access.md for the spike that settled this against Octokit.
 */
export function normalizeHost(input: string): string {
  const trimmed = input.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!trimmed) throw new Error('Enter a GitHub host, such as github.com or git.example.com.');
  if (/[\s/]/.test(trimmed)) throw new Error('The host should be just the domain, such as github.com — no path or spaces.');
  return trimmed.toLowerCase();
}

export function apiBaseUrl(host: string): string {
  const h = normalizeHost(host);
  return h === 'github.com' ? 'https://api.github.com' : `https://${h}/api/v3`;
}

/** The hostname every API request actually goes to — what the network allow-list checks against. */
export function apiHostname(host: string): string {
  return new URL(apiBaseUrl(host)).hostname;
}
