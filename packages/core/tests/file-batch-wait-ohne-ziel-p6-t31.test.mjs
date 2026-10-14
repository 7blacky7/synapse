/**
 * P6-T31: Reservierung ohne Plan erzeugt einen handlungsleitenden Wait.
 * Test-DB only; separates Projekt, fremde aktive Projektdateien werden nicht beruehrt.
 * Aufruf: (DATABASE_URL = Projekt-DB aus dem Synapse-shell-Job) node packages/core/tests/file-batch-wait-ohne-ziel-p6-t31.test.mjs
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const db = new URL(process.env.DATABASE_URL || 'http://invalid');
assert.equal(db.pathname, '/synapse_test', 'nur synapse_test');
assert.equal(db.port, '5433', 'nur Test-DB-Port');
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const batch = await import(join(dist, 'services', 'file-batch.js'));
const codeWrite = await import(join(dist, 'services', 'code-write.js'));
const reservations = await import(join(dist, 'services', 'file-reservations.js'));
const events = await import(join(dist, 'services', 'events.js'));
const { getPool } = await import(join(dist, 'db', 'client.js'));
const pool = getPool();
const PROJECT = 'p6t31-wait-handoff';
const A = 'p6t31-agent-a';
const B = 'p6t31-agent-b';
let assertions = 0;
const check = (condition, message, detail) => {
  assertions++;
  assert.ok(condition, message + (detail === undefined ? '' : ': ' + JSON.stringify(detail)));
};
async function cleanup() {
  await pool.query('DELETE FROM tool_calls WHERE project=$1', [PROJECT]);
  await pool.query('DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project=$1)', [PROJECT]);
  for (const table of ['file_batch_waits','file_batch_plans','file_reservations','file_versions','code_files','agent_events']) {
    await pool.query('DELETE FROM ' + table + ' WHERE project=$1', [PROJECT]);
  }
  await pool.query('DELETE FROM agent_sessions WHERE project=$1 AND id=ANY($2::text[])', [PROJECT,[A,B,'p6t31-agent-c','p6t31-agent-d','p6t31-setup']]);
}
async function createFile(path, content) {
  const p = await batch.planBatch({project:PROJECT,agent_id:'p6t31-setup',ops:[{file_path:path,action:'create',content}]});
  const c = await batch.commitBatch({plan_id:p.plan_id,agent_id:'p6t31-setup'});
  check(c.success === true, 'Testdatei angelegt', c);
}
async function waitRow(token) {
  return (await pool.query('SELECT primary_plan_id::text AS target_plan_id,status::text AS status FROM file_batch_waits WHERE wait_token=$1::uuid',[token])).rows[0];
}

await cleanup();
try {
  // A reserviert ohne Plan; B soll seinen eigenen Write nicht verlieren, aber A muss die Bitte sehen.
  await createFile('src/shared.ts','one\ntwo\n');
  await reservations.addFileReservations({project:PROJECT,agentId:A,filePaths:['src/shared.ts']});
  const started = Date.now();
  const bOp = {file_path:'src/shared.ts',action:'search_replace',search:'two',replace:'TWO'};
  const b = await batch.planBatch({project:PROJECT,agent_id:B,ops:[bOp]});
  const wait = b.coedit_waits?.[0];
  check(b.total_ops === 0 && b.deferred_ops === 1, 'B bleibt Wait statt A-Vorrang zu ueberschreiben', b);
  check(wait && !wait.target_plan_id, 'Start-Wait hat noch keinen Zielplan');
  check(wait.expires_at && new Date(wait.expires_at).getTime() - started >= 280000, 'Wait-Deadline folgt der planlosen Fuenf-Minuten-TTL', wait);
  check(typeof wait.handlungsanweisung === 'string', 'B-Antwort enthaelt konkrete Handlungsanweisung');
  check(wait.handlungsanweisung.includes('reservation_release'), 'B sieht Freigabeweg');
  check(wait.handlungsanweisung.includes('60 Sekunden'), 'B sieht den 60-s-Statusrhythmus');
  check(wait.handlungsanweisung.includes('dieselben Ops erneut'), 'B sieht Retry nach Ablauf');

  const pending = await events.getPendingEvents(PROJECT,A);
  const invitation = pending.find(event => event.eventType === 'PLAN_WAITING' && event.sourceId === B);
  check(Boolean(invitation), 'A erhaelt ein persistentes PLAN_WAITING-Event', pending.map(e => e.eventType));
  const payload = JSON.parse(invitation.payload);
  check(payload.wait_token === wait.wait_token && payload.waiting_agent === B, 'Event bindet genau diesen Wait an B');
  check(payload.shared_files.includes('src/shared.ts') && payload.expires_at === wait.expires_at, 'Event nennt Datei und Deadline');
  check(payload.actions?.plan?.action === 'plan' && payload.actions.plan.agent_id === A
    && payload.actions.plan.file_paths?.includes('src/shared.ts') && payload.actions.plan.ops_hint, 'Event beschreibt As Planweg mit benoetigten eigenen Ops');
  check(payload.actions?.release?.action === 'reservation_release'
    && payload.actions.release.agent_id === A && payload.actions.release.file_path === 'src/shared.ts', 'Event enthaelt fertigen Freigabeaufruf');
  check(invitation.requiresAck === true, 'Einladung bleibt bis Ack persistent');

  // B bekommt nach A's Plan ein Ziel und kann ueber den Wait beitragen.
  const a = await batch.planBatch({project:PROJECT,agent_id:A,ops:[{file_path:'src/shared.ts',action:'search_replace',search:'one',replace:'ONE'}]});
  const linked = await waitRow(wait.wait_token);
  check(linked.target_plan_id === a.plan_id, 'A-Plan bindet den wartenden Beitrag an genau einen Zielplan', linked);
  const contribution = await batch.addCoeditContribution({project:PROJECT,plan_id:a.plan_id,agent_id:B,wait_token:wait.wait_token,ops:[bOp]});
  check(contribution.success === true && contribution.plan_id === a.plan_id, 'B kann nach A-Plan beitragen', contribution);

  // Unveraendertes plan/plan_status-Standardverhalten ohne Reservations-Overlap pruefen.
  await createFile('src/plain.ts','plain=1\n');
  const plain = await batch.planBatch({project:PROJECT,agent_id:B,ops:[{file_path:'src/plain.ts',action:'search_replace',search:'plain=1',replace:'plain=2'}]});
  check(plain.total_ops === 1 && !plain.coedit_waits && !plain.hinweise, 'Standard-plan ohne Overlap bleibt schlank', plain);
  const plainStatus = batch.buildPlanStatusResponse(await batch.getBatchPlan(plain.plan_id));
  check(plainStatus.ops_count === 1 && !plainStatus.coedit_waits && !plainStatus.hinweise, 'Standard-plan_status ohne Wait bleibt schlank', plainStatus);

  // Live-Fall: mehrere Reservierende skalieren die TTL; ein Commit auf anderer Datei loest
  // As planlose Index-Reservierung nicht automatisch. Die 60 Minuten werden nicht abgewartet.
  await createFile('src/index.ts','export const live = 1;\n');
  await createFile('src/own-commit.ts','export const own = 1;\n');
  const C = 'p6t31-agent-c';
  const D = 'p6t31-agent-d';
  await reservations.addFileReservations({project:PROJECT,agentId:C,filePaths:['src/index.ts']});
  await reservations.addFileReservations({project:PROJECT,agentId:D,filePaths:['src/index.ts']});
  const scaled = await reservations.addFileReservations({project:PROJECT,agentId:A,filePaths:['src/index.ts']});
  const liveReservation = (await pool.query(
    "SELECT expires_at, released_at, plan_id::text AS plan_id FROM file_reservations WHERE project=$1 AND agent_id=$2 AND file_path='src/index.ts' ORDER BY reserved_at DESC,id DESC LIMIT 1",
    [PROJECT,A],
  )).rows[0];
  const ttlSeconds = (new Date(liveReservation.expires_at).getTime()-Date.now())/1000;
  check(ttlSeconds >= 280 && ttlSeconds <= 305 && liveReservation.plan_id === null,
    'Planlose Reservierung hat feste Fuenf-Minuten-TTL trotz mehrerer Beteiligter', {ttlSeconds,liveReservation,scaled});
  const liveB = await batch.planBatch({project:PROJECT,agent_id:B,ops:[{file_path:'src/index.ts',action:'search_replace',search:'live = 1',replace:'live = 2'}]});
  check(liveB.deferred_ops === 1 && liveB.coedit_waits?.[0]?.primary_agent === C,
    'B wartet vor As Commit mit gespeicherter Deferred-Op', liveB);
  await createFile('src/planned.ts','export const planned = 1;\n');
  const protectedPlan = await batch.planBatch({project:PROJECT,agent_id:A,ops:[{file_path:'src/planned.ts',action:'search_replace',search:'planned = 1',replace:'planned = 2'}]});
  await reservations.addFileReservations({project:PROJECT,agentId:A,filePaths:['src/planned.ts'],planId:protectedPlan.plan_id});
  const protectedBefore = (await pool.query("SELECT released_at, plan_id::text AS plan_id FROM file_reservations WHERE project=$1 AND agent_id=$2 AND file_path='src/planned.ts' AND released_at IS NULL ORDER BY id DESC LIMIT 1",[PROJECT,A])).rows[0];
  check(protectedBefore?.plan_id === protectedPlan.plan_id, 'Kontrollreservierung trägt den offenen Plan', {protectedBefore,protectedPlan});
  const ownPlan = await batch.planBatch({project:PROJECT,agent_id:A,ops:[{file_path:'src/own-commit.ts',action:'search_replace',search:'own = 1',replace:'own = 2'}]});
  const ownCommit = await batch.commitBatch({plan_id:ownPlan.plan_id,agent_id:A});
  check(ownCommit.success === true, 'A kann eigene unabhaengige Datei committen', ownCommit);
  const protectedAfter = (await pool.query("SELECT released_at, plan_id::text AS plan_id FROM file_reservations WHERE project=$1 AND agent_id=$2 AND file_path='src/planned.ts' AND released_at IS NULL ORDER BY id DESC LIMIT 1",[PROJECT,A])).rows[0];
  check(protectedAfter?.released_at === null && protectedAfter.plan_id === protectedPlan.plan_id, 'Planbehaftete Reservierung bleibt vom fremden Commit unberührt', protectedAfter);
  await reservations.releaseFileReservations({project:PROJECT,agentId:C,filePaths:['src/index.ts']});
  await reservations.releaseFileReservations({project:PROJECT,agentId:D,filePaths:['src/index.ts']});
  const stillReserved = (await pool.query(
    "SELECT released_at, plan_id::text AS plan_id, expires_at FROM file_reservations WHERE project=$1 AND agent_id=$2 AND file_path='src/index.ts' ORDER BY reserved_at,id LIMIT 1",
    [PROJECT,A],
  )).rows[0];
  check(stillReserved.released_at !== null && stillReserved.plan_id === null,
    'Eigener Commit gibt As planlose index.ts-Reservierung frei', stillReserved);
  check(ownCommit.released_reservations?.some(r => r.file_path === 'src/index.ts' && r.reason === 'freigegeben nach eigenem Commit'),
    'Commit-Antwort nennt planlose Freigabe samt Grund', ownCommit.released_reservations);
  const replannedB = (await pool.query(
    "SELECT id::text AS plan_id, jsonb_array_length(ops)::int AS ops FROM file_batch_plans WHERE project=$1 AND owner_agent_id=$2 AND status='open' AND expected_hashes ? 'src/index.ts' ORDER BY created_at DESC,id DESC LIMIT 1",
    [PROJECT,B],
  )).rows[0];
  check(replannedB?.plan_id && replannedB.ops === 1,
    'B bekommt seine gespeicherte Deferred-Op nach As Commit automatisch eingeplant', replannedB);

  await reservations.addFileReservations({project:PROJECT,agentId:A,filePaths:['src/index.ts']});
  const directWrite = await codeWrite.updateFileInPg(PROJECT,'src/own-commit.ts','export const own = 3;\n',A,'update');
  check(directWrite.released_reservations?.some(r => r.file_path === 'src/index.ts' && r.reason === 'freigegeben nach eigenem Commit'),
    'Einzelschreibweg gibt planlose Reservierungen frei und nennt sie', directWrite);
  const directRelease = (await pool.query(
    "SELECT released_at FROM file_reservations WHERE project=$1 AND agent_id=$2 AND file_path='src/index.ts' ORDER BY reserved_at DESC,id DESC LIMIT 1",
    [PROJECT,A],
  )).rows[0];
  check(directRelease.released_at !== null, 'Einzelschreibweg hat Planlos-Reservierung freigegeben', directRelease);

  await reservations.addFileReservations({project:PROJECT,agentId:A,filePaths:['src/index.ts']});
  await pool.query("UPDATE file_reservations SET expires_at=NOW()-INTERVAL '1 second' WHERE project=$1 AND agent_id=$2 AND file_path='src/index.ts' AND released_at IS NULL AND plan_id IS NULL",[PROJECT,A]);
  const expiry = await reservations.releaseStaleFileReservations({project:PROJECT});
  const expired = (await pool.query("SELECT released_at FROM file_reservations WHERE project=$1 AND agent_id=$2 AND file_path='src/index.ts' AND plan_id IS NULL ORDER BY reserved_at DESC,id DESC LIMIT 1",[PROJECT,A])).rows[0];
  check(expiry.abgelaufen >= 1 && expired.released_at !== null, 'Planlose Reservierung wird unmittelbar nach TTL automatisch freigegeben', {expiry,expired});
  console.log('ERGEBNIS P6-T36: ' + assertions + ' Assertions gruen.');
} finally {
  await cleanup();
  const remain = await pool.query("SELECT (SELECT COUNT(*) FROM file_batch_plans WHERE project=$1)+(SELECT COUNT(*) FROM file_batch_waits WHERE project=$1)+(SELECT COUNT(*) FROM file_reservations WHERE project=$1)+(SELECT COUNT(*) FROM code_files WHERE project=$1)+(SELECT COUNT(*) FROM agent_events WHERE project=$1) AS n",[PROJECT]);
  check(Number(remain.rows[0].n) === 0, 'Testprojekt bereinigt', remain.rows[0]);
  await pool.end();
}
