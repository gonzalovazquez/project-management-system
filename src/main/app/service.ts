import { fail, ok, REPO_ROLES, type AuthState, type FileContent, type PublicSettings, type RepoRef, type RepoRole, type Result, type SettingsPatch, type TreeEntry } from '../../shared/ipc.js';
import { normalizeHost } from '../github/host.js';
import type { GitHubClient } from '../github/client.js';
import { SecureStorageUnavailable, type TokenStore } from './secrets.js';
import type { SettingsStore } from './settings.js';

export interface ServiceDeps {
  settings: SettingsStore;
  tokens: Pick<TokenStore, 'get' | 'set' | 'secureStorageAvailable'>;
  /** Builds a client for one host+token pair. Never called with an unvalidated token held onto past the call that validates it. */
  createClient(host: string, token: string): GitHubClient;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Owns sign-in, the repo-role settings, and browsing the three connected repos. Everything here
 * is Phase 1 scope: the product model, the workflow board and write-back are later phases.
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

  async listAvailableRepos(): Promise<Result<RepoRef[]>> {
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
      return ok({ path: f.path, content: f.content, truncated: f.truncated, htmlUrl: f.htmlUrl });
    } catch (e) {
      return fail('network', msg(e));
    }
  }
}
