/**
 * P22-T264 (Testphase t232, Koordinator 34607): Ende-zu-Ende der Web-Editor-Routen gegen den UI-Vertrag von claude-linde
 * (packages/web-ui/src/components/ProjektEditor.tsx: Typen UserOp/UserPlanDatei/UserPlan, Aufrufe speichern/userPlanLaden/
 * userPlanDatei/pruefenLassen; Vertrag Channel 34579).
 * Prueft packages/rest-api/src/routes/agent-runtimes.ts:
 *   A POST /api/main-agent/editor/user-plan (Parameterpruefung, Antwort plan{plan_id,status,dateien[{file_path,basis_hash,aktuell_hash,
 *     konflikt,ops[{index,action,agent_id,ok}]}]}), zweite Datei -> dieselbe plan_id (U2).
 *   B GET /api/main-agent/editor/user-plan -> plan (bzw. null).
 *   C GET /api/main-agent/editor/user-plan/datei -> datei{basis,entwurf,aktuell,konflikt}; 400 ohne path, 404 fremde Datei.
 *   D POST /api/main-agent/editor/pruefauftrag {project,plan_id,text?} -> koordinatoren_benachrichtigt; 400 bei ungueltiger plan_id.
 *   E alte Route /api/main-agent/editor/pruefplaene ist weg (404).
 *   F Ruecknahme -> plan null; Schalter editor_modul AUS -> 403 funktion_aus.
 * NUR synapse_test:5433; Schaltertabelle in privatem Schema (public bleibt unberuehrt), Projektdaten in eigenem Testprojekt.
 * Braucht gebaute core- und rest-api-dists. Aufruf:
 *   SYNAPSE_DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/editor-user-plan-routen-p22-t264.test.mjs
 */
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const db = process.env.SYNAPSE_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
let testDb;
try { testDb = new URL(db); } catch { /* unten geschlossen abbrechen */ }
if (testDb?.pathname !== '/synapse_test' || testDb.port !== '5433') {
  console.error('Abbruch P22-T264: SYNAPSE_DATABASE_URL/DATABASE_URL muss auf synapse_test:5433 zeigen'); process.exit(2);
}
process.env.SYNAPSE_AUTH_DISABLED = '1';
process.env.DOCKER_SOCKET = '/nicht/vorhanden/docker.sock';
process.env.SYNAPSE_KI_BROWSER_URL = 'http://127.0.0.1:9';

const load = (p) => import(pathToFileURL(join(repo, p)).href);
const { Pool } = createRequire(join(repo, 'packages/core/package.json'))('pg');
const admin = new Pool({ connectionString: db });
const schema = 'p22_t264_' + randomUUID().replaceAll('-', '');
await admin.query('CREATE SCHEMA ' + schema);
await admin.query('CREATE TABLE ' + schema + '.agent_profil_schalter (LIKE public.agent_profil_schalter INCLUDING DEFAULTS INCLUDING INDEXES)');
const url = new URL(db);
url.searchParams.set('options', '-c search_path=' + schema + ',public');
process.env.DATABASE_URL = url.href;
delete process.env.SYNAPSE_DATABASE_URL;
const R = await load('packages/rest-api/dist/routes/agent-runtimes.js');
const C = await load('packages/core/dist/index.js');
const { default: Fastify } = await import('fastify');
const pool = C.getPool();

let fails = 0;
const check = (ok, name, info) => {
  if (ok) console.log('OK   P22-T264 agent-runtimes.ts ' + name);
  else { fails++; console.log('FAIL P22-T264 agent-runtimes.ts ' + name + (info !== undefined ? ' tatsaechlich=' + JSON.stringify(info).slice(0, 700) : '')); }
};
const P = 'test-p22-t264-r-' + randomUUID().slice(0, 8);
const KOORD = randomUUID();
const hash = (x) => createHash('sha256').update(x).digest('hex');
const app = Fastify();
await app.register(R.agentRuntimeRoutes);
await app.ready();
const get = (u) => app.inject({ method: 'GET', url: u });
const post = (u, payload) => app.inject({ method: 'POST', url: u, payload });
const q = encodeURIComponent;
const schalter = async (aktiv) => {
  await pool.query("DELETE FROM agent_profil_schalter WHERE ebene='global' AND funktion='editor_modul'");
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,'editor_modul',$1,'P22-T264 Testfixture','user')", [aktiv]);
};
const insert = (path, text) => pool.query('INSERT INTO code_files(id,project,file_path,file_name,file_type,file_size,content,content_hash) VALUES($1,$2,$3,$3,$4,$5,$6,$7)',
  [randomUUID(), P, path, 'txt', Buffer.byteLength(text), text, hash(text)]);
// Vertrag ProjektEditor.tsx: UserOp={index,action,agent_id,ok,error?}; UserPlanDatei={file_path,basis_hash?,aktuell_hash?,konflikt,ops}; UserPlan={plan_id,status,dateien}.
const vertragPlan = (p) => p && typeof p.plan_id === 'string' && typeof p.status === 'string' && Array.isArray(p.dateien)
  && p.dateien.every((d) => typeof d.file_path === 'string' && typeof d.konflikt === 'boolean' && Array.isArray(d.ops)
    && d.ops.every((o) => Number.isInteger(o.index) && typeof o.action === 'string' && typeof o.ok === 'boolean' && 'agent_id' in o));

try {
  await schalter(true);
  await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)', [P, 'test-p22-t264', '/tmp/p22-t264-' + randomUUID()]);
  await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von) VALUES($1,$2,'koordinator','koordinator','koordinator','aktiv','t264')", [KOORD, P]);
  await insert('src/a.txt', 'eins\nzwei\n'); await insert('src/b.txt', 'b\n');
  const abbild = (await post('/api/main-agent/editor/abbild', { project: P })).json().abbild;
  check(!!abbild?.id, 'POST /editor/abbild liefert Abbild', abbild);

  // A - Speichern
  let r = await post('/api/main-agent/editor/user-plan', { project: P, abbild_id: abbild.id, file_path: 'src/a.txt' });
  check(r.statusCode === 400 && r.json().error === 'parameter_ungueltig', 'A POST user-plan ohne entwurf -> 400 parameter_ungueltig', r.json());
  r = await post('/api/main-agent/editor/user-plan', { project: P, abbild_id: abbild.id, file_path: 'src/a.txt', entwurf: 'eins\nZWEI\n' });
  const a = r.json();
  check(r.statusCode === 200 && a.success === true && vertragPlan(a.plan), 'A POST user-plan: Antwort im UI-Vertrag', a);
  const d0 = a.plan?.dateien?.[0];
  check(d0?.file_path === 'src/a.txt' && d0.basis_hash === hash('eins\nzwei\n') && d0.aktuell_hash === hash('eins\nzwei\n') && d0.konflikt === false
    && d0.ops.length === 1 && d0.ops[0].agent_id === 'user' && d0.ops[0].ok === true && d0.ops[0].action === 'search_replace', 'A Datei-Eintrag (Hashes, Op des Users)', d0);
  r = await post('/api/main-agent/editor/user-plan', { project: P, abbild_id: abbild.id, file_path: 'src/b.txt', entwurf: 'B\n' });
  check(r.json().plan?.plan_id === a.plan?.plan_id && r.json().plan?.dateien?.length === 2, 'A U2: zweite Datei -> dieselbe plan_id, 2 Dateien', r.json());

  // B - Lesen
  r = await get('/api/main-agent/editor/user-plan?project=' + q(P));
  check(r.statusCode === 200 && r.json().plan?.plan_id === a.plan?.plan_id && vertragPlan(r.json().plan), 'B GET user-plan', r.json());

  // C - Drei-Wege
  r = await get('/api/main-agent/editor/user-plan/datei?project=' + q(P) + '&path=' + q('src/a.txt'));
  const dd = r.json().datei;
  check(r.statusCode === 200 && dd?.basis === 'eins\nzwei\n' && dd.entwurf === 'eins\nZWEI\n' && dd.aktuell === 'eins\nzwei\n' && dd.konflikt === false,
    'C GET user-plan/datei: basis/entwurf/aktuell/konflikt (DreiWegeSpalte)', r.json());
  r = await get('/api/main-agent/editor/user-plan/datei?project=' + q(P));
  check(r.statusCode === 400 && r.json().error === 'pfad_fehlt', 'C GET user-plan/datei ohne path -> 400', r.json());
  r = await get('/api/main-agent/editor/user-plan/datei?project=' + q(P) + '&path=' + q('src/fehlt.txt'));
  check(r.statusCode === 404 && r.json().error === 'datei_nicht_im_user_plan', 'C GET user-plan/datei fremde Datei -> 404', r.json());

  // D - Pruefauftrag (U3)
  const vor = Number((await pool.query('SELECT count(*)::int n FROM specialist_inbox WHERE project=$1', [P])).rows[0].n);
  r = await post('/api/main-agent/editor/pruefauftrag', { project: P, plan_id: a.plan.plan_id, text: 'Bitte pruefen' });
  check(r.statusCode === 200 && r.json().koordinatoren_benachrichtigt === 1, 'D POST pruefauftrag -> 1 Koordinator', r.json());
  const nach = Number((await pool.query('SELECT count(*)::int n FROM specialist_inbox WHERE project=$1', [P])).rows[0].n);
  check(nach === vor + 1, 'D Inbox-Zeile fuer den Koordinator', { vor, nach });
  r = await post('/api/main-agent/editor/pruefauftrag', { project: P, plan_id: 'abc' });
  check(r.statusCode === 400 && r.json().error === 'parameter_ungueltig', 'D POST pruefauftrag ungueltige plan_id -> 400', r.json());
  r = await post('/api/main-agent/editor/pruefauftrag', { project: P, plan_id: a.plan.plan_id });
  check(r.statusCode === 200, 'D POST pruefauftrag ohne text (UI sendet undefined) -> 200', r.json());

  // E - alte Pruefplan-Route entfernt (User 2a26e5e1)
  r = await get('/api/main-agent/editor/pruefplaene?project=' + q(P));
  check(r.statusCode === 404, 'E GET /editor/pruefplaene existiert nicht mehr', { status: r.statusCode });

  // F - Ruecknahme und Schalter
  await post('/api/main-agent/editor/user-plan', { project: P, abbild_id: abbild.id, file_path: 'src/b.txt', entwurf: 'b\n' });
  r = await post('/api/main-agent/editor/user-plan', { project: P, abbild_id: abbild.id, file_path: 'src/a.txt', entwurf: 'eins\nzwei\n' });
  check(r.statusCode === 200 && r.json().plan === null, 'F Ruecknahme aller Aenderungen -> plan null (UI: "Keine Aenderung mehr")', r.json());
  check((await get('/api/main-agent/editor/user-plan?project=' + q(P))).json().plan === null, 'F GET user-plan danach null');
  await schalter(false);
  r = await get('/api/main-agent/editor/user-plan?project=' + q(P));
  check(r.statusCode === 403 && r.json().error === 'funktion_aus', 'F Schalter editor_modul AUS -> 403', r.json());
} catch (e) {
  fails++; console.log('FAIL P22-T264 Ausnahme: ' + (e?.stack ?? e));
} finally {
  for (const sql of ['DELETE FROM specialist_inbox WHERE project=$1', 'DELETE FROM file_batch_plans WHERE project=$1', 'DELETE FROM editor_abbilder WHERE project=$1',
    'DELETE FROM agent_identitaeten WHERE project=$1', 'DELETE FROM code_files WHERE project=$1', 'DELETE FROM projects WHERE name=$1'])
    await pool.query(sql, [P]).catch((e) => console.log('P22-T264 Aufraeumen fehlgeschlagen: ' + sql + ' ' + e.message));
  await app.close().catch(() => {});
  await admin.query('DROP SCHEMA ' + schema + ' CASCADE').catch(() => {});
  await admin.end(); await C.closePool?.().catch?.(() => {});
}
console.log(fails ? 'P22-T264 Routen: ' + fails + ' FEHLER' : 'P22-T264 Routen: alle Pruefungen gruen');
process.exit(fails ? 1 : 0);
