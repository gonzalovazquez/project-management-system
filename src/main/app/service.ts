import { fail, ok, REPO_ROLES, type AuthState, type FileContent, type PublicSettings, type RepoList, type RepoRef, type RepoRole, type Result, type SettingsPatch, type TreeEntry } from '../../shared/ipc.js';
import type { AddLinksResult, FileDialogResult, ImportReport, Link, Product, ProductHome, ProductSummary, PullDetail, PullSummary } from '../../shared/products.js';
import { normalizeHost } from '../github/host.js';
import type { GitHubClient } from '../github/client.js';
import { checkLinks } from '../products/linkcheck.js';
import { MappingError, parseMapping, planImport, toMapping } from '../products/mapping.js';
import type { NewLink, ProductStore } from '../products/store.js';
import { isId, isPrNumber, isRole, validateLinkInput, validateLinkPatch, validateProductInput } from '../products/validate.js';
import { SecureStorageUnavailable, type TokenStore } from './secrets.js';
import type { SettingsStore } from './settings.js';

export interface ServiceDeps {
  settings: SettingsStore;
  tokens: Pick<TokenStore, 'get' | 'set' | 'secureStorageAvailable'>;
  /** Builds a client for one host+token pair. Never called with an unvalidated token held onto past the call that validates it. */
  createClient(host: string, token: string): GitHubClient;
  products: ProductStore;
  /** Native file dialogs, behind an interface so tests can stand in for them. null means the PM cancelled. */
  files: {
    saveText(suggestedName: string, text: string): Promise<string | null>;
    openText(): Promise<string | null>;
  };
  now?: () => Date;
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

  constructor(private d: ServiceDeps) {}

  /** Tries to resume a session from a stored host and token (env var or Keychain). Never throws. */
  async init(): Promise<void> {
    const settings = await this.d.settings.load();
    const { token, source } = await this.d.tokens.get();
    if (!settings.host || !token) return;
    try {
      const client = this.d.createClient(settings.host, token);
      const { login } = await client.whoAmI();
      this.host = settings.host;
      this.token = token;
      this.client = client;
      this.auth = { status: 'signed-in', host: settings.host, login, tokenSource: source === 'env' ? 'env' : 'keychain' };
    } catch {
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
    const client = this.d.createClient(host, token);
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
    await this.d.settings.save({ host });
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
    if (this.auth.status !== 'signed-in' || !this.client) return fail('not-signed-in', 'Sign in with a GitHub personal access token first.');
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
    return { host: s.host, repoRoles: s.repoRoles, appearance: s.appearance, onboarded: s.onboarded, secureStorageAvailable: this.d.tokens.secureStorageAvailable };
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
    try {
      return ok(await c.value.listTree(repo.value, path));
    } catch (e) {
      return fail('network', msg(e));
    }
  }

  async readFile(role: RepoRole, path: string): Promise<Result<FileContent>> {
    const c = this.requireClient();
    if (!c.ok) return c;
    const repo = await this.repoForRole(role);
    if (!repo.ok) return repo;
    try {
      const f = await c.value.getFile(repo.value, path);
      return ok({ path: f.path, content: f.content, truncated: f.truncated, htmlUrl: f.htmlUrl, sha: f.sha });
    } catch (e) {
      return fail('network', msg(e));
    }
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
    try {
      return ok(await c.value.listPulls(repo.value));
    } catch (e) {
      return fail('network', msg(e));
    }
  }

  async readPull(role: unknown, n: unknown): Promise<Result<PullDetail>> {
    if (!isRole(role)) return fail('invalid', 'Unknown repo role.');
    if (!isPrNumber(n)) return fail('invalid', 'That pull request number is not valid.');
    const c = this.requireClient();
    if (!c.ok) return c;
    const repo = await this.repoForRole(role);
    if (!repo.ok) return repo;
    try {
      const pr = await c.value.getPull(repo.value, n);
      return pr ? ok(pr) : fail('not-found', `Pull request #${n} doesn't exist in ${repo.value.fullName}.`);
    } catch (e) {
      return fail('network', msg(e));
    }
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
    return this.local(() => this.d.products.addLinks(productId, rows));
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
    return this.d.products.removeLink(linkId) ? ok(undefined) : fail('not-found', 'That link no longer exists.');
  }

  async checkLinks(productId: unknown): Promise<Result<ProductHome>> {
    if (!isId(productId)) return fail('invalid', 'Unknown product.');
    const home = this.d.products.home(productId);
    if (!home) return fail('not-found', 'That product no longer exists.');
    const c = this.requireClient();
    if (!c.ok) return c;
    const s = await this.d.settings.load();
    const outcomes = await checkLinks(home.links, s.host, s.repoRoles, c.value, this.now());
    for (const o of outcomes) {
      if (o.health) this.d.products.setHealth(o.linkId, o.health);
      const link = home.links.find((l) => l.id === o.linkId);
      if (o.blobSha && link && link.blobSha !== o.blobSha) this.d.products.updateLink(o.linkId, { blobSha: o.blobSha });
    }
    const errors = outcomes.filter((o) => o.error);
    if (errors.length === outcomes.length && errors.length > 0) return fail('network', `Couldn't reach GitHub to check links: ${errors[0].error}`);
    return ok(this.d.products.home(productId)!);
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
      return { productId: product.id, productName: product.name, imported: added, unresolved: plan.unresolved };
    });
  }
}
