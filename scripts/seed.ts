/**
 * Seeds two sample products against the throwaway test repos, for development and manual checks.
 * Never point this at real work repos.
 *
 *   PMWORKBENCH_HOME=/tmp/pmw npx tsx scripts/seed.ts [--owner gonzalovazquez] [--host github.com] [--assign-roles]
 *
 * Without PMWORKBENCH_HOME it writes to the app's normal data folder
 * (~/Library/Application Support/PM Workbench). --assign-roles also points the three repo roles at
 * <owner>/pm-artifacts, <owner>/pm-crm and <owner>/pm-pdr. Products that already exist by name are
 * left alone, so running it twice is harmless. Most items are placed in a workflow stage; the control
 * book and one Globex conversation are left unstaged so the board's tray has something in it. Nothing here talks to GitHub; open each product in
 * the app to check its links.
 *
 * --with-history backdates "Checkout retry flow" so its flow metrics have something to draw: 10
 * weeks of made-up daily stage counts and stage-entry dates spread over the past two months, plus
 * an "Empty product" with no links. That history is sample data for checking the charts, not
 * anything GitHub said.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createSettingsStore } from '../src/main/app/settings.js';
import { localDate, stageCounts } from '../src/shared/metrics.js';
import { openDatabase } from '../src/main/products/db.js';
import { ProductStore, type NewLink } from '../src/main/products/store.js';
import type { RepoRef, RepoRole } from '../src/shared/ipc.js';

const { values } = parseArgs({
  options: {
    owner: { type: 'string', default: 'gonzalovazquez' }, host: { type: 'string', default: 'github.com' },
    'assign-roles': { type: 'boolean', default: false }, 'with-history': { type: 'boolean', default: false },
  },
});
const owner = values.owner!;
const host = values.host!;
const home = process.env.PMWORKBENCH_HOME ?? join(homedir(), 'Library', 'Application Support', 'PM Workbench');

const repos: Record<RepoRole, string> = { artifacts: `${owner}/pm-artifacts`, crm: `${owner}/pm-crm`, pdr: `${owner}/pm-pdr` };
const ref = (fullName: string): RepoRef => {
  const [o, name] = fullName.split('/');
  const web = host === 'github.com' ? 'https://github.com' : `https://${host}`;
  return { owner: o, name, fullName, defaultBranch: 'main', private: true, htmlUrl: `${web}/${fullName}` };
};
const l = (role: RepoRole, rest: Omit<NewLink, 'role' | 'repoHost' | 'repoFullName'>): NewLink => ({ role, repoHost: host, repoFullName: repos[role], ...rest });

const SAMPLES = [
  {
    input: {
      name: 'Checkout retry flow',
      objective: 'Reduce checkout abandonment caused by failed-payment retries by 20% this quarter.',
      kpis: [{ name: 'Checkout abandonment after a decline', target: '-20%' }, { name: 'Retry attempts allowed', target: '3 in 10 min' }],
    },
    links: [
      l('artifacts', { kind: 'artifact', path: 'control-book/checkout-retry-flow.md', title: 'Control Book — Checkout Retry Flow', artifactType: 'control-book' }),
      l('artifacts', { kind: 'artifact', path: 'exec-comms/2026-10-weekly-update.md', title: 'Weekly Update — 2026-10-12', artifactType: 'exec-comm', stage: 'release' }),
      l('crm', { kind: 'customer', path: 'customers/acme-corp.md', title: 'Acme Corp', stage: 'intake' }),
      l('crm', { kind: 'conversation', path: 'customers/acme-corp.md', anchor: '2026-09-18--checkout-retry-friction', title: '2026-09-18 — Checkout retry friction', stage: 'intake' }),
      l('crm', { kind: 'conversation', path: 'customers/acme-corp.md', anchor: '2026-10-02--follow-up', title: '2026-10-02 — Follow-up', stage: 'problem' }),
      l('pdr', { kind: 'decision', path: 'specs/spec-003-checkout-retry.md', title: 'SPEC-003: Checkout Retry Flow', stage: 'specification' }),
    ],
  },
  {
    input: {
      name: 'Globex renewal',
      objective: 'Renew Globex for another year by addressing the gaps raised at the last business review.',
      kpis: [],
    },
    links: [
      l('crm', { kind: 'customer', path: 'customers/globex.md', title: 'Globex Industries', stage: 'intake' }),
      l('crm', { kind: 'conversation', path: 'customers/globex.md', anchor: '2026-08-30--quarterly-business-review-notes', title: '2026-08-30 — Quarterly business review notes', stage: 'intake' }),
      l('crm', { kind: 'conversation', path: 'customers/globex.md', anchor: '2026-10-10--renewal-prep-call', title: '2026-10-10 — Renewal prep call' }),
      l('artifacts', { kind: 'artifact', path: 'exec-comms/2026-10-weekly-update.md', title: 'Weekly Update — 2026-10-12', artifactType: 'exec-comm' }),
    ],
  },
];

const db = openDatabase(join(home, 'products.db'));
const store = new ProductStore(db);
const existing = new Set(store.listProducts().map((p) => p.name));
for (const s of SAMPLES) {
  if (existing.has(s.input.name)) { console.log(`skip   ${s.input.name} (already exists)`); continue; }
  const p = store.createProduct(s.input);
  const r = store.addLinks(p.id, s.links);
  console.log(`seeded ${s.input.name}: ${r.added} links`);
}

if (values['with-history']) {
  const DAY = 86_400_000;
  const now = Date.now();
  const p = store.listProducts().find((x) => x.name === 'Checkout retry flow');
  if (p) {
    const links = store.links(p.id);
    const entered: Record<string, number> = { intake: 40, problem: 26, specification: 12, release: 3 };
    for (const l of links) if (l.stage) db.prepare('UPDATE links SET stage_entered_at = ? WHERE id = ?').run(new Date(now - (entered[l.stage] ?? 5) * DAY).toISOString(), l.id);
    // Ten weeks of daily counts: items arriving in intake and moving right over time.
    for (let d = 70; d >= 1; d--) {
      const t = 70 - d;
      const counts = { ...stageCounts([]), intake: t < 30 ? 2 + (t > 10 ? 1 : 0) : 2, problem: t > 20 ? (t > 55 ? 1 : 2) : 0, specification: t > 50 ? 1 : 0, release: t > 66 ? 1 : 0, unstaged: 1 };
      db.prepare('INSERT INTO stage_snapshots (product_id, date, counts) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(p.id, localDate(new Date(now - d * DAY)), JSON.stringify(counts));
    }
    console.log('history 70 days of sample stage counts for Checkout retry flow');
  }
  if (!store.listProducts().some((x) => x.name === 'Empty product')) {
    store.createProduct({ name: 'Empty product', objective: '', kpis: [] });
    console.log('seeded Empty product: no links');
  }
}

if (values['assign-roles']) {
  const settings = createSettingsStore(join(home, 'settings.json'));
  await settings.save({ host, repoRoles: { artifacts: ref(repos.artifacts), crm: ref(repos.crm), pdr: ref(repos.pdr) } });
  console.log(`roles  ${Object.values(repos).join(', ')} on ${host}`);
}
console.log(`data   ${home}`);
