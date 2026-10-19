/**
 * P22-T15/S4: echte DB-Verträge in eigenem Schema auf synapse_test:5433.
 * node packages/core/tests/agent-kommunikation-p22-t15-s4.test.mjs [--basis-rot]
 * P22_BASE_ROOT=/tmp/synapse-basis-89d1c7a7. Keine Modell-/Netzwerkaufrufe.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const url=new URL(process.env.DATABASE_URL ?? 'http://invalid');
assert.equal(url.port,'5433'); assert.equal(url.pathname,'/synapse_test');
const schema='p22_s4_'+process.pid+'_'+randomUUID().slice(0,8), project='p22-s4-'+randomUUID(), foreign=project+'-foreign';
url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.href;
process.env.SYNAPSE_SHELL_JOB='1';process.env.SYNAPSE_SKIP_EMBEDDINGS='1';process.env.PARSER_LOOP_DISABLED='1';process.env.SYNAPSE_ONBOARDING_RUHE_MIN='0';
delete process.env.SYNAPSE_DATABASE_URL;
delete process.env.SYNAPSE_INTERN_TOOL;
delete process.env.SYNAPSE_TOKEN_IDENTITAET;
process.env.SYNAPSE_AGENT_BEZUG_MODUS='alt';
process.env.QDRANT_URL='http://127.0.0.1:9'; process.env.OLLAMA_URL='http://127.0.0.1:9';
let network=0; globalThis.fetch=async()=>{network++;throw Error('S4 verbietet Netz/Modellaufrufe');};
const require=createRequire(new URL('../package.json',import.meta.url)),{Pool}=require('pg');
const root=process.env.P22_BASE_ROOT ?? '/tmp/synapse-basis-89d1c7a7';
const DB=await import('../dist/db/client.js'), BDB=await import(pathToFileURL(join(root,'packages/core/dist/db/client.js')));
const load=n=>import(new URL('../dist/services/'+n+'.js',import.meta.url));
const base=n=>import(pathToFileURL(join(root,'packages/core/dist/services/'+n+'.js')));
// Öffentlichen Einstieg zuerst initialisieren; parallele Deep-Imports erzeugen künstliche ESM-TDZ-Zyklen.
await import('../dist/index.js');
const modules=[];
for(const n of ['chat','inbox','channels','channel-unread','chat-unread','events','project-status','hinweis-drossel','ausloeser-hinweise','skill-hook','fehlermuster-auslieferung','project-record-ids','agent-bezug','agent-identitaet-sitzungen']) modules.push(await load(n));
const [Chat,Inbox,Ch,Read,Unread,Ev,On,H,Trigger,Skill,Pattern,Lookup,Bezug,Sitz]=modules;
const {AGENT_IDENTITAET_SCHEMA_SQL:s111}=await import('../dist/db/agent-identitaet-schema.js');
const {AGENT_BEZUG_SCHEMA_SQL:s112}=await import('../dist/db/agent-bezug-schema.js');
const {AGENT_PROFIL_SCHEMA_SQL:s113}=await import('../dist/db/agent-profil-schema.js');
const {AGENT_AUSWEIS_SCHEMA_SQL:s114}=await import('../dist/db/agent-ausweis-schema.js');
const {AGENT_AUSWEIS_NR_SCHEMA_SQL:s115}=await import('../dist/db/agent-ausweis-nr-schema.js');
const sql111=await readFile(new URL('../src/db/schema-sql/111_agent_identitaet.sql',import.meta.url),'utf8');
const sql112=await readFile(new URL('../src/db/schema-sql/112_agent_bezug.sql',import.meta.url),'utf8');
assert.equal(s111.trim(),sql111.trim());assert.equal(s112.trim(),sql112.trim());
const raw=new Pool({connectionString:process.env.DATABASE_URL,max:16});
const pool={
 async connect(){const c=await raw.connect();try{await c.query('SET search_path TO '+schema+',public');return c;}catch(e){c.release();throw e;}},
 async query(...a){const c=await this.connect();try{return await c.query(...a);}finally{c.release();}}
};
const q=(s,a=[])=>pool.query(s,a), names=rs=>rs.map(r=>r.content);
let checks=0,failed=0;
const group=async(name,fn)=>{try{await fn();console.log('PASS '+(++checks)+' '+name);}catch(e){failed++;console.error('FAIL '+name+' '+(e.code ?? e.name)+': '+e.message+' '+String(e.stack).split('\n').slice(1,3).join(' '));}};
const principal=(id,name,role='subagent',p=project)=>({art:'identity',project:p,identity_id:id,agent_id:name,rolle:role,modell:null,context_epoch:1,lauf_id:null});
const alias='s4-twin', a=principal(randomUUID(),alias), b=principal(randomUUID(),alias+'#2'), c=principal(randomUUID(),'s4-coord','koordinator');
const legacy={art:'legacy',project,agent_id:alias}, target=x=>'identity:'+x.identity_id;
const testModus=process.env.P22_S4_MODE ?? 'beide';
assert(['beide','neu'].includes(testModus));
const run=(p,fn,modus=testModus)=>DB.mitLesePool(pool,()=>Bezug.mitAgentAufrufKontext({principal:p,bezug:{modus,standard:modus,quelle:'standard',bis:null,letzter_fehler:null}},fn));
const row=async(s,v=[]) => (await q(s,v)).rows[0];
let stop;const close=[];
try {
 await raw.query('CREATE SCHEMA '+schema);
 // Vollständige leere Legacy-Tabellenformen, keine produktiven/synthetischen Bestandszeilen kopieren.
 const tables=(await raw.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(x=>x.tablename);
 const owned=new Set([...sql111.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g),...sql112.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map(m=>m[1]));
 const required=new Set([...tables,...[...sql112.matchAll(/(?:LIKE|ALTER TABLE|REFERENCES) ([a-z_]+)/g)].map(m=>m[1])].filter(n=>!owned.has(n)));
 for(const t of ['agent_sessions','chat_messages','chat_lesestand','specialist_channels','specialist_channel_members','specialist_channel_messages','specialist_inbox','channel_sichtung','agent_events','agent_event_acks','hinweis_gesehen','hinweis_optionen','ausloeser_hinweis_profile','ausloeser_hinweis_aufrufe','ausloeser_hinweis_zustellungen','ausloeser_hinweis_metriken','skill_hook_deliveries','skill_hook_preparations','skill_hook_metrics','error_patterns','error_pattern_seen','agent_onboardings','skill_names']) required.add(t);
 for(const t of required) {
  assert(/^[a-z_][a-z0-9_]*$/.test(t));
  if(!tables.includes(t)) {await q('CREATE TABLE '+t+'(id TEXT PRIMARY KEY)');continue;}
  await q('CREATE TABLE '+t+' (LIKE public.'+t+' INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)');
 }
 // Keine gemeinsam genutzten public-Sequenzen: jeder Test-Surrogatschlüssel gehört diesem Schema.
 const defaults=(await q("SELECT table_name,column_name,column_default FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%'",[schema])).rows;
 for(const [i,d] of defaults.entries()){
  const seq='s4_seq_'+i;await q('CREATE SEQUENCE '+seq);
  await q('ALTER TABLE '+d.table_name+' ALTER COLUMN '+d.column_name+" SET DEFAULT nextval('"+schema+'.'+seq+"'::regclass)");
 }
 await q(sql111);await q(sql112);await q(sql111);await q(sql112);
 await q(s113);await q(s114);await q(s115); // P22-T31 R2: Profil- (113) und Ausweis-Spalten (114) fuer agent_vorbereiten/anmelden
 console.log('PASS Schema111+112 je zweimal, SQL/TS-Spiegel gleich, Scope='+schema);
 if(process.argv.includes('--basis-rot')){
  await q('INSERT INTO agent_identitaeten(id,project,name,agent_id,erstellt_von) VALUES($1,$2,$3,$3,$4)',[a.identity_id,project,alias,'test']);
  await q("INSERT INTO chat_messages(project,sender_id,recipient_id,recipient_identity_id,content) VALUES($1,'sender',$2,$3,'private-id-dm')",[project,alias,a.identity_id]);
  const old=await base('chat');
  const leaked=await BDB.mitLesePool(pool,()=>old.getMessages(project,{agentId:alias}));
  assert.equal(leaked.length,0,'POSITIVKONTROLLE: alter Namensleser darf keine gleichnamige ID-DM adoptieren');
  throw Error('Rotkontrolle unerwartet grün');
 }
 await group('alt Golden: Chat/Inbox/Channels/Events/Hinweise exakt t107',async()=>{
  const modules=['chat','inbox','channels','channel-unread','chat-unread','events','project-status','hinweis-drossel'];
  const baseline=await Promise.all(modules.map(base));
  const current=[Chat,Inbox,Ch,Read,Unread,Ev,On,H];
  async function capture(ms,db){
   await q('TRUNCATE chat_messages,chat_lesestand,specialist_inbox,specialist_channel_members,specialist_channel_messages,specialist_channels,agent_event_acks,agent_events,hinweis_gesehen CASCADE');
   await q("DELETE FROM agent_sessions WHERE id='s4-golden'");
   await q("INSERT INTO agent_sessions(id,project,status,registered_at,sitzung_seit,aktiv_seit) VALUES('s4-golden',$1,'active','2020-01-01','2020-01-01','2020-01-01')",[project]);
   await q("INSERT INTO chat_messages(id,project,sender_id,recipient_id,content,timestamp) VALUES(101,$1,'sender',NULL,'broadcast','2025-01-01'),(102,$1,'sender','s4-golden','dm','2025-01-01'),(103,$1,'sender','other','private','2025-01-01')",[project]);
   await q("INSERT INTO chat_lesestand(project,agent_id,letzte_id) VALUES($1,'s4-golden',0)",[project]);
   await q("INSERT INTO specialist_inbox(id,project,from_agent,to_agent,content,created_at) VALUES(201,$1,'sender','s4-golden','inbox','2025-01-01')",[project]);
   await q("INSERT INTO specialist_channels(id,name,project,created_by) VALUES(301,'golden',$1,'sender')",[project]);
   await q("INSERT INTO specialist_channel_members(channel_id,agent_name,last_read_message_id,last_notified_message_id) VALUES(301,'s4-golden',0,0)");
   await q("INSERT INTO specialist_channel_messages(id,channel_id,sender,content,created_at) VALUES(401,301,'sender','post','2025-01-01')");
   await q("INSERT INTO agent_events(id,project,event_type,priority,scope,source_id,payload,requires_ack,created_at) VALUES(501,$1,'ANNOUNCEMENT','normal','agent:s4-golden','sender','golden',true,'2025-01-01')",[project]);
   return db.mitLesePool(pool,async()=>({
    chatHint:await ms[4].getUnreadChatHint(project,'s4-golden'),
    messages:await ms[0].getMessages(project,{agentId:'s4-golden'}),
    inbox:await ms[1].checkInbox('s4-golden',project),
    channel:await ms[2].getChannelMessages(project,'golden'),
    members:await ms[2].getChannelMembers(project,'golden'),
    unread:await ms[3].claimUnreadChannelHints('s4-golden'),
    participants:await ms[6].holeChannelTeilnehmer(project,'golden'),
    events:await ms[5].getPendingEvents(project,'s4-golden'),
    claim:await ms[7].claimHinweis({project,agentId:'s4-golden',art:'golden',fingerprint:'same',jetzt:1700000000000}),
    cursor:(await q("SELECT letzte_id,letzte_hinweis_id FROM chat_lesestand WHERE agent_id='s4-golden'")).rows,
   }));
  }
  const expected=await capture(baseline,BDB);
  const actual=await run(legacy,()=>capture(current,DB),'alt');
  assert.deepEqual(JSON.parse(JSON.stringify(actual)),JSON.parse(JSON.stringify(expected)));
 });
 // Feste Golden-IDs dürfen spätere echte Serial-Nachrichten nicht überholen.
 for(const [i,d] of defaults.entries()) if(d.column_name==='id') await q("SELECT setval('"+schema+'.s4_seq_'+i+"',GREATEST(COALESCE((SELECT MAX(id) FROM "+d.table_name+"),0),1000),true)");
 for(const [i,p] of [a,b,c].entries()){
  await q('INSERT INTO agent_identitaeten(id,project,name,instanz_nr,agent_id,rolle,erstellt_von,context_epoch) VALUES($1,$2,$3,$4,$5,$6,$7,1)',[p.identity_id,project,i<2?alias:p.agent_id,i<2?i+1:1,p.agent_id,p.rolle,'s4-test']);
  await q("INSERT INTO agent_identitaet_sitzungen(identity_id,project,agent_id,status,context_epoch,registered_at,sitzung_seit,aktiv_seit) VALUES($1,$2,$3,'active',1,'2020-01-01','2020-01-01','2020-01-01')",[p.identity_id,project,p.agent_id]);
 }
 await q("INSERT INTO agent_sessions(id,project,status,registered_at,sitzung_seit,aktiv_seit) VALUES($1,$2,'active','2020-01-01','2020-01-01','2020-01-01')",[alias,project]);
 await group('Chat beide/neu: gleichnamige Empfänger, Broadcast, GREATEST/Claim, ID-Lookup',async()=>{
  await run(a,()=>Unread.initialisiereChatLesestand(project,a.agent_id));
  await run(b,()=>Unread.initialisiereChatLesestand(project,b.agent_id));
  const dm=await run(c,()=>Chat.sendMessage(project,c.agent_id,'token-a',target(a)));
  const legacyDm=await run(c,()=>Chat.sendMessage(project,c.agent_id,'legacy',alias));
  const broad=await run(c,()=>Chat.sendMessage(project,c.agent_id,'public'));
  const aHint=await run(a,()=>Unread.getUnreadChatHint(project,a.agent_id));
  assert.equal(aHint.broadcasts,1);assert.equal(aHint.dms.reduce((n,d)=>n+d.count,0),1);
  assert.equal(await run(a,()=>Unread.getUnreadChatHint(project,a.agent_id)),null);
  assert((await run(a,()=>Chat.getMessages(project,{agentId:a.agent_id}))).some(m=>m.id===dm.id));
  assert(!(await run(b,()=>Chat.getMessages(project,{agentId:b.agent_id}))).some(m=>m.id===dm.id));
  assert((await run(legacy,()=>Chat.getMessages(project,{agentId:alias}))).some(m=>m.id===legacyDm.id));
  assert(!(await run(legacy,()=>Chat.getMessages(project,{agentId:alias}))).some(m=>m.id===dm.id));
  assert((await run(b,()=>Chat.getMessages(project,{agentId:b.agent_id}),'neu')).some(m=>m.id===broad.id));
  assert.equal((await run(a,()=>Lookup.getProjectRecordById('chat_message',project,dm.id,a.agent_id))).content,'token-a');
  assert.equal(await run(b,()=>Lookup.getProjectRecordById('chat_message',project,dm.id,b.agent_id)),null);
  const before=await row('SELECT letzte_id FROM agent_identitaet_chat_lesestand WHERE identity_id=$1',[a.identity_id]);
  await run(a,()=>Chat.getMessages(project,{agentId:a.agent_id,messageId:dm.id}));
  assert.equal((await row('SELECT letzte_id FROM agent_identitaet_chat_lesestand WHERE identity_id=$1',[a.identity_id])).letzte_id,before.letzte_id);
  await assert.rejects(()=>run(a,()=>Chat.sendMessage(foreign,a.agent_id,'bad',target(b))));
 });
 await group('Inbox alle Leser/Process/Purge und beide->alt->neu ohne Namensadoption',async()=>{
  await run(c,()=>Inbox.postToInbox(c.agent_id,target(a),'id-only',project));
  await run(c,()=>Inbox.postToInbox(c.agent_id,alias,'legacy-only',project));
  assert.deepEqual(names(await run(a,()=>Inbox.getNewInboxMessages(a.agent_id,0,project))),['id-only']);
  assert.deepEqual(names(await run(b,()=>Inbox.getInboxHistory(b.agent_id,project))),[]);
  assert.deepEqual(names(await run(legacy,()=>Inbox.checkInbox(alias,project),'alt')),['legacy-only']);
  assert.equal((await run(legacy,()=>Inbox.getInboxHistory(alias,project),'alt')).some(m=>m.content==='id-only'),false);
  assert.equal((await run(legacy,()=>Chat.getMessages(project,{agentId:alias}),'alt')).some(m=>m.content==='token-a'),false);
  assert.deepEqual(names(await run(a,()=>Inbox.checkInbox(a.agent_id,project),'neu')),['id-only']);
  assert.deepEqual(await run(a,()=>Inbox.checkInbox(a.agent_id,project)),[]);
  await run(c,()=>Inbox.postToInbox(c.agent_id,target(b),'keep-b',project));
  await run(a,()=>Inbox.removeInboxForAgent(a.agent_id,project));
  assert.deepEqual(names(await run(b,()=>Inbox.getInboxHistory(b.agent_id,project))),['keep-b']);
  await assert.rejects(()=>run(c,()=>Inbox.postToInbox(c.agent_id,target(b),'bad',foreign)));
 });
 let channel;
 await group('Channels: drei Mitgliedschaften, Baseline/Read/Claims, Attribution ohne Modellaufruf',async()=>{
  channel=await run(c,()=>Ch.createChannel(project,'s4-channel','own',c.agent_id));
  // Leerer Channel beim Beitritt: keine historischen Skills zu berechnen.
  for(const p of [legacy,a,b])assert.equal(await run(p,()=>Ch.joinChannel(project,'s4-channel',p.agent_id)),true);
  const post=await row("INSERT INTO specialist_channel_messages(channel_id,sender,sender_identity_id,content) VALUES($1,$2,$3,'a-post') RETURNING id",[channel.id,a.agent_id,a.identity_id]);
  const members=await run(a,()=>Ch.getChannelMembers(project,'s4-channel'));
  assert.equal(members.length,3);assert(members.includes(target(a)));assert(members.includes(alias));
  const participants=await run(a,()=>On.holeChannelTeilnehmer(project,'s4-channel'));
  assert.equal(participants.length,3);assert.equal(participants.filter(x=>x.agent===alias).length,2);
  const ah=await run(a,()=>Read.claimUnreadChannelHints(a.agent_id));assert(!ah.some(h=>h.channel==='s4-channel'));
  const lh=await run(legacy,()=>Read.claimUnreadChannelHints(alias));assert(lh.some(h=>h.channel==='s4-channel'));
  const claims=await run(b,()=>Promise.all(Array.from({length:5},()=>Read.claimUnreadChannelHints(b.agent_id))));
  assert.equal(claims.filter(h=>h.some(x=>x.channel==='s4-channel')).length,1);
  await run(b,()=>Read.recordChannelRead(project,'s4-channel',b.agent_id,[post.id]));
  const idcursor=await row('SELECT last_read_message_id FROM agent_identitaet_channel_mitglieder WHERE channel_id=$1 AND identity_id=$2',[channel.id,b.identity_id]);
  await run(b,()=>Read.recordChannelRead(project,'s4-channel',b.agent_id,[0]));
  assert.equal((await row('SELECT last_read_message_id FROM agent_identitaet_channel_mitglieder WHERE channel_id=$1 AND identity_id=$2',[channel.id,b.identity_id])).last_read_message_id,idcursor.last_read_message_id);
  assert.equal(await run(legacy,()=>Read.markChannelRead(project,'s4-channel',alias)),1);
  for(const p of [legacy,a,b])await run(p,()=>Ch.leaveChannel(project,'s4-channel',p.agent_id));
  const sent=await run(a,()=>Ch.postChannelMessage(project,'s4-channel',a.agent_id,'attributed'));
  assert.equal((await row('SELECT sender_identity_id FROM specialist_channel_messages WHERE id=$1',[sent.id])).sender_identity_id,a.identity_id);
 });
 await group('Sichtung/Archiv/Purge trennen Subjekt und Reviewer',async()=>{
  await q("INSERT INTO specialist_channel_messages(channel_id,sender,content) VALUES($1,$2,'legacy-post')",[channel.id,alias]);
  await run(c,()=>Ch.setzeSichtung({project,channel:'s4-channel',agent:target(a),status:'nichts_verwertbares',gesichtetVon:c.agent_id}));
  await run(c,()=>Ch.setzeSichtung({project,channel:'s4-channel',agent:alias,status:'nichts_verwertbares',gesichtetVon:c.agent_id}));
  const state=await run(c,()=>Ch.holeSichtungsstand(project,'s4-channel'));
  assert.equal(state.filter(s=>s.agent===alias).length,2);assert(state.every(s=>s.status==='nichts_verwertbares'));
  assert.equal((await row('SELECT reviewer_identity_id FROM agent_identitaet_channel_sichtung WHERE identity_id=$1',[a.identity_id])).reviewer_identity_id,c.identity_id);
  assert.equal((await row('SELECT reviewer_identity_id FROM channel_sichtung WHERE project=$1 AND agent=$2',[project,alias])).reviewer_identity_id,c.identity_id);
  const archived=await run(c,()=>Ch.archiviereChannel(project,'s4-channel'));
  assert(archived.ok);assert.equal((await row('SELECT channel FROM agent_identitaet_channel_sichtung WHERE identity_id=$1',[a.identity_id])).channel,archived.archivname);
  // Purge-Bindungen direkt ohne historische Skill-Nachbereitung vorbereiten.
  await q('INSERT INTO specialist_channel_members(channel_id,agent_name) VALUES($1,$2)',[channel.id,alias]);
  await q('INSERT INTO agent_identitaet_channel_mitglieder(channel_id,agent_name,identity_id) VALUES($1,$2,$3),($1,$4,$5)',[channel.id,alias,a.identity_id,b.agent_id,b.identity_id]);
  assert.equal(await run(c,()=>Ch.removeAgentFromAllChannels(target(a),project)),1);
  assert.equal((await row('SELECT count(*)::int n FROM specialist_channel_members WHERE agent_name=$1',[alias])).n,1);
  assert.equal((await row('SELECT count(*)::int n FROM agent_identitaet_channel_mitglieder WHERE identity_id=$1',[b.identity_id])).n,1);
 });
 let acked;
 await group('Events: Scope/Dedupe/Pending/COUNT/ACK/Einzel-ID und Vertretung',async()=>{
  const e=await run(c,()=>Ev.emitEvent(project,'ANNOUNCEMENT','high',target(a),c.agent_id,'test',true));
  const broadcast=await run(c,()=>Ev.emitEvent(project,'ANNOUNCEMENT','normal','all',c.agent_id));
  assert((await run(a,()=>Ev.getPendingEvents(project,a.agent_id))).some(x=>x.id===e.id));
  assert(!(await run(legacy,()=>Ev.getPendingEvents(project,alias))).some(x=>x.id===e.id));
  assert.equal(await run(b,()=>Lookup.getProjectRecordById('event',project,e.id,b.agent_id)),null);
  assert.equal((await run(a,()=>Lookup.getProjectRecordById('event',project,e.id,a.agent_id))).id,e.id);
  await assert.rejects(()=>run(b,()=>Ev.acknowledgeEvent(e.id,b.agent_id)));
  await assert.rejects(()=>run(b,()=>Ev.acknowledgeEvent(e.id,b.agent_id,'not allowed')));
  const before=await run(a,()=>Ev.getUnackedCount(project,a.agent_id));
  await run(a,()=>Ev.acknowledgeEvent(e.id,a.agent_id,'done'));acked=e.id;
  assert.equal(await run(a,()=>Ev.getUnackedCount(project,a.agent_id)),before-1);
  await run(a,()=>Ev.acknowledgeEvent(broadcast.id,a.agent_id));
  assert((await run(legacy,()=>Ev.getPendingEvents(project,alias))).some(x=>x.id===broadcast.id));
  const directLegacy=await run(c,()=>Ev.emitEvent(project,'ANNOUNCEMENT','normal','agent:'+alias,c.agent_id));
  await assert.rejects(()=>run(a,()=>Ev.acknowledgeEvent(directLegacy.id,a.agent_id)));
  await run(c,()=>Ev.acknowledgeEvent(directLegacy.id,c.agent_id,'coordinator'));
  assert.equal((await row('SELECT actor_identity_id FROM agent_event_acks WHERE event_id=$1 AND agent_id=$2',[directLegacy.id,alias])).actor_identity_id,c.identity_id);
  const delegated=await run(c,()=>Ev.emitEvent(project,'ANNOUNCEMENT','normal',target(a),c.agent_id));
  await run(c,()=>Ev.acknowledgeEvent(delegated.id,c.agent_id,'coordinator'));
  const ack=await row('SELECT identity_id,actor_identity_id FROM agent_identitaet_event_acks WHERE event_id=$1',[delegated.id]);
  assert.equal(ack.identity_id,a.identity_id);assert.equal(ack.actor_identity_id,c.identity_id);
  const inactive=await run(c,()=>Ev.emitEvent(project,'ANNOUNCEMENT','normal',target(a),c.agent_id));
  await q("UPDATE agent_identitaet_sitzungen SET status='inactive' WHERE identity_id=$1",[a.identity_id]);
  try {
   await assert.rejects(()=>run(b,()=>Ev.acknowledgeEvent(inactive.id,b.agent_id)));
   await run(b,()=>Ev.acknowledgeEvent(inactive.id,b.agent_id,'inactive target handover'));
   const delegatedAck=await row('SELECT identity_id,actor_identity_id,reaction FROM agent_identitaet_event_acks WHERE event_id=$1',[inactive.id]);
   assert.equal(delegatedAck.identity_id,a.identity_id);assert.equal(delegatedAck.actor_identity_id,b.identity_id);
   assert(delegatedAck.reaction.includes('inactive target handover'));
   assert(!(await run(a,()=>Ev.getPendingEvents(project,a.agent_id))).some(x=>x.id===inactive.id));
   assert.equal((await row('SELECT count(*)::int n FROM agent_event_acks WHERE event_id=$1',[inactive.id])).n,0,'kein gleichnamiger Legacy-ACK');
  } finally {await q("UPDATE agent_identitaet_sitzungen SET status='active' WHERE identity_id=$1",[a.identity_id]);}
  const wrong=await row("INSERT INTO agent_events(project,event_type,priority,scope,source_id) VALUES($1,'ANNOUNCEMENT','normal','all','sender') RETURNING id",[foreign]);
  await assert.rejects(()=>run(a,()=>Ev.acknowledgeEvent(wrong.id,a.agent_id)));
  const client=await pool.connect();
  try{await client.query('BEGIN');const args={project,eventType:'ANNOUNCEMENT',priority:'normal',scope:target(a),sourceId:c.agent_id,dedupeKey:'same'};
   assert(await run(c,()=>Ev.emitEventOnce(args,client)));
   assert.equal(await run(c,()=>Ev.emitEventOnce(args,client)),null);
   assert(await run(c,()=>Ev.emitEventOnce({...args,scope:target(b)},client)));await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 });
 await group('Onboarding: ID-Claim/Refresh ohne Legacy-Sitzungsanlage oder Namenadoption',async()=>{
  await q('DELETE FROM agent_onboardings WHERE project=$1 AND agent_id=$2',[project,alias]);
  const answer=await run(a,()=>Promise.all(Array.from({length:5},()=>On.registerAgent(project,a.agent_id,'s4-instance','subagent','angegeben'))));
  assert.equal(answer.filter(Boolean).length,1);
  assert.equal(await run(b,()=>On.istOnboardingBekannt(project,b.agent_id)),false);
  assert.equal(await run(legacy,()=>On.istOnboardingBekannt(project,alias)),false);
  assert.equal(await run(a,()=>On.registerAgent(project,a.agent_id,'s4-instance','subagent','angegeben',true)),true);
  assert.equal((await row('SELECT count(*)::int n FROM agent_sessions WHERE id=$1',[b.agent_id])).n,0);
  assert.equal(await run(a,()=>On.vergissOnboarding(project,a.agent_id)),1);
  assert.equal(await run(a,()=>On.istOnboardingBekannt(project,a.agent_id)),false);
 });
 await group('Hinweisclaims/Triggerprofile: gleicher Name getrennt, Session erneuert nur Hinweise',async()=>{
  const claim=p=>run(p,()=>H.claimHinweis({project,agentId:p.agent_id,art:'s4',fingerprint:'same'}));
  const raced=await Promise.all(Array.from({length:5},()=>claim(a)));assert.equal(raced.filter(Boolean).length,1);
  assert.equal(await claim(legacy),true);assert.equal(await claim(b),true);
  const rawResult={success:true};const args={project,action:'read',file_path:'fixture.ts'};
  stop=Trigger.registriereHinweisQuelle({quelle_id:'s4-source',pruefe:()=>[{hinweis_id:'same',modus:'einmal_je_sitzung',text:'own hint'}]});
  const call=p=>run(p,()=>Trigger.haengeAusloeserHinweiseAn(rawResult,'files',args,p.agent_id,{pool,zeitbudgetMs:3000}));
  assert.deepEqual((await call(a)).ausloeser_hinweise,['own hint']);assert.equal(await call(a),rawResult);
  assert.deepEqual((await call(legacy)).ausloeser_hinweise,['own hint']);
  await run(c,()=>Trigger.fuehreHinweisprofilAdminAus('kontextprofil_setzen',{project,ziel:target(b),hinweise_aus:['s4-source']},c.agent_id,pool));
  assert.equal(await call(b),rawResult);
  await run(a,()=>Sitz.beginneIdentitaetsSitzung({identitaet:{id:a.identity_id},project,agent_id:a.agent_id,modell:null,context_epoch:2,lauf_id:null}));
  a.context_epoch=2;assert.equal(await claim(a),true);
  assert.deepEqual((await call(a)).ausloeser_hinweise,['own hint']);stop();stop=null;
  assert.equal((await row('SELECT count(*)::int n FROM agent_identitaet_event_acks WHERE event_id=$1 AND identity_id=$2',[acked,a.identity_id])).n,1);
 });
 await group('Skill-Dedup: ID/Legacy und neue Epoch, monotone alte Requests',async()=>{
  // Hier wird die DB-Dedup-Semantik geprüft. Die produktive Lastfrist (30ms)
  // ist kein LAN-Integrationsbudget; Verbindung vorher holen, nur Queryfrist anheben.
  const lang=async p=>{
   const client=await pool.connect();
   const semanticPool={query:(...args)=>pool.query(...args),connect:async()=>({
    query:arg=>client.query(typeof arg==='object'?{...arg,query_timeout:3000}:arg),release:()=>{},
   })};
   try{return await run(p,()=>Skill.holeSprachSkillVorschlaege(p.agent_id,['fixture.ts'],semanticPool));}
   finally{client.release();}
  };
  assert.equal((await lang(a)).suggestions.length,1);assert.equal((await lang(a)).suggestions.length,0);
  assert.equal((await lang(legacy)).suggestions.length,1);assert.equal((await lang(b)).suggestions.length,1);
  a.context_epoch=3;
  assert.equal((await lang(a)).suggestions.length,1);
  const previous={...a,context_epoch:2};assert.equal((await lang(previous)).suggestions.length,0);
  assert.equal((await row("SELECT context_epoch FROM agent_identitaet_skill_deliveries WHERE identity_id=$1 AND skill_name='typescript-advanced-types'",[a.identity_id])).context_epoch,3);
  await q("INSERT INTO agent_identitaet_skill_preparations(source_type,source_id,identity_id,agent_id,skill_name,score,reason) VALUES('task','s4',$1,$2,'synthetic-private',1,'test')",[a.identity_id,a.agent_id]);
  assert((await run(a,()=>Skill.holeOffeneSkillVorschlaege(a.agent_id,pool))).suggestions.some(s=>s.skill_name==='synthetic-private'));
  assert(!(await run(b,()=>Skill.holeOffeneSkillVorschlaege(b.agent_id,pool))).suggestions.some(s=>s.skill_name==='synthetic-private'));
 });
 await group('Fehlermuster/Queue-Empfänger: persistente seen-IDs und explizites Legacy-null',async()=>{
  Pattern._fehlermusterAuslieferungZuruecksetzen();
  const id=randomUUID();await q("INSERT INTO error_patterns(id,description,fix,severity,model_scope,found_by,found_in_model) VALUES($1,'synthetic','fix','warning','all','s4','none')",[id]);
  await run(a,()=>Pattern.verfolgeFehlermusterPruefung(a.agent_id,'fixture.ts',Promise.resolve([{id,severity:'warning',description:'synthetic',fix:'fix'}])));
  assert.equal(await run(legacy,()=>Pattern.holeFehlermusterHinweise(alias)),null);
  assert.equal((await run(a,()=>Pattern.holeFehlermusterHinweise(a.agent_id))).anzahl,1);
  assert.equal((await row('SELECT count(*)::int n FROM agent_identitaet_error_pattern_seen WHERE identity_id=$1',[a.identity_id])).n,1);
  assert.equal((await row('SELECT count(*)::int n FROM error_pattern_seen WHERE session_id=$1',[alias])).n,0);
  Pattern._fehlermusterAuslieferungZuruecksetzen();
  const note={pattern_id:'queue',severity:'info',datei:'queue.ts',was:'synthetic',wie:'fix',quelle:'erklaerung'};
  // Persistierter Queuejob läuft absichtlich ohne Principal.
  Pattern.vormerkenErklaerung(alias,'queue.ts',note,a.identity_id);
  assert.equal(await run(legacy,()=>Pattern.holeFehlermusterHinweise(alias)),null,'Legacy darf ID-Queuehinweis nicht abholen');
  assert.equal((await run(a,()=>Pattern.holeFehlermusterHinweise(alias))).anzahl,1);
  await run(a,()=>Pattern.vormerkenErklaerung(alias,'queue.ts',note,null));
  assert.equal(await run(a,()=>Pattern.holeFehlermusterHinweise(alias)),null);
  assert.equal((await run(legacy,()=>Pattern.holeFehlermusterHinweise(alias))).anzahl,1);
 });

 await group('REST / + /mcp/messages + stdio: bezeugte Kommunikation, Login und Moduswechsel',async()=>{
  process.env.SYNAPSE_TOKEN_IDENTITAET='1';process.env.SYNAPSE_AGENT_BEZUG_MODUS='beide';
  const fastify=(await import('../../rest-api/node_modules/fastify/fastify.js')).default;
  const {mcpRoutes}=await import('../../rest-api/dist/routes/mcp.js');
  const app=fastify({logger:false});await app.register(mcpRoutes);await app.ready();close.push(()=>app.close());
  const {InMemoryTransport}=await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js');
  const {Client}=await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const {createServer}=await import('../../mcp-server/dist/server.js');
  const server=createServer(),client=new Client({name:'s4-e2e',version:'1'});
  const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
  close.push(()=>client.close());
  const unwrap=r=>r.structuredContent ?? JSON.parse(r.content.find(c=>c.type==='text').text);
  let seq=0;
  const http=path=>async(name,args)=>{
   const response=await app.inject({method:'POST',url:path,payload:{jsonrpc:'2.0',id:++seq,method:'tools/call',params:{name,arguments:args}}});
   assert.equal(response.statusCode,200);const body=response.json();assert(body.result,'HTTP liefert Toolergebnis');return unwrap(body.result);
  };
  const h=http('/'),h2=http('/mcp/messages'),s=async(name,args)=>unwrap(await client.callTool({name,arguments:args}));
  // P22-T31 R2: register ohne token stellt keinen Ausweis aus (Weg A: nur Legacy + Schatten). Ausweise kommen ueber agent_vorbereiten (Legacy-Koordinator) + chat(anmelden, token).
  process.env.SYNAPSE_AGENTEN_AUSWEIS='1';
  const vorbereitet=async(call,name)=>{
   const v=await call('admin',{action:'agent_vorbereiten',project,agent_name:name,grund:'S4 Transport-Fixture',agent_id:'koordinator'});
   assert(v.success,'agent_vorbereiten '+name+': '+JSON.stringify(v.error??v));
   const l=await call('chat',{action:'anmelden',token:v.token,project});
   return {...l,token:v.token};
  };
  const first=await vorbereitet(h,'s4-transport-a');
  const second=await vorbereitet(s,'s4-transport-b');
  assert(first.success,'HTTP-Registrierung');assert(second.success,'stdio-Registrierung');
  const aid=first.principal.identity_id,bid=second.principal.identity_id;
  const aname=first.principal.agent_id,bname=second.principal.agent_id;
  assert.notEqual(aid,bid);assert.equal((await row('SELECT count(*)::int n FROM agent_sessions WHERE id=ANY($1)',[[aname,bname]])).n,0);
  // Gleichnamiger Legacy-Bestand ist eine getrennte Testidentität.
  await q("INSERT INTO agent_sessions(id,project,status) VALUES($1,$2,'active')",[aname,project]);
  const dm=await h('chat',{action:'send',token:first.token,project,sender_id:'forged',recipient_id:'identity:'+bid,content:'e2e-id-dm'});
  assert(dm.id,'HTTP-ID-DM');
  const sent=await row('SELECT sender_identity_id,recipient_identity_id,sender_id FROM chat_messages WHERE id=$1',[dm.id]);
  assert.equal(sent.sender_identity_id,aid);assert.equal(sent.recipient_identity_id,bid);assert.equal(sent.sender_id,aname);
  const received=await s('chat',{action:'get',token:second.token,project});
  assert(received.messages.some(m=>m.id===dm.id),'stdio liest HTTP-ID-DM');
  const legacyRead=await h2('chat',{action:'get',project,agent_id:aname});
  assert(!legacyRead.messages.some(m=>m.id===dm.id),'gleichnamiger Legacy-Agent liest fremde ID-DM nicht');
  const lookup=await h2('chat',{action:'get',token:second.token,project,message_id:dm.id});
  assert.equal(lookup.messages[0].id,dm.id);
  const noLookup=await s('chat',{action:'get',project,agent_id:aname,message_id:dm.id});
  assert.equal(noLookup.messages.length,0);
  await h('chat',{action:'inbox_send',token:first.token,project,from_agent:'forged',to_agent:'identity:'+bid,content:'e2e-id-inbox'});
  const inboxRaw=await s('chat',{action:'inbox_check',token:second.token,project});
  // Bestehender stdio-inbox_check-Vertrag enthält einen zusätzlichen jsonResult-Block.
  const inbox=inboxRaw.messages ? inboxRaw : unwrap(inboxRaw);
  assert(inbox.messages.some(m=>m.content==='e2e-id-inbox'));
  const evt=await h('event',{action:'emit',token:first.token,project,event_type:'ANNOUNCEMENT',priority:'normal',scope:'identity:'+bid});
  const eventId=evt.id ?? evt.event?.id;assert(eventId,'HTTP-ID-Event');
  const pending=await s('event',{action:'pending',token:second.token,project});
  assert((pending.events ?? []).some(e=>e.id===eventId),'stdio liest HTTP-Event');
  const ack=await h2('event',{action:'ack',token:second.token,project,event_id:eventId,reaction:'done'});
  assert(ack.success!==false);
  const saved=(await row('SELECT letzte_id FROM agent_identitaet_chat_lesestand WHERE identity_id=$1',[bid])).letzte_id;
  const active=(await row('SELECT aktiv_seit FROM agent_identitaet_sitzungen WHERE identity_id=$1',[bid])).aktiv_seit.toISOString();
  const login=await s('chat',{action:'anmelden',token:second.token,project});
  assert(login.success);assert.equal(login.principal.identity_id,bid);
  assert.equal((await row('SELECT aktiv_seit FROM agent_identitaet_sitzungen WHERE identity_id=$1',[bid])).aktiv_seit.toISOString(),active);
  assert.equal((await row('SELECT letzte_id FROM agent_identitaet_chat_lesestand WHERE identity_id=$1',[bid])).letzte_id,saved);
  assert(!(await s('event',{action:'pending',token:second.token,project})).events.some(e=>e.id===eventId),'ACK überlebt Login');
  process.env.SYNAPSE_AGENT_BEZUG_MODUS='neu';
  assert((await h2('chat',{action:'get',token:second.token,project})).messages.some(m=>m.id===dm.id));
  process.env.SYNAPSE_AGENT_BEZUG_MODUS='alt';
  assert.equal((await h('chat',{action:'identitaet',token:second.token,project})).success,false,'kein ID->Legacy-Downgrade');
  // alt behält den t107-Freigabevertrag: Legacy-Zugriff mit Tokenmechanik AUS.
  process.env.SYNAPSE_TOKEN_IDENTITAET='0';
  assert(!(await h('chat',{action:'get',project,agent_id:aname})).messages.some(m=>m.id===dm.id));
  process.env.SYNAPSE_TOKEN_IDENTITAET='1';process.env.SYNAPSE_AGENT_BEZUG_MODUS='beide';
  assert((await s('chat',{action:'get',token:second.token,project})).messages.some(m=>m.id===dm.id),'ID-Daten nach Rückkehr erhalten');
  assert(!(await h('event',{action:'pending',token:second.token,project})).events.some(e=>e.id===eventId));
  const bad=await s('chat',{action:'get',token:second.token,project:foreign});
  assert.equal(bad.success,false);assert.equal(bad.error,'agent_token_fremdes_projekt');
  // Leerer Channel: Join/Leave brauchen keine Skill-Berechnung.
  const channelName='e2e-channel';
  assert((await h('channel',{action:'create',token:first.token,project,name:channelName})).success!==false);
  assert((await s('channel',{action:'join',token:second.token,project,channel_name:channelName})).success!==false);
  assert.equal((await row('SELECT count(*)::int n FROM agent_identitaet_channel_mitglieder m JOIN specialist_channels c ON c.id=m.channel_id WHERE c.project=$1 AND c.name=$2 AND m.identity_id=$3',[project,channelName,bid])).n,1);
  await s('channel',{action:'leave',token:second.token,project,channel_name:channelName});
  const posted=await h('channel',{action:'post',token:first.token,project,channel_name:channelName,content:'e2e-public'});
  assert(posted.success!==false);
  const feed=await s('channel',{action:'feed',token:second.token,project,channel_name:channelName});
  assert(feed.messages.some(m=>m.content==='e2e-public' && m.senderIdentityId===aid),'öffentlicher Feed hält ID-Attribution');
  // Audit-Flush ohne Ausweiswerte auszugeben.
  await new Promise(resolve=>setTimeout(resolve,50));
  const audit=(await q('SELECT args_preview,result,error FROM tool_calls')).rows;
  const logged=JSON.stringify(audit);
  // P22-T55 (User 19.10.): der Ausweis wird nicht mehr maskiert - im Tool-Log sichtbar.
  assert(logged.includes(first.token));
  process.env.SYNAPSE_TOKEN_IDENTITAET='0';process.env.SYNAPSE_AGENT_BEZUG_MODUS='alt';
 });
 assert.equal(network,0,'Keine Modell-/Netzwerkaufrufe im S4-Test');
 console.log('P22-T15 S4 modus='+testModus+' '+checks+' Gruppen PASS, '+failed+' FAIL; network='+network);
 process.exitCode=failed?1:0;
} finally {
 stop?.();Pattern._fehlermusterAuslieferungZuruecksetzen();
 for(const fn of close.reverse())await fn().catch(()=>{});
 await DB.closePool();await BDB.closePool();
 await raw.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await raw.end();
 await DB.closePool();await BDB.closePool();
}
process.exit(process.exitCode ?? 0);
