# Flow metrics

Phase 3b, per ADR 001 ("bring flow metrics into the MVP") in the PM Workbench plan.

## Scope, decided before this phase

- **Flow metrics only.** They show how a product's work moves through the five stages. They don't
  measure whether the objective or its KPIs moved. The metrics view says so in a banner, and the
  health panel says so in its subtitle.
- **No burnup and no forecast.** The plan has no definition of done for a product, so there is
  nothing to burn up to, and none was invented.
- **Activity comes from the GitHub API**, not local git.

## Activity: what counts, and what it costs

An activity event is any of these, within the trailing 12 weeks:

- a commit on the default branch that touches a linked file;
- a linked pull request being opened, reviewed, merged, or receiving a commit.

Events are deduped by id across the product, so a commit that touches two linked files, or a
linked file and a linked PR, counts once.

**Cost.** Activity piggybacks on the Phase 3a sync instead of adding a pass:

- The per-file "last changed" read became `GET /commits?path=…&per_page=100`. That is still one
  request, and it now also returns the file's recent commit history. As before, it only runs when
  the file's blob SHA changed since the last sync; an unchanged SHA means no new commits touched it.
- Each linked pull request adds one read, `GET /pulls/{n}/commits`, which is a 304 when unchanged.
- Measured against the test repos (6-link seeded product, no PR links): first sync **8 requests**,
  refresh with nothing changed **3 requests, all 304**. That is the same as Phase 3a. Each PR link
  costs 3 requests on its first sync and 3 free 304s after.
- **Limit:** a file's history is capped at its last 100 commits. A file committed to more than 100
  times in 12 weeks would be under-counted.

## Functions: reused unchanged, and rewritten

| Inherited (Project Dashboard) | Now | Change |
|---|---|---|
| `computePulse` | `shared/pulse.ts` | **Unchanged.** It is fed GitHub weekly buckets, and `dirty` is always false (there's no uncommitted work to see). |
| `weeklyBuckets`, `dailyBuckets` | `shared/metrics.ts` | Rewritten. They lived in the deleted local scanner; now they bucket timestamped events by local day over 84 days and fold days into weeks. |
| `stageDays` | `shared/metrics.ts` | Same rule, read from the link's `stageEnteredAt` (Phase 3a). |
| `flags` | `shared/metrics.ts` | Rewritten for items (below). |
| `healthParts` / `health` | `shared/metrics.ts` → `health` | Progress dropped, the rest reweighted (below). |
| `stageCounts`, `upsertPoint` (JSON history) | `shared/metrics.ts`, `ProductStore.snapshot` | Five stages plus unstaged. Upsert and cap are now SQL (`stage_snapshots`, 400 days per product). |
| `niceTicks`, `stageColumns`, `ageBars`, `commitSeries`, tables | `renderer/viewmodel/charts.ts` | Same shapes. `commitSeries` became `activitySeries`, stacked by repo instead of by focus project. |
| `ColumnCharts`, `AgeChart`, `Heatmap`, `HealthPanel`, chart infra | `renderer/components/charts/` | Drawing code carried over. Forecast, scatter, burnup, language and bar-list charts were dropped. |

Removed with them: the old `Project`/`Stage` model (`shared/types.ts`, `shared/rules.ts`),
`main/app/history.ts`'s JSON store, and the `reserved/` folder.

## Thresholds (Settings → Flow metrics)

| Stage | Review after |
|---|---|
| Intake and triage | 14 days |
| Problem brief | 21 days |
| Solution | 30 days |
| Specification | 21 days |
| Release and feedback | 30 days |
| Quiet (no activity) | 21 days |

Project Dashboard's 30 and 45 days were for one person's side projects. A PM team's triage and
handoff should be quick, problem framing a few weeks, and solution and release work longer. Every
value can be set from 1 to 365 days.

## Stall flags

- **Past review point:** a placed item that has been in its stage longer than that stage's threshold.
- **Quiet:** a placed item with no activity for the quiet threshold. Items in release and feedback
  aren't flagged, because they are expected to go quiet. Items with no known activity at all aren't
  flagged either, since there is nothing to measure from.
- **Empty stage:** a stage with nothing in it while a later stage has items, which usually means a
  step was skipped or an item hasn't been placed.
- **Broken link.**

Item flags show on the metrics view and on their board card. Product flags show on the metrics view.

## Health: 0–100, always explainable

| Part | Weight | Value |
|---|---|---|
| Momentum | 40% | Activity pulse; 4 or more counts as full |
| Freshness | 30% | Per placed item: full within its threshold, falling linearly to 0 at twice it; averaged |
| Hygiene | 30% | 100 − 20 per flag |

- Project Dashboard's "Progress" part (35%) was dropped rather than faked.
- Momentum leads because activity is the most direct flow signal.
- When there is nothing to measure for a part (no placed items means no freshness), it is left out
  and the others are reweighted. It isn't counted as perfect or as zero.
- Levels: Good from 70, Fair from 45, otherwise At risk. The panel shows each part, its weight and
  why, plus a table view.

## Stage history

See `docs/chart-colors.md` § Where stage history comes from: one point per product per day, after
every sync and stage change, starting the day the product is set up.

## Colors

The four-step stage ramp became five steps and was re-validated in both modes, with the dark ramp
shifted one step lighter to clear the app's dark card. Details in `docs/chart-colors.md`.

## Deviations

- **No `ui-check` harness.** Phase 1 removed it, so there is none to extend. Instead,
  `test/charts.test.ts` builds the metrics model for a product with full history, one with sparse
  history and one with nothing linked. An end-to-end Playwright run rendered all three in light and
  dark with no console or page errors. `npm run seed -- --with-history` creates that data.
- **"Remove what is left of the inherited Overview, Deep dive and portfolio screens":** Phase 1
  already removed them. This phase removed the parked chart code they left in `reserved/`.
