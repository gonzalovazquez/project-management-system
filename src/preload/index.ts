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
  listPulls: (role) => ipcRenderer.invoke(CHANNELS.listPulls, role),
  readPull: (role, number) => ipcRenderer.invoke(CHANNELS.readPull, role, number),
  listProducts: () => ipcRenderer.invoke(CHANNELS.listProducts),
  getProduct: (id) => ipcRenderer.invoke(CHANNELS.getProduct, id),
  createProduct: (input) => ipcRenderer.invoke(CHANNELS.createProduct, input),
  updateProduct: (id, input) => ipcRenderer.invoke(CHANNELS.updateProduct, id, input),
  deleteProduct: (id) => ipcRenderer.invoke(CHANNELS.deleteProduct, id),
  addLinks: (productId, links) => ipcRenderer.invoke(CHANNELS.addLinks, productId, links),
  updateLink: (linkId, patch) => ipcRenderer.invoke(CHANNELS.updateLink, linkId, patch),
  removeLink: (linkId) => ipcRenderer.invoke(CHANNELS.removeLink, linkId),
  syncProduct: (productId) => ipcRenderer.invoke(CHANNELS.syncProduct, productId),
  moveLink: (linkId, stage) => ipcRenderer.invoke(CHANNELS.moveLink, linkId, stage),
  exportProduct: (id) => ipcRenderer.invoke(CHANNELS.exportProduct, id),
  importProduct: () => ipcRenderer.invoke(CHANNELS.importProduct),
  previewWrite: (draft) => ipcRenderer.invoke(CHANNELS.previewWrite, draft),
  confirmWrite: (id) => ipcRenderer.invoke(CHANNELS.confirmWrite, id),
  editSource: (linkId) => ipcRenderer.invoke(CHANNELS.editSource, linkId),
  openOnGitHub: (url) => ipcRenderer.invoke(CHANNELS.openOnGitHub, url),
  crmLayout: () => ipcRenderer.invoke(CHANNELS.crmLayout),
  pdrLayout: () => ipcRenderer.invoke(CHANNELS.pdrLayout),
  listAppPulls: () => ipcRenderer.invoke(CHANNELS.listAppPulls),
};

contextBridge.exposeInMainWorld('pmworkbench', api);
