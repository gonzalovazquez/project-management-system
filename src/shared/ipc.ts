/**
 * The whole contract between the renderer and the main process. The renderer never reaches the
 * network, the file system, or GitHub directly — every one of these calls crosses the preload
 * bridge (src/preload/index.ts) to a handler registered in src/main/app/ipc.ts. Nothing else is
 * exposed on window.pmworkbench.
 */

export type RepoRole = 'artifacts' | 'crm' | 'pdr';
export const REPO_ROLES: RepoRole[] = ['artifacts', 'crm', 'pdr'];
export const ROLE_LABEL: Record<RepoRole, string> = { artifacts: 'Artifacts and skills', crm: 'CRM', pdr: 'PDR' };

export type Appearance = 'system' | 'light' | 'dark';
export const APPEARANCES: Appearance[] = ['system', 'light', 'dark'];

export interface RepoRef {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  htmlUrl: string;
}

export interface RepoList {
  repos: RepoRef[];
  /** The token is a classic PAT without the `repo` scope, so private repos are hidden from it. */
  missingPrivateScope: boolean;
}

export type AuthState =
  | { status: 'signed-out' }
  | { status: 'signed-in'; host: string; login: string; tokenSource: 'env' | 'keychain' };

export interface PublicSettings {
  host: string;
  repoRoles: Partial<Record<RepoRole, RepoRef>>;
  appearance: Appearance;
  onboarded: boolean;
  secureStorageAvailable: boolean;
}

export interface SettingsPatch {
  repoRoles?: Partial<Record<RepoRole, RepoRef | null>>;
  appearance?: Appearance;
  onboarded?: boolean;
}

export interface TreeEntry {
  path: string;
  name: string;
  type: 'file' | 'dir';
  sha: string;
}

export interface FileContent {
  path: string;
  content: string;
  truncated: boolean;
  htmlUrl: string;
}

export type ErrorCode = 'invalid' | 'not-signed-in' | 'no-role' | 'network' | 'blocked-host';
export type Result<T> = { ok: true; value: T } | { ok: false; error: ErrorCode; message: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (error: ErrorCode, message: string): Result<never> => ({ ok: false, error, message });

export interface PMWorkbenchApi {
  getAuth(): Promise<AuthState>;
  signIn(host: string, token: string): Promise<Result<AuthState>>;
  signOut(): Promise<void>;
  listAvailableRepos(): Promise<Result<RepoList>>;
  getSettings(): Promise<PublicSettings>;
  saveSettings(patch: SettingsPatch): Promise<Result<PublicSettings>>;
  browseTree(role: RepoRole, path: string): Promise<Result<TreeEntry[]>>;
  readFile(role: RepoRole, path: string): Promise<Result<FileContent>>;
}

export const CHANNELS = {
  getAuth: 'pmw:get-auth',
  signIn: 'pmw:sign-in',
  signOut: 'pmw:sign-out',
  listAvailableRepos: 'pmw:list-available-repos',
  getSettings: 'pmw:get-settings',
  saveSettings: 'pmw:save-settings',
  browseTree: 'pmw:browse-tree',
  readFile: 'pmw:read-file',
} as const;
