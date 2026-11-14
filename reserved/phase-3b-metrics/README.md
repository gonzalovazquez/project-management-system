# Reserved for Phase 3b (flow metrics)

This is Project Dashboard's charting code, parked here during Phase 1 rather than deleted, per
ADR 001 in the PM Workbench Notion plan ("keep the pure bucket and pulse functions... reserved for
when the metrics view is built in Phase 3b").

It is **not wired into the app and not part of the build**: this folder sits outside `src/` and
`test/`, so neither `tsc` nor the Vite renderer build sees it, and its own relative imports are
left exactly as they were in Project Dashboard — they will not resolve until Phase 3a/3b moves
this code back under `src/` and adapts it.

What's here and what Phase 3a/3b needs to do with it:

- `components/charts/{ColumnCharts,OtherCharts,infra}.tsx`, `components/deep/DeepCharts.tsx` —
  the chart drawing components. These render from `viewmodel/charts.ts`'s table shapes; they don't
  know about Notion or the local scanner directly, so they should need little more than new data
  to draw.
- `viewmodel/charts.ts` — the real adaptation work. It derives its tables from
  `shared/rules.ts`'s `focusProjects` (removed in Phase 1 along with the focus/park/kill/ship
  rules) and from `Project`/`Stage` in `shared/types.ts` (also reserved, still Project Dashboard's
  shape). This needs rewriting against whatever product/item model Phase 2 defines.
- `viewmodel/format.ts`, `tokens.ts` — small, generic formatting and color-token helpers; these
  should drop in with little or no change.

`src/main/app/history.ts` and `src/shared/{types,rules,pulse}.ts` are the other half of this ADR's
"keep for later" list — those stayed under `src/`, with the same reserved-for-Phase-3b doc
comments, because they still typecheck cleanly against the Phase 1 code as written (they only
touch shared types, not scanning/Notion code), and `test/charts.test.ts` and
`test/fixtures/sample.ts`/`test/history.test.ts`'s pure-function tests follow the same split. The
difference is that the files in *this* folder actually fail to compile right now — the one
`focusProjects` import makes that unavoidable — so parking them outside the build was the only way
to keep them around without breaking Phase 1.
