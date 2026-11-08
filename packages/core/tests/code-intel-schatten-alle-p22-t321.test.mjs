/** P22-T321 (Bericht 899e15dd, claude-birke): schatten:'alle' zaehlt nur offene bzw. wirklich faellige committete Plaene, nicht
 * jeden committeten Plan mit JSON/MD-Datei (parser_version bleibt dort NULL) - frueher '76 offene Plaene' bei 0 offenen.
 * Zeit je Stufe: schatten_zeiten nur bei Schatten-Aufrufen ab Einstellwert code_intel_schatten_zeiten_ab_ms (Env nur Rueckfall).
 * Nur synapse_test. Aufruf: node tests/code-intel-schatten-alle-p22-t321.test.mjs
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
const url = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(url.port, '5433'); assert.equal(url.pathname, '/synapse_test');
process.env.QDRANT_URL = 'http://127.0.0.1:9';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.SYNAPSE_PLAN_PRUEFUNG = '0';
const ci = await import('../dist/services/code-intel.js');
const db = await import('../dist/db/client.js');
const core = await import('../dist/index.js');
const grenzen = await import('../dist/services/code-intel-grenzen.js');
const ru = await import('../dist/services/runtime-ueberwachung.js');
// Schwelle per Env-Rueckfall (ohne PG-Wert im Testschema); Puffer von leseCodeIntelGrenzen (30 s) nach jedem Wechsel leeren.
const schwelle = (ms) => { process.env.SYNAPSE_SCHATTEN_ZEITEN_AB_MS = String(ms); grenzen.leereCodeIntelGrenzenCache(); };
const pool = db.getPool();
assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db, 'synapse_test');
const project = 'p22_t321-' + randomUUID();
const hash = (t) => createHash('sha256').update(t).digest('hex');
const bestand = (a) => async () => {
  const functions = await ci.getFunctions(project, a.file_path, a.name, false, undefined);
  return { success: true, functions, count: functions.length, project };
};
const run = (a) => core.mitCodeIntelSchatten('functions', { project, ...a }, bestand(a));
let ok = 0;
const check = (bedingung, name, info) => { assert.ok(bedingung, name + ' ' + JSON.stringify(info ?? null)); ok++; console.log('OK ' + name); };
// parsed:true -> parsed_at deutlich nach updated_at (geparst), parsed:false -> parsed_at NULL (faellig).
const datei = (file_path, content, parsed, pv) => pool.query(
  `INSERT INTO code_files(id,project,file_path,file_name,file_type,file_size,content,content_hash,updated_at,parsed_at,parser_version)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW()-interval '10 minutes',$9,$10)`,
  [randomUUID(), project, file_path, file_path.split('/').at(-1), file_path.split('.').at(-1), Buffer.byteLength(content), content, hash(content),
    parsed ? new Date(Date.now() + 60_000) : null, pv]);
const plan = async (file_path, content) => (await pool.query(
  `INSERT INTO file_batch_plans(project,ops,expected_hashes,previews,status,committed_at)
   VALUES($1,$2::jsonb,$3::jsonb,'[]'::jsonb,'committed',NOW()) RETURNING id::text AS id`,
  [project, JSON.stringify([{ action: 'update', file_path, content }]), JSON.stringify({ [file_path]: hash(content) })])).rows[0].id;
const aufraeumen = async () => {
  for (const sql of ['DELETE FROM file_batch_plans WHERE project=$1', 'DELETE FROM code_files WHERE project=$1', 'DELETE FROM projects WHERE name=$1']) {
    try { await pool.query(sql, [project]); } catch { /* Testdaten bleiben isoliert */ }
  }
};
const vorherAb = process.env.SYNAPSE_SCHATTEN_ZEITEN_AB_MS;
try {
  await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)', [project, 'p22-t321-test', '/tmp/p22-t321-fixture']);
  await datei('src/x.ts', 'export function x(){ return 1; }\n', true, 5);
  // Committeter Plan auf eine geparste JSON-Datei ohne Struktur-Parser (parser_version NULL): NICHT offen, nicht faellig.
  await datei('conf/a.json', '{"a":1}\n', true, null);
  const jsonPlan = await plan('conf/a.json', '{"a":2}\n');
  // Regel 7: Einstellwert im runtime_ueberwachung-Katalog, gleiche Lesestelle wie die anderen code_intel-Werte.
  check(JSON.stringify(ru.RUNTIME_UEBERWACHUNG_EINSTELLUNGEN.code_intel_schatten_zeiten_ab_ms) === JSON.stringify({ art: 'zahl', standard: 1000, min: 0, max: 600000 })
    && grenzen.CODE_INTEL_GRENZEN_STANDARD.schatten_zeiten_ab_ms === 1000,
    'P22-T321 Einstellwert code_intel_schatten_zeiten_ab_ms im Katalog, Standard 1000 (runtime-ueberwachung.ts)', ru.RUNTIME_UEBERWACHUNG_EINSTELLUNGEN.code_intel_schatten_zeiten_ab_ms);
  delete process.env.SYNAPSE_SCHATTEN_ZEITEN_AB_MS; grenzen.leereCodeIntelGrenzenCache();
  const gStd = await grenzen.leseCodeIntelGrenzen();
  check(typeof gStd.schatten_zeiten_ab_ms === 'number' && gStd.quelle.schatten_zeiten_ab_ms !== 'env', 'P22-T321 leseCodeIntelGrenzen liefert die Schwelle ohne Env', { wert: gStd.schatten_zeiten_ab_ms, quelle: gStd.quelle.schatten_zeiten_ab_ms });
  schwelle(100000);
  const gEnv = await grenzen.leseCodeIntelGrenzen();
  check(gStd.quelle.schatten_zeiten_ab_ms !== 'standard' || (gEnv.schatten_zeiten_ab_ms === 100000 && gEnv.quelle.schatten_zeiten_ab_ms === 'env'),
    'P22-T321 Env nur Rueckfall ohne PG-Wert (code-intel-grenzen.ts)', { wert: gEnv.schatten_zeiten_ab_ms, quelle: gEnv.quelle.schatten_zeiten_ab_ms });
  const r1 = await run({ schatten: 'alle', file_path: 'src/x.ts' });
  check(r1.success === true && r1.ohne_bezug === undefined && typeof r1.schatten_hinweis === 'string',
    'P22-T321 committeter Plan mit geparster JSON-Datei (parser_version NULL) zaehlt nicht als offen (code-intel-schatten.ts SCHATTEN_ALLE_PLAENE_SQL)',
    { ohne_bezug: r1.ohne_bezug, hinweis: r1.schatten_hinweis });
  check(r1.schatten_zeiten === undefined, 'P22-T321 schnelle Antwort unter der Schwelle ohne schatten_zeiten (Goldens bleiben bytegleich)', r1.schatten_zeiten);

  // Committeter Plan mit wirklich faelliger Datei (parsed_at NULL) bleibt im Schatten - ohne Bezug zu src/x.ts gezaehlt.
  await datei('src/offen.ts', 'export function offen(){ return 2; }\n', false, null);
  await plan('src/offen.ts', 'export function offen(){ return 3; }\n');
  const r2 = await run({ schatten: 'alle', file_path: 'src/x.ts' });
  check(r2.ohne_bezug === 1 && /1 offener Plan ohne Bezug zu src\/x\.ts/.test(String(r2.ohne_bezug_hinweis)),
    'P22-T321 committeter Plan mit faelliger Datei bleibt Teil von schatten:alle', { ohne_bezug: r2.ohne_bezug, hinweis: r2.ohne_bezug_hinweis });

  // Gegenpruefung claude-eiche: OFFENE Plaene zaehlen immer (auch ohne faellige Datei), und die gezielte plan_id eines committeten,
  // nicht faelligen Plans bleibt waehlbar wie vorher (eigene Abfrage, code-intel-schatten.ts mitCodeIntelSchattenKern).
  await pool.query(`INSERT INTO file_batch_plans(project,ops,expected_hashes,previews,status) VALUES($1,$2::jsonb,$3::jsonb,'[]'::jsonb,'open')`,
    [project, JSON.stringify([{ action: 'update', file_path: 'conf/b.json', content: '{"b":2}\n' }]), JSON.stringify({ 'conf/b.json': hash('{"b":1}\n') })]);
  const rOffen = await run({ schatten: 'alle', file_path: 'src/x.ts' });
  check(rOffen.ohne_bezug === 2, 'P22-T321 offener Plan ohne faellige Datei bleibt Teil von schatten:alle (SCHATTEN_ALLE_PLAENE_SQL status open)', { ohne_bezug: rOffen.ohne_bezug, hinweis: rOffen.ohne_bezug_hinweis });
  const rGezielt = await run({ schatten: jsonPlan, file_path: 'src/x.ts' });
  check(rGezielt.error !== 'Offener Plan in diesem Projekt nicht gefunden', 'P22-T321 gezielte plan_id eines committeten, nicht faelligen Plans bleibt waehlbar (Verhalten unveraendert)', { success: rGezielt.success, error: rGezielt.error });

  // Zeit je Stufe ins Debug (Schwelle 0 = immer).
  schwelle(0);
  const r3 = await run({ schatten: 'alle', file_path: 'src/x.ts' });
  const z = r3.schatten_zeiten;
  check(z && ['plaene_ms', 'gesamt_ms', 'rest_ms'].every((k) => typeof z[k] === 'number' && z[k] >= 0) && z.gesamt_ms >= z.plaene_ms,
    'P22-T321 schatten_zeiten nennt Planauswahl, Gesamtzeit und Rest', z);
  const r4 = await core.mitCodeIntelSchatten('functions', { project, file_path: 'src/x.ts' }, bestand({ file_path: 'src/x.ts' }));
  check(r4.schatten_zeiten === undefined, 'P22-T321 Aufruf ohne schatten bleibt ohne schatten_zeiten', Object.keys(r4));
  console.log('TEST_GRUEN P22-T321 schatten:alle checks=' + ok);
} finally {
  if (vorherAb === undefined) delete process.env.SYNAPSE_SCHATTEN_ZEITEN_AB_MS; else process.env.SYNAPSE_SCHATTEN_ZEITEN_AB_MS = vorherAb;
  await aufraeumen();
  await pool.end();
}
