import {
  ARTIFACT_TYPE_LABEL, PULL_STATUS_LABEL, STAGES, suggestStage,
  type ArtifactType, type ItemState, type Link, type ProductHome, type SyncStatus, type WorkflowStage,
} from '../../../shared/products.js';

/**
 * The workflow board as data: every linked item lands in exactly one of the five stage columns or
 * the unstaged tray (or is hidden by a filter), with the label, state and tone its card shows.
 * Pure so the board's placement and wording can be tested without rendering.
 */

export type TypeFilter = 'all' | ArtifactType | 'customers' | 'decisions';
export interface BoardFilters { type: TypeFilter; /** A CRM file path, or 'all'. */ customer: string }
export const NO_FILTERS: BoardFilters = { type: 'all', customer: 'all' };

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral' | 'done';

export interface Card {
  link: Link;
  kindLabel: string;
  stateLabel: string;
  tone: Tone;
  /** Last change on GitHub (file commit or PR update), ISO. */
  updatedAt?: string;
  detail?: string;
  suggested?: WorkflowStage;
}

export interface Board {
  columns: Record<WorkflowStage, Card[]>;
  unstaged: Card[];
  total: number;
  shown: number;
  /** CRM customers present on the board, for the customer filter. */
  customers: { path: string; label: string }[];
  /** Artifact types present, for the type filter. */
  types: ArtifactType[];
}

export function kindLabel(l: Link): string {
  if (l.kind === 'artifact') return ARTIFACT_TYPE_LABEL[l.artifactType ?? 'other'];
  if (l.kind === 'customer') return 'Customer';
  if (l.kind === 'conversation') return 'Conversation';
  return l.prNumber !== undefined ? 'Decision · pull request' : 'Decision record';
}

export function cardFor(l: Link, s: ItemState | undefined, now: Date): Card {
  const base = { link: l, kindLabel: kindLabel(l), suggested: suggestStage(l) };
  if (l.health.state === 'broken') return { ...base, stateLabel: 'Broken link', tone: 'bad', detail: l.health.reason };
  if (!s) return { ...base, stateLabel: 'Not synced yet', tone: 'neutral' };
  if (s.kind === 'pending') {
    const tone: Tone = s.status === 'approved' ? 'ok' : s.status === 'changes-requested' ? 'warn' : 'neutral';
    return { ...base, stateLabel: `Pending · PR #${s.prNumber} ${PULL_STATUS_LABEL[s.status].toLowerCase()}`, tone, updatedAt: s.updatedAt, detail: 'Not on the default branch until the pull request merges' };
  }
  if (s.kind === 'file') {
    if (!s.exists) return { ...base, stateLabel: 'Not on default branch', tone: 'bad' };
    return {
      ...base, stateLabel: 'On default branch', tone: 'ok', updatedAt: s.lastChangedAt,
      detail: s.lastChangedAt ? `Changed ${ago(s.lastChangedAt, now)}${s.lastChangedBy ? ` by ${s.lastChangedBy}` : ''}` : undefined,
    };
  }
  const tone: Tone = s.status === 'merged' ? 'done' : s.status === 'approved' ? 'ok' : s.status === 'changes-requested' ? 'warn' : s.status === 'closed' ? 'bad' : 'neutral';
  const waiting = s.reviewers.filter((r) => r.state === 'requested').map((r) => r.login);
  const decided = s.reviewers.filter((r) => r.state === 'approved' || r.state === 'changes-requested').map((r) => `${r.login} ${r.state === 'approved' ? '✓' : '✗'}`);
  const detail = [decided.join(', '), waiting.length ? `waiting on ${waiting.join(', ')}` : ''].filter(Boolean).join(' · ');
  return { ...base, stateLabel: PULL_STATUS_LABEL[s.status], tone, updatedAt: s.updatedAt, detail: detail || undefined };
}

function matches(l: Link, f: BoardFilters): boolean {
  if (f.customer !== 'all' && !((l.kind === 'customer' || l.kind === 'conversation') && l.path === f.customer)) return false;
  if (f.type === 'all') return true;
  if (f.type === 'customers') return l.kind === 'customer' || l.kind === 'conversation';
  if (f.type === 'decisions') return l.kind === 'decision';
  return l.kind === 'artifact' && (l.artifactType ?? 'other') === f.type;
}

export function buildBoard(home: Pick<ProductHome, 'links' | 'states'>, filters: BoardFilters, now: Date): Board {
  const columns = Object.fromEntries(STAGES.map((s) => [s, [] as Card[]])) as Record<WorkflowStage, Card[]>;
  const unstaged: Card[] = [];
  let shown = 0;
  for (const l of home.links) {
    if (!matches(l, filters)) continue;
    shown++;
    const card = cardFor(l, home.states[l.id], now);
    if (l.stage) columns[l.stage].push(card); else unstaged.push(card);
  }
  // Longest in its stage first, so what's been sitting there longest is at the top.
  for (const s of STAGES) columns[s].sort((a, b) => (a.link.stageEnteredAt ?? '').localeCompare(b.link.stageEnteredAt ?? '') || a.link.title.localeCompare(b.link.title));
  unstaged.sort((a, b) => a.link.title.localeCompare(b.link.title));

  const customers = new Map<string, string>();
  for (const l of home.links) {
    if ((l.kind === 'customer' || l.kind === 'conversation') && l.path) {
      if (l.kind === 'customer' || !customers.has(l.path)) customers.set(l.path, l.kind === 'customer' ? l.title : l.path.split('/').pop()!);
    }
  }
  const types = [...new Set(home.links.filter((l) => l.kind === 'artifact').map((l) => l.artifactType ?? 'other'))];
  return {
    columns, unstaged, total: home.links.length, shown,
    customers: [...customers.entries()].map(([path, label]) => ({ path, label })).sort((a, b) => a.label.localeCompare(b.label)),
    types,
  };
}

/** "3 min ago", "2 h ago", "5 days ago", or a date past a month. */
export function ago(iso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 31) return `${d} day${d === 1 ? '' : 's'} ago`;
  return `on ${iso.slice(0, 10)}`;
}

/** The one line the board shows about data freshness. */
export function syncLine(s: SyncStatus, syncing: boolean, now: Date): { text: string; tone: Tone } {
  if (syncing) return { text: 'Syncing with GitHub…', tone: 'neutral' };
  if (s.lastError) {
    const age = s.lastSuccessAt ? `showing data from ${ago(s.lastSuccessAt, now)}` : 'nothing synced yet';
    return { text: `${s.lastError} — ${age}.`, tone: 'warn' };
  }
  if (!s.lastSuccessAt) return { text: 'Not synced yet.', tone: 'neutral' };
  return { text: `Synced ${ago(s.lastSuccessAt, now)}.`, tone: 'ok' };
}
