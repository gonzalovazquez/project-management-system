import { DEFAULT_METRIC_SETTINGS } from '../src/shared/metrics.js';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RepoRef } from '../src/shared/ipc.js';
import { createSettingsStore, defaultSettings, validatePatch } from '../src/main/app/settings.js';
import { tmp } from './helpers.js';

const repo = (name: string): RepoRef => ({ owner: 'gonzalovazquez', name, fullName: `gonzalovazquez/${name}`, defaultBranch: 'main', private: true, htmlUrl: `https://github.com/gonzalovazquez/${name}` });

describe('defaultSettings', () => {
  it('starts with no host, no roles, system appearance and not onboarded', () => {
    expect(defaultSettings()).toEqual({ host: '', repoRoles: {}, appearance: 'system', onboarded: false, metrics: DEFAULT_METRIC_SETTINGS });
  });
});

describe('validatePatch', () => {
  it('accepts an empty patch and a fully valid one', () => {
    expect(validatePatch({})).toBeUndefined();
    expect(validatePatch({ host: 'github.com', repoRoles: { artifacts: repo('artifacts') }, appearance: 'dark', onboarded: true })).toBeUndefined();
  });
  it('accepts clearing a role with null', () => {
    expect(validatePatch({ repoRoles: { crm: null } })).toBeUndefined();
  });
  it('rejects an unknown repo role', () => {
    expect(validatePatch({ repoRoles: { bogus: repo('x') } as never })).toMatch(/not a repo role/);
  });
  it('rejects a repo missing required fields', () => {
    expect(validatePatch({ repoRoles: { pdr: { name: 'x' } as never } })).toMatch(/missing required fields/);
  });
  it('rejects an invalid appearance', () => {
    expect(validatePatch({ appearance: 'matrix' as never })).toMatch(/system, light or dark/);
  });
  it('rejects a non-boolean onboarded', () => {
    expect(validatePatch({ onboarded: 'yes' as never })).toMatch(/true or false/);
  });
});

describe('createSettingsStore', () => {
  it('loads defaults when no file exists yet', async () => {
    const store = createSettingsStore(join(tmp(), 'settings.json'));
    expect(await store.load()).toEqual(defaultSettings());
  });

  it('persists a patch and merges it onto what is already stored', async () => {
    const store = createSettingsStore(join(tmp(), 'settings.json'));
    await store.save({ host: 'github.com', repoRoles: { artifacts: repo('artifacts-and-skills') } });
    const after = await store.save({ repoRoles: { crm: repo('customer-notes') }, appearance: 'dark' });
    expect(after.host).toBe('github.com');
    expect(after.repoRoles.artifacts?.fullName).toBe('gonzalovazquez/artifacts-and-skills');
    expect(after.repoRoles.crm?.fullName).toBe('gonzalovazquez/customer-notes');
    expect(after.appearance).toBe('dark');
  });

  it('a null in a patch clears just that role', async () => {
    const store = createSettingsStore(join(tmp(), 'settings.json'));
    await store.save({ repoRoles: { artifacts: repo('a'), crm: repo('b') } });
    const after = await store.save({ repoRoles: { crm: null } });
    expect(after.repoRoles.artifacts).toBeDefined();
    expect(after.repoRoles.crm).toBeUndefined();
  });

  it('rejects an invalid patch and leaves the stored settings untouched', async () => {
    const path = join(tmp(), 'settings.json');
    const store = createSettingsStore(path);
    await store.save({ host: 'github.com' });
    await expect(store.save({ appearance: 'nope' as never })).rejects.toThrow();
    expect((await store.load()).host).toBe('github.com');
  });

  it('a corrupt settings file is treated as defaults, not an error', async () => {
    const path = join(tmp(), 'settings.json');
    const store = createSettingsStore(path);
    await store.save({ host: 'github.com' });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '{not json');
    expect(await createSettingsStore(path).load()).toEqual(defaultSettings());
  });

  it('drops a malformed stored role rather than trusting it', async () => {
    const path = join(tmp(), 'settings.json');
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ host: 'github.com', repoRoles: { artifacts: { name: 'incomplete' }, pdr: repo('pdr') }, appearance: 'system', onboarded: true }));
    const loaded = await createSettingsStore(path).load();
    expect(loaded.repoRoles.artifacts).toBeUndefined();
    expect(loaded.repoRoles.pdr?.fullName).toBe('gonzalovazquez/pdr');
  });
});

describe('metric settings', () => {
  it('accepts whole-day review points and rejects anything else', async () => {
    const store = createSettingsStore(join(tmp(), 's.json'));
    const m = { stageThresholds: { intake: 7, problem: 14, solution: 21, specification: 14, release: 30 }, quietDays: 10 };
    expect((await store.save({ metrics: m })).metrics).toEqual(m);
    expect((await store.load()).metrics).toEqual(m);
    await expect(store.save({ metrics: { ...m, quietDays: 0 } })).rejects.toThrow(/whole number/);
    await expect(store.save({ metrics: { ...m, stageThresholds: { ...m.stageThresholds, release: 2.5 } } })).rejects.toThrow(/whole number/);
  });
});
