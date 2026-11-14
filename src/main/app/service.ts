import { fail, ok, REPO_ROLES, type AuthState, type FileContent, type PublicSettings, type RepoList, type RepoRef, type RepoRole, type Result, type SettingsPatch, type TreeEntry } from '../../shared/ipc.js';
import type { AddLinksResult, FileDialogResult, ImportReport, ItemState, Link, Product, ProductHome, ProductSummary, PullDetail, PullSummary } from '../../shared/products.js';
import { normalizeHost } from '../github/host.js';
import type { ClientHooks, GitHubClient } from '../github/client.js';
import type { HttpCache } from '../products/httpcache.js';
import { syncLinks } from '../products/sync.js';
import { WriteEngine, WriteError } from '../write/engine.js';
import type { WriteGuardOptions } from '../write/guard.js';
import type { AppPullStatus, BranchConvention, CrmLayout, EditSource, PdrLayout, WritePreview, WriteResult } from '../../shared/writes.js';
import { MappingError, parseMapping, planImport, toMapping } from '../products/mapping.js';
import type { NewLink, ProductStore } from '../products/store.js';
import { isId, isPrNumber, isRole, validateLinkInput, validateLinkPatch, validateProductInput } from '../products/validate.js';
import { isStage } from '../../shared/products.js';
import { SecureStorageUnavailable, type TokenStore } from './secrets.js';
import type { SettingsStore } from './settings.js';

export interface ServiceDeps {
  settings: SettingsStore;
  tokens: Pick<TokenStore, 'get' | 'set' | 'secureStorageAvailable'>;
  /**
   * Builds a client for one host+token pair. Never called with an unvalidated token held onto past
   * the call that validates it. `guard` tells the client's network write guard which branches are
   * the connected repos' defaults.
   */
  createClient(host: string, token: string, guard?: WriteGuardOptions, hooks?: ClientHooks): GitHubClient;
  products: ProductStore;
  /** GitHub response cache for the board sync; lives in the same database as the products. */
  cache: HttpCache;
  /** Native file dialogs, behind an interface so tests can stand in for them. null means the PM cancelled. */
  files: {
    saveText(suggestedName: string, text: string): Promise<string | null>;
    openText(): Promise<string | null>;
  };
  now?: () => Date;
  /** Opens a URL in the system browser (Electron's shell.openExternal). Only ever called with a vetted GitHub URL. */
  openExternal?: (url: string) => Promise<void>;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Owns sign-in, the repo-role settings, browsing the three connected repos (Phase 1), and the
 * local product model: products, their links into the repos, link checks, export and import
 * (Phase 2). The workflow board and write-back are later phases.
 */
export class AppService {
  private auth: AuthState = { status: 'signed-out' };
  private host = '';
  private token?: string;
  private client?: GitHubClient;

  /** Default branch per connected repo ("owner/name" lowercase), kept current for the write guard. */
  private defaultBranches: Record<string, string> = {};
  /** Branch conventions the PM confirmed, by repo (lowercase), kept current for the write guard. */
  private conventions: Record<string, BranchConvention> = {};
  private guard: WriteGuardOptions = {
    defaultBranches: () => this.defaultBranches,
    prefixes: () => {
      const out: Record<string, string[]> = {};
      for (const [repo, c] of Object.entries(this.conventions)) out[repo] = [c.prefix];
      for (const [repo, p] of this.engine.pendingPrefixes) out[repo] = [...(out[repo] ?? []), p];
      return out;
    },
    owns: (repo, branch) => this.d.products.writes().some((w) => w.repo.toLowerCase() === repo.toLowerCase() && w.branch === branch),
  };
  private engine: WriteEngine;

  constructor(private d: ServiceDeps) {
    this.engine = new WriteEngine({
      client: () => {
        if (!this.client) throw new WriteError('invalid', 'Sign in with a GitHub personal access token first.');
        return this.client;
      },
      products: d.products,
      host: () => this.host,
      roles: async () => (await this.d.settings.load()).repoRoles,
      guard: this.guard,
      now: d.now,
      convention: async (repo) => (await this.d.settings.load()).branchConventions[repo.toLowerCase()],
      saveConvention: async (repo, c) => {
        const s = await this.d.settings.save({ branchConventions: { [repo.toLowerCase()]: c } });
        this.conventions = s.branchConventions;
      },
    });
  }

  /** Until when GitHub asked us to back off. Nothing is sent before then; reads come from the cache. */
  private limitedUntil?: Date;

  /** Hooks for a client built for `token`: they only act while that token is the session's. */
  private hooksFor(token: string): ClientHooks {
    return {
      onUnauthorized: () => { if (this.token === token) void this.expire(); },
      onRateLimited: (until) => { if (!this.limitedUntil || until > this.limitedUntil) this.limitedUntil = until; },
    };
  }

  /**
   * The token stopped working (revoked, expired, or its access was removed). Sign out and forget the
   * dead token, but keep every product, link, cached state and setting, so signing in again with a
   * new token picks up exactly where the PM left off.
   */
  private async expire(): Promise<void> {
    // Signed out at once, so no further call uses the dead token; then forget it.
    this.auth = { status: 'signed-out', host: this.host, reason: 'GitHub no longer accepts your token. It may have expired or been revoked. Sign in with a new one; your products and settings are kept.' };
    this.token = undefined;
    this.client = undefined;
    await this.d.tokens.set(null).catch(() => undefined);
  }

  private cooling(): string | undefined {
    const until = this.limitedUntil;
    if (!until || until.getTime() <= this.now().getTime()) { this.limitedUntil = undefined; return undefined; }
    return `GitHub's rate limit is used up until ${until.toLocaleTimeString()}. The app is waiting rather than retrying.`;
  }

  /**
   * A read that falls back to its last good answer when GitHub can't be reached or asked us to back
   * off, so browsing and previews keep working offline. Live answers refresh the cache.
   */
  private async offlineCapable<T>(key: string, live: () => Promise<T>): Promise<Result<T>> {
    const cached = () => this.d.cache.get(`offline|${this.host}|${key}`);
    const cool = this.cooling();
    if (cool) {
      const c = cached();
      return c ? ok(c.body as T) : fail('rate-limited', cool);
    }
    try {
      const v = await live();
      this.d.cache.put(`offline|${this.host}|${key}`, 200, v);
      return ok(v);
    } catch (e) {
      const status = (e as { status?: number }).status;
      const c = cached();
      if (c && (status === undefined || status >= 500 || this.cooling())) return ok(c.body as T);
      if (this.auth.status !== 'signed-in') return fail('not-signed-in', this.auth.status === 'signed-out' && this.auth.reason ? this.auth.reason : 'Sign in first.');
      return fail('network', msg(e));
    }
  }

  private rememberBranches(roles: Partial<Record<RepoRole, RepoRef>>, conventions?: Record<string, BranchConvention>) {
    if (conventions) this.conventions = conventions;
    this.defaultBranches = Object.fromEntries(Object.values(roles).filter((r): r is RepoRef => !!r).map((r) => [r.fullName.toLowerCase(), r.defaultBranch]));
  }

  /** Tries to resume a session from a stored host and token (env var or Keychain). Never throws. */
  async init(): Promise<void> {
    const settings = await this.d.settings.load();
    this.rememberBranches(settings.repoRoles, settings.branchConventions);
    const { token, source } = await this.d.tokens.get();
    if (!settings.host || !token) return;
    const client = this.d.createClient(settings.host, token, this.guard, this.hooksFor(token));
    const tokenSource = source === 'env' ? 'env' : 'keychain';
    try {
      const { login } = await client.whoAmI();
      this.host = settings.host;
      this.token = token;
      this.client = client;
      this.auth = { status: 'signed-in', host: settings.host, login, tokenSource };
      await this.engine.recoverInterrupted().catch(() => undefined);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === undefined && settings.login) {
        // GitHub didn't answer at all (offline, DNS, blocked): keep the session so cached products and
        // boards still open. A token GitHub actually rejects (any HTTP status) still signs the PM out.
        this.host = settings.host;
        this.token = token;
        this.client = client;
        this.auth = { status: 'signed-in', host: settings.host, login: settings.login, tokenSource, offline: true };
        return;
      }
      // A stored token that no longer works just leaves the app signed out; the PM signs in again.
      this.auth = { status: 'signed-out' };
    }
  }

  getAuth(): AuthState {
    return this.auth;
  }

  async signIn(hostInput: string, token: string): Promise<Result<AuthState>> {
    let host: string;
    try {
      host = normalizeHost(hostInput);
    } catch (e) {
      return fail('invalid', msg(e));
    }
    if (!token.trim()) return fail('invalid', 'Enter a personal access token.');
    const client = this.d.createClient(host, token, this.guard, this.hooksFor(token));
    let login: string;
    try {
      ({ login } = await client.whoAmI());
    } catch (e) {
      return fail('network', `Could not sign in to ${host}: ${msg(e)}`);
    }
    try {
      await this.d.tokens.set(token);
    } catch (e) {
      if (!(e instanceof SecureStorageUnavailable)) throw e;
      return fail('invalid', e.message);
    }
    await this.d.settings.save({ host, login });
    this.host = host;
    this.token = token;
    this.client = client;
    const source = (await this.d.tokens.get()).source === 'env' ? 'env' : 'keychain';
    this.auth = { status: 'signed-in', host, login, tokenSource: source };
    return ok(this.auth);
  }

  async signOut(): Promise<void> {
    await this.d.tokens.set(null);
    this.host = '';
    this.token = undefined;
    this.client = undefined;
    this.auth = { status: 'signed-out' };
  }

  private requireClient(): Result<GitHubClient> {
    if (this.auth.status !== 'signed-in' || !this.client) return fail('not-signed-in', this.auth.status === 'signed-out' && this.auth.reason ? this.auth.reason : 'Sign in with a GitHub personal access token first.');
    return ok(this.client);
  }

  async listAvailableRepos(): Promise<Result<RepoList>> {
    const c = this.requireClient();
    if (!c.ok) return c;
    try {
      return ok(await c.value.listRepos());
    } catch (e) {
      return fail('network', msg(e));
    }
  }

  async getSettings(): Promise<PublicSettings> {
    const s = await this.d.settings.load();
    this.rememberBranches(s.repoRoles, s.branchConventions);
    return { host: s.host, repoRoles: s.repoRoles, appearance: s.appearance, onboarded: s.onboarded, metrics: s.metrics, templates: s.templates, branchConventions: s.branchConventions, secureStorageAvailable: this.d.tokens.secureStorageAvailable };
  }

  async saveSettings(patch: SettingsPatch): Promise<Result<PublicSettings>> {
    try {
      await this.d.settings.save(patch);
    } catch (e) {
      return fail('invalid', msg(e));
    }
    return ok(await this.getSettings());
  }

  private async repoForRole(role: RepoRole): Promise<Result<RepoRef>> {
    if (!REPO_ROLES.includes(role)) return fail('invalid', `"${role}" is not a repo role.`);
    const s = await this.d.settings.load();
    const repo = s.repoRoles[role];
    if (!repo) return fail('no-role', `No repo is assigned to the ${role} role yet. Set it up in Settings.`);
    return ok(repo);
  }

  async browseTree(role: RepoRole, path: string): Promise<Result<TreeEntry[]>> {
    const c = this.requireClient();
    if (!c.ok) return c;
    const repo = await this.repoForRole(role);
    if (!repo.ok) return repo;
    return this.offlineCapable(`tree|${repo.value.fullName}|${path}`, () => c.value.listTree(repo.value, path));
  }

  async readFile(role: RepoRole, path: string): Promise<Result<FileContent>> {
    const c = this.requireClient();
    if (!c.ok) return c;
    const repo = await this.repoForRole(role);
    if (!repo.ok) return repo;
    return this.offlineCapable(`file|${repo.value.fullName}|${path}`, async () => {
      const f = await c.value.getFile(repo.value, path);
      return { path: f.path, content: f.content, truncated: f.truncated, htmlUrl: f.htmlUrl, sha: f.sha };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Pull requests (PDR links can point at one)
  // -------------------------------------------------------------------------------------------

  async listPulls(role: unknown): Promise<Result<PullSummary[]>> {
    if (!isRole(role)) return fail('invalid', 'Unknown repo role.');
    const c = this.requireClient();
    if (!c.ok) return c;
    const repo = await this.repoForRole(role);
    if (!repo.ok) return repo;
    return this.offlineCapable(`pulls|${repo.value.fullName}`, () => c.value.listPulls(repo.value));
  }

  async readPull(role: unknown, n: unknown): Promise<Result<PullDetail>> {
    if (!isRole(role)) return fail('invalid', 'Unknown repo role.');
    if (!isPrNumber(n)) return fail('invalid', 'That pull request number is not valid.');
    const c = this.requireClient();
    if (!c.ok) return c;
    const repo = await this.repoForRole(role);
    if (!repo.ok) return repo;
    const r = await this.offlineCapable(`pull|${repo.value.fullName}|${n}`, () => c.value.getPull(repo.value, n));
    if (!r.ok) return r;
    return r.value ? ok(r.value) : fail('not-found', `Pull request #${n} doesn't exist in ${repo.value.fullName}.`);
  }

  // -------------------------------------------------------------------------------------------
  // Products. All local: nothing here writes to GitHub.
  // -------------------------------------------------------------------------------------------

  private now() {
    return this.d.now?.() ?? new Date();
  }

  private local<T>(fn: () => T): Result<T> {
    try {
      return ok(fn());
    } catch (e) {
      return fail('invalid', `The local product database refused that: ${msg(e)}`);
    }
  }

  async listProducts(): Promise<Result<ProductSummary[]>> {
    return this.local(() => this.d.products.listProducts());
  }

  async getProduct(id: unknown): Promise<Result<ProductHome>> {
    if (!isId(id)) return fail('invalid', 'Unknown product.');
    const home = this.d.products.home(id);
    return home ? ok(home) : fail('not-found', 'That product no longer exists.');
  }

  async createProduct(input: unknown): Promise<Result<Product>> {
    const v = validateProductInput(input);
    if (!v.ok) return fail('invalid', v.message);
    return this.local(() => this.d.products.createProduct(v.value));
  }

  async updateProduct(id: unknown, input: unknown): Promise<Result<Product>> {
    if (!isId(id)) return fail('invalid', 'Unknown product.');
    const v = validateProductInput(input);
    if (!v.ok) return fail('invalid', v.message);
    const p = this.d.products.updateProduct(id, v.value);
    return p ? ok(p) : fail('not-found', 'That product no longer exists.');
  }

  async deleteProduct(id: unknown): Promise<Result<void>> {
    if (!isId(id)) return fail('invalid', 'Unknown product.');
    return this.d.products.deleteProduct(id) ? ok(undefined) : fail('not-found', 'That product no longer exists.');
  }

  /** Links items from the repo currently assigned to each item's role. */
  async addLinks(productId: unknown, links: unknown): Promise<Result<AddLinksResult>> {
    if (!isId(productId) || !this.d.products.getProduct(productId)) return fail('not-found', 'That product no longer exists.');
    if (!Array.isArray(links) || links.length === 0) return fail('invalid', 'Pick at least one item to link.');
    if (links.length > 500) return fail('invalid', 'Link at most 500 items at a time.');
    const s = await this.d.settings.load();
    if (!s.host) return fail('not-signed-in', 'Sign in first.');
    const rows: NewLink[] = [];
    for (const raw of links) {
      const v = validateLinkInput(raw);
      if (!v.ok) return fail('invalid', v.message);
      const repo = s.repoRoles[v.value.role];
      if (!repo) return fail('no-role', `No repo is assigned to the ${v.value.role} role yet.`);
      rows.push({ ...v.value, repoHost: s.host, repoFullName: repo.fullName });
    }
    return this.local(() => {
      const r = this.d.products.addLinks(productId, rows);
      this.d.products.snapshot(productId);
      return r;
    });
  }

  async updateLink(linkId: unknown, patch: unknown): Promise<Result<Link>> {
    if (!isId(linkId)) return fail('invalid', 'Unknown link.');
    const cur = this.d.products.getLink(linkId);
    if (!cur) return fail('not-found', 'That link no longer exists.');
    const v = validateLinkPatch(patch);
    if (!v.ok) return fail('invalid', v.message);
    const p = v.value;
    // A relink keeps the link's kind: a file stays a file, a pull request stays a pull request.
    if (cur.prNumber !== undefined && (p.path !== undefined || p.anchor != null)) return fail('invalid', 'This link is a pull request; pick another pull request.');
    if (cur.prNumber === undefined && p.prNumber != null) return fail('invalid', 'This link is a file; pick another file.');
    if (cur.prNumber !== undefined && p.prNumber === null) return fail('invalid', 'A pull request link needs a pull request number.');
    if (cur.kind === 'conversation' && p.anchor === null) return fail('invalid', 'A conversation needs a section.');
    if (cur.kind !== 'conversation' && p.anchor != null) return fail('invalid', 'Only a conversation points at a section.');
    if (cur.kind !== 'artifact' && p.artifactType !== undefined) return fail('invalid', 'Only artifacts have an artifact type.');
    try {
      const l = this.d.products.updateLink(linkId, p);
      return l ? ok(l) : fail('not-found', 'That link no longer exists.');
    } catch (e) {
      // The unique index: the new target is already linked to this product.
      return fail('invalid', /UNIQUE/i.test(msg(e)) ? 'That item is already linked to this product.' : msg(e));
    }
  }

  async removeLink(linkId: unknown): Promise<Result<void>> {
    if (!isId(linkId)) return fail('invalid', 'Unknown link.');
    const l = this.d.products.getLink(linkId);
    if (!l || !this.d.products.removeLink(linkId)) return fail('not-found', 'That link no longer exists.');
    this.d.products.snapshot(l.productId);
    return ok(undefined);
  }

  /**
   * Brings a product's items up to date with GitHub: link health (broken, moved) and board state.
   * Always answers with the product home: when GitHub can't be reached or the rate limit is used
   * up, the cached state comes back with the sync status saying why and how old it is.
   */
  async syncProduct(productId: unknown): Promise<Result<ProductHome>> {
    if (!isId(productId)) return fail('invalid', 'Unknown product.');
    const home = this.d.products.home(productId);
    if (!home) return fail('not-found', 'That product no longer exists.');
    const c = this.requireClient();
    if (!c.ok) return c;
    const cool = this.cooling();
    if (cool) {
      // Backing off: show what's cached and say why, without sending anything.
      this.d.products.recordSync(productId, { ok: false, error: cool, requests: 0, notModified: 0 });
      return ok(this.d.products.home(productId)!);
    }
    const s = await this.d.settings.load();
    const r = await syncLinks(home.links, s.host, s.repoRoles, c.value, this.d.cache, home.states, this.now());
    for (const o of r.outcomes) {
      if (o.clearPending) this.d.products.clearPending(o.linkId);
      if (o.health) this.d.products.setHealth(o.linkId, o.health);
      if (o.state) this.d.products.setItemState(o.linkId, o.state);
      const link = home.links.find((l) => l.id === o.linkId);
      if (o.blobSha && link && link.blobSha !== o.blobSha) this.d.products.updateLink(o.linkId, { blobSha: o.blobSha });
    }
    this.d.products.recordSync(productId, { ok: !r.error, error: r.error, requests: r.requests, notModified: r.notModified });
    if (!r.error && this.auth.status === 'signed-in' && this.auth.offline) this.auth = { ...this.auth, offline: false };
    this.d.products.snapshot(productId);
    return ok(this.d.products.home(productId)!);
  }

  /** Places an item in a workflow stage, or back in the unstaged tray with null. Local only. */
  async moveLink(linkId: unknown, stage: unknown): Promise<Result<Link>> {
    if (!isId(linkId)) return fail('invalid', 'Unknown link.');
    if (stage !== null && !isStage(stage)) return fail('invalid', 'Unknown stage.');
    const l = this.d.products.moveLink(linkId, stage);
    return l ? ok(l) : fail('not-found', 'That link no longer exists.');
  }

  async exportProduct(id: unknown): Promise<Result<FileDialogResult<{ path: string }>>> {
    if (!isId(id)) return fail('invalid', 'Unknown product.');
    const home = this.d.products.home(id);
    if (!home) return fail('not-found', 'That product no longer exists.');
    const text = `${JSON.stringify(toMapping(home, this.now()), null, 2)}\n`;
    const safeName = home.product.name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().replace(/\s+/g, '-') || 'product';
    try {
      const path = await this.d.files.saveText(`${safeName}.pmworkbench.json`, text);
      return ok(path ? { cancelled: false, path } : { cancelled: true });
    } catch (e) {
      return fail('invalid', `Couldn't write the file: ${msg(e)}`);
    }
  }

  async importProduct(): Promise<Result<FileDialogResult<ImportReport>>> {
    let text: string | null;
    try {
      text = await this.d.files.openText();
    } catch (e) {
      return fail('invalid', `Couldn't read the file: ${msg(e)}`);
    }
    if (text === null) return ok({ cancelled: true });
    return this.importMappingText(text).then((r) => (r.ok ? ok({ cancelled: false as const, ...r.value }) : r));
  }

  /** Imports a mapping file's text as a new product. Separate from the dialog so it can be tested directly. */
  async importMappingText(text: string): Promise<Result<ImportReport>> {
    let mapping;
    try {
      mapping = parseMapping(text);
    } catch (e) {
      return fail('invalid', e instanceof MappingError ? e.message : msg(e));
    }
    const s = await this.d.settings.load();
    if (!s.host) return fail('not-signed-in', 'Sign in and connect your repos before importing.');
    const plan = planImport(mapping, s.host, s.repoRoles);
    const v = validateProductInput(mapping.product);
    if (!v.ok) return fail('invalid', v.message);
    for (const l of plan.links) {
      const lv = validateLinkInput(l);
      if (!lv.ok) return fail('invalid', `"${l.title}": ${lv.message}`);
    }
    return this.local(() => {
      const product = this.d.products.createProduct(v.value);
      const { added } = this.d.products.addLinks(product.id, plan.links);
      this.d.products.snapshot(product.id);
      return { productId: product.id, productName: product.name, imported: added, unresolved: plan.unresolved };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Write-back (Phase 4a). Every write is a branch plus a pull request; see src/main/write/engine.ts.
  // -------------------------------------------------------------------------------------------

  private async writeCall<T>(fn: () => Promise<T>): Promise<Result<T>> {
    const c = this.requireClient();
    if (!c.ok) return c;
    const cool = this.cooling();
    if (cool) return fail('rate-limited', cool);
    try {
      return ok(await fn());
    } catch (e) {
      if (e instanceof WriteError) return fail(e.code === 'not-found' ? 'not-found' : e.code === 'network' ? 'network' : 'invalid', e.message);
      return fail('network', msg(e));
    }
  }

  async previewWrite(draft: unknown): Promise<Result<WritePreview>> {
    return this.writeCall(() => this.engine.preview(draft));
  }

  async confirmWrite(previewId: unknown): Promise<Result<WriteResult>> {
    return this.writeCall(() => this.engine.confirm(previewId));
  }

  async editSource(linkId: unknown): Promise<Result<EditSource>> {
    return this.writeCall(() => this.engine.editSource(linkId));
  }

  /** Opens a page on the configured GitHub web host. Everything else is refused, so this can't become a way out to arbitrary sites. */
  async openOnGitHub(url: unknown): Promise<Result<void>> {
    if (this.auth.status !== 'signed-in') return fail('not-signed-in', 'Sign in first.');
    let u: URL;
    try {
      u = new URL(String(url));
    } catch {
      return fail('invalid', 'Not a valid link.');
    }
    const web = this.auth.host.toLowerCase();
    if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== web || u.username || u.password) return fail('blocked-host', `Only links on ${web} can be opened from here.`);
    if (!this.d.openExternal) return fail('invalid', 'Opening links is not available.');
    await this.d.openExternal(u.toString());
    return ok(undefined);
  }

  // -------------------------------------------------------------------------------------------
  // Phase 4b: where CRM conversations and PDRs go, and the app's open pull requests
  // -------------------------------------------------------------------------------------------

  async crmLayout(): Promise<Result<CrmLayout>> {
    return this.writeCall(() => this.engine.crmLayout());
  }

  async pdrLayout(): Promise<Result<PdrLayout>> {
    return this.writeCall(() => this.engine.pdrLayout());
  }

  /**
   * Every pull request the app opened, across the three repos, with its live review state:
   * status, reviewers and their latest review, and unresolved review threads. Read through the
   * same cached, conditional sync as the board.
   */
  async listAppPulls(): Promise<Result<AppPullStatus[]>> {
    const c = this.requireClient();
    if (!c.ok) return c;
    const s = await this.d.settings.load();
    const writes = this.d.products.writes().filter((w) => w.prNumber !== undefined);
    const names = new Map(this.d.products.listProducts().map((p) => [p.id, p.name]));
    // Run them through the sync as pull-request links so state, caching and back-off are shared.
    const pseudo = writes.map((w): Link => ({
      id: `write:${w.id}`, productId: w.productId ?? '', role: w.role, kind: 'decision', repoHost: this.host, repoFullName: w.repo,
      prNumber: w.prNumber, title: w.title, health: { state: 'unchecked' }, createdAt: w.createdAt,
    }));
    const prev = this.appPullStates;
    const cool = this.cooling();
    const r = cool ? undefined : await syncLinks(pseudo, s.host, s.repoRoles, c.value, this.d.cache, prev, this.now());
    for (const o of r?.outcomes ?? []) if (o.state) this.appPullStates[o.linkId] = o.state;
    return ok(writes.map((w) => {
      const st = this.appPullStates[`write:${w.id}`];
      const pr = st && st.kind === 'pull' ? st : undefined;
      return {
        ...w, reviewers: pr?.reviewers ?? [], ...(pr ? { status: pr.status } : {}), ...(pr?.unresolvedComments !== undefined ? { unresolvedComments: pr.unresolvedComments } : {}),
        ...(w.productId && names.has(w.productId) ? { productName: names.get(w.productId) } : {}),
      };
    }));
  }

  private appPullStates: Record<string, ItemState> = {};
}
