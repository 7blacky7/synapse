/**
 * search_replace eindeutig oder Fehler, search_replace_batch atomar (P15-T10, 11.10.2026).
 * Befund: searchReplaceBatch uebersprang mehrdeutige oder fehlende Suchtexte still, die Aufrufer
 * schrieben trotzdem, sobald ein Edit passte. Einzel-search_replace ersetzte immer ALLE Vorkommen.
 *  M1 findeTreffer: Trefferzahl + Zeilen (LF, CRLF-Variante, Whitespace-tolerant).
 *  M2 searchReplaceEindeutig: 1 Treffer ok; mehrdeutig -> ok:false mit Zeilen, Inhalt unveraendert;
 *     replace_all ersetzt alle; 0 Treffer -> ok:false (auch mit replace_all).
 *  M3 searchReplaceBatch atomar: ein mehrdeutiges/fehlendes Edit -> Original zurueck, failed nennt
 *     index/reason/lines; alles eindeutig -> angewendet, failed leer.
 *  M4 planBatch: search_replace_batch-Op mit mehrdeutigem Edit scheitert, Datei unveraendert;
 *     search_replace-Op mehrdeutig -> Fehler nennt die Zeilen.
 * AUFRUF: node packages/core/tests/search-replace-mehrdeutig.test.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.PLAENE_TEST_DIST || join(hier, '..', 'dist');
const PROJECT = 'mehrdeutig-test';
const cw = await import(join(dist, 'services', 'code-write.js'));
const batch = await import(join(dist, 'services', 'file-batch.js'));
const { getPool } = await import(join(dist, 'db', 'client.js'));
const pool = getPool();

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.error('FEHLER  ' + text + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')); }
}
async function aufraeumen() {
  for (const t of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files', 'agent_events']) await pool.query(`DELETE FROM ${t} WHERE project = $1`, [PROJECT]);
}
async function planFehler(args) {
  try {
    const p = await batch.planBatch(args);
    return { ok: true, p };
  } catch (e) {
    const antwort = batch.planFailureResponse ? batch.planFailureResponse(e) : null;
    return { ok: false, text: JSON.stringify(antwort ?? {}) + ' ' + (e?.message ?? String(e)) };
  }
}
const text = 'a = 1;\nb = 2;\na = 1;\nc = 3;\n';
const json = (x) => JSON.stringify(x);

try {
  await aufraeumen();
  // ===== M1 =====
  const t1 = cw.findeTreffer(text, 'a = 1;');
  pruefe(t1.count === 2 && json(t1.lines) === '[1,3]', 'M1: zwei Treffer in Zeilen 1 und 3', t1);
  const t1b = cw.findeTreffer(text, 'c = 3;');
  pruefe(t1b.count === 1 && json(t1b.lines) === '[4]', 'M1: ein Treffer in Zeile 4', t1b);
  const t1c = cw.findeTreffer(text.replace(/\n/g, '\r\n'), 'a = 1;\nc = 3;', 'x\ny');
  pruefe(t1c.count === 1 && json(t1c.lines) === '[3]' && t1c.suche === 'a = 1;\r\nc = 3;' && t1c.ersatz === 'x\r\ny', 'M1: CRLF-Variante mit Zeile', t1c);
  const t1d = cw.findeTreffer('x\n\tfoo  bar\n', 'foo bar');
  pruefe(t1d.count === 1 && json(t1d.lines) === '[2]', 'M1: Whitespace-tolerant', t1d);
  pruefe(cw.findeTreffer(text, 'fehlt').count === 0, 'M1: kein Treffer');

  // ===== M2 =====
  const r1 = cw.searchReplaceEindeutig(text, 'b = 2;', 'b = 22;');
  pruefe(r1.ok && r1.count === 1 && r1.content === text.replace('b = 2;', 'b = 22;'), 'M2: eindeutiger Treffer ersetzt', r1);
  const r2 = cw.searchReplaceEindeutig(text, 'a = 1;', 'X');
  pruefe(!r2.ok && r2.content === text && r2.count === 2 && json(r2.lines) === '[1,3]'
    && /1, 3/.test(r2.error) && /replace_all/.test(r2.error) && /nichts geschrieben/.test(r2.error), 'M2: mehrdeutig -> ok:false, Zeilen, Hinweis, Inhalt unveraendert', r2);
  const r3 = cw.searchReplaceEindeutig(text, 'a = 1;', 'X', true);
  pruefe(r3.ok && r3.count === 2 && r3.content === 'X\nb = 2;\nX\nc = 3;\n', 'M2: replace_all ersetzt alle', r3);
  const r4 = cw.searchReplaceEindeutig(text, 'zzz', 'y');
  pruefe(!r4.ok && r4.count === 0 && r4.content === text && /0-mal/.test(r4.error), 'M2: 0 Treffer -> ok:false', r4);
  const r5 = cw.searchReplaceEindeutig(text, 'zzz', 'y', true);
  pruefe(!r5.ok && r5.count === 0, 'M2: 0 Treffer mit replace_all -> ok:false', r5);

  // ===== M3 =====
  const b1 = cw.searchReplaceBatch(text, [
    { search: 'b = 2;', replace: 'b = 20;' },
    { search: 'a = 1;', replace: 'Y' },
    { search: 'fehlt', replace: 'z' },
  ]);
  const f = b1.result.failed;
  pruefe(b1.content === text && b1.result.applied === 0 && b1.result.skipped === 3 && f.length === 2
    && f[0].index === 1 && f[0].reason === 'multiple_matches' && f[0].count === 2 && json(f[0].lines) === '[1,3]'
    && f[1].index === 2 && f[1].reason === 'no_match' && f[1].count === 0
    && /Edit 1/.test(f[0].message) && b1.result.warnings.length === 2,
  'M3: ein fehlerhaftes Edit -> nichts angewendet, failed nennt jedes Edit mit Zeilen', b1.result);
  const b2 = cw.searchReplaceBatch(text, [
    { search: 'b = 2;', replace: 'b = 20;' },
    { search: 'a = 1;', replace: 'Y', replace_all: true },
    { search: 'a = 1;\nb', replace: 'nie' },
  ]);
  pruefe(b2.content === text && b2.result.failed.length === 1 && b2.result.failed[0].reason === 'no_match',
    'M3: spaeteres Edit sieht fruehere Aenderungen, scheitert -> Original', b2.result);
  const b3 = cw.searchReplaceBatch(text, [
    { search: 'b = 2;', replace: 'b = 20;' },
    { search: 'a = 1;', replace: 'Y', replace_all: true },
  ]);
  pruefe(b3.content === 'Y\nb = 20;\nY\nc = 3;\n' && b3.result.applied === 2 && b3.result.skipped === 0 && b3.result.failed.length === 0,
    'M3: alles passt -> angewendet, failed leer', b3.result);

  // ===== M4 plan =====
  const p0 = await batch.planBatch({ project: PROJECT, agent_id: 'md-setup', ops: [{ file_path: 'src/m.ts', action: 'create', content: text }] });
  await batch.commitBatch({ plan_id: p0.plan_id, agent_id: 'md-setup' });
  const p1 = await planFehler({ project: PROJECT, agent_id: 'md-a', ops: [{ file_path: 'src/m.ts', action: 'search_replace_batch', edits: [
    { search: 'b = 2;', replace: 'b = 20;' },
    { search: 'a = 1;', replace: 'Y' },
  ] }] });
  pruefe(!p1.ok && /mehrdeutig/.test(p1.text) && /1, 3/.test(p1.text), 'M4: Plan-Op search_replace_batch mit mehrdeutigem Edit scheitert mit Zeilen', p1);
  const p2 = await planFehler({ project: PROJECT, agent_id: 'md-b', ops: [{ file_path: 'src/m.ts', action: 'search_replace', search: 'a = 1;', replace: 'Y' }] });
  pruefe(!p2.ok && /2 matches/.test(p2.text) && /1, 3/.test(p2.text), 'M4: Plan-Op search_replace mehrdeutig nennt Zeilen', p2);
  const ist = (await pool.query('SELECT content FROM code_files WHERE project=$1 AND file_path=$2', [PROJECT, 'src/m.ts'])).rows[0]?.content ?? '';
  pruefe(ist === text, 'M4: Datei unveraendert', ist);
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
