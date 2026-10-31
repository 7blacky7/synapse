/**
 * P22-T194 / f18b99fb: echte PG-Vertraege der Cache-Mod und REST-Handler.
 * synapse_test:5433, privates Schema, aktuelle Migration167 aus Produktcode, kein Browser/LLM/Docker.
 * Quellen: runtime-synapse-mods.ts, cache-waechter.ts und wrapper-bridge.ts.
 * Routerregistrierung ersetzt; Auth-Service, Runtime-Bearerbindung/PID/SQL und Handler bleiben echt.
 * Der Aufrufkontext entspricht einem bestaetigten Ausweis; generische HTTP-Header-Pruefung deckt ALT-T13/T34.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
const url=new URL(process.env.SYNAPSE_DATABASE_URL||process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'1'});
globalThis.fetch=async()=>{throw Error('P22-T194 Testnetz gesperrt');};
const require=createRequire(new URL('../../core/package.json',import.meta.url)),{Pool}=require('pg');
const admin=new Pool({connectionString:url.href}),schema='p22_t194_'+randomUUID().replaceAll('-','');
let C,pool,checks=0;
const P='p22-t194',id=randomUUID(),sid=randomUUID(),agent='p22-t194-agent',first=randomUUID();let lauf=first;
const now=Date.now(),origin={weg:'container_runtime',host:'synapse-runtime-claude',daemon_id:'daemon-synapse-runtime-claude-123',runtime:'claude',lauf_art:'cli'};
const ok=(v,label,ist=v)=>{assert.ok(v,'P22-T194 '+label+' | erwartet=true | ist='+JSON.stringify(ist));checks++;};
try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const t of ['agent_identitaeten','agent_identitaet_laeufe','agent_profil_schalter','intern_schalter','agent_identitaet_wrapper_status','specialist_jobs','auth_tokens','daemon_restore_host_bindings','agent_runtime_instances']){
  await admin.query('CREATE TABLE '+schema+'.'+t+' (LIKE public.'+t+' INCLUDING ALL)');
 }
 url.searchParams.set('options','-c search_path='+schema);process.env.DATABASE_URL=url.href;
 C=await import('../../core/dist/index.js');pool=C.getPool();
 const {CACHE_WAECHTER_SCHEMA_SQL}=await import('../../core/dist/db/cache-waechter-schema.js');
 await pool.query(CACHE_WAECHTER_SCHEMA_SQL);
 await pool.query('INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,erstellt_von) VALUES($1,$2,$3,$3,$4,$5)',[id,P,agent,'koordinator','test']);
 await pool.query("INSERT INTO agent_identitaet_laeufe(id,identity_id,context_epoch,status) VALUES($1,$2,1,'aktiv')",[lauf,id]);
 const set=async(name,aktiv)=>{
  await pool.query('DELETE FROM agent_profil_schalter WHERE funktion=$1',[name]);
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,$2,$3,'P22-T194 Test','user')",[P,name,aktiv]);
 };
 ok(!(await C.leseRuntimeSynapseMods(P)).aktiv,'runtime-synapse-mods Produktstandard AUS');
 await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',null,'alle',true,'Test','user')");
 ok(!(await C.leseRuntimeSynapseMods(P)).aktiv,'alle gibt Container-Mod nicht implizit frei');
 await set('runtime_synapse_mods',true);
 ok((await C.leseRuntimeSynapseMods(P)).quelle==='produkt-schalter','PG-Produktwert mit Quelle EIN');
 const I=await import('../../core/dist/services/intern-schalter.js');
 await I.setzeSchalter('runtime_synapse_mods',{aktiv:false,modus:'freigegeben',dauer_min:1,grund:'Test'});
 let s=await C.leseRuntimeSynapseMods(P);
 ok(!s.aktiv&&s.quelle==='intern'&&!!s.bis&&s.produkt.aktiv,'intern AUS befristet vor PG EIN',s);
 await assert.rejects(()=>I.setzeSchalter('runtime_synapse_mods',{aktiv:true,dauerhaft:true}),e=>e.code==='ablauf_erforderlich');checks++;
 await pool.query("UPDATE intern_schalter SET bis=NOW()-INTERVAL '1 second' WHERE name='runtime_synapse_mods'");
 ok((await C.leseRuntimeSynapseMods(P)).aktiv,'abgelaufener Override -> PG EIN');
 await pool.query("DELETE FROM intern_schalter WHERE name='runtime_synapse_mods'");
 await set('cache_waechter',true);await set('runtime_synapse_mods',false);
 const messung=(quelle='mod',extra={})=>({modell:'haiku',request_id:'msg-1',messung_ms:now+10,request_beginn_ms:now,
  nutzungsmessung_ms:now+5,input:2,output:3,gelesen:100,geschrieben:0,kontext_tokens:102,ttl_klassen:['5m'],
  ttl_quelle:quelle==='mod'?'transcript':'stream_json',mod_version:quelle==='mod'?'0.3.0':'wrapper-stream-v1',cli_version:'2.1.310',
  erfassung:quelle,zeitbasis:quelle==='mod'?'request_beginn':'turn_beginn',...extra});
 const melden=m=>C.meldeCacheWaechter({identity_id:id,lauf_id:lauf,sitzung:sid,herkunft:origin,messung:m});
 ok((await melden(messung())).grund==='runtime_mod_schalter_aus','Core sperrt Container-Mod auch bei Cache EIN');
 ok((await melden(messung('wrapper_stream'))).angenommen,'Wrapper-Quelle bleibt unabhaengig von Mod-Schalter');
 await set('runtime_synapse_mods',true);
 ok((await melden(messung('mod',{messung_ms:now+20}))).angenommen,'Mod nach Freigabe gespeichert');
 s=await C.leseCacheWaechterStand(id);
 ok(s.stand.messung.erfassung==='mod'&&Object.keys(s.stand.quellen).length===2,'gleicher Providerrequest: Mod plus Wrapper sichtbar',s.stand);
 ok(s.stand.messung.gelesen===100&&s.stand.messung.kontext_tokens===102,'derselbe Request wird nicht doppelt addiert',s.stand.messung);
 await melden(messung('wrapper_stream',{request_id:'msg-2',messung_ms:now+40,nutzungsmessung_ms:now+35}));
 await melden(messung('mod',{messung_ms:now+30}));
 s=await C.leseCacheWaechterStand(id);
 ok(s.stand.messung.request_id==='msg-2'&&s.stand.messung.erfassung==='wrapper_stream','verspaetete alte Mod-Messung verdeckt keinen neueren Request');
 ok(!(await melden(messung('mod',{messung_ms:now+25}))).angenommen,'alter Stand derselben Quelle abgewiesen');
 await Promise.all([melden(messung('mod',{request_id:'msg-3',messung_ms:now+60,nutzungsmessung_ms:now+55})),
  melden(messung('wrapper_stream',{request_id:'msg-3',messung_ms:now+60,nutzungsmessung_ms:now+55}))]);
 s=await C.leseCacheWaechterStand(id);
 ok(Object.keys(s.stand.quellen).length===2&&s.stand.messung.erfassung==='mod','parallele Schreiber verlieren keinen der zwei Snapshots');
 await pool.query("UPDATE agent_identitaet_laeufe SET status='abgeloest' WHERE id=$1",[lauf]);
 lauf=randomUUID();await pool.query("INSERT INTO agent_identitaet_laeufe(id,identity_id,context_epoch,status) VALUES($1,$2,2,'aktiv')",[lauf,id]);
 await assert.rejects(()=>C.meldeCacheWaechter({identity_id:id,lauf_id:first,sitzung:sid,herkunft:origin,messung:messung()}),e=>e.code==='cache_lauf_nicht_aktuell');checks++;
 await melden(messung());
 s=await C.leseCacheWaechterStand(id);
 ok(Object.keys(s.stand.quellen).length===1&&!s.stand.quellen.wrapper_stream,'Neuanmeldung verwirft alte Quellenprojektion');

 // Echte Runtime-Bearerbindung und Wrapper-PID gegen denselben Handler wie HTTP.
 const bearer=randomUUID(),hash=createHash('sha256').update(bearer).digest('hex'),pid=12345;
 await pool.query("INSERT INTO auth_tokens(token_hash,kind,scope) VALUES($1,'service','runtime-daemon:claude')",[hash]);
 await pool.query("INSERT INTO daemon_restore_host_bindings(token_hash,hostname) VALUES($1,'synapse-runtime-claude')",[hash]);
 await pool.query("INSERT INTO agent_runtime_instances(runtime,driver,role,root_path,image,container_name,assigned_to_main) VALUES('claude','claude','main','/test','fixture','synapse-runtime-claude',true)");
 await pool.query("INSERT INTO agent_identitaet_wrapper_status(identity_id,project,agent_name,status,provider,wrapper_pid) VALUES($1,$2,$3,'running','anthropic',$4)",[id,P,agent,pid]);
 await pool.query("INSERT INTO specialist_jobs(project,action,args,status,claimed_by,target_identity_id) VALUES($1,'spawn',$2,'done',$3,$4)",[P,JSON.stringify({target_runtime:'claude'}),origin.daemon_id,id]);
 const routes=new Map(),router={addHook(){},get(path,...args){routes.set('GET '+path,args.at(-1));},post(path,...args){routes.set('POST '+path,args.at(-1));}};
 const {wrapperBridgeRoutes}=await import('../dist/routes/wrapper-bridge.js');await wrapperBridgeRoutes(router);
 const base='/api/projects/:name/specialists/:specName/cache-waechter';
 const request=async(method,path,body,headers={},principal={art:'identity',identity_id:id,agent_id:agent,project:P,rolle:'koordinator',context_epoch:2,lauf_id:lauf})=>{
  let status=200;const reply={code(n){status=n;return this;},send(body){return body;}};
  const r=await C.mitAgentAufrufKontext({principal,bezug:{modus:'beide',quelle:'test'}},()=>routes.get(method+' '+base+path)({
   params:{name:P,specName:agent},headers:{authorization:'Bearer '+bearer,...headers},body},reply));
  return {status,body:r};
 };
 let r=await request('GET','');
 ok(r.status===200&&r.body.aktiv&&r.body.runtime_synapse_mods.aktiv,'REST GET liefert beide aktuellen Freigaben',r);
 const body={lauf_id:lauf,sitzung:sid,wrapper_pid:pid,messung:messung('mod',{messung_ms:now+70}),herkunft:{weg:'tray_daemon',host:'gefaelscht'}};
 r=await request('POST','/mod',body);
 ok(r.status===200&&r.body.angenommen,'REST Mod-POST mit realer Bearer-/PG-/PID-Pruefung',r);
 s=await C.leseCacheWaechterStand(id);
 ok(s.stand.herkunft.weg==='container_runtime'&&s.stand.herkunft.host===origin.host,'REST leitet Herkunft serverseitig ab statt Body zu glauben',s.stand.herkunft);
 ok((await request('POST','/mod',{...body,wrapper_pid:1})).status===409,'falscher Wrapper-PID abgewiesen');
 ok((await request('POST','/mod',{...body,lauf_id:first})).status===409,'alter Lauf am REST-Eingang abgewiesen');
 ok((await request('POST','/mod',body,{authorization:'Bearer fremd'})).status===409,'fremder Runtime-Bearer abgewiesen');
 ok((await request('POST','/mod',body,{}, {art:'legacy',project:P,agent_id:agent})).status===409,'Legacy ohne Ausweis-Lauf abgewiesen');
 ok((await request('POST','',body)).status===409,'Mod-Transcript nicht als Wrapper-Stream akzeptiert');
 await set('runtime_synapse_mods',false);
 r=await request('POST','/mod',body);ok(!r.body.angenommen&&r.body.grund==='runtime_mod_schalter_aus','API prueft Mod-Schalter auch beim Schreiben');
 await set('runtime_synapse_mods',true);await set('cache_waechter',false);
 r=await request('POST','/mod',body);ok(!r.body.angenommen&&r.body.grund==='schalter_aus','API prueft Cache-Schalter auch beim Schreiben');
 console.log('BESTANDEN '+checks+' P22-T194 PG-/REST-Vertraege');
}finally{await pool?.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();}
