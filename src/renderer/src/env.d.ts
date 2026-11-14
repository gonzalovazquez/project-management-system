/// <reference types="vite/client" />
import type { PMWorkbenchApi } from '../../shared/ipc.js';

declare global {
  interface Window {
    /** Exposed by src/preload/index.ts. The only way the interface reaches the main process. */
    pmworkbench: PMWorkbenchApi;
  }
}
