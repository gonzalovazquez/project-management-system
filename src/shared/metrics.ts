/**
 * Flow metrics for a product: how its linked items are moving through the five stages. Adapted
 * from Project Dashboard's rules (ADR 001) to PM Workbench's model: one row per linked item rather
 * than per local project, five stages rather than four, activity from GitHub rather than local git.
 *
 * These are flow metrics only. They say how work is moving; they say nothing about whether the
 * product's objective or KPIs moved, and nothing here should be presented as if it did. There is
 * no progress, burnup or forecast: the plan has no definition of done for a product.
 */
import { computePulse } from './pulse.js';
import { STAGE_LABEL, STAGES, type ActivityEvent, type ItemState, type Link, type WorkflowStage } from './products.js';

export const DAY = 86_400_000;
/** The trailing window every activity metric covers: 12 weeks. */
export const WEEKS = 12;
export const DAYS = WEEKS * 7;

export type PulseLevel = 'Hot' | 'Warm' | 'Cooling' | 'Dormant';
export interface Pulse { score: number; level: PulseLevel; lastActivityDays: number | null }

/** Review thresholds: days in a stage before an item is flagged, and days without activity before it counts as quiet. */
export interface MetricSettings {
  stageThresholds: Record<WorkflowStage, number>;
  quietDays: number;
}

/**
 * Defaults for a PM team's flow rather than Project Dashboard's 30/45 days for one person's side
 * projects: triage and handoff should be quick, problem framing a few weeks, solution work and
 * release-and-feedback longer.
 */
export const DEFAULT_METRIC_SETTINGS: MetricSettings = {
  stageThresholds: { intake: 14, problem: 21, solution: 30, specification: 21, release: 30 },
  quietDays: 21,
};

/** The local calendar date, which is what a person means by "today". */
export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const startOfLocalDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

// ---------------------------------------------------------------- activity

/** Every distinct activity event across a product's items: a commit touching two linked files counts once. */
export function productActivity(links: Link[], states: Record<string, ItemState>): ActivityEvent[] {
  const seen = new Map<string, ActivityEvent>();
  for (const l of links) {
    const s = states[l.id];
    const events = s && 'activity' in s ? s.activity ?? [] : [];
    for (const e of events) if (!seen.has(e.id)) seen.set(e.id, e);
  }
  return [...seen.values()];
}

/** Events per local calendar day for the trailing `days` days, oldest first; the last entry is today. */
export function dailyBuckets(events: Pick<ActivityEvent, 'at'>[], now: Date, days = DAYS): number[] {
  const out = new Array(days).fill(0);
  const today = startOfLocalDay(now).getTime();
  for (const e of events) {
    const t = Date.parse(e.at);
    if (Number.isNaN(t)) continue;
    const idx = days - 1 - Math.round((today - startOfLocalDay(new Date(t)).getTime()) / DAY);
    if (idx >= 0 && idx < days) out[idx]++;
  }
  return out;
}

/** Sums seven consecutive days into one week; the last entry is the week ending today. */
export function weeklyBuckets(daily: number[]): number[] {
  const weeks = Math.floor(daily.length / 7);
  const offset = daily.length - weeks * 7;
  return Array.from({ length: weeks }, (_, w) => daily.slice(offset + w * 7, offset + w * 7 + 7).reduce((a, b) => a + b, 0));
}

export function latest(events: Pick<ActivityEvent, 'at'>[]): Date | undefined {
  let best = -Infinity;
  for (const e of events) { const t = Date.parse(e.at); if (t > best) best = t; }
  return Number.isFinite(best) ? new Date(best) : undefined;
}

/** The inherited recency-weighted pulse, fed GitHub activity. There is no "uncommitted work" here, so dirty is always false. */
export function productPulse(events: ActivityEvent[], now: Date): Pulse {
  return computePulse(weeklyBuckets(dailyBuckets(events, now)), false, latest(events), now);
}

// ---------------------------------------------------------------- time in stage

export function stageDays(l: Pick<Link, 'stageEnteredAt'>, now: Date): number {
  const at = l.stageEnteredAt ? Date.parse(l.stageEnteredAt) : NaN;
  return Number.isNaN(at) ? 0 : Math.max(0, Math.floor((now.getTime() - at) / DAY));
}

export const isOver = (l: Link, s: MetricSettings, now: Date) => !!l.stage && stageDays(l, now) > s.stageThresholds[l.stage];

// ---------------------------------------------------------------- stall flags

export type FlagCode = 'over-threshold' | 'quiet' | 'empty-stage' | 'broken';
export interface Flag {
  code: FlagCode;
  text: string;
  /** The item it is about; absent for product-level flags. */
  linkId?: string;
}

/**
 * What needs a look:
 * - an item past its stage's review threshold;
 * - a placed item with no GitHub activity for `quietDays` (items in release and feedback are
 *   expected to go quiet, so they aren't flagged);
 * - an empty stage that later stages depend on: nothing in it while something sits further along,
 *   which usually means a step was skipped or an item hasn't been placed;
 * - a broken link.
 */
export function flags(links: Link[], states: Record<string, ItemState>, s: MetricSettings, now: Date): Flag[] {
  const out: Flag[] = [];
  for (const l of links) {
    if (l.health.state === 'broken') out.push({ code: 'broken', linkId: l.id, text: `${l.title}: link is broken` });
    if (!l.stage) continue;
    const days = stageDays(l, now);
    const limit = s.stageThresholds[l.stage];
    if (days > limit) out.push({ code: 'over-threshold', linkId: l.id, text: `${l.title}: ${days} days in ${STAGE_LABEL[l.stage]} (review at ${limit})` });
    if (l.stage !== 'release') {
      const st = states[l.id];
      const last = latest(st && 'activity' in st ? st.activity ?? [] : []);
      const quiet = last ? Math.floor((now.getTime() - last.getTime()) / DAY) : undefined;
      if (quiet !== undefined && quiet > s.quietDays) out.push({ code: 'quiet', linkId: l.id, text: `${l.title}: no activity for ${quiet} days` });
    }
  }
  const counts = stageCounts(links);
  STAGES.forEach((stage, i) => {
    if (counts[stage] > 0) return;
    const later = STAGES.slice(i + 1).filter((x) => counts[x] > 0);
    if (later.length) out.push({ code: 'empty-stage', text: `Nothing in ${STAGE_LABEL[stage]}, but ${later.map((x) => `${counts[x]} in ${STAGE_LABEL[x]}`).join(', ')}` });
  });
  return out;
}

// ---------------------------------------------------------------- stage counts and history

export type StageCounts = Record<WorkflowStage, number> & { unstaged: number };

export function stageCounts(links: Pick<Link, 'stage'>[]): StageCounts {
  const c = { ...Object.fromEntries(STAGES.map((s) => [s, 0])), unstaged: 0 } as StageCounts;
  for (const l of links) { if (l.stage) c[l.stage]++; else c.unstaged++; }
  return c;
}

/** How many of a product's items sat in each stage on one day. GitHub keeps no stage history, so these start when the product is set up. */
export interface StagePoint { date: string; counts: StageCounts }

/** At most this many daily points are kept per product (a bit over a year). */
export const MAX_POINTS = 400;

// ---------------------------------------------------------------- health

export interface HealthPart { label: 'Momentum' | 'Freshness' | 'Hygiene'; value: number; weight: number; why: string }
export interface Health { score: number; level: 'Good' | 'Fair' | 'At risk'; parts: HealthPart[] }

/**
 * Weights after dropping Project Dashboard's "Progress" part (35%), which needs a definition of
 * done this plan doesn't have. Momentum leads because activity is the most direct signal of flow;
 * freshness and hygiene share the rest.
 */
export const HEALTH_WEIGHTS = { Momentum: 0.4, Freshness: 0.3, Hygiene: 0.3 } as const;

/**
 * A 0-100 score with its parts shown, so it is always explainable:
 * - Momentum: the activity pulse, 4 or more counting as full;
 * - Freshness: per placed item, full while within its stage threshold, falling to zero at twice it;
 * - Hygiene: 100 less 20 per flag.
 * A part with nothing to measure (no placed items) is left out and the others reweighted, rather
 * than counted as perfect or as zero.
 */
export function health(links: Link[], pulse: Pulse, fl: Flag[], s: MetricSettings, now: Date): Health {
  const parts: HealthPart[] = [];
  parts.push({ label: 'Momentum', value: Math.min(1, pulse.score / 4) * 100, weight: HEALTH_WEIGHTS.Momentum, why: `Activity pulse ${pulse.score} (${pulse.level})` });
  const placed = links.filter((l) => l.stage);
  if (placed.length) {
    const each = placed.map((l) => {
      const limit = s.stageThresholds[l.stage!];
      const d = stageDays(l, now);
      return d <= limit ? 1 : Math.max(0, 1 - (d - limit) / limit);
    });
    const over = placed.filter((l) => isOver(l, s, now)).length;
    parts.push({ label: 'Freshness', value: (each.reduce((a, b) => a + b, 0) / each.length) * 100, weight: HEALTH_WEIGHTS.Freshness, why: `${over} of ${placed.length} placed items past their review point` });
  }
  parts.push({ label: 'Hygiene', value: Math.max(0, 100 - 20 * fl.length), weight: HEALTH_WEIGHTS.Hygiene, why: `${fl.length} flag${fl.length === 1 ? '' : 's'}` });
  const total = parts.reduce((a, p) => a + p.weight, 0);
  for (const p of parts) p.weight = p.weight / total;
  const score = Math.round(parts.reduce((a, p) => a + p.value * p.weight, 0));
  return { score, level: score >= 70 ? 'Good' : score >= 45 ? 'Fair' : 'At risk', parts };
}
