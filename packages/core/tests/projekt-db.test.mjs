/**
 * Projekt-DB (packages/core/src/services/projekt-db.ts + rest-api/routes/projekt-db.ts)
 *
 * Laeuft OHNE Unraid: startet einen lokalen Wegwerf-Container postgres:16 unter dem
 * Namen postgresql16_2 (den verlangt die Whitelist) und benutzt darin eine Wegwerf-DB
 * "syntest" als Synapse-DB fuer den Core-Pool. Das Pool-Ziel wird vor jedem Schreiben
 * hart geprueft. Kein Docker oder Container-Name schon belegt -> sauber uebersprungen.
 *
 * Voraussetzung: pnpm --filter @synapse/core build && pnpm --filter @synapse/rest-api build
 * Aufruf:        node packages/core/tests/projekt-db.test.mjs
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const CORE_DIST = path.join(HIER, '../dist/index.js');
const ROUTE_DIST = path.join(HIER, '../../rest-api/dist/routes/projekt-db.js');
const FASTIFY = path.join(HIER, '../../rest-api/node_modules/fastify/fastify.js');
const CONTAINER = 'postgresql16_2';

function ueberspringen(grund) {
  console.log(`SKIP projekt-db.test: ${grund}`);
  process.exit(0);
}

if (spawnSync('docker', ['version'], { stdio: 'ignore' }).status !== 0) ueberspringen('kein Docker verfuegbar');
if (!fs.existsSync(CORE_DIST) || !fs.existsSync(ROUTE_DIST)) ueberspringen('core/rest-api nicht gebaut');
if (execFileSync('docker', ['ps', '-a', '--filter', `name=^${CONTAINER}$`, '--format', '{{.Names}}']).toString().trim()) {
  ueberspringen(`Container ${CONTAINER} existiert lokal schon — wird nicht angefasst`);
}

let fehler = 0;
const ok = (name, bedingung) => {
  console.log((bedingung ? 'OK   ' : 'FAIL ') + name);
  if (!bedingung) fehler++;
};
const docker = (...args) => execFileSync('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'projekt-db-test-'));

try {
  // --- Wegwerf-Container ---------------------------------------------------
  const adminPw = randomBytes(16).toString('hex');
  docker('run', '-d', '--name', CONTAINER, '-e', 'POSTGRES_USER=pgadmin', '-e', `POSTGRES_PASSWORD=${adminPw}`, 'postgres:16');
  for (let i = 0; i < 40; i++) {
    if (spawnSync('docker', ['exec', CONTAINER, 'pg_isready', '-U', 'pgadmin', '-q']).status === 0) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 1000));
  const ip = docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', CONTAINER).trim();
  execFileSync('docker', ['exec', '-i', CONTAINER, 'psql', '-q', '-U', 'pgadmin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
    input: `CREATE DATABASE syntest;
CREATE ROLE spdb_fremd LOGIN PASSWORD 'fremdes-pw-1';
CREATE DATABASE spdb_fremd OWNER spdb_fremd;
REVOKE ALL ON DATABASE spdb_fremd FROM PUBLIC;
CREATE ROLE spdb_fremd2_user LOGIN PASSWORD 'fremdes-pw-2';
CREATE DATABASE spdb_fremd2 OWNER spdb_fremd2_user;
CREATE ROLE spdb_rolle_user LOGIN CREATEDB PASSWORD 'fremdes-pw-3';
\\c spdb_fremd
CREATE TABLE daten(id int, txt text); INSERT INTO daten VALUES (1,'bleibt'),(2,'so');
\\c syntest
CREATE TABLE projekt_datenbanken (project TEXT PRIMARY KEY, host TEXT NOT NULL, port INTEGER NOT NULL, db TEXT NOT NULL, db_user TEXT NOT NULL, passwort TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
`,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  const konfPfad = path.join(scratch, 'projektdb.env');
  fs.writeFileSync(konfPfad, 'PROJEKTDB_HOST=192.168.50.65\nPROJEKTDB_PORT=5433\nPROJEKTDB_CONTAINER=postgresql16_2\nPROJEKTDB_ADMIN_USER=pgadmin\n');

  // Pool auf die Wegwerf-DB, BEVOR der Core geladen wird.
  process.env.DATABASE_URL = `postgresql://pgadmin:${adminPw}@${ip}:5432/syntest`;
  process.env.SYNAPSE_DB_URL = process.env.DATABASE_URL;
  process.env.SYNAPSE_PROJEKTDB_ENV = konfPfad;

  const core = await import(CORE_DIST);
  const { dockerPsqlAusfuehrer, projektDbRoutes } = await import(ROUTE_DIST);
  const Fastify = (await import(FASTIFY)).default;
  const pool = core.getPool();
  if ((await pool.query('SELECT current_database() AS d')).rows[0].d !== 'syntest') {
    throw new Error('ABBRUCH: Core-Pool zeigt nicht auf die Wegwerf-DB syntest');
  }

  const K = { host: '192.168.50.65', port: 5433, container: CONTAINER, adminUser: 'pgadmin' };
  const ex = dockerPsqlAusfuehrer(K);

  // --- A: Whitelist + Logik mit injiziertem Ausfuehrer ----------------------
  const wirft = (z) => { try { core.pruefeProjektDbZiel(z); return false; } catch { return true; } };
  ok('A Whitelist: Port 5432 bricht ab', wirft({ ...K, database: 'x_y', port: 5432 }));
  ok('A Whitelist: Container postgresql16 bricht ab', wirft({ ...K, database: 'x_y', container: 'postgresql16' }));
  ok('A Whitelist: DB synapse bricht ab', wirft({ ...K, database: 'Synapse' }));
  ok('A Whitelist: fremder Host bricht ab', wirft({ ...K, database: 'x_y', host: '127.0.0.1' }));
  ok('A Whitelist: 192.168.50.65:5433 erlaubt', !wirft({ ...K, database: 'x_y' }));
  const fake = (antworten, fehlerBei) => {
    const log = [];
    const f = async (sql) => { log.push(sql); if (fehlerBei && sql.includes(fehlerBei)) throw new Error('boom ' + sql); return antworten.shift() ?? ''; };
    f.log = log;
    return f;
  };
  let f = fake([]);
  let r = await core.legeProjektDbAn('spdb-x', f, { konfig: { ...K, port: 5432 }, memory: false });
  ok('A Konfig 5432 -> fehler, kein Aufruf', r.status === 'fehler' && f.log.length === 0);
  f = fake([]);
  r = await core.legeProjektDbAn('spdb-x', f, { konfig: { ...K, container: 'postgresql16' }, memory: false });
  ok('A Konfig postgresql16 -> fehler, kein Aufruf', r.status === 'fehler' && f.log.length === 0);
  r = await core.legeProjektDbAn('spdb-x', fake([]), { konfig: null });
  ok('A ohne Konfig -> nicht_konfiguriert', r.status === 'nicht_konfiguriert');
  r = await core.legeProjektDbAn('synapse', fake([]), { konfig: K });
  ok('A Projekt synapse -> uebersprungen', r.status === 'uebersprungen');
  f = fake(['1|0|0']);
  r = await core.legeProjektDbAn('spdb-x', f, { konfig: K, memory: false });
  ok('A Instanz mit DB synapse -> fehler, keine Anlage', r.status === 'fehler' && f.log.length === 1);
  f = fake(['0|0|0', '', '', '0|000|0']);
  r = await core.legeProjektDbAn('spdb-x', f, { konfig: K, memory: false });
  const rolleSql = f.log[1] ?? '';
  const anlageSql = f.log[2] ?? '';
  ok('A angelegt + Passwort 28 Zeichen', r.status === 'angelegt' && r.passwort?.length === 28 && r.user === 'spdb_x_user' && r.database === 'spdb_x');
  ok('A SQL Rechte-Modell',
    /CREATE ROLE "spdb_x_user" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE/.test(rolleSql)
    && anlageSql.includes('OWNER "spdb_x_user"')
    && anlageSql.includes('REVOKE ALL ON DATABASE "spdb_x" FROM PUBLIC')
    && anlageSql.includes('GRANT CONNECT, TEMPORARY ON DATABASE "spdb_x" TO "spdb_x_user"')
    && anlageSql.includes('ALTER SCHEMA public OWNER TO "spdb_x_user"')
    && anlageSql.includes('lock_timeout'));
  f = fake(['0|0|0', ''], 'CREATE DATABASE');
  r = await core.legeProjektDbAn('spdb-x', f, { konfig: K, memory: false });
  ok('A Anlage-Fehler: Passwort geschwaerzt + Rueckbau eigener Objekte',
    r.status === 'fehler' && !r.passwort && f.log.some((s) => s.includes('DROP ROLE IF EXISTS "spdb_x_user"')));
  f = fake(['0|0|0', '', '', '0|100|0', '']);
  r = await core.legeProjektDbAn('spdb-x', f, { konfig: K, memory: false });
  ok('A Nachpruefung Superuser -> fehler + Rueckbau', r.status === 'fehler' && f.log.some((s) => s.includes('DROP ROLE')));
  const log6 = [];
  const f6 = async (sql) => { log6.push(sql); if (sql.includes('CREATE ROLE')) throw new Error('role exists'); return log6.length === 1 ? '0|0|0' : ''; };
  r = await core.legeProjektDbAn('spdb-x', f6, { konfig: K, memory: false });
  ok('A CREATE ROLE scheitert -> fehler, KEIN DROP', r.status === 'fehler' && !log6.some((s) => s.includes('DROP')));
  await pool.query('DELETE FROM projekt_datenbanken');

  // --- B: echter dockerode-Ausfuehrer, Rechte ---------------------------------
  const dir = path.join(scratch, 'spdb-wegwerf');
  fs.mkdirSync(dir);
  const e = await core.legeProjektDbAn('spdb-wegwerf', ex, { konfig: K, projektPfad: dir, memory: false });
  ok('B angelegt', e.status === 'angelegt');
  const e2 = await core.legeProjektDbAn('spdb-andere', ex, { konfig: K, memory: false });
  ok('B zweite Projekt-DB angelegt', e2.status === 'angelegt');
  core.schreibeProjektDbEnv(dir, e);
  const envP = path.join(dir, '.env');
  ok('B .env 600 + DSN auf 5433', (fs.statSync(envP).mode & 0o777) === 0o600 && fs.readFileSync(envP, 'utf8').includes('@192.168.50.65:5433/spdb_wegwerf'));
  ok('B .gitignore + .env.example', fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').includes('.env') && fs.readFileSync(path.join(dir, '.env.example'), 'utf8').includes('<PASSWORT>'));
  // Ueber die Container-IP (scram) statt 127.0.0.1 (im offiziellen Image trust).
  const alsRolle = (pw, db, sql) => {
    try {
      return { ok: true, out: execFileSync('docker', ['exec', '-e', `PGPASSWORD=${pw}`, CONTAINER, 'psql', '-X', '-tA', '-h', ip, '-U', 'spdb_wegwerf_user', '-d', db, '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: ['ignore', 'pipe', 'pipe'] }).toString() };
    } catch (x) {
      return { ok: false, out: String(x.stderr) };
    }
  };
  const schreib = alsRolle(e.passwort, 'spdb_wegwerf', 'CREATE TABLE t(id int); INSERT INTO t VALUES (1); SELECT count(*) FROM t;');
  ok('B Rolle schreibt in eigene DB (Passwort-Login)', schreib.ok && schreib.out.trim().endsWith('1'));
  const fremd = alsRolle(e.passwort, 'spdb_andere', 'SELECT 1');
  ok('B kein CONNECT auf andere Projekt-DB', !fremd.ok && /permission denied/.test(fremd.out));
  ok('B falsches Passwort abgelehnt', !alsRolle('falsch', 'spdb_wegwerf', 'SELECT 1').ok);
  const flags = (await ex("SELECT rolsuper::int::text || rolcreatedb::int::text || rolcreaterole::int::text FROM pg_roles WHERE rolname='spdb_wegwerf_user';", 'postgres')).trim();
  ok('B Rolle kein Superuser/CreateDB/CreateRole', flags === '000');
  const e3 = await core.legeProjektDbAn('spdb-wegwerf', ex, { konfig: K, memory: false });
  ok('B zweiter Lauf: vorhanden, kein Passwort', e3.status === 'vorhanden' && !e3.passwort);

  // --- C: Route + Zugang aus projekt_datenbanken -------------------------------
  const app = Fastify();
  await app.register(projektDbRoutes);
  await app.ready();
  const c1 = (await app.inject({ method: 'POST', url: '/api/projects/spdb-a/projekt-db', payload: { projekt_pfad: dir } })).json();
  ok('C Route angelegt, Ergebnis ohne Passwort', c1.projekt_db?.status === 'angelegt' && !('passwort' in c1.projekt_db));
  ok('C Route liefert zugang mit Passwort + DATABASE_URL', c1.zugang?.passwort?.length === 28 && c1.zugang.database_url.includes('@192.168.50.65:5433/spdb_a'));
  const c2 = (await app.inject({ method: 'POST', url: '/api/projects/spdb-a/projekt-db', payload: {} })).json();
  ok('C 2. Lauf vorhanden, gleiches Passwort aus Tabelle', c2.projekt_db?.status === 'vorhanden' && c2.zugang?.passwort === c1.zugang.passwort);
  const kurz = await core.projektDbKurzinfo('spdb-a');
  ok('C Kurzinfo (status) ohne Passwort', kurz.vorhanden === true && !JSON.stringify(kurz).includes(c1.zugang.passwort));
  const keine = await core.projektDbKurzinfo('spdb-leer');
  ok('C ohne DB: vorhanden:false + erstellen-Aufruf', keine.vorhanden === false && String(keine.hinweis).includes('erstellen:true'));
  process.env.SYNAPSE_PROJEKTDB_ENV = '/nonexistent';
  const c3 = (await app.inject({ method: 'POST', url: '/api/projects/spdb-b/projekt-db', payload: {} })).json();
  ok('C ohne Konfig: nicht_konfiguriert', c3.projekt_db?.status === 'nicht_konfiguriert' && c3.zugang === null);
  process.env.SYNAPSE_PROJEKTDB_ENV = konfPfad;
  ok('C ungueltiger Name -> 400', (await app.inject({ method: 'POST', url: '/api/projects/..%2Fx/projekt-db', payload: {} })).statusCode === 400);

  // --- D: nie ueberschreiben -------------------------------------------------
  const snapshot = async () => [
    await ex("SELECT string_agg(concat_ws('|', r.rolname, r.rolpassword, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolcanlogin, r.rolvaliduntil), E'\\n' ORDER BY r.rolname) FROM pg_authid r WHERE r.rolname LIKE 'spdb\\_fremd%' OR r.rolname = 'spdb_rolle_user';", 'postgres'),
    await ex("SELECT string_agg(concat_ws('|', d.datname, d.datdba::regrole, d.datacl::text, d.encoding, d.datallowconn), E'\\n' ORDER BY d.datname) FROM pg_database d WHERE d.datname LIKE 'spdb\\_fremd%';", 'postgres'),
    await ex("SELECT md5(string_agg(id||':'||txt, ',' ORDER BY id)) || '|' || (SELECT nspowner::regrole FROM pg_namespace WHERE nspname='public') || '|' || coalesce((SELECT nspacl::text FROM pg_namespace WHERE nspname='public'),'') FROM daten;", 'spdb_fremd'),
  ].join('\n---\n');
  const vorher = await snapshot();
  const eintraegeVorher = (await pool.query('SELECT count(*)::int n FROM projekt_datenbanken')).rows[0].n;
  const d1 = await core.legeProjektDbAn('spdb-fremd', ex, { konfig: K, memory: false });
  ok('D fremde DB (Script-Stil) -> vorhanden_fremd', d1.status === 'vorhanden_fremd' && !d1.passwort && d1.hinweis.includes('nicht von Synapse angelegt'));
  const d2 = await core.legeProjektDbAn('spdb-fremd2', ex, { konfig: K, memory: false });
  ok('D fremde DB + fremde Rolle <db>_user -> vorhanden_fremd', d2.status === 'vorhanden_fremd');
  const d3 = await core.legeProjektDbAn('spdb-rolle', ex, { konfig: K, memory: false });
  ok('D nur fremde Rolle -> fehler', d3.status === 'fehler');
  const d4 = (await app.inject({ method: 'POST', url: '/api/projects/spdb-fremd/projekt-db', payload: {} })).json();
  ok('D Route auf fremde DB -> vorhanden_fremd, zugang null', d4.projekt_db?.status === 'vorhanden_fremd' && d4.zugang === null);
  await app.close();
  ok('D kein Eintrag mit leerem Passwort', (await pool.query('SELECT count(*)::int n FROM projekt_datenbanken')).rows[0].n === eintraegeVorher);
  ok('D fremde Rollen, DBs, Inhalt und Schema-Rechte bitgleich', (await snapshot()) === vorher);
  let erst = true;
  const race = async (sql, db) => {
    const out = await ex(sql, db);
    if (erst && sql.includes('pg_database WHERE datname')) { erst = false; await ex('CREATE DATABASE spdb_race;', 'postgres'); }
    return out;
  };
  const d5 = await core.legeProjektDbAn('spdb-race', race, { konfig: K, memory: false });
  const raceDb = (await ex("SELECT concat_ws('|', datname, datdba::regrole) FROM pg_database WHERE datname='spdb_race';", 'postgres')).trim();
  const raceRolle = (await ex("SELECT count(*) FROM pg_roles WHERE rolname='spdb_race_user';", 'postgres')).trim();
  ok('D Race: fremde DB bleibt, nur eigene Rolle entfernt', d5.status === 'fehler' && raceDb === 'spdb_race|pgadmin' && raceRolle === '0');

  await pool.end();
} catch (err) {
  console.log('FAIL Abbruch: ' + err.message);
  fehler++;
} finally {
  spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
  fs.rmSync(scratch, { recursive: true, force: true });
  const rest = execFileSync('docker', ['ps', '-a', '--filter', `name=^${CONTAINER}$`, '--format', '{{.Names}}']).toString().trim();
  console.log(rest ? 'WARNUNG: Container noch vorhanden' : 'Container entfernt');
}
console.log(fehler === 0 ? 'ALLE TESTS OK' : `${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
