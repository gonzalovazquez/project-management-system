import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/main/products/db.js';
import { ProductStore } from '../src/main/products/store.js';
import {
  dailyBuckets, DEFAULT_METRIC_SETTINGS as S, flags, health, MAX_POINTS, productActivity, productPulse, stageCounts, stageDays, weeklyBuckets,
} from '../src/shared/metrics.js';
import { computePulse } from '../src/shared/pulse.js';
import type { ActivityEvent, ItemState, Link } from '../src/shared/products.js';

const NOW = new Date(2026, 10, 14, 12, 0); // local noon, 14 Nov 2026
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
let n = 0;
const link = (over: Partial<Link> = {}): Link => ({
  id: `l${++n}`, productId: 'p', role: 'artifacts', kind: 'artifact', repoHost: 'github.com', repoFullName: 'o/a', path: `f${n}.md`,
  title: `Item ${n}`, health: { state: 'ok', checkedAt: '' }, createdAt: '', ...over,
});
const ev = (id: string, ago: number): ActivityEvent => ({ id, at: daysAgo(ago), type: 'commit' });
const fileWith = (events: ActivityEvent[]): ItemState => ({ kind: 'file', exists: true, sha: 'x', activity: events });

describe('activity', () => {
  it('counts a commit seen through two linked files once', () => {
    const a = link(); const b = link();
    const states = { [a.id]: fileWith([ev('commit:1', 1), ev('commit:2', 3)]), [b.id]: fileWith([ev('commit:1', 1)]) };
    expect(productActivity([a, b], states).map((e) => e.id).sort()).toEqual(['commit:1', 'commit:2']);
  });

  it('buckets by local day over 84 days and by week, oldest first', () => {
    const d = dailyBuckets([ev('a', 0), ev('b', 0), ev('c', 6), ev('d', 7), ev('e', 83), ev('f', 84), { at: 'nope' }], NOW);
    expect(d).toHaveLength(84);
    expect(d[83]).toBe(2);
    expect(d[77]).toBe(1);
    expect(d[0]).toBe(1);
    const w = weeklyBuckets(d);
    expect(w).toHaveLength(12);
    expect(w[11]).toBe(3);   // days 0..6 ago
    expect(w[10]).toBe(1);   // 7 ago
    expect(w.reduce((a, b) => a + b)).toBe(5);
  });

  it('feeds the inherited pulse unchanged', () => {
    const events = [ev('a', 1), ev('b', 2), ev('c', 3), ev('d', 4), ev('e', 5)];
    const p = productPulse(events, NOW);
    expect(p).toEqual(computePulse(weeklyBuckets(dailyBuckets(events, NOW)), false, new Date(daysAgo(1)), NOW));
    expect(p.level).toBe('Warm'); // 5 events this week score 3.9, just under Hot's 4
    expect(productPulse([], NOW)).toEqual({ score: 0, level: 'Dormant', lastActivityDays: null });
  });
});

describe('stall flags', () => {
  it('flags items past their stage threshold, quiet items, empty upstream stages and broken links', () => {
    const over = link({ title: 'Old brief', stage: 'problem', stageEnteredAt: daysAgo(30) });
    const fresh = link({ title: 'Fresh spec', stage: 'specification', stageEnteredAt: daysAgo(3) });
    const quiet = link({ title: 'Quiet spec', stage: 'specification', stageEnteredAt: daysAgo(3) });
    const shipped = link({ title: 'Shipped', stage: 'release', stageEnteredAt: daysAgo(5) });
    const broken = link({ title: 'Gone', health: { state: 'broken', checkedAt: '', reason: 'x' } });
    const states = { [quiet.id]: fileWith([ev('q', 40)]), [shipped.id]: fileWith([ev('s', 60)]), [fresh.id]: fileWith([ev('f', 2)]) };
    const f = flags([over, fresh, quiet, shipped, broken], states, S, NOW);
    expect(f.map((x) => [x.code, x.linkId ?? null])).toEqual([
      ['over-threshold', over.id], ['quiet', quiet.id], ['broken', broken.id],
      ['empty-stage', null], ['empty-stage', null],
    ]);
    expect(f.find((x) => x.code === 'over-threshold')?.text).toBe('Old brief: 30 days in Problem brief (review at 21)');
    expect(f.filter((x) => x.code === 'empty-stage').map((x) => x.text)).toEqual([
      'Nothing in Intake and triage, but 1 in Problem brief, 2 in Specification, 1 in Release and feedback',
      'Nothing in Solution, but 2 in Specification, 1 in Release and feedback',
    ]);
  });

  it('respects custom thresholds and says nothing about an empty product', () => {
    const l = link({ stage: 'intake', stageEnteredAt: daysAgo(5) });
    expect(flags([l], {}, { ...S, stageThresholds: { ...S.stageThresholds, intake: 3 } }, NOW).map((x) => x.code)).toEqual(['over-threshold']);
    expect(flags([], {}, S, NOW)).toEqual([]);
    expect(stageDays({ stageEnteredAt: undefined }, NOW)).toBe(0);
  });
});

describe('health', () => {
  it('shows its parts, reweighted to 100%, and drops freshness when nothing is placed', () => {
    const pulse = { score: 2, level: 'Warm' as const, lastActivityDays: 1 };
    const placed = [link({ stage: 'problem', stageEnteredAt: daysAgo(10) }), link({ stage: 'problem', stageEnteredAt: daysAgo(42) })];
    const h = health(placed, pulse, [{ code: 'quiet', text: '' }], S, NOW);
    expect(h.parts.map((p) => [p.label, Math.round(p.value), p.weight])).toEqual([['Momentum', 50, 0.4], ['Freshness', 50, 0.3], ['Hygiene', 80, 0.3]]);
    expect(h.score).toBe(Math.round(50 * 0.4 + 50 * 0.3 + 80 * 0.3)); // within threshold = 1, twice the threshold = 0
    expect(h.level).toBe('Fair');
    const none = health([link()], pulse, [], S, NOW);
    expect(none.parts.map((p) => p.label)).toEqual(['Momentum', 'Hygiene']);
    expect(none.parts.reduce((a, p) => a + p.weight, 0)).toBeCloseTo(1);
    expect(none.score).toBe(Math.round(50 * 0.4 / 0.7 + 100 * 0.3 / 0.7));
  });
});

describe('daily stage snapshots', () => {
  it('records one point per product per local day, replaced on the same day, capped', () => {
    let clock = new Date(2026, 10, 1, 9);
    const s = new ProductStore(openDatabase(':memory:'), () => clock);
    const p = s.createProduct({ name: 'P', objective: '', kpis: [] });
    s.addLinks(p.id, [{ role: 'artifacts', kind: 'artifact', repoHost: 'h', repoFullName: 'o/a', path: 'a.md', title: 'A', stage: 'intake' }]);
    s.snapshot(p.id);
    const [l] = s.links(p.id);
    clock = new Date(2026, 10, 1, 17);
    s.moveLink(l.id, 'problem');
    expect(s.history(p.id)).toEqual([{ date: '2026-11-01', counts: { ...stageCounts([]), problem: 1 } }]);
    clock = new Date(2026, 10, 2, 9);
    s.snapshot(p.id);
    expect(s.history(p.id).map((x) => x.date)).toEqual(['2026-11-01', '2026-11-02']);
    for (let i = 0; i < MAX_POINTS + 5; i++) { clock = new Date(2026, 10, 3 + i, 9); s.snapshot(p.id); }
    const h = s.history(p.id);
    expect(h).toHaveLength(MAX_POINTS);
    expect(h[0].date > '2026-11-02').toBe(true);
  });
});
