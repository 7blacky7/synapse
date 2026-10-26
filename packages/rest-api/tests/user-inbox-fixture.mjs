/**
 * P22-T195 Folge t215: optionale vollstaendige Schema166-Fixture fuer QuellenAnmerkungen im echten Lesefenster.
 * P22-T192: echte User-Inbox-REST/Core/Auth-Dienste, eigenes Schema nur synapse_test:5433.
 * specialist_inbox-Fixture ist die einzige Nachrichtenquelle. Keine Mock-Antworten/LLM/Daemon/Produktivdaten.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
export async function userInboxFixture({ intern = false, quellenanmerkungen = false } = {}) {
  const url = new URL(process.env.SYNAPSE_DATABASE_URL || process.env.DATABASE_URL || 'http://invalid');
  assert.equal(url.port, '5433'); assert.equal(url.pathname, '/synapse_test');
  for (const n of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_AUTH_DISABLED']) delete process.env[n];
  Object.assign(process.env, { SYNAPSE_AGENT_BEZUG_MODUS: 'beide', SYNAPSE_INTERN_TOOL: intern ? '1' : '0',
    SYNAPSE_SHELL_JOB: '1', SYNAPSE_SKIP_EMBEDDINGS: '1', PARSER_LOOP_DISABLED: '1' });
  const require = createRequire(new URL('../../core/package.json', import.meta.url)), { Pool } = require('pg');
  const admin = new Pool({ connectionString: url.href }), schema = 'p22_t192_' + randomUUID().replaceAll('-', '');
  const P = 'p22-t192-alfa', Q = 'p22-t192-beta', A = randomUUID(), B = randomUUID(), T = randomUUID();
  let C, app;
  const close = async () => { await app?.close(); if (C) await C.closePool(); await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); await admin.end(); };
  try {
    await admin.query('CREATE SCHEMA ' + schema);
    // P22-T195 Folge t215: Schema166 installiert echte Quelltrigger; dafuer alle sechs Quelltabellen im privaten Schema bereitstellen.
    for (const table of ['agent_identitaeten','agent_profil_schalter','runtime_ueberwachung_einstellungen','intern_schalter','specialist_inbox','auth_tokens','thoughts','tech_docs',
      ...(quellenanmerkungen ? ['memories','plans','agent_artifacts','chat_messages','specialist_channels','specialist_channel_messages'] : [])]) {
      await admin.query('CREATE TABLE ' + schema + '.' + table + ' (LIKE public.' + table + ' INCLUDING ALL)');
    }
    const serials = await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%'", [schema]);
    for (const [n, row] of serials.rows.entries()) {
      const seq = schema + '.serial_' + n;
      await admin.query('CREATE SEQUENCE ' + seq);
      await admin.query('ALTER TABLE ' + schema + '."' + row.table_name + '" ALTER COLUMN "' + row.column_name + '" SET DEFAULT nextval(\'' + seq + '\'::regclass)');
    }
    url.searchParams.set('options', '-c search_path=' + schema); process.env.DATABASE_URL = url.href;
    C = await import('../../core/dist/index.js');
    const pool = C.getPool();
    if (quellenanmerkungen) await pool.query(C.QUELLENANMERKUNGEN_SCHEMA_SQL);
    await pool.query("INSERT INTO agent_identitaeten(id,project,agent_id,name,rolle,status,erstellt_von) VALUES($1,$2,'gleicher-name','Alfa Agent','subagent','aktiv','P22-T192 Test'),($3,$4,'gleicher-name','Beta Agent','koordinator','aktiv','P22-T192 Test')", [A,P,B,Q]);
    await pool.query("INSERT INTO thoughts(id,project,content,source) VALUES($1,$2,'P22-T192 Zitat-Beleg aus echter Testdatenbank','test')", [T,P]);
    const insert = async (project, from, to, text, identity = null, processed = false) => {
      const r = await pool.query('INSERT INTO specialist_inbox(project,from_agent,to_agent,content,from_identity_id,processed) VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text', [project,from,to,text,identity,processed]);
      return r.rows[0].id;
    };
    const reset = async () => {
      await pool.query('DELETE FROM specialist_inbox');
      await pool.query('DELETE FROM agent_profil_schalter');
      await pool.query('DELETE FROM intern_schalter');
      await pool.query('DELETE FROM runtime_ueberwachung_einstellungen');
      await pool.query("UPDATE agent_identitaeten SET status='aktiv',agent_id='gleicher-name' WHERE id IN ($1,$2)", [A,B]);
      const a = await insert(P,'gleicher-name','user',C.textMitZitaten('Antwort Alfa. Beleg thought ' + T, [{ art:'thought',id:T,projekt:P,titel:'Zitat-Beleg',ausschnitt:'Belegtext',anmerkung:'Bitte lesen' }]),A);
      const b = await insert(Q,'gleicher-name','user','Antwort Beta aus anderem Projekt.',B);
      const c = await insert(P,'legacy-helfer','user','Ältere bereits gelesene Nachricht.',null,true);
      const fremd = await insert(P,'gleicher-name','fremder-agent','Nicht für den User.',A);
      return { a,b,c,fremd };
    };
    const ids = await reset();
    const auth = await import('../dist/services/auth.js');
    const tokens = {
      session: (await auth.issueSessionToken(null, 600000)).token,
      access: (await auth.issueAccessToken('p22-t192', null, 600000)).token,
      service: (await auth.issueServiceToken(JSON.stringify({ rolle: 'koordinator', project: P }), 'P22-T192 Test', 600000)).token,
    };
    const requireApi = createRequire(new URL('../package.json', import.meta.url)), Fastify = requireApi('fastify');
    app = Fastify({ logger: false });
    const { agentRuntimeRoutes } = await import('../dist/routes/agent-runtimes.js');
    const { verweiseRoutes } = await import('../dist/routes/verweise.js');
    await app.register(agentRuntimeRoutes); await app.register(verweiseRoutes);
    await app.listen({ host:'127.0.0.1',port:0 });
    return { app,C,pool,ids,reset,insert,P,Q,A,B,T,tokens,close,url:'http://127.0.0.1:' + app.server.address().port };
  } catch (e) { await close(); throw e; }
}
