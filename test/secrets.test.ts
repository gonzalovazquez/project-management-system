import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { SecureStorageUnavailable, TokenStore, type SecretBox } from '../src/main/app/secrets.js';
import { tmp } from './helpers.js';

/** A fake safeStorage: "encryption" is reversible but not plaintext, so a bug that skips it is visible. */
function fakeBox(available = true): SecretBox {
  return {
    isAvailable: () => available,
    encrypt: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
    decrypt: (data) => data.toString('utf8').replace(/^enc:/, ''),
  };
}

describe('TokenStore', () => {
  it('prefers GITHUB_TOKEN from the environment, and never touches the keychain for it', async () => {
    const path = join(tmp(), 'token.bin');
    const store = new TokenStore(path, fakeBox(), { GITHUB_TOKEN: ' ghp_env_token ' });
    expect(await store.get()).toEqual({ token: 'ghp_env_token', source: 'env' });
  });

  it('falls back to the keychain when there is no env var', async () => {
    const path = join(tmp(), 'token.bin');
    const store = new TokenStore(path, fakeBox(), {});
    expect(await store.get()).toEqual({ source: 'none' });
    await store.set('ghp_keychain_token');
    expect(await store.get()).toEqual({ token: 'ghp_keychain_token', source: 'keychain' });
  });

  it('writes the token encrypted, never in plain text', async () => {
    const path = join(tmp(), 'token.bin');
    const store = new TokenStore(path, fakeBox(), {});
    await store.set('ghp_super_secret');
    const raw = await readFile(path, 'utf8');
    // The fake box's "encryption" is reversible but distinct from the plaintext, so a bug that
    // skips calling box.encrypt() (and writes the plain token straight to disk) is still caught.
    expect(raw).not.toBe('ghp_super_secret');
    expect(raw).toBe('enc:ghp_super_secret');
  });

  it('clearing the token removes the file', async () => {
    const path = join(tmp(), 'token.bin');
    const store = new TokenStore(path, fakeBox(), {});
    await store.set('ghp_x');
    await store.set(null);
    expect(await store.get()).toEqual({ source: 'none' });
  });

  it('refuses to save when secure storage is unavailable, instead of writing plaintext', async () => {
    const path = join(tmp(), 'token.bin');
    const store = new TokenStore(path, fakeBox(false), {});
    await expect(store.set('ghp_x')).rejects.toBeInstanceOf(SecureStorageUnavailable);
  });

  it('a corrupt or undecryptable file is treated as no token, not an error', async () => {
    const path = join(tmp(), 'token.bin');
    const store = new TokenStore(path, fakeBox(), {});
    await store.set('ghp_x');
    const broken: SecretBox = { ...fakeBox(), decrypt: () => { throw new Error('bad ciphertext'); } };
    const reread = new TokenStore(path, broken, {});
    expect(await reread.get()).toEqual({ source: 'none' });
  });
});
