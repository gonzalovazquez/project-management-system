import { describe, expect, it, vi } from 'vitest';
import { createGuardedFetch, DisallowedHostError } from '../src/main/github/allowlist.js';

describe('createGuardedFetch', () => {
  it('passes through a request to the allowed host', async () => {
    const base = vi.fn(async () => new Response('ok'));
    const guarded = createGuardedFetch(() => 'api.github.com', base as unknown as typeof fetch);
    await guarded('https://api.github.com/user');
    expect(base).toHaveBeenCalledOnce();
  });

  it('blocks a request to any other host — this is the test the Phase 1 plan asked for', async () => {
    const base = vi.fn(async () => new Response('ok'));
    const guarded = createGuardedFetch(() => 'api.github.com', base as unknown as typeof fetch);
    await expect(guarded('https://evil.example.com/steal')).rejects.toThrow(DisallowedHostError);
    expect(base).not.toHaveBeenCalled();
  });

  it('blocks everything when no host is configured yet', async () => {
    const base = vi.fn(async () => new Response('ok'));
    const guarded = createGuardedFetch(() => undefined, base as unknown as typeof fetch);
    await expect(guarded('https://api.github.com/user')).rejects.toThrow(DisallowedHostError);
  });

  it('blocks a request whose URL does not even parse', async () => {
    const base = vi.fn(async () => new Response('ok'));
    const guarded = createGuardedFetch(() => 'api.github.com', base as unknown as typeof fetch);
    await expect(guarded('not a url')).rejects.toThrow(DisallowedHostError);
    expect(base).not.toHaveBeenCalled();
  });

  it('matches hostnames case-insensitively, and accepts a Request or URL as input', async () => {
    const base = vi.fn(async () => new Response('ok'));
    const guarded = createGuardedFetch(() => 'API.GitHub.com', base as unknown as typeof fetch);
    await guarded(new URL('https://api.github.com/user'));
    await guarded(new Request('https://api.github.com/user'));
    expect(base).toHaveBeenCalledTimes(2);
  });

  it('re-checks the allowed host on every call, not just the first', async () => {
    const base = vi.fn(async () => new Response('ok'));
    let allowed: string | undefined = 'api.github.com';
    const guarded = createGuardedFetch(() => allowed, base as unknown as typeof fetch);
    await guarded('https://api.github.com/user');
    allowed = 'git.example.com/api/v3'.split('/')[0];
    await expect(guarded('https://api.github.com/user')).rejects.toThrow(DisallowedHostError);
  });
});
