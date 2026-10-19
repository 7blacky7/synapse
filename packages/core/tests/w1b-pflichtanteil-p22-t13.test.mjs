/**
 * P22-T19 (W1b-T3, Befund 6fd44ab6 Punkt 5f): Pflichtanteil bei aktiver Antwortanpassung (w1b_antwortanpassung EIN).
 * Ein Agent mit stark gekuerztem Profil (kontext_stufe minimal, alle optionalen Hinweise aus, kleines Limit) MUSS ein
 * echtes WORK_STOP- und CRITICAL_REVIEW-Event ueber den echten Event-Weg (event emit, scope agent:<id> und all)
 * vollstaendig sehen: REST (fastify inject) UND stdio (InMemory-Client). Gegenprobe: Schalter AUS = Altverhalten.
 * Nur synapse_test:5433, eigenes privates Schema (Klon), keine Modelle/Netz/Daemon. Schalter nur per Env im Testprozess.
 *   node packages/core/tests/w1b-pflichtanteil-p22-t13.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const root=process.env.P22_T13_ROOT||repo;
const load=(...p)=>import(pathToFileURL(join(root,...p)).href);
const require=createRequire(join(root,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_W1B_DURCHSETZUNG',
 'SYNAPSE_W1B_ANTWORTANPASSUNG','SYNAPSE_AGENT_TOKEN_SCHLUESSEL','SYNAPSE_MAIN_SYNAPSE'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_TOKEN_IDENTITAET:'1',SYNAPSE_ONBOARDING_RUHE_MIN:'0',SYNAPSE_AGENT_BEZUG_MODUS:'alt',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
let network=0;
globalThis.fetch=async()=>{network++;throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t19_'+process.pid+'_'+randomUUID().slice(0,8);
const bearer=randomUUID()+randomUUID(),secrets=[bearer],close=[],failures=[];
let core,pool,seq=0,checks=0;
const unwrap=r=>r.structuredContent??JSON.parse(r.content.find(c=>c.type==='text').text);
const mask=s=>secrets.reduce((s,x)=>s.replaceAll(x,'[GEHEIM]'),String(s)).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]');
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}}
function gleich(a,b){try{assert.deepEqual(a,b);return true;}catch{return false;}}
async function section(name,fn){
 try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}
 catch(e){failures.push(name+': '+mask(e.message));console.error('FAIL Abschnitt '+name+': '+mask(e.stack));}
}

async function transports(){
 const fastify=(await load('packages/rest-api/node_modules/fastify/fastify.js')).default;
 const {mcpRoutes}=await load('packages/rest-api/dist/routes/mcp.js');
 const {registerAuthHook}=await load('packages/rest-api/dist/middleware/auth-hook.js');
 const app=fastify({logger:false});registerAuthHook(app);await app.register(mcpRoutes);await app.ready();
 close.push(()=>app.close());
 const rpc=async(method,params,extra={})=>{
  const r=await app.inject({method:'POST',url:'/mcp/messages',
   headers:{authorization:'Bearer '+bearer,'mcp-session-id':'p22-t19',...extra},payload:{jsonrpc:'2.0',id:++seq,method,params}});
  assert.equal(r.statusCode,200,'HTTP 200');return r.json().result;
 };
 const rest={name:'rest',call:async(name,args,extra={})=>unwrap(await rpc('tools/call',{name,arguments:args},extra))};
 const sdk=join(root,'packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm');
 const {InMemoryTransport}=await import(pathToFileURL(join(sdk,'inMemory.js')).href);
 const {Client}=await import(pathToFileURL(join(sdk,'client/index.js')).href);
 const {createServer}=await load('packages/mcp-server/dist/server.js');
 const server=createServer(),client=new Client({name:'p22-t19',version:'1'});
 const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
 close.push(()=>client.close());
 const stdio={name:'stdio',call:async(name,args)=>unwrap(await client.callTool({name,arguments:args}))};
 return {rest,stdio};
}

const OPTIONAL_AUS=['pending_events','event_warning','reservation_hint','env_hinweise','fehlermuster','shell_activity','shell_ergebnis_hinweis','shell_job_hinweis',
 'unread_chat','unread_channels','open_plans','plan_hinweise','jev_modus','skill_suggestions','tool_guide','onboarding','ausloeser'];
/** Stark gekuerztes Profil: Stufe minimal, jede optionale Art ausdruecklich aus (auch Pflichtklassen versucht), kleines Mengenlimit. */
const STARK={kontext_stufe:'minimal',
 hinweise:Object.fromEntries([...OPTIONAL_AUS,'fehler','sicherheit','werkzeug_regeln','status_kuerzung'].map(k=>[k,false])),
 zuschnitt:{limits:{'thought.get.limit':1}}};
const typen=l=>(l??[]).map(e=>e.event_type).sort().join(',');
const LANG='Stopp-Grund '+'x'.repeat(600)+' ENDE';

try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){
  const q='"'+tablename.replaceAll('"','""')+'"';
  await admin.query('CREATE TABLE '+schema+'.'+q+' (LIKE public.'+q+' INCLUDING ALL)');
 }
 const serials=await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%' ORDER BY table_name,column_name",[schema]);
 for(const [i,r]of serials.rows.entries()){
  const quote=s=>'"'+s.replaceAll('"','""')+'"',sequence=schema+'.private_serial_'+i;
  await admin.query('CREATE SEQUENCE '+sequence);
  await admin.query('ALTER TABLE '+schema+'.'+quote(r.table_name)+' ALTER COLUMN '+quote(r.column_name)+" SET DEFAULT nextval('"+sequence+"'::regclass)");
 }
 url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.href;
 core=await load('packages/core/dist/index.js');pool=core.getPool();
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);
 }
 await pool.query("INSERT INTO auth_tokens(token_hash,kind,scope,expires_at) VALUES($1,'access','mcp:tools',NOW()+INTERVAL '1 hour')",[createHash('sha256').update(bearer).digest('hex')]);
 const {rest,stdio}=await transports();
 const TR=[rest,stdio];

 /** Token-Agent in eigenem Testprojekt (Events mit scope all bleiben je Abschnitt/Transport getrennt). */
 async function neuerAgent(t,tag){
  const project='p22-t19-'+tag+'-'+t.name,name='w-'+tag+'-'+t.name,thought=randomUUID();
  await pool.query('INSERT INTO thoughts(id,project,source,content,tags) VALUES($1,$2,$3,$4,$5)',[thought,project,'synthetic','T19 fixture',[]]);
  const reg=await stdio.call('chat',{action:'register',id:name,project,model:'m1'});
  secrets.push(reg.token);
  const a={t,project,name,thought,tok:reg.token,idn:reg.principal.identity_id};
  a.profil=async p=>pool.query('UPDATE agent_identitaeten SET profil=$2::jsonb, profil_revision=profil_revision+1 WHERE id=$1',[a.idn,JSON.stringify(p)]);
  a.typisch=[['thought',{action:'get',project,id:thought}],['plan',{action:'list',project}],['channel',{action:'list',project}]];
  a.rufe=async([tool,args])=>t.call(tool,{...args,token:a.tok});
  return a;
 }
 /** echter Event-Weg: event(emit) ueber stdio ohne Agenten-Token, Absender ist ein anderer (Koordinator-)Name */
 async function sende(a,event_type,priority,scope,payload){
  const r=await stdio.call('event',{action:'emit',project:a.project,event_type,priority,scope,source_id:'koordinator-t19',payload});
  const id=r.event?.id??r.id;
  assert.ok(id!==undefined,'emit lieferte keine Event-ID: '+JSON.stringify(r));return Number(id);
 }
 const hinweis=(id,type)=>({event_id:id,event_type:type});

 await section('Positiv: Pflichtanteil WORK_STOP + CRITICAL_REVIEW bei stark gekuerztem Profil, Gegenprobe Schalter AUS',async()=>{
  for(const t of TR){
   const a=await neuerAgent(t,'haupt');
   const ws=await sende(a,'WORK_STOP','critical','agent:'+a.name,LANG);
   const cr=await sende(a,'CRITICAL_REVIEW','high','all','{"grund":"Review"}');
   const an=await sende(a,'ANNOUNCEMENT','normal','agent:'+a.name,'hinweis');
   await a.profil(STARK);

   // Altverhalten: Schalter AUS -> Profil wirkungslos, alle drei Hinweise, nichts gekuerzt
   const basis=[];
   for(const c of a.typisch){const r=await a.rufe(c);basis.push(r);}
   const b0=basis[0].pending_events??[];
   check(typen(b0)==='ANNOUNCEMENT,CRITICAL_REVIEW,WORK_STOP','AUS: alle drei Events sichtbar (Altverhalten) '+t.name);
   check(basis.every(r=>gleich(r.pending_events,b0)),'AUS: stabile Hinweise in jedem Tool '+t.name);
   check(!('antwort_zuschnitt' in basis[0]),'AUS: keine Antwortprojektion '+t.name);
   check(typeof basis[0].event_warning==='string'&&basis[0].event_warning.length>0,'AUS: Eskalationswarnung vorhanden '+t.name);
   const sollWs=b0.find(h=>h.event_id===ws),sollCr=b0.find(h=>h.event_id===cr);
   check(sollWs?.event_type==='WORK_STOP'&&sollCr?.event_type==='CRITICAL_REVIEW'&&typeof sollWs.summary==='string'&&sollWs.summary.includes('WORK_STOP'),'AUS: Basishinweise lesbar '+t.name);

   // Schalter EIN: starkes Profil
   process.env.SYNAPSE_W1B_ANTWORTANPASSUNG='1';
   for(const c of a.typisch){
    const r=await a.rufe(c);
    const pe=r.pending_events;
    check(typen(pe)==='CRITICAL_REVIEW,WORK_STOP','EIN: nur Pflichtanteil, ANNOUNCEMENT weg ('+c[0]+') '+t.name);
    check(gleich(pe?.find(h=>h.event_id===ws),sollWs)&&gleich(pe?.find(h=>h.event_id===cr),sollCr),'EIN: Hinweise identisch zum Altverhalten, Text nicht gekuerzt ('+c[0]+') '+t.name);
    check(!pe?.some(h=>h.event_id===an),'EIN: ANNOUNCEMENT unterdrueckt ('+c[0]+') '+t.name);
    check(r.event_warning===basis[0].event_warning,'EIN: Eskalationswarnung bleibt (Pflichtanteil) ('+c[0]+') '+t.name);
    check(!('open_plans' in r)&&!('jev_modus' in r)&&!('skill_suggestions' in r)&&!('tool_guide' in r)&&!('unreadChat' in r),'EIN: optionaler Rest weg ('+c[0]+') '+t.name);
   }
   const lim=await a.rufe(a.typisch[0]);
   check(lim.antwort_zuschnitt?.gekuerzt===true,'EIN: Mengenlimit greift auf den Fachkern (status_kuerzung sichtbar) '+t.name);
   check(typen(lim.pending_events)==='CRITICAL_REVIEW,WORK_STOP','EIN: Limit kuerzt den Pflichtanteil nicht '+t.name);

   // Fehlerpfad: auch ein fehlgeschlagener Aufruf traegt den Pflichtanteil
   const fe=await a.rufe(['thought',{action:'get',project:a.project,id:randomUUID()}]);
   check(typen(fe.pending_events)==='CRITICAL_REVIEW,WORK_STOP','EIN: Pflichtanteil auch bei Fehlerantwort '+t.name);

   // Vollstaendigkeit: event(pending) liefert Payload ungekuerzt
   const pend=await a.rufe(['event',{action:'pending',project:a.project,agent_id:a.name}]);
   const w=(pend.events??[]).find(e=>(e.id??e.event_id)===ws);
   check(w&&w.payload===LANG&&(pend.events??[]).length===3,'EIN: event(pending) vollstaendig inkl. langem Payload '+t.name);

   // Quittieren schliesst den Hinweis; Rest bleibt
   const ack=await a.rufe(['event',{action:'ack',event_id:ws,agent_id:a.name,reaction:'gesehen'}]);
   check(ack.eventId===ws||ack.event_id===ws||ack.success!==false,'EIN: ack WORK_STOP '+t.name);
   const nach=await a.rufe(a.typisch[1]);
   check(typen(nach.pending_events)==='CRITICAL_REVIEW','EIN: nach ACK nur noch CRITICAL_REVIEW '+t.name);
   delete process.env.SYNAPSE_W1B_ANTWORTANPASSUNG;
  }
 });

 await section('Legacy-Kontextprofil (hinweise_nur/hinweise_aus) unterdrueckt den Pflichtanteil nicht',async()=>{
  for(const t of TR){
   const a=await neuerAgent(t,'legacy');
   const ws=await sende(a,'WORK_STOP','critical','agent:'+a.name,'stop');
   const cr=await sende(a,'CRITICAL_REVIEW','critical','all',null);
   await a.profil(STARK);
   await pool.query("INSERT INTO ausloeser_hinweis_profile(project,ziel,hinweise_nur,hinweise_aus,gesetzt_von) VALUES($1,$2,$3,$4,'test')"
    ,[a.project,a.name,['fehler'],['pending_events','event_warning']]);
   process.env.SYNAPSE_W1B_ANTWORTANPASSUNG='1';
   const r=await a.rufe(a.typisch[1]);
   check(typen(r.pending_events)==='CRITICAL_REVIEW,WORK_STOP'&&r.pending_events.every(h=>[ws,cr].includes(h.event_id)),'Legacy-Profil: Pflichtanteil bleibt '+t.name);
   delete process.env.SYNAPSE_W1B_ANTWORTANPASSUNG;
  }
 });

 await section('Limit 3 der Inbox darf den Pflichtanteil nicht verdraengen (ANNOUNCEMENT-Flut vor WORK_STOP)',async()=>{
  for(const t of TR){
   const a=await neuerAgent(t,'flut');
   for(let i=0;i<4;i++)await sende(a,'ANNOUNCEMENT','critical','agent:'+a.name,'flut '+i);
   const ws=await sende(a,'WORK_STOP','critical','agent:'+a.name,'stop nach flut');
   const cr=await sende(a,'CRITICAL_REVIEW','high','all','review nach flut');
   await a.profil(STARK);
   process.env.SYNAPSE_W1B_ANTWORTANPASSUNG='1';
   const r=await a.rufe(a.typisch[1]);
   const ids=(r.pending_events??[]).map(h=>h.event_id);
   check(ids.includes(ws),'BEFUND Flut: WORK_STOP sichtbar trotz 4 aelterer kritischer Events '+t.name);
   check(ids.includes(cr),'BEFUND Flut: CRITICAL_REVIEW sichtbar trotz Flut '+t.name);
   delete process.env.SYNAPSE_W1B_ANTWORTANPASSUNG;
  }
 });

 await section('Eskalation (Pflichtanteil event_warning) auch ohne Pflicht-Event, REST und stdio gleich',async()=>{
  const antwort={};
  for(const t of TR){
   const a=await neuerAgent(t,'eskal');
   await sende(a,'ANNOUNCEMENT','critical','agent:'+a.name,'dringend');
   await a.profil(STARK);
   process.env.SYNAPSE_W1B_ANTWORTANPASSUNG='1';
   const r=await a.rufe(a.typisch[1]);
   antwort[t.name]=typeof r.event_warning==='string';
   delete process.env.SYNAPSE_W1B_ANTWORTANPASSUNG;
  }
  check(antwort.rest===antwort.stdio,'BEFUND Eskalation: REST und stdio liefern bei nur dringendem ANNOUNCEMENT dasselbe (rest='+antwort.rest+', stdio='+antwort.stdio+')');
  check(antwort.rest===true,'BEFUND Eskalation: event_warning (Pflichtanteil) bei dringendem Event trotz pending_events aus REST');
  check(antwort.stdio===true,'BEFUND Eskalation: event_warning (Pflichtanteil) bei dringendem Event trotz pending_events aus stdio');
 });

 const logs=JSON.stringify((await pool.query('SELECT * FROM tool_calls')).rows);
 check(secrets.every(s=>!logs.includes(s)),'kein Ausweis im Audit');
 check(network===0,'keine Netzwerk-/Modellaufrufe');
 console.log('P22-T19 Pflichtanteil: '+checks+' Pruefungen, '+failures.length+' Fehler');
 if(failures.length){console.error(failures.join('\n'));process.exitCode=1;}
}catch(error){console.error(mask(error.stack));process.exitCode=1;}
finally{
 for(const fn of close.reverse())try{await fn();}catch(error){console.error(mask('Cleanup: '+error.message));}
 if(core)await core.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(process.exitCode||0);
