#!/usr/bin/env node
// test-intern-diagnose-daemon.mjs — P15-T23: Daemon-Teile von sync_inspektor und parser_pool ueber die Bruecke.
// Aufbau wie test-intern-daemon-bruecke.mjs (P15-T12 E2): echte Route intern-daemon.ts, echtes intern-bruecke.ts
// des Daemons mit Test-config.json unter einem Test-HOME, ein Testprojekt mit Pfad in einem tmp-Ordner.
//   G1 ohne Daemon: sync_inspektor prozess daemon -> PG-Teil bleibt, platte.fehler daemon_nicht_verbunden;
//      parser_pool prozess daemon -> daemon_nicht_verbunden; prozess "quatsch" -> parameter_ungueltig
//   G2 Platte = PG -> gleich_pg true                                  (Kontrolle)
//   G3 POSITIVKONTROLLE: Platte bewusst anders als PG (Hash unbekannt) -> gleich_pg false + Befund UNBEKANNT
//   G4 Platte zeigt einen aelteren, in file_versions bekannten Stand -> Befund AELTEREN bekannten Stand
//   G5 in PG, auf der Platte geloescht -> Befund "fehlt aber auf der Platte"
//   G6 nur auf der Platte -> Befund "NICHT in code_files"
//   G7 kein gueltiges UTF-8 -> utf8_gueltig false, sha256_roh gesetzt
//   G8 Ausbruch: "../x", absoluter Pfad, Symlink aus dem Projekt -> parameter_ungueltig (nichts gelesen)
//   G9 Projekt nicht in der Daemon-Config -> projekt_unbekannt
//   G10 sync_fs_pg im Daemon pausiert (worker_pausieren ueber die Bruecke) -> Befund PAUSIERT, sync_pausen
//   G11 parser_pool prozess daemon -> prozess daemon:<host>, ohne daemon_teil; API-Variante mit daemon_teil;
//       daemon:<host> gezielt, unbekannter Host -> daemon_nicht_verbunden
// Aufruf: set -a; . <test-db.env>; set +a; node scripts/test-intern-diagnose-daemon.mjs
//   (braucht gebaute dists von core, rest-api, file-watcher-daemon-ts)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

if (!/:5433\/synapse_test(\?|$)/.test(process.env.DATABASE_URL ?? '')) {
  console.error('ABBRUCH: DATABASE_URL zeigt nicht auf die Test-DB (:5433/synapse_test).');
  process.exit(2);
}

process.env.SYNAPSE_INTERN_TOOL = '1';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'p15-diag-daemon-'));
process.env.HOME = home;
fs.mkdirSync(path.join(home, '.synapse', 'file-watcher'), { recursive: true });
const projektDir = path.join(home, 'projekt');
fs.mkdirSync(path.join(projektDir, 'src'), { recursive: true });
const draussen = path.join(home, 'geheim.txt');
fs.writeFileSync(draussen, 'nicht lesen\n');

const requireFromRest = createRequire(new URL('../packages/rest-api/package.json', import.meta.url));
const Fastify = requireFromRest('fastify');
const core = await import('../packages/core/dist/index.js');
const { internDaemonRoutes } = await import('../packages/rest-api/dist/routes/intern-daemon.js');
const kern = await import('../packages/core/dist/services/daemon-bruecke.js');

const PRJ = 'diag-daemon-p23';
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const pool = core.getPool();
let ok = 0;
const pruefe = (bed, text, detail) => {
  assert.ok(bed, `${text}${detail !== undefined ? '\n' + JSON.stringify(detail).slice(0, 2500) : ''}`);
  ok++;
  console.log('OK  ' + text);
};
async function aufraeumen() {
  for (const t of ['file_versions', 'code_files']) await pool.query(`DELETE FROM ${t} WHERE project = $1`, [PRJ]).catch(() => {});
}
async function pgDatei(rel, inhalt) {
  await pool.query(
    `INSERT INTO code_files (id, project, file_path, file_name, file_type, content, content_hash, file_size, updated_at, indexed_at)
     VALUES ($1, $2, $3, $4, 'ts', $5, $6, $7, NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '5 minutes')
     ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, content_hash = EXCLUDED.content_hash`,
    [`${PRJ}:${rel}`, PRJ, rel, path.basename(rel), inhalt, sha(inhalt), Buffer.byteLength(inhalt)],
  );
}

let app = null;
async function starteApi() {
  app = Fastify({ logger: false });
  await app.register(internDaemonRoutes);
  await app.listen({ host: '127.0.0.1', port: 0 });
  return app.server.address().port;
}
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
async function bis(bedingung, ms, text) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    if (await bedingung()) return;
    await warte(100);
  }
  throw new Error('Zeitueberschreitung: ' + text);
}
const intern = (args) => core.fuehreInternAus(args, 'tester');
const sync = (file_path, extra = {}) => intern({ action: 'sync_inspektor', project: PRJ, file_path, prozess: 'daemon', ...extra });
const hat = (r, teil) => (r.befund ?? []).some((b) => b.includes(teil));

let bruecke = null;
try {
  await aufraeumen();
  const port = await starteApi();
  fs.writeFileSync(path.join(home, '.synapse', 'file-watcher', 'config.json'), JSON.stringify({
    port: 7999, synapse_api_url: `http://127.0.0.1:${port}`, synapse_api_token: 'test-token',
    projekte: [{ name: PRJ, pfad: projektDir, enabled: true }],
  }));
  const INHALT = 'export const a = 1;\n';
  await pgDatei('src/a.ts', INHALT);
  fs.writeFileSync(path.join(projektDir, 'src', 'a.ts'), INHALT);

  // G1 ohne Daemon
  let r = await sync('src/a.ts');
  pruefe(r.success === true && r.pg?.content_hash === sha(INHALT), 'G1 ohne Daemon: PG-Teil bleibt gueltig', r);
  pruefe(r.platte?.fehler === 'daemon_nicht_verbunden' && hat(r, 'Plattenstand nicht verfuegbar'), 'G1 platte.fehler daemon_nicht_verbunden mit Befund', r);
  r = await intern({ action: 'parser_pool', prozess: 'daemon' });
  pruefe(r.success === false && r.error === 'daemon_nicht_verbunden', 'G1 parser_pool prozess daemon ohne Daemon -> daemon_nicht_verbunden', r);
  r = await intern({ action: 'sync_inspektor', project: PRJ, file_path: 'src/a.ts', prozess: 'quatsch' });
  pruefe(r.success === false && r.error === 'parameter_ungueltig', 'G1 prozess quatsch -> parameter_ungueltig', r);
  r = await intern({ action: 'sync_inspektor', project: PRJ, file_path: 'src/a.ts' });
  pruefe(r.success === true && r.platte === null && typeof r.daemon_teil === 'string', 'G1 ohne prozess: wie bisher nur PG, Hinweis auf prozess daemon', r);

  // Daemon anmelden (Worker wie im Daemon registrieren)
  core.registriereWorker({ name: 'sync_pg_fs', beschreibung: 'S', inAlle: false });
  core.registriereWorker({ name: 'sync_fs_pg', beschreibung: 'S', inAlle: false });
  const { startInternBruecke } = await import('../packages/file-watcher-daemon-ts/dist/intern-bruecke.js');
  bruecke = startInternBruecke();
  await bis(() => core.daemonUebersicht().some((d) => d.verbunden && d.wartet_gerade), 10_000, 'Daemon meldet sich an');
  const host = core.daemonUebersicht()[0].host;

  // G2 gleich
  let t0 = Date.now();
  r = await sync('src/a.ts');
  const latenz = Date.now() - t0;
  pruefe(r.success === true && r.prozess === `daemon:${host}` && r.host === host, `G2 Antwort ueber die Bruecke (${latenz} ms)`, r);
  pruefe(r.gleich_pg === true && r.platte?.existiert === true && r.platte?.sha256 === sha(INHALT) && hat(r, 'Platte = PG'), 'G2 Platte = PG -> gleich_pg true', r);
  pruefe(r.platte?.groesse === Buffer.byteLength(INHALT) && typeof r.platte?.mtime === 'string', 'G2 groesse und mtime der Platte', r.platte);
  pruefe(Array.isArray(r.versionen) && 'reservierungen' in r && !('daemon_teil' in r), 'G2 PG-Teil (versionen, reservierungen) bleibt, Hinweis daemon_teil entfaellt', Object.keys(r));

  // G3 POSITIVKONTROLLE: Platte bewusst anders als PG
  const LOKAL = 'export const a = 2; // lokal geaendert\n';
  fs.writeFileSync(path.join(projektDir, 'src', 'a.ts'), LOKAL);
  r = await sync('src/a.ts');
  pruefe(r.gleich_pg === false && r.platte?.sha256 === sha(LOKAL) && r.pg?.content_hash === sha(INHALT), 'G3 Positivkontrolle: Platte != PG -> gleich_pg false, beide Hashes', r);
  pruefe(hat(r, 'UNBEKANNT') && r.platte?.bekannte_version === null, 'G3 Befund: Hash PG unbekannt (lokale Aenderung)', r.befund);

  // G4 aelterer bekannter Stand
  await pool.query(
    `INSERT INTO file_versions (project, file_path, content, content_hash, agent_id, created_at) VALUES ($1, 'src/a.ts', $2, $3, 'diag', NOW() - INTERVAL '20 minutes')`,
    [PRJ, LOKAL, sha(LOKAL)],
  );
  r = await sync('src/a.ts');
  pruefe(r.gleich_pg === false && hat(r, 'AELTEREN bekannten Stand') && r.platte?.bekannte_version?.agent_id === 'diag', 'G4 aelterer bekannter Stand aus file_versions', r);

  // G5 in PG, auf der Platte weg
  fs.rmSync(path.join(projektDir, 'src', 'a.ts'));
  r = await sync('src/a.ts');
  pruefe(r.platte?.existiert === false && hat(r, 'fehlt aber auf der Platte'), 'G5 in PG, fehlt auf der Platte', r);

  // G6 nur auf der Platte
  fs.writeFileSync(path.join(projektDir, 'src', 'neu.ts'), 'export {};\n');
  r = await sync('src/neu.ts');
  pruefe(r.platte?.existiert === true && r.gleich_pg === null && hat(r, 'NICHT in code_files'), 'G6 nur auf der Platte', r);

  // G7 kein gueltiges UTF-8
  fs.writeFileSync(path.join(projektDir, 'src', 'kaputt.ts'), Buffer.from([0x61, 0xff, 0xfe, 0x62]));
  r = await sync('src/kaputt.ts');
  pruefe(r.platte?.utf8_gueltig === false && typeof r.platte?.sha256_roh === 'string' && hat(r, 'kein gueltiges UTF-8'), 'G7 ungueltiges UTF-8 erkannt', r.platte);

  // G8 Ausbruch
  for (const fp of ['../geheim.txt', 'src/../../geheim.txt', draussen]) {
    r = await sync(fp);
    pruefe(r.success === true && r.platte?.fehler === 'parameter_ungueltig' && r.platte?.sha256 === undefined, `G8 Ausbruch abgewiesen: ${fp.startsWith('/') ? '<absolut>' : fp}`, r.platte);
  }
  fs.symlinkSync(draussen, path.join(projektDir, 'src', 'link.txt'));
  r = await sync('src/link.txt');
  pruefe(r.platte?.fehler === 'parameter_ungueltig' && /Symlink/.test(r.platte?.message ?? ''), 'G8 Symlink aus dem Projekt heraus abgewiesen', r.platte);

  // G9 Projekt nicht in der Daemon-Config
  r = await intern({ action: 'sync_inspektor', project: 'gibt-es-nicht-p23', file_path: 'x.ts', prozess: 'daemon' });
  pruefe(r.success === true && r.platte?.fehler === 'projekt_unbekannt', 'G9 Projekt nicht in config.json -> projekt_unbekannt', r.platte);

  // G10 sync_fs_pg im Daemon pausiert
  r = await intern({ action: 'worker_pausieren', prozess: 'daemon', worker: 'sync_fs_pg', dauer_min: 1, grund: 'P15-T23 Test' });
  pruefe(r.success === true, 'G10 sync_fs_pg ueber die Bruecke pausiert', r);
  r = await sync('src/neu.ts');
  pruefe(r.platte?.sync_pausen?.sync_fs_pg === true && r.platte?.sync_pausen?.sync_pg_fs === false && hat(r, 'sync_fs_pg ist in diesem Daemon PAUSIERT'), 'G10 Befund PAUSIERT', r);
  await intern({ action: 'worker_fortsetzen', prozess: 'daemon', worker: 'sync_fs_pg' });
  r = await sync('src/neu.ts');
  pruefe(r.platte?.sync_pausen?.sync_fs_pg === false && !hat(r, 'PAUSIERT'), 'G10 nach fortsetzen kein Pausen-Befund', r.befund);

  // G11 parser_pool
  r = await intern({ action: 'parser_pool', prozess: 'daemon' });
  pruefe(r.success === true && r.prozess === `daemon:${host}` && r.host === host && !('daemon_teil' in r) && 'threads_prozess' in r, 'G11 parser_pool prozess daemon: Antwort des Daemon-Prozesses', r);
  r = await intern({ action: 'parser_pool' });
  pruefe(r.success === true && r.prozess === 'api' && typeof r.daemon_teil === 'string', 'G11 parser_pool ohne prozess: API wie bisher', r);
  r = await intern({ action: 'parser_pool', prozess: `daemon:${host}` });
  pruefe(r.success === true && r.prozess === `daemon:${host}`, 'G11 parser_pool prozess daemon:<host>', { prozess: r.prozess, pool: r.pool === null ? null : 'gesetzt' });
  r = await intern({ action: 'parser_pool', prozess: 'daemon:unbekannt' });
  pruefe(r.success === false && r.error === 'daemon_nicht_verbunden', 'G11 unbekannter Host -> daemon_nicht_verbunden', r);

  console.log(`ALLE PRUEFUNGEN GRUEN (${ok})`);
} catch (err) {
  console.error('FEHLER ' + (err?.message ?? err));
  process.exitCode = 1;
} finally {
  bruecke?.stop();
  core.setzeWorkerFort?.('alle');
  kern.vergissDaemons();
  setTimeout(() => process.exit(process.exitCode ?? 0), 3_000);
  await aufraeumen();
  await app?.close().catch(() => {});
  await core.closePool?.();
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
