/**
 * P10-T72: project(projekt_db, uebernehmen) — BESTEHENDE Projekt-DB registrieren — und kein Sonderfall
 * fuer das Projekt synapse in der Shell-/Workspace-Umgebung.
 *
 * ABSICHERUNG: nur synapse_test (:5433/synapse_test, sonst Abbruch), eigenes Testprojekt
 * "t72-projektdb-uebernahme" (nur dessen Zeile in projekt_datenbanken wird geschrieben/geloescht).
 * Die System-DB taucht nur als synthetische URL auf, es gibt keine Verbindung dorthin.
 * Voraussetzung: pnpm --filter @synapse/core build && pnpm --filter @synapse/rest-api build
 */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';

const db = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(db.port, '5433', 'nur Test-DB (5433)');
assert.equal(db.pathname, '/synapse_test', 'nur synapse_test');
process.env.SYNAPSE_DATABASE_URL = db.href;
Object.assign(process.env, { QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9', SYNAPSE_INTERN_TOOL: '0' });

const core = await import('../dist/index.js');
const { workspaceJobDatenbank } = await import('../../rest-api/dist/services/workspace-job-db.js');

const PROJEKT = 't72-projektdb-uebernahme';
const LIVE = 'postgresql://synapse:geheim-live@192.168.50.65:5432/synapse';
const KONFIG = { host: '192.168.50.65', port: 5433, container: 'postgresql16_2', adminUser: 'admin_t72' };
const PW = 'Testpasswort_t72-abc';
const eingabe = { database: 't72_db', user: 't72_db_user', passwort: PW };
const passend = async () => ({ datenbank: 't72_db', user: 't72_db_user', synapse_dbs: 0 });
const opt = (o = {}) => ({ agent: 'koordinator', konfig: KONFIG, systemUrl: LIVE, pruefeVerbindung: passend, ...o });

const pool = core.getPool();
assert.equal((await pool.query('SELECT current_database() AS d')).rows[0].d, 'synapse_test');
const aufraeumen = () => pool.query('DELETE FROM projekt_datenbanken WHERE project = $1', [PROJEKT]);
await aufraeumen();
after(async () => { await aufraeumen(); await core.closePool?.(); });

test('nur Koordinator/User darf uebernehmen', async () => {
  const r = await core.uebernehmeProjektDb(PROJEKT, eingabe, opt({ agent: 'claude-t72' }));
  assert.equal(r.status, 'abgelehnt');
  assert.equal(await core.leseProjektDbZugang(PROJEKT), null);
});

test('System-DB, fremde Instanz, gesperrte Rollen und kaputte Eingaben werden abgelehnt', async () => {
  const faelle = [
    [{ ...eingabe, port: 5432 }, 'Port 5432'],
    [{ ...eingabe, database: 'synapse' }, 'DB synapse'],
    [{ ...eingabe, host: '10.0.0.1' }, 'fremder Host'],
    [{ ...eingabe, user: 'synapse' }, 'Rolle synapse'],
    [{ ...eingabe, user: 'admin_t72' }, 'Admin-Rolle'],
    [{ ...eingabe, passwort: 'kurz' }, 'Passwort zu kurz'],
    [{ ...eingabe, passwort: 'mit@sonder/zeichen' }, 'Passwort nicht URL-sicher'],
    [{ ...eingabe, database: 'Drop;Table' }, 'DB-Name ungueltig'],
  ];
  for (const [e, name] of faelle) {
    const r = await core.uebernehmeProjektDb(PROJEKT, e, opt());
    assert.equal(r.status, 'abgelehnt', name);
  }
  // Die System-URL zeigt (synthetisch) genau auf das Ziel -> nicht_system_db greift unabhaengig von der Whitelist.
  const r = await core.uebernehmeProjektDb(PROJEKT, eingabe, opt({ systemUrl: 'postgresql://x:y@192.168.50.65:5433/t72_db' }));
  assert.equal(r.status, 'abgelehnt');
  assert.ok(r.pruefungen.some((p) => p.pruefung === 'nicht_system_db' && !p.ok));
  assert.equal(await core.leseProjektDbZugang(PROJEKT), null);
});

test('Anmeldung muss genau die genannte DB/Rolle treffen, Passwort nie in der Antwort', async () => {
  for (const pv of [
    async () => ({ datenbank: 'andere', user: 't72_db_user', synapse_dbs: 0 }),
    async () => ({ datenbank: 't72_db', user: 'jemand', synapse_dbs: 0 }),
    async () => ({ datenbank: 't72_db', user: 't72_db_user', synapse_dbs: 1 }),
  ]) assert.equal((await core.uebernehmeProjektDb(PROJEKT, eingabe, opt({ pruefeVerbindung: pv }))).status, 'abgelehnt');
  const f = await core.uebernehmeProjektDb(PROJEKT, eingabe, opt({ pruefeVerbindung: async () => { throw new Error('auth failed: ' + PW); } }));
  assert.equal(f.status, 'fehler');
  assert.ok(!JSON.stringify(f).includes(PW), 'Passwort geschwaerzt');
  assert.equal(await core.leseProjektDbZugang(PROJEKT), null);
});

test('Vorschau schreibt nichts; vorschau:false traegt ein; zweiter Aufruf ueberschreibt nie', async () => {
  const v = await core.uebernehmeProjektDb(PROJEKT, eingabe, opt());
  assert.equal(v.status, 'vorschau');
  assert.ok(!JSON.stringify(v).includes(PW));
  assert.equal(await core.leseProjektDbZugang(PROJEKT), null);
  const u = await core.uebernehmeProjektDb(PROJEKT, eingabe, opt({ vorschau: false }));
  assert.equal(u.status, 'uebernommen', JSON.stringify(u));
  assert.ok(!JSON.stringify(u).includes(PW));
  const z = await core.leseProjektDbZugang(PROJEKT);
  assert.deepEqual([z.host, z.port, z.database, z.user], ['192.168.50.65', 5433, 't72_db', 't72_db_user']);
  const w = await core.uebernehmeProjektDb(PROJEKT, { ...eingabe, database: 't72_anders' },
    opt({ vorschau: false, pruefeVerbindung: async () => ({ datenbank: 't72_anders', user: 't72_db_user', synapse_dbs: 0 }) }));
  assert.equal(w.status, 'vorhanden');
  assert.equal((await core.leseProjektDbZugang(PROJEKT)).database, 't72_db');
});

test('baueJobUmgebung mit echter Registry: Basis traegt Live-URL, Ergebnis ist die registrierte Projekt-DB', async () => {
  core.vergissJobUmgebungCache();
  const r = await core.baueJobUmgebung(PROJEKT, {
    basis: { PATH: '/usr/bin', DATABASE_URL: LIVE, SYNAPSE_DATABASE_URL: LIVE, PGPASSWORD: 'geheim-live', PGPORT: '5432' },
    systemUrl: LIVE, existiert: () => false, secretsPfad: '/nonexistent',
  });
  assert.match(r.env.DATABASE_URL, /@192\.168\.50\.65:5433\/t72_db$/);
  assert.equal(r.info.database_url, 'projekt-db t72_db (192.168.50.65:5433)');
  assert.equal(r.env.SYNAPSE_DATABASE_URL, undefined);
  assert.equal(r.env.PGPORT, undefined);
  assert.ok(!Object.values(r.env).some((w) => String(w).includes('geheim-live') || /:5432\//.test(String(w))));
  core.vergissJobUmgebungCache();
});

test('workspace-job-db: registrierte Projekt-DB bleibt auch fuer synapse, System-DB nie', () => {
  const live = { host: '192.168.50.65', port: '5432', datenbank: 'synapse', user: 'synapse' };
  const ziel = { host: '192.168.50.65', port: '5433', datenbank: 'synapse_test', user: 'synapse_test_user' };
  const url = 'postgresql://synapse_test_user:pw12345678@192.168.50.65:5433/synapse_test';
  const freigabe = { project: 'synapse', live, ziele: [{ ...ziel, art: 'projekt' }] };
  assert.equal(workspaceJobDatenbank('synapse', { DATABASE_URL: url }, freigabe, {}).DATABASE_URL, url);
  assert.equal(workspaceJobDatenbank('synapse', { DATABASE_URL: LIVE }, { ...freigabe, ziele: [{ ...live, art: 'projekt' }] }, {}).DATABASE_URL, undefined);
  assert.equal(workspaceJobDatenbank('synapse', { DATABASE_URL: url }, { ...freigabe, ziele: [] }, {}).DATABASE_URL, undefined);
  assert.equal(workspaceJobDatenbank('synapse', { DATABASE_URL: url }, { ...freigabe, project: 'anderes' }, {}).DATABASE_URL, undefined);
  assert.equal(workspaceJobDatenbank('synapse', { DATABASE_URL: url }, { ...freigabe, ziele: [{ ...ziel, art: 'test' }] }, {}).DATABASE_URL, undefined);
});

test('M2: Registry-Ziel mit Alias-Host derselben System-Instanz (gleicher Port ODER gleiche DB) wird verworfen', async () => {
  const faelle = [
    ['postgresql://x:y@db-alias.lan:5432/projekt_x', 'db-alias.lan', 5432, 'projekt_x'],
    ['postgresql://x:y@10.0.0.7:5433/synapse', '10.0.0.7', 5433, 'synapse'],
    ['postgresql://x:y@localhost:5432/synapse', 'localhost', 5432, 'synapse'],
  ];
  for (const [database_url, host, port, database] of faelle) {
    core.vergissJobUmgebungCache();
    const r = await core.baueJobUmgebung('t72-alias', { basis: { PATH: '/usr/bin' }, systemUrl: LIVE, existiert: () => false, secretsPfad: '/nonexistent',
      leseZugang: async () => ({ database_url, host, port, database }) });
    assert.equal(r.env.DATABASE_URL, undefined, database_url);
    assert.equal(r.info.database_url, 'keine');
    assert.match(r.env.SYNAPSE_PROJEKT_DB_HINWEIS ?? '', /verworfen/);
  }
  core.vergissJobUmgebungCache();
});

test('N2: job_env-Hinweis nennt nur eine gepruefte DB', async () => {
  const P2 = 't72-hinweis-n2';
  const { drossleShellJobHinweis } = await import('../dist/services/shell-job-hinweis.js');
  const vorher = process.env.SYNAPSE_DATABASE_URL;
  process.env.SYNAPSE_DATABASE_URL = LIVE;
  try {
    await pool.query('DELETE FROM projekt_datenbanken WHERE project = $1', [P2]);
    await pool.query('DELETE FROM hinweis_gesehen WHERE project = $1', [P2]);
    await pool.query('INSERT INTO projekt_datenbanken (project, host, port, db, db_user, passwort) VALUES ($1,$2,$3,$4,$5,$6)',
      [P2, 'db-alias.lan', 5432, 'projekt_x', 'x_user', 'synthetisch12345']);
    const r = await drossleShellJobHinweis({ action: 'exec', project: P2, agent_id: 't72-n2-a-' + Date.now() }, { success: true });
    assert.equal(r.job_env?.database_url, 'keine', JSON.stringify(r));
    await pool.query('UPDATE projekt_datenbanken SET host=$2, port=$3, db=$4 WHERE project=$1', [P2, '192.168.50.65', 5433, 't72_ok']);
    const g = await drossleShellJobHinweis({ action: 'exec', project: P2, agent_id: 't72-n2-b-' + Date.now() }, { success: true });
    assert.equal(g.job_env?.database_url, 'projekt-db t72_ok (192.168.50.65:5433)', JSON.stringify(g));
  } finally {
    process.env.SYNAPSE_DATABASE_URL = vorher;
    await pool.query('DELETE FROM projekt_datenbanken WHERE project = $1', [P2]);
    await pool.query('DELETE FROM hinweis_gesehen WHERE project = $1', [P2]);
  }
});

test('echte Anmeldung gegen synapse_test mit dem Standard-Pruefer (nur Vorschau)', async (t) => {
  const user = decodeURIComponent(db.username);
  const pw = decodeURIComponent(db.password);
  if (db.hostname !== '192.168.50.65' || !/^[A-Za-z0-9._~-]{8,200}$/.test(pw)) { t.skip('Test-Zugang nicht URL-sicher oder anderer Host'); return; }
  await aufraeumen();
  const r = await core.uebernehmeProjektDb(PROJEKT, { database: 'synapse_test', user, passwort: pw }, { agent: 'koordinator', konfig: KONFIG, systemUrl: LIVE });
  assert.equal(r.status, 'vorschau', JSON.stringify(r));
  assert.ok(r.pruefungen.find((p) => p.pruefung === 'anmeldung')?.ok);
  assert.ok(!JSON.stringify(r).includes(pw));
  const f = await core.uebernehmeProjektDb(PROJEKT, { database: 'synapse_test', user, passwort: pw + 'x' }, { agent: 'koordinator', konfig: KONFIG, systemUrl: LIVE });
  assert.equal(f.status, 'fehler', JSON.stringify(f));
  assert.ok(!JSON.stringify(f).includes(pw));
  assert.equal(await core.leseProjektDbZugang(PROJEKT), null);
});
