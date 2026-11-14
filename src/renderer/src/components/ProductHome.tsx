import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ROLE_LABEL, type AuthState, type PublicSettings } from '../../../shared/ipc.js';
import { ARTIFACT_TYPE_LABEL, ARTIFACT_TYPES, describeTarget, groupLinks, STAGE_LABEL, type ArtifactType, type Link, type ProductHome as Home, type WorkflowStage } from '../../../shared/products.js';
import { syncLine } from '../viewmodel/board.js';
import { metricsModel } from '../viewmodel/charts.js';
import { Metrics, MetricStrip } from './Metrics.js';
import { ApprovalPanel } from './ApprovalPanel.js';
import { ArtifactWriter } from './ArtifactWriter.js';
import { ConversationWriter } from './ConversationWriter.js';
import { PdrWriter } from './PdrWriter.js';
import { Board } from './Board.js';
import { LinkPicker } from './LinkPicker.js';
import { Preview } from './Preview.js';
import { ProductForm } from './ProductForm.js';
import { Sheet } from './Sheet.js';

interface Props {
  id: string;
  settings: PublicSettings;
  auth: Extract<AuthState, { status: 'signed-in' }>;
  /** Called after anything that changes the sidebar's product list (rename, delete, links added). */
  onChanged: () => void;
  onDeleted: () => void;
  tab: ProductTab;
  onTab: (t: ProductTab) => void;
}

export type ProductTab = 'home' | 'board' | 'metrics';

/** While a product is open, sync this often. With ETags an unchanged product costs a handful of free 304s. */
const REFRESH_MS = 5 * 60_000;

function Health({ link }: { link: Link }) {
  if (link.health.state === 'ok') return null;
  if (link.health.state === 'unchecked') return <span className="tag mut" title="Not checked against GitHub yet">unchecked</span>;
  return <span className="tag bad" title={link.health.reason}>broken</span>;
}

/**
 * One product in one place, with the objective pinned on top and two views below it: the home
 * (customers, artifacts by type, decisions, each with a preview) and the five-stage workflow
 * board. It renders straight from the local cache, then syncs with GitHub on open and every few
 * minutes, so it opens instantly and still works offline.
 */
export function ProductHome({ id, settings, auth, onChanged, onDeleted, tab, onTab }: Props) {
  const [home, setHome] = useState<Home>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [previewing, setPreviewing] = useState<Link>();
  const [writer, setWriter] = useState<{ kind: 'create' } | { kind: 'edit'; link: Link } | { kind: 'conversation' } | { kind: 'pdr' }>();
  const [selected, setSelected] = useState<Link>();
  const [sheet, setSheet] = useState<'edit' | 'link' | 'delete' | { relink: Link }>();

  // Held in a ref so a new callback identity from the parent never re-triggers the load-and-check effect.
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const check = useCallback(async () => {
    setChecking(true);
    const r = await window.pmworkbench.syncProduct(id);
    setChecking(false);
    if (r.ok) { setHome(r.value); changed.current(); } else setNotice(`Not synced: ${r.message}`);
  }, [id]);

  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') void check(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [check]);

  const load = useCallback(async () => {
    const r = await window.pmworkbench.getProduct(id);
    if (r.ok) { setHome(r.value); setError(undefined); } else setError(r.message);
    return r.ok;
  }, [id]);

  useEffect(() => {
    setHome(undefined);
    setSelected(undefined);
    setNotice(undefined);
    void load().then((found) => { if (found) void check(); });
  }, [id, load, check]);

  // Keep the preview pointing at the current version of the selected link after a reload.
  useEffect(() => {
    if (selected && home) setSelected(home.links.find((l) => l.id === selected.id));
  }, [home]); // eslint-disable-line react-hooks/exhaustive-deps

  // Recomputed per render minute rather than per tick; metrics depend on "now" only at day granularity.
  const metrics = useMemo(() => (home ? metricsModel(home, settings.metrics, new Date()) : undefined), [home, settings.metrics]);

  if (error) return <div className="empty card"><b>Can't open this product</b><span>{error}</span></div>;
  if (!home) return <div className="loading">Loading…</div>;

  const { product, links } = home;
  const g = groupLinks(links);
  const broken = links.filter((l) => l.health.state === 'broken').length;

  const remove = async (l: Link) => {
    const r = await window.pmworkbench.removeLink(l.id);
    if (!r.ok) { setNotice(r.message); return; }
    if (selected?.id === l.id) setSelected(undefined);
    await load();
    onChanged();
  };

  const setArtifactType = async (l: Link, artifactType: ArtifactType) => {
    const r = await window.pmworkbench.updateLink(l.id, { artifactType });
    if (r.ok) await load(); else setNotice(r.message);
  };

  // Optimistic: the card moves at once; a refusal puts it back and says why.
  const move = async (l: Link, stage: WorkflowStage | null) => {
    setHome((h) => h && { ...h, links: h.links.map((x) => (x.id === l.id ? { ...x, stage: stage ?? undefined, stageEnteredAt: stage ? new Date().toISOString() : undefined } : x)) });
    const r = await window.pmworkbench.moveLink(l.id, stage);
    if (!r.ok) setNotice(r.message);
    await load();
  };

  const sl = syncLine(home.sync, checking, new Date());

  const exportIt = async () => {
    const r = await window.pmworkbench.exportProduct(id);
    if (!r.ok) setNotice(r.message);
    else if (!r.value.cancelled) setNotice(`Exported to ${r.value.path}. A teammate can import it from the Products page.`);
  };

  const Row = ({ link, nested }: { link: Link; nested?: boolean }) => (
    <li className={`lrow${nested ? ' nested' : ''}`} aria-current={selected?.id === link.id}>
      <button className="lmain" onClick={() => setSelected(link)}>
        <b>{link.title}</b>
        <span className="mut small mono">{describeTarget(link)}</span>
      </button>
      <Health link={link} />
      {link.health.state === 'broken' && (
        <button className="btn small-btn" onClick={() => setSheet({ relink: link })}>Relink</button>
      )}
    </li>
  );

  return (
    <div className="product">
      <section className="card objective">
        <div className="hd">
          <h3>Objective</h3>
          <div className="pa">
            <button className="btn" onClick={() => setSheet('edit')}>Edit</button>
            <button className="btn" onClick={() => setWriter({ kind: 'create' })} disabled={!settings.repoRoles.artifacts}>New artifact</button>
            <button className="btn" onClick={() => setWriter({ kind: 'conversation' })} disabled={!settings.repoRoles.crm}>Log conversation</button>
            <button className="btn" onClick={() => setWriter({ kind: 'pdr' })} disabled={!settings.repoRoles.pdr}>Raise PDR</button>
            <button className="btn primary" onClick={() => setSheet('link')}>Link items</button>
          </div>
        </div>
        <p className={product.objective ? 'obj' : 'mut'}>{product.objective || 'No objective yet. Edit the product to add the outcome it is driving.'}</p>
        {product.kpis.length > 0 && (
          <ul className="kpi-list">
            {product.kpis.map((k, i) => <li key={i}><span>{k.name}</span>{k.target && <b>{k.target}</b>}</li>)}
          </ul>
        )}
        <div className="setrow small">
          <div className="seg small" role="tablist" aria-label="View">
            <button role="tab" aria-selected={tab === 'home'} onClick={() => onTab('home')}>Home</button>
            <button role="tab" aria-selected={tab === 'board'} onClick={() => onTab('board')}>Board</button>
            <button role="tab" aria-selected={tab === 'metrics'} onClick={() => onTab('metrics')}>Metrics</button>
          </div>
          <span className="mut">{links.length} linked item{links.length === 1 ? '' : 's'}{broken ? ` · ` : ''}</span>
          {broken > 0 && <span style={{ color: 'var(--red)' }}>{broken} broken</span>}
          <span className="sp" />
          <span className="sync-line" data-tone={sl.tone} title={home.sync.requests !== undefined ? `Last sync: ${home.sync.requests} requests, ${home.sync.notModified ?? 0} unchanged (304)` : undefined}>{sl.text}</span>
          <button className="btn" disabled={checking} onClick={() => void check()}>Refresh</button>
          <button className="btn" onClick={() => void exportIt()}>Export mapping</button>
          <button className="btn danger" onClick={() => setSheet('delete')}>Delete</button>
        </div>
        {notice && <p className="banner info small">{notice}</p>}
      </section>

      {links.length > 0 && tab === 'board' ? (
        <Board home={home} flags={metrics?.flags ?? []} onMove={(l, s) => void move(l, s)} onOpen={setPreviewing} />
      ) : links.length > 0 && tab === 'metrics' && metrics ? (
        <Metrics model={metrics} />
      ) : links.length === 0 ? (
        <div className="empty card">
          <b>Nothing linked yet</b>
          <span>Link artifacts, customers and conversations, and decision records from your three repos.</span>
          <button className="btn primary" onClick={() => setSheet('link')}>Link items</button>
        </div>
      ) : (
        <>
        {metrics && <MetricStrip model={metrics} onOpen={() => onTab('metrics')} />}
        <div className="home-grid">
          <div className="home-cols">
            <section className="card">
              <h3>Customers</h3>
              {g.customers.length === 0 ? <p className="mut small">No customers or conversations linked.</p> : (
                <ul className="links">
                  {g.customers.map((c) => (
                    <li key={c.key} className="group">
                      {c.customer ? <ul className="links"><Row link={c.customer} /></ul> : <span className="mut small mono">{c.path}</span>}
                      {c.conversations.length > 0 && <ul className="links">{c.conversations.map((l) => <Row key={l.id} link={l} nested />)}</ul>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="card">
              <h3>Artifacts</h3>
              {g.artifacts.length === 0 ? <p className="mut small">No artifacts linked.</p> : g.artifacts.map((group) => (
                <div key={group.type} className="group">
                  <h4>{ARTIFACT_TYPE_LABEL[group.type]}</h4>
                  <ul className="links">{group.links.map((l) => <Row key={l.id} link={l} />)}</ul>
                </div>
              ))}
            </section>
            <section className="card">
              <h3>Decisions</h3>
              {g.decisions.length === 0 ? <p className="mut small">No decision records linked.</p> : (
                <ul className="links">{g.decisions.map((l) => <Row key={l.id} link={l} />)}</ul>
              )}
              {g.decisions.length > 0 && (
                <ApprovalPanel links={g.decisions} states={home.states} host={auth.host} />
              )}
            </section>
          </div>
          <aside className="card viewer preview">
            {!selected ? <p className="mut">Pick an item to preview it.</p> : (
              <>
                <div className="hd">
                  <div>
                    <h3>{selected.title}</h3>
                    <span className="mut small">{ROLE_LABEL[selected.role]} · {selected.repoFullName} · {describeTarget(selected)}</span>
                    <span className="mut small">{selected.stage ? `Stage: ${STAGE_LABEL[selected.stage]}` : 'Unstaged'}</span>
                  </div>
                  <div className="pa">
                    {selected.kind === 'artifact' && selected.health.state !== 'broken' && <button className="btn small-btn" onClick={() => setWriter({ kind: 'edit', link: selected })}>Edit</button>}
                    {selected.pending && <span className="tag" title="Not on the default branch until its pull request merges">pending · PR #{selected.pending.prNumber}</span>}
                    <button className="btn danger small-btn" onClick={() => void remove(selected)}>Unlink</button>
                  </div>
                </div>
                {selected.kind === 'artifact' && (
                  <label className="setrow small">
                    <span className="mut">Type</span>
                    <select value={selected.artifactType ?? 'other'} onChange={(e) => void setArtifactType(selected, e.target.value as ArtifactType)}>
                      {ARTIFACT_TYPES.map((t) => <option key={t} value={t}>{ARTIFACT_TYPE_LABEL[t]}</option>)}
                    </select>
                  </label>
                )}
                {selected.health.state === 'broken' ? (
                  <div className="banner bad small">
                    <p>{selected.health.reason}</p>
                    {selected.health.movedTo && <p>Same content found at <code className="mono">{selected.health.movedTo}</code>.</p>}
                    <div className="setrow">
                      <button className="btn" onClick={() => setSheet({ relink: selected })}>Relink…</button>
                      <button className="btn danger" onClick={() => void remove(selected)}>Remove link</button>
                    </div>
                  </div>
                ) : (
                  <Preview link={selected} />
                )}
              </>
            )}
          </aside>
        </div>
        </>
      )}

      {writer?.kind === 'conversation' && (
        <ConversationWriter product={product} onClose={() => setWriter(undefined)} onDone={() => { void load().then(() => void check()); changed.current(); }} />
      )}
      {writer?.kind === 'pdr' && (
        <PdrWriter product={product} auth={auth} onClose={() => setWriter(undefined)} onDone={() => { void load().then(() => void check()); changed.current(); }} />
      )}
      {writer && (writer.kind === 'create' || writer.kind === 'edit') && (
        <ArtifactWriter
          mode={writer.kind === 'create' ? { kind: 'create', product, links } : { kind: 'edit', link: writer.link }}
          settings={settings}
          onClose={() => setWriter(undefined)}
          onDone={() => { void load().then(() => void check()); changed.current(); }}
        />
      )}
      {previewing && (
        <Sheet
          name="board-preview"
          title={previewing.title}
          width={640}
          onClose={() => setPreviewing(undefined)}
          footer={
            <>
              {previewing.health.state === 'broken' && <button className="btn" onClick={() => { setSheet({ relink: previewing }); setPreviewing(undefined); }}>Relink…</button>}
              {previewing.kind === 'artifact' && previewing.health.state !== 'broken' && <button className="btn" onClick={() => { setWriter({ kind: 'edit', link: previewing }); setPreviewing(undefined); }}>Edit…</button>}
              <button className="btn" data-autofocus onClick={() => setPreviewing(undefined)}>Close</button>
            </>
          }
        >
          <p className="mut small">{ROLE_LABEL[previewing.role]} · {previewing.repoFullName} · {describeTarget(previewing)}</p>
          {previewing.health.state === 'broken' ? <p className="banner bad small">{previewing.health.reason}</p> : <div className="viewer sheet-preview"><Preview link={previewing} /></div>}
        </Sheet>
      )}
      {sheet === 'edit' && (
        <ProductForm product={product} onClose={() => setSheet(undefined)} onSaved={() => { setSheet(undefined); void load(); onChanged(); }} />
      )}
      {sheet === 'link' && (
        <LinkPicker
          settings={settings}
          existing={links}
          mode={{ kind: 'add' }}
          onClose={() => setSheet(undefined)}
          onPick={async (r) => {
            if (!('add' in r)) return undefined;
            const res = await window.pmworkbench.addLinks(id, r.add);
            if (!res.ok) return res.message;
            setSheet(undefined);
            setNotice(`Linked ${res.value.added} item${res.value.added === 1 ? '' : 's'}${res.value.duplicates ? ` (${res.value.duplicates} already linked)` : ''}.`);
            await load();
            onChanged();
            void check();
            return undefined;
          }}
        />
      )}
      {typeof sheet === 'object' && (
        <LinkPicker
          settings={settings}
          existing={links}
          mode={{ kind: 'relink', link: sheet.relink }}
          onClose={() => setSheet(undefined)}
          onPick={async (r) => {
            if (!('relink' in r)) return undefined;
            const res = await window.pmworkbench.updateLink(sheet.relink.id, r.relink);
            if (!res.ok) return res.message;
            setSheet(undefined);
            setSelected(res.value);
            await check();
            return undefined;
          }}
        />
      )}
      {sheet === 'delete' && (
        <Sheet
          name="delete-product"
          title={`Delete “${product.name}”?`}
          onClose={() => setSheet(undefined)}
          footer={
            <>
              <button className="btn" onClick={() => setSheet(undefined)} data-autofocus>Cancel</button>
              <button className="btn danger solid" onClick={() => void window.pmworkbench.deleteProduct(id).then((r) => { if (r.ok) onDeleted(); else setNotice(r.message); })}>Delete product</button>
            </>
          }
        >
          <p>This removes the product, its objective and its {links.length} link{links.length === 1 ? '' : 's'} from this Mac. Nothing in GitHub changes. Export the mapping first if you might want it back.</p>
        </Sheet>
      )}
    </div>
  );
}
