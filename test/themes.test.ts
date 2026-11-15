import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APPEARANCES, THEME_BASE } from '../src/shared/ipc.js';

const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8');
const block = (theme: string): string => [...css.matchAll(/:root\[data-theme="([a-z]+)"\] \{([^}]*)\}/g)].find((m) => m[1] === theme)?.[2] ?? '';
const tokens = (text: string) => new Set([...text.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]));

describe('colour themes', () => {
  it('every colour theme has a native base and a CSS block', () => {
    for (const t of APPEARANCES.filter((a) => THEME_BASE[a])) {
      expect(['light', 'dark']).toContain(THEME_BASE[t]);
      expect(block(t), t).not.toBe('');
    }
    expect(Object.keys(THEME_BASE).sort()).toEqual(['matrix', 'pink']);
  });

  it('each theme defines every colour token the base light theme defines, including all chart tokens', () => {
    const root = /:root \{([^}]*)\}/.exec(css)![1];
    const needed = [...tokens(root)].filter((t) => t !== '--font' && t !== '--mono');
    for (const t of ['matrix', 'pink']) {
      const have = tokens(block(t));
      expect(needed.filter((n) => !have.has(n)), t).toEqual([]);
      for (const chart of ['--series-1', '--series-2', '--series-3', '--stage-0', '--stage-4', '--status-serious']) expect(have.has(chart), `${t} ${chart}`).toBe(true);
    }
  });
});
