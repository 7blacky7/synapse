#!/usr/bin/env node
/** P9-T27 Nachbesserung (Testbefund 291473c2 Nr. 1): /api/daemon/specialist/daten und der PG-Datenweg der
 * Spezialisten-Tools duerfen NUR Daten des geprueften Projekts zum Agentnamen aendern.
 * Aufbau: zwei Projekte PA/PB (beide auf diesem Host) mit gleichem Agentnamen X; Vorher/Nachher-Zaehlung fuer PB.
 * Nur synapse_test (5433), eigenes Wegwerf-Schema (LIKE-Kopien, PGOPTIONS search_path), echte Auth (Token + Hostbindung),
 * Fastify nur per inject. Kein Daemon, kein Docker, keine Live-Registry.
 * Aufruf: node scripts/test-spezialisten-projektbindung-p9-t27.mjs (DATABASE_URL setzt der Synapse-Shell-Job). */
import assert from 'node:assert/strict';
import os from 'node:os';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';

const url=new URL(process.env.DATABASE_URL??'');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
const schema='p9_t27pb_'+randomUUID().replaceAll('-','').slice(0,20);
const T=n=>schema+'.'+n;
process.env.PGOPTIONS='-c search_path='+schema+',public';
process.env.SYNAPSE_SKIP_EMBEDDINGS='1';
process.env.QDRANT_URL='http://127.0.0.1:9';
delete process.env.SYNAPSE_AUTH_DISABLED;
const require=createRequire(new URL('../packages/core/package.json',import.meta.url)),{Client}=require('pg');
const admin=new Client({connectionString:url.href,options:''});await admin.connect();
assert.equal((await admin.query('SELECT current_database() AS db')).rows[0].db,'synapse_test');
const HOST=os.hostname(),PA='t27pb-a-'+process.pid,PB='t27pb-b-'+process.pid;
const X='t27pb-x-'+process.pid,Y='t27pb-y-'+process.pid;
const TABELLEN=['projects','wrapper_status','daemon_restore_host_bindings','specialist_inbox','specialist_channels',
 'specialist_channel_members','specialist_channel_messages','agent_sessions','agent_onboardings'];
let made=false,app,auth=null,count=0;const tokens=[];
const check=async(name,fn)=>{await fn();console.log('PASS '+(++count)+' '+name);};
const q=(sql,args=[])=>admin.query(sql,args);
const sha=s=>createHash('sha256').update(s).digest('hex');

async function wrapperZeile(agent,project){
 const spalten=(await q("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='wrapper_status' AND is_nullable='NO' AND column_default IS NULL",[schema])).rows.map(r=>r.column_name);
 const w={project,agent_name:agent,wrapper_pid:4711,status:'running'};for(const s of spalten)if(!(s in w))w[s]=s==='model'?'fixture':'x';
 const k=Object.keys(w);
 await q('INSERT INTO '+T('wrapper_status')+'('+k.join(',')+',last_activity) VALUES('+k.map((_,i)=>'$'+(i+1)).join(',')+',NOW())',Object.values(w));
}
async function channelMitglied(project,agent,name='c'){
 const c=(await q('INSERT INTO '+T('specialist_channels')+"(name,project,created_by) VALUES($1,$2,'t27pb') ON CONFLICT DO NOTHING RETURNING id",[name+'-'+project,project])).rows[0]
  ??(await q('SELECT id FROM '+T('specialist_channels')+' WHERE name=$1 AND project=$2',[name+'-'+project,project])).rows[0];
 await q('INSERT INTO '+T('specialist_channel_members')+'(channel_id,agent_name,last_read_message_id) VALUES($1,$2,0) ON CONFLICT DO NOTHING',[c.id,agent]);
}
const inbox=async(agent,n)=>{for(let i=0;i<n;i++)await q('INSERT INTO '+T('specialist_inbox')+"(from_agent,to_agent,content) VALUES('koordinator',$1,$2)",[agent,'t27pb '+i]);};
/** Alles, was in PB (bzw. global am Namen X haengt und PB gehoert) liegt — fuer Vorher/Nachher-Vergleich. */
async function standPB(){
 return {
  mitglieder:(await q('SELECT c.name,m.agent_name FROM '+T('specialist_channel_members')+' m JOIN '+T('specialist_channels')+' c ON c.id=m.channel_id WHERE c.project=$1 ORDER BY 1,2',[PB])).rows,
  wrapper:(await q('SELECT agent_name,status,wrapper_pid FROM '+T('wrapper_status')+' WHERE project=$1 ORDER BY 1',[PB])).rows,
  sitzung:(await q('SELECT id,project,status,sitzung_seit,aktiv_seit FROM '+T('agent_sessions')+' WHERE id=$1',[X])).rows,
  inbox:(await q('SELECT id,to_agent,content,processed FROM '+T('specialist_inbox')+' WHERE to_agent=$1 ORDER BY id',[X])).rows,
 };
}
const zaehle=async(sql,args)=>Number((await q(sql,args)).rows[0].n);
const mitgliederIn=(project,agent)=>zaehle('SELECT count(*) n FROM '+T('specialist_channel_members')+' m JOIN '+T('specialist_channels')+' c ON c.id=m.channel_id WHERE c.project=$1 AND m.agent_name=$2',[project,agent]);
const inboxVon=agent=>zaehle('SELECT count(*) n FROM '+T('specialist_inbox')+' WHERE to_agent=$1',[agent]);

try{
 await q('CREATE SCHEMA '+schema);made=true;
 for(const t of TABELLEN)await q('CREATE TABLE '+T(t)+' (LIKE public.'+t+' INCLUDING ALL)');
 await q('INSERT INTO '+T('projects')+'(name,hostname,path,enabled) VALUES($1,$3,$4,true),($2,$3,$5,true)',[PA,PB,HOST,'/tmp/t27pb-a','/tmp/t27pb-b']);
 // X gibt es in beiden Projekten; die (globale) Chat-Sitzung von X gehoert PB. Y gibt es nur in PA.
 for(const p of [PA,PB]){await wrapperZeile(X,p);await channelMitglied(p,X);await channelMitglied(p,X,'zwei');}
 await q('INSERT INTO '+T('agent_sessions')+"(id,project,status,registered_at,sitzung_seit,aktiv_seit) VALUES($1,$2,'active',NOW()-interval '1 hour',NOW()-interval '1 hour',NOW()-interval '1 hour')",[X,PB]);
 await inbox(X,2);
 await wrapperZeile(Y,PA);await channelMitglied(PA,Y);await inbox(Y,3);
 await q('INSERT INTO '+T('agent_sessions')+"(id,project,status) VALUES($1,$2,'active')",[Y,PA]);

 const core=await import('../packages/core/dist/index.js');
 const fastify=createRequire(new URL('../packages/rest-api/package.json',import.meta.url))('fastify');
 const {daemonJobsRoutes}=await import('../packages/rest-api/dist/routes/daemon-jobs.js');
 const {registerAuthHook}=await import('../packages/rest-api/dist/middleware/auth-hook.js');
 auth=await import('../packages/rest-api/dist/services/auth.js');
 const TOK=(await auth.issueServiceToken('daemon:t27pb','t27pb')).token;tokens.push(TOK);
 await q('INSERT INTO '+T('daemon_restore_host_bindings')+'(token_hash,hostname) VALUES($1,$2)',[sha(TOK),HOST]);
 app=fastify({logger:false});registerAuthHook(app);await app.register(daemonJobsRoutes);await app.ready();
 const D='daemon-'+HOST+'-'+process.pid;
 const d=body=>app.inject({method:'POST',url:'/api/daemon/specialist/daten',payload:{host:HOST,daemon_id:D,...body},headers:{authorization:'Bearer '+TOK}});

 const vorher=await standPB();
 assert.equal(vorher.mitglieder.length,2);assert.equal(vorher.wrapper.length,1);assert.equal(vorher.sitzung.length,1);assert.equal(vorher.inbox.length,2);

 // ══════════ API-Weg: Aktionen in PA fuer den gleichnamigen Agenten X ══════════
 await check('API aus_channels in PA: nur PA-Mitgliedschaften weg, PB unveraendert',async()=>{
  assert.equal(await mitgliederIn(PA,X),2);
  const r=await d({aktion:'aus_channels',project:PA,agent:X});assert.equal(r.statusCode,200,r.body);
  assert.equal(r.json().anzahl,2);assert.equal(await mitgliederIn(PA,X),0);assert.equal(await mitgliederIn(PB,X),2);
 });
 await check('API chat_abmelden in PA: Sitzung von X gehoert PB -> anzahl 0, Sitzung bleibt active',async()=>{
  const r=await d({aktion:'chat_abmelden',project:PA,agent:X});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().anzahl,0);
  assert.equal((await q('SELECT status FROM '+T('agent_sessions')+' WHERE id=$1',[X])).rows[0].status,'active');
 });
 await check('API inbox_entfernen in PA: Name auch in PB -> 409 agent_in_anderem_projekt, Inbox unveraendert',async()=>{
  const r=await d({aktion:'inbox_entfernen',project:PA,agent:X});
  assert.equal(r.statusCode,409,r.body);assert.equal(r.json().error,'agent_in_anderem_projekt');assert.deepEqual(r.json().andere_projekte,[PB]);
  assert.equal(await inboxVon(X),2);
 });
 await check('API inbox_post in PA an X: 409, keine neue Zeile',async()=>{
  const r=await d({aktion:'inbox_post',project:PA,from:'koordinator',to:X,content:'nicht zustellen'});
  assert.equal(r.statusCode,409,r.body);assert.equal(r.json().error,'agent_in_anderem_projekt');assert.equal(await inboxVon(X),2);
 });
 await check('API sitzung_neu in PA: Sitzung von X gehoert PB -> 409, Sitzung unveraendert',async()=>{
  const r=await d({aktion:'sitzung_neu',project:PA,agent:X});
  assert.equal(r.statusCode,409,r.body);assert.deepEqual(r.json().andere_projekte,[PB]);
 });
 await check('API wrapper_status_entfernen/wrapper_gestoppt/heartbeat_beim_spawn in PA: PB-Zeile unveraendert',async()=>{
  assert.equal((await d({aktion:'wrapper_gestoppt',project:PA,agent:X,pid:4711})).json().anzahl,1);
  assert.equal((await d({aktion:'heartbeat_beim_spawn',project:PA,agent:X})).statusCode,200);
  assert.equal((await d({aktion:'wrapper_status_entfernen',project:PA,agent:X})).statusCode,200);
  assert.equal(await zaehle('SELECT count(*) n FROM '+T('wrapper_status')+' WHERE agent_name=$1 AND project=$2',[X,PA]),0);
 });
 await check('VORHER/NACHHER: alle PB-Daten zu X nach allen PA-Aktionen identisch',async()=>{
  assert.deepEqual(await standPB(),vorher);
 });

 // ══════════ Positivfall: Y gehoert nur PA -> Aktionen wirken ══════════
 await check('API Y nur in PA: inbox_post 200, inbox_entfernen loescht alle, chat_abmelden 1, sitzung_neu 200, aus_channels 1',async()=>{
  assert.equal((await d({aktion:'sitzung_neu',project:PA,agent:Y})).statusCode,200);
  const p=await d({aktion:'inbox_post',project:PA,from:'koordinator',to:Y,content:'hallo'});assert.equal(p.statusCode,200,p.body);
  assert.equal(await inboxVon(Y),4);
  const e=await d({aktion:'inbox_entfernen',project:PA,agent:Y});assert.equal(e.statusCode,200,e.body);assert.equal(e.json().anzahl,4);
  assert.equal(await inboxVon(Y),0);
  assert.equal((await d({aktion:'chat_abmelden',project:PA,agent:Y})).json().anzahl,1);
  assert.equal((await q('SELECT status FROM '+T('agent_sessions')+' WHERE id=$1',[Y])).rows[0].status,'inactive');
  assert.equal((await d({aktion:'aus_channels',project:PA,agent:Y})).json().anzahl,1);
 });
 await check('VORHER/NACHHER nach Positivfall: PB weiter unveraendert',async()=>{assert.deepEqual(await standPB(),vorher);});

 // ══════════ PG-Weg (mcp-server pgSpezialistenDatenweg, purge-Schritte) ══════════
 const {pgSpezialistenDatenweg:pg}=await import('../packages/mcp-server/dist/tools/spezialisten-datenweg.js');
 await channelMitglied(PA,X);await wrapperZeile(X,PA);
 await check('PG-Weg mit Projekt PA: ausAllenChannels nur PA, chatAbmelden laesst PB-Sitzung, inboxEntfernen wirft ohne zu loeschen',async()=>{
  assert.equal(await pg.ausAllenChannels(X,PA),1);assert.equal(await mitgliederIn(PA,X),0);
  await pg.chatAbmelden(X,PA);
  await assert.rejects(()=>pg.inboxEntfernen(X,PA),/auch in Projekt\(en\) .*t27pb-b-/);
  await pg.wrapperStatusEntfernen(X,PA);
  assert.deepEqual(await standPB(),vorher);
 });
 await check('PG-Weg Positivfall: Y nur in PA -> inboxEntfernen loescht',async()=>{
  await inbox(Y,2);assert.equal(await pg.inboxEntfernen(Y,PA),2);assert.equal(await inboxVon(Y),0);
 });

 // ══════════ Kontrolle: die alte globale Variante haette PB veraendert (Test ist empfindlich) ══════════
 await check('KONTROLLE: altes removeAgentFromAllChannels(X) bzw. PG-Weg ohne Projekt entfernt auch PB-Mitgliedschaften',async()=>{
  assert.equal(await core.removeAgentFromAllChannels(X),2);assert.equal(await mitgliederIn(PB,X),0);
  assert.notDeepEqual(await standPB(),vorher);
 });
 console.log('RESULT P9_T27_PROJEKTBINDUNG '+count+'/'+count+' PASS; schema='+schema);
}finally{
 if(app)await app.close().catch(()=>{});
 if(auth)for(const t of tokens)await auth.revokeToken(t).catch(()=>{});
 if(made)await admin.query('DROP SCHEMA '+schema+' CASCADE').catch(e=>console.error('DROP SCHEMA',e.message));
 await admin.end();
}
process.exit(0);
