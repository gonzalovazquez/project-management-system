// Reserved for Phase 3b per ADR 001: history.ts and this test cover the pure stage-history
// functions only. The old "recording history from scans" suite drove the deleted
// DashboardService (Notion + local scanning) through a fake harness; that integration doesn't
// exist in PM Workbench, and is Phase 3b's to rebuild against the new product model.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StagePoint } from '../src/shared/types.js';
import { createHistoryStore, localDate, stageCounts, upsertPoint } from '../src/main/app/history.js';
import { project, tmp } from './helpers.js';

const pt = (date: string, beta = 1): StagePoint => ({ date, counts: { 'Not started': 0, 'In progress': 1, Beta: beta, 'General Available': 0 } });

describe('stage history', () => {
  it('formats the local calendar date', () => {
    expect(localDate(new Date(2026, 9, 5, 23, 59))).toBe('2026-10-05');
    expect(localDate(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01');
  });
  it('counts active tracked projects per stage and ignores the rest', () => {
    const ps = [
      project({ name: 'a' }, { stage: 'Beta' }), project({ name: 'b' }, { stage: 'Beta' }), project({ name: 'c' }, { stage: 'In progress' }),
      project({ name: 'parked' }, { stage: 'Beta', life: 'parked' }), project({ name: 'killed' }, { stage: 'Beta', life: 'killed' }), project({ name: 'untracked' }),
      project({ name: 'shipped' }, { stage: 'General Available' }),
    ];
    expect(stageCounts(ps)).toEqual({ 'Not started': 0, 'In progress': 1, Beta: 2, 'General Available': 1 });
  });
  it('replaces the point for the same day, sorts, and caps the length', () => {
    expect(upsertPoint([pt('2026-10-02'), pt('2026-10-01')], pt('2026-10-03')).map((p) => p.date)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    const replaced = upsertPoint([pt('2026-10-01', 1)], pt('2026-10-01', 5));
    expect(replaced).toHaveLength(1);
    expect(replaced[0].counts.Beta).toBe(5);
    const many = Array.from({ length: 10 }, (_, i) => pt(`2026-10-${String(i + 1).padStart(2, '0')}`));
    expect(upsertPoint(many, pt('2026-10-20'), 5).map((p) => p.date)).toEqual(['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-20']);
  });
  it('persists points, one per day', async () => {
    const path = join(tmp(), 'h.json');
    const store = createHistoryStore(path);
    expect(await store.load()).toEqual([]);
    await store.record(pt('2026-10-01'));
    await store.record(pt('2026-10-02'));
    await store.record(pt('2026-10-02', 4));
    const back = await createHistoryStore(path).load();
    expect(back.map((p) => p.date)).toEqual(['2026-10-01', '2026-10-02']);
    expect(back[1].counts.Beta).toBe(4);
  });
  it('drops malformed entries and survives a corrupt file', async () => {
    const path = join(tmp(), 'h.json');
    await writeFile(path, JSON.stringify([pt('2026-10-01'), { date: 'x', counts: {} }, { date: '2026-10-02', counts: { Beta: 'two' } }, null, 5]));
    expect((await createHistoryStore(path).load()).map((p) => p.date)).toEqual(['2026-10-01']);
    await writeFile(path, '{oops');
    expect(await createHistoryStore(path).load()).toEqual([]);
    await writeFile(path, '"nope"');
    expect(await createHistoryStore(path).load()).toEqual([]);
  });
});
