import { useMemo, useState } from 'react';
import { ARTIFACT_TYPE_LABEL, STAGE_HINT, STAGE_LABEL, STAGES, type Link, type ProductHome, type WorkflowStage } from '../../../shared/products.js';
import { ago, buildBoard, NO_FILTERS, type BoardFilters, type Card } from '../viewmodel/board.js';

interface Props {
  home: ProductHome;
  /** Places an item in a stage, or back in the tray with null. Local only; nothing is written to GitHub. */
  onMove: (link: Link, stage: WorkflowStage | null) => void;
  onOpen: (link: Link) => void;
}

const DRAG_TYPE = 'application/x-pmworkbench-link';

/**
 * The five-stage workflow board for one product. Cards move by drag and drop or with each card's
 * stage menu (the keyboard path). Moving a card only changes where the PM placed it on this Mac.
 */
export function Board({ home, onMove, onOpen }: Props) {
  const [filters, setFilters] = useState<BoardFilters>(NO_FILTERS);
  const [over, setOver] = useState<WorkflowStage | 'tray'>();
  const now = new Date();
  const board = useMemo(() => buildBoard(home, filters, now), [home, filters]); // eslint-disable-line react-hooks/exhaustive-deps
  const byId = useMemo(() => new Map(home.links.map((l) => [l.id, l])), [home.links]);

  const drop = (stage: WorkflowStage | null) => (e: React.DragEvent) => {
    e.preventDefault();
    setOver(undefined);
    const l = byId.get(e.dataTransfer.getData(DRAG_TYPE));
    if (l && (l.stage ?? null) !== stage) onMove(l, stage);
  };
  const zone = (key: WorkflowStage | 'tray') => ({
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); setOver(key); } },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(undefined); },
    onDrop: drop(key === 'tray' ? null : key),
    'data-over': over === key || undefined,
  });

  const CardView = ({ card }: { card: Card }) => {
    const l = card.link;
    return (
      <li
        className="bcard"
        data-tone={card.tone}
        draggable
        onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, l.id); e.dataTransfer.effectAllowed = 'move'; }}
      >
        <button className="bcard-main" onClick={() => onOpen(l)}>
          <span className="bcard-kind">{card.kindLabel}</span>
          <b>{l.title}</b>
          <span className="bcard-state"><i aria-hidden="true" />{card.stateLabel}</span>
          {card.detail && <span className="mut small">{card.detail}</span>}
          {!card.detail && card.updatedAt && <span className="mut small">Updated {ago(card.updatedAt, now)}</span>}
        </button>
        <div className="bcard-foot">
          {!l.stage && card.suggested && (
            <button className="btn small-btn" onClick={() => onMove(l, card.suggested!)}>Place in {STAGE_LABEL[card.suggested]}</button>
          )}
          <select
            aria-label={`Stage for ${l.title}`}
            value={l.stage ?? ''}
            onChange={(e) => onMove(l, (e.target.value || null) as WorkflowStage | null)}
          >
            <option value="">Unstaged</option>
            {STAGES.map((s, i) => <option key={s} value={s}>{i + 1}. {STAGE_LABEL[s]}</option>)}
          </select>
        </div>
      </li>
    );
  };

  const filtered = filters.type !== 'all' || filters.customer !== 'all';

  return (
    <div className="board">
      <div className="setrow board-filters">
        <label className="setrow small">
          <span className="mut">Show</span>
          <select value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value as BoardFilters['type'] })}>
            <option value="all">Everything</option>
            <option value="customers">Customers and conversations</option>
            <option value="decisions">Decisions</option>
            {board.types.map((t) => <option key={t} value={t}>{ARTIFACT_TYPE_LABEL[t]}</option>)}
          </select>
        </label>
        <label className="setrow small">
          <span className="mut">Customer</span>
          <select value={filters.customer} onChange={(e) => setFilters({ ...filters, customer: e.target.value })} disabled={board.customers.length === 0}>
            <option value="all">Any</option>
            {board.customers.map((c) => <option key={c.path} value={c.path}>{c.label}</option>)}
          </select>
        </label>
        {filtered && (
          <>
            <span className="mut small">Showing {board.shown} of {board.total}</span>
            <button className="btn small-btn" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>
          </>
        )}
      </div>

      <section className="tray card" aria-label="Unstaged" {...zone('tray')}>
        <h3>Unstaged <span className="mut small">{board.unstaged.length ? `${board.unstaged.length} to place` : 'Everything is placed'}</span></h3>
        {board.unstaged.length > 0 && <ul className="tray-cards">{board.unstaged.map((c) => <CardView key={c.link.id} card={c} />)}</ul>}
      </section>

      <div className="columns">
        {STAGES.map((s, i) => (
          <section key={s} className="col card" aria-label={STAGE_LABEL[s]} {...zone(s)}>
            <header>
              <h3><span className="step">{i + 1}</span>{STAGE_LABEL[s]}</h3>
              <span className="mut small">{STAGE_HINT[s]}</span>
            </header>
            <ul>
              {board.columns[s].map((c) => <CardView key={c.link.id} card={c} />)}
              {board.columns[s].length === 0 && <li className="col-empty mut small">Drop items here</li>}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
