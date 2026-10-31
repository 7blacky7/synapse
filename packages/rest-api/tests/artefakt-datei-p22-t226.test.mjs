/**
 * P22-T226/P22-T228: datei.ende/datei.inhalt und Live-Aktualisierung.
 * Quellen: core/src/services/artefakt-vorlagen.ts, shell-maske.ts;
 * rest-api/src/services/artefakt-live.ts; code_files NOTIFY-Trigger.
 * Nur synapse_test:5433, privates Schema/Testprojekt, kein Browser/Daemon.
 * Fehlerzeilen nennen Task, Quelle, erwartet/tatsaechlich und Artefakt-ID, nie Geheimwerte.
 */
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const url = process.env.SYNAPSE_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
let db;
try { db = new URL(url); } catch { /* Invalid URL is rejected by the guard below. */ }
if (db?.pathname !== '/synapse_test' || db.port !== '5433') throw Error('P22-T226: nur synapse_test:5433');
process.env.DATABASE_URL = url;
process.env.SYNAPSE_INTERN_TOOL = '0';
const load = (p) => import(pathToFileURL(join(root, p)).href);
const C = await load('packages/core/dist/index.js');
const L = await load('packages/rest-api/dist/services/artefakt-live.js');
const S = await load('packages/core/dist/services/shell-maske.js');
const { mitLesePool } = await load('packages/core/dist/db/client.js');
const basis = C.getPool();
const schema = 'p22_t226_' + randomUUID().replaceAll('-', '');
const project = 'p22-t226-' + randomUUID().slice(0, 8);
const ident = randomUUID();
const pool = {
  async connect() { const c = await basis.connect(); try { await c.query('SET search_path TO ' + schema + ',public'); return c; } catch (e) { c.release(); throw e; } },
  async query(...args) { const c = await this.connect(); try { return await c.query(...args); } finally { c.release(); } },
};
const mit = (f) => mitLesePool(pool, f);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0, abo, artifact = '';
function check(ok, einheit, erwartet, tatsaechlich) {
  const label = 'P22-T226 ' + einheit;
  if (ok) console.log('OK ' + label);
  else { failures++; console.log('FAIL ' + label + ' ' + JSON.stringify({ erwartet, tatsaechlich, artifact, project }).slice(0, 900)); }
}
const schalter = async (funktion, aktiv) => pool.query(
  "INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,$1,$2,'P22-T226 Test','user')",
  [funktion, aktiv]);
const q = (vertrag, pfad, extra = {}) => [{ name: 'd', vertrag, args: { pfad, ...extra } }];
const secret = 'testGeheimnisP22T226NichtAusgeben';
try {
  await basis.query('CREATE SCHEMA ' + schema);
  for (const t of ['agent_profil_schalter', 'agent_artifacts', 'hauptagent_verlauf', 'agent_identitaeten',
    'specialist_inbox', 'agent_runtime_sessions', 'agent_runtime_instances', 'code_files', 'tool_calls']) {
    await pool.query('CREATE TABLE ' + schema + '.' + t + ' (LIKE public.' + t + ' INCLUDING DEFAULTS INCLUDING INDEXES)');
  }
  await pool.query(C.ARTEFAKT_BEWERTUNG_SCHEMA_SQL);
  await pool.query(C.ARTEFAKT_VORLAGEN_SCHEMA_SQL);
  await pool.query('CREATE TRIGGER trg_notify_code_file_change AFTER INSERT OR UPDATE OR DELETE ON code_files FOR EACH ROW EXECUTE FUNCTION public.notify_code_file_change()');
  for (const name of ['artefakt_vorlagen','artefakt_vorlagen_live','datei_vertrag']) await schalter(name, true);
  await mit(() => C.setzeArtefaktVorlagenEinstellungen({ drossel_ms: 1000, buendel_ms: 0 }, 'P22-T226 Test', 'test'));
  await pool.query("INSERT INTO code_files(id,project,file_path,file_name,file_type,content,content_hash) VALUES('fixture1',$1,$2,'ausgabe.jsonl','jsonl',$3,'fixture')",
    [project, 'daten/ausgabe.jsonl', '{"n":1}\n{"n":2}\n']);
  await pool.query("INSERT INTO code_files(id,project,file_path,file_name,file_type,content,content_hash) VALUES('fixture2',$1,$2,'.env.example','env',$3,'fixture')",
    [project, 'daten/.env.example', 'PASSWORD=' + secret + '\n']);
  const w = (await mit(() => C.leseArtefaktVorlagenEinstellungen())).werte;
  const lese = (vertrag, pfad, extra) => mit(() => C.ladeQuellen(q(vertrag, pfad, extra), project, w));
  // User verlangt letzte Zeilen, kleine Dateien, Maskierung und Pfadbindung.
  let r = await lese('datei.ende', 'daten/ausgabe.jsonl', {limit: 1});
  check(r.daten.d?.zeilen?.join('') === '{"n":2}' && !!r.daten.d?.stand && /^[a-f0-9]{64}$/.test(r.daten.d?.hash ?? ''),
    'artefakt-vorlagen.ts datei.ende: letzte Zeile/Stand/Hash', 'zweite Zeile + Stand + SHA256', {daten:r.daten,stand:r.stand});
  r = await lese('datei.inhalt', 'daten/ausgabe.jsonl');
  check(r.daten.d?.inhalt === '{"n":1}\n{"n":2}\n', 'artefakt-vorlagen.ts datei.inhalt: kleine Datei', 'beide Zeilen', r.daten);
  r = await lese('datei.inhalt', 'daten/.env.example');
  check(!JSON.stringify(r).includes(secret) && JSON.stringify(r).includes('[WERT]'),
    'artefakt-vorlagen.ts datei.inhalt: Geheimdatei maskiert', 'Platzhalter ohne Geheimwert', {maskiert:!JSON.stringify(r).includes(secret), stand:r.stand});
  r = await lese('datei.inhalt', '../ausserhalb');
  check(r.daten.d === null && /relativer Projektpfad/.test(r.stand[0].fehler ?? ''),
    'artefakt-vorlagen.ts datei.inhalt: Traversal abgewiesen', 'null + Pfadfehler', r.stand);
  await pool.query("UPDATE agent_profil_schalter SET aktiv=false WHERE funktion='datei_vertrag'");
  r = await lese('datei.ende', 'daten/ausgabe.jsonl');
  check(r.daten.d === null && /funktion_aus/.test(r.stand[0].fehler ?? ''),
    'artefakt-vorlagen.ts datei.ende: Schalter AUS', 'null + funktion_aus', r.stand);
  await pool.query("UPDATE agent_profil_schalter SET aktiv=true WHERE funktion='datei_vertrag'");
  // Echter PG-Trigger und LISTEN: Dateiaenderung muss im offenen Artefakt sichtbar werden.
  const art = await mit(() => C.speichereVorlagenArtefakt({ ownerIdentityId: ident, createdBy: 'p22-t226-test',
    titel: 'Datei-Test', vorlage: '<div>{{#each d.zeilen as z}}<p>{{z}}</p>{{/each}}</div>',
    quellen: q('datei.ende', 'daten/ausgabe.jsonl'), modus: 'live', project }));
  artifact = art.id;
  const first = await mit(() => C.renderArtefakt(artifact, { project, betrachter: {art:'user'}, anlass:'neu_zeichnen' }));
  check(first.html.includes('&quot;n&quot;:1') || first.html.includes('"n":1'),
    'artefakt-vorlagen.ts renderArtefakt: Anfangszeile', 'JSONL erste Zeile im HTML', first.html);
  const events = [];
  abo = await mit(() => L.abonniereArtefaktLive(artifact, project, {art:'user'}, (event, data) => events.push({event,data})));
  await pool.query("UPDATE code_files SET content=$3,content_hash='fixture-neu',updated_at=NOW() WHERE project=$1 AND file_path=$2", [project,'daten/ausgabe.jsonl','{"n":1}\n{"n":2}\n{"n":3}\n']);
  let live;
  for (let i=0; i<160 && !live; i++) { live = events.find(e => e.event === 'artefakt' && e.data.revision > first.revision && /n.*3/.test(e.data.html)); if (!live) await pause(50); }
  check(!!live, 'artefakt-live.ts synapse_code_file_change: neue Zeile live', 'Ereignis mit Zeile 3', {events:events.map(e=>({event:e.event, revision:e.data.revision, html:e.data.html})), status:L.artefaktLiveStatus()});
  // Bestehende Shell-Rueckfrage: Ausgabe ohne Bestaetigung nie lesen, identitaetsgebunden mit Grund.
  const principal = { art:'identity', project, agent_id:'p22-test-agent', identity_id:ident, rolle:'subagent', modell:null, context_epoch:1, lauf_id:null };
  const bezug = { modus:'beide', standard:'beide', quelle:'standard', bis:null, letzter_fehler:null };
  const aufruf = (args) => mit(() => C.mitAgentAufrufKontext({principal,bezug}, () => S.mitShellAusgabe(args, async () => ({success:true, output:secret}))));
  const frage = await aufruf({action:'get', project, id:'test', maskierung:false});
  check(frage.stufe === 'rueckfrage' && !!frage.bestaetigung_id && !JSON.stringify(frage).includes(secret),
    'shell-maske.ts mitShellAusgabe: unmaskiert nur nach Rueckfrage', 'rueckfrage ohne Ausgabe', {stufe:frage.stufe,id:frage.bestaetigung_id});
  const offen = await aufruf({action:'get', project, id:'test', maskierung:false, bestaetigung:{id:frage.bestaetigung_id,grund:'P22-T226 Testfreigabe'}});
  check(offen.output === secret && !!offen.maskierung_audit, 'shell-maske.ts mitShellAusgabe: gleicher Ausweis + Grund', 'freigegebene Einzelansicht mit Audit', {freigegeben:offen.output===secret,audit:!!offen.maskierung_audit});
} catch (e) {
  failures++; console.error('FAIL P22-T226 Testlauf: ' + (e?.stack ?? e));
} finally {
  abo?.abmelden();
  await basis.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
  await basis.end();
}
if (failures) process.exitCode = 1;
