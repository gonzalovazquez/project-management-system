import type { RepoRole } from '../../shared/ipc.js';

export type Route =
  | { view: 'products' }
  | { view: 'product'; id: string }
  | { view: 'browse'; role: RepoRole }
  | { view: 'settings' };

export const DEFAULT_ROUTE: Route = { view: 'products' };

export const sameRoute = (a: Route, b: Route): boolean => {
  if (a.view !== b.view) return false;
  if (a.view === 'browse' && b.view === 'browse') return a.role === b.role;
  if (a.view === 'product' && b.view === 'product') return a.id === b.id;
  return true;
};
