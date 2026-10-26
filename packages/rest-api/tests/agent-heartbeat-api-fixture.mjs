/** P22-T188: echte REST-Route und Core, nur privates Schema in synapse_test:5433. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
export const HEARTBEAT_IDS = {
  'ko-a': '00000000-0000-4000-8000-00000000000a',
  'ko-b': '00000000-0000-4000-8000-00000000000b',
  'agent-a': '00000000-0000-4000-8000-00000000000c',
};
export async function heartbeatApiFixture() {
  const url = new URL(process.env.SYNAPSE_DATABASE_URL || process.env.DATABASE_URL || 'http://invalid');
  assert.equal(url.port, '5433', 'P22-T188 nur Test-Port'); assert.equal(url.pathname, '/synapse_test', 'P22-T188 nur Test-DB');
  delete process.env.SYNAPSE_DATABASE_URL;
  delete process.env.SYNAPSE_AGENT_TOKEN;
  delete process.env.SYNAPSE_AGENT_IDENTITY_ID;
  Object.assign(process.env, { SYNAPSE_AUTH_DISABLED: '1', SYNAPSE_AGENT_BEZUG_MODUS: 'beide', SYNAPSE_INTERN_TOOL: '0',
    SYNAPSE_SHELL_JOB: '1', SYNAPSE_SKIP_EMBEDDINGS: '1', PARSER_LOOP_DISABLED: '1' });
  const require = createRequire(new URL('../../core/package.json', import.meta.url));
  const { Pool } = require('pg'), admin = new Pool({ connectionString: url.href });
  const schema = 'p22_t188_' + randomUUID().replaceAll('-', ''), project = 'p22-t188-fixture';
  let C, app;
  const close = async () => {
    await app?.close();
    if (C) await C.getPool().end();
    await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await admin.end();
  };
  try {
    await admin.query('CREATE SCHEMA ' + schema);
    for (const table of ['agent_identitaeten', 'agent_identitaet_wrapper_status', 'wrapper_status', 'agent_identitaet_audit', 'agent_profil_schalter']) {
      await admin.query('CREATE TABLE ' + schema + '.' + table + ' (LIKE public.' + table + ' INCLUDING ALL)');
    }
    // Keine Sequenz aus public benutzen, auch nicht in der Testdatenbank.
    const serials = await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%'", [schema]);
    for (const [n, row] of serials.rows.entries()) {
      const seq = schema + '.serial_' + n;
      await admin.query('CREATE SEQUENCE ' + seq);
      await admin.query('ALTER TABLE ' + schema + '."' + row.table_name + '" ALTER COLUMN "' + row.column_name + '" SET DEFAULT nextval(\'' + seq + '\'::regclass)');
    }
    url.searchParams.set('options', '-c search_path=' + schema); process.env.DATABASE_URL = url.href;
    C = await import('../../core/dist/index.js');
    const pool = C.getPool();
    for (const [name, id] of Object.entries(HEARTBEAT_IDS)) {
      await pool.query("INSERT INTO agent_identitaeten(id,project,agent_id,name,rolle,status,erstellt_von) VALUES($1,$2,$3,$3,$4,'aktiv','p22-t188-test')", [id, project, name, name.startsWith('ko') ? 'koordinator' : 'subagent']);
    }
    for (const funktion of ['koordinator_heartbeat', 'runtime_agenten_steuerung']) {
      await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,$2,true,'P22-T188 Test','user')", [project, funktion]);
    }
    const reset = async ({ off = false, noRun = false } = {}) => {
      await pool.query('UPDATE agent_profil_schalter SET aktiv=$1', [!off]);
      await pool.query('DELETE FROM agent_identitaet_wrapper_status');
      for (const [name, id] of Object.entries(HEARTBEAT_IDS)) {
        const aktiv = name !== 'ko-b';
        await pool.query("UPDATE agent_identitaeten SET startrezept=jsonb_build_object('heartbeat',jsonb_build_object('aktiv',$2::boolean,'intervall_ms',60000)) WHERE id=$1", [id, aktiv]);
        if (noRun && name === 'agent-a') continue;
        await pool.query("INSERT INTO agent_identitaet_wrapper_status(identity_id,project,agent_name,status,busy,last_activity,heartbeat_enabled,heartbeat_interval_ms) VALUES($1,$2,$3,'running',false,NOW(),$4,60000)", [id, project, name, aktiv]);
      }
    };
    await reset();
    const requireApi = createRequire(new URL('../package.json', import.meta.url));
    const Fastify = requireApi('fastify');
    app = Fastify({ logger: false });
    const { agentRuntimeRoutes } = await import('../dist/routes/agent-runtimes.js');
    await app.register(agentRuntimeRoutes);
    await app.listen({ host: '127.0.0.1', port: 0 });
    return { app, C, pool, project, reset, close, url: 'http://127.0.0.1:' + app.server.address().port };
  } catch (error) { await close(); throw error; }
}
