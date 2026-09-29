/**
 * search_replace in CRLF-Dateien (Befund 29.09.2026): Agenten schicken mehrzeilige Suchtexte mit \n.
 * In einer Datei mit \r\n fand search_replace sie nicht — die Aenderung scheiterte, obwohl der Text
 * sichtbar dasteht. Jetzt: trifft der Suchtext mit \n nicht, wird er gegen die CRLF-Form geprueft;
 * der Ersatz uebernimmt dann die Zeilenenden der Datei (kein Mischmasch).
 *  C1 searchReplace (Einzel-Aktion files search_replace + Plan-Op) auf CRLF-Inhalt.
 *  C2 searchReplaceBatch.
 *  C3 plan + commit einer search_replace-Op auf einer CRLF-Datei: Treffer, Datei bleibt reines CRLF.
 *  C4 LF-Datei unveraendert; Suchtext, der schon \r\n enthaelt, bleibt wie er ist.
 * AUFRUF: node packages/core/tests/search-replace-crlf.test.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.PLAENE_TEST_DIST || join(hier, '..', 'dist');
const PROJECT = 'crlf-test';
const cw = await import(join(dist, 'services', 'code-write.js'));
const batch = await import(join(dist, 'services', 'file-batch.js'));
const { getPool } = await import(join(dist, 'db', 'client.js'));
const pool = getPool();

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.error('FEHLER  ' + text + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')); }
}
const versuch = async (fn) => { try { return await fn(); } catch (e) { return { success: false, error: e?.message ?? String(e) }; } };
async function aufraeumen() {
  for (const t of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files', 'agent_events']) await pool.query(`DELETE FROM ${t} WHERE project = $1`, [PROJECT]);
}
const crlf = 'function a() {\r\n  return 1;\r\n}\r\n\r\nfunction b() {\r\n  return 2;\r\n}\r\n';
const nurCrlf = (s) => !/(^|[^\r])\n/.test(s);

try {
  await aufraeumen();
  // ===== C1 =====
  const r1 = cw.searchReplace(crlf, 'function b() {\n  return 2;\n}', 'function b() {\n  return 22;\n}');
  pruefe(r1.count === 1 && r1.content.includes('return 22;\r\n}') && nurCrlf(r1.content), 'C1: mehrzeiliger \\n-Suchtext trifft CRLF-Datei, Ersatz behaelt CRLF', { count: r1.count, content: r1.content });
  // ===== C2 =====
  const r2 = cw.searchReplaceBatch(crlf, [{ search: '{\n  return 1;', replace: '{\n  // eins\n  return 1;' }]);
  pruefe(r2.result.applied === 1 && r2.content.includes('{\r\n  // eins\r\n  return 1;') && nurCrlf(r2.content), 'C2: search_replace_batch trifft CRLF, Ersatz CRLF', r2.result);
  // ===== C4 =====
  const lf = crlf.replace(/\r\n/g, '\n');
  const r4 = cw.searchReplace(lf, 'return 1;\n}', 'return 11;\n}');
  pruefe(r4.count === 1 && r4.content === lf.replace('return 1;\n}', 'return 11;\n}'), 'C4: LF-Datei unveraendert behandelt', r4.content);
  const r4b = cw.searchReplace(crlf, 'return 1;\r\n}', 'return 11;\r\n}');
  pruefe(r4b.count === 1 && nurCrlf(r4b.content), 'C4: Suchtext mit \\r\\n trifft wie bisher', r4b.count);
  // ===== C3 plan + commit =====
  const p0 = await batch.planBatch({ project: PROJECT, agent_id: 'crlf-setup', ops: [{ file_path: 'src/w.ts', action: 'create', content: crlf }] });
  await batch.commitBatch({ plan_id: p0.plan_id, agent_id: 'crlf-setup' });
  const p1 = await versuch(() => batch.planBatch({ project: PROJECT, agent_id: 'crlf-a', ops: [{ file_path: 'src/w.ts', action: 'search_replace', search: 'function a() {\n  return 1;\n}', replace: 'function a() {\n  return 100;\n}' }] }));
  const c1 = p1.plan_id && !p1.error ? await versuch(() => batch.commitBatch({ plan_id: p1.plan_id, agent_id: 'crlf-a' })) : p1;
  const ist = (await pool.query('SELECT content FROM code_files WHERE project=$1 AND file_path=$2', [PROJECT, 'src/w.ts'])).rows[0]?.content ?? '';
  pruefe(c1.success === true && ist.includes('return 100;\r\n}') && nurCrlf(ist), 'C3: plan + commit auf CRLF-Datei trifft, Datei bleibt reines CRLF', { error: c1.error ?? p1.error, ist });
} catch (err) {
  fehler++;
  console.error('FEHLER  Ausnahme: ' + (err instanceof Error ? err.stack : String(err)));
} finally {
  await aufraeumen().catch(() => null);
  const r = await pool.query(`SELECT (SELECT COUNT(*) FROM file_batch_plans WHERE project=$1)+(SELECT COUNT(*) FROM file_versions WHERE project=$1)+(SELECT COUNT(*) FROM code_files WHERE project=$1) AS n`, [PROJECT]);
  console.log('REST    ' + r.rows[0].n + ' Zeilen im Testprojekt');
  if (Number(r.rows[0].n) !== 0) fehler++;
}
console.log(fehler === 0 ? 'ERGEBNIS alle Zusagen erfuellt' : 'ERGEBNIS ' + fehler + ' Zusage(n) verletzt');
process.exit(fehler === 0 ? 0 : 1);
