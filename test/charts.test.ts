import { describe, expect, it } from 'vitest';
import { DEFAULT_METRIC_SETTINGS as S, stageCounts, type StagePoint } from '../src/shared/metrics.js';
import type { Link, ProductHome } from '../src/shared/products.js';
import { activitySeries, ageBars, heatModel, metricsModel, niceTicks, stageColumns } from '../src/renderer/src/viewmodel/charts.js';

const NOW = new Date(2026, 10, 14, 12, 0);
const ago = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
let n = 0;
const link = (over: Partial<Link> = {}): Link => ({
  id: `l${++n}`, productId: 'p', role: 'artifacts', kind: 'artifact', repoHost: 'github.com', repoFullName: 'o/a', path: `f${n}.md`,
  title: `Item ${n}`, health: { state: 'ok', checkedAt: '' }, createdAt: '', ...over,
});
const home = (links: Link[], states: ProductHome['states'] = {}, history: StagePoint[] = []): ProductHome => ({
  product: { id: 'p', name: 'P', objective: 'o', kpis: [], createdAt: '', updatedAt: '' }, links, states, sync: {}, history,
});
const point = (date: string, over: Partial<StagePoint['counts']>): StagePoint => ({ date, counts: { ...stageCounts([]), ...over } });

describe('flow metric charts', () => {
  it('ticks are whole numbers from zero', () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(23)).toEqual([0, 5, 10, 15, 20, 25]);
  });

  it('stacks activity per week by repo, counting a shared commit once', () => {
    const a = link(); const c = link({ role: 'crm', kind: 'customer' }); const p = link({ role: 'pdr', kind: 'decision', path: undefined, prNumber: 1 });
    const m = activitySeries(home([a, c, p], {
      [a.id]: { kind: 'file', exists: true, sha: 'x', activity: [{ id: 'commit:1', at: ago(1), type: 'commit' }, { id: 'commit:2', at: ago(8), type: 'commit' }] },
      [c.id]: { kind: 'file', exists: true, sha: 'y', activity: [{ id: 'commit:1', at: ago(1), type: 'commit' }, { id: 'commit:3', at: ago(2), type: 'commit' }] },
      [p.id]: { kind: 'pull', status: 'open', title: '', updatedAt: '', reviewers: [], activity: [{ id: 'pr:1:opened', at: ago(3), type: 'opened' }] },
    }), NOW);
    expect(m.series.map((s) => [s.id, s.values.slice(-2)])).toEqual([['artifacts', [1, 1]], ['crm', [0, 1]], ['pdr', [0, 1]]]);
    expect(m.total).toBe(4);
    expect(m.weeks).toHaveLength(12);
  });

  it('draws one column per recorded week across five stages, and says when history is short', () => {
    const sparse = stageColumns([point('2026-11-13', { intake: 2, specification: 1 })], NOW);
    expect(sparse.columns).toHaveLength(1);
    expect(sparse.columns[0]).toMatchObject({ slot: 11, total: 3 });
    expect(sparse).toMatchObject({ sparse: true, startedOn: '2026-11-13' });
    const full = stageColumns(Array.from({ length: 60 }, (_, i) => point(`2026-${i < 30 ? '09' : '10'}-${String((i % 30) + 1).padStart(2, '0')}`, { problem: 1, release: i % 3 })), new Date(2026, 9, 31, 12));
    expect(full.sparse).toBe(false);
    expect(full.columns.length).toBeGreaterThanOrEqual(8);
    expect(stageColumns([], NOW).columns).toEqual([]);
  });

  it('time in stage covers placed items only, longest first, with their stage review point', () => {
    const bars = ageBars(home([
      link({ title: 'A', stage: 'intake', stageEnteredAt: ago(20) }),
      link({ title: 'B', stage: 'solution', stageEnteredAt: ago(5) }),
      link({ title: 'Unplaced' }),
    ]), S, NOW);
    expect(bars.map((b) => [b.title, b.days, b.threshold, b.over])).toEqual([['A', 20, 14, true], ['B', 5, 30, false]]);
  });

  it('lays twelve weeks of days out as a heatmap ending today', () => {
    const daily = new Array(84).fill(0);
    daily[83] = 3; daily[0] = 1;
    const h = heatModel(daily, NOW);
    expect(h.cells).toHaveLength(84);
    expect(h.cells[83]).toMatchObject({ col: 11, row: 6, level: 3 });
    expect(h.cells[0]).toMatchObject({ col: 0, row: 0, level: 1 });
    expect(h.total).toBe(4);
  });

  it('builds a full metrics model for a product with history, one with sparse history, and one with nothing linked', () => {
    const full = home(
      [link({ stage: 'problem', stageEnteredAt: ago(40) }), link({ stage: 'release', stageEnteredAt: ago(2) })],
      {},
      Array.from({ length: 70 }, (_, i) => point(new Date(NOW.getTime() - (69 - i) * 86_400_000).toISOString().slice(0, 10), { problem: 1, release: i > 60 ? 1 : 0 })),
    );
    const m = metricsModel(full, S, NOW);
    expect(m.stages.sparse).toBe(false);
    expect(m.flags.map((f) => f.code)).toContain('over-threshold');
    expect(m.health.parts.map((p) => p.label)).toEqual(['Momentum', 'Freshness', 'Hygiene']);
    const sparse = metricsModel(home([link({ stage: 'intake', stageEnteredAt: ago(1) })], {}, [point('2026-11-14', { intake: 1 })]), S, NOW);
    expect(sparse.stages.sparse).toBe(true);
    const empty = metricsModel(home([]), S, NOW);
    expect(empty).toMatchObject({ flags: [], ages: [], pulse: { level: 'Dormant' } });
    expect(empty.activity.total).toBe(0);
  });
});
