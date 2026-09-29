/**
 * KEINE BESCHRAENKUNG BEIM AENDERN (User-Vorgabe 29.09.2026) — Wegwerf-Projekt PROJECT.
 *  G1 Volltextindex: Schreiben scheitert nie an der tsvector-Groesse (1 MB). 150.000 Zeilen und
 *     ~10 MB werden vollstaendig gespeichert; die Suche findet ein Wort vom Anfang (tsv + tsv_zerlegt).
 *     Geprueft mit genau dem Trigger-SQL aus dist/db/schema.js in einer Transaktion (ROLLBACK).
 *  G2 REST-Body-Limit 64 MB (SYNAPSE_BODY_LIMIT_MB) statt Fastify-Standard 1 MiB.
 *  G3 ops[] ohne 100er-Grenze: plan + commit mit 2.000 Ops, coedit_add mit 150 Ops (gemessen).
 *  G4 Schemas (MCP-stdio, REST files + files_batch) und Guide ohne 100er-/50er-Grenze.
 * AUFRUF: node packages/core/tests/file-batch-grenzen.test.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.PLAENE_TEST_DIST || join(hier, '..', 'dist');
const PROJECT = 'grenzen-test';
const batch = await import(join(dist, 'services', 'file-batch.js'));
const res = await import(join(dist, 'services', 'file-reservations.js'));
const { contentHash } = await import(join(dist, 'services', 'code-write.js'));
const { getPool } = await import(join(dist, 'db', 'client.js'));
const pool = getPool();

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.error('FEHLER  ' + text + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : '')); }
}
const versuch = async (fn) => { try { return await fn(); } catch (e) { return { success: false, error: e?.message ?? String(e) }; } };
async function aufraeumen() {
  await pool.query(`DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project = $1)`, [PROJECT]);
  for (const t of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files', 'agent_events']) await pool.query(`DELETE FROM ${t} WHERE project = $1`, [PROJECT]);
}
const inhalt = async (p) => (await pool.query('SELECT content FROM code_files WHERE project=$1 AND file_path=$2 AND deleted_at IS NULL', [PROJECT, p])).rows[0]?.content ?? null;

try {
  await aufraeumen();

  // ===== G1 Volltextindex ohne Groessengrenze =====
  const schemaJs = readFileSync(join(dist, 'db', 'schema.js'), 'utf8');
  const von = schemaJs.indexOf('CREATE OR REPLACE FUNCTION code_files_tsv');
  const bisMarke = 'EXECUTE FUNCTION code_files_tsv_trigger();';
  const bis = schemaJs.indexOf(bisMarke, von);
  const triggerSql = von >= 0 && bis > von ? schemaJs.slice(von, bis + bisMarke.length) : null;
  pruefe(triggerSql !== null && !/^\s*\/\//m.test(triggerSql), 'G1: Trigger-SQL im dist gefunden, keine //-Kommentare', triggerSql?.slice(0, 200));
  const faelle = [
    ['150k-kurz', Array.from({ length: 150000 }, (_, i) => `z${i + 1}`)],
    ['150k-10mb', Array.from({ length: 150000 }, (_, i) => `const wert_${i} = berechne(eingabe_${i}, faktor_${i % 97}) // zeile ${i} ${'x'.repeat(10)}`)],
  ];
  for (const [name, zeilen] of faelle) {
    zeilen[0] = 'anfangswortalpha ' + zeilen[0];
    const text = zeilen.join('\n') + '\n';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(triggerSql ?? 'SELECT 1');
      const t0 = Date.now();
      const eingefuegt = await versuch(() => client.query(
        `INSERT INTO code_files (id, project, file_path, file_name, file_type, content, content_hash, file_size)
         VALUES (gen_random_uuid()::text, $1, $2, $3, 'ts', $4, $5, $6)`,
        [PROJECT, `src/${name}.ts`, `${name}.ts`, text, contentHash(text), Buffer.byteLength(text)],
      ));
      const ms = Date.now() - t0;
      const gespeichert = eingefuegt.success === false ? null : (await client.query(
        `SELECT length(content) AS laenge,
                tsv @@ to_tsquery('english', 'anfangswortalpha') AS treffer,
                tsv_zerlegt @@ to_tsquery('simple', 'anfangswortalpha') AS treffer_zerlegt
           FROM code_files WHERE project = $1 AND file_path = $2`,
        [PROJECT, `src/${name}.ts`],
      )).rows[0];
      console.log(`MESSUNG G1 ${name}: ${(Buffer.byteLength(text) / 1e6).toFixed(1)} MB, INSERT inkl. Index ${ms} ms`);
      pruefe(gespeichert?.laenge === text.length && gespeichert?.treffer === true && gespeichert?.treffer_zerlegt === true,
        `G1: ${name} (${zeilen.length} Zeilen, ${(Buffer.byteLength(text) / 1e6).toFixed(1)} MB) vollstaendig gespeichert, Suche findet Wort vom Anfang`,
        eingefuegt.success === false ? eingefuegt.error : gespeichert);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }

  // ===== G2 REST-Body-Limit =====
  const server = readFileSync(join(hier, '..', '..', 'rest-api', 'dist', 'server.js'), 'utf8');
  pruefe(/bodyLimit/.test(server) && /SYNAPSE_BODY_LIMIT_MB/.test(server) && /\b64\b/.test(server), 'G2: REST setzt bodyLimit 64 MB, per SYNAPSE_BODY_LIMIT_MB ueberschreibbar', null);

  // ===== G3 viele Ops =====
  const datei = Array.from({ length: 4000 }, (_, i) => `g${i + 1}`).join('\n') + '\n';
  const p0 = await batch.planBatch({ project: PROJECT, agent_id: 'gr-setup', ops: [{ file_path: 'src/g3.ts', action: 'create', content: datei }] });
  await batch.commitBatch({ plan_id: p0.plan_id, agent_id: 'gr-setup' });
  const viele = Array.from({ length: 2000 }, (_, i) => ({ file_path: 'src/g3.ts', action: 'replace_lines', line_start: 2 * i + 1, line_end: 2 * i + 1, content: `G${2 * i + 1}`, anchor_text: `g${2 * i + 1}` }));
  let t0 = Date.now();
  const p1 = await versuch(() => batch.planBatch({ project: PROJECT, agent_id: 'gr-owner', ops: viele }));
  const planMs = Date.now() - t0;
  t0 = Date.now();
  const c1 = p1.plan_id ? await versuch(() => batch.commitBatch({ plan_id: p1.plan_id, agent_id: 'gr-owner' })) : p1;
  const commitMs = Date.now() - t0;
  console.log(`MESSUNG G3: plan 2.000 Ops ${planMs} ms, commit ${commitMs} ms`);
  const ist = (await inhalt('src/g3.ts'))?.split('\n') ?? [];
  pruefe(c1.success === true && c1.committed_ops === 2000 && ist[0] === 'G1' && ist[1] === 'g2' && ist[3998] === 'G3999' && ist[3999] === 'g4000',
    'G3: plan + commit mit 2.000 Ops in einem Plan', { error: p1.error ?? c1.error, ops: c1.committed_ops });
  // coedit_add mit 150 Ops
  const d2 = Array.from({ length: 400 }, (_, i) => `h${i + 1}`).join('\n') + '\n';
  const q0 = await batch.planBatch({ project: PROJECT, agent_id: 'gr-setup', ops: [{ file_path: 'src/g3b.ts', action: 'create', content: d2 }] });
  await batch.commitBatch({ plan_id: q0.plan_id, agent_id: 'gr-setup' });
  await res.addFileReservations({ project: PROJECT, agentId: 'gr-o2', filePaths: ['src/g3b.ts'] });
  const q1 = await batch.planBatch({ project: PROJECT, agent_id: 'gr-o2', ops: [{ file_path: 'src/g3b.ts', action: 'replace_lines', line_start: 400, line_end: 400, content: 'H400', anchor_text: 'h400' }] });
  const beitrag = Array.from({ length: 150 }, (_, i) => ({ file_path: 'src/g3b.ts', action: 'replace_lines', line_start: 2 * i + 1, line_end: 2 * i + 1, content: `B${2 * i + 1}`, anchor_text: `h${2 * i + 1}` }));
  const w = await versuch(() => batch.planBatch({ project: PROJECT, agent_id: 'gr-w2', ops: beitrag }));
  const a = w.coedit_waits ? await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: q1.plan_id, agent_id: 'gr-w2', ops: beitrag })) : w;
  const c2 = a.success ? await versuch(() => batch.commitBatch({ plan_id: q1.plan_id, agent_id: 'gr-o2' })) : a;
  pruefe(a.appended_ops === 150 && c2.success === true && c2.committed_ops === 151, 'G3: coedit_add mit 150 Ops, commit schreibt alle 151', { a: a.error ?? a.appended_ops, c2: c2.error ?? c2.committed_ops });

  // ===== G4 Schemas + Guide =====
  const mcpFiles = await import(join(hier, '..', '..', 'mcp-server', 'dist', 'tools', 'consolidated', 'files.js'));
  const props = mcpFiles.filesTool.definition.inputSchema.properties;
  const grenze = (s) => s?.maxItems === undefined || s.maxItems >= 10000;
  pruefe(grenze(props.ops) && grenze(props.edits) && grenze(props.ops?.items?.properties?.edits), 'G4: MCP-stdio-Schema ohne ops-100/edits-50-Grenze', { ops: props.ops?.maxItems, edits: props.edits?.maxItems });
  const rest = readFileSync(join(hier, '..', '..', 'rest-api', 'dist', 'routes', 'mcp.js'), 'utf8');
  pruefe(!/1\.\.100 Operationen|1\.\.50 Elemente|\(1\.\.100\)|maximal 100/.test(rest) && !/ops: \{[^}]{0,200}maxItems: 100/.test(rest), 'G4: REST-Schemas files + files_batch ohne 100er-/50er-Grenze', null);
  const guide = readFileSync(join(dist, 'guide', 'content.js'), 'utf8');
  pruefe(!/1\.\.100 Operationen|edits \(Array, 1\.\.50/.test(guide), 'G4: Guide nennt keine ops-100-/edits-50-Grenze mehr', guide.match(/.{40}(1\.\.100 Operationen|edits \(Array, 1\.\.50).{40}/)?.[0]);
} catch (err) {
  fehler++;
  console.error('FEHLER  Ausnahme: ' + (err instanceof Error ? err.stack : String(err)));
} finally {
  await aufraeumen().catch(() => null);
  const r = await pool.query(`SELECT (SELECT COUNT(*) FROM file_batch_plans WHERE project=$1)+(SELECT COUNT(*) FROM file_batch_waits WHERE project=$1)+(SELECT COUNT(*) FROM file_reservations WHERE project=$1)+(SELECT COUNT(*) FROM file_versions WHERE project=$1)+(SELECT COUNT(*) FROM code_files WHERE project=$1)+(SELECT COUNT(*) FROM agent_events WHERE project=$1) AS n`, [PROJECT]);
  console.log('REST    ' + r.rows[0].n + ' Zeilen im Testprojekt');
  if (Number(r.rows[0].n) !== 0) fehler++;
}
console.log(fehler === 0 ? 'ERGEBNIS alle Zusagen erfuellt' : 'ERGEBNIS ' + fehler + ' Zusage(n) verletzt');
process.exit(fehler === 0 ? 0 : 1);
