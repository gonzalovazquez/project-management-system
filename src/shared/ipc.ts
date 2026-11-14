/**
 * The whole contract between the renderer and the main process. The renderer never reaches the
 * network, the file system, or GitHub directly — every one of these calls crosses the preload
 * bridge (src/preload/index.ts) to a handler registered in src/main/app/ipc.ts. Nothing else is
 * exposed on window.pmworkbench.
 */
import type { MetricSettings } from './metrics.js';
import type { EditSource, WriteDraft, WritePreview, WriteResult } from './writes.js';
import type { AddLinksResult, ArtifactType, WorkflowStage, FileDialogResult, ImportReport, Link, LinkInput, Product, ProductHome, ProductInput, ProductSummary, PullDetail, PullSummary } from './products.js';

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
  /** `offline`: GitHub couldn't be reached at launch to re-check the token; cached data is shown until a sync succeeds. */
  | { status: 'signed-in'; host: string; login: string; tokenSource: 'env' | 'keychain'; offline?: boolean };

export interface PublicSettings {
  host: string;
  repoRoles: Partial<Record<RepoRole, RepoRef>>;
  appearance: Appearance;
  onboarded: boolean;
  secureStorageAvailable: boolean;
  /** Flow-metric review points: days in each stage, and days without activity, before an item is flagged. */
  metrics: MetricSettings;
  /** Template file per artifact type in the artifacts repo. */
  templates: Partial<Record<ArtifactType, string>>;
}

export interface SettingsPatch {
  repoRoles?: Partial<Record<RepoRole, RepoRef | null>>;
  appearance?: Appearance;
  onboarded?: boolean;
  metrics?: MetricSettings;
  /** Set a type's template path, or null to clear it. */
  templates?: Partial<Record<ArtifactType, string | null>>;
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
  /** Blob SHA, recorded on links so a moved file can be found again. */
  sha: string;
}

export type ErrorCode = 'invalid' | 'not-signed-in' | 'no-role' | 'network' | 'blocked-host' | 'not-found';
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
  listPulls(role: RepoRole): Promise<Result<PullSummary[]>>;
  readPull(role: RepoRole, number: number): Promise<Result<PullDetail>>;

  listProducts(): Promise<Result<ProductSummary[]>>;
  getProduct(id: string): Promise<Result<ProductHome>>;
  createProduct(input: ProductInput): Promise<Result<Product>>;
  updateProduct(id: string, input: ProductInput): Promise<Result<Product>>;
  /** Removes the product and its links from this Mac. Nothing in GitHub changes. */
  deleteProduct(id: string): Promise<Result<void>>;
  addLinks(productId: string, links: LinkInput[]): Promise<Result<AddLinksResult>>;
  /** Relink (a new path, section or pull request) or relabel one link. */
  updateLink(linkId: string, patch: LinkUpdate): Promise<Result<Link>>;
  removeLink(linkId: string): Promise<Result<void>>;
  /**
   * Syncs a product's items with GitHub (link health and board state) and returns the product home.
   * Offline or rate limited, it still succeeds with the cached state; `sync.lastError` says why.
   */
  syncProduct(productId: string): Promise<Result<ProductHome>>;
  /** Places an item in a workflow stage, or back in the unstaged tray with null. Writes nothing to GitHub. */
  moveLink(linkId: string, stage: WorkflowStage | null): Promise<Result<Link>>;
  /** Asks where to save, then writes the product's mapping file. */
  exportProduct(id: string): Promise<Result<FileDialogResult<{ path: string }>>>;
  /** Asks for a mapping file, then imports it as a new product. */
  importProduct(): Promise<Result<FileDialogResult<ImportReport>>>;

  /** Write-back: build the branch, diff and pull request for a change, without sending anything. */
  previewWrite(draft: WriteDraft): Promise<Result<WritePreview>>;
  /** Send exactly what a preview showed: a branch, one commit, and a pull request (or a commit on the app's existing one). */
  confirmWrite(previewId: string): Promise<Result<WriteResult>>;
  /** The current text of a linked artifact to edit, from the app's open pull request touching it if there is one. */
  editSource(linkId: string): Promise<Result<EditSource>>;
  /** Opens a page on the configured GitHub host (a pull request, a file) in the default browser. Any other URL is refused. */
  openOnGitHub(url: string): Promise<Result<void>>;
}

export interface LinkUpdate {
  path?: string;
  anchor?: string | null;
  prNumber?: number | null;
  title?: string;
  artifactType?: ArtifactType;
  blobSha?: string | null;
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
  listPulls: 'pmw:list-pulls',
  readPull: 'pmw:read-pull',
  listProducts: 'pmw:list-products',
  getProduct: 'pmw:get-product',
  createProduct: 'pmw:create-product',
  updateProduct: 'pmw:update-product',
  deleteProduct: 'pmw:delete-product',
  addLinks: 'pmw:add-links',
  updateLink: 'pmw:update-link',
  removeLink: 'pmw:remove-link',
  syncProduct: 'pmw:sync-product',
  moveLink: 'pmw:move-link',
  exportProduct: 'pmw:export-product',
  importProduct: 'pmw:import-product',
  previewWrite: 'pmw:preview-write',
  confirmWrite: 'pmw:confirm-write',
  editSource: 'pmw:edit-source',
  openOnGitHub: 'pmw:open-on-github',
} as const;
