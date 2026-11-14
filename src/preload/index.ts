import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type PMWorkbenchApi } from '../shared/ipc.js';

/**
 * The only thing the renderer can reach. Each method forwards to one fixed channel; ipcRenderer
 * itself is never exposed, and there is no network access here — every GitHub call happens in
 * the main process, behind the allow-list in src/main/index.ts.
 */
const api: PMWorkbenchApi = {
  getAuth: () => ipcRenderer.invoke(CHANNELS.getAuth),
  signIn: (host, token) => ipcRenderer.invoke(CHANNELS.signIn, host, token),
  signOut: () => ipcRenderer.invoke(CHANNELS.signOut),
  listAvailableRepos: () => ipcRenderer.invoke(CHANNELS.listAvailableRepos),
  getSettings: () => ipcRenderer.invoke(CHANNELS.getSettings),
  saveSettings: (patch) => ipcRenderer.invoke(CHANNELS.saveSettings, patch),
  browseTree: (role, path) => ipcRenderer.invoke(CHANNELS.browseTree, role, path),
  readFile: (role, path) => ipcRenderer.invoke(CHANNELS.readFile, role, path),
};

contextBridge.exposeInMainWorld('pmworkbench', api);
