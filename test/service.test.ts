import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RepoRef } from '../src/shared/ipc.js';
import type { GitHubClient } from '../src/main/github/client.js';
import { SecureStorageUnavailable, TokenStore, type SecretBox } from '../src/main/app/secrets.js';
import { AppService, type ServiceDeps } from '../src/main/app/service.js';
import { createSettingsStore } from '../src/main/app/settings.js';
import { openDatabase } from '../src/main/products/db.js';
import { ProductStore } from '../src/main/products/store.js';
import { HttpCache } from '../src/main/products/httpcache.js';
import { tmp } from './helpers.js';

const repo = (name: string): RepoRef => ({ owner: 'gonzalovazquez', name, fullName: `gonzalovazquez/${name}`, defaultBranch: 'main', private: true, htmlUrl: `https://github.com/gonzalovazquez/${name}` });

function fakeBox(): SecretBox {
  let stored: string | undefined;
  return {
    isAvailable: () => true,
    encrypt: (plain) => { stored = plain; return Buffer.from(plain); },
    decrypt: () => stored ?? '',
  };
}

interface Setup { deps: ServiceDeps; clients: Record<string, Partial<GitHubClient>>; createClient: ServiceDeps['createClient'] }

function setup(env: Record<string, string | undefined> = {}): Setup {
  const dir = tmp();
  const clients: Record<string, Partial<GitHubClient>> = {};
  const createClient: ServiceDeps['createClient'] = (host, token) => {
    const key = `${host}:${token}`;
    const client = clients[key] ?? (clients[key] = { whoAmI: async () => { throw new Error(`no fake client registered for ${key}`); } });
    return client as GitHubClient;
  };
  const deps: ServiceDeps = {
    settings: createSettingsStore(join(dir, 'settings.json')),
    tokens: new TokenStore(join(dir, 'token.bin'), fakeBox(), env),
    createClient,
    products: new ProductStore(openDatabase(':memory:')),
    cache: new HttpCache(openDatabase(':memory:')),
    files: { saveText: async () => null, openText: async () => null },
  };
  return { deps, clients, createClient };
}

describe('AppService', () => {
  let s: Setup;
  beforeEach(() => { s = setup(); });

  it('starts signed out and stays signed out when init finds nothing', async () => {
    const svc = new AppService(s.deps);
    await svc.init();
    expect(svc.getAuth()).toEqual({ status: 'signed-out' });
  });

  it('signIn validates the token against GitHub, stores it, and reports signed-in', async () => {
    s.clients['github.com:ghp_good'] = { whoAmI: async () => ({ login: 'gonzo' }) };
    const svc = new AppService(s.deps);
    const result = await svc.signIn('github.com', 'ghp_good');
    expect(result).toEqual({ ok: true, value: { status: 'signed-in', host: 'github.com', login: 'gonzo', tokenSource: 'keychain' } });
    expect(svc.getAuth()).toEqual(result.ok ? result.value : undefined);
  });

  it('signIn fails cleanly when GitHub rejects the token, and nothing is persisted', async () => {
    s.clients['github.com:ghp_bad'] = { whoAmI: async () => { throw new Error('401 Bad credentials'); } };
    const svc = new AppService(s.deps);
    const result = await svc.signIn('github.com', 'ghp_bad');
    expect(result.ok).toBe(false);
    expect(svc.getAuth()).toEqual({ status: 'signed-out' });
    expect((await s.deps.tokens.get()).source).toBe('none');
  });

  it('signIn rejects an invalid host or an empty token before ever calling GitHub', async () => {
    const svc = new AppService(s.deps);
    expect((await svc.signIn('', 'ghp_x')).ok).toBe(false);
    expect((await svc.signIn('github.com', '  ')).ok).toBe(false);
  });

  it('signIn surfaces a secure-storage failure as a result instead of throwing', async () => {
    s.clients['github.com:ghp_good'] = { whoAmI: async () => ({ login: 'gonzo' }) };
    const broken: ServiceDeps['tokens'] = { get: async () => ({ source: 'none' }), set: async () => { throw new SecureStorageUnavailable(); }, secureStorageAvailable: false };
    const svc = new AppService({ ...s.deps, tokens: broken });
    const result = await svc.signIn('github.com', 'ghp_good');
    expect(result.ok).toBe(false);
  });

  it('init resumes a session from a token set via the environment', async () => {
    s.clients['github.com:ghp_env'] = { whoAmI: async () => ({ login: 'gonzo' }) };
    await s.deps.settings.save({ host: 'github.com' });
    const env = setup({ GITHUB_TOKEN: 'ghp_env' });
    env.clients['github.com:ghp_env'] = { whoAmI: async () => ({ login: 'gonzo' }) };
    await env.deps.settings.save({ host: 'github.com' });
    const svc = new AppService(env.deps);
    await svc.init();
    expect(svc.getAuth()).toEqual({ status: 'signed-in', host: 'github.com', login: 'gonzo', tokenSource: 'env' });
  });

  it('applies the appearance setting at launch and whenever it is saved, and only then', async () => {
    const applied: string[] = [];
    const deps = { ...s.deps, applyAppearance: (a: string) => { applied.push(a); } };
    await deps.settings.save({ appearance: 'dark' });
    const svc = new AppService(deps);
    await svc.init();
    expect(applied).toEqual(['dark']);
    expect((await svc.saveSettings({ appearance: 'light' })).ok).toBe(true);
    expect((await svc.saveSettings({ onboarded: true })).ok).toBe(true); // unrelated change: not re-applied
    expect((await svc.saveSettings({ appearance: 'system' })).ok).toBe(true);
    expect(applied).toEqual(['dark', 'light', 'system']);
    expect((await svc.saveSettings({ appearance: 'neon' as never })).ok).toBe(false);
    expect(applied).toEqual(['dark', 'light', 'system']);
  });

  it('init stays signed in, marked offline, when GitHub cannot be reached at launch', async () => {
    s.clients['github.com:ghp_good'] = { whoAmI: async () => ({ login: 'gonzo' }) };
    await new AppService(s.deps).signIn('github.com', 'ghp_good');
    s.clients['github.com:ghp_good'] = { whoAmI: async () => { throw new TypeError('fetch failed'); } };
    const svc = new AppService(s.deps);
    await svc.init();
    expect(svc.getAuth()).toEqual({ status: 'signed-in', host: 'github.com', login: 'gonzo', tokenSource: 'keychain', offline: true });
  });

  it('init still signs out when GitHub rejects the stored token, even with a remembered login', async () => {
    s.clients['github.com:ghp_good'] = { whoAmI: async () => ({ login: 'gonzo' }) };
    await new AppService(s.deps).signIn('github.com', 'ghp_good');
    s.clients['github.com:ghp_good'] = { whoAmI: async () => { throw Object.assign(new Error('Bad credentials'), { status: 401 }); } };
    const svc = new AppService(s.deps);
    await svc.init();
    expect(svc.getAuth()).toEqual({ status: 'signed-out' });
  });

  it('init falls back to signed-out when the stored token no longer works', async () => {
    await s.deps.settings.save({ host: 'github.com' });
    await s.deps.tokens.set('ghp_stale');
    s.clients['github.com:ghp_stale'] = { whoAmI: async () => { throw new Error('401'); } };
    const svc = new AppService(s.deps);
    await svc.init();
    expect(svc.getAuth()).toEqual({ status: 'signed-out' });
  });

  it('signOut clears the token and the in-memory client', async () => {
    s.clients['github.com:ghp_good'] = { whoAmI: async () => ({ login: 'gonzo' }) };
    const svc = new AppService(s.deps);
    await svc.signIn('github.com', 'ghp_good');
    await svc.signOut();
    expect(svc.getAuth()).toEqual({ status: 'signed-out' });
    expect((await s.deps.tokens.get()).source).toBe('none');
  });

  it('every repo-scoped call requires signing in first', async () => {
    const svc = new AppService(s.deps);
    expect((await svc.listAvailableRepos()).ok).toBe(false);
    expect((await svc.browseTree('artifacts', '')).ok).toBe(false);
    expect((await svc.readFile('artifacts', 'README.md')).ok).toBe(false);
  });

  it('browseTree and readFile require that role to have a repo assigned', async () => {
    s.clients['github.com:ghp_good'] = { whoAmI: async () => ({ login: 'gonzo' }) };
    const svc = new AppService(s.deps);
    await svc.signIn('github.com', 'ghp_good');
    const result = await svc.browseTree('crm', '');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('no-role');
  });

  it('browseTree and readFile use the repo assigned to that role', async () => {
    const repoRef = repo('pm-artifacts');
    s.clients['github.com:ghp_good'] = {
      whoAmI: async () => ({ login: 'gonzo' }),
      listTree: async (r, path) => [{ path: `${r.name}/${path}`, name: 'README.md', type: 'file', sha: 's' }],
      getFile: async (r) => ({ path: 'README.md', content: `hello from ${r.fullName}`, truncated: false, htmlUrl: 'https://x', sha: 's' }),
    };
    const svc = new AppService(s.deps);
    await svc.signIn('github.com', 'ghp_good');
    await svc.saveSettings({ repoRoles: { artifacts: repoRef } });
    const tree = await svc.browseTree('artifacts', '');
    expect(tree.ok).toBe(true);
    const file = await svc.readFile('artifacts', 'README.md');
    expect(file.ok && file.value.content).toBe('hello from gonzalovazquez/pm-artifacts');
  });

  it('getSettings reports whether secure storage is available', async () => {
    const svc = new AppService(s.deps);
    expect((await svc.getSettings()).secureStorageAvailable).toBe(true);
  });

  it('saveSettings rejects an invalid patch with a Result instead of throwing', async () => {
    const svc = new AppService(s.deps);
    const result = await svc.saveSettings({ appearance: 'nope' as never });
    expect(result.ok).toBe(false);
  });
});
