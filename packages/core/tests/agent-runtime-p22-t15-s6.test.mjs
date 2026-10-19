/**
 * P22-T15 S6: real route/service integration in an isolated synapse_test schema.
 * No daemon process, model call or production connection. --positive-only fails on t107.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const root=process.env.SYNAPSE_TEST_DIST_ROOT||repo;
const load=(...p)=>import(pathToFileURL(join(root,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
delete process.env.SYNAPSE_AGENT_TOKEN;delete process.env.SYNAPSE_AGENT_IDENTITY_ID;
Object.assign(process.env,{SYNAPSE_INTERN_TOOL:'0',SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_TOKEN_IDENTITAET:'1',
 SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_ONBOARDING_RUHE_MIN:'0'});
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='sol36_t15_'+process.pid+'_'+Date.now(),project='sol36-t15-synthetic';
let core,pool,app,checks=0;const cleanup=[];
const eq=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;};
const ok=(v,label)=>{assert.ok(v,label);checks++;};
const pause=()=>new Promise(r=>setTimeout(r,10));
const eventually=async(fn)=>{for(let n=0;n<100;n++){if(await fn())return;await pause();}throw Error('event timeout');};
const stand=modus=>({modus,standard:modus,quelle:'standard',bis:null,letzter_fehler:null});
let B,W,K,Q;
const ctx=(p,mode,fn)=>B.mitAgentAufrufKontext({principal:p,bezug:stand(mode)},fn);
const clone=async()=>{
 await admin.query('CREATE SCHEMA '+schema);
 const tables=(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
 for(const {tablename:t} of tables){const q='"'+t.replaceAll('"','""')+'"';await admin.query('CREATE TABLE '+schema+'.'+q+' (LIKE public.'+q+' INCLUDING ALL)');}
 url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.href;
 core=await load('packages/core/dist/index.js');pool=core.getPool();
 eq((await pool.query('SELECT current_schema() s')).rows[0].s,schema,'isolated search path');
 for(const [file,key] of [['agent-identitaet-schema','AGENT_IDENTITAET_SCHEMA_SQL'],['agent-bezug-schema','AGENT_BEZUG_SCHEMA_SQL'],['agent-ausweis-schema','AGENT_AUSWEIS_SCHEMA_SQL']]){
  const m=await load('packages/core/dist/db/'+file+'.js');
  await pool.query(m[key]);await pool.query(m[key]);
 }
};
try{
 // Positive control touches an exported new behavior before any test state.
 W=await load('packages/core/dist/services/wrapper-status.js');
 ok(W.baueWrapperStatusUpsert({agentName:'same',project},{art:'identity',project,agent_id:'same',identity_id:randomUUID()}).text.includes('agent_identitaet_wrapper_status'),'positive control: explicit ID writes separate table');
 B=await load('packages/core/dist/services/agent-bezug.js');
 const A=await load('packages/agents/dist/agent-lauf.js');
 const ids=[randomUUID(),randomUUID()];
 const k=await A.mitAgentLaufUmgebung('same',project,{SYNAPSE_AGENT_IDENTITY_ID:ids[0]},async()=>A.agentLaufSchluessel('same'));
 eq(k,'identity:'+ids[0],'positive control: identity key replaces display name');
 if(process.argv.includes('--positive-only')){console.log('S6 POSITIVE_CONTROL PASS');}
 else{
 await clone();
 W=await load('packages/core/dist/services/wrapper-status.js');
 K=await load('packages/core/dist/services/agent-wissen.js');
 Q=await load('packages/core/dist/services/specialist-queue.js');
 const legacy={art:'legacy',project,agent_id:'same'};
 const tokens=[];
 for(let n=0;n<2;n++){
  const issued=await core.stelleAgentTokenAus({project,name:'same'},undefined,stand('beide'));
  const logged=await core.meldeAgentMitTokenAn(issued.token,project,stand('beide'));
  tokens.push({token:issued.token,p:B.agentPrincipalAusAnmeldung(logged)});
 }
 const [a,b]=tokens.map(t=>t.p);
 eq(a.agent_id,'same','first display snapshot');eq(b.agent_id,'same#2','same base name has separate instance');
 ok(a.identity_id!==b.identity_id,'independent identities');
 await core.registerAgent('same',project,'synthetic-legacy');
 const originalLegacy=(await pool.query('SELECT row_to_json(s) r FROM agent_sessions s')).rows;
 await ctx(legacy,'beide',()=>W.upsertWrapperStatus({agentName:'same',project,currentTask:'legacy',wrapperPid:123}));
 await ctx(legacy,'beide',()=>K.setzeWissen(project,'same','regeln','legacy private'));
 for(const [p,tag] of [[a,'A'],[b,'B']]){
  await ctx(p,'beide',async()=>{
   await W.upsertWrapperStatus({agentName:p.agent_id,project,currentTask:tag,wrapperPid:tag==='A'?234:345});
   await K.setzeWissen(project,p.agent_id,'regeln',tag+' private');
  });
 }
 const beforeLegacy=(await pool.query('SELECT row_to_json(s) r FROM wrapper_status s')).rows;
 for(const mode of ['beide','neu','alt','beide']){
  process.env.SYNAPSE_AGENT_BEZUG_MODUS=mode;
  const rows=await W.listWrapperStatus(project);
  eq(rows.length,mode==='alt'?1:3,'mode list isolation '+mode);
  if(mode==='alt'){
   await assert.rejects(ctx(a,mode,()=>W.getWrapperStatus(a,project)),/altmodus/);checks++;
   await assert.rejects(ctx(a,mode,()=>K.leseAgentWissen(project,a)),/altmodus/);checks++;
  }else{
   await Promise.all([[a,'A'],[b,'B']].map(([p,tag])=>ctx(p,mode,async()=>{
    await pause();
    eq((await W.getWrapperStatus(p.agent_id,project)).currentTask,tag,'async status identity '+mode);
    ok((await K.leseAgentWissen(project,p.agent_id)).text.includes(tag+' private'),'async knowledge identity '+mode);
    eq(B.aktuelleAgentIdentityId(project,p.agent_id),p.identity_id,'ALS identity');
   })));
  }
 }
 eq((await pool.query('SELECT row_to_json(s) r FROM wrapper_status s')).rows,beforeLegacy,'ID operations preserve legacy status bytewise');
 eq((await pool.query('SELECT row_to_json(s) r FROM agent_sessions s')).rows,originalLegacy,'ID login preserves legacy sessions');
 process.env.SYNAPSE_AGENT_BEZUG_MODUS='beide';
 await ctx(a,'beide',()=>W.setzeHeartbeatKonfiguration(project,[a],{enabled:false,intervalMs:5000}));
 eq((await ctx(a,'beide',()=>W.getWrapperStatus(a,project))).heartbeatEnabled,false,'heartbeat A changed');
 eq((await ctx(b,'beide',()=>W.getWrapperStatus(b,project))).heartbeatEnabled,true,'heartbeat B preserved');
 eq((await W.getWrapperStatus('same',project)).heartbeatEnabled,true,'heartbeat legacy preserved');
 await ctx(a,'beide',()=>K.haengeWissenAn(project,a,'fehler','A appended'));
 await ctx(a,'beide',()=>K.loescheAgentWissen(project,a));
 eq(await ctx(a,'beide',()=>K.leseAgentWissen(project,a)),null,'purge only A');
 ok((await ctx(b,'beide',()=>K.leseAgentWissen(project,b))).text.includes('B private'),'purge preserves B');
 ok((await K.leseAgentWissen(project,'same')).text.includes('legacy private'),'purge preserves legacy');
 await ctx(a,'beide',()=>K.setzeWissen(project,a,'regeln','A private'));

 // Real personal transport routes and daemon bridge, fake service authentication only.
 const fastify=(await import(pathToFileURL(join(repo,'packages/rest-api/node_modules/fastify/fastify.js')).href)).default;
 app=fastify({logger:false});
 const {wrapperBridgeRoutes}=await load('packages/rest-api/dist/routes/wrapper-bridge.js');
 const {agentWissenRoutes}=await load('packages/rest-api/dist/routes/agent-wissen.js');
 const {daemonJobsRoutes}=await load('packages/rest-api/dist/routes/daemon-jobs.js');
 await app.register(wrapperBridgeRoutes);await app.register(agentWissenRoutes);
 await app.register(daemonJobsRoutes,{
  validateToken:async t=>t==='fake-daemon'?{kind:'service',scope:'daemon',token_hash:'fake-hash'}:null,
  daemonHost:async()=> 'sol36-test-host'
 });
 await app.ready();
 const path=p=>'/api/projects/'+project+'/specialists/'+encodeURIComponent(p.agent_id);
 const headers=t=>({'x-synapse-agent-token':t.token,'x-synapse-agent-identity-id':t.p.identity_id});
 const request=async(p,suffix,t,method='GET',payload)=>{
  const r=await app.inject({method,url:path(p)+suffix,headers:t?headers(t):{},payload});
  return {code:r.statusCode,body:r.json()};
 };
 const good=await request(a,'/wissen',tokens[0]);
 eq(good.code,200,'wissen personal route');ok(good.body.text.includes('A private'),'wissen uses personal storage');
 eq((await request(b,'/wissen',tokens[0])).code,403,'token cannot change path agent');
 const wrong=await app.inject({method:'GET',url:path(a)+'/wissen',headers:{...headers(tokens[0]),'x-synapse-agent-identity-id':b.identity_id}});
 eq(wrong.statusCode,403,'token cannot claim second identity');
 eq((await app.inject({method:'GET',url:path(a)+'/wissen',headers:{'x-synapse-agent-identity-id':a.identity_id}})).statusCode,403,'identity header requires personal proof');
 eq((await app.inject({method:'GET',url:path(a)+'/wissen',headers:{Authorization:'Bearer fake-daemon'}})).json().text,good.body.text.replace('A private','legacy private'),'service bearer alone remains legacy');
 process.env.SYNAPSE_AGENT_BEZUG_MODUS='alt';
 eq((await request(a,'/wissen',tokens[0])).code,409,'alt refuses identity header');
 process.env.SYNAPSE_AGENT_BEZUG_MODUS='beide';
 const inboxIds=[];
 for(const [target,text] of [[a,'A message'],[b,'B message'],[legacy,'legacy message']]){
  inboxIds.push((await pool.query('INSERT INTO specialist_inbox(project,from_agent,to_agent,content,to_identity_id) VALUES($1,$2,$3,$4,$5) RETURNING id',[project,'sender',target.agent_id,text,target.identity_id??null])).rows[0].id);
 }
 const inbox=await request(a,'/inbox',tokens[0]);
 eq(inbox.code,200,'personal inbox route');eq(inbox.body.messages.map(x=>x.content),['A message'],'personal inbox isolated');
 eq((await request(a,'/inbox/ack',tokens[0],'POST',{ids:inboxIds})).body.updated,1,'ack cannot alter another identity or legacy');
 eq((await pool.query('SELECT content FROM specialist_inbox WHERE processed=false ORDER BY id')).rows.map(x=>x.content),['B message','legacy message'],'foreign inbox remains');
 const wm=await request(a,'/watermarks',tokens[0]);eq(wm.body.watermarks.inbox,inboxIds[0],'watermark scoped by ID');

 // Trusted queued target and actor; display name only never adopts an identity.
 const job=await ctx(a,'beide',()=>Q.enqueueSpecialistJob({project,action:'wake',args:{name:'identity:'+b.identity_id}}));
 const row=(await pool.query('SELECT * FROM specialist_jobs WHERE id=$1',[job.id])).rows[0];
 eq(row.actor_identity_id,a.identity_id,'queue actor trusted');eq(row.target_identity_id,b.identity_id,'queue explicit target');
 eq(row.args.name,b.agent_id,'queue snapshot normalized');
 const oldJob=await Q.enqueueSpecialistJob({project,action:'wake',args:{name:b.agent_id}});
 eq((await pool.query('SELECT target_identity_id FROM specialist_jobs WHERE id=$1',[oldJob.id])).rows[0].target_identity_id,null,'name-only queue stays legacy');
 const daemonId='daemon-sol36-test-host-777';
 await pool.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,$2,$3,true)",[project,'sol36-test-host','/tmp/sol36-t15']);
 const daemon=async extra=>{
  const r=await app.inject({method:'POST',url:'/api/daemon/specialist/daten',headers:{Authorization:'Bearer fake-daemon'},
   payload:{host:'sol36-test-host',daemon_id:daemonId,project,agent:b.agent_id,identity_id:b.identity_id,aktion:'wrapper_pid',...extra}});
  return {code:r.statusCode,body:r.json()};
 };
 eq((await daemon({})).body.error,'daemon_identity_auftrag_fehlt','daemon cannot invent identity target');
 eq((await daemon({auftrag_id:job.id})).body.error,'daemon_identity_auftrag_falsch','pending job grants no rights');
 await pool.query("UPDATE specialist_jobs SET status='running',claimed_by=$2 WHERE id=$1",[job.id,daemonId]);
 const bound=await daemon({auftrag_id:job.id});eq(bound.code,200,'claimed ID job allowed');
 eq((await daemon({auftrag_id:job.id,identity_id:a.identity_id,agent:a.agent_id})).code,403,'claim cannot change target');
 eq((await daemon({auftrag_id:job.id,daemon_id:'daemon-sol36-test-host-778'})).code,403,'claim cannot change daemon');
 eq((await daemon({auftrag_id:job.id,host:'foreign-host'})).code,403,'daemon host proof');
 process.env.SYNAPSE_AGENT_BEZUG_MODUS='alt';eq((await daemon({auftrag_id:job.id})).code,409,'alt preserves ID job state');
 process.env.SYNAPSE_AGENT_BEZUG_MODUS='beide';

 // Claim-bound start and PID-CAS must never touch legacy or the adjacent identity.
 const start=await daemon({auftrag_id:job.id,aktion:'agent_start'});
 eq(start.code,200,'claimed child start succeeds');
 eq(start.body.identity_id,b.identity_id,'start response binds child target ID');
 ok(/^sai_[a-f0-9]{64}$/.test(start.body.token),'start response contains personal proof');
 eq(start.body.agent_bezug_modus,'beide','start reports captured mode');
 const noAdopt=await daemon({aktion:'agent_start',identity_id:undefined});
 eq(noAdopt.body.legacy_start,true,'name-only daemon start never adopts ID');
 eq(noAdopt.body.token,undefined,'name-only daemon start returns no ID proof');
 eq((await daemon({auftrag_id:job.id,aktion:'wrapper_gestoppt',pid:999})).body.anzahl,0,'stale PID CAS preserves restarted wrapper');
 eq((await daemon({auftrag_id:job.id,aktion:'wrapper_gestoppt',pid:345})).body.anzahl,1,'matching PID CAS changes only bound target');
 eq((await ctx(a,'beide',()=>W.getWrapperStatus(a,project))).currentTask,'A','PID CAS preserves first identity');
 eq((await W.getWrapperStatus('same',project)).currentTask,'legacy','PID CAS preserves same-name legacy');
 const SId=await load('packages/core/dist/services/specialist-identitaet.js');
 const stableCounts=async()=>(await pool.query('SELECT (SELECT count(*) FROM specialist_jobs)::int AS jobs,(SELECT count(*) FROM specialist_inbox)::int AS inbox')).rows;
 const beforeRejected=await stableCounts();
 for(const args of [
  {action:'wake',project,name:['same','identity:'+a.identity_id],message:'must not send'},
  {action:'spawn_batch',project,specialists:[{name:'same'},{name:'identity:'+b.identity_id}]}
 ]){
  eq((await ctx(a,'alt',()=>SId.fuehreSpecialistIdentitaetsAktion(args))).error,'specialist_identity_im_altmodus','alt rejects whole mixed batch before side effects');
 }
 eq(await stableCounts(),beforeRejected,'mixed alt batch produces no jobs/inbox');
 eq((await ctx(a,'beide',()=>SId.fuehreSpecialistIdentitaetsAktion({action:'status',project,name:'identity:'+b.identity_id}))).specialist.identityId,b.identity_id,'specialist status explicit ID');
 const sent=await ctx(a,'beide',()=>SId.fuehreSpecialistIdentitaetsAktion({action:'wake',project,name:'identity:'+b.identity_id,message:'durable ID wake'}));
 ok(sent.success&&sent.inboxId,'specialist wake persisted');
 const sentRow=(await pool.query('SELECT to_identity_id,from_identity_id FROM specialist_inbox WHERE id=$1',[sent.inboxId])).rows[0];
 eq(sentRow,{to_identity_id:b.identity_id,from_identity_id:a.identity_id},'durable specialist wake attributed by principal');

 // Shell execution context trusts claimed owner ID and current role, never a supplied name.
 const shellId=randomUUID();
 await pool.query("INSERT INTO shell_jobs(id,project,command,status,claimed_by,agent_id,owner_identity_id) VALUES($1,$2,'true','running',$3,'koordinator',$4)",[shellId,project,daemonId,a.identity_id]);
 const shellContext=await core.ladeShellExecKontextFuerDaemon(shellId,daemonId,'sol36-test-host');
 ok(shellContext.ok,'shell context claimed owner');
 eq(shellContext.kontext.agent_identity_id,a.identity_id,'shell identity from claimed owner');
 eq(shellContext.kontext.agent_koordination_erlaubt,false,'coordinator display name grants no role');
 eq((await core.ladeShellExecKontextFuerDaemon(shellId,'daemon-sol36-test-host-778','sol36-test-host')).error,'nicht_eigener_job','foreign daemon cannot fetch shell owner');
 await pool.query("UPDATE agent_identitaeten SET rolle='koordinator' WHERE id=$1",[a.identity_id]);
 eq((await core.ladeShellExecKontextFuerDaemon(shellId,daemonId,'sol36-test-host')).kontext.agent_koordination_erlaubt,true,'confirmed active role grants coordination');
 await pool.query("UPDATE agent_identitaeten SET rolle='subagent' WHERE id=$1",[a.identity_id]);

 // Request snapshot remains fixed even if global configuration changes while handler awaits.
 await core.mitAgentToolAufruf('chat',{action:'identitaet',token:tokens[0].token,project},'sol36-t15',async k=>{
  ok(k.principal,'tool verified principal');process.env.SYNAPSE_AGENT_BEZUG_MODUS='alt';await pause();
  eq(B.aktuellerAgentAufruf().bezug.modus,'beide','one request mode snapshot');
  eq(B.aktuelleAgentIdentityId(project,a.agent_id),a.identity_id,'principal remains scoped until hooks');
 });
 eq(B.aktuellerAgentPrincipal(),null,'no global last principal');

 // Concurrent child scopes separate filesystem keys/environment; no artifact writes required.
 const scopes=await Promise.all(ids.map((id,n)=>A.mitAgentLaufUmgebung('same',project,{SYNAPSE_AGENT_IDENTITY_ID:id,SYNAPSE_AGENT_TOKEN:'fake-'+n},async()=>{
  await pause();return [A.agentLaufSchluessel('same'),A.agentLaufPfad('/tmp/project','same'),A.agentLaufUmgebung().SYNAPSE_AGENT_TOKEN,A.agentLaufSchluessel('other')];
 })));
 for(let n=0;n<2;n++)eq(scopes[n],['identity:'+ids[n],join(homedir(),'.synapse','agent-runs',ids[n]),'fake-'+n,'other'],'child ALS isolation '+n);
 eq(A.agentLaufSchluessel('same'),'same','scope unwinds to legacy');
 const D=await load('packages/file-watcher-daemon-ts/dist/daemon-auftrag.js');
 eq(await D.mitDaemonAuftrag(row,async()=>{await pause();return D.daemonAuftragBindung();}),{auftrag_id:job.id,identity_id:b.identity_id},'daemon request uses claimed target only');
 eq(D.daemonAuftragBindung(),{},'daemon scope unwinds');
 const P=await load('packages/core/dist/services/wrapper-prozess.js');
 eq((await P.pruefeWrapperProzess(process.pid,'same',project,'/tmp',a.identity_id)).zustand,'ungeprueft','current arbitrary PID never signalled');

 const cas=[];
 const stopped=await P.stoppeLokalenWrapper('same','/tmp',project,{
  identityId:()=>a.identity_id,projektpfad:async()=>'/tmp',wrapperPid:async()=>2147483647,
  setzeGestoppt:async(...args)=>cas.push(args)
 });
 ok(stopped.success,'proven dead PID reports stopped');
 eq(cas,[['same',project,2147483647]],'stop writes only checked PID through injected CAS');
 const rejected=await P.stoppeLokalenWrapper('same','/tmp',project,{
  identityId:()=>b.identity_id,projektpfad:async()=>'/tmp',wrapperPid:async()=>process.pid,
  setzeGestoppt:async()=>{throw Error('must not run');}
 });
 eq(rejected.success,false,'unverified PID never reaches write/signalling');

 // Fake HTTP/SSE exercises actual ApiTransport and ApiWissen without opening sockets.
 const {ApiTransport}=await load('packages/agents/dist/transport/api.js');
 const {ApiWissen}=await load('packages/agents/dist/wissen/api.js');
 const realFetch=globalThis.fetch,calls=[],live=[],logs=[];
 Object.assign(process.env,{SYNAPSE_API_URL:'http://synthetic.invalid',SYNAPSE_API_TOKEN:'fake-service',
  SYNAPSE_AGENT_TOKEN:'fake-personal',SYNAPSE_AGENT_IDENTITY_ID:a.identity_id});
 let streamController,liveTransport;
 globalThis.fetch=async (url,opts)=>{
  calls.push({url,headers:opts.headers});
  if(String(url).endsWith('/stream')){
   const body=new ReadableStream({start(c){streamController=c;}});
   opts.signal.addEventListener('abort',()=>{try{streamController.close();}catch{/* Fake stream may already be closed after explicit stop. */}},{once:true});
   return new Response(body,{status:200});
  }
  return new Response(JSON.stringify({success:true,text:'synthetic knowledge'}),{status:200});
 };
 try{
  liveTransport=new ApiTransport({projekt:project,agentName:a.agent_id,log:(...v)=>logs.push(v)});
  await liveTransport.starte();
  eq(calls[0].headers['x-synapse-agent-token'],'fake-personal','ordinary request personal header');
  eq(calls[0].headers['x-synapse-agent-identity-id'],a.identity_id,'ordinary request ID header');
  await liveTransport.starteLiveKanal(e=>live.push(e));
  await eventually(()=>!!streamController);
  eq(calls[1].headers['x-synapse-agent-identity-id'],a.identity_id,'SSE request ID header');
  const frame=(event,data)=>streamController.enqueue(new TextEncoder().encode('event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n'));
  frame('file',{project,file_path:'own.ts',agent_id:a.agent_id,author_identity_id:a.identity_id});
  frame('file',{project,file_path:'other-id.ts',agent_id:a.agent_id,author_identity_id:b.identity_id});
  frame('file',{project,file_path:'legacy-same.ts',agent_id:a.agent_id});
  frame('file',{project:'elsewhere',file_path:'foreign.ts',author_identity_id:b.identity_id});
  frame('wake',{message:'wake payload'});
  await eventually(()=>live.some(e=>e.art==='wake'));
  eq(live.filter(e=>e.art==='datei').map(e=>e.pfad),['other-id.ts','legacy-same.ts'],'echo suppression compares ID rather than name');
  await liveTransport.beendeLiveKanal();
  streamController=null;
  await liveTransport.starteLiveKanal(e=>live.push(e));
  await eventually(()=>!!streamController);
  eq(calls.filter(c=>String(c.url).endsWith('/stream')).at(-1).headers['x-synapse-agent-token'],'fake-personal','SSE reconnect retains personal header');
  await liveTransport.beendeLiveKanal();
  await Promise.all([a,b].map((p,n)=>A.mitAgentLaufUmgebung(p.agent_id,project,{
   SYNAPSE_API_URL:'http://synthetic.invalid',SYNAPSE_API_TOKEN:'fake-service',
   SYNAPSE_AGENT_TOKEN:'fake-child-'+n,SYNAPSE_AGENT_IDENTITY_ID:p.identity_id
  },async()=>{await pause();const w=new ApiWissen({projekt:project,log:()=>{}});await w.liesAlles(p.agent_id);})));
  for(let n=0;n<2;n++){
   const c=calls.find(c=>c.headers['x-synapse-agent-token']==='fake-child-'+n);
   eq(c.headers['x-synapse-agent-identity-id'],[a,b][n].identity_id,'knowledge child request bound '+n);
  }
  ok(!JSON.stringify(logs).includes('fake-personal'),'transport logs omit personal proof');
 }finally{
  if(liveTransport)await liveTransport.beendeLiveKanal();
  globalThis.fetch=realFetch;
  delete process.env.SYNAPSE_AGENT_TOKEN;delete process.env.SYNAPSE_AGENT_IDENTITY_ID;
 }

 // Real LISTEN/NOTIFY fanout: private wakes only to matching ID, never same-name legacy.
 process.env.SYNAPSE_AGENT_BEZUG_MODUS='beide';
 const S=await load('packages/rest-api/dist/services/wrapper-stream.js'),events=[[],[],[]];
 for(const [n,p] of [[0,a],[1,b],[2,legacy]])cleanup.push(ctx(p,'beide',()=>S.abonniere(project,p.agent_id,e=>events[n].push(e))));
 await eventually(()=>S.stromGesundheit().listener.connected);
 await pool.query('SELECT pg_notify($1,$2)',['synapse_identity_wake_'+a.identity_id.replaceAll('-','_'),JSON.stringify({project,message:'A wake'})]);
 await eventually(()=>events[0].some(e=>e.event==='wake'));
 eq(events.map(es=>es.filter(e=>e.event==='wake').length),[1,0,0],'private ID wake fanout');
 await pool.query('SELECT pg_notify($1,$2)',['synapse_specialist_wake_same',JSON.stringify({project,message:'legacy wake'})]);
 await eventually(()=>events[2].some(e=>e.event==='wake'));
 eq(events.map(es=>es.filter(e=>e.event==='wake').length),[1,0,1],'legacy wake cannot reach ID subscriber');
 for(const f of cleanup.splice(0))f();
 console.log('P22-T15 S6 PASS '+checks+' assertions; schema111/112 twice; no model/daemon/network calls');
 }
}catch(e){console.error('P22-T15 S6 FAIL '+String(e?.stack||e).replace(/sai_[a-f0-9]{64}/g,'[AUSWEIS]'));process.exitCode=1;}
finally{
 for(const f of cleanup.splice(0))f();
 if(app)await app.close().catch(()=>{});
 if(core)await core.closePool().catch(()=>{});
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
 console.log('CLEANUP sol36 synthetic schema removed');
}
process.exit(process.exitCode||0);
