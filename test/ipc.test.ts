import { describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { CHANNELS } from '../src/shared/ipc.js';
import { registerIpc } from '../src/main/app/ipc.js';
import type { AppService } from '../src/main/app/service.js';

/** A minimal fake of Electron's ipcMain: just enough to register and invoke handlers in a test. */
function fakeIpcMain(): { ipc: IpcMain; invoke: (channel: string, e: Partial<IpcMainInvokeEvent>, ...args: unknown[]) => unknown } {
  const handlers = new Map<string, (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const ipc = { handle: (channel: string, fn: (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => handlers.set(channel, fn) } as unknown as IpcMain;
  return { ipc, invoke: (channel, e, ...args) => handlers.get(channel)!(e as IpcMainInvokeEvent, ...args) };
}

describe('registerIpc', () => {
  it('rejects a call from an untrusted sender without reaching the service', async () => {
    const { ipc, invoke } = fakeIpcMain();
    const getAuth = vi.fn();
    const service = { getAuth } as unknown as AppService;
    const log = vi.fn();
    registerIpc(ipc, service, { isTrusted: () => false, log });
    const result = await invoke(CHANNELS.getAuth, {});
    expect(getAuth).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: 'invalid', message: 'Rejected.' });
    expect(log).toHaveBeenCalledOnce();
  });

  it('delegates to the service for a trusted sender', async () => {
    const { ipc, invoke } = fakeIpcMain();
    const getAuth = vi.fn(() => ({ status: 'signed-out' }));
    const service = { getAuth } as unknown as AppService;
    registerIpc(ipc, service, { isTrusted: () => true, log: vi.fn() });
    const result = await invoke(CHANNELS.getAuth, {});
    expect(getAuth).toHaveBeenCalledOnce();
    expect(result).toEqual({ status: 'signed-out' });
  });

  it('passes arguments through for a multi-argument channel', async () => {
    const { ipc, invoke } = fakeIpcMain();
    const signIn = vi.fn((host: string, token: string) => ({ ok: true, value: { status: 'signed-in', host, login: 'gonzo', tokenSource: 'keychain' } }));
    const service = { signIn } as unknown as AppService;
    registerIpc(ipc, service, { isTrusted: () => true, log: vi.fn() });
    await invoke(CHANNELS.signIn, {}, 'github.com', 'ghp_x');
    expect(signIn).toHaveBeenCalledWith('github.com', 'ghp_x');
  });

  it('logs and rethrows when a handler throws, instead of swallowing it', async () => {
    const { ipc, invoke } = fakeIpcMain();
    const getAuth = vi.fn(() => { throw new Error('boom'); });
    const service = { getAuth } as unknown as AppService;
    const log = vi.fn();
    registerIpc(ipc, service, { isTrusted: () => true, log });
    expect(() => invoke(CHANNELS.getAuth, {})).toThrow('boom');
    expect(log).toHaveBeenCalledWith(expect.stringContaining(CHANNELS.getAuth), expect.any(Error));
  });
});
