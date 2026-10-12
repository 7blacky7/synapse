/** P10-T13: Proposal-Antworten über den echten stdio-Server; nur synapse_test. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {Client} from '../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StdioClientTransport} from '../node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const db = new URL(process.env.DATABASE_URL ?? 'http://invalid');
assert.equal(db.port, '5433');
assert.equal(db.pathname, '/synapse_test');
const {getPool} = await import('../../core/dist/db/client.js');
const {emitEvent} = await import('../../core/dist/services/events.js');
const pool = getPool();
const project = 'sol-3-proposal-json-' + randomUUID();
const client = new Client({name: 'proposal-json-regression', version: '1.0.0'});
const env = Object.fromEntries(Object.entries(process.env).filter(([,v]) => typeof v === 'string'));
// Beide DB-Variablen auf dieselbe geprüfte Test-DB begrenzen.
env.SYNAPSE_DATABASE_URL = env.DATABASE_URL;
env.SYNAPSE_PROJECT = project;
// Test-Home außerhalb des überwachten Repos; die echte Registry bleibt unberührt.
const fixtureHome = mkdtempSync(join(homedir(), 'dev', '.synapse-t13-'));
env.HOME = fixtureHome;
mkdirSync(join(fixtureHome, '.synapse'));
writeFileSync(join(fixtureHome, '.synapse', 'project-registry.json'), JSON.stringify({[project]: fixtureHome}));
writeFileSync(join(fixtureHome, '.synapse', 'status.json'), JSON.stringify({project, path: fixtureHome, status: 'active', setupPhase: 'initial-done'}));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
  env,
  cwd: fixtureHome,
  stderr: 'pipe',
});
transport.stderr?.resume();
try {
  // Vorhandene Regel verhindert den automatischen Handoff-Embedding-Schreibweg.
  await pool.query('INSERT INTO memories(id,project,name,content,category,tags) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), project, 'context-handoff-regeln', 'Testregel', 'rules', ['pflicht']]);
  await client.connect(transport);
  for (const action of ['list', 'get', 'update_status', 'delete']) {
    const agent = project + '-' + action;
    const event = await emitEvent(project, 'ANNOUNCEMENT', 'normal', 'agent:' + agent, agent, 'Testhinweis', true);
    const args = {action, project, agent_id: agent};
    if (action !== 'list') args.id = randomUUID();
    if (action === 'update_status') args.status = 'reviewed';
    const response = await client.callTool({name: 'proposal', arguments: args});
    assert(!response.isError, action + ': reguläre Antwort erwartet');
    const text = response.content.find(part => part.type === 'text')?.text;
    assert.equal(typeof text, 'string');
    const json = JSON.parse(text);
    assert.equal(typeof json, 'object');
    assert(!Array.isArray(json));
    assert.equal(json.agentOnboarding?.isFirstVisit, true, action + ': Onboarding fehlt');
    assert(json.pending_events?.some(e => String(e.event_id) === String(event.id)), action + ': Event-Hook fehlt');
    assert.equal(typeof json.content?.[0]?.text, 'string', 'Legacy-Anzeigetext bleibt erhalten');
    const repeat = await client.callTool({name: 'proposal', arguments: args});
    assert.equal(JSON.parse(repeat.content[0].text).agentOnboarding, undefined, 'Onboarding nur beim ersten Besuch');
    console.log('OK ' + action + ': JSON, erstes Onboarding, Event-Hook und Legacy-Anzeige');
  }
  console.log('PASS P10-T13: vier Proposal-Aktionen über stdio');
} catch (error) {
  // Keine Umgebungswerte oder fremden Daten ausgeben.
  console.error('stdio-Regressionslauf fehlgeschlagen: ' + error.message);
  throw error;
} finally {
  await client.close();
  await pool.query('DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project=$1)', [project]);
  for (const table of ['agent_events', 'tool_calls', 'agent_onboardings', 'agent_sessions', 'memories']) {
    await pool.query('DELETE FROM ' + table + ' WHERE project=$1', [project]);
  }
  await pool.end();
  rmSync(fixtureHome, {recursive: true, force: true});
}
