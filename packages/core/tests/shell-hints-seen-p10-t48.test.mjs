/**
 * P10-T48: Ein Agent, der Shell-Ausgabe direkt gelesen hat, bekommt sie nicht
 * nochmals als shell_activity-Hinweis. Andere Agenten bleiben unabhaengig.
 * Ausschliesslich synapse_test.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const dbUrl = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(dbUrl.port, '5433', 'nur Test-Instanz');
assert.equal(dbUrl.pathname, '/synapse_test', 'nur synapse_test');

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const load = (...parts) => import(pathToFileURL(join(repo, ...parts)).href);
const { getPool, closePool } = await load('packages/core/dist/db/client.js');
const { markShellJobSeenForToolCall, claimShellJobHints } = await load('packages/core/dist/services/shell-hints.js');
const pool = getPool();
const project = 'test-p10-t48-' + randomUUID();
const starter = 'p10-t48-starter-' + randomUUID();
const third = 'p10-t48-third-' + randomUUID();
const reader = 'p10-t48-reader-' + randomUUID();

async function addJob({ status = 'done', agentId = starter, streamId = null } = {}) {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO shell_jobs(id, project, command, status, agent_id, stream_id, exit_code, claimed_at, completed_at) VALUES($1, $2, 'true', $3::shell_job_status, $4, $5, 0, NOW() - interval '1 second', CASE WHEN $3 = 'running' THEN NULL ELSE NOW() END)",
    [id, project, status, agentId, streamId],
  );
  return id;
}
async function containsJob(agentId, id, kind) {
  const hints = await claimShellJobHints(project, agentId, 20);
  return hints.some((hint) => hint.job_id === id && hint.kind === kind);
}

try {
  assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db, 'synapse_test');

  // Synchronous exec: der Starter kennt Ergebnis + Status bereits. Dritte sehen
  // die Fertigmeldung einmal, bis sie diese selbst erhalten.
  const execId = await addJob();
  await markShellJobSeenForToolCall('exec', {}, { id: execId, status: 'done', exit_code: 0 }, starter);
  assert.equal(await containsJob(starter, execId, 'done'), false, 'Starter bekommt exec-Endergebnis nicht nochmals');
  assert.equal(await containsJob(third, execId, 'done'), true, 'Dritter bekommt Fertigmeldung');
  assert.equal(await containsJob(third, execId, 'done'), false, 'Dritter bekommt sie nur einmal');

  // Eine Lesung waehrend des Laufs quittiert nur den Start. Beim spaeteren Ende
  // bekommt der Starter genau eine neue, separate Fertigmeldung.
  const runningId = await addJob({ status: 'running' });
  await markShellJobSeenForToolCall('get', { id: runningId }, { success: true, job: { id: runningId, status: 'running' } }, starter);
  assert.equal(await containsJob(starter, runningId, 'done'), false, 'laufender eigener Job wird nicht vorzeitig als fertig gemeldet');
  assert.equal(await containsJob(third, runningId, 'start'), true, 'Dritter sieht laufenden Job');
  assert.equal(await containsJob(third, runningId, 'start'), false, 'Start-Hinweis nur einmal');
  await pool.query("UPDATE shell_jobs SET status='done', completed_at=NOW(), exit_code=0 WHERE id=$1", [runningId]);
  assert.equal(await containsJob(starter, runningId, 'done'), true, 'Starter sieht spaeter den Abschluss');
  assert.equal(await containsJob(starter, runningId, 'done'), false, 'Abschluss fuer Starter nur einmal');
  assert.equal(await containsJob(third, runningId, 'done'), true, 'Dritter sieht Abschluss nach bereits gesehenem Start');
  assert.equal(await containsJob(third, runningId, 'done'), false, 'Abschluss fuer Dritten nur einmal');

  // get, log und get_stream quittieren je Agent separat.
  const getId = await addJob();
  await markShellJobSeenForToolCall('get', { id: getId }, { success: true, job: { id: getId, status: 'done' } }, reader);
  assert.equal(await containsJob(reader, getId, 'done'), false, 'get markiert als gesehen');
  assert.equal(await containsJob(third, getId, 'done'), true, 'get eines Agenten blendet Dritten nicht aus');

  const logId = await addJob();
  await markShellJobSeenForToolCall('log', { id: logId }, { success: true, lines: [] }, reader);
  assert.equal(await containsJob(reader, logId, 'done'), false, 'log markiert als gesehen');

  const streamId = 'stream-' + randomUUID();
  const streamJobId = await addJob({ streamId });
  await markShellJobSeenForToolCall('get_stream', { stream_id: streamId }, { status: 'done', stream_id: streamId, new_lines: [] }, reader);
  assert.equal(await containsJob(reader, streamJobId, 'done'), false, 'get_stream markiert als gesehen');

  // Beide Transportpfade rufen denselben Core-Mechanismus auf.
  const rest = await readFile(join(repo, 'packages/rest-api/src/routes/mcp.ts'), 'utf8');
  const stdio = await readFile(join(repo, 'packages/mcp-server/src/server.ts'), 'utf8');
  const central = await readFile(join(repo, 'packages/core/src/services/tool-antwort.ts'), 'utf8');
  assert.match(rest, /await ergaenzeToolHinweise\(/);
  assert.match(stdio, /await ergaenzeToolHinweise\(JSON.parse\(first.text\), name/);
  assert.match(central, /await markShellJobSeenForToolCall\(args.action, args, kern, agentId\)/);

  console.log('OK P10-T48: starter/get/log/get_stream, Fremdagent, running->done, REST+stdio gemeinsam');
} finally {
  await pool.query('DELETE FROM shell_jobs WHERE project=$1', [project]).catch(() => {});
  await closePool().catch(() => {});
}
