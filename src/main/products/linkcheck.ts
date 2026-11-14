import type { RepoRef, RepoRole } from '../../shared/ipc.js';
import { markdownSections, type Link, type LinkHealth } from '../../shared/products.js';
import type { GitHubClient } from '../github/client.js';

export interface CheckOutcome {
  linkId: string;
  /** undefined when the check itself failed (network, rate limit) and the stored health was left alone. */
  health?: LinkHealth;
  /** The file's current blob SHA when it was found, so the store can keep it fresh for move detection. */
  blobSha?: string;
  error?: string;
}

const CONCURRENCY = 4;

/**
 * Checks each link against GitHub and says whether its target still exists. A missing file whose
 * last known content (blob SHA) now sits at another path is reported as moved, with that path, so
 * the PM can relink in one step. Only 404s count as broken: any other failure leaves the link's
 * stored health as it was, so being offline or rate limited never marks everything broken.
 *
 * Cost: one request per file or pull-request link, plus one file read per conversation link, plus
 * at most one recursive tree read per repo, only when something in that repo is missing.
 */
export async function checkLinks(
  links: Link[],
  host: string,
  roles: Partial<Record<RepoRole, RepoRef>>,
  client: Pick<GitHubClient, 'statPath' | 'findBlob' | 'getPull' | 'getFile'>,
  now: Date,
): Promise<CheckOutcome[]> {
  const checkedAt = now.toISOString();
  const broken = (reason: string, movedTo?: string): LinkHealth => ({ state: 'broken', checkedAt, reason, ...(movedTo ? { movedTo } : {}) });
  const ok: LinkHealth = { state: 'ok', checkedAt };

  const repoFor = (l: Link): RepoRef | undefined => {
    if (l.repoHost.toLowerCase() !== host.toLowerCase()) return undefined;
    return Object.values(roles).find((r) => r && r.fullName.toLowerCase() === l.repoFullName.toLowerCase());
  };

  // One recursive tree lookup per repo and SHA, shared across links.
  const blobLookups = new Map<string, Promise<string | null>>();
  const findMoved = (repo: RepoRef, sha: string | undefined) => {
    if (!sha) return Promise.resolve(null);
    const key = `${repo.fullName}@${sha}`;
    if (!blobLookups.has(key)) blobLookups.set(key, client.findBlob(repo, sha).catch(() => null));
    return blobLookups.get(key)!;
  };

  const one = async (l: Link): Promise<CheckOutcome> => {
    const repo = repoFor(l);
    if (!repo) return { linkId: l.id, health: broken(`${l.repoFullName} on ${l.repoHost} is not one of your connected repos.`) };
    try {
      if (l.prNumber !== undefined) {
        const pr = await client.getPull(repo, l.prNumber);
        return { linkId: l.id, health: pr ? ok : broken(`Pull request #${l.prNumber} no longer exists in ${repo.fullName}.`) };
      }
      const path = l.path!;
      const stat = await client.statPath(repo, path);
      if (!stat || stat.type !== 'file') {
        const moved = await findMoved(repo, l.blobSha);
        return { linkId: l.id, health: broken(stat ? `${path} is now a folder.` : `${path} is no longer on ${repo.defaultBranch}.`, moved ?? undefined) };
      }
      if (l.kind === 'conversation' && l.anchor) {
        const file = await client.getFile(repo, path);
        if (!markdownSections(file.content).some((s) => s.anchor === l.anchor)) {
          return { linkId: l.id, health: broken(`The section "${l.title}" is no longer in ${path}.`), blobSha: stat.sha };
        }
      }
      return { linkId: l.id, health: ok, blobSha: stat.sha };
    } catch (e) {
      return { linkId: l.id, error: e instanceof Error ? e.message : String(e) };
    }
  };

  const out: CheckOutcome[] = new Array(links.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, links.length) }, async () => {
    while (next < links.length) {
      const i = next++;
      out[i] = await one(links[i]);
    }
  }));
  return out;
}
