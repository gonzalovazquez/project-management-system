import type { MetricsModel } from '../viewmodel/charts.js';
import { TipProvider } from './charts/infra.js';
import { ActivityChart, AgeChart, HealthPanel, Heatmap, StageChart } from './charts/MetricCharts.js';

const FLAG_LABEL = { 'over-threshold': 'Past review point', quiet: 'Quiet', 'empty-stage': 'Empty stage', broken: 'Broken link' } as const;

/**
 * A product's flow metrics: how its linked items are moving through the five stages. These are
 * flow metrics only — the view never claims the objective or its KPIs moved.
 */
export function Metrics({ model }: { model: MetricsModel }) {
  const flagged = new Set(model.flags.map((f) => f.linkId).filter((x): x is string => !!x));
  return (
    <TipProvider>
      <div className="metrics">
        <p className="banner info small">
          Flow metrics show how work on this product is moving through the five stages. They don't measure whether the objective or its KPIs moved.
        </p>
        <MetricStrip model={model} />
        <section className="card" aria-labelledby="flags-t">
          <div className="hd"><h3 id="flags-t">Needs a look</h3><span className="mut small">{model.flags.length ? `${model.flags.length} flag${model.flags.length === 1 ? '' : 's'}` : 'Nothing flagged'}</span></div>
          {model.flags.length === 0 ? <p className="mut small">Every placed item is within its review point and active, and no stage is skipped.</p> : (
            <ul className="flag-list">
              {model.flags.map((f, i) => <li key={i} data-code={f.code}><span className="tag" data-code={f.code}>{FLAG_LABEL[f.code]}</span>{f.text}</li>)}
            </ul>
          )}
        </section>
        <div className="metric-grid">
          <ActivityChart model={model.activity} />
          <StageChart model={model.stages} />
          <AgeChart bars={model.ages} flagged={flagged} />
          <div className="metric-col">
            <HealthPanel model={model.health} />
            <Heatmap model={model.heat} />
          </div>
        </div>
      </div>
    </TipProvider>
  );
}

/** The compact strip shown on the product home and atop the metrics view: pulse, flags, health. */
export function MetricStrip({ model, onOpen }: { model: MetricsModel; onOpen?: () => void }) {
  const days = model.pulse.lastActivityDays;
  const tone = model.health.level === 'Good' ? 'ok' : model.health.level === 'Fair' ? 'warn' : 'bad';
  return (
    <div className="metric-strip">
      <div className="tile"><span className="mut small">Activity pulse</span><b>{model.pulse.level}</b><span className="mut small">{days === null ? 'No activity in 12 weeks' : days === 0 ? 'Active today' : `Last activity ${days} day${days === 1 ? '' : 's'} ago`}</span></div>
      <div className="tile" data-tone={model.flags.length ? 'warn' : 'ok'}><span className="mut small">Flags</span><b>{model.flags.length}</b><span className="mut small">{model.flags.length ? 'Items needing a look' : 'Nothing flagged'}</span></div>
      <div className="tile" data-tone={tone}><span className="mut small">Flow health</span><b>{model.health.score}<span className="mut small"> / 100</span></b><span className="mut small">{model.health.level}</span></div>
      {onOpen && <button className="btn" onClick={onOpen}>Open metrics</button>}
    </div>
  );
}
