#!/usr/bin/env node
// P8-T17: wiederverwendete Tray-Routen mit echtem Auth-Hook und synapse_test.
// Nur eigenes Wegwerf-Schema; keine Registry-/Daemon-/Hostbindung.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pruefeTestDbUrl} from './lib/test-db-schutz.mjs';
pruefeTestDbUrl('test-tray-api-p8-t17');
const connectionString=process.env.DATABASE_URL;
const require=createRequire(new URL('../packages/core/package.json',import.meta.url));
const {Client}=require('pg');
const admin=new Client({connectionString});
await admin.connect();
const schema='p8_t17_'+randomUUID().replaceAll('-','');
const project='sol14-tray-'+randomUUID(), foreign=project+'-fremd';
const oldOptions=process.env.PGOPTIONS;
const oldAuth=process.env.SYNAPSE_AUTH_DISABLED;
let pool,app,made=false;
try {
 assert.equal((await admin.query('SELECT current_database() AS db')).rows[0].db,'synapse_test');
 await admin.query('CREATE SCHEMA '+schema);made=true;
 for(const table of ['wrapper_status','file_versions','tool_calls','agent_sessions','specialist_channels','specialist_channel_members','specialist_channel_messages','auth_tokens']){
  await admin.query('CREATE TABLE '+schema+'.'+table+' (LIKE public.'+table+' INCLUDING ALL)');
 }
 process.env.PGOPTIONS='-c search_path='+schema+',public';
 delete process.env.SYNAPSE_AUTH_DISABLED;
 const core=await import('../packages/core/dist/index.js');pool=core.getPool();
 assert.equal((await pool.query('SELECT current_schema() AS schema')).rows[0].schema,schema);
 const Fastify=createRequire(new URL('../packages/rest-api/package.json',import.meta.url))('fastify');
 const {registerAuthHook}=await import('../packages/rest-api/dist/middleware/auth-hook.js');
 const {trayRoutes}=await import('../packages/rest-api/dist/routes/tray.js');
 const {specialistRoutes}=await import('../packages/rest-api/dist/routes/specialists.js');
 const auth=await import('../packages/rest-api/dist/services/auth.js');
 app=Fastify({logger:false});registerAuthHook(app);
 await app.register(trayRoutes);await app.register(specialistRoutes);await app.ready();
 const issued=await auth.issueServiceToken('daemon:sol14-fixture','P8-T17 Fixture');
 const expired=await auth.issueSessionToken('ui:tray',-1000);
 const get=(suffix,token=issued.token,p=project)=>app.inject({method:'GET',url:'/api/projects/'+encodeURIComponent(p)+suffix,headers:token?{authorization:'Bearer '+token}:{}});
 await pool.query("INSERT INTO wrapper_status(agent_name,project,model,status,tokens_percent,last_activity) VALUES ('older',$1,NULL,'idle',NULL,'2026-10-14T10:00:00Z'),('newer',$1,'fixture','running',12,'2026-10-14T11:00:00Z'),('foreign',$2,'foreign','running',99,NOW())",[project,foreign]);
 await pool.query("INSERT INTO agent_sessions(id,project,model,status) VALUES ('member',$1,NULL,'active'),('inactive',$1,'x','inactive'),('foreign',$2,'x','active')",[project,foreign]);
 await pool.query("INSERT INTO file_versions(project,file_path,content,content_hash,edit_action,agent_id,reason,created_at) VALUES ($1,'older.go','x','h1','update',NULL,NULL,'2026-10-14T10:00:00Z'),($1,'newer.go','x','h2','update','newer','fixture','2026-10-14T11:00:00Z'),($2,'foreign.go','x','h3','update','foreign','fixture',NOW())",[project,foreign]);
 const ownCall=(await pool.query("INSERT INTO tool_calls(project,tool_name,action,agent_id,ok,result,duration_ms) VALUES ($1,'files','plan','member',true,'fixture-result',7) RETURNING id::text",[project])).rows[0].id;
 const otherCall=(await pool.query("INSERT INTO tool_calls(project,tool_name,result) VALUES ($1,'foreign','foreign-result') RETURNING id::text",[foreign])).rows[0].id;
 const channel=(await pool.query("INSERT INTO specialist_channels(name,project,created_by) VALUES ('team',$1,'sol-14') RETURNING id",[project])).rows[0].id;
 const otherChannel=(await pool.query("INSERT INTO specialist_channels(name,project,created_by) VALUES ('team',$1,'sol-14') RETURNING id",[foreign])).rows[0].id;
 await pool.query("INSERT INTO specialist_channel_members(channel_id,agent_name) VALUES ($1,'member')",[channel]);
 const msg=(await pool.query("INSERT INTO specialist_channel_messages(channel_id,sender,content) VALUES ($1,'member','alt'),($1,'poster','neu') RETURNING id",[channel])).rows;
 await pool.query("INSERT INTO specialist_channel_messages(channel_id,sender,content) VALUES ($1,'foreign','fremd')",[otherChannel]);
 const suffixes=['/agents','/file-versions?limit=1','/tool-calls','/sessions','/channels/team/messages','/channels/team/members'];
 for(const suffix of suffixes){
  assert.equal((await get(suffix,null)).statusCode,401,'ohne Token: '+suffix);
  assert.equal((await get(suffix,'invalid')).statusCode,401,'falscher Token: '+suffix);
  assert.equal((await get(suffix,expired.token)).statusCode,401,'abgelaufen: '+suffix);
  const r=await get(suffix);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().success,true);
 }
 const agents=(await get('/agents')).json().agents;
 assert.deepEqual(agents.map(x=>x.agent_name),['newer','older']);
 assert.equal(agents[1].model,'');assert.equal(agents[1].tokens_percent,'0');
 const versions=(await get('/file-versions?limit=1')).json().versions;
 assert.equal(versions.length,1);assert.equal(versions[0].file_path,'newer.go');
 const calls=(await get('/tool-calls')).json().calls;
 assert.equal(calls.length,1);assert.equal(String(calls[0].id),ownCall);
 const detail=await get('/tool-calls/'+ownCall);
 assert.equal(detail.statusCode,200);assert.equal(detail.json().call.result,'fixture-result');
 assert.equal((await get('/tool-calls/'+otherCall)).statusCode,404,'fremder Tool-Call nicht abrufbar');
 assert.deepEqual((await get('/sessions')).json().sessions.map(x=>[x.id,x.model]),[['member','']]);
 const initial=(await get('/channels/team/messages')).json();
 assert.equal(initial.order,'desc');assert.deepEqual(initial.messages.map(x=>x.content),['neu','alt']);
 const polled=(await get('/channels/team/messages?since_id='+msg[0].id)).json();
 assert.equal(polled.order,'asc');assert.deepEqual(polled.messages.map(x=>x.content),['neu']);
 const members=(await get('/channels/team/members')).json().members;
 assert.deepEqual(members.map(x=>[x.agent,x.mitglied,x.hat_gepostet,x.aktiv]),[['member',true,true,true],['poster',false,true,false]]);
 // Nach Widerruf darf derselbe Tray-Zugang keine Daten mehr lesen.
 await auth.revokeToken(issued.token);
 assert.equal((await get('/agents')).statusCode,401);
 console.log('P8-T17 REST PASS: Tray-Token/Auth/Widerruf, Projektfilter, Agents/Versions/ToolCalls/Sessions/Channel-Feed/Members');
} finally {
 await app?.close();await pool?.end();
 if(made)await admin.query('DROP SCHEMA '+schema+' CASCADE');
 await admin.end();
 if(oldOptions===undefined)delete process.env.PGOPTIONS;else process.env.PGOPTIONS=oldOptions;
 if(oldAuth===undefined)delete process.env.SYNAPSE_AUTH_DISABLED;else process.env.SYNAPSE_AUTH_DISABLED=oldAuth;
}
