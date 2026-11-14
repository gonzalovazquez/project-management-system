// Reserved for Phase 3a/3b (workflow board, flow metrics) per ADR 001 in the PM Workbench plan.
// Inherited from Project Dashboard; not wired into the app until those phases, and the types
// and fields it reads (Project, NotionInfo, Stage, criteria) are the old local-project model,
// to be adapted to PM Workbench's own product/item model when it is built in Phase 2/3a.
// The 3-project focus limit, park/kill/ship/promote rules and the weekly review they supported
// were removed in Phase 1 — they were specific to Project Dashboard's single-person workflow.
import { type Criterion, type Project } from './types.js';

const DAY = 86_400_000;

/** Days in a stage after which a project is flagged for review. Charts draw the same line. */
export const REVIEW_DAYS = { 'In progress': 30, 'Beta': 45 } as const;
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);

export interface Flag { code: 'stuck-beta' | 'stuck-progress' | 'no-criteria' | 'no-commits' | 'quiet'; text: string }
export interface Forecast { remaining: number; velocity: number; weeks: number; date: string; low: string; high: string; hoursLeft: number }

const criteria = (p: Project): Criterion[] => p.notion?.criteria ?? [];
export const doneCount = (p: Project) => criteria(p).filter((c) => c.done).length;
export const progress = (p: Project): number | undefined => (criteria(p).length ? doneCount(p) / criteria(p).length : undefined);

/** The next thing to do on a project: its first open ship criterion, in page order. */
export const nextCriterion = (p: Project): Criterion | undefined => criteria(p).find((c) => !c.done);

/** The next step in words: the first open criterion, shipping once every criterion is done, or nothing when there are none. */
export function nextStep(p: Project): string | undefined {
  const c = nextCriterion(p);
  if (c) return c.title;
  return criteria(p).length ? 'Every criterion is done. Mark it shipped.' : undefined;
}

/** Tracked, active, and not yet shipped. */
export const isLive = (p: Project) => !!p.notion && p.notion.life === 'active' && p.notion.stage !== 'General Available';

export function stageDays(p: Project, now: Date): number {
  const at = p.notion?.stageChangedAt;
  return at ? Math.max(0, Math.floor((now.getTime() - Date.parse(at)) / DAY)) : 0;
}

/** Criteria completed per week over the last 4 weeks, floored so forecasts stay finite. */
export function velocity(p: Project, now: Date): number {
  const cutoff = now.getTime() - 28 * DAY;
  const n = criteria(p).filter((c) => c.done && c.doneOn && Date.parse(c.doneOn) >= cutoff).length;
  return Math.max(0.25, n / 4);
}

export function forecast(p: Project, now: Date): Forecast {
  const open = criteria(p).filter((c) => !c.done);
  const v = velocity(p, now);
  const weeks = open.length / v;
  const at = (w: number) => addDays(now, Math.round(w * 7)).toISOString();
  return { remaining: open.length, velocity: v, weeks, date: at(weeks), low: at(weeks * 0.7), high: at(weeks * 1.5), hoursLeft: open.reduce((a, c) => a + (c.hours ?? 0), 0) };
}

export function flags(p: Project, now: Date): Flag[] {
  if (!isLive(p) || !p.notion) return [];
  const out: Flag[] = [];
  const days = stageDays(p, now);
  if (p.notion.stage === 'Beta' && days > REVIEW_DAYS.Beta) out.push({ code: 'stuck-beta', text: `In Beta for ${days} days` });
  if (p.notion.stage === 'In progress' && days > REVIEW_DAYS['In progress']) out.push({ code: 'stuck-progress', text: `In progress for ${days} days` });
  if (p.notion.criteria.length === 0) out.push({ code: 'no-criteria', text: 'No ship criteria' });
  const idle = p.pulse.lastActivityDays;
  if (idle !== null) {
    if (p.notion.focus && idle > 14) out.push({ code: 'no-commits', text: `No commits in ${idle} days` });
    else if (!p.notion.focus && idle > 21) out.push({ code: 'quiet', text: 'Gone quiet' });
  }
  return out;
}

export function healthParts(p: Project, now: Date): Array<{ label: string; value: number; weight: number }> {
  const hygiene = Math.max(0, 100 - 35 * flags(p, now).length);
  return [
    { label: 'Progress', value: (progress(p) ?? 0) * 100, weight: 0.35 },
    { label: 'Momentum', value: Math.min(1, p.pulse.score / 4) * 100, weight: 0.25 },
    { label: 'Freshness', value: (1 - Math.min(1, stageDays(p, now) / 90)) * 100, weight: 0.2 },
    { label: 'Hygiene', value: hygiene, weight: 0.2 },
  ];
}
export const health = (p: Project, now: Date) => Math.round(healthParts(p, now).reduce((a, x) => a + x.value * x.weight, 0));
