/**
 * ensureSchema v2 (Entscheidung Koordinator 29.09.2026, nach Vorfall mit 132 s gehaltenen Sperren).
 * SICHERHEIT: Dieser Test sperrt NIE Produktionstabellen. ensureSchema laeuft hier nur mit
 * sperrSchema = eigenes Hilfsschema und koerper = eigenes SQL; jede eigene Verbindung setzt
 * lock_timeout, statement_timeout und idle_in_transaction_session_timeout. Ohne v2 im dist
 * (Marker fehlt) wird ensureSchema gar nicht aufgerufen.
 *  N1 Fehler VOR dem Aufruf injiziert (40P01 zweimal) -> dritter Versuch gelingt.
 *  N2 Zweite Verbindung haelt eine Hilfstabelle VOR dem Aufruf, Timer gibt sie nach 1,5 s frei ->
 *     Sperr-Runden > 1, dann Erfolg; keine Warterei ohne Ende.
 *  N3 Bleibender 40P01 -> Abbruch nach 3 Versuchen mit klarer Log-Zeile; 42601 sofort.
 *  N4 Probelauf: alles laeuft, Abbruch = Rollback -> Hilfsobjekt existiert danach nicht; Timeouts belegt.
 *  N5 EIN Server-Aufruf: waehrend des Laufs ist die Sitzung nie "idle in transaction".
 *  N6 statement_timeout greift (57014), kein Neuversuch.
 *  N7 Kein Test-Hook zwischen Sperre und Transaktionsende mehr im dist.
 * AUFRUF: node packages/core/tests/schema-ensure-neuversuch.test.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.PLAENE_TEST_DIST || join(hier, '..', 'dist');
const { getPool } = await import(join(dist, 'db', 'client.js'));
const schemaMod = await import(join(dist, 'db', 'schema.js'));
const pool = getPool();
const SCH = 'ensureschema_test';

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.error('FEHLER  ' + text + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : '')); }
}
const schlaf = (ms) => new Promise((r) => setTimeout(r, ms));
const distText = readFileSync(join(dist, 'db', 'schema.js'), 'utf8');
const istV2 = distText.includes('SYNAPSE_SCHEMA_PROBE_ENDE') && distText.includes('koerper');
const logZeilen = [];
const origError = console.error;
console.error = (...a) => { logZeilen.push(a.map(String).join(' ')); origError(...a); };
/** Eigene Verbindung, immer mit allen drei Timeouts (Regel: nie ohne). */
async function sichereVerbindung() {
  const c = await pool.connect();
  await c.query(`SET lock_timeout = '3s'; SET statement_timeout = '10s'; SET idle_in_transaction_session_timeout = '5s'`);
  return c;
}
const opt = (mehr) => ({ sperrSchema: SCH, koerper: `CREATE TABLE IF NOT EXISTS ${SCH}.angelegt (i int)`, wartezeitMs: 20, lockTimeoutMs: 2000, statementTimeoutMs: 10000, idleTimeoutMs: 5000, ...mehr });
const gibt = async (name) => (await pool.query(`SELECT to_regclass($1) IS NOT NULL AS x`, [`${SCH}.${name}`])).rows[0].x;

try {
  pruefe(istV2, 'ensureSchema v2 im dist (ein Server-Aufruf, Probelauf per Abbruch, Test-Optionen ohne Produktionssperre)', null);
  pruefe(!/vorSchema/.test(distText), 'N7: kein Test-Hook zwischen Sperre und Transaktionsende (vorSchema entfernt)', null);
  if (istV2) {
    const a = await sichereVerbindung();
    try {
      await a.query(`DROP SCHEMA IF EXISTS ${SCH} CASCADE; CREATE SCHEMA ${SCH}; CREATE TABLE ${SCH}.eltern (id int PRIMARY KEY); CREATE TABLE ${SCH}.kind (id int REFERENCES ${SCH}.eltern(id))`);
    } finally { a.release(); }

    // ===== N1 Fehler vor dem Aufruf =====
    let n1 = 0;
    const r1 = await schemaMod.ensureSchema(opt({ vorAufruf: (versuch) => { n1++; if (versuch <= 2) { const e = new Error('injizierter Deadlock'); e.code = '40P01'; throw e; } } }));
    pruefe(r1?.versuche === 3 && n1 === 3 && await gibt('angelegt') && logZeilen.some((z) => /Versuch 1\/5 abgebrochen \(40P01/.test(z)), 'N1: zweimal 40P01 vor dem Aufruf -> dritter Versuch gelingt', { r1, n1 });

    // ===== N2 belegte Hilfstabelle, Timer gibt frei =====
    const b = await sichereVerbindung();
    let freigegeben = 0;
    try {
      await b.query('BEGIN');
      await b.query(`LOCK TABLE ${SCH}.kind IN ACCESS EXCLUSIVE MODE`);
      const timer = setTimeout(() => { b.query('ROLLBACK').then(() => { freigegeben = Date.now(); }, () => {}); }, 1500);
      const t0 = Date.now();
      const r2 = await schemaMod.ensureSchema(opt({}));
      clearTimeout(timer);
      pruefe(r2?.sperr_runden > 1 && r2?.versuche === 1 && freigegeben > 0 && Date.now() - t0 >= 1400 && Date.now() - t0 < 8000,
        'N2: belegte Tabelle -> neue Sperr-Runden (je 200 ms), nach Freigabe Erfolg', { r2, ms: Date.now() - t0 });
    } finally {
      await b.query('ROLLBACK').catch(() => {});
      b.release();
    }

    // ===== N3 bleibender Fehler / sofortiger Abbruch =====
    let n3 = 0;
    const e3 = await schemaMod.ensureSchema(opt({ versuche: 3, vorAufruf: () => { n3++; const e = new Error('bleibender Deadlock'); e.code = '40P01'; throw e; } })).then(() => 'kein Fehler', (e) => e.code);
    pruefe(e3 === '40P01' && n3 === 3 && logZeilen.some((z) => /SCHEMA-UPDATE FEHLGESCHLAGEN nach 3 Versuch/.test(z)), 'N3: bleibender 40P01 -> Abbruch nach 3 Versuchen mit klarer Log-Zeile', { e3, n3 });
    const e3b = await schemaMod.ensureSchema(opt({ koerper: 'CREAT TABLE kaputt' })).then(() => 'kein Fehler', (e) => e.code);
    pruefe(e3b === '42601', 'N3: Syntaxfehler (42601) bricht sofort ab', e3b);

    // ===== N4 Probelauf =====
    const r4 = await schemaMod.ensureSchema(opt({ nurProbe: true, koerper: `CREATE TABLE ${SCH}.probe (i int)` }));
    pruefe(r4?.probe === true && !(await gibt('probe')) && r4.timeouts?.lock_timeout === '2s' && r4.timeouts?.statement_timeout === '10s' && r4.timeouts?.idle_in_transaction_session_timeout === '5s',
      'N4: Probelauf rollt zurueck (Hilfsobjekt fehlt danach), Timeouts in der Transaktion belegt', r4);
    const r4b = await schemaMod.ensureSchema(opt({ nurProbe: true, lockTimeoutMs: undefined, statementTimeoutMs: undefined, idleTimeoutMs: undefined }));
    pruefe(r4b?.timeouts?.lock_timeout === '5s' && r4b?.timeouts?.statement_timeout === '1min' && r4b?.timeouts?.idle_in_transaction_session_timeout === '10s',
      'N4: Standard-Timeouts 5 s / 60 s / 10 s', r4b?.timeouts);

    // ===== N5 nie idle in transaction =====
    const beob = await sichereVerbindung();
    const zustaende = [];
    try {
      const lauf = schemaMod.ensureSchema(opt({ nurProbe: true, koerper: `SELECT pg_sleep(1.2) /* ensureschema_test_marker_n5 */` }));
      for (let i = 0; i < 8; i++) {
        await schlaf(150);
        // application_name statt Text-Marker: pg_stat_activity.query ist auf 1024 Zeichen gekuerzt.
        const r = await beob.query(`SELECT state FROM pg_stat_activity WHERE application_name = 'synapse-ensure-schema' AND pid <> pg_backend_pid()`);
        for (const z of r.rows) zustaende.push(z.state);
      }
      await lauf;
    } finally { beob.release(); }
    pruefe(zustaende.length > 0 && zustaende.every((z) => z === 'active'), 'N5: waehrend des Laufs nur "active", nie "idle in transaction" (ein Server-Aufruf)', zustaende);

    // ===== N6 statement_timeout =====
    const t6 = Date.now();
    const e6 = await schemaMod.ensureSchema(opt({ statementTimeoutMs: 1000, koerper: 'SELECT pg_sleep(3)' })).then(() => 'kein Fehler', (e) => e.code);
    pruefe(e6 === '57014' && Date.now() - t6 < 2500, 'N6: statement_timeout bricht ab (57014), kein Neuversuch', { e6, ms: Date.now() - t6 });
  }
} catch (err) {
  fehler++;
  origError('FEHLER  Ausnahme: ' + (err instanceof Error ? err.stack : String(err)));
} finally {
  await pool.query(`SET lock_timeout = '3s'; DROP SCHEMA IF EXISTS ${SCH} CASCADE`).catch(() => {});
  const haengt = await pool.query(`SELECT COUNT(*)::int n FROM pg_stat_activity WHERE state LIKE 'idle in transaction%' AND query LIKE '%${SCH}%'`).catch(() => ({ rows: [{ n: -1 }] }));
  console.log('HAENGEND ' + haengt.rows[0].n + ' Sitzungen idle in transaction mit Testbezug');
  if (haengt.rows[0].n !== 0) fehler++;
  console.error = origError;
}
console.log(fehler === 0 ? 'ERGEBNIS alle Zusagen erfuellt' : 'ERGEBNIS ' + fehler + ' Zusage(n) verletzt');
await pool.end().catch(() => {});
process.exit(fehler === 0 ? 0 : 1);
