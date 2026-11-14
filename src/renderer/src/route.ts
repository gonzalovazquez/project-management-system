import type { RepoRole } from '../../shared/ipc.js';

export type Route =
  | { view: 'browse'; role: RepoRole }
  | { view: 'settings' };

export const DEFAULT_ROUTE: Route = { view: 'browse', role: 'artifacts' };

export const sameRoute = (a: Route, b: Route): boolean =>
  a.view === b.view && (a.view !== 'browse' || (b.view === 'browse' && a.role === b.role));
