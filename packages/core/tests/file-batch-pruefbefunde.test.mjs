/**
 * P15-T17 E3 Teil 2 (11.10.2026): Pruefbefunde an Plan-Ops (file-batch.ts + plan-befunde.ts), Konzept 6236baf2.
 *  T1  Befund an der richtigen Op (Muster error an op 1 von 3), Diff zeigt "!! befund" direkt unter der +-Zeile.
 *  P1  plan_status ohne op_index: pruefung je Op + Befund im Diff; mit op_indices: befunde nur an ihrer Op.
 *  T3  error sperrt commit: pruef_befunde, nichts geschrieben, Plan offen, Abruf/Korrektur/Quittieren-Aufruf.
 *  T2  plan_update (im selben Plan) behebt: Befund weg, commit schreibt.
 *  T4  warning sichtbar, keine Sperre.
 *  T5  Altlast (Muster- und Syntaxfehler in unveraenderten Zeilen) nicht angelastet, keine Sperre, altlasten gezaehlt.
 *  T6  Drift: (a) Datei aussen geaendert -> commit schreibt nicht (stale);
 *          (b) neues error-Muster nach plan -> commit prueft gegen den aktuellen Stand und sperrt.
 *  T7  auto_commit-Ablauf (plan + commit wie die Routen) mit error: nichts geschrieben, Plan offen, Befunde je Op;
 *      per_file_atomic-Ablauf: Datei ohne error committed, Datei mit error bleibt offen.
 *  T8  coedit: Befund an der Op von Autor B, eigene_befunde in Bs Antwort, Sperre nennt B.
 *  T9  Sperre ueberlebt Neustart: Befund in file_batch_plans.befunde; ein NEUER Node-Prozess sperrt den commit ebenso.
 *  T10 Quittieren: Muster mit grund (zu kurz -> abgelehnt), Quittierung bleibt ueber plan_update erhalten, Grund in
 *      file_versions.agent_note; Syntax nur mit Absichtsgrund (Meldung nennt "nur bei absichtlich fehlerhaftem Inhalt").
 *  S1  Schalter FEHLERPRUEFUNG_PLAN=0: keine pruefung, keine Sperre.
 * ABSICHERUNG: nur Test-DB (...:5433/synapse_test); Ollama und Qdrant sind eigene Fakes.
 * AUFRUF: set -a; . <test-db.env>; set +a; node packages/core/tests/file-batch-pruefbefunde.test.mjs  (core bauen)
 */
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
if (!/:5433\/synapse_test(\?|$)/.test(DB_URL)) {
  console.error('ABBRUCH: dieser Test laeuft nur gegen die Test-DB (...:5433/synapse_test).');
  process.exit(2);
}
const MODELL = 'fake-pb-embed:latest';
const PRJ = 'zz-planbefunde';
const A = 'pb-a';
const B = 'pb-b';
const P_ERR = 'f0f0f0f0-1717-4e00-8a17-0000000000e1';
const P_WARN = 'f0f0f0f0-1717-4e00-8a17-0000000000e2';
const P_SPAET = 'f0f0f0f0-1717-4e00-8a17-0000000000e3';

const fake = (antwort) => http.createServer((req, res) => {
  let body = '';
  req.on('data', (s) => { body += s; });
  req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(antwort(req, body))); });
});
const ollama = fake((req, body) => {
  if (req.url === '/api/tags') return { models: [{ name: MODELL, model: MODELL, digest: 'cd'.repeat(32), size: 1000 }] };
  if (req.url === '/api/ps') return { models: [] };
  if (req.url === '/api/show') return { model_info: { 'general.architecture': 'fake', 'fake.embedding_length': 8, 'fake.context_length': 999999 } };
  if (req.url === '/api/embed') { const a = JSON.parse(body); return { embeddings: (Array.isArray(a.input) ? a.input : [a.input]).map(() => [0, 1, 0, 0, 0, 0, 0, 0]) }; }
  return {};
});
const qdrant = fake((req) => (req.method === 'GET' && req.url === '/' ? { title: 'qdrant', version: '1.13.0' } : { status: 'ok', time: 0, result: /points\/search/.test(req.url) ? [] : {} }));
await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
await new Promise((r) => qdrant.listen(0, '127.0.0.1', r));
Object.assign(process.env, {
  EMBEDDING_PROVIDER: 'ollama', OLLAMA_URL: `http://127.0.0.1:${ollama.address().port}`, OLLAMA_MODEL: MODELL,
  QDRANT_URL: `http://127.0.0.1:${qdrant.address().port}`, EMBED_MIN_GAP_MS: '0', SCORE_SCHWELLE_ERROR_PATTERNS: '0.5',
  EMBEDDING_QUERY_PREFIX: '', EMBEDDING_DOC_PREFIX: '', FEHLERMUSTER_WARTE_MS: '50', FEHLERPRUEFUNG_BUDGET_MS: '2000',
});
for (const n of ['EMBEDDING_TARGET_DIM', 'EMBEDDING_PRAEFIXE', 'SYNAPSE_OLLAMA_MODEL_DIGEST', 'SYNAPSE_COMPUTE_NODE', 'SYNAPSE_AGENT_NAME',
  'SYNAPSE_DEFAULT_AGENT_ID', 'FEHLERMUSTER_CACHE_MS', 'FEHLERPRUEFUNG_PLAN', 'FEHLERPRUEFUNG_GUELTIG_MS', 'FEHLERPRUEFUNG_MAX_ANZEIGE']) delete process.env[n];

const hier = dirname(fileURLToPath(import.meta.url));
const dist = join(hier, '..', 'dist');
const lade = (...t) => import(pathToFileURL(join(...t)).href);
const { getConfig } = await lade(dist, 'config.js');
if (/192\.168\.50\.65/.test(getConfig().embeddings.ollama.url + getConfig().qdrant.url)) { console.error('ABBRUCH: Produktion.'); process.exit(2); }
const batch = await lade(dist, 'services', 'file-batch.js');
const res = await lade(dist, 'services', 'file-reservations.js');
const CW = await lade(dist, 'services', 'code-write.js');
const FP = await lade(dist, 'services', 'fehlermuster-pruefung.js');
const db = await lade(dist, 'db', 'client.js');
const pool = db.getPool();

let fehler = 0;
let ok = 0;
function pruefe(b, text, detail) {
  if (b) { ok++; console.log('OK      ' + text); }
  else { fehler++; console.log('FEHLER  ' + text + (detail !== undefined ? '\n        ' + JSON.stringify(detail).slice(0, 1500) : '')); }
}
const versuch = async (fn) => { try { return await fn(); } catch (e) { return { success: false, error: e?.message ?? String(e), _err: e }; } };
const inhalt = (p) => CW.getFileContentFromPg(PRJ, p);
const zeilen = (n) => Array.from({ length: n }, (_, i) => `export const z${i + 1} = ${i + 1};`).join('\n') + '\n';
const planStatus = async (id) => (await pool.query('SELECT status::text AS s FROM file_batch_plans WHERE id = $1::bigint', [id])).rows[0]?.s;
const befundeZeile = async (id) => (await pool.query('SELECT befunde FROM file_batch_plans WHERE id = $1::bigint', [id])).rows[0]?.befunde;
async function aufraeumen() {
  await pool.query(`DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project = $1)`, [PRJ]).catch(() => {});
  for (const t of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files', 'agent_events']) {
    await pool.query(`DELETE FROM ${t} WHERE project = $1`, [PRJ]).catch(() => {});
  }
  await pool.query('DELETE FROM error_patterns WHERE id = ANY($1::uuid[])', [[P_ERR, P_WARN, P_SPAET]]);
}
const muster = (id, severity, signatur, titel) => pool.query(
  `INSERT INTO error_patterns (id, description, fix, severity, model_scope, found_by, found_in_model, status, titel, warum, erkennung, geltung, verweise)
   VALUES ($1, $2, $3, $4, 'all', 'zz', 'opus', 'aktiv', $5, $6, $7::jsonb, NULL, $8::jsonb)`,
  [id, 'ZZ-TEST ' + titel, 'ZZ-TEST fix ' + titel, severity, titel, 'ZZ-TEST warum ' + titel,
    JSON.stringify({ art: 'regex', signatur: [signatur], fenster: 'zeile', version: 1 }), JSON.stringify([{ art: 'memory', name: 'zz-mem' }])]);
async function anlegen(p, t) {
  const x = await batch.planBatch({ project: PRJ, agent_id: 'pb-setup', ops: [{ file_path: p, action: 'create', content: t }] });
  const c = await batch.commitBatch({ plan_id: x.plan_id, agent_id: 'pb-setup' });
  if (!c.success) throw new Error(`anlegen ${p}: ${c.message}`);
}
const sr = (file_path, search, replace) => ({ file_path, action: 'search_replace', search, replace });

try {
  await aufraeumen();
  FP._signaturMusterCacheLeeren();
  FP._syntaxPrueferLeeren();
  await muster(P_ERR, 'error', 'zzPlanVerboten_4K\\(', 'ZZ verbotener Plan-Aufruf');
  await muster(P_WARN, 'warning', 'zzPlanWarnung_4K', 'ZZ Plan-Warnung');
  FP.registriereSyntaxPruefer({
    name: 'zz-sperr', version: '0.1', endungen: ['zzs'], sperrfaehig: true,
    pruefe: (text) => text.split('\n').flatMap((z, i) => (z.includes('KAPUTT') ? [{ zeile: i + 1, spalte: 1, code: 'ZZ1', meldung: 'KAPUTT gefunden', wie: 'KAPUTT entfernen' }] : [])),
  });

  // ===== T1 Befund an der richtigen Op =====
  await anlegen('s/t1.ts', zeilen(40));
  const p1 = await batch.planBatch({ project: PRJ, agent_id: A, ops: [
    { file_path: 's/t1.ts', action: 'replace_lines', line_start: 5, line_end: 5, content: 'export const ok5 = 5;', anchor_text: 'export const z5 = 5;' },
    sr('s/t1.ts', 'export const z20 = 20;', 'zzPlanVerboten_4K(20);'),
    { file_path: 's/t1.ts', action: 'insert_after', after_line: 30, content: 'export const neu31 = 31;', anchor_text: 'export const z30 = 30;' },
  ] });
  const pr1 = p1.pruefung;
  const b1 = pr1?.befunde?.find((b) => b.pattern_id === P_ERR);
  pruefe(pr1?.sperre === true && b1?.op_index === 1 && b1.agent_id === A && b1.zeilen?.[0] === 20 && b1.quelle === 'muster' && b1.status === 'offen'
    && pr1.je_op?.['1']?.error === 1 && !pr1.je_op?.['0'] && !pr1.je_op?.['2'] && pr1.anzahl === 1,
    'T1 plan(): Muster-Befund (error) an op 1 von 3, Z.20, agent pb-a, sperre:true', pr1);
  const t1 = String(p1.diff?.dateien?.[0]?.text ?? '');
  pruefe(b1 && t1.includes(`+zzPlanVerboten_4K(20);\n!! befund ${b1.id} op 1 error`),
    'T1 Diff der plan-Antwort: "!! befund <id> op 1 error" direkt unter der +-Zeile', t1);
  const gespeichert1 = await befundeZeile(p1.plan_id);
  pruefe(gespeichert1?.befunde?.length === 1 && gespeichert1.befunde[0].id === b1?.id, 'T1 Befund klein am Plan gespeichert (file_batch_plans.befunde)', gespeichert1);

  // ===== P1 plan_status =====
  const st1 = await batch.buildPlanStatusResponseMitDiff(await batch.getBatchPlan(p1.plan_id));
  pruefe((st1.pruefung?.op_indices_mit_befund ?? []).join(',') === '1' && String(st1.diff?.dateien?.[0]?.text ?? '').includes(`!! befund ${b1?.id}`),
    'P1 plan_status: pruefung.op_indices_mit_befund [1] und Befund im Diff', { pruefung: st1.pruefung, diff: st1.diff });
  const so1 = await batch.getPlanOpsVollstaendig({ plan_id: p1.plan_id, op_indices: [0, 1] });
  pruefe(!so1.ops?.[0]?.befunde && so1.ops?.[1]?.befunde?.[0]?.id === b1?.id && String(so1.ops?.[1]?.diff?.[0]?.text ?? '').includes('!! befund'),
    'P1 plan_status(op_indices): Befund nur an op 1, im Op-Diff an der +-Zeile', so1.ops);

  // ===== T3 error sperrt commit =====
  const c3 = await batch.commitBatch({ plan_id: p1.plan_id, agent_id: A });
  pruefe(c3.success === false && c3.error === 'pruef_befunde' && c3.status === 'open' && c3.geschrieben === false
    && c3.blockierende?.[0]?.op_index === 1 && c3.blockierende[0].agent_id === A
    && /plan_update/.test(c3.korrektur ?? '') && /befunde_quittieren/.test(c3.quittieren ?? '') && /op_index:1/.test(c3.abruf ?? '')
    && (await inhalt('s/t1.ts')) === zeilen(40) && (await planStatus(p1.plan_id)) === 'open',
    'T3 commit gesperrt (pruef_befunde), nichts geschrieben, Plan offen, Abruf/Korrektur/Quittieren genannt', c3);

  // ===== T2 plan_update behebt =====
  const u2 = await batch.replanBatch({ project: PRJ, plan_id: p1.plan_id, agent_id: A, op_index: 1,
    ops: [sr('s/t1.ts', 'export const z20 = 20;', 'export const sauber20 = 20;')] });
  pruefe(u2.in_place === true && u2.pruefung?.sperre === false && u2.pruefung?.anzahl === 0, 'T2 plan_update im selben Plan: Befund weg, keine Sperre', u2.pruefung);
  const c2 = await batch.commitBatch({ plan_id: p1.plan_id, agent_id: A });
  const i2 = await inhalt('s/t1.ts');
  pruefe(c2.success === true && i2.includes('sauber20') && i2.includes('ok5') && i2.includes('neu31') && !i2.includes('zzPlanVerboten'),
    'T2 commit nach Korrektur schreibt alle 3 Ops', c2);

  // ===== T4 warning: sichtbar, keine Sperre =====
  await anlegen('s/t4.ts', zeilen(20));
  const p4 = await batch.planBatch({ project: PRJ, agent_id: A, ops: [sr('s/t4.ts', 'export const z7 = 7;', 'zzPlanWarnung_4K(7);')] });
  const b4 = p4.pruefung?.befunde?.find((b) => b.pattern_id === P_WARN);
  pruefe(b4?.severity === 'warning' && b4.op_index === 0 && p4.pruefung?.sperre === false && p4.pruefung?.je_op?.['0']?.warning === 1,
    'T4 warning-Befund an op 0 sichtbar, sperre:false', p4.pruefung);
  const c4 = await batch.commitBatch({ plan_id: p4.plan_id, agent_id: A });
  pruefe(c4.success === true && (await inhalt('s/t4.ts')).includes('zzPlanWarnung_4K(7);'), 'T4 commit mit warning schreibt', c4);

  // ===== T5 Altlast nicht angelastet =====
  await CW.createFileInPg(PRJ, 's/t5.ts', zeilen(40).replace('export const z3 = 3;', 'zzPlanVerboten_4K(3);'), 'pb-setup');
  await CW.createFileInPg(PRJ, 's/t5.zzs', 'a\nKAPUTT\n' + Array.from({ length: 20 }, (_, i) => `b${i}`).join('\n') + '\n', 'pb-setup');
  const p5 = await batch.planBatch({ project: PRJ, agent_id: A, ops: [
    sr('s/t5.ts', 'export const z30 = 30;', 'export const neu30 = 30;'),
    sr('s/t5.zzs', 'b15\n', 'B15\n'),
  ] });
  pruefe(p5.pruefung?.sperre === false && p5.pruefung?.anzahl === 0 && p5.pruefung?.altlasten >= 1,
    'T5 Muster- und Syntaxfehler in unveraenderten Zeilen: kein Befund, keine Sperre, altlasten gezaehlt', p5.pruefung);
  const c5 = await batch.commitBatch({ plan_id: p5.plan_id, agent_id: A });
  pruefe(c5.success === true, 'T5 commit trotz Altlasten', c5);

  // ===== T6 Drift =====
  await anlegen('s/t6.ts', zeilen(20));
  const p6 = await batch.planBatch({ project: PRJ, agent_id: A, ops: [sr('s/t6.ts', 'export const z5 = 5;', 'export const neu5 = 5;')] });
  const aussen = zeilen(20) + 'export const aussen = 1;\n';
  await CW.updateFileInPg(PRJ, 's/t6.ts', aussen, 'pb-aussen');
  const c6 = await batch.commitBatch({ plan_id: p6.plan_id, agent_id: A });
  pruefe(c6.success === false && (await inhalt('s/t6.ts')) === aussen, 'T6a Datei aussen geaendert: commit schreibt nicht (stale)', c6);

  await anlegen('s/t6b.ts', zeilen(20));
  const p6b = await batch.planBatch({ project: PRJ, agent_id: A, ops: [sr('s/t6b.ts', 'export const z9 = 9;', 'zzSpaetVerboten_8M(9);')] });
  pruefe(p6b.pruefung?.sperre === false && p6b.pruefung?.anzahl === 0, 'T6b plan(): noch kein Muster -> kein Befund', p6b.pruefung);
  await muster(P_SPAET, 'error', 'zzSpaetVerboten_8M\\(', 'ZZ spaetes Muster');
  FP._signaturMusterCacheLeeren();
  process.env.FEHLERPRUEFUNG_GUELTIG_MS = '0';
  const c6b = await batch.commitBatch({ plan_id: p6b.plan_id, agent_id: A });
  delete process.env.FEHLERPRUEFUNG_GUELTIG_MS;
  pruefe(c6b.error === 'pruef_befunde' && c6b.blockierende?.[0]?.op_index === 0 && (await inhalt('s/t6b.ts')) === zeilen(20),
    'T6b commit prueft gegen den aktuellen Stand neu (neues error-Muster) und sperrt', c6b);
  await batch.cancelBatch(p6b.plan_id, A, 'test');

  // ===== T7 auto_commit-Ablauf =====
  await anlegen('s/t7a.ts', zeilen(10));
  await anlegen('s/t7b.ts', zeilen(10));
  const p7 = await batch.planBatch({ project: PRJ, agent_id: A, ops: [
    sr('s/t7a.ts', 'export const z2 = 2;', 'export const ok2 = 2;'),
    sr('s/t7b.ts', 'export const z4 = 4;', 'zzPlanVerboten_4K(4);'),
  ] });
  const c7 = await batch.commitBatch({ plan_id: p7.plan_id, agent_id: A });
  pruefe(c7.error === 'pruef_befunde' && p7.pruefung?.je_op?.['1']?.error === 1 && c7.pruefung?.je_op?.['1']?.error === 1
    && (await inhalt('s/t7a.ts')) === zeilen(10) && (await inhalt('s/t7b.ts')) === zeilen(10) && (await planStatus(p7.plan_id)) === 'open',
    'T7 auto_commit (plan + commit) mit error: nichts geschrieben, Plan offen, Befunde je Op in plan- und commit-Antwort', { p: p7.pruefung, c: c7 });
  await batch.cancelBatch(p7.plan_id, A, 'test');
  // per_file_atomic: je Datei ein Plan + commit
  const p7a = await batch.planBatch({ project: PRJ, agent_id: A, persist_failed: false, ops: [sr('s/t7a.ts', 'export const z2 = 2;', 'export const ok2 = 2;')] });
  const p7b = await batch.planBatch({ project: PRJ, agent_id: A, persist_failed: false, ops: [sr('s/t7b.ts', 'export const z4 = 4;', 'zzPlanVerboten_4K(4);')] });
  const c7a = await batch.commitBatch({ plan_id: p7a.plan_id, agent_id: A });
  const c7b = await batch.commitBatch({ plan_id: p7b.plan_id, agent_id: A });
  pruefe(c7a.success === true && c7b.error === 'pruef_befunde' && (await inhalt('s/t7a.ts')).includes('ok2') && (await inhalt('s/t7b.ts')) === zeilen(10)
    && (await planStatus(p7b.plan_id)) === 'open',
    'T7 per_file_atomic: Datei ohne error committed, Datei mit error bleibt offener Plan', { c7a: c7a.success, c7b: c7b.error });
  await batch.cancelBatch(p7b.plan_id, A, 'test');

  // ===== T8 coedit: Befund an der Op von B =====
  await anlegen('s/t8.ts', zeilen(40));
  await res.addFileReservations({ project: PRJ, agentId: A, filePaths: ['s/t8.ts'] });
  const p8 = await batch.planBatch({ project: PRJ, agent_id: A, ops: [
    { file_path: 's/t8.ts', action: 'replace_lines', line_start: 2, line_end: 2, content: 'export const owner2 = 2;', anchor_text: 'export const z2 = 2;' },
  ] });
  const bOp = { file_path: 's/t8.ts', action: 'replace_lines', line_start: 30, line_end: 30, content: 'zzPlanVerboten_4K(30);', anchor_text: 'export const z30 = 30;' };
  await batch.planBatch({ project: PRJ, agent_id: B, ops: [bOp] });
  const add8 = await batch.addCoeditContribution({ project: PRJ, plan_id: p8.plan_id, agent_id: B, ops: [bOp] });
  const e8 = add8.eigene_befunde?.[0];
  pruefe(add8.success === true && e8?.op_index === 1 && e8.severity === 'error' && add8.pruefung?.je_op?.['1']?.error === 1 && !add8.pruefung?.je_op?.['0'],
    'T8 coedit_add: Befund an Bs Op (op 1), in Bs Antwort (eigene_befunde)', add8);
  const c8 = await batch.commitBatch({ plan_id: p8.plan_id, agent_id: A });
  pruefe(c8.error === 'pruef_befunde' && c8.blockierende?.[0]?.agent_id === B && c8.blockierende[0].op_index === 1 && c8.message.includes(B)
    && (await inhalt('s/t8.ts')) === zeilen(40),
    'T8 commit des Owners gesperrt, Sperre nennt Autor B und seine Op', c8);

  // ===== T9 Sperre ueberlebt Neustart =====
  await anlegen('s/t9.ts', zeilen(10));
  const p9 = await batch.planBatch({ project: PRJ, agent_id: A, ops: [sr('s/t9.ts', 'export const z3 = 3;', 'zzPlanVerboten_4K(3);')] });
  const g9 = await befundeZeile(p9.plan_id);
  pruefe(g9?.befunde?.some((b) => b.severity === 'error' && b.status === 'offen'), 'T9 offener error-Befund steht in file_batch_plans.befunde', g9);
  const skript = `const b = await import(${JSON.stringify(pathToFileURL(join(dist, 'services', 'file-batch.js')).href)});
const r = await b.commitBatch({ plan_id: ${JSON.stringify(p9.plan_id)}, agent_id: ${JSON.stringify(A)} });
console.log('ERGEBNIS ' + JSON.stringify({ success: r.success, error: r.error, op: r.blockierende?.[0]?.op_index }));
process.exit(0);`;
  const kind = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', skript], { env: { ...process.env, FEHLERPRUEFUNG_GUELTIG_MS: '0' } })
    .catch((e) => ({ stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? e.message) }));
  const zeileK = String(kind.stdout).split('\n').find((z) => z.startsWith('ERGEBNIS '));
  const k9 = zeileK ? JSON.parse(zeileK.slice(9)) : null;
  pruefe(k9?.success === false && k9.error === 'pruef_befunde' && k9.op === 0 && (await inhalt('s/t9.ts')) === zeilen(10),
    'T9 neuer Prozess (ohne Speicherstand, Neupruefung) sperrt den commit ebenso', { k9, stderr: String(kind.stderr ?? '').slice(-400) });
  await batch.cancelBatch(p9.plan_id, A, 'test');

  // ===== T10 Quittieren =====
  await anlegen('s/t10.ts', zeilen(30));
  const p10 = await batch.planBatch({ project: PRJ, agent_id: A, ops: [
    sr('s/t10.ts', 'export const z5 = 5;', 'zzPlanVerboten_4K(5);'),
    sr('s/t10.ts', 'export const z25 = 25;', 'zzPlanVerboten_4K(25);'),
  ] });
  const q0 = p10.pruefung?.befunde?.find((b) => b.op_index === 0);
  const q1 = p10.pruefung?.befunde?.find((b) => b.op_index === 1);
  pruefe(q0 && q1 && q0.id !== q1.id, 'T10 zwei error-Befunde an op 0 und op 1', p10.pruefung);
  const c10a = await batch.commitBatch({ plan_id: p10.plan_id, agent_id: A, befunde_quittieren: [{ id: q0?.id, grund: 'kurz' }] });
  pruefe(c10a.error === 'pruef_befunde' && c10a.quittierung_abgelehnt?.length === 1 && c10a.blockierende?.length === 2,
    'T10 Grund zu kurz: Quittierung abgelehnt, beide sperren weiter', c10a);
  const grund = 'Testfall T10: Aufruf ist hier gewollt';
  const c10b = await batch.commitBatch({ plan_id: p10.plan_id, agent_id: A, befunde_quittieren: [{ id: q0?.id, grund }] });
  pruefe(c10b.error === 'pruef_befunde' && c10b.blockierende?.length === 1 && c10b.blockierende[0].op_index === 1 && c10b.pruefung?.je_op?.['0']?.quittiert === 1,
    'T10 op 0 mit Grund quittiert, op 1 sperrt weiter', c10b);
  const u10 = await batch.replanBatch({ project: PRJ, plan_id: p10.plan_id, agent_id: A, op_index: 1,
    ops: [sr('s/t10.ts', 'export const z25 = 25;', 'export const sauber25 = 25;')] });
  const q0neu = u10.pruefung?.befunde?.find((b) => b.op_index === 0);
  pruefe(u10.pruefung?.sperre === false && q0neu?.status === 'quittiert' && q0neu.quittiert_grund === grund,
    'T10 Quittierung bleibt ueber plan_update (Neupruefung) erhalten', u10.pruefung);
  const c10c = await batch.commitBatch({ plan_id: p10.plan_id, agent_id: A });
  const note10 = (await pool.query(`SELECT agent_note FROM file_versions WHERE project = $1 AND batch_id = $2::bigint`, [PRJ, p10.plan_id])).rows.map((r) => r.agent_note ?? '').join(' ');
  pruefe(c10c.success === true && (await inhalt('s/t10.ts')).includes('zzPlanVerboten_4K(5);') && note10.includes('[Befund quittiert:') && note10.includes(grund),
    'T10 commit nach Quittierung schreibt, Grund in file_versions.agent_note', { c10c: c10c.message ?? c10c.error, note10 });

  await anlegen('s/t10.zzs', 'a\nb\nc\n');
  const p10s = await batch.planBatch({ project: PRJ, agent_id: A, ops: [sr('s/t10.zzs', 'b\n', 'KAPUTT\n')] });
  const s0 = p10s.pruefung?.befunde?.find((b) => b.quelle === 'syntax');
  const c10s = await batch.commitBatch({ plan_id: p10s.plan_id, agent_id: A });
  pruefe(s0?.severity === 'error' && s0.op_index === 0 && c10s.error === 'pruef_befunde' && /nur bei absichtlich fehlerhaftem Inhalt/.test(c10s.quittieren ?? '')
    && (await inhalt('s/t10.zzs')) === 'a\nb\nc\n',
    'T10 Syntaxbefund sperrt, Meldung: nur bei absichtlich fehlerhaftem Inhalt quittierbar', { s0, c10s });
  const c10s2 = await batch.commitBatch({ plan_id: p10s.plan_id, agent_id: A, befunde_quittieren: [{ id: s0?.id, grund: 'Absicht: Negativbeispiel fuer den Parser-Test' }] });
  pruefe(c10s2.success === true && (await inhalt('s/t10.zzs')) === 'a\nKAPUTT\nc\n', 'T10 Syntaxbefund mit Absichtsgrund quittiert -> geschrieben', c10s2);

  // ===== S1 Schalter =====
  await anlegen('s/s1.ts', zeilen(10));
  process.env.FEHLERPRUEFUNG_PLAN = '0';
  const ps1 = await batch.planBatch({ project: PRJ, agent_id: A, ops: [sr('s/s1.ts', 'export const z3 = 3;', 'zzPlanVerboten_4K(3);')] });
  const cs1 = await batch.commitBatch({ plan_id: ps1.plan_id, agent_id: A });
  delete process.env.FEHLERPRUEFUNG_PLAN;
  pruefe(!ps1.pruefung && cs1.success === true, 'S1 FEHLERPRUEFUNG_PLAN=0: keine pruefung, keine Sperre', { p: ps1.pruefung, c: cs1.error });
} catch (error) {
  fehler++;
  console.log('FEHLER  Ausnahme: ' + (error?.stack ?? error));
} finally {
  await aufraeumen().catch((e) => console.log('Aufraeumen: ' + e.message));
  ollama.close();
  qdrant.close();
  console.log(`\n${ok} OK, ${fehler} FEHLER`);
  await pool.end().catch(() => {});
  process.exit(fehler > 0 ? 1 : 0);
}
