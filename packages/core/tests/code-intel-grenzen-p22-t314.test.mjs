/**
 * P22-T314 (claude-buche, 08.11.2026): code_intel-Abfragen mit Zeit- und Sperrgrenze, ohne Parallel-Worker, Abbruch bei Client-Ende.
 * WARUM: Ghost-Schatten-Abfragen liefen in der Produktions-PG minutenlang weiter, obwohl der Client laengst im Timeout war
 * (thoughts 4e749391, 20ea0533, Ursache 236ac889). Folgen: /dev/shm voll (Parallel-Hash), Schema-Sperre beim Deploy t243.
 * Vorgabe memory unraid-postgresql-speicher-fakten-und-regel: PG-Speicher NICHT erhoehen, Loesung im Code.
 * PRUEFT (Herkunft je Label):
 *   - core services/code-intel-grenzen.ts begrenzterPool: SET LOCAL statement_timeout/lock_timeout/max_parallel_workers_per_gather=0
 *     je Abfrage; Zeitlimit bricht IN PG ab (pg_stat_activity ohne die Abfrage); Abbruchsignal -> pg_cancel_backend;
 *     lock_timeout -> 55P03; abgebrochene Verbindung nicht wiederverwendet.
 *   - pgFehlerAntwort: 57014 zeitlimit/abgebrochen, 55P03 sperre_belegt, 53100/53200 speicherlimit, sonst null.
 *   - leseCodeIntelGrenzen: Einstellung runtime_ueberwachung_einstellungen (code_intel_*) > Code-Standard 25000/2000.
 *   - code-intel-schatten.ts mitCodeIntelSchatten: Bestand laeuft im begrenzten Kontext (SHOW ... = 0), Zeitlimit -> Antwort
 *     error 'zeitlimit' statt Ausnahme.
 * Testdatenbank synapse_test (DATABASE_URL des Shell-Jobs, Port 5433); eigene Marker in den Abfragen, Testtabelle und
 * Einstellungszeilen werden am Ende entfernt.
 * Aufruf: node packages/core/tests/code-intel-grenzen-p22-t314.test.mjs   (vorher mise run build:core)
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ziel = new URL(process.env.DATABASE_URL ?? 'http://ungueltig');
assert.equal(ziel.port, '5433', 'DATABASE_URL muss auf die Test-Instanz 5433 zeigen');
assert.equal(ziel.pathname, '/synapse_test', 'DATABASE_URL muss synapse_test sein');
Object.assign(process.env, { QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9' });

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.P22_CORE_DIST ?? resolve(hier, '../dist');
const lade = (p) => import(pathToFileURL(join(dist, p)).href);
const db = await lade('db/client.js');
const g = await lade('services/code-intel-grenzen.js');
const schatten = await lade('services/code-intel-schatten.js');
const typen = await lade('services/typen-pruefung.js');
const code = await lade('services/code.js');
const pool = db.getPool();

const marke = 'p22t314_' + randomUUID().slice(0, 8);
const tabelle = 'p22t314_sperre_' + marke.slice(-8);
const NAMEN = ['code_intel_statement_timeout_ms', 'code_intel_lock_timeout_ms'];
let ok = 0;
const check = async (name, fn) => {
  try { await fn(); ok++; console.log('OK ' + name); }
  catch (e) { console.error('FEHLER ' + name + '\n  ' + e.message); throw e; }
};
const schlafe = (ms) => new Promise((r) => setTimeout(r, ms));
/** Laeuft eine Abfrage mit unserer Marke noch in PG? (aktiv, nicht die Pruefabfrage selbst) */
const laeuftNoch = async (m) => (await pool.query(
  "SELECT pid, state, now() - query_start AS dauer FROM pg_stat_activity WHERE query LIKE $1 AND query NOT LIKE '%pg_stat_activity%' AND state = 'active'",
  ['%' + m + '%'])).rows;
const grenzen = (st, lt) => ({ statement_timeout_ms: st, lock_timeout_ms: lt, quelle: { statement_timeout_ms: 'test', lock_timeout_ms: 'test' } });
const vorherEinstellungen = (await pool.query('SELECT name, wert, grund, gesetzt_von FROM runtime_ueberwachung_einstellungen WHERE name = ANY($1::text[])', [NAMEN])).rows;

try {
  // WARUM: SET LOCAL muss in genau der Transaktion der Abfrage wirken (sonst bleibt der Server-Standard 2 Parallel-Worker).
  await check('P22-T314 code-intel-grenzen.ts begrenzterPool: SET LOCAL wirkt je Abfrage (statement/lock_timeout, keine Parallel-Worker)', async () => {
    const bp = g.begrenzterPool(pool, grenzen(1500, 300));
    assert.equal((await bp.query('SHOW max_parallel_workers_per_gather')).rows[0].max_parallel_workers_per_gather, '0');
    assert.equal((await bp.query('SHOW statement_timeout')).rows[0].statement_timeout, '1500ms');
    assert.equal((await bp.query('SHOW lock_timeout')).rows[0].lock_timeout, '300ms');
    // Ausserhalb der Huelle bleibt die Sitzung unveraendert (SET LOCAL endet mit COMMIT).
    assert.notEqual((await pool.query('SHOW statement_timeout')).rows[0].statement_timeout, '1500ms');
    assert.equal(g.begrenzterPool(bp, grenzen(1, 1)), bp, 'zweites Umhuellen liefert dieselbe Huelle');
  });

  // WARUM (SOLL 5): die Abfrage muss in PG wirklich enden, nicht nur auf Client-Seite.
  await check('P22-T314 Zeitlimit bricht in PG ab: pg_sleep(5) mit 1000 ms -> 57014, pg_stat_activity leer', async () => {
    const bp = g.begrenzterPool(pool, grenzen(1000, 300));
    const m = marke + '_zeit';
    const t0 = Date.now();
    const err = await bp.query(`SELECT pg_sleep(5) /* ${m} */`).then(() => null, (e) => e);
    const ms = Date.now() - t0;
    assert.equal(err?.code, '57014', 'erwartet 57014, ist ' + err?.code + ' ' + err?.message);
    assert.ok(ms < 3000, 'Abbruch nach ' + ms + ' ms');
    assert.deepEqual(await laeuftNoch(m), [], 'P22-T314 Abfrage laeuft nach dem Zeitlimit nicht mehr in PG');
    const a = g.pgFehlerAntwort(err, grenzen(1000, 300));
    assert.equal(a.error, 'zeitlimit');
    assert.equal(a.wiederholbar, true);
    assert.match(a.message, /1000 ms/);
  });

  // WARUM (SOLL 1): bricht der Client ab, endet die PG-Abfrage sofort (pg_cancel_backend), nicht erst nach dem Zeitlimit.
  await check('P22-T314 Abbruchsignal -> pg_cancel_backend: pg_sleep(20) endet nach ~300 ms, Antwort abgebrochen', async () => {
    const ac = new AbortController();
    const bp = g.begrenzterPool(pool, grenzen(30000, 300), ac.signal);
    const m = marke + '_abbruch';
    const t0 = Date.now();
    const lauf = bp.query(`SELECT pg_sleep(20) /* ${m} */`).then(() => null, (e) => e);
    await schlafe(300);
    assert.equal((await laeuftNoch(m)).length, 1, 'Abfrage laeuft vor dem Abbruch');
    ac.abort();
    const err = await lauf;
    assert.equal(err?.code, 'SYNAPSE_ABGEBROCHEN', 'erwartet SYNAPSE_ABGEBROCHEN, ist ' + err?.code + ' ' + err?.message);
    assert.ok(Date.now() - t0 < 5000);
    await schlafe(200);
    assert.deepEqual(await laeuftNoch(m), [], 'P22-T314 Abfrage nach dem Abbruch nicht mehr aktiv');
    assert.equal(g.pgFehlerAntwort(err).error, 'abgebrochen');
    // Schon abgebrochenes Signal: keine Abfrage mehr.
    const vorher = g.CODE_INTEL_GRENZEN_ZAEHLER.abfragen;
    const sofort = await bp.query('SELECT 1').then(() => null, (e) => e);
    assert.equal(sofort?.code, 'SYNAPSE_ABGEBROCHEN');
    assert.equal(g.CODE_INTEL_GRENZEN_ZAEHLER.abfragen, vorher, 'nach Abbruch wird nichts mehr gestartet');
  });

  // WARUM (SOLL 1 + 4): Deploy t243 - die Schema-Sperre darf eine code_intel-Abfrage nicht lange blockieren (und umgekehrt).
  await check('P22-T314 lock_timeout: gesperrte Tabelle -> 55P03 nach ~300 ms, Antwort sperre_belegt', async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${tabelle} (id int)`);
    const halter = await pool.connect();
    try {
      await halter.query('BEGIN');
      await halter.query(`LOCK TABLE ${tabelle} IN ACCESS EXCLUSIVE MODE`);
      const bp = g.begrenzterPool(pool, grenzen(10000, 300));
      const t0 = Date.now();
      const err = await bp.query(`SELECT count(*) FROM ${tabelle}`).then(() => null, (e) => e);
      assert.equal(err?.code, '55P03', 'erwartet 55P03, ist ' + err?.code);
      assert.ok(Date.now() - t0 < 3000);
      const a = g.pgFehlerAntwort(err, grenzen(10000, 300));
      assert.equal(a.error, 'sperre_belegt');
      assert.match(a.message, /300 ms/);
    } finally {
      await halter.query('ROLLBACK').catch(() => {});
      halter.release();
    }
  });

  await check('P22-T314 pgFehlerAntwort: 53100/53200 speicherlimit, fremde Fehler null', async () => {
    const dsm = Object.assign(new Error('could not resize shared memory segment "/PostgreSQL.1" to 2097152 bytes: No space left on device'), { code: '53100' });
    assert.equal(g.pgFehlerAntwort(dsm).error, 'speicherlimit');
    assert.equal(g.pgFehlerAntwort(Object.assign(new Error('out of memory'), { code: '53200' })).error, 'speicherlimit');
    assert.equal(g.pgFehlerAntwort(Object.assign(new Error('syntax'), { code: '42601' })), null);
    assert.equal(g.pgFehlerAntwort(new Error('ohne Code')), null);
  });

  // WARUM (Regel 7): Grenzen sind Einstellwerte (admin runtime_ueberwachung), Code-Standard nur Rueckfall.
  await check('P22-T314 leseCodeIntelGrenzen: Standard 25000/2000, Einstellung hat Vorrang', async () => {
    await pool.query('DELETE FROM runtime_ueberwachung_einstellungen WHERE name = ANY($1::text[])', [NAMEN]);
    g.leereCodeIntelGrenzenCache();
    const std = await g.leseCodeIntelGrenzen();
    assert.equal(std.statement_timeout_ms, 25000);
    assert.equal(std.lock_timeout_ms, 2000);
    assert.equal(std.quelle.statement_timeout_ms, 'standard');
    await pool.query("INSERT INTO runtime_ueberwachung_einstellungen (name, wert, grund, gesetzt_von, gesetzt_am) VALUES ($1, $2::jsonb, 'Test P22-T314', 'test-p22t314', NOW()), ($3, $4::jsonb, 'Test P22-T314', 'test-p22t314', NOW())",
      ['code_intel_statement_timeout_ms', '1000', 'code_intel_lock_timeout_ms', '200']);
    g.leereCodeIntelGrenzenCache();
    const e = await g.leseCodeIntelGrenzen();
    assert.equal(e.statement_timeout_ms, 1000);
    assert.equal(e.lock_timeout_ms, 200);
    assert.equal(e.quelle.statement_timeout_ms, 'einstellung');
  });

  // WARUM: Ursache 236ac889 - auch normale code_intel-Aufrufe laufen ueber den Ghost-Lesekontext (index_folgt); der
  // Grenzkontext muss deshalb um den GANZEN Aufruf liegen, nicht nur um die Schatten-SQL.
  await check('P22-T314 code-intel-schatten.ts mitCodeIntelSchatten: Bestand im Grenzkontext, Zeitlimit -> Antwort zeitlimit', async () => {
    const project = 'test-p22t314-' + marke;
    const innen = await schatten.mitCodeIntelSchatten('search', { project, query: 'x' }, async () => {
      const r = await db.getPool().query('SHOW max_parallel_workers_per_gather');
      return { success: true, parallel: r.rows[0].max_parallel_workers_per_gather };
    });
    assert.equal(innen.success, true, JSON.stringify(innen));
    assert.equal(innen.parallel, '0', 'getPool() im Aufruf liefert den begrenzten Pool');
    const m = marke + '_schatten';
    const t0 = Date.now();
    const zeit = await schatten.mitCodeIntelSchatten('search', { project, query: 'x' }, async () => {
      await db.getPool().query(`SELECT pg_sleep(4) /* ${m} */`);
      return { success: true };
    });
    assert.equal(zeit.success, false, JSON.stringify(zeit));
    assert.equal(zeit.error, 'zeitlimit');
    assert.equal(zeit.project, project);
    assert.equal(zeit.grenzen.statement_timeout_ms, 1000, 'Einstellung aus dem vorigen Check wirkt');
    assert.ok(Date.now() - t0 < 3500);
    assert.deepEqual(await laeuftNoch(m), []);
    // Abbruchsignal ueber den Anfragekontext (rest-api mcp.ts setzeAnfrageAbbruch).
    const ac = new AbortController();
    const m2 = marke + '_kontext';
    const p = g.mitAnfrageAbbruch(ac.signal, () => schatten.mitCodeIntelSchatten('search', { project, query: 'x' }, async () => {
      await db.getPool().query(`SELECT pg_sleep(3) /* ${m2} */`);
      return { success: true };
    }));
    await schlafe(300);
    ac.abort();
    const ab = await p;
    assert.equal(ab.error, 'abgebrochen', JSON.stringify(ab));
    await schlafe(200);
    assert.deepEqual(await laeuftNoch(m2), []);
  });
  // WARUM (User-Vorgabe thought 7613eaee, Befund f250768c): ist der Pruef-Container nicht bereit, kommt die Antwort sofort
  // ohne kleine Typpruefung - kein Laden des TS-Bestands aus PG, kein Warten auf den Container.
  await check('P22-T314 typen-pruefung.ts pruefePlanTypen: Pruef-Container nicht bereit -> sofort uebersprungen, Container nicht gefragt', async () => {
    let gefragt = 0, auftraege = 0;
    typen.registriereTypContainerPruefer(async () => { auftraege++; return new Promise(() => {}); }, () => { gefragt++; return { bereit: false, grund: 'aus' }; });
    try {
      const t0 = Date.now();
      const r = await typen.pruefePlanTypen('test-p22t314-' + marke, [{ file_path: 'pkg/src/a.ts', basis: 'export const a = 1;\n', ergebnis: 'export const a: number = 2;\n', ops: [] }]);
      const ms = Date.now() - t0;
      assert.equal(r.status, 'nicht_verfuegbar', JSON.stringify(r));
      assert.equal(r.pruefung, 'uebersprungen');
      assert.equal(r.grund, 'pruefcontainer_nicht_bereit');
      assert.equal(r.pruefcontainer, 'aus');
      assert.equal(r.befunde.length, 0, 'keine Sperre');
      assert.equal(gefragt, 1);
      assert.equal(auftraege, 0, 'haengender Container wird gar nicht erst beauftragt');
      assert.ok(ms < 200, 'sofort (' + ms + ' ms)');
      // code_intel mit typen:true: Antwort kommt sofort mit uebersprungener Typstufe, keine offene PG-Abfrage.
      const t1 = Date.now();
      const a = await schatten.mitCodeIntelSchatten('file', { project: 'test-p22t314-' + marke, file_path: 'pkg/src/a.ts', typen: true }, async () => ({ success: true, file_path: 'pkg/src/a.ts' }));
      assert.equal(a.success, true, JSON.stringify(a));
      assert.ok(Date.now() - t1 < 2000);
      assert.equal(auftraege, 0);
      assert.deepEqual(await laeuftNoch('test-p22t314-' + marke), []);
      // Bereit -> Container wird gefragt (Gegenprobe; Budget aus opt.budget_ms kappt das Warten).
      typen.registriereTypContainerPruefer(async (auftrag) => { auftraege++; return { status: 'fertig', dauer_ms: 1, befunde: [], altlasten: 0, dateien: [], vollstaendig: true, fehlende_module: [], betroffene_aufrufer: [], budget: auftrag.budget_ms }; }, () => ({ bereit: true }));
    } finally {
      typen.registriereTypContainerPruefer(null);
    }
  });
  // WARUM (Befund bff52856, .mjs-Fall): ein Inhalt, der nach dem letzten Parse geaendert wurde, muss im Parse-Backlog
  // faellig sein - sonst heilt ein verlorener Commit-Anstoss nie und code_intel laeuft dauerhaft ueber den Ghost-Weg.
  await check('P22-T314 code.ts baueFaelligkeitsBedingung: parsed_at < updated_at -> faellig (neu), Schonfrist und parse_failures ausgenommen', async () => {
    const p = 'test-p22t314-' + marke;
    const zeile = (pfad, parsedMin, updatedSek) => pool.query(
      `INSERT INTO code_files (id, project, file_path, file_name, file_type, file_size, content, content_hash, ignored, parsed_at, updated_at, parser_version)
       VALUES ($1, $2, $3, $4, 'ts', 10, 'export {};', md5($3), false, NOW() - make_interval(mins => $5), NOW() - make_interval(secs => $6), 9999)`,
      [randomUUID(), p, pfad, pfad.split('/').pop(), parsedMin, updatedSek]);
    await zeile('src/geaendert.ts', 10, 300);
    await zeile('src/frisch.ts', 10, 30);
    await zeile('src/ausfall.ts', 10, 300);
    await zeile('src/fertig.ts', 1, 300);
    await pool.query('INSERT INTO parse_failures (project, file_path, grund, details, aufgetreten_am) VALUES ($1, $2, $3, $4, NOW())', [p, 'src/ausfall.ts', 'test', 'P22-T314 dauerhafter Ausfall']);
    const r = await code.listeFaelligeDateien(p, 50, 0);
    const pfade = Object.fromEntries(r.dateien.map((d) => [d.file_path, d.grund]));
    assert.equal(pfade['src/geaendert.ts'], 'neu', JSON.stringify(r));
    assert.equal(pfade['src/frisch.ts'], undefined, '2 min Schonfrist fuer den laufenden Anstoss');
    assert.equal(pfade['src/ausfall.ts'], undefined, 'dauerhafter Parse-Ausfall erzeugt keine Schleife');
    assert.equal(pfade['src/fertig.ts'], undefined, 'parsed_at nach updated_at ist fertig');
  });
  await check('P22-T314 db/client.ts: Hintergrund-Pool traegt application_name (erkennbar in pg_stat_activity)', async () => {
    const r = await db.getHintergrundPool().query("SELECT current_setting('application_name') AS n");
    assert.match(r.rows[0].n, /^synapse-.+-hintergrund$/, r.rows[0].n);
  });
  console.log('TEST_GRUEN P22-T314 code_intel-Grenzen checks=' + ok);
} finally {
  await pool.query(`DROP TABLE IF EXISTS ${tabelle}`).catch(() => {});
  await pool.query('DELETE FROM parse_failures WHERE project = $1', ['test-p22t314-' + marke]).catch(() => {});
  await pool.query('DELETE FROM code_files WHERE project = $1', ['test-p22t314-' + marke]).catch(() => {});
  await pool.query('DELETE FROM runtime_ueberwachung_einstellungen WHERE name = ANY($1::text[])', [NAMEN]).catch(() => {});
  for (const z of vorherEinstellungen) {
    await pool.query('INSERT INTO runtime_ueberwachung_einstellungen (name, wert, grund, gesetzt_von, gesetzt_am) VALUES ($1, $2::jsonb, $3, $4, NOW())',
      [z.name, JSON.stringify(z.wert), z.grund, z.gesetzt_von]).catch(() => {});
  }
  await db.closePool?.().catch?.(() => {});
  await pool.end().catch(() => {});
}
