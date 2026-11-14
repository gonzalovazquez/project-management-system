import type { Pulse, PulseLevel } from './metrics.js';

/**
 * Recency-weighted activity score. Each event counts exp(-age/14 days), so one from last week is
 * worth about 0.6 and one from a month ago about 0.1. Uncommitted work adds 1 (a Project Dashboard
 * input PM Workbench never has, so it is always passed as false).
 *
 * Inherited unchanged from Project Dashboard per ADR 001; fed GitHub activity by shared/metrics.ts.
 */
export function computePulse(weekly: number[], dirty: boolean, lastActivity: Date | undefined, now: Date): Pulse {
  const DAY = 86_400_000;
  const n = weekly.length;
  const score = weekly.reduce((a, c, i) => a + c * Math.exp(-(((n - 1 - i) * 7) + 3.5) / 14), 0) + (dirty ? 1 : 0);
  const quiet = weekly.slice(-4).every((c) => c === 0) && !dirty;
  const level: PulseLevel = quiet ? 'Dormant' : score >= 4 ? 'Hot' : score >= 1.5 ? 'Warm' : 'Cooling';
  const lastActivityDays = lastActivity ? Math.max(0, Math.floor((now.getTime() - lastActivity.getTime()) / DAY)) : null;
  return { score: Math.round(score * 100) / 100, level, lastActivityDays };
}
