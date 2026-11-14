import { useState } from 'react';
import type { ImportReport, ProductSummary } from '../../../shared/products.js';
import { Sheet } from './Sheet.js';

interface Props {
  products: ProductSummary[];
  onNew: () => void;
  onOpen: (id: string) => void;
  onImported: (id: string) => void;
}

/** Every product on this Mac, plus importing a teammate's exported mapping. */
export function ProductsPage({ products, onNew, onOpen, onImported }: Props) {
  const [report, setReport] = useState<ImportReport>();
  const [error, setError] = useState<string>();

  const importIt = async () => {
    setError(undefined);
    const r = await window.pmworkbench.importProduct();
    if (!r.ok) { setError(r.message); return; }
    if (r.value.cancelled) return;
    if (r.value.unresolved.length) setReport(r.value); else onImported(r.value.productId);
  };

  return (
    <div className="products">
      <div className="setrow">
        <button className="btn primary" onClick={onNew}>New product</button>
        <button className="btn" onClick={() => void importIt()}>Import mapping…</button>
      </div>
      {error && <p className="banner bad small">{error}</p>}
      {products.length === 0 ? (
        <div className="empty card">
          <b>No products yet</b>
          <span>Create a product, give it an objective, and link the artifacts, customers and decisions that belong to it. Or import a mapping a teammate exported.</span>
        </div>
      ) : (
        <ul className="product-cards">
          {products.map((p) => (
            <li key={p.id}>
              <button className="card pcard" onClick={() => onOpen(p.id)}>
                <b>{p.name}</b>
                <span className="mut small obj-line">{p.objective || 'No objective yet'}</span>
                <span className="small">
                  <span className="mut">{p.linkCount} linked</span>
                  {p.brokenCount > 0 && <span style={{ color: 'var(--red)' }}> · {p.brokenCount} broken</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {report && (
        <Sheet
          name="import-report"
          title={`Imported “${report.productName}”`}
          onClose={() => { setReport(undefined); onImported(report.productId); }}
          width={560}
          footer={<button className="btn primary" data-autofocus onClick={() => { setReport(undefined); onImported(report.productId); }}>Open product</button>}
        >
          <p>{report.imported} link{report.imported === 1 ? '' : 's'} imported. {report.unresolved.length} couldn't be matched to a repo connected here and were left out:</p>
          <ul className="unresolved">
            {report.unresolved.map((u, i) => <li key={i}><b>{u.title}</b> <span className="mut small mono">{u.repo}</span><br /><span className="small">{u.reason}</span></li>)}
          </ul>
          <p className="mut small">To bring them in, assign the matching repos in Settings and import the file again into a fresh product.</p>
        </Sheet>
      )}
    </div>
  );
}
