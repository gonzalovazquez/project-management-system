/**
 * A unified line diff for the write preview. Longest-common-subsequence over lines, grouped into
 * hunks with three lines of context, like `git diff`. Files the app edits are Markdown documents,
 * so the quadratic table is small; past a size cap it falls back to "everything replaced", which
 * is still an honest preview.
 */
const CONTEXT = 3;
const MAX_CELLS = 4_000_000;

type Op = { t: ' ' | '-' | '+'; line: string; a: number; b: number };

function ops(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_CELLS) {
    return [...a.map((line, i) => ({ t: '-' as const, line, a: i, b: 0 })), ...b.map((line, j) => ({ t: '+' as const, line, a: n, b: j }))];
  }
  const w = m + 1;
  const L = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    L[i * w + j] = a[i] === b[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
  }
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: ' ', line: a[i], a: i, b: j }); i++; j++; }
    else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) { out.push({ t: '-', line: a[i], a: i, b: j }); i++; }
    else { out.push({ t: '+', line: b[j], a: i, b: j }); j++; }
  }
  while (i < n) { out.push({ t: '-', line: a[i], a: i, b: j }); i++; }
  while (j < m) { out.push({ t: '+', line: b[j], a: i, b: j }); j++; }
  return out;
}

const lines = (s: string) => (s === '' ? [] : s.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'));

export function unifiedDiff(before: string | null, after: string, path: string): { diff: string; added: number; removed: number } {
  const a = lines(before ?? '');
  const b = lines(after);
  const all = ops(a, b);
  const added = all.filter((o) => o.t === '+').length;
  const removed = all.filter((o) => o.t === '-').length;
  const header = [`--- ${before === null ? '/dev/null' : `a/${path}`}`, `+++ b/${path}`];
  if (!added && !removed) return { diff: header.join('\n'), added, removed };

  // Group changes into hunks, keeping CONTEXT unchanged lines either side.
  const changed = all.map((o, k) => (o.t === ' ' ? -1 : k)).filter((k) => k >= 0);
  const hunks: [number, number][] = [];
  for (const k of changed) {
    const lo = Math.max(0, k - CONTEXT);
    const hi = Math.min(all.length - 1, k + CONTEXT);
    const last = hunks.at(-1);
    if (last && lo <= last[1] + 1) last[1] = hi; else hunks.push([lo, hi]);
  }
  const body: string[] = [];
  for (const [lo, hi] of hunks) {
    const seg = all.slice(lo, hi + 1);
    const aStart = seg.find((o) => o.t !== '+')?.a ?? seg[0].a;
    const bStart = seg.find((o) => o.t !== '-')?.b ?? seg[0].b;
    const aLen = seg.filter((o) => o.t !== '+').length;
    const bLen = seg.filter((o) => o.t !== '-').length;
    body.push(`@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@`);
    for (const o of seg) body.push(`${o.t}${o.line}`);
  }
  return { diff: [...header, ...body].join('\n'), added, removed };
}
