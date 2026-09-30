/**
 * P7-T12: SCHEMA_SQL wird WIRKLICH ausgefuehrt (nicht nur als Text geprueft).
 * Anlass 29.09.2026: ein doppelter Seed-Rest (Syntaxfehler 42601) passierte alle Unit-Tests und fiel
 * erst im ensureSchema-Probelauf auf.
 *
 * SICHERHEIT (hart, VOR jeder Verbindung):
 *   - Verbindung nur aus TEST_DATABASE_URL (scripts/lib/test-db-schutz.mjs). Fehlt sie: Exit 0 "uebersprungen".
 *   - Port 5432 oder DB-Name 'synapse' oder Live-Host -> Exit 2.
 *   - Der Test legt eine EIGENE Wegwerf-Datenbank schema_probe_<pid>_<zeit> an, arbeitet nur darin und
 *     loescht sie im finally (auch bei Fehler). Die Admin-Verbindung (TEST_DATABASE_URL) fasst sonst nichts an.
 *
 * Faelle:
 *  H1-H4 reine Schutzpruefung (laeuft immer, ohne DB)
 *  S1 Probelauf (nurProbe) gegen leere Wegwerf-DB: gesamtes SCHEMA_SQL + AUTH_SCHEMA_SQL laeuft, probe===true
 *  S2 Rollback: danach existiert keine Tabelle (memories, plans)
 *  S3 Negativ: kaputter Koerper -> Fehler 42601 (beweist, dass ein Syntaxfehler den Test rot macht)
 *  S4 echter Lauf zweimal hintereinander (Idempotenz): Tabellen da, kein Fehler
 *
 * AUFRUF (nur Koordinator mit Admin-Zugang zur Spielwiese 5433):
 *   TEST_DATABASE_URL='postgresql://<admin>:<pw>@<host>:5433/postgres' \
 *     node packages/core/tests/schema-sql-ausfuehren.test.mjs
 * (CREATEDB-Recht noetig; Datenbankname der URL darf nicht 'synapse' sein; Voraussetzung: pnpm build.)
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.PLAENE_TEST_DIST || join(hier, '..', 'dist');
const schutz = await import(join(hier, '..', '..', '..', 'scripts', 'lib', 'test-db-schutz.mjs'));

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.error('FEHLER  ' + text + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : '')); }
}

// ===== H: harte Schutzpruefung (rein, ohne DB) =====
const h = schutz.bewerteSchemaProbeDb;
pruefe(typeof h === 'function', 'H0: bewerteSchemaProbeDb exportiert', null);
if (typeof h === 'function') {
  pruefe(h({ TEST_DATABASE_URL: 'postgresql://a:b@10.0.0.1:5432/postgres' }).modus === 'abbruch', 'H1: Port 5432 (beliebiger Host) -> abbruch', null);
  pruefe(h({ TEST_DATABASE_URL: 'postgresql://a:b@10.0.0.1:5433/synapse' }).modus === 'abbruch', "H2: DB-Name 'synapse' -> abbruch", null);
  pruefe(h({ TEST_DATABASE_URL: 'postgresql://a:b@10.0.0.1/postgres' }).modus === 'abbruch', 'H3: Port fehlt (Default 5432) -> abbruch', null);
  pruefe(h({ TEST_DATABASE_URL: 'postgresql://a:b@10.0.0.1:5433/postgres' }).modus === 'ok', 'H4: 5433/postgres -> ok', null);
  pruefe(h({}).modus === 'skip', 'H5: ohne TEST_DATABASE_URL -> skip', null);
}
if (fehler > 0) process.exit(1);

// ===== Ab hier nur mit Wegwerf-DB =====
const bewertung = h(process.env);
if (bewertung.modus === 'skip') {
  console.error('schema-sql-ausfuehren: uebersprungen — TEST_DATABASE_URL nicht gesetzt (Schutzpruefungen H1-H5 liefen).');
  process.exit(0);
}
if (bewertung.modus === 'abbruch') {
  console.error(`schema-sql-ausfuehren: ABBRUCH — ${bewertung.grund}. Dieser Test laeuft nie gegen die Live-DB.`);
  process.exit(2);
}

const { default: pg } = await import('pg');
const adminUrl = bewertung.url;
const dbName = `schema_probe_${process.pid}_${Date.now()}`;
const probeUrl = new URL(adminUrl);
probeUrl.pathname = '/' + dbName;
const admin = new pg.Client({ connectionString: adminUrl });
let closePool = async () => {};
let angelegt = false;
try {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  angelegt = true;
  // erst JETZT auf die Wegwerf-DB umbiegen, dann core/dist laden (Pool liest DATABASE_URL beim ersten getPool)
  process.env.DATABASE_URL = probeUrl.toString();
  const client = await import(join(dist, 'db', 'client.js'));
  closePool = client.closePool;
  const schemaMod = await import(join(dist, 'db', 'schema.js'));
  const pool = client.getPool();
  const gibt = async (name) => (await pool.query('SELECT to_regclass($1) IS NOT NULL AS x', [name])).rows[0].x;
  const dbAktuell = (await pool.query('SELECT current_database() AS n')).rows[0].n;
  pruefe(dbAktuell === dbName, 'Pool zeigt auf die Wegwerf-DB (nicht auf die Admin-DB)', { dbAktuell });

  const opt = { versuche: 1, wartezeitMs: 20, lockTimeoutMs: 5000, statementTimeoutMs: 60000, idleTimeoutMs: 10000 };

  // S1 Probelauf gegen leere DB
  let r1;
  try { r1 = await schemaMod.ensureSchema({ ...opt, nurProbe: true }); } catch (e) { r1 = { fehler: `${e.code ?? ''} ${e.message}` }; }
  pruefe(r1?.probe === true, 'S1: SCHEMA_SQL + AUTH_SCHEMA_SQL laufen im Probelauf ohne Fehler', r1);

  // S2 Rollback
  pruefe(!(await gibt('memories')) && !(await gibt('plans')), 'S2: Probelauf hinterlaesst nichts (Rollback)', null);

  // S3 Negativ
  let code3 = null;
  try { await schemaMod.ensureSchema({ ...opt, nurProbe: true, koerper: 'SELEKT kaputt' }); } catch (e) { code3 = e.code ?? 'ohne'; }
  pruefe(code3 === '42601', 'S3: kaputtes SQL im Probelauf -> Syntaxfehler 42601 (Test faengt so etwas)', { code3 });

  // S4 echter Lauf, zweimal (Idempotenz)
  let r4a, r4b;
  try { r4a = await schemaMod.ensureSchema(opt); r4b = await schemaMod.ensureSchema(opt); } catch (e) { r4b = { fehler: `${e.code ?? ''} ${e.message}` }; }
  pruefe(r4a?.probe === false && r4b?.probe === false && await gibt('memories') && await gibt('plans'), 'S4: echter Lauf zweimal hintereinander, Tabellen vorhanden', { r4a, r4b });
} catch (e) {
  fehler++;
  console.error('FEHLER  Test abgebrochen: ' + (e?.code ?? '') + ' ' + (e?.message ?? e));
} finally {
  try { await closePool(); } catch { /* egal */ }
  if (angelegt) {
    try {
      // Sicherung: nur Wegwerf-Namen mit Praefix droppen
      if (!dbName.startsWith('schema_probe_')) throw new Error('Namenspraefix passt nicht');
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      console.log('OK      Wegwerf-DB ' + dbName + ' gedroppt');
    } catch (e) {
      fehler++;
      console.error('FEHLER  Wegwerf-DB ' + dbName + ' NICHT gedroppt: ' + (e?.message ?? e) + ' — bitte von Hand loeschen');
    }
  }
  try { await admin.end(); } catch { /* egal */ }
}
console.log(fehler === 0 ? '\nALLE OK' : `\n${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
