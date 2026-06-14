/**
 * GRAPH-2: Datenzugriff der Graph-View.
 *
 * ALLE Calls laufen ueber apiFetch (api/auth.ts) -> Bearer + Cookie werden
 * same-origin transparent mitgeschickt, 401 fuehrt zentral zum Login.
 * KEINE Port-4280-URLs, KEIN bare fetch.
 *
 * Endpunkte (GRAPH-1/1b API-Vertrag):
 *   GET /api/graph/overview
 *   GET /api/graph/projects/:name/code?symbols=csv
 *   GET /api/graph/projects/:name/file?path=
 *   GET /api/graph/projects/:name/knowledge?layers=
 *   GET /api/graph/projects/:name/timeline
 *   GET /api/graph/projects/:name/knowledge-detail?kind=&ref=&query=
 *   GET /api/graph/projects/:name/diff?path=&versionId=
 */

import { apiFetch } from '../api/auth';

const BASE = '/api/graph';

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await apiFetch(url, signal ? { signal } : {});
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Response-Typen (gemaess GRAPH-1/1b Handoff)
// ---------------------------------------------------------------------------

export interface OverviewProject {
  name: string;
  pfad: string | null;
  enabled: boolean | null;
  running: boolean | null;
  files: number | null;
  vectors: number;
}
export interface OverviewResponse {
  success: boolean;
  quelle: string;
  generatedAt: string;
  projekte: OverviewProject[];
}

export interface CodeNode {
  id: string;
  label: string;
  type: 'file' | 'external' | 'symbol';
  dir?: string;
  ext?: string;
  fnCount?: number;
  usedBy?: number;
  symbolType?: string;
  file?: string;
  line?: number;
}
export interface GraphEdge {
  source: string;
  target: string;
  type: string;
}
export interface CodeResponse {
  success: boolean;
  project: string;
  generatedAt: string;
  counts: {
    files: number;
    imports: number;
    edges: number;
    internalEdges: number;
    externals: number;
    symbols: number;
    symbolTruncated: boolean;
  };
  nodes: CodeNode[];
  edges: GraphEdge[];
}

export interface FileDetailResponse {
  success: boolean;
  project: string;
  filePath: string;
  functions: string[];
  semantic: Array<{ filePath: string; score: number }>;
  knowledge: Array<{ kind: 'memory' | 'thought'; label: string; score: number }>;
}

export interface KnowledgeNode {
  id: string;
  label: string;
  kind: string;
  status?: string;
  category?: string;
  source?: string;
  meta?: string;
  refId?: string;
}
export interface KnowledgeResponse {
  success: boolean;
  project: string;
  counts: {
    tasks: number;
    tasksTotal: number;
    memories: number;
    thoughts: number;
    proposals: number;
    tags: number;
  };
  nodes: KnowledgeNode[];
  edges: GraphEdge[];
}

export interface TimelineItem {
  ts: string;
  type: 'thought' | 'memory' | 'proposal' | 'task' | 'files' | 'shell';
  title: string;
  detail?: string;
  ref?: string;
  files?: Array<{ path: string; version?: string } | string>;
}
export interface TimelineResponse {
  success: boolean;
  project: string;
  items: TimelineItem[];
}

export interface KnowledgeDetailResponse {
  success: boolean;
  project: string;
  kind: string;
  ref: string;
  content: string;
  tags: string[];
  linkedPaths: string[];
  neighbors: Array<{ nodeId: string; kind: string; label: string; score: number }>;
}

export interface DiffResponse {
  success: boolean;
  filePath: string;
  fromVersion: string | null;
  toVersion: string | null;
  firstVersion: boolean;
  diff: Array<{ t: ' ' | '+' | '-' | '~'; line: string }>;
}

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

const enc = encodeURIComponent;

export function fetchOverview(signal?: AbortSignal) {
  return getJson<OverviewResponse>(`${BASE}/overview`, signal);
}

export function fetchCode(project: string, symbols: string[], signal?: AbortSignal) {
  const q = symbols.length ? `?symbols=${symbols.map(enc).join(',')}` : '';
  return getJson<CodeResponse>(`${BASE}/projects/${enc(project)}/code${q}`, signal);
}

export function fetchFileDetail(project: string, path: string, signal?: AbortSignal) {
  return getJson<FileDetailResponse>(
    `${BASE}/projects/${enc(project)}/file?path=${enc(path)}`,
    signal,
  );
}

export function fetchKnowledge(project: string, layers: string[], signal?: AbortSignal) {
  return getJson<KnowledgeResponse>(
    `${BASE}/projects/${enc(project)}/knowledge?layers=${layers.map(enc).join(',')}`,
    signal,
  );
}

export function fetchTimeline(project: string, signal?: AbortSignal) {
  return getJson<TimelineResponse>(`${BASE}/projects/${enc(project)}/timeline`, signal);
}

export function fetchKnowledgeDetail(
  project: string, kind: string, ref: string, query: string, signal?: AbortSignal,
) {
  return getJson<KnowledgeDetailResponse>(
    `${BASE}/projects/${enc(project)}/knowledge-detail?kind=${enc(kind)}&ref=${enc(ref)}&query=${enc(query.slice(0, 300))}`,
    signal,
  );
}

export function fetchDiff(project: string, path: string, versionId: string, signal?: AbortSignal) {
  return getJson<DiffResponse>(
    `${BASE}/projects/${enc(project)}/diff?path=${enc(path)}&versionId=${enc(versionId)}`,
    signal,
  );
}
