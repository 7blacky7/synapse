#!/usr/bin/env node
// backfill-flow.mjs — Backfillt NUR die Ablauf-Ebene (code_statements + code_call_edges)
// fuer bereits indexierte Projekte, OHNE Embeddings/Qdrant/code_chunks/code_symbols anzufassen.
//
// Hintergrund: parseAndEmbed hat einen Idempotenz-Skip (bereits-embeddete Dateien werden
// uebersprungen) → ein normaler Reparse traegt die neue Flow-Ebene bei bestehenden Projekten
// NICHT nach. Dieses Script parst den Datei-Inhalt (aus code_files.content) erneut und schreibt
// ausschliesslich statements + callEdges (gleiche advisory-lock + Batch-Logik wie code.ts).
//
// Nutzung:
//   node scripts/backfill-flow.mjs <project>     # ein Projekt
//   node scripts/backfill-flow.mjs --all          # alle Projekte
//   node scripts/backfill-flow.mjs --all --min-files=3   # Projekte mit >= N Dateien

import fs from 'node:fs';

const args = process.argv.slice(2);
const ALL = args.includes('--all');
const SKIP_DONE = args.includes('--skip-done');
const minFiles = parseInt((args.find(a => a.startsWith('--min-files=')) || '').split('=')[1] || '1', 10);
const singleProject = args.find(a => !a.startsWith('--'));

if (!ALL && !singleProject) {
  console.error('Usage: node scripts/backfill-flow.mjs <project> | --all [--min-files=N]');
  process.exit(1);
}

const { getPool } = await import('../packages/core/dist/index.js');
const { getParserForFile } = await import('../packages/core/dist/parser/index.js');

const pool = getPool();

async function persistFlow(client, project, filePath, statements, callEdges) {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`statements:${project}:${filePath}`]);
  await client.query('DELETE FROM code_call_edges WHERE project = $1 AND file_path = $2', [project, filePath]);
  await client.query('DELETE FROM code_statements WHERE project = $1 AND file_path = $2', [project, filePath]);

  const tempToDbId = new Map();
  if (statements && statements.length > 0) {
    const P = 18, BATCH = 2000;
    for (let i = 0; i < statements.length; i += BATCH) {
      const slice = statements.slice(i, i + BATCH);
      const vals = [];
      const rows = slice.map((st, j) => {
        const b = j * P;
        vals.push(
          project, filePath,
          st.scope_type ?? null, st.scope_name ?? null,
          st.statement_type, st.node_kind ?? null,
          st.line_start, st.line_end ?? null,
          st.order_index, st.depth,
          st.text ?? null, st.callee ?? null, st.receiver ?? null,
          st.assigned_to ?? null, st.condition_text ?? null,
          st.is_top_level, st.is_awaited,
          st.metadata ? JSON.stringify(st.metadata) : null
        );
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},NULL,$${b+11},$${b+12},$${b+13},$${b+14},$${b+15},$${b+16},$${b+17},$${b+18})`;
      });
      const res = await client.query(
        `INSERT INTO code_statements
           (project, file_path, scope_type, scope_name, statement_type, node_kind,
            line_start, line_end, order_index, depth, parent_statement_id,
            text, callee, receiver, assigned_to, condition_text,
            is_top_level, is_awaited, metadata)
         VALUES ${rows.join(',')} RETURNING id`,
        vals
      );
      res.rows.forEach((r, j) => tempToDbId.set(slice[j].temp_id, String(r.id)));
    }
    const childIds = [], parentIds = [];
    for (const st of statements) {
      if (!st.parent_temp_id) continue;
      const c = tempToDbId.get(st.temp_id), p = tempToDbId.get(st.parent_temp_id);
      if (c && p) { childIds.push(c); parentIds.push(p); }
    }
    if (childIds.length > 0) {
      await client.query(
        `UPDATE code_statements AS cs SET parent_statement_id = v.parent
           FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::bigint[]) AS parent) AS v
          WHERE cs.id = v.id`,
        [childIds, parentIds]
      );
    }
  }

  if (callEdges && callEdges.length > 0) {
    const P = 9, BATCH = 5000;
    for (let i = 0; i < callEdges.length; i += BATCH) {
      const slice = callEdges.slice(i, i + BATCH);
      const vals = [];
      const rows = slice.map((ce, j) => {
        const b = j * P;
        const stmtId = ce.statement_temp_id ? tempToDbId.get(ce.statement_temp_id) ?? null : null;
        vals.push(
          project, filePath,
          ce.caller_scope ?? null, stmtId,
          ce.callee_name, ce.callee_receiver ?? null,
          ce.line_number, ce.call_kind ?? null,
          ce.confidence ?? 1.0
        );
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},NULL,$${b+7},$${b+8},$${b+9})`;
      });
      await client.query(
        `INSERT INTO code_call_edges
           (project, file_path, caller_scope, statement_id, callee_name,
            callee_receiver, target_symbol_id, line_number, call_kind, confidence)
         VALUES ${rows.join(',')}`,
        vals
      );
    }
  }
  await client.query('COMMIT');
}

async function backfillProject(project) {
  if (SKIP_DONE) {
    const done = await pool.query('SELECT count(*)::int c FROM code_statements WHERE project = $1', [project]);
    if (done.rows[0].c > 0) { console.log(`[${project}] uebersprungen (bereits ${done.rows[0].c} statements)`); return { skipped: true }; }
  }
  const r = await pool.query(
    'SELECT file_path, content FROM code_files WHERE project = $1 AND content IS NOT NULL ORDER BY file_path',
    [project]
  );
  let ok = 0, skip = 0, fail = 0, stmtTotal = 0, edgeTotal = 0;
  for (const row of r.rows) {
    const filePath = row.file_path;
    const parser = getParserForFile(filePath);
    if (!parser) { skip++; continue; }
    // Aktuelle Datei festhalten → bei Parser-Hang (CPU-Endlosschleife) zeigt
    // /tmp/backfill-current.txt den Uebeltaeter, da parser.parse synchron ist.
    try { fs.writeFileSync('/tmp/backfill-current.txt', `${project} :: ${filePath}\n`); } catch {}
    let parseResult;
    try {
      parseResult = parser.parse(row.content, filePath);
    } catch {
      fail++; continue;
    }
    const statements = parseResult.statements;
    const callEdges = parseResult.callEdges;
    if ((!statements || statements.length === 0) && (!callEdges || callEdges.length === 0)) {
      skip++; continue;
    }
    const client = await pool.connect();
    try {
      await persistFlow(client, project, filePath, statements, callEdges);
      ok++;
      stmtTotal += statements?.length ?? 0;
      edgeTotal += callEdges?.length ?? 0;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      fail++;
      if (fail <= 3) console.error(`  FEHLER ${filePath}: ${e.message}`);
    } finally {
      client.release();
    }
  }
  console.log(`[${project}] ${r.rows.length} Dateien → ok=${ok} skip=${skip} fail=${fail} | statements=${stmtTotal} callEdges=${edgeTotal}`);
  return { ok, skip, fail, stmtTotal, edgeTotal };
}

let projects;
if (ALL) {
  const pr = await pool.query(
    `SELECT project, count(*)::int c FROM code_files WHERE content IS NOT NULL
     GROUP BY project HAVING count(*) >= $1 ORDER BY c DESC`,
    [minFiles]
  );
  projects = pr.rows.map(x => x.project);
  console.log(`[backfill-flow] ${projects.length} Projekte (>= ${minFiles} Dateien)`);
} else {
  projects = [singleProject];
}

const t0 = Date.now();
for (const p of projects) {
  await backfillProject(p);
}
console.log(`[backfill-flow] FERTIG in ${((Date.now() - t0) / 1000).toFixed(1)}s fuer ${projects.length} Projekt(e)`);
await pool.end();
