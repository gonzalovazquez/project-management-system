import { APPEARANCES, REPO_ROLES, type Appearance, type RepoRef, type RepoRole, type SettingsPatch } from '../../shared/ipc.js';
import { readJson, writeJsonAtomic } from './jsonFile.js';

export interface StoredSettings {
  host: string;
  repoRoles: Partial<Record<RepoRole, RepoRef>>;
  appearance: Appearance;
  onboarded: boolean;
  /** The GitHub login last signed in, so the app can open offline without asking GitHub who the token belongs to. */
  login?: string;
}

export const defaultSettings = (): StoredSettings => ({ host: '', repoRoles: {}, appearance: 'system', onboarded: false });

export interface SettingsStore {
  load(): Promise<StoredSettings>;
  save(patch: SettingsPatch & { host?: string; login?: string }): Promise<StoredSettings>;
}

const isRepoRef = (v: unknown): v is RepoRef => {
  const r = v as RepoRef;
  return !!r && typeof r.owner === 'string' && typeof r.name === 'string' && typeof r.fullName === 'string' && typeof r.defaultBranch === 'string' && typeof r.private === 'boolean' && typeof r.htmlUrl === 'string';
};

/** Returns an error message, or undefined when the patch is acceptable. */
export function validatePatch(patch: SettingsPatch & { host?: string; login?: string }): string | undefined {
  if (patch.host !== undefined && typeof patch.host !== 'string') return 'The host must be a string.';
  if (patch.login !== undefined && typeof patch.login !== 'string') return 'The login must be a string.';
  if (patch.repoRoles !== undefined) {
    if (typeof patch.repoRoles !== 'object' || patch.repoRoles === null || Array.isArray(patch.repoRoles)) return 'Repo roles must be a map of role to repo.';
    for (const [role, repo] of Object.entries(patch.repoRoles)) {
      if (!REPO_ROLES.includes(role as RepoRole)) return `"${role}" is not a repo role.`;
      if (repo !== null && !isRepoRef(repo)) return `The repo for "${role}" is missing required fields.`;
    }
  }
  if (patch.appearance !== undefined && !APPEARANCES.includes(patch.appearance)) return 'Appearance must be system, light or dark.';
  if (patch.onboarded !== undefined && typeof patch.onboarded !== 'boolean') return 'The onboarded setting must be true or false.';
  return undefined;
}

function sanitizeRoles(stored: unknown): Partial<Record<RepoRole, RepoRef>> {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
  const out: Partial<Record<RepoRole, RepoRef>> = {};
  for (const [role, repo] of Object.entries(stored as Record<string, unknown>)) {
    if (REPO_ROLES.includes(role as RepoRole) && isRepoRef(repo)) out[role as RepoRole] = repo;
  }
  return out;
}

export function createSettingsStore(path: string): SettingsStore {
  const load = async (): Promise<StoredSettings> => {
    const stored = await readJson<Partial<StoredSettings>>(path);
    const d = defaultSettings();
    return {
      host: typeof stored?.host === 'string' ? stored.host : d.host,
      repoRoles: sanitizeRoles(stored?.repoRoles),
      appearance: stored?.appearance && APPEARANCES.includes(stored.appearance) ? stored.appearance : d.appearance,
      onboarded: typeof stored?.onboarded === 'boolean' ? stored.onboarded : d.onboarded,
      ...(typeof stored?.login === 'string' && stored.login ? { login: stored.login } : {}),
    };
  };
  return {
    load,
    async save(patch) {
      const err = validatePatch(patch);
      if (err) throw new Error(err);
      const current = await load();
      const repoRoles = { ...current.repoRoles };
      if (patch.repoRoles) {
        for (const [role, repo] of Object.entries(patch.repoRoles)) {
          if (repo === null) delete repoRoles[role as RepoRole];
          else repoRoles[role as RepoRole] = repo as RepoRef;
        }
      }
      const next: StoredSettings = {
        host: patch.host ?? current.host,
        repoRoles,
        appearance: patch.appearance ?? current.appearance,
        onboarded: patch.onboarded ?? current.onboarded,
        ...((patch.login ?? current.login) ? { login: patch.login ?? current.login } : {}),
      };
      await writeJsonAtomic(path, next);
      return next;
    },
  };
}
