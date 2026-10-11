/**
 * P15-T17 E1 (11.10.2026): Migrations-Test fuer scripts/fehlermuster-migration.mjs auf der Test-DB.
 *
 * ABLAUF: Die echten Muster werden aus der Live-DB GELESEN (LIVE_DATABASE_URL, Sitzung read-only) und mit
 * denselben IDs in synapse_test geschrieben. Dort laeuft ausfuehren() wie bei der echten Migration,
 * mit Fake-writeMemory und Fake-loescheVektor. Danach wird der Zustand geprueft und die Testzeilen entfernt.
 *
 * ZUSAGEN (User-Freigabe 37673ac6):
 *   T1 ohne --sicherung bricht ausfuehren() VOR jeder Aenderung ab.
 *   T2 Sicherung: JSON mit allen Zeilen (Anzahl und IDs = Bestand vor der Migration).
 *   T3 geaendert/geloescht: 104 aktualisiert, 35 geloescht, danach 104 Zeilen.
 *   T4 Status: aktiv 27, themenhinweis 28, stillgelegt 49 (29 Dubletten + 20 stillgelegt).
 *   T5 ersetzt_durch bei 32 Mustern (29 Dubletten + 3 widerspruechliche), jedes Ziel existiert und ist aktiv/themenhinweis.
 *   T6 aktive Muster: severity warning, erkennung art regex mit Selbsttest, titel; themenhinweise haben titel.
 *   T7 genau die 35 saar-quiz-Muster sind weg, alle anderen IDs sind noch da.
 *   T8 loescheVektor fuer genau die 35 geloeschten IDs aufgerufen.
 *   T9 writeMemory genau einmal: synapse / fehlermuster-agenten-prozessregeln mit 14 Mustern.
 *   T10 jedes stillgelegte Muster hat stillgelegt_grund.
 *   T11 checkErrorPatterns (Fake-Ollama/Qdrant): stillgelegtes und geloeschtes Muster liefern nichts, aktives schon.
 *   T12 zweiter Lauf ist idempotent: 104 aktualisiert, 0 geloescht, Zustand gleich.
 * ABSICHERUNG: DATABASE_URL muss ...:5433/synapse_test sein; die Live-DB wird nur gelesen.
 * AUFRUF (Shell-Job im Projekt synapse, dort ist DATABASE_URL die Live-DB):
 *   L="$DATABASE_URL"; set -a; . <test-db.env>; set +a; LIVE_DATABASE_URL="$L" node scripts/test-fehlermuster-migration.mjs
 */
import http from 'node:http';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
if (!/:5433\/synapse_test(\?|$)/.test(DB_URL)) {
  console.error('ABBRUCH: dieser Test laeuft nur gegen die Test-DB (...:5433/synapse_test).');
  process.exit(2);
}
const LIVE_URL = process.env.LIVE_DATABASE_URL ?? '';
if (!LIVE_URL || LIVE_URL === DB_URL) {
  console.error('ABBRUCH: LIVE_DATABASE_URL fehlt (Quelle der echten Muster, wird nur gelesen).');
  process.exit(2);
}

const MODELL = 'fake-fm-embed:latest';
const AGENT = 'zz-fm-migration';
let TREFFER_IDS = [];
const ollama = http.createServer((req, res) => {
  let body = '';
  req.on('data', (s) => { body += s; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: MODELL, model: MODELL, digest: 'ab'.repeat(32), size: 1000 }] }));
    if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [] }));
    if (req.url === '/api/show') return res.end(JSON.stringify({ model_info: { 'general.architecture': 'fake', 'fake.embedding_length': 8, 'fake.context_length': 999999 } }));
    if (req.url === '/api/embed') {
      const a = JSON.parse(body);
      const liste = Array.isArray(a.input) ? a.input : [a.input];
      return res.end(JSON.stringify({ embeddings: liste.map(() => [1, 0, 0, 0, 0, 0, 0, 0]) }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
let ERRP = '';
const qdrant = http.createServer((req, res) => {
  let body = '';
  req.on('data', (s) => { body += s; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/') return res.end(JSON.stringify({ title: 'qdrant', version: '1.13.0' }));
    const m = /^\/collections\/([^/]+)\/points\/search$/.exec(u.pathname);
    if (m && decodeURIComponent(m[1]) === ERRP) {
      return res.end(JSON.stringify({ status: 'ok', time: 0, result: TREFFER_IDS.map((id) => (
        { id, version: 0, score: 0.9, payload: { id, model_scope: 'all', severity: 'warning' } })) }));
    }
    res.end(JSON.stringify({ status: 'ok', time: 0, result: m ? [] : {} }));
  });
});
await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
await new Promise((r) => qdrant.listen(0, '127.0.0.1', r));
process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.OLLAMA_URL = `http://127.0.0.1:${ollama.address().port}`;
process.env.OLLAMA_MODEL = MODELL;
process.env.QDRANT_URL = `http://127.0.0.1:${qdrant.address().port}`;
process.env.EMBED_MIN_GAP_MS = '0';
process.env.SCORE_SCHWELLE_ERROR_PATTERNS = '0.5';
for (const name of ['EMBEDDING_TARGET_DIM', 'EMBEDDING_PRAEFIXE', 'SYNAPSE_OLLAMA_MODEL_DIGEST', 'SYNAPSE_COMPUTE_NODE',
  'FEHLERMUSTER_UNBEKANNT_SIEHT_ALLE', 'FEHLERMUSTER_GESEHEN_STUNDEN']) delete process.env[name];
process.env.EMBEDDING_QUERY_PREFIX = '';
process.env.EMBEDDING_DOC_PREFIX = '';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = join(hier, '..', 'packages', 'core', 'dist');
const lade = (...teile) => import(pathToFileURL(join(...teile)).href);
const { getConfig } = await lade(dist, 'config.js');
if (/192\.168\.50\.65/.test(getConfig().embeddings.ollama.url + getConfig().qdrant.url)) {
  console.error('ABBRUCH: Ollama/Qdrant zeigen auf Produktion.');
  process.exit(2);
}
const erkennung = await lade(dist, 'services', 'fehlermuster-erkennung.js');
const EP = await lade(dist, 'services', 'error-patterns.js');
const db = await lade(dist, 'db', 'client.js');
const { COLLECTIONS } = await lade(dist, 'types', 'index.js');
ERRP = COLLECTIONS.globalErrorPatterns;
const { PLAN } = await import('./fehlermuster-migration-plan.mjs');
const M = await import('./fehlermuster-migration.mjs');
const pg = createRequire(join(hier, '..', 'packages', 'core', 'package.json'))('pg');

const pool = db.getPool();
const live = new pg.Pool({ connectionString: LIVE_URL, max: 1, options: '-c default_transaction_read_only=on' });
const SICHERUNG = join(tmpdir(), `zz-fehlermuster-sicherung-${process.pid}.json`);

let fehler = 0;
let ok = 0;
function pruefe(b, text, detail) {
  if (b) { ok++; console.log('OK      ' + text); }
  else { fehler++; console.log('FEHLER  ' + text + (detail !== undefined ? '\n        ' + JSON.stringify(detail).slice(0, 1500) : '')); }
}
const zeilen = async () => (await pool.query('SELECT * FROM error_patterns WHERE id = ANY($1::uuid[])', [IDS])).rows;
let IDS = [];

async function aufraeumen() {
  if (IDS.length) await pool.query('DELETE FROM error_patterns WHERE id = ANY($1::uuid[])', [IDS]);
  await pool.query('DELETE FROM error_pattern_seen WHERE session_id = $1', [AGENT]).catch(() => {});
  await pool.query('DELETE FROM agent_sessions WHERE id = $1', [AGENT]).catch(() => {});
  if (existsSync(SICHERUNG)) rmSync(SICHERUNG);
}

try {
  // ---- Vorbereitung: Live-Muster lesen (read-only) und in die Test-DB kopieren ----
  const quelle = (await live.query(
    `SELECT id::text, description, fix, severity, model_scope, found_by, found_in_model, created_at, embedded_at
       FROM error_patterns ORDER BY created_at, id`)).rows;
  IDS = quelle.map((r) => r.id);
  console.log(`Live-Muster gelesen: ${quelle.length}`);
  await aufraeumen();
  const fremd = (await pool.query('SELECT count(*)::int n FROM error_patterns WHERE NOT (id = ANY($1::uuid[]))', [IDS])).rows[0].n;
  for (const r of quelle) {
    await pool.query(
      `INSERT INTO error_patterns (id, description, fix, severity, model_scope, found_by, found_in_model, created_at, embedded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [r.id, r.description, r.fix, r.severity, r.model_scope, r.found_by, r.found_in_model, r.created_at, r.embedded_at]);
  }
  const vorher = await zeilen();
  pruefe(vorher.length === quelle.length && quelle.length === 139, `Vorbereitung: 139 Muster in synapse_test kopiert (ist ${vorher.length})`);

  const rows = (await pool.query(
    `SELECT id::text, description, fix, severity, model_scope, found_by, found_in_model, created_at FROM error_patterns
      WHERE id = ANY($1::uuid[]) ORDER BY created_at, id`, [IDS])).rows;
  const { eintraege, fehler: planFehler, hinweise } = M.planAufloesen(rows, PLAN, erkennung);
  pruefe(planFehler.length === 0 && hinweise.length === 0, 'Trockenlauf gegen die Kopie: 0 Fehler, 0 Kreuztreffer', { planFehler, hinweise });

  // ---- T1: ohne Sicherung kein Lauf ----
  const memories = [];
  const vektoren = [];
  const fakeMemory = async (projekt, name, content, category, tags) => { memories.push({ projekt, name, content, category, tags }); };
  let t1 = null;
  try { await M.ausfuehren(pool, eintraege, fakeMemory, { loescheVektor: async (id) => { vektoren.push(id); } }); } catch (err) { t1 = err; }
  const nachT1 = await zeilen();
  pruefe(t1 && /Sicherung fehlt/.test(t1.message) && nachT1.length === 139 && nachT1.every((r) => r.status === null) && memories.length === 0,
    'T1 ohne sicherungPfad: Abbruch vor jeder Aenderung', { err: t1?.message, n: nachT1.length });

  // ---- echter Lauf ----
  const erg = await M.ausfuehren(pool, eintraege, fakeMemory, { sicherungPfad: SICHERUNG, loescheVektor: async (id) => { vektoren.push(id); } });
  console.log('Ergebnis: ' + JSON.stringify({ ...erg, memories: erg.memories }));

  // ---- T2: Sicherung ----
  const sich = JSON.parse(readFileSync(SICHERUNG, 'utf8'));
  const sichIds = new Set(sich.zeilen.map((r) => r.id));
  pruefe(erg.sicherung.zeilen === 139 + fremd && sich.anzahl === sich.zeilen.length && IDS.every((id) => sichIds.has(id))
    && sich.zeilen.find((r) => r.id === IDS[0]).description === quelle[0].description,
    'T2 Sicherung enthaelt alle Zeilen mit Inhalt', { sicherung: erg.sicherung, fremd });

  // ---- T3 ----
  const nach = await zeilen();
  pruefe(erg.geaendert === 104 && erg.geloescht === 35 && nach.length === 104, 'T3 104 aktualisiert, 35 geloescht, 104 Zeilen uebrig',
    { geaendert: erg.geaendert, geloescht: erg.geloescht, n: nach.length });

  // ---- T4 ----
  const st = (s) => nach.filter((r) => r.status === s).length;
  pruefe(st('aktiv') === 27 && st('themenhinweis') === 28 && st('stillgelegt') === 49 && nach.every((r) => r.status),
    'T4 Status aktiv 27 / themenhinweis 28 / stillgelegt 49', { aktiv: st('aktiv'), th: st('themenhinweis'), still: st('stillgelegt') });

  // ---- T5 ----
  const nachId = new Map(nach.map((r) => [r.id, r]));
  const mitZiel = nach.filter((r) => r.ersetzt_durch);
  pruefe(mitZiel.length === 32 && mitZiel.every((r) => ['aktiv', 'themenhinweis'].includes(nachId.get(r.ersetzt_durch)?.status)),
    'T5 ersetzt_durch bei 32 Mustern, Ziel existiert und ist aktiv/themenhinweis', mitZiel.length);

  // ---- T6 ----
  const aktiv = nach.filter((r) => r.status === 'aktiv');
  const aktivKaputt = aktiv.filter((r) => r.severity !== 'warning' || r.erkennung?.art !== 'regex' || !r.titel
    || !erkennung.selbsttest(r).ok || r.statistik?.selbsttest_ok !== true);
  pruefe(aktivKaputt.length === 0, 'T6 aktiv: severity warning, Signatur mit bestandenem Selbsttest (aus der DB gelesen), titel',
    aktivKaputt.map((r) => r.id.slice(0, 8)));
  pruefe(nach.filter((r) => r.status === 'themenhinweis').every((r) => r.titel && r.erkennung?.art === 'keine'),
    'T6b themenhinweis: titel gesetzt, erkennung art keine');

  // ---- T7 ----
  const saar = eintraege.filter((e) => e.aktion === 'loeschen').map((e) => e.voll_id);
  const rest = IDS.filter((id) => !saar.includes(id));
  pruefe(saar.length === 35 && saar.every((id) => !nachId.has(id)) && rest.every((id) => nachId.has(id)),
    'T7 genau die 35 saar-quiz-Muster geloescht, alle anderen vorhanden');

  // ---- T8 ----
  pruefe(vektoren.length === 35 && [...vektoren].sort().join() === [...saar].sort().join(), 'T8 loescheVektor fuer genau die 35 IDs', vektoren.length);

  // ---- T9 ----
  pruefe(memories.length === 1 && memories[0].projekt === 'synapse' && memories[0].name === 'fehlermuster-agenten-prozessregeln'
    && (memories[0].content.match(/^## /gm) ?? []).length === 14 && memories[0].category === 'documentation',
    'T9 genau ein memory: synapse/fehlermuster-agenten-prozessregeln mit 14 Mustern', memories.map((m) => ({ p: m.projekt, n: m.name })));

  // ---- T10 ----
  pruefe(nach.filter((r) => r.status === 'stillgelegt').every((r) => r.stillgelegt_grund), 'T10 jedes stillgelegte Muster hat stillgelegt_grund');

  // ---- T11: checkErrorPatterns ----
  const stillId = nach.find((r) => r.status === 'stillgelegt' && r.ersetzt_durch).id;
  const stillOhneZiel = nach.find((r) => r.status === 'stillgelegt' && !r.ersetzt_durch).id;
  const aktivId = aktiv[0].id;
  TREFFER_IDS = [stillId, stillOhneZiel, saar[0], aktivId];
  const treffer = await EP.checkErrorPatterns('irgendein code', AGENT);
  pruefe(treffer.length === 1 && treffer[0].id === aktivId && treffer[0].titel === aktiv[0].titel,
    'T11 checkErrorPatterns: stillgelegt/Dublette/geloescht liefern nichts, aktiv mit titel', treffer.map((t) => t.id));
  TREFFER_IDS = [aktivId];
  const kontrolle = await EP.checkErrorPatterns('irgendein code', AGENT);
  pruefe(kontrolle.length === 1, 'T11b Positivkontrolle: Fake-Suche liefert das aktive Muster');

  // ---- T12: idempotent ----
  const vorZweitem = JSON.stringify((await zeilen()).map((r) => [r.id, r.status, r.severity, r.ersetzt_durch, r.titel]).sort());
  const erg2 = await M.ausfuehren(pool, eintraege, async () => {}, { sicherungPfad: SICHERUNG, loescheVektor: async () => {} });
  const nachZweitem = JSON.stringify((await zeilen()).map((r) => [r.id, r.status, r.severity, r.ersetzt_durch, r.titel]).sort());
  pruefe(erg2.geaendert === 104 && erg2.geloescht === 0 && vorZweitem === nachZweitem && erg2.sicherung.zeilen === 104 + fremd,
    'T12 zweiter Lauf: 104 aktualisiert, 0 geloescht, Zustand unveraendert', { g: erg2.geaendert, l: erg2.geloescht });
} catch (err) {
  fehler++;
  console.log('FEHLER  Ausnahme: ' + (err?.stack ?? err));
} finally {
  await aufraeumen().catch((e) => console.log('Aufraeumen fehlgeschlagen: ' + e.message));
  const rest = (await pool.query('SELECT count(*)::int n FROM error_patterns WHERE id = ANY($1::uuid[])', [IDS])).rows[0].n;
  console.log(`Aufgeraeumt: ${rest} Testzeilen uebrig`);
  await live.end();
  await pool.end();
  ollama.close();
  qdrant.close();
}
console.log(`\nERGEBNIS: ${ok} OK, ${fehler} FEHLER`);
process.exit(fehler ? 1 : 0);
