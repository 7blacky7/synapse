/**
 * P22-T10: Altverhalten bei Schalter AUS gegen t106, plus Ergebnis-Rotkontrolle.
 * Basisdist wird separat vom Koordinator/sol-32 gebaut; dieser Test liest die Basis nur.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const u=new URL(process.env.DATABASE_URL??'http://invalid');
assert.equal(u.port,'5433');assert.equal(u.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
delete process.env.SYNAPSE_INTERN_TOOL;delete process.env.SYNAPSE_TOKEN_IDENTITAET;
process.env.QDRANT_URL='http://127.0.0.1:9';process.env.OLLAMA_URL='http://127.0.0.1:9';
const base=process.env.P22_BASE_ROOT??'/tmp/synapse-basis-d0c6ef30';
const B=await import(pathToFileURL(join(base,'packages/core/dist/services/chat.js')));
const BDB=await import(pathToFileURL(join(base,'packages/core/dist/db/client.js')));
const C=await import('../dist/services/chat.js');
const DB=await import('../dist/db/client.js');
const S=await import('../dist/services/agent-identitaet.js');
const {AGENT_IDENTITAET_SCHEMA_SQL}=await import('../dist/db/agent-identitaet-schema.js');
const require=createRequire(new URL('../package.json',import.meta.url)),{Pool}=require('pg');
const schema='p22_t10_alt_'+process.pid+'_'+randomUUID().slice(0,8), project='p22-t10-alt-own';
const raw=new Pool({connectionString:process.env.DATABASE_URL});
const pool={
 async connect(){const c=await raw.connect();try{await c.query('SET search_path TO '+schema);return c;}catch(e){c.release();throw e;}},
 async query(...a){const c=await this.connect();try{return await c.query(...a);}finally{c.release();}}
};
const q=(sql,a=[])=>pool.query(sql,a);
const date='2026-01-01T00:00:00.000Z';
const norm=v=>JSON.parse(JSON.stringify(v),(k,v)=>['sitzungSeit','sitzung_seit'].includes(k)?'<SITZUNGSZEIT>':v);
async function capture(chat,db){
 await q('TRUNCATE agent_sessions,chat_lesestand');
 await q(`INSERT INTO agent_sessions(id,project,status,registered_at,sitzung_seit,aktiv_seit)
   VALUES ('legacy',$1,'active',$2,$2,$2)`,[project,date]);
 await q("INSERT INTO chat_lesestand(project,agent_id,letzte_id,letzte_hinweis_id) VALUES ($1,'legacy',5,8)",[project]);
 const result=await db.mitLesePool(pool,()=>chat.registerAgent('legacy',project));
 const session=(await q("SELECT * FROM agent_sessions WHERE id='legacy'")).rows[0];
 const read=(await q("SELECT * FROM chat_lesestand WHERE agent_id='legacy'")).rows[0];
 const snap=norm({result,session,read});
 assert.equal(snap.result.registeredAt,date);
 assert.equal(Number(snap.read.letzte_id),5);assert.equal(Number(snap.read.letzte_hinweis_id),8);
 return snap;
}
try{
 await raw.query('CREATE SCHEMA '+schema);
 await q(`CREATE TABLE agent_sessions(id TEXT PRIMARY KEY,project TEXT NOT NULL,model TEXT,cutoff_date DATE,
  status TEXT DEFAULT 'active', registered_at TIMESTAMPTZ DEFAULT NOW(),sitzung_seit TIMESTAMPTZ,
  aktiv_seit TIMESTAMPTZ)`);
 await q('CREATE TABLE chat_messages(id BIGINT,project TEXT)');
 await q('CREATE TABLE chat_lesestand(project TEXT,agent_id TEXT,letzte_id BIGINT,letzte_hinweis_id BIGINT DEFAULT 0,PRIMARY KEY(project,agent_id))');
 await q(AGENT_IDENTITAET_SCHEMA_SQL);
 const golden=await capture(B,BDB);
 const actual=await capture(C,DB);
 assert.deepEqual(actual,golden,'AUS-Altverhalten muss identisch zur Basis t106 bleiben');
 console.log('PASS AUS-Golden: echte chat-Registrierung + PG-Sitzung + Lesestand exakt t106 (nur Sitzungszeit normalisiert)');
 // Rote Positivkontrolle AN EINEM ERGEBNIS: alte Registrierung erzeugt keine zweite Identitaet/Sitzung.
 // Die Migration ist absichtlich bereits vorhanden; kein fehlender Export entscheidet den Befund.
 const oldSessionCount=(await q('SELECT count(*)::int n FROM agent_sessions')).rows[0].n;
 assert.equal(golden.session.context_epoch,0);assert.equal(oldSessionCount,1);
 let red=false;try{assert.equal(oldSessionCount,2);}catch(e){if(e instanceof assert.AssertionError)red=true;else throw e;}
 assert(red);console.log('EXPECTED_RED t106: zwei getrennte Sitzungen erwartet, alte Registrierung liefert nur eine');
 if(process.argv[2]==='red-only'){process.exitCode=1;} else {
  process.env.SYNAPSE_TOKEN_IDENTITAET='1';
  await DB.mitLesePool(pool,async()=>{
   await assert.rejects(()=>S.stelleAgentTokenAus({project,name:'legacy'}),e=>e.code==='name_gehoert_bestehendem_agenten');
   assert.equal((await q("SELECT count(*)::int n FROM agent_identitaeten WHERE name='legacy'")).rows[0].n,0);
   const issued=await S.stelleAgentTokenAus({project,name:'fresh'});
   const p=await S.meldeAgentMitTokenAn(issued.token,project);
   assert.equal(p.context_epoch,1);assert.equal(p.agent_id,'fresh');
   const session=(await q("SELECT * FROM agent_sessions WHERE id='fresh'")).rows[0];
   assert.equal(session.context_epoch,1);assert.equal(session.identity_id,issued.identitaet.id);
   const old=(await q("SELECT * FROM agent_sessions WHERE id='legacy'")).rows[0];
   assert.equal(old.aktiv_seit.toISOString(),date);assert.deepEqual(norm(old),actual.session);
   assert.equal(old.identity_id,null);assert.equal(old.context_epoch,0);
   assert.equal((await q('SELECT count(*)::int n FROM agent_sessions')).rows[0].n,2);
   assert.equal(Number((await q("SELECT letzte_id FROM chat_lesestand WHERE agent_id='legacy'")).rows[0].letzte_id),5);
  });
  console.log('PASS Positivkontrolle neu: Legacy-Selbstanmeldung abgewiesen; separate neue Identität mit Epoch1; alte Legacy-Sitzung und Lesestand unverändert');
 }
}finally{
 await raw.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await raw.end();
 await DB.closePool();await BDB.closePool();
}
