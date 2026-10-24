/**
 * P22-T118: Probe-Fehlerklasse und Wrapper-Ende belegbar - reine Teile ohne DB/Docker. Nichts wird gestartet/gestoppt.
 *   pnpm --filter @synapse/core build && pnpm --filter ./packages/rest-api build && node packages/core/tests/runtime-diagnose-p22-t118.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const load = (...p) => import(pathToFileURL(join(repo, ...p)).href);
const W = await load('packages/core/dist/services/wrapper-ende.js');
const SCH = await load('packages/core/dist/db/wrapper-ende-schema.js');
const P = await load('packages/rest-api/dist/services/agent-runtime/probe.js');
const B = await load('packages/rest-api/dist/services/agent-runtime/runtime-beobachtung.js');

// (1) Probe-Fehlerklasse: vorher alles 'haengt', jetzt einzeln
const k = (e) => B.klassifiziereProbeFehler(e, 1234);
assert.equal(k(new P.RuntimeProbeError('probe_timeout', 'x', 'container_watchdog')).klasse, 'timeout_container');
assert.equal(k(new P.RuntimeProbeError('probe_timeout', 'x', 'container_watchdog')).exit_code, 124);
assert.equal(k(new P.RuntimeProbeError('probe_timeout', 'x', 'transport')).klasse, 'timeout_transport');
assert.equal(k(new P.RuntimeProbeError('probe_timeout', 'x')).klasse, 'timeout_transport', 'ohne art: Transport (kein Exit-Beleg)');
assert.equal(k(new P.RuntimeProbeError('pid_limit', 'x')).klasse, 'pid_limit');
assert.equal(k(new Error('Runtime-Prüfung: Docker-Stream vorzeitig geschlossen')).klasse, 'stream_abbruch');
assert.equal(k(new Error('(HTTP code 409) container is not running')).klasse, 'exec_fehler');
const d = k(new Error('connect ECONNREFUSED /var/run/docker.sock'));
assert.equal(d.dauer_ms, 1234); assert.match(d.meldung, /ECONNREFUSED/);
assert.equal(new P.RuntimeProbeError('probe_timeout', 'm').code, 'probe_timeout', 'Code-Vertrag unveraendert');

// (2)+(3) Wrapper-Ende: Erkennung != Todeszeit; Ursache NUR mit Wrapper-Beleg (Identitaet+Projekt+PID im Ereignis-Snapshot)
const ID = 'd6dc4703-bab7-4ada-bc29-8727a83adb1c';
const ziel = { identity_id: ID, agent: 'koordinator-test-t107', project: 'synapse', wrapper_pid: 14701 };
const ich = { identity_id: ID, agent: 'koordinator-test-t107', project: 'synapse', wrapper_pid: 14701 };
const fremd = { identity_id: 'ffffffff-0000-0000-0000-000000000000', agent: 'different', project: 'other', wrapper_pid: 999 };
const restart = (betroffene, extra = {}) => [
  { id: '170', zeit: '2026-10-24T10:23:21.324Z', art: 'zustand_gestoert', ursache: 'daemon_haengt' },
  { id: '171', zeit: '2026-10-24T10:23:46.125Z', art: 'container_restart', ursache: 'daemon_haengt', betroffene_wrapper: betroffene, ...extra },
  { id: '172', zeit: '2026-10-24T10:24:05.266Z', art: 'wiederhergestellt', ursache: null },
  { id: '161', zeit: '2026-10-24T09:39:13.936Z', art: 'container_restart', ursache: 'daemon_haengt', betroffene_wrapper: [ich] },
];
const lauf = (ereignisse, o = {}) => W.bewerteWrapperEnde({ ziel, letztes_lebenszeichen: '2026-10-24T10:23:12.300Z', erkannt_am: '2026-10-24T10:29:00.000Z', ereignisse, ...o });
// POSITIV: Ziel steht im Snapshot
const pos = lauf(restart([fremd, ich]));
assert.equal(pos.ursache, 'container_restart'); assert.equal(pos.ereignis.id, '171'); assert.equal(pos.beleg, 'betroffene_wrapper');
assert.deepEqual(pos.fenster, { von: '2026-10-24T10:23:12.300Z', bis: '2026-10-24T10:29:00.000Z' }, 'Ende im Fenster, kein erfundener Zeitpunkt');
// GEGENPROBE (Reviewerfall 7476d698): nur fremde Identitaet/PID 999 im Snapshot -> keine Ursache, nur Hinweis
const fr = lauf(restart([fremd]));
assert.equal(fr.ursache, 'prozess_weg'); assert.equal(fr.ereignis, null); assert.equal(fr.beleg, null);
assert.deepEqual(fr.zeitgleich.map(z => [z.id, z.grund]), [['171', 'anderer_wrapper']]);
// gleiche Identitaet, andere PID (andere Generation) -> keine Ursache
assert.equal(lauf(restart([{ ...ich, wrapper_pid: 100 }])).ursache, 'prozess_weg', 'andere Wrapper-Generation');
// gleiche PID, andere Identitaet / anderes Projekt -> keine Ursache
assert.equal(lauf(restart([{ ...ich, identity_id: fremd.identity_id }])).ursache, 'prozess_weg', 'fremde Identitaet mit gleicher PID');
assert.equal(lauf(restart([{ ...ich, project: 'other' }])).ursache, 'prozess_weg', 'anderes Projekt');
// fehlender Snapshot (Altereignis) / gekappter Snapshot ohne Ziel -> nur Hinweis
const ohneSnap = lauf(restart(undefined));
assert.equal(ohneSnap.ursache, 'prozess_weg'); assert.equal(ohneSnap.zeitgleich[0].grund, 'kein_snapshot');
assert.equal(lauf(restart([fremd], { betroffene_gekappt: true })).zeitgleich[0].grund, 'snapshot_gekappt');
// wiederbelebung ist nie Ursache (kein Snapshot), nur Hinweis
const wb = lauf([{ id: '180', zeit: '2026-10-24T10:25:00.000Z', art: 'wiederbelebung', ursache: 'x', betroffene_wrapper: [ich] }]);
assert.equal(wb.ursache, 'prozess_weg'); assert.equal(wb.zeitgleich[0].art, 'wiederbelebung');
// Zeitlage: Restart vor dem Lebenszeichen / nach der Erkennung / ausserhalb Fenster -> weder Ursache noch Hinweis
assert.equal(lauf(restart([ich]), { letztes_lebenszeichen: '2026-10-24T10:30:00.000Z', erkannt_am: '2026-10-24T10:40:00.000Z' }).ursache, 'prozess_weg');
assert.equal(lauf(restart([ich]), { letztes_lebenszeichen: '2026-10-24T10:20:00.000Z', erkannt_am: '2026-10-24T10:23:30.000Z' }).ursache, 'prozess_weg');
const fern = lauf(restart([ich]), { letztes_lebenszeichen: '2026-10-24T08:00:00.000Z', fenster_ms: 30 * 60_000 });
assert.equal(fern.ursache, 'prozess_weg'); assert.equal(fern.zeitgleich.length, 0);
assert.equal(lauf(restart([ich]), { fenster_ms: 60_000 }).ursache, 'container_restart', 'Fenster aus Einstellung wird verwendet (34 s < 1 min)');
assert.equal(lauf(restart([ich]), { fenster_ms: 10_000 }).ursache, 'prozess_weg', 'kleines Fenster schliesst aus');
// Legacy-Wrapper (ohne Identitaet): Agent+Projekt+PID
const leg = { identity_id: null, agent: 'spez-a', project: 'synapse', wrapper_pid: 5 };
assert.equal(W.zielBetroffen(leg, [{ identity_id: null, agent: 'spez-a', project: 'synapse', wrapper_pid: 5 }]), true);
assert.equal(W.zielBetroffen(leg, [{ identity_id: ID, agent: 'spez-a', project: 'synapse', wrapper_pid: 5 }]), false);
assert.deepEqual([...W.CONTAINER_ENDE_ARTEN], ['container_restart', 'container_start']);
assert.deepEqual([...W.CONTAINER_HINWEIS_ARTEN], ['wiederbelebung']);

// R3: Fenster und Kappung als PG-Einstellungen mit Code-Standard
const U = await load('packages/core/dist/services/runtime-ueberwachung.js');
assert.equal(U.RUNTIME_UEBERWACHUNG_EINSTELLUNGEN.wrapper_ende_fenster_minuten.standard * 60_000, W.WRAPPER_ENDE_STANDARD.fenster_ms);
assert.equal(U.RUNTIME_UEBERWACHUNG_EINSTELLUNGEN.wrapper_ende_betroffene_max.standard, W.WRAPPER_ENDE_STANDARD.betroffene_max);

// Schema 150: additiv (nur SQL-Anweisungen pruefen, Kommentare ausgenommen), Spiegel = SQL-Datei
const sql = readFileSync(join(repo, 'packages/core/src/db/schema-sql/150_wrapper_ende.sql'), 'utf8');
assert.equal(SCH.WRAPPER_ENDE_SCHEMA_SQL.trim(), sql.trim(), 'TS-Spiegel = 150_wrapper_ende.sql');
const anweisungen = sql.split('\n').map(z => z.replace(/--.*$/, '').trim()).filter(Boolean);
assert.ok(anweisungen.length === 6, 'genau 6 Anweisungen');
for (const a of anweisungen) {
  assert.match(a, /^ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS \w+ /, 'nur ADD COLUMN IF NOT EXISTS: ' + a);
  assert.ok(!/\b(DROP|DELETE|RENAME|TRUNCATE|UPDATE)\b|ALTER COLUMN/i.test(a), 'nichts Destruktives: ' + a);
}
for (const t of ['wrapper_status', 'agent_identitaet_wrapper_status']) for (const c of ['beendet_erkannt_am', 'beendet_ursache', 'beendet_details'])
  assert.ok(anweisungen.some(a => a.startsWith(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${c} `)), t + '.' + c);
console.log('OK runtime-diagnose-p22-t118');

