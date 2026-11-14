import { useState } from 'react';
import type { Kpi, Product } from '../../../shared/products.js';
import { Sheet } from './Sheet.js';

interface Props {
  /** Editing this product, or creating a new one when absent. */
  product?: Product;
  onClose: () => void;
  onSaved: (p: Product) => void;
}

/** Name, objective and optional KPIs. Everything is stored on this Mac only. */
export function ProductForm({ product, onClose, onSaved }: Props) {
  const [name, setName] = useState(product?.name ?? '');
  const [objective, setObjective] = useState(product?.objective ?? '');
  const [kpis, setKpis] = useState<Kpi[]>(product?.kpis.length ? product.kpis : [{ name: '', target: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const setKpi = (i: number, patch: Partial<Kpi>) => setKpis(kpis.map((k, j) => (j === i ? { ...k, ...patch } : k)));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    const input = { name, objective, kpis };
    const r = product ? await window.pmworkbench.updateProduct(product.id, input) : await window.pmworkbench.createProduct(input);
    setBusy(false);
    if (!r.ok) { setError(r.message); return; }
    onSaved(r.value);
  };

  return (
    <Sheet name="product-form" title={product ? 'Edit product' : 'New product'} onClose={onClose} width={520}>
      <form onSubmit={submit}>
        <label className="fld">
          Product name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Checkout retry flow" data-autofocus maxLength={200} />
        </label>
        <label className="fld">
          Objective
          <textarea rows={3} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="What this product is driving, e.g. reduce checkout abandonment from failed payments by 20% this quarter." />
        </label>
        <fieldset className="kpis">
          <legend>KPIs <span className="mut small">(optional)</span></legend>
          {kpis.map((k, i) => (
            <div className="kpi-row" key={i}>
              <input className="field" aria-label={`KPI ${i + 1} name`} value={k.name} onChange={(e) => setKpi(i, { name: e.target.value })} placeholder="Metric" />
              <input className="field" aria-label={`KPI ${i + 1} target`} value={k.target} onChange={(e) => setKpi(i, { target: e.target.value })} placeholder="Target" />
              <button type="button" className="btn icon" aria-label={`Remove KPI ${i + 1}`} onClick={() => setKpis(kpis.length > 1 ? kpis.filter((_, j) => j !== i) : [{ name: '', target: '' }])}>×</button>
            </div>
          ))}
          <button type="button" className="btn" onClick={() => setKpis([...kpis, { name: '', target: '' }])}>Add KPI</button>
        </fieldset>
        {error && <p className="small" style={{ color: 'var(--red)' }}>{error}</p>}
        <div className="sheet-foot">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>{busy ? 'Saving…' : product ? 'Save' : 'Create product'}</button>
        </div>
      </form>
    </Sheet>
  );
}
