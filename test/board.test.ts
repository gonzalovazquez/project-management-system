import { describe, expect, it } from 'vitest';
import { STAGES, type ItemState, type Link } from '../src/shared/products.js';
import { ago, buildBoard, cardFor, NO_FILTERS, syncLine } from '../src/renderer/src/viewmodel/board.js';

const NOW = new Date('2026-11-14T12:00:00Z');
let n = 0;
const link = (over: Partial<Link>): Link => ({
  id: `l${++n}`, productId: 'p', role: 'artifacts', kind: 'artifact', repoHost: 'github.com', repoFullName: 'o/a', path: `f${n}.md`,
  title: `Item ${n}`, health: { state: 'ok', checkedAt: '' }, createdAt: '', ...over,
});

const links: Link[] = [
  link({ title: 'Problem brief', artifactType: 'problem-brief', stage: 'problem', stageEnteredAt: '2026-11-01T00:00:00Z' }),
  link({ title: 'Older problem', artifactType: 'problem-brief', stage: 'problem', stageEnteredAt: '2026-10-01T00:00:00Z' }),
  link({ title: 'Control book', artifactType: 'control-book' }),
  link({ title: 'Acme', role: 'crm', kind: 'customer', path: 'customers/acme.md', stage: 'intake' }),
  link({ title: 'Acme call', role: 'crm', kind: 'conversation', path: 'customers/acme.md', anchor: 'call', stage: 'intake' }),
  link({ title: 'Globex call', role: 'crm', kind: 'conversation', path: 'customers/globex.md', anchor: 'qbr' }),
  link({ title: 'SPEC PR', role: 'pdr', kind: 'decision', path: undefined, prNumber: 3, stage: 'specification' }),
  link({ title: 'Release notes', artifactType: 'exec-comm', stage: 'release' }),
];

describe('workflow board', () => {
  it('puts every linked item in exactly one column or the unstaged tray', () => {
    const b = buildBoard({ links, states: {} }, NO_FILTERS, NOW);
    const placed = [...STAGES.flatMap((s) => b.columns[s]), ...b.unstaged].map((c) => c.link.id);
    expect(placed.sort()).toEqual(links.map((l) => l.id).sort());
    expect(new Set(placed).size).toBe(placed.length);
    expect(b.unstaged.map((c) => c.link.title)).toEqual(['Control book', 'Globex call']);
    expect(b.columns.problem.map((c) => c.link.title)).toEqual(['Older problem', 'Problem brief']);
    expect(b.columns.solution).toEqual([]);
    expect(b).toMatchObject({ total: 8, shown: 8 });
  });

  it('filters by artifact type, by kind, and by customer', () => {
    const only = (f: Parameters<typeof buildBoard>[1]) => {
      const b = buildBoard({ links, states: {} }, f, NOW);
      return [...STAGES.flatMap((s) => b.columns[s]), ...b.unstaged].map((c) => c.link.title).sort();
    };
    expect(only({ type: 'problem-brief', customer: 'all' })).toEqual(['Older problem', 'Problem brief']);
    expect(only({ type: 'decisions', customer: 'all' })).toEqual(['SPEC PR']);
    expect(only({ type: 'all', customer: 'customers/acme.md' })).toEqual(['Acme', 'Acme call']);
    expect(only({ type: 'problem-brief', customer: 'customers/acme.md' })).toEqual([]);
    const b = buildBoard({ links, states: {} }, NO_FILTERS, NOW);
    expect(b.customers).toEqual([{ path: 'customers/acme.md', label: 'Acme' }, { path: 'customers/globex.md', label: 'globex.md' }]);
    expect(b.types.sort()).toEqual(['control-book', 'exec-comm', 'problem-brief']);
  });

  it('describes each card’s GitHub state', () => {
    const file = links[0];
    const pr = links[6];
    const st = (s: ItemState) => s;
    expect(cardFor(file, undefined, NOW)).toMatchObject({ stateLabel: 'Not synced yet', tone: 'neutral', suggested: 'problem' });
    expect(cardFor(file, st({ kind: 'file', exists: true, sha: 'x', lastChangedAt: '2026-11-12T12:00:00Z', lastChangedBy: 'dana' }), NOW))
      .toMatchObject({ stateLabel: 'On default branch', tone: 'ok', detail: 'Changed 2 days ago by dana' });
    expect(cardFor(file, st({ kind: 'file', exists: false }), NOW)).toMatchObject({ tone: 'bad' });
    expect(cardFor({ ...file, health: { state: 'broken', checkedAt: '', reason: 'gone' } }, undefined, NOW)).toMatchObject({ stateLabel: 'Broken link', detail: 'gone' });
    expect(cardFor(pr, st({ kind: 'pull', status: 'changes-requested', title: 't', updatedAt: '', reviewers: [{ login: 'eng', state: 'changes-requested' }, { login: 'design', state: 'requested' }] }), NOW))
      .toMatchObject({ stateLabel: 'Changes requested', tone: 'warn', detail: 'eng ✗ · waiting on design', kindLabel: 'Decision · pull request' });
    expect(cardFor(pr, st({ kind: 'pull', status: 'merged', title: 't', updatedAt: '', reviewers: [] }), NOW)).toMatchObject({ tone: 'done' });
  });

  it('says how fresh the data is', () => {
    expect(syncLine({}, false, NOW).text).toBe('Not synced yet.');
    expect(syncLine({ lastSuccessAt: '2026-11-14T11:57:00Z' }, false, NOW)).toEqual({ text: 'Synced 3 min ago.', tone: 'ok' });
    expect(syncLine({ lastSuccessAt: '2026-11-14T10:00:00Z', lastError: "Couldn't reach GitHub" }, false, NOW))
      .toEqual({ text: "Couldn't reach GitHub — showing data from 2 h ago.", tone: 'warn' });
    expect(ago('2026-09-01T00:00:00Z', NOW)).toBe('on 2026-09-01');
  });
});
