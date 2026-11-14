import { useEffect, useState } from 'react';
import { markdownSections, type Link, type PullDetail } from '../../../shared/products.js';

type Loaded =
  | { kind: 'file'; text: string; truncated: boolean; url: string }
  | { kind: 'pull'; pr: PullDetail };

/** Read-only preview of a linked item: the file, just the linked conversation section, or the pull request. */
export function Preview({ link }: { link: Link }) {
  const [data, setData] = useState<Loaded>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let alive = true;
    setData(undefined);
    setError(undefined);
    const run = async () => {
      if (link.prNumber !== undefined) {
        const r = await window.pmworkbench.readPull(link.role, link.prNumber);
        if (!alive) return;
        if (r.ok) setData({ kind: 'pull', pr: r.value }); else setError(r.message);
        return;
      }
      const r = await window.pmworkbench.readFile(link.role, link.path!);
      if (!alive) return;
      if (!r.ok) { setError(r.message); return; }
      let text = r.value.content;
      if (link.kind === 'conversation' && link.anchor) {
        const s = markdownSections(text).find((x) => x.anchor === link.anchor);
        text = s ? `## ${s.heading}\n\n${s.body}` : '(This section is no longer in the file. Check links to update its status.)';
      }
      setData({ kind: 'file', text, truncated: r.value.truncated, url: r.value.htmlUrl });
    };
    void run();
    return () => { alive = false; };
  }, [link.id, link.path, link.anchor, link.prNumber, link.role, link.kind]);

  if (error) return <p className="small" style={{ color: 'var(--red)' }}>{error}</p>;
  if (!data) return <p className="mut small">Loading preview…</p>;
  if (data.kind === 'pull') {
    const { pr } = data;
    return (
      <>
        <p className="small">
          <span className="tag">{pr.merged ? 'merged' : pr.draft ? 'draft' : pr.state}</span>{' '}
          <span className="mut">{pr.author} wants to merge <code className="mono">{pr.headRef}</code> into <code className="mono">{pr.baseRef}</code></span>
        </p>
        <span className="mut small">{pr.htmlUrl}</span>
        <pre className="mono small">{pr.body || '(No description.)'}</pre>
      </>
    );
  }
  return (
    <>
      <span className="mut small">{data.url}</span>
      {data.truncated && <p className="banner warn small">This file is large; the preview may be cut short.</p>}
      <pre className="mono small">{data.text}</pre>
    </>
  );
}
