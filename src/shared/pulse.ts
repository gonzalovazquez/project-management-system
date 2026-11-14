import type { Pulse, PulseLevel } from './types.js';

/**
 * Recency-weighted activity score. Each commit counts exp(-age/14 days), so a commit
 * from last week is worth about 0.6 and one from a month ago about 0.1.
 * Uncommitted work adds 1, since it is activity that a single history lookup cannot see.
 *
 * Reserved for Phase 3b (flow metrics) per ADR 001 in the PM Workbench plan — not wired
 * into the app until then. Moved here, unchanged, from the Project Dashboard scanner it
 * was inherited from so it can be fed GitHub activity instead of local git activity.
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
