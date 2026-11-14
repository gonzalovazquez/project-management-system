import type { Health } from '../../../../shared/metrics.js';
import { STAGE_LABEL, STAGES } from '../../../../shared/products.js';
import {
  activityTable, ageTable, STAGE_RAMP, stageTable,
  type ActivityModel, type AgeBar, type HeatModel, type StageModel,
} from '../../viewmodel/charts.js';
import { fmtDate } from '../../viewmodel/format.js';
import { ChartCard, rightRounded, topRounded, truncate, useTip, useWidth, type LegendItem } from './infra.js';

/**
 * The flow-metric charts, adapted from Project Dashboard's (ADR 001): the same drawing rules (thin
 * marks, 2px gaps, rounded data ends, a legend plus selective direct labels, a table view and
 * keyboard tooltips for every chart), new data. Colors are validated in docs/chart-colors.md.
 */

const GAP = 2;
const MAX_BAR = 24;
const M = { l: 30, t: 14, b: 24 };
/** Room to the right of the last column for series names. Narrow charts skip them; the legend and tooltip still name everything. */
const LABEL_ROOM = 136;
const LABEL_MIN_WIDTH = 460;
const H = 224;

interface Seg { id: string; name: string; token: string; value: number }
interface Col { slot: number; label: string; segs: Seg[]; total: number; tipTitle: string }

/** Shared drawing for stacked columns: axis, gridlines, 2px gaps, rounded data end, direct labels, hit targets. */
function Columns({ width, slots, cols, ticks, unit }: { width: number; slots: string[]; cols: Col[]; ticks: number[]; unit: string }) {
  const tip = useTip();
  const direct = width >= LABEL_MIN_WIDTH;
  const r = direct ? LABEL_ROOM : 16;
  const pw = width - M.l - r;
  const ph = H - M.t - M.b;
  const top = ticks.at(-1) ?? 1;
  const slotW = pw / slots.length;
  const bw = Math.min(MAX_BAR, slotW * 0.62);
  const y = (v: number) => M.t + ph - (v / top) * ph;
  const cx = (slot: number) => M.l + slot * slotW + slotW / 2;
  const every = slots.length <= 6 ? 1 : 2;
  const last = cols.at(-1);

  return (
    <svg className="chart" width={width} height={H} role="img" aria-label={`Stacked columns, ${unit}`}>
      {ticks.map((t) => <g key={t}><line x1={M.l} x2={M.l + pw} y1={y(t)} y2={y(t)} className="grid" /><text x={M.l - 6} y={y(t) + 3.5} textAnchor="end">{t}</text></g>)}
      {slots.map((s, i) => ((slots.length - 1 - i) % every === 0 ? <text key={i} x={cx(i)} y={H - 7} textAnchor="middle">{s}</text> : null))}
      {cols.map((c) => {
        let acc = 0;
        const topId = c.segs.filter((s) => s.value > 0).at(-1)?.id;
        return (
          <g key={c.slot} className="col">
            {c.segs.map((s) => {
              if (s.value <= 0) return null;
              const y0 = y(acc + s.value);
              const hgt = Math.max(3, y(acc) - y0);
              const isBottom = acc === 0;
              acc += s.value;
              const x = cx(c.slot) - bw / 2;
              const h = isBottom ? hgt : Math.max(1, hgt - GAP);
              const fill = `var(--${s.token})`;
              return s.id === topId
                ? <path key={s.id} d={topRounded(x, y0, bw, h)} fill={fill} />
                : <rect key={s.id} x={x} y={y0} width={bw} height={h} fill={fill} />;
            })}
            <rect className="hit" x={cx(c.slot) - Math.max(slotW, 24) / 2} y={M.t} width={Math.max(slotW, 24)} height={ph} {...tip({ title: c.tipTitle, rows: [...c.segs.slice().reverse().map((s) => ({ label: s.name, value: String(s.value), token: s.token })), { label: 'Total', value: String(c.total) }] })} />
          </g>
        );
      })}
      {last && last.total > 0 && <text x={cx(last.slot)} y={y(last.total) - 6} textAnchor="middle" className="val">{last.total}</text>}
      {last && direct && (() => {
        let acc = 0;
        return (
          <g>
            {last.segs.map((s) => {
              const mid = y(acc + s.value / 2);
              const hgt = y(acc) - y(acc + s.value);
              acc += s.value;
              if (hgt < 12) return null;
              return <g key={s.id}><rect x={cx(last.slot) + bw / 2 + 8} y={mid - 4} width="8" height="8" rx="2" fill={`var(--${s.token})`} /><text x={cx(last.slot) + bw / 2 + 21} y={mid + 3.5}>{truncate(s.name, 17)}</text></g>;
            })}
          </g>
        );
      })()}
    </svg>
  );
}

export function ActivityChart({ model }: { model: ActivityModel }) {
  const [ref, width] = useWidth();
  const cols: Col[] = model.weeks.map((w, j) => ({
    slot: j, label: w.label, total: model.totals[j], tipTitle: `Week ending ${w.label}`,
    segs: model.series.map((s) => ({ id: s.id, name: s.name, token: s.token, value: s.values[j] })),
  }));
  const legend: LegendItem[] = model.series.slice().reverse().map((s) => ({ label: s.name, token: s.token }));
  return (
    <ChartCard id="activity" title="Activity per week" aside={`${model.total} in 12 weeks`} legend={legend} table={activityTable(model)}
      subtitle="Commits to linked files, and pull requests opened, reviewed, committed to or merged, across the three repos.">
      <div ref={ref}>
        {model.total === 0
          ? <div className="empty inner" data-state="no-activity"><b>No activity in 12 weeks</b><span>Nothing linked to this product changed on GitHub in that time, or it hasn't synced yet.</span></div>
          : <Columns width={width} slots={model.weeks.map((w) => w.label)} cols={cols} ticks={model.ticks} unit="activity per week by repo" />}
      </div>
    </ChartCard>
  );
}

export function StageChart({ model }: { model: StageModel }) {
  const [ref, width] = useWidth();
  const order = [...STAGES]; // bottom to top: earliest stage at the base
  const cols: Col[] = model.columns.map((c) => ({
    slot: c.slot, label: c.label, total: c.total, tipTitle: `Week ending ${c.label}, recorded ${fmtDate(new Date(c.date + 'T12:00:00'))}`,
    segs: order.map((s) => ({ id: s, name: STAGE_LABEL[s], token: STAGE_RAMP[s], value: c.counts[s] })),
  }));
  const note = model.columns.length === 0
    ? 'No history yet. GitHub keeps no record of workflow stage, so the app records how many items sit in each stage every day from now on.'
    : model.sparse ? `History starts ${fmtDate(new Date(model.startedOn + 'T12:00:00'))}, when this product was set up. GitHub keeps no record of workflow stage, so the chart fills in day by day.` : undefined;
  const legend: LegendItem[] = order.slice().reverse().map((s) => ({ label: STAGE_LABEL[s], token: STAGE_RAMP[s] }));
  return (
    <ChartCard id="stages" title="Items by stage over time" aside="Where work is piling up" legend={legend} table={stageTable(model)} subtitle={note ? <span data-note="history">{note}</span> : undefined}>
      <div ref={ref}><Columns width={width} slots={model.slots.map((s) => s.label)} cols={cols} ticks={model.ticks} unit="items per stage over the last 12 weeks" /></div>
    </ChartCard>
  );
}

export function AgeChart({ bars, flagged }: { bars: AgeBar[]; flagged?: Set<string> }) {
  const [ref, width] = useWidth();
  const tip = useTip();
  const rowH = 30;
  const m = { l: 170, r: 84, t: 8, b: 6 };
  const height = m.t + m.b + Math.max(1, bars.length) * rowH;
  const pw = width - m.l - m.r;
  const max = Math.max(14, ...bars.map((b) => b.days), ...bars.map((b) => b.threshold)) * 1.05;
  const x = (d: number) => m.l + (d / max) * pw;
  const legend: LegendItem[] = [{ label: 'Within review point', token: 'series-1' }, { label: 'Past review point', token: 'status-serious' }, { label: 'Review point', token: 'label2', shape: 'tick' }];
  return (
    <ChartCard id="age" title="Time in stage" subtitle="Days since each item entered its current stage. Ticks mark the stage's review point, set in Settings." legend={legend} table={bars.length ? ageTable(bars) : undefined}>
      <div ref={ref}>
        {bars.length === 0 ? <div className="empty inner" data-state="no-age"><b>No placed items</b><span>Items appear here once they're placed in a stage on the board.</span></div> : (
          <svg className="chart" width={width} height={height} role="img" aria-label="Days each item has spent in its current stage">
            {bars.map((b, i) => {
              const cy = m.t + i * rowH + rowH / 2;
              return (
                <g key={b.id} data-flagged={flagged?.has(b.id) || undefined}>
                  <text x={m.l - 10} y={cy + 4} textAnchor="end" className="val-soft">{truncate(b.title, 25)}</text>
                  <path d={rightRounded(m.l, cy - 7, Math.max(3, x(b.days) - m.l), 14)} fill={`var(--${b.over ? 'status-serious' : 'series-1'})`} />
                  <line x1={x(b.threshold)} x2={x(b.threshold)} y1={cy - 11} y2={cy + 11} className="review-tick" />
                  <text x={x(Math.max(b.days, b.threshold)) + 8} y={cy + 4} className="val">{b.days}d{b.over ? ' · over' : ''}</text>
                  <rect className="hit" x={0} y={cy - rowH / 2} width={width} height={rowH} {...tip({ title: b.title, rows: [
                    { label: STAGE_LABEL[b.stage], value: `${b.days} days` },
                    { label: b.over ? `past the ${b.threshold} day review point` : `review point is ${b.threshold} days`, value: b.over ? `+${b.days - b.threshold}` : `${b.threshold - b.days} left` },
                  ] })} />
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </ChartCard>
  );
}

const HEAT_TOKENS = ['fill2', 'stage-0', 'stage-2', 'stage-4'] as const;

/** Twelve weeks of days. One hue stepped by lightness, since activity count is an ordered quantity. */
export function Heatmap({ model }: { model: HeatModel }) {
  const tip = useTip();
  const [ref, width] = useWidth();
  const left = 34;
  const PITCH = Math.max(16, Math.min(22, Math.floor((width - left - 4) / 12)));
  const CELL = PITCH - 2;
  return (
    <ChartCard id="heatmap" title="Activity by day" aside={`${model.total} events, 12 weeks`}
      legend={[{ label: 'None', token: 'fill2' }, { label: '1', token: 'stage-0' }, { label: '2', token: 'stage-2' }, { label: '3 or more', token: 'stage-4' }]}
      table={{ head: ['Day', 'Events'], rows: model.cells.filter((c) => c.count > 0).map((c) => [c.label, String(c.count)]) }}>
      <div ref={ref}><svg className="chart heat" width={left + 12 * PITCH} height={7 * PITCH + 22} role="img" aria-label="Activity per day over twelve weeks">
        {model.rowLabels.map((l, r) => (r % 2 === 0 ? <text key={r} x={left - 6} y={r * PITCH + CELL - 2} textAnchor="end">{l}</text> : null))}
        {model.columnLabels.map((c) => <text key={c.col} x={left + c.col * PITCH} y={7 * PITCH + 14}>{c.label}</text>)}
        {model.cells.map((c) => (
          <rect key={`${c.col}-${c.row}`} x={left + c.col * PITCH} y={c.row * PITCH} width={CELL} height={CELL} rx="3" fill={`var(--${HEAT_TOKENS[c.level]})`} data-level={c.level}
            {...tip({ title: c.label, rows: [{ label: c.count === 1 ? 'event' : 'events', value: String(c.count) }] })} />
        ))}
      </svg></div>
    </ChartCard>
  );
}

export function HealthPanel({ model }: { model: Health }) {
  return (
    <ChartCard id="health" title="Health" aside={`${model.score} / 100 · ${model.level}`}
      subtitle="How the work is flowing, not whether the objective moved."
      table={{ head: ['Part', 'Score', 'Weight', 'Why'], rows: model.parts.map((p) => [p.label, String(Math.round(p.value)), `${Math.round(p.weight * 100)}%`, p.why]) }}>
      <div className="hbars">
        {model.parts.map((p) => (
          <div key={p.label} className="hrow" title={p.why}>
            <span>{p.label} <span className="mut small">{Math.round(p.weight * 100)}%</span></span>
            <span className="trk"><i style={{ width: `${Math.max(2, Math.min(100, p.value))}%` }} /></span>
            <b className="num">{Math.round(p.value)}</b>
          </div>
        ))}
      </div>
    </ChartCard>
  );
}

