/**
 * P22-T98 (21.10.2026): intern db_lesen / db_schema gegen die Test-DB.
 *
 * ZUSAGEN:
 *   S  Schalter: Produkt-Schalter db_lesen im Katalog (nur ausdruecklich), Standard AUS -> db_lesen_aus;
 *      intern-Override db_lesen (schalter_setzen, freigegeben) schaltet ein, Antwort zeigt quelle intern.
 *   P  Projekt: nur SYNAPSE_DB_LESEN_PROJEKT (hier eigenes Testprojekt); anderes Projekt und Visum/Fremdprojekt abgewiesen.
 *   L  Lesen: Zeilen/Spalten im Array-Modus, params, EXPLAIN, ; im String-Literal und am Ende erlaubt,
 *      limit (abgeschnitten, Obergrenze 2000).
 *   M  Maskierung: Spalten token_hash/token_offen/passwort, JSON-Schluessel, Ausweis sai_ und Hex-Hash im Text, bytea.
 *   V  Vorpruefung weist ab: INSERT, UPDATE, DELETE, MERGE, TRUNCATE, DDL (CREATE/ALTER/DROP/GRANT), COPY,
 *      mehrere Statements (auch hinter Kommentar), schreibende CTE, SELECT INTO, FOR UPDATE, SET/BEGIN,
 *      gesperrte Funktionen (pg_sleep auch als "pg_sleep", dblink, set_config, lo_import, pg_read_file), U&-Escape.
 *   R  Server: eine Funktion mit INSERT (Vorpruefung passiert) scheitert an der READ-ONLY-Transaktion (25006),
 *      Tabelle unveraendert; statement_timeout greift (57014).
 *   A  Audit: jeder Aufruf (auch abgewiesen) als tool_calls intern/db_lesen_audit mit SQL-Text, ohne Geheimnisse.
 *   D  db_schema: Tabellenliste, Spalten mit maskiert, Indizes, unbekannte/ungueltige Tabelle.
 *   X  Demaskieren: maskierung:false liefert nur bestaetigung_id (kein Ergebnis, Schreibsperre gilt weiter); Bestaetigung
 *      nur mit ID + Grund OHNE sql liefert direkt unmaskiert; ohne/zu kurzer Grund, fremder Agent, benutzte, abgelaufene
 *      und unbekannte ID abgewiesen; Audit mit Grund, Agent, Spalten ohne Werte; allgemeine tool_calls-Zeile ohne Ergebnis.
 *
 * ABSICHERUNG: nur Test-DB (...:5433/synapse_test, sonst Exit 2); eigenes Schema und Testprojekt, am Ende entfernt.
 * AUFRUF: (DATABASE_URL = Test-DB aus dem Synapse-shell-Job) node packages/core/tests/intern-db-lesen-p22-t98.test.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pruefeTestDbUrl } from '../../../scripts/lib/test-db-schutz.mjs';

pruefeTestDbUrl('intern-db-lesen-p22-t98.test');
const KENNUNG = randomUUID().replaceAll('-', '').slice(0, 10);
const PROJECT = 'p22t98-dblesen-' + KENNUNG;
const SCHEMA = 'p22t98_' + KENNUNG;
const ANDERES = 'p22t98-anderes-' + KENNUNG, HEIMAT = 'p22t98-heimat-' + KENNUNG;
const START = new Date();
process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.QDRANT_URL = 'http://127.0.0.1:9';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.OLLAMA_MODEL = 'fake-embed';
process.env.SYNAPSE_INTERN_TOOL = '1';
process.env.SYNAPSE_DB_LESEN_PROJEKT = PROJECT;
delete process.env.SYNAPSE_DB_LESEN_URL;

const hier = dirname(fileURLToPath(import.meta.url));
const dist = join(hier, '..', 'dist');
const lade = (...teile) => import(pathToFileURL(join(...teile)).href);

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.log('FEHLER  ' + text + (detail !== undefined ? '\n        ' + JSON.stringify(detail).slice(0, 2000) : '')); }
}

createRequire(join(hier, '..', 'package.json'))('pg');
const db = await lade(dist, 'db', 'client.js');
const pool = db.getPool();
const ddl = readFileSync(join(dist, 'db', 'schema.js'), 'utf8').match(/CREATE TABLE IF NOT EXISTS intern_schalter \([\s\S]*?\n\);/)?.[0];
await pool.query("SET lock_timeout = '5s'");
await pool.query(ddl);
const T = await lade(dist, 'services', 'intern-tool.js');
const S = await lade(dist, 'services', 'agent-profil-schalter.js');
const B = await lade(dist, 'services', 'agent-bezug.js');
const L = await lade(dist, 'services', 'intern-db-lesen.js');
const TL = await lade(dist, 'services', 'tool-call-log.js');

const lies = (args) => T.fuehreInternAus({ project: PROJECT, ...args }, 'claude-db-lesen-test');
const sql = (s, weitere = {}) => lies({ action: 'db_lesen', sql: s, ...weitere });
const TAB = SCHEMA + '.daten';
const HASH64 = 'a'.repeat(8) + '0123456789abcdef'.repeat(3) + 'deadbeef';

try {
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await pool.query(`CREATE TABLE ${TAB} (id int PRIMARY KEY, name text, token_hash text, token_offen text, passwort text, meta jsonb, roh bytea)`);
  await pool.query(`CREATE INDEX daten_name_idx ON ${TAB}(name)`);
  await pool.query(`INSERT INTO ${TAB} VALUES
    (1, 'eins', 'h1', 'sai_x', 'geheim1', '{"password":"pw1","token":"t1","ok":1,"tief":{"api_key":"k1","x":2}}', '\\x0102'),
    (2, 'zwei mit sai_k7 drin', 'h2', 'sai_y', 'geheim2', '{"ok":2}', NULL),
    (3, 'hash ${HASH64}', NULL, NULL, NULL, NULL, NULL),
    (4, '${HASH64}', NULL, NULL, NULL, NULL, NULL),
    (5, 'fuenf', NULL, NULL, NULL, NULL, NULL)`);
  await pool.query(`CREATE FUNCTION ${SCHEMA}.schreib() RETURNS int LANGUAGE plpgsql AS $f$
    BEGIN INSERT INTO ${TAB}(id, name) VALUES (99, 'durchgekommen'); RETURN 1; END $f$`);
  await pool.query("DELETE FROM intern_schalter WHERE name = 'db_lesen'");

  // ---------------------------------------------------------------- S
  pruefe(S.PROFIL_PRODUKT_FUNKTIONEN.includes('db_lesen') && S.NUR_AUSDRUECKLICH.includes('db_lesen') && !S.STANDARD_EIN.includes('db_lesen'),
    'S Produkt-Schalter db_lesen im Katalog, nur ausdruecklich, Standard AUS');
  let r = await sql(`SELECT id FROM ${TAB}`);
  pruefe(r.success === false && r.error === 'db_lesen_aus' && r.schalter?.aktiv === false, 'S Standard AUS -> db_lesen_aus', r);
  r = await lies({ action: 'db_schema' });
  pruefe(r.success === false && r.error === 'db_lesen_aus', 'S db_schema bei AUS abgewiesen', r);
  r = await T.fuehreInternAus({ action: 'schalter_setzen', name: 'db_lesen', aktiv: true, modus: 'freigegeben', dauer_min: 15, grund: 'P22-T98 Test' }, 'claude-db-lesen-test');
  pruefe(r.success === true && r.schalter?.aktiv === true, 'S intern-Override db_lesen gesetzt', r);
  r = await sql(`SELECT id FROM ${TAB} ORDER BY id`);
  pruefe(r.success === true && r.schalter?.quelle === 'intern' && r.zeilen_anzahl === 5, 'S Override EIN -> db_lesen laeuft (quelle intern)', r);

  // ---------------------------------------------------------------- P
  r = await T.fuehreInternAus({ action: 'db_lesen', project: ANDERES, sql: 'SELECT 1' });
  pruefe(r.success === false && r.error === 'nur_projekt_synapse', 'P anderes Projekt abgewiesen', r);
  r = await T.fuehreInternAus({ action: 'db_lesen', sql: 'SELECT 1' });
  pruefe(r.success === false && r.error === 'nur_projekt_synapse', 'P ohne Projekt abgewiesen', r);
  const bezug = await B.leseAgentBezugModus();
  r = await B.mitAgentAufrufKontext({ principal: { art: 'legacy', project: PROJECT, agent_id: 'gast' }, bezug,
    fremdprojekt: { project: PROJECT, heimat: HEIMAT, zugang: 'visum', identity_id: randomUUID() } },
  () => T.fuehreInternAus({ action: 'db_lesen', sql: 'SELECT 1' }));
  pruefe(r.success === false && r.error === 'nur_projekt_synapse', 'P Visum/Fremdprojekt abgewiesen', r);
  r = await B.mitAgentAufrufKontext({ principal: { art: 'legacy', project: HEIMAT, agent_id: 'gast' }, bezug },
    () => T.fuehreInternAus({ action: 'db_lesen', project: PROJECT, sql: 'SELECT 1' }));
  pruefe(r.success === false && r.error === 'nur_projekt_synapse', 'P Principal-Projekt zaehlt, nicht das Argument project', r);

  // ---------------------------------------------------------------- L
  r = await sql(`SELECT id, name AS n, id FROM ${TAB} WHERE id = $1`, { params: [5] });
  pruefe(r.success && r.spalten.map((s) => s.name).join(',') === 'id,n,id' && JSON.stringify(r.zeilen) === '[[5,"fuenf",5]]'
    && r.spalten[0].typ === 'int4', 'L params + doppelte Spaltennamen (Array-Modus) + Typname', r);
  r = await sql(`SELECT ';' AS s, 'a''b' AS q, $x$ ; drop $x$ AS d -- ; kommentar\n;`);
  pruefe(r.success && JSON.stringify(r.zeilen) === '[[";","a\'b"," ; drop "]]', 'L ; in Literal/Dollar-Quote/Kommentar und am Ende erlaubt', r);
  r = await sql(`WITH x AS (SELECT id FROM ${TAB}) SELECT count(*)::int AS n FROM x`);
  pruefe(r.success && r.zeilen[0][0] === 5, 'L WITH (lesend)', r);
  r = await sql(`EXPLAIN SELECT * FROM ${TAB} WHERE id = 1`);
  pruefe(r.success && r.art === 'explain' && r.zeilen_anzahl >= 1 && /QUERY PLAN/i.test(r.spalten[0].name), 'L EXPLAIN', r);
  r = await sql(`SELECT id FROM ${TAB} ORDER BY id`, { limit: 2 });
  pruefe(r.success && JSON.stringify(r.zeilen) === '[[1],[2]]' && r.abgeschnitten === true && r.limit === 2, 'L limit 2 -> abgeschnitten', r);
  r = await sql('SELECT g FROM generate_series(1, 2500) g', { limit: 99999 });
  pruefe(r.success && r.limit === 2000 && r.zeilen_anzahl === 2000 && r.abgeschnitten === true, 'L limit auf 2000 gekappt', { limit: r.limit, n: r.zeilen_anzahl });
  r = await sql('SELECT 1', { limit: 0 });
  pruefe(r.success === false && r.error === 'parameter_ungueltig', 'L limit 0 -> parameter_ungueltig', r);
  r = await sql('SELECT 1', { params: [{ a: 1 }] });
  pruefe(r.success === false && r.error === 'parameter_ungueltig', 'L params nur Skalare', r);

  // ---------------------------------------------------------------- M
  r = await sql(`SELECT * FROM ${TAB} ORDER BY id`);
  const sp = Object.fromEntries(r.spalten.map((s, i) => [s.name, i]));
  const z1 = r.zeilen?.[0] ?? [], z2 = r.zeilen?.[1] ?? [], z3 = r.zeilen?.[2] ?? [], z4 = r.zeilen?.[3] ?? [];
  pruefe(r.success && z1[sp.token_hash] === '[WERT]' && z1[sp.token_offen] === '[WERT]' && z1[sp.passwort] === '[WERT]'
    && z3[sp.token_hash] === null, 'M Geheimnis-Spalten [WERT], NULL bleibt NULL', r.zeilen?.slice(0, 3));
  pruefe(JSON.stringify(r.maskiert?.spalten?.sort()) === JSON.stringify(['passwort', 'token_hash', 'token_offen']), 'M maskiert.spalten', r.maskiert);
  const meta = z1[sp.meta];
  pruefe(meta && meta.password === '[WERT]' && meta.token === '[WERT]' && meta.ok === 1 && meta.tief?.api_key === '[WERT]' && meta.tief?.x === 2,
    'M JSON-Schluessel maskiert (auch verschachtelt)', meta);
  pruefe(z2[sp.name] === 'zwei mit [WERT] drin', 'M Ausweis im Text maskiert', z2[sp.name]);
  pruefe(z3[sp.name] === 'hash [WERT]' && z4[sp.name] === '[WERT]', 'M Hex-Hash im Text und als ganzer Wert maskiert', [z3[sp.name], z4[sp.name]]);
  pruefe(z1[sp.roh] === '[BYTES 2]', 'M bytea nur als Groesse', z1[sp.roh]);
  pruefe(!JSON.stringify(r).includes('sai_x') && !JSON.stringify(r).includes('geheim1') && !JSON.stringify(r).includes(HASH64), 'M kein Geheimnis in der Antwort');
  r = await sql(`SELECT to_jsonb(d) AS j FROM ${TAB} d WHERE id = 1`);
  pruefe(r.success && r.zeilen[0][0].token_offen === '[WERT]' && r.zeilen[0][0].token_hash === '[WERT]' && r.zeilen[0][0].name === 'eins',
    'M ganze Zeile als JSON: Geheimnis-Schluessel maskiert', r.zeilen);

  // ---------------------------------------------------------------- V
  const abgewiesen = [
    ['INSERT', `INSERT INTO ${TAB}(id) VALUES (50)`, 'nur_lesen'],
    ['UPDATE', `UPDATE ${TAB} SET name = 'x'`, 'nur_lesen'],
    ['DELETE', `DELETE FROM ${TAB}`, 'nur_lesen'],
    ['MERGE', `MERGE INTO ${TAB} t USING ${TAB} s ON t.id = s.id WHEN MATCHED THEN DELETE`, 'nur_lesen'],
    ['TRUNCATE', `TRUNCATE ${TAB}`, 'nur_lesen'],
    ['DDL CREATE', `CREATE TABLE ${SCHEMA}.neu (x int)`, 'nur_lesen'],
    ['DDL ALTER', `ALTER TABLE ${TAB} ADD COLUMN y int`, 'nur_lesen'],
    ['DDL DROP', `DROP TABLE ${TAB}`, 'nur_lesen'],
    ['DDL GRANT', `GRANT SELECT ON ${TAB} TO PUBLIC`, 'nur_lesen'],
    ['COPY', `COPY ${TAB} TO STDOUT`, 'nur_lesen'],
    ['COPY in SELECT-Gestalt', `SELECT 1 FROM (COPY ${TAB} TO STDOUT) x`, 'nur_lesen'],
    ['zwei Statements', 'SELECT 1; SELECT 2', 'mehrere_statements'],
    ['SELECT; INSERT', `SELECT 1; INSERT INTO ${TAB}(id) VALUES (51)`, 'mehrere_statements'],
    ['Statement hinter Kommentar', `SELECT 1 -- x\n; DROP TABLE ${TAB}`, 'mehrere_statements'],
    ['Statement hinter Blockkommentar', `SELECT 1 /* ; */ ; DELETE FROM ${TAB}`, 'mehrere_statements'],
    ['schreibende CTE', `WITH x AS (DELETE FROM ${TAB} RETURNING id) SELECT * FROM x`, 'nur_lesen'],
    ['SELECT INTO', `SELECT * INTO ${SCHEMA}.kopie FROM ${TAB}`, 'nur_lesen'],
    ['FOR UPDATE', `SELECT * FROM ${TAB} FOR UPDATE`, 'nur_lesen'],
    ['FOR SHARE', `SELECT * FROM ${TAB} FOR SHARE`, 'nur_lesen'],
    ['SET ROLE', 'SET ROLE postgres', 'nur_lesen'],
    ['BEGIN', 'BEGIN', 'nur_lesen'],
    ['pg_sleep', 'SELECT pg_sleep(1)', 'funktion_gesperrt'],
    ['"pg_sleep"', 'SELECT "pg_sleep"(1)', 'funktion_gesperrt'],
    ['pg_catalog.pg_sleep', 'SELECT pg_catalog.pg_sleep(1)', 'funktion_gesperrt'],
    ['dblink', "SELECT * FROM dblink_exec('dbname=x', 'DROP TABLE y')", 'funktion_gesperrt'],
    ['set_config', "SELECT set_config('transaction_read_only', 'off', true)", 'funktion_gesperrt'],
    ['lo_import', "SELECT lo_import('/etc/passwd')", 'funktion_gesperrt'],
    ['pg_read_file', "SELECT pg_read_file('/etc/passwd')", 'funktion_gesperrt'],
    ['query_to_xml', "SELECT query_to_xml('select 1', true, true, '')", 'funktion_gesperrt'],
    ['Advisory-Lock', 'SELECT pg_advisory_lock(1)', 'funktion_gesperrt'],
    ['U&-Escape', 'SELECT U&"\\0070g_sleep"(1)', 'sql_gesperrt'],
    ['offenes Literal', "SELECT 'abc", 'sql_unvollstaendig'],
    ['Klammer-Ausbruch', `SELECT 1) x, (SELECT 2`, 'klammern_ungleich'],
    ['leer', '-- nur Kommentar', 'sql_leer'],
  ];
  for (const [name, s, code] of abgewiesen) {
    r = await sql(s);
    pruefe(r.success === false && r.error === code, `V ${name} -> ${code}`, r);
  }
  const anzahl = (await pool.query(`SELECT count(*)::int AS n FROM ${TAB}`)).rows[0].n;
  const spalten = (await pool.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'daten'", [SCHEMA])).rows[0].n;
  pruefe(anzahl === 5 && spalten === 7, 'V Tabelle nach allen Versuchen unveraendert (5 Zeilen, 7 Spalten)', { anzahl, spalten });

  // ---------------------------------------------------------------- R
  r = await sql(`SELECT ${SCHEMA}.schreib()`);
  pruefe(r.success === false && r.error === 'sql_fehler' && r.pg_code === '25006', 'R Funktion mit INSERT scheitert an READ ONLY (25006)', r);
  const nachher = (await pool.query(`SELECT count(*)::int AS n FROM ${TAB} WHERE id = 99`)).rows[0].n;
  pruefe(nachher === 0, 'R kein Zeilenzuwachs durch die Funktion', nachher);
  r = await sql('SELECT count(*) FROM generate_series(1, 2000000000) a', { timeout_ms: 300 });
  pruefe(r.success === false && r.error === 'sql_fehler' && r.pg_code === '57014', 'R statement_timeout greift (57014)', r);
  await new Promise((res) => setTimeout(res, 500));
  const offen = (await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'synapse-db-lesen'")).rows[0].n;
  pruefe(offen === 0, 'R keine offene db_lesen-Verbindung nach den Aufrufen', offen);

  // ---------------------------------------------------------------- D
  r = await lies({ action: 'db_schema' });
  pruefe(r.success && r.tabellen.some((t) => t.schema === SCHEMA && t.tabelle === 'daten' && t.spalten === 7), 'D Tabellenliste enthaelt die Testtabelle', r.success ? r.anzahl : r);
  r = await lies({ action: 'db_schema', db_tabelle: TAB });
  const th = r.spalten?.find((s) => s.name === 'token_hash'), nm = r.spalten?.find((s) => s.name === 'name');
  pruefe(r.success && th?.maskiert === true && nm && !nm.maskiert && r.indizes.some((i) => i.name === 'daten_name_idx') && r.constraints.some((c) => c.art === 'p'),
    'D Spalten (maskiert), Indizes, Constraints', r);
  r = await lies({ action: 'db_schema', db_tabelle: SCHEMA + '.gibtsnicht' });
  pruefe(r.success === false && r.error === 'tabelle_unbekannt', 'D unbekannte Tabelle', r);
  r = await lies({ action: 'db_schema', db_tabelle: "x'; drop table y; --" });
  pruefe(r.success === false && r.error === 'parameter_ungueltig', 'D ungueltiger Tabellenname', r);

  // ---------------------------------------------------------------- X (Demaskieren per Rueckfrage-ID + Grund)
  const GRUND = 'Pruefung der Token-Zuordnung fuer P22-T98';
  r = await sql(`SELECT id, token_offen, passwort, roh, meta FROM ${TAB} WHERE id = $1`, { params: [1], maskierung: false });
  const id1 = r.bestaetigung_id;
  pruefe(r.success === false && r.error === 'demaskieren_rueckfrage' && typeof id1 === 'string' && r.zeilen === undefined && r.einmalig === true,
    'X maskierung:false liefert nur bestaetigung_id, kein Ergebnis', r);
  r = await sql(`INSERT INTO ${TAB}(id) VALUES (60)`, { maskierung: false });
  pruefe(r.success === false && r.error === 'nur_lesen' && r.bestaetigung_id === undefined, 'X Schreibsperre gilt auch beim Demaskieren (keine ID)', r);
  r = await lies({ action: 'db_lesen', bestaetigung: { id: id1 } });
  pruefe(r.success === false && r.error === 'grund_fehlt' && r.zeilen === undefined, 'X ohne Grund abgewiesen', r);
  r = await lies({ action: 'db_lesen', bestaetigung: { id: id1, grund: 'kurz' } });
  pruefe(r.success === false && r.error === 'grund_fehlt', 'X zu kurzer Grund abgewiesen', r);
  r = await T.fuehreInternAus({ project: PROJECT, action: 'db_lesen', bestaetigung: { id: id1, grund: GRUND } }, 'ein-anderer-agent');
  pruefe(r.success === false && r.error === 'bestaetigung_fremd' && r.zeilen === undefined, 'X fremder Agent abgewiesen', r);
  r = await lies({ action: 'db_lesen', bestaetigung: { id: id1, grund: GRUND } });
  const zx = r.zeilen?.[0] ?? [];
  pruefe(r.success === true && r.demaskiert === true && zx[0] === 1 && zx[1] === 'sai_x' && zx[2] === 'geheim1' && zx[3] === '\\x0102' && zx[4]?.password === 'pw1',
    'X ID + Grund (ohne sql) liefert direkt das unmaskierte Ergebnis', r);
  pruefe(JSON.stringify(r.demaskierte_spalten?.spalten?.sort()) === JSON.stringify(['passwort', 'token_offen']) && r.grund === GRUND,
    'X demaskierte_spalten + Grund in der Antwort', r.demaskierte_spalten);
  r = await lies({ action: 'db_lesen', bestaetigung: { id: id1, grund: GRUND } });
  pruefe(r.success === false && r.error === 'bestaetigung_unbekannt', 'X benutzte ID abgewiesen (einmalig)', r);
  r = await sql(`SELECT token_offen FROM ${TAB} WHERE id = 1`, { maskierung: false });
  const id2 = r.bestaetigung_id;
  L.demaskierAnfragen().get(id2).bis = Date.now() - 1;
  r = await lies({ action: 'db_lesen', bestaetigung: { id: id2, grund: GRUND } });
  pruefe(r.success === false && r.error === 'bestaetigung_abgelaufen', 'X abgelaufene ID abgewiesen', r);
  r = await lies({ action: 'db_lesen', bestaetigung: { id: 'ffffffffffffffff', grund: GRUND } });
  pruefe(r.success === false && r.error === 'bestaetigung_unbekannt', 'X unbekannte ID abgewiesen', r);
  const xa = (await pool.query(
    "SELECT ok, agent_id, args_preview, result FROM tool_calls WHERE project = $1 AND action = 'db_lesen_audit' AND args_preview LIKE $2 ORDER BY id",
    [PROJECT, '%' + GRUND + '%'])).rows;
  const xok = xa.find((z) => z.ok === true);
  pruefe(xok && xok.agent_id === 'claude-db-lesen-test' && xok.args_preview.includes('SELECT id, token_offen') && xok.result.includes('token_offen')
    && !JSON.stringify(xa).includes('sai_x') && !JSON.stringify(xa).includes('geheim1') && !JSON.stringify(xa).includes('pw1'),
    'X Audit: Grund, Agent, SQL und Spalten, keine Werte', xa);
  await TL.logToolCall({ project: PROJECT, agentId: 'claude-db-lesen-test', tool: 'intern', action: 'db_lesen', argsPreview: '{}', ok: true,
    result: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ success: true, demaskiert: true, zeilen: [['geheim1']] }) }] }) });
  const gl = (await pool.query("SELECT result FROM tool_calls WHERE project = $1 AND tool_name = 'intern' AND action = 'db_lesen' ORDER BY id DESC LIMIT 1", [PROJECT])).rows[0];
  pruefe(gl && /nicht protokolliert: demaskiertes/.test(gl.result) && !gl.result.includes('geheim1'), 'X allgemeine tool_calls-Zeile speichert kein demaskiertes Ergebnis', gl);

  // ---------------------------------------------------------------- A
  const audit = (await pool.query(
    "SELECT action, ok, error, args_preview, result FROM tool_calls WHERE project = $1 AND tool_name = 'intern' ORDER BY id", [PROJECT])).rows;
  const lesen = audit.filter((z) => z.action === 'db_lesen_audit');
  pruefe(lesen.length >= abgewiesen.length + 10, 'A je db_lesen-Aufruf eine Audit-Zeile', lesen.length);
  pruefe(lesen.some((z) => z.ok === false && z.error === 'nur_lesen' && z.args_preview.includes('DELETE FROM ' + TAB)), 'A abgewiesener Aufruf mit SQL-Text', lesen.filter((z) => !z.ok).slice(0, 2));
  pruefe(lesen.some((z) => z.ok === true && z.args_preview.includes('SELECT * FROM ' + TAB)), 'A erfolgreicher Aufruf mit SQL-Text');
  pruefe(audit.some((z) => z.action === 'db_schema_audit'), 'A db_schema im Audit');
  pruefe(!JSON.stringify(audit).includes('geheim1') && !JSON.stringify(audit).includes('sai_x'), 'A keine Geheimnisse im Audit');
} finally {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
  await pool.query("DELETE FROM intern_schalter WHERE name = 'db_lesen'").catch(() => {});
  await pool.query('DELETE FROM tool_calls WHERE project = ANY($1::text[])', [[PROJECT, ANDERES, HEIMAT]]).catch(() => {});
  await pool.query("DELETE FROM tool_calls WHERE project IS NULL AND tool_name = 'intern' AND action = 'db_lesen_audit' AND ts >= $1", [START]).catch(() => {});
  await db.closePool().catch(() => {});
}
console.log(fehler === 0 ? '\nALLE PRUEFUNGEN GRUEN' : `\n${fehler} PRUEFUNG(EN) ROT`);
process.exit(fehler === 0 ? 0 : 1);
