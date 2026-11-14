import { REPO_ROLES, type RepoRef, type RepoRole } from '../../shared/ipc.js';
import { ARTIFACT_TYPES, isStage, KINDS_FOR_ROLE, type ArtifactType, type Kpi, type LinkKind, type ProductHome, type WorkflowStage } from '../../shared/products.js';
import type { NewLink } from './store.js';

/**
 * The file a PM exports to share one product's mapping with a teammate. It holds the product, its
 * objective and KPIs, and every link with its repo named by host and full name. It never holds
 * file contents, tokens, or anything from GitHub beyond the reference and a title.
 */
export const MAPPING_FORMAT = 'pm-workbench.product-mapping';
export const MAPPING_VERSION = 1;

export interface MappingLink {
  role: RepoRole;
  kind: LinkKind;
  repo: { host: string; fullName: string };
  path?: string;
  anchor?: string;
  prNumber?: number;
  title: string;
  artifactType?: ArtifactType;
  blobSha?: string;
  stage?: WorkflowStage;
  stageEnteredAt?: string;
}

export interface ProductMapping {
  format: typeof MAPPING_FORMAT;
  version: typeof MAPPING_VERSION;
  exportedAt: string;
  product: { name: string; objective: string; kpis: Kpi[] };
  links: MappingLink[];
}

export function toMapping(home: ProductHome, now: Date): ProductMapping {
  return {
    format: MAPPING_FORMAT,
    version: MAPPING_VERSION,
    exportedAt: now.toISOString(),
    product: { name: home.product.name, objective: home.product.objective, kpis: home.product.kpis.map((k) => ({ name: k.name, target: k.target })) },
    links: home.links.map((l) => {
      const m: MappingLink = { role: l.role, kind: l.kind, repo: { host: l.repoHost, fullName: l.repoFullName }, title: l.title };
      if (l.path !== undefined) m.path = l.path;
      if (l.anchor !== undefined) m.anchor = l.anchor;
      if (l.prNumber !== undefined) m.prNumber = l.prNumber;
      if (l.artifactType !== undefined) m.artifactType = l.artifactType;
      if (l.blobSha !== undefined) m.blobSha = l.blobSha;
      if (l.stage !== undefined) m.stage = l.stage;
      if (l.stageEnteredAt !== undefined) m.stageEnteredAt = l.stageEnteredAt;
      return m;
    }),
  };
}

const MAX_TEXT = 10_000;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = MAX_TEXT): v is string => typeof v === 'string' && v.length <= max;
const optStr = (v: unknown, max = MAX_TEXT) => v === undefined || str(v, max);

export class MappingError extends Error {}

/**
 * Checks an imported file's structure and returns it typed. Throws MappingError on anything that
 * is not a PM Workbench product mapping, so a bad file is rejected before anything is written.
 * Individual links whose repo can't be matched are not an error here; see planImport.
 */
export function parseMapping(text: string): ProductMapping {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new MappingError('This file is not valid JSON.');
  }
  if (!isObj(raw) || raw.format !== MAPPING_FORMAT) throw new MappingError('This file is not a PM Workbench product mapping.');
  if (raw.version !== MAPPING_VERSION) throw new MappingError(`This mapping is version ${String(raw.version)}; this build reads version ${MAPPING_VERSION}.`);
  const p = raw.product;
  if (!isObj(p) || !str(p.name, 200) || !p.name.trim() || !str(p.objective) || !Array.isArray(p.kpis)) throw new MappingError('The product section is missing or malformed.');
  if (p.kpis.length > 50 || !p.kpis.every((k) => isObj(k) && str(k.name, 200) && str(k.target, 500))) throw new MappingError('A KPI is malformed.');
  if (!Array.isArray(raw.links) || raw.links.length > 5000) throw new MappingError('The links section is missing or too large.');
  raw.links.forEach((l, i) => {
    const bad = (why: string) => new MappingError(`Link ${i + 1} is malformed: ${why}.`);
    if (!isObj(l)) throw bad('not an object');
    if (!REPO_ROLES.includes(l.role as RepoRole)) throw bad('unknown role');
    if (!KINDS_FOR_ROLE[l.role as RepoRole].includes(l.kind as LinkKind)) throw bad(`kind "${String(l.kind)}" does not belong to the ${String(l.role)} role`);
    if (!isObj(l.repo) || !str(l.repo.host, 255) || !str(l.repo.fullName, 255) || !/^[^/\s]+\/[^/\s]+$/.test(l.repo.fullName)) throw bad('repo');
    if (!str(l.title, 500)) throw bad('title');
    if (!optStr(l.path, 1024) || !optStr(l.anchor, 500) || !optStr(l.blobSha, 64) || !optStr(l.stage, 100) || !optStr(l.stageEnteredAt, 40)) throw bad('field type');
    if (l.prNumber !== undefined && !(Number.isInteger(l.prNumber) && (l.prNumber as number) > 0)) throw bad('prNumber');
    if (l.path === undefined && l.prNumber === undefined) throw bad('needs a path or a pull request number');
    if (l.kind === 'conversation' && (l.anchor === undefined || l.path === undefined)) throw bad('a conversation needs a file and a section');
    if (l.artifactType !== undefined && !ARTIFACT_TYPES.includes(l.artifactType as ArtifactType)) throw bad('artifactType');
    if (l.stage !== undefined && !isStage(l.stage)) throw bad(`unknown stage "${String(l.stage)}"`);
    if (l.stageEnteredAt !== undefined && Number.isNaN(Date.parse(l.stageEnteredAt as string))) throw bad('stageEnteredAt');
  });
  return raw as unknown as ProductMapping;
}

export interface ImportPlan {
  links: NewLink[];
  unresolved: { title: string; repo: string; reason: string }[];
}

/**
 * Matches each imported link to a repo connected on this machine: same GitHub host, and the repo
 * with that full name is the one assigned to the link's role. Anything else is reported back as
 * unresolved instead of failing the whole import.
 */
export function planImport(m: ProductMapping, host: string, roles: Partial<Record<RepoRole, RepoRef>>): ImportPlan {
  const plan: ImportPlan = { links: [], unresolved: [] };
  const norm = (h: string) => h.trim().toLowerCase();
  for (const l of m.links) {
    const repo = `${l.repo.host}/${l.repo.fullName}`;
    if (norm(l.repo.host) !== norm(host)) {
      plan.unresolved.push({ title: l.title, repo, reason: `It is on ${l.repo.host}, but you are signed in to ${host}.` });
      continue;
    }
    const assigned = roles[l.role];
    if (!assigned) {
      plan.unresolved.push({ title: l.title, repo, reason: `No repo is assigned to the ${l.role} role here.` });
      continue;
    }
    if (assigned.fullName.toLowerCase() !== l.repo.fullName.toLowerCase()) {
      plan.unresolved.push({ title: l.title, repo, reason: `Your ${l.role} role points at ${assigned.fullName}, not ${l.repo.fullName}.` });
      continue;
    }
    plan.links.push({
      role: l.role, kind: l.kind, repoHost: host, repoFullName: assigned.fullName,
      path: l.path, anchor: l.anchor, prNumber: l.prNumber, title: l.title, artifactType: l.artifactType, blobSha: l.blobSha,
      stage: l.stage, stageEnteredAt: l.stageEnteredAt,
    });
  }
  return plan;
}
