import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { CHANNELS, fail } from '../../shared/ipc.js';
import type { AppService } from './service.js';

export interface IpcDeps {
  /** Only the app's own page may call these handlers; see src/main/app/trust.ts. */
  isTrusted(e: IpcMainInvokeEvent): boolean;
  log(message: string, err: unknown): void;
}

/** Wraps every handler so an untrusted sender gets a clean error instead of running the call. */
export function registerIpc(ipc: IpcMain, service: AppService, deps: IpcDeps): void {
  const handle = <A extends unknown[]>(channel: string, fn: (...args: A) => unknown) => {
    ipc.handle(channel, (e, ...args: A) => {
      if (!deps.isTrusted(e)) {
        deps.log(`Rejected an IPC call from an untrusted sender on ${channel}`, undefined);
        return fail('invalid', 'Rejected.');
      }
      try {
        return fn(...args);
      } catch (err) {
        deps.log(`${channel} failed`, err);
        throw err;
      }
    });
  };

  handle(CHANNELS.getAuth, () => service.getAuth());
  handle(CHANNELS.signIn, (host: string, token: string) => service.signIn(host, token));
  handle(CHANNELS.signOut, () => service.signOut());
  handle(CHANNELS.listAvailableRepos, () => service.listAvailableRepos());
  handle(CHANNELS.getSettings, () => service.getSettings());
  handle(CHANNELS.saveSettings, (patch: Parameters<AppService['saveSettings']>[0]) => service.saveSettings(patch));
  handle(CHANNELS.browseTree, (role: Parameters<AppService['browseTree']>[0], path: string) => service.browseTree(role, path));
  handle(CHANNELS.readFile, (role: Parameters<AppService['readFile']>[0], path: string) => service.readFile(role, path));
}
