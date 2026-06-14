/**
 * Synapse API - Graph Routes (PLAN-003 / GRAPH-1)
 *
 * Portierung der synapse-graph Standalone-Aggregationen (server.mjs) in die
 * REST-API. Statt HTTP-Self-Calls (fetchJson/callMcp) auf die eigene API werden
 * die Daten DIREKT aus @synapse/core geholt (PG + Qdrant) — schneller, kein
 * Self-Auth, kein Loopback.
 *
 * Endpunkte (alle unter /api/graph/* -> automatisch hinter dem globalen
 * Auth-Hook AUTH-4):
 *   GET /api/graph/overview                  -> Projektliste + Gewichte (Files/Vektoren)
 *   GET /api/graph/projects/:name/code       -> Datei-Graph (Import-Kanten) + Symbol-Ebenen
 *   GET /api/graph/projects/:name/file       -> Datei-Details (Funktionen + Qdrant-Nachbarn + Wissen)  (?path=)
 *   GET /api/graph/projects/:name/knowledge  -> Wissens-Graph (Plan/Tasks/Memories/Thoughts/Proposals/Tags)
 *   GET /api/graph/projects/:name/knowledge-detail -> Wissens-Detail (Volltext + semantische Nachbarn) (?kind=&ref=&query=)
 *   GET /api/graph/projects/:name/timeline   -> Chronik (file_versions/shell/thoughts/memories/proposals/tasks)
 *   GET /api/graph/projects/:name/diff       -> Datei-Diff zweier Versionen  (?path=&versionId=)
 *
 * Alle Responses sind Cytoscape-freundlich: { nodes, edges, counts, ... }.
 */

import { FastifyInstance } from 'fastify';
import {
  // Code-Intel (PG)
  getProjectTree,
  getFunctions,
  getSymbols,
  getFileContent,
  // Semantik (Qdrant)
  searchCode,
  searchMemories,
  searchThoughts,
  // Wissen
  getPlan,
  listMemories,
  getThoughts,
  listProposals,
  // Stats / Projekte
  listCollections,
  getProjectStats,
  getCollectionStats,
  // Versionen (PG)
  listFileVersions,
  getFileVersion,
  listFileHistory,
  // Chronik-Zusatzquellen
  getShellJobs,
  isDaemonAliveForProject,
  getPool,
  // Wissens-Detail
  getMemoryByName,
  getThoughtsByIds,
  getProposal,
} from '@synapse/core';

// ───────────────────────── Konstanten ─────────────────────────
const SYMBOL_TYPES = ['function', 'variable', 'string', 'class', 'interface', 'todo', 'route', 'table'];
const SYMBOL_CAP = 250;
const KNOW_CAPS = { tasks: 120, memories: 200, thoughts: 200, proposals: 120 };

// ───────────────────────── Helper: Import-Aufloesung ─────────────────────────
// (1:1 portiert aus synapse-graph/server.mjs — heuristische Spec->Datei-Aufloesung)

interface ImportSymbol {
  file_path?: string | null;
  name?: string | null;
  value?: string | null;
}

function pickSpec(imp: ImportSymbol): string {
  const cands = [imp.value, imp.name].map((s) => String(s ?? '').trim());
  return cands.find((s) => s && !/\s/.test(s)) ?? '';
}

function resolveRelative(fromFile: string, spec: string): string {
  const stack = fromFile.split('/').slice(0, -1);
  for (const part of spec.split('/')) {
    if (part === '' || part === '.') continue;
    else if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

function candidates(base: string, srcExt = ''): string[] {
  const list = [base];
  if (srcExt) list.push(`${base}.${srcExt}`);
  if (/\.(js|mjs|cjs)$/.test(base)) {
    list.push(base.replace(/\.(js|mjs|cjs)$/, '.ts'), base.replace(/\.(js|mjs|cjs)$/, '.tsx'));
  }
  list.push(
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}.py`, `${base}.moo`,
    `${base}/index.ts`, `${base}/index.js`,
  );
  return list;
}

function buildBasenameIndex(fileSet: Set<string>): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const fp of fileSet) {
    const base = fp.split('/').pop() ?? fp;
    const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
    for (const key of new Set([base, stem])) {
      if (!idx.has(key)) idx.set(key, []);
      idx.get(key)!.push(fp);
    }
  }
  return idx;
}

function resolveSpec(
  src: string,
  spec: string,
  fileSet: Set<string>,
  basenameIdx: Map<string, string[]>,
): string | null {
  const srcExt = src.includes('.') ? src.split('.').pop()!.toLowerCase() : '';
  if (spec.startsWith('.')) {
    const base = resolveRelative(src, spec);
    return candidates(base, srcExt).find((c) => fileSet.has(c)) ?? null;
  }
  const ws = spec.match(/^@[^/]+\/([^/]+)(?:\/(.+))?$/);
  if (ws) {
    const [, pkg, sub] = ws;
    const bases = sub
      ? [`packages/${pkg}/src/${sub}`, `packages/${pkg}/${sub}`]
      : [`packages/${pkg}/src/index`, `packages/${pkg}/index`];
    for (const b of bases) {
      const hit = candidates(b, srcExt).find((c) => fileSet.has(c));
      if (hit) return hit;
    }
    return null;
  }
  if (!spec.includes('/')) {
    const dir = src.split('/').slice(0, -1).join('/');
    const local = candidates(dir ? `${dir}/${spec}` : spec, srcExt).find((c) => fileSet.has(c));
    if (local) return local;
    const hits = basenameIdx.get(spec) ?? [];
    const sameExt = srcExt ? hits.filter((h) => h.endsWith(`.${srcExt}`)) : [];
    if (sameExt.length === 1) return sameExt[0];
    if (hits.length === 1) return hits[0];
  }
  return null;
}

function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// ───────────────────────── Helper: Datei-Liste aus Tree-String ─────────────────────────
// getProjectTree() liefert einen formatierten String — wir parsen ihn zu einer
// flachen Pfadliste (gleicher Parser wie im Standalone, aber ohne HTTP).
function parseFileListFromTree(treeStr: string): string[] {
  const files: string[] = [];
  let dir = '';
  for (const line of String(treeStr ?? '').split('\n')) {
    if (line.startsWith('---')) break;
    if (!line.startsWith('  ')) {
      const m = line.match(/^(.*?)\/?\s*\(\d+ Datei/);
      if (m) dir = m[1] === '' || m[1] === '/' ? '' : m[1];
      continue;
    }
    const fname = line.trim();
    if (fname) files.push(dir ? `${dir}/${fname}` : fname);
  }
  return files.filter((f) => !f.startsWith('.synapse/'));
}

async function getFileList(name: string): Promise<string[]> {
  const tree = await getProjectTree(name, { show_lines: false, show_counts: false });
  return parseFileListFromTree(tree);
}

// ───────────────────────── Aggregation: Overview ─────────────────────────
async function buildOverview() {
  const collections = await listCollections();
  const names = new Set(
    collections
      .filter((c) => c.startsWith('project_'))
      // project_<name>_<suffix> -> <name>; einfache Heuristik wie REST projects.ts
      .map((c) => c.replace(/^project_/, '').replace(/_(code|thoughts|memories|proposals|plans|media)$/, '')),
  );
  const projekte = [...names].sort().map((n) => ({
    name: n,
    pfad: null as string | null,
    enabled: null as boolean | null,
    running: null as boolean | null,
    files: null as number | null,
    vectors: null as number | null,
  }));

  // enabled-Flag projekt-weit aus PG (gleiche Quelle wie project-Registry /
  // enabled-sync.ts): EINE Query, danach Map-Lookup pro Projekt.
  const enabledMap = new Map<string, boolean>();
  try {
    const { rows } = await getPool().query<{ name: string; enabled: boolean }>(
      'SELECT name, enabled FROM projects',
    );
    for (const r of rows) enabledMap.set(r.name, r.enabled);
  } catch { /* projects-Tabelle best-effort */ }

  await Promise.all(
    projekte.map(async (p) => {
      // running: Daemon-Heartbeat (frisch <30s) fuer dieses Projekt
      try {
        p.running = await isDaemonAliveForProject(p.name);
      } catch { /* Heartbeat best-effort */ }
      // enabled: aus PG-Map (kann false sein -> nicht auf null zuruecksetzen)
      if (enabledMap.has(p.name)) p.enabled = enabledMap.get(p.name)!;
      try {
        const codeStats = await getProjectStats(p.name);
        let thoughtsCount = 0;
        let memoriesCount = 0;
        try {
          const ts = await getCollectionStats('project_thoughts');
          thoughtsCount = ts?.pointsCount ?? 0;
        } catch { /* Collection evtl. nicht vorhanden */ }
        try {
          const ms = await getCollectionStats('synapse_memories');
          memoriesCount = ms?.pointsCount ?? 0;
        } catch { /* Collection evtl. nicht vorhanden */ }
        p.files = codeStats?.fileCount ?? null;
        p.vectors = (codeStats?.chunkCount ?? 0) + thoughtsCount + memoriesCount;
      } catch { /* Stats best-effort */ }
    }),
  );

  return { success: true, quelle: 'core', generatedAt: new Date().toISOString(), projekte };
}

// ───────────────────────── Aggregation: Projekt-Code-Graph ─────────────────────────
async function buildProjectGraph(name: string, symbolTypes: string[]) {
  const [fileList, imports, fns] = await Promise.all([
    getFileList(name),
    getSymbols(name, 'import'),
    getFunctions(name),
  ]);

  const files = new Map<string, { fnCount: number }>();
  const ensureFile = (fp: string) => {
    if (!files.has(fp)) files.set(fp, { fnCount: 0 });
    return files.get(fp)!;
  };
  for (const fp of fileList) ensureFile(fp);
  for (const fn of fns) if (fn.file_path) ensureFile(fn.file_path).fnCount++;
  for (const imp of imports) if (imp.file_path) ensureFile(imp.file_path);

  const fileSet = new Set(files.keys());
  const basenameIdx = buildBasenameIndex(fileSet);
  const edges = new Map<string, { source: string; target: string; type: string }>();
  const externals = new Map<string, number>();

  for (const imp of imports) {
    const src = imp.file_path;
    const spec = pickSpec(imp as ImportSymbol);
    if (!src || !spec) continue;
    const target = resolveSpec(src, spec, fileSet, basenameIdx);
    if (target && target !== src) {
      const key = `${src}->${target}`;
      if (!edges.has(key)) edges.set(key, { source: src, target, type: 'import' });
    } else if (!target && !spec.startsWith('.')) {
      const pkg = packageName(spec);
      if (!pkg) continue;
      externals.set(pkg, (externals.get(pkg) ?? 0) + 1);
      const key = `${src}->ext:${pkg}`;
      if (!edges.has(key)) edges.set(key, { source: src, target: `ext:${pkg}`, type: 'external' });
    }
  }

  const nodes: Record<string, unknown>[] = [...files.entries()].map(([fp, meta]) => ({
    id: fp,
    label: fp.split('/').pop(),
    dir: fp.split('/').slice(0, -1).join('/'),
    ext: (fp.includes('.') ? fp.split('.').pop()! : '').toLowerCase(),
    type: 'file',
    fnCount: meta.fnCount,
  }));
  for (const [pkg, count] of externals) {
    nodes.push({ id: `ext:${pkg}`, label: pkg, type: 'external', usedBy: count });
  }

  // Zuschaltbare Symbol-Ebenen
  const symbolTruncated: Record<string, number> = {};
  let symbolCount = 0;
  const symEdges: Record<string, unknown>[] = [];
  const seenSym = new Set<string>();
  for (const t of symbolTypes) {
    if (!SYMBOL_TYPES.includes(t)) continue;
    try {
      const syms = await getSymbols(name, t);
      symbolTruncated[t] = Math.max(0, syms.length - SYMBOL_CAP);
      for (const s of syms.slice(0, SYMBOL_CAP)) {
        if (!s.file_path || !fileSet.has(s.file_path)) continue;
        const raw = String(s.name ?? s.value ?? '').trim();
        if (!raw) continue;
        const id = `sym:${t}:${s.file_path}:${s.line_start ?? 0}:${raw.slice(0, 40)}`;
        if (seenSym.has(id)) continue;
        seenSym.add(id);
        nodes.push({
          id,
          label: raw.length > 24 ? `${raw.slice(0, 24)}…` : raw,
          type: 'symbol',
          symbolType: t,
          file: s.file_path,
          line: s.line_start ?? null,
        });
        symEdges.push({ source: s.file_path, target: id, type: 'symbol' });
        symbolCount++;
      }
    } catch {
      symbolTruncated[t] = -1;
    }
  }

  const allEdges = [...edges.values(), ...symEdges];
  const internalEdges = [...edges.values()].filter((e) => e.type === 'import').length;
  return {
    success: true,
    project: name,
    generatedAt: new Date().toISOString(),
    counts: {
      files: fileSet.size,
      imports: imports.length,
      edges: allEdges.length,
      internalEdges,
      externals: externals.size,
      symbols: symbolCount,
      symbolTruncated,
    },
    nodes,
    edges: allEdges,
  };
}

// ───────────────────────── Aggregation: Datei-Details ─────────────────────────
async function buildFileDetails(project: string, filePath: string) {
  let queryText = filePath;
  try {
    const f = await getFileContent(project, filePath, { from: 1, to: 40 });
    queryText = String(f?.content ?? '').slice(0, 600) || filePath;
  } catch { /* Datei evtl. (noch) nicht indexiert */ }

  const [fnList, semResRaw, memResRaw, thoResRaw] = await Promise.allSettled([
    getFunctions(project, filePath),
    searchCode(queryText, project, undefined, 12),
    searchMemories(queryText.slice(0, 400), project, 5),
    searchThoughts(queryText.slice(0, 400), project, 5),
  ]);

  const functions =
    fnList.status === 'fulfilled' ? fnList.value.map((f) => f.name) : [];

  const semantic: { filePath: string; score: number }[] = [];
  const seen = new Set<string>();
  if (semResRaw.status === 'fulfilled') {
    for (const r of semResRaw.value) {
      const fp = r.payload?.file_path;
      if (!fp || fp === filePath || seen.has(fp)) continue;
      if ((r.score ?? 0) < 0.55) continue;
      seen.add(fp);
      semantic.push({ filePath: fp, score: Math.round((r.score ?? 0) * 100) / 100 });
    }
  }

  const knowledge: { kind: string; label: string; score: number }[] = [];
  if (memResRaw.status === 'fulfilled') {
    for (const r of memResRaw.value) {
      if ((r.score ?? 0) < 0.45) continue;
      knowledge.push({ kind: 'memory', label: r.payload?.name ?? '', score: Math.round((r.score ?? 0) * 100) / 100 });
    }
  }
  if (thoResRaw.status === 'fulfilled') {
    for (const r of thoResRaw.value) {
      if ((r.score ?? 0) < 0.45) continue;
      knowledge.push({ kind: 'thought', label: String(r.payload?.content ?? '').slice(0, 60), score: Math.round((r.score ?? 0) * 100) / 100 });
    }
  }
  knowledge.sort((a, b) => b.score - a.score);

  return {
    success: true,
    project,
    filePath,
    functions,
    semantic: semantic.slice(0, 6),
    knowledge: knowledge.slice(0, 8),
  };
}

// ───────────────────────── Aggregation: Wissens-Graph ─────────────────────────
async function buildKnowledgeGraph(name: string, layers: string[]) {
  const want = (l: string) => layers.includes(l);
  const [plan, memories, thoughts, proposals] = await Promise.all([
    getPlan(name).catch(() => null),
    want('memories') ? listMemories(name).catch(() => []) : Promise.resolve([]),
    want('thoughts') ? getThoughts(name, KNOW_CAPS.thoughts).catch(() => []) : Promise.resolve([]),
    want('proposals') ? listProposals(name).catch(() => []) : Promise.resolve([]),
  ]);

  const projId = `proj:${name}`;
  const nodes: Record<string, unknown>[] = [{ id: projId, label: name, kind: 'project' }];
  const edges: Record<string, unknown>[] = [];
  const tagMap = new Map<string, string[]>();
  const collectTags = (nodeId: string, tags?: string[]) => {
    for (const tag of tags ?? []) {
      if (!tagMap.has(tag)) tagMap.set(tag, []);
      tagMap.get(tag)!.push(nodeId);
    }
  };
  const counts = { tasks: 0, tasksTotal: 0, memories: 0, thoughts: 0, proposals: 0, tags: 0 };

  if (plan) {
    nodes.push({ id: 'plan', label: plan.name ?? 'Plan', kind: 'plan', meta: String(plan.description ?? '').slice(0, 400) });
    edges.push({ source: projId, target: 'plan', type: 'has' });
    if (want('tasks')) {
      const all = plan.tasks ?? [];
      counts.tasksTotal = all.length;
      const tasks = [...all]
        .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
        .slice(0, KNOW_CAPS.tasks);
      for (const t of tasks) {
        const id = `task:${t.id}`;
        nodes.push({
          id,
          label: String(t.title ?? t.id).slice(0, 40),
          kind: 'task',
          status: t.status ?? 'todo',
          meta: String(t.description ?? '').slice(0, 400),
        });
        edges.push({ source: 'plan', target: id, type: 'has' });
        counts.tasks++;
      }
    }
  }
  for (const m of memories.slice(0, KNOW_CAPS.memories)) {
    const id = `mem:${m.name}`;
    nodes.push({ id, label: m.name, kind: 'memory', category: m.category ?? 'other', refId: m.name });
    edges.push({ source: projId, target: id, type: 'has' });
    collectTags(id, m.tags);
    counts.memories++;
  }
  for (const t of thoughts) {
    const id = `tho:${t.id}`;
    const text = String(t.content ?? '');
    nodes.push({
      id,
      label: text.slice(0, 32) + (text.length > 32 ? '…' : ''),
      kind: 'thought',
      source: t.source ?? '',
      meta: text.slice(0, 400),
    });
    edges.push({ source: projId, target: id, type: 'has' });
    collectTags(id, t.tags);
    counts.thoughts++;
  }
  for (const p of proposals.slice(0, KNOW_CAPS.proposals)) {
    const id = `prop:${p.id}`;
    nodes.push({
      id,
      label: String(p.description ?? p.id).slice(0, 32),
      kind: 'proposal',
      status: p.status ?? '',
      file: p.filePath ?? null,
      meta: String(p.description ?? '').slice(0, 400),
    });
    edges.push({ source: projId, target: id, type: 'has' });
    collectTags(id, p.tags);
    counts.proposals++;
  }
  if (want('tags')) {
    for (const [tag, ids] of tagMap) {
      if (ids.length < 2) continue;
      const tid = `tag:${tag}`;
      nodes.push({ id: tid, label: `#${tag}`, kind: 'tag' });
      for (const nid of ids) edges.push({ source: nid, target: tid, type: 'tag' });
      counts.tags++;
    }
  }
  return { success: true, project: name, generatedAt: new Date().toISOString(), counts, nodes, edges };
}

// ───────────────────────── Aggregation: Chronik (Timeline) ─────────────────────────
// GRAPH-1b: Vollstaendige Chronik direkt aus @synapse/core (kein Daemon-HTTP,
// kein callMcp). Quellen: file_versions (listFileHistory, pro batch_id
// gruppiert), shell-jobs (getShellJobs), thoughts, memories, proposals,
// plan-tasks. Alle Items in der bestehenden Form {ts,type,title,detail,ref,files?}.
async function buildTimeline(name: string) {
  const [thoughts, memories, proposals, plan, versions, shellJobs] = await Promise.all([
    getThoughts(name, 60).catch(() => []),
    listMemories(name).catch(() => []),
    listProposals(name).catch(() => []),
    getPlan(name).catch(() => null),
    listFileHistory(name, { limit: 150 }).catch(() => []),
    getShellJobs({ project: name, limit: 40 }).catch(() => []),
  ]);

  const items: Record<string, unknown>[] = [];

  // Datei-Versionen: pro Batch EIN Eintrag (reason + agent_note + Datei-Liste);
  // Einzel-Edits (kein batch_id) bleiben einzeln. Gruppierung wie server.mjs.
  const verGroups = new Map<string, { v: typeof versions[number]; files: Map<string, string> }>();
  for (const v of versions) {
    const key = v.batch_id ? `batch:${v.batch_id}` : `v:${v.id}`;
    if (!verGroups.has(key)) verGroups.set(key, { v, files: new Map() });
    const g = verGroups.get(key)!;
    if (!g.files.has(v.file_path)) g.files.set(v.file_path, String(v.id));
  }
  for (const [key, g] of verGroups) {
    const v = g.v;
    items.push({
      ts: v.created_at ?? null,
      type: 'files',
      title: v.reason || `Datei-Änderung (${v.edit_action ?? key})`,
      detail: [
        v.agent_id ? `Agent: ${v.agent_id}` : null,
        v.feature_tag ? `Feature: ${v.feature_tag}` : null,
        v.agent_note ? `KI-Notiz: ${v.agent_note}` : null,
      ].filter(Boolean).join('\n\n'),
      files: [...g.files.entries()].map(([path, version]) => ({ path, version })),
      ref: key,
    });
  }

  // Shell-Job-History (getShellJobs — projekt-gefiltert, neueste zuerst).
  // created_at/completed_at sind Date-Objekte -> als ISO normalisieren, damit
  // die spaetere String-Sortierung mit den ISO-ts der anderen Quellen passt.
  const toIso = (d: Date | string | null | undefined): string | null =>
    d == null ? null : d instanceof Date ? d.toISOString() : String(d);
  for (const j of shellJobs) {
    const cmd = String(j.command ?? '').replace(/\s+/g, ' ');
    items.push({
      ts: toIso(j.created_at ?? j.completed_at ?? null),
      type: 'shell',
      title: cmd.slice(0, 90),
      detail: [
        `Status: ${j.status ?? '?'}${j.exit_code != null ? ` (exit ${j.exit_code})` : ''}`,
        `Agent: ${j.agent_id ?? '?'}`,
        '',
        'Befehl:',
        String(j.command ?? '').slice(0, 600),
      ].join('\n'),
      ref: `shell:${j.id}`,
    });
  }

  for (const t of thoughts) {
    const text = String(t.content ?? '');
    items.push({
      ts: t.timestamp ?? null,
      type: 'thought',
      title: text.slice(0, 90) + (text.length > 90 ? '…' : ''),
      detail: `Quelle: ${t.source ?? '?'}\nTags: ${(t.tags ?? []).join(', ') || '—'}\n\n${text.slice(0, 1000)}`,
      ref: `tho:${t.id}`,
    });
  }
  for (const m of memories) {
    items.push({
      ts: m.updatedAt ?? m.createdAt ?? null,
      type: 'memory',
      title: `Memory „${m.name}“ aktualisiert`,
      detail: `Kategorie: ${m.category ?? '?'}\nTags: ${(m.tags ?? []).join(', ') || '—'}`,
      ref: `mem:${m.name}`,
    });
  }
  for (const p of proposals) {
    items.push({
      ts: p.createdAt ?? null,
      type: 'proposal',
      title: String(p.description ?? p.id).slice(0, 90),
      detail: `Status: ${p.status ?? '?'}\nDatei: ${p.filePath ?? '—'}\nAutor: ${p.author ?? '?'}`,
      files: p.filePath ? [{ path: p.filePath, version: null }] : [],
      ref: `prop:${p.id}`,
    });
  }
  for (const t of plan?.tasks ?? []) {
    items.push({
      ts: t.updatedAt ?? t.createdAt ?? null,
      type: 'task',
      title: `[${t.status ?? 'todo'}] ${String(t.title ?? t.id).slice(0, 80)}`,
      detail: String(t.description ?? '').slice(0, 800) || 'Keine Beschreibung.',
      ref: `task:${t.id}`,
    });
  }

  items.sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')));
  return { success: true, project: name, generatedAt: new Date().toISOString(), items: items.slice(0, 200) };
}

// ───────────────────────── Aggregation: Wissens-Detail ─────────────────────────
// GRAPH-1b: portiert aus synapse-graph/server.mjs (getKnowledgeDetails/
// loadKnowledgeDetails/searchKnowledge) — aber direkt via @synapse/core statt
// HTTP. Liefert den Volltext eines Wissens-Nodes (memory/thought/proposal/task)
// + semantische Nachbarn (memories + thoughts). Response-Form fuer GRAPH-2:
//   { success, kind, ref, content, tags, linkedPaths, neighbors:[{nodeId,kind,label,score}] }
async function buildKnowledgeDetail(
  project: string,
  kind: string,
  ref: string,
  query: string | undefined,
) {
  let content = '';
  let tags: string[] = [];
  let linkedPaths: string[] = [];

  if (kind === 'memory') {
    const m = await getMemoryByName(project, ref).catch(() => null);
    if (m) {
      content = String(m.content ?? '');
      tags = m.tags ?? [];
      linkedPaths = m.linkedPaths ?? [];
    }
  } else if (kind === 'thought') {
    const [t] = await getThoughtsByIds(project, [ref]).catch(() => []);
    if (t) {
      content = String(t.content ?? '');
      tags = t.tags ?? [];
    }
  } else if (kind === 'proposal') {
    const p = await getProposal(project, ref).catch(() => null);
    if (p) {
      content = String(p.description ?? '');
      tags = p.tags ?? [];
      if (p.filePath) linkedPaths = [p.filePath];
    }
  } else if (kind === 'task') {
    const plan = await getPlan(project).catch(() => null);
    const task = (plan?.tasks ?? []).find((t) => String(t.id) === String(ref));
    if (task) content = `${task.title ?? ''}\n\n${task.description ?? ''}`.trim();
  }

  // Semantische Nachbarn: Volltext (oder query/ref als Fallback) gegen
  // memories + thoughts. searchMemories/searchThoughts liefern roh
  // SearchResult { id, score, payload } — Zugriff via r.payload.*.
  const q = (content || query || ref || '').slice(0, 400);
  const neighbors: { nodeId: string; kind: string; label: string; score: number }[] = [];
  if (q) {
    const [memRes, thoRes] = await Promise.allSettled([
      searchMemories(q, project, 8),
      searchThoughts(q, project, 8),
    ]);
    if (memRes.status === 'fulfilled') {
      for (const r of memRes.value) {
        const memName = String(r.payload?.name ?? '');
        if (!memName || (kind === 'memory' && memName === ref)) continue;
        if ((r.score ?? 0) < 0.45) continue;
        neighbors.push({
          nodeId: `mem:${memName}`,
          kind: 'memory',
          label: memName,
          score: Math.round((r.score ?? 0) * 100) / 100,
        });
      }
    }
    if (thoRes.status === 'fulfilled') {
      for (const r of thoRes.value) {
        const tid = String(r.id ?? '');
        if (!tid || (kind === 'thought' && tid === ref)) continue;
        if ((r.score ?? 0) < 0.45) continue;
        const text = String(r.payload?.content ?? '');
        neighbors.push({
          nodeId: `tho:${tid}`,
          kind: 'thought',
          label: text.slice(0, 40),
          score: Math.round((r.score ?? 0) * 100) / 100,
        });
      }
    }
  }
  neighbors.sort((a, b) => b.score - a.score);

  return {
    success: true,
    project,
    kind,
    ref,
    content: content.slice(0, 1200),
    tags,
    linkedPaths,
    neighbors: neighbors.slice(0, 8),
  };
}

// ───────────────────────── Aggregation: Datei-Diff ─────────────────────────
function lineDiff(aText: string, bText: string, cap = 1500): { t: string; line: string }[] {
  const a = String(aText).split('\n').slice(0, cap);
  const b = String(bText).split('\n').slice(0, cap);
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const out: { t: string; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: ' ', line: a[i] });
      i++; j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      out.push({ t: '-', line: a[i] });
      i++;
    } else {
      out.push({ t: '+', line: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ t: '-', line: a[i++] });
  while (j < m) out.push({ t: '+', line: b[j++] });
  // Kontext: nur ±2 Zeilen um Aenderungen, Rest als …
  const keep = new Set<number>();
  out.forEach((l, k) => {
    if (l.t !== ' ') for (let d = -2; d <= 2; d++) keep.add(k + d);
  });
  const compact: { t: string; line: string }[] = [];
  let skipping = false;
  out.forEach((l, k) => {
    if (keep.has(k)) {
      compact.push(l);
      skipping = false;
    } else if (!skipping) {
      compact.push({ t: '~', line: '' });
      skipping = true;
    }
  });
  return compact.slice(0, 800);
}

async function buildDiff(project: string, filePath: string, versionId: string) {
  const list = await listFileVersions(project, filePath, 200);
  const idx = list.findIndex((v) => String(v.id) === String(versionId));
  const cur = idx >= 0 ? list[idx] : null;
  const prev = idx >= 0 && idx + 1 < list.length ? list[idx + 1] : null;

  const fetchContent = async (vid: string | number | null | undefined): Promise<string> => {
    if (vid == null) return '';
    const v = await getFileVersion(String(vid));
    return String(v?.content ?? '');
  };

  const [oldText, newText] = await Promise.all([
    fetchContent(prev?.id ?? null),
    fetchContent(cur?.id ?? versionId),
  ]);

  return {
    success: true,
    filePath,
    fromVersion: prev?.id ?? null,
    toVersion: cur?.id ?? versionId,
    firstVersion: prev == null,
    diff: lineDiff(oldText, newText),
  };
}

// ───────────────────────── Routen-Registrierung ─────────────────────────
function csv(value: string | undefined, fallback: string[] = []): string[] {
  return value ? value.split(',').map((s) => s.trim()).filter(Boolean) : fallback;
}

export async function graphRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /api/graph/overview — Projektliste + Gewichte */
  fastify.get('/api/graph/overview', async (_request, reply) => {
    try {
      return await buildOverview();
    } catch (error) {
      return reply.status(500).send({ success: false, error: { message: String(error) } });
    }
  });

  /** GET /api/graph/projects/:name/code?symbols=function,class — Datei-Graph + Symbol-Ebenen */
  fastify.get<{
    Params: { name: string };
    Querystring: { symbols?: string };
  }>('/api/graph/projects/:name/code', async (request, reply) => {
    const { name } = request.params;
    const symbolTypes = csv(request.query.symbols);
    try {
      return await buildProjectGraph(name, symbolTypes);
    } catch (error) {
      return reply.status(500).send({ success: false, error: { message: String(error) } });
    }
  });

  /** GET /api/graph/projects/:name/file?path=... — Datei-Details (Funktionen + Nachbarn + Wissen) */
  fastify.get<{
    Params: { name: string };
    Querystring: { path?: string };
  }>('/api/graph/projects/:name/file', async (request, reply) => {
    const { name } = request.params;
    const { path } = request.query;
    if (!path) {
      return reply.status(400).send({ success: false, error: { message: 'Query-Parameter "path" ist erforderlich' } });
    }
    try {
      return await buildFileDetails(name, path);
    } catch (error) {
      return reply.status(500).send({ success: false, error: { message: String(error) } });
    }
  });

  /** GET /api/graph/projects/:name/knowledge?layers=tasks,memories,thoughts,proposals,tags */
  fastify.get<{
    Params: { name: string };
    Querystring: { layers?: string };
  }>('/api/graph/projects/:name/knowledge', async (request, reply) => {
    const { name } = request.params;
    const layers = csv(request.query.layers, ['tasks', 'memories', 'thoughts', 'proposals', 'tags']);
    try {
      return await buildKnowledgeGraph(name, layers);
    } catch (error) {
      return reply.status(500).send({ success: false, error: { message: String(error) } });
    }
  });

  /** GET /api/graph/projects/:name/timeline — Chronik */
  fastify.get<{
    Params: { name: string };
  }>('/api/graph/projects/:name/timeline', async (request, reply) => {
    const { name } = request.params;
    try {
      return await buildTimeline(name);
    } catch (error) {
      return reply.status(500).send({ success: false, error: { message: String(error) } });
    }
  });

  /** GET /api/graph/projects/:name/knowledge-detail?kind=&ref=&query= — Wissens-Detail + Nachbarn */
  fastify.get<{
    Params: { name: string };
    Querystring: { kind?: string; ref?: string; query?: string };
  }>('/api/graph/projects/:name/knowledge-detail', async (request, reply) => {
    const { name } = request.params;
    const { kind, ref, query } = request.query;
    if (!kind || !ref) {
      return reply.status(400).send({
        success: false,
        error: { message: 'Query-Parameter "kind" und "ref" sind erforderlich' },
      });
    }
    try {
      return await buildKnowledgeDetail(name, kind, ref, query);
    } catch (error) {
      return reply.status(500).send({ success: false, error: { message: String(error) } });
    }
  });

  /** GET /api/graph/projects/:name/diff?path=...&versionId=... — Datei-Diff */
  fastify.get<{
    Params: { name: string };
    Querystring: { path?: string; versionId?: string };
  }>('/api/graph/projects/:name/diff', async (request, reply) => {
    const { name } = request.params;
    const { path, versionId } = request.query;
    if (!path || !versionId) {
      return reply.status(400).send({
        success: false,
        error: { message: 'Query-Parameter "path" und "versionId" sind erforderlich' },
      });
    }
    try {
      return await buildDiff(name, path, versionId);
    } catch (error) {
      return reply.status(500).send({ success: false, error: { message: String(error) } });
    }
  });
}
