import { REPO_ROLES, ROLE_LABEL, type RepoRole } from '../../../shared/ipc.js';
import {
  dailyBuckets, DAY, flags, health, latest, productActivity, productPulse, stageDays, weeklyBuckets, WEEKS,
  type Flag, type Health, type MetricSettings, type Pulse, type StagePoint,
} from '../../../shared/metrics.js';
import { STAGE_LABEL, STAGES, type ActivityEvent, type ProductHome, type WorkflowStage } from '../../../shared/products.js';
import { fmtDate, sum } from './format.js';

/**
 * Chart view models for a product's flow metrics, adapted from Project Dashboard's
 * (ADR 001): the same table shapes the inherited chart components draw, fed by linked items,
 * five stages and GitHub activity. Every chart has a table form for "View as table".
 */

/** Color tokens. The stage ramp and the three repo slots are validated in docs/chart-colors.md. */
export const STAGE_RAMP: Record<WorkflowStage, string> = { intake: 'stage-0', problem: 'stage-1', solution: 'stage-2', specification: 'stage-3', release: 'stage-4' };
export const REPO_TOKEN: Record<RepoRole, string> = { artifacts: 'series-1', crm: 'series-2', pdr: 'series-3' };

export interface TableData { head: string[]; rows: string[][] }
export interface WeekSlot { end: string; label: string }

/**
 * Whole-number tick values from zero, at most five intervals. Counts are never fractional, so the
 * step comes from 1, 2, 5, 10, 20, 50... and the top is the first multiple at or above the maximum.
 */
export function niceTicks(max: number, maxIntervals = 5): number[] {
  const m = Math.max(1, Math.ceil(max));
  let step = 1;
  for (let mag = 1; ; mag *= 10) {
    const hit = [1, 2, 5].map((k) => k * mag).find((s) => Math.ceil(m / s) <= maxIntervals);
    if (hit) { step = hit; break; }
  }
  const top = Math.ceil(m / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return ticks;
}

const weekEnd = (now: Date, weeksAgo: number) => new Date(now.getTime() - weeksAgo * 7 * DAY);
const weekSlots = (now: Date, range = WEEKS): WeekSlot[] =>
  Array.from({ length: range }, (_, j) => { const d = weekEnd(now, range - 1 - j); return { end: d.toISOString(), label: fmtDate(d) }; });

// ---------------------------------------------------------------- activity per week, by repo

export interface Series { id: string; name: string; token: string; values: number[] }
export interface ActivityModel { weeks: WeekSlot[]; series: Series[]; totals: number[]; ticks: number[]; max: number; total: number }

/** Each distinct event is counted once, under the repo of the first linked item it was seen on. */
export function activitySeries(home: Pick<ProductHome, 'links' | 'states'>, now: Date): ActivityModel {
  const byRole = new Map<RepoRole, ActivityEvent[]>(REPO_ROLES.map((r) => [r, []]));
  const seen = new Set<string>();
  for (const l of home.links) {
    const s = home.states[l.id];
    for (const e of s && 'activity' in s ? s.activity ?? [] : []) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      byRole.get(l.role)!.push(e);
    }
  }
  const series = REPO_ROLES.map((r): Series => ({ id: r, name: ROLE_LABEL[r], token: REPO_TOKEN[r], values: weeklyBuckets(dailyBuckets(byRole.get(r)!, now)) }));
  const weeks = weekSlots(now);
  const totals = weeks.map((_, j) => sum(series.map((s) => s.values[j])));
  const max = Math.max(0, ...totals);
  return { weeks, series, totals, ticks: niceTicks(max), max, total: sum(totals) };
}

export function activityTable(m: ActivityModel): TableData {
  return { head: ['Week ending', ...m.series.map((s) => s.name), 'Total'], rows: m.weeks.map((w, j) => [w.label, ...m.series.map((s) => String(s.values[j])), String(m.totals[j])]) };
}

// ---------------------------------------------------------------- items by stage over time

export interface StageColumn { slot: number; date: string; end: string; label: string; counts: Record<WorkflowStage, number>; total: number }
export interface StageModel { slots: WeekSlot[]; columns: StageColumn[]; max: number; ticks: number[]; startedOn?: string; sparse: boolean }

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** One column per week that has a recorded point: the latest point inside that week. Weeks with no record stay empty; nothing is invented. */
export function stageColumns(history: StagePoint[], now: Date, range = WEEKS): StageModel {
  const slots = weekSlots(now, range);
  const columns: StageColumn[] = [];
  slots.forEach((s, slot) => {
    const end = new Date(s.end);
    const hi = ymd(end);
    const lo = ymd(new Date(end.getTime() - 7 * DAY));
    const p = history.filter((x) => x.date <= hi && x.date > lo).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
    if (p) columns.push({ slot, date: p.date, end: s.end, label: s.label, counts: p.counts, total: sum(STAGES.map((st) => p.counts[st])) });
  });
  const max = Math.max(0, ...columns.map((c) => c.total));
  return { slots, columns, max, ticks: niceTicks(max), startedOn: history[0]?.date, sparse: columns.length < 2 };
}

export function stageTable(m: StageModel): TableData {
  return { head: ['Week ending', 'Recorded on', ...STAGES.map((s) => STAGE_LABEL[s])], rows: m.columns.map((c) => [c.label, c.date, ...STAGES.map((s) => String(c.counts[s]))]) };
}

// ---------------------------------------------------------------- time in stage

export interface AgeBar { id: string; title: string; days: number; stage: WorkflowStage; threshold: number; over: boolean }

export function ageBars(home: Pick<ProductHome, 'links'>, s: MetricSettings, now: Date): AgeBar[] {
  return home.links.filter((l) => l.stage).map((l): AgeBar => {
    const days = stageDays(l, now);
    const threshold = s.stageThresholds[l.stage!];
    return { id: l.id, title: l.title, days, stage: l.stage!, threshold, over: days > threshold };
  }).sort((a, b) => b.days - a.days || a.title.localeCompare(b.title));
}

export function ageTable(bars: AgeBar[]): TableData {
  return { head: ['Item', 'Stage', 'Days in stage', 'Review point', 'Status'], rows: bars.map((b) => [b.title, STAGE_LABEL[b.stage], String(b.days), `${b.threshold} days`, b.over ? 'Past review point' : 'Within']) };
}

// ---------------------------------------------------------------- heatmap

export interface HeatCell { col: number; row: number; count: number; level: 0 | 1 | 2 | 3; label: string }
export interface HeatModel { cells: HeatCell[]; rowLabels: string[]; columnLabels: { col: number; label: string }[]; total: number }

/** Twelve columns of seven days, oldest first; the last cell is today. */
export function heatModel(daily: number[], now: Date): HeatModel {
  const n = daily.length;
  const dayOf = (i: number) => new Date(now.getTime() - (n - 1 - i) * DAY);
  const cells = daily.map((count, i): HeatCell => ({
    col: Math.floor(i / 7), row: i % 7, count, level: count === 0 ? 0 : count === 1 ? 1 : count === 2 ? 2 : 3,
    label: dayOf(i).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
  }));
  const rowLabels = Array.from({ length: 7 }, (_, r) => dayOf(r).toLocaleDateString('en-US', { weekday: 'short' }));
  const columnLabels = [0, 4, 8].map((col) => ({ col, label: fmtDate(dayOf(col * 7)) }));
  return { cells, rowLabels, columnLabels, total: sum(daily) };
}

// ---------------------------------------------------------------- everything the metrics view needs

export interface MetricsModel {
  events: ActivityEvent[];
  daily: number[];
  pulse: Pulse;
  lastActivity?: Date;
  flags: Flag[];
  health: Health;
  activity: ActivityModel;
  stages: StageModel;
  ages: AgeBar[];
  heat: HeatModel;
}

export function metricsModel(home: ProductHome, s: MetricSettings, now: Date): MetricsModel {
  const events = productActivity(home.links, home.states);
  const daily = dailyBuckets(events, now);
  const pulse = productPulse(events, now);
  const fl = flags(home.links, home.states, s, now);
  return {
    events, daily, pulse, lastActivity: latest(events), flags: fl, health: health(home.links, pulse, fl, s, now),
    activity: activitySeries(home, now), stages: stageColumns(home.history, now), ages: ageBars(home, s, now), heat: heatModel(daily, now),
  };
}

export const flagsFor = (fl: Flag[], linkId: string) => fl.filter((f) => f.linkId === linkId);
