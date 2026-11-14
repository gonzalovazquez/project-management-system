# Chart colors

Chart colors come from the documented palette of the data-viz method. They were checked with its
validator (`validate_palette.js`) against the actual card surfaces: `#ffffff` in light, `#2a2a2d`
in dark. The interface chrome (pills, tiles, sidebar) keeps the macOS system colors, which are
labelled text, not chart marks.

| Use | Light | Dark | Result |
|---|---|---|---|
| Repo series: artifacts, CRM, PDR (activity per week) | `#2a78d6` `#eb6834` `#1baf7a` | `#3987e5` `#d95926` `#199e70` | Unchanged from Project Dashboard's validated categorical slots, in fixed order: lightness, chroma, CVD separation and the normal-vision floor all pass. Light aqua is 2.82:1 on white, below 3:1, so the direct labels, legend, table view and tooltips are the required relief. Color follows the repo, never its rank. |
| Stage ramp, intake → release (items by stage, heatmap) | `#86b6ef` `#5598e7` `#2a78d6` `#1c5cab` `#104281` | `#256abf` `#3987e5` `#6da7ec` `#9ec5f4` `#cde2fb` | **Five steps (Phase 3b; was four).** Passes as an ordinal ramp in both modes (`--ordinal`): monotone lightness, adjacent ΔL ≥ 0.06, one hue (3° spread). The end nearest the surface is 2.11:1 in light and 2.65:1 in dark. In dark the ramp starts at step 500, not 600: step 600 measured 1.77:1 against the `#2a2a2d` card, below the 2:1 floor. Stages are ordered, so one hue stepped by lightness is correct. |
| Past review point | `#ec835a` | `#ec835a` | The documented "serious" status color. Separation from series 1 (blue): ΔE 23.3 (protan), 32.3 normal vision. Below 3:1 on white (2.64:1), so it is always paired with the words "over" / "past review point" and never carries meaning alone. |

To re-run the validator:

```
node validate_palette.js "#86b6ef,#5598e7,#2a78d6,#1c5cab,#104281" --mode light --ordinal --surface "#ffffff"
node validate_palette.js "#256abf,#3987e5,#6da7ec,#9ec5f4,#cde2fb" --mode dark --ordinal --surface "#2a2a2d"
node validate_palette.js "#2a78d6,#ec835a" --mode light --surface "#ffffff"
```

The rules every chart follows:
- a legend for two or more series, and direct labels where there is room;
- a "View as table" for every chart;
- tooltips on hover and on keyboard focus, with hit areas of at least 24px;
- bars at most 24px thick with a rounded data end, and 2px gaps between stacked segments;
- text in text colors, never in the data color.

## Where stage history comes from

GitHub keeps no record of an item's workflow stage, so past stages can't be reconstructed. After
every sync and every stage change, the app records one point per product per local day,
`{date, items per stage}`, in the `stage_snapshots` table (at most 400 days per product). The
"Items by stage over time" chart draws only those points and says so while history is short.
Nothing is invented. A week the app wasn't opened stays empty.
