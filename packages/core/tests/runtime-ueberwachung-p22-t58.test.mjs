/**
 * P22-T58 (W2e): Runtime-Ueberwachung in der API. Vertrag c1173508, Nachtraege 5045840e, 561ef899, 591c71bd.
 * Prueft mit Fake-Docker-Diensten (kein Docker, kein Netz, keine Modelle):
 *  A Schalter runtime_ueberwachung (Standard AUS = Altverhalten, 'alle' schaltet nicht, nur User ueber REST-Weg)
 *  B Einstellungen (Quelle, Grenzen, entfernen, admin: User/Koordinator/Legacy-Koordinator ja, Subagent nein)
 *  C Bewertung (rein)
 *  D Neustart im Takt, Fencing, Kette Main + Nicht-Main, Wiederbelebung
 *  E automatische Rueckkehr (busy wartet, zweistufig stop -> spawn)
 *  F kein Ziel, Free-Stufe (registrierter Free-Ausfuehrer), Nachzug, Rueckkehr von Free auf ein Abo
 *  G Kontingent (Wrapper-Meldung, Wechsel ohne Fencing, frei), resetZeitMs
 *  H Sperre zweier Instanzen, vom User angehalten
 *  I CLI-Update aus der API
 *  J admin-Modi, Status, hauptagent_status.ueberwachung
 *  K codexLimitAus (agents)
 * Nur synapse_test:5433, eigenes privates Schema.
 *   node packages/core/tests/runtime-ueberwachung-p22-t58.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_HAUPTAGENT','SYNAPSE_AGENTEN_AUSWEIS'])delete process.env[k];
const tmp=await mkdtemp(join(tmpdir(),'p22-t58-'));
Object.assign(process.env,{HOME:tmp,SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
globalThis.fetch=async()=>{throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t58_'+process.pid+'_'+randomUUID().slice(0,8);
const failures=[];let core,pool,checks=0;
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}}
async function section(name,fn){try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}catch(e){failures.push(name+': '+mask(e.message));console.error('FAIL Abschnitt '+name+': '+mask(e.stack));}}

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
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','agent-runtime-auftraege-schema','hauptagent-verlauf-schema','main-warteschlange-schema','runtime-ueberwachung-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);await pool.query(sql);
 }
 await pool.query('CREATE SEQUENCE IF NOT EXISTS agent_ausweis_nr');
 const C=core,USER={art:'user'},HP=C.HAUPTAGENT_PROJEKT,P='p58proj';
 const err=async f=>{try{const r=await f();return r&&r.success===false?r.error:'kein_fehler';}catch(e){return e.code??e.message;}};
 const zugang=async(runtime)=>{
  const h=createHash('sha256').update(runtime+schema).digest('hex');
  await pool.query("INSERT INTO auth_tokens(token_hash,kind,scope,last_used_at) VALUES($1,'service',$2,NOW()) ON CONFLICT (token_hash) DO UPDATE SET last_used_at=NOW()",[h,'runtime-daemon:'+runtime]);
  await pool.query('INSERT INTO daemon_restore_host_bindings(token_hash,hostname) VALUES($1,$2) ON CONFLICT DO NOTHING',[h,'synapse-runtime-'+runtime]);
 };
 for(const [rt,main] of [['claude',true],['codex',false]]){
  await pool.query("INSERT INTO agent_runtime_instances(runtime,driver,role,root_path,image,container_name,assigned_to_main) VALUES($1,$1,'main','/mnt/z/x','img','synapse-runtime-'||$1,$2)",[rt,main]);
 }
 await pool.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,'rest-api','/virtual/'||$1,true)",[P]);
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:true,grund:'Test P22-T58 alle'},{system:'user'});
 await C.setzeHauptagentSchalter(USER,{aktiv:true,grund:'Test P22-T58 EIN'});
 const MAIN=(await C.stelleMainIdentitaetSicher(USER,{modell:'opus',runtime:'claude'})).identity_id;
 const ident=(id,project,name,rolle)=>pool.query('INSERT INTO agent_identitaeten(id,project,name,instanz_nr,agent_id,rolle,erstellt_von) VALUES($1,$2,$3,1,$3,$4,$5)',[id,project,name,rolle,'test']);
 await ident('t58-k',P,'t58-koord','koordinator');await ident('t58-s',P,'t58-sub','subagent');
 await ident('t58-nm',P,'t58-nm','subagent');await ident('t58-y',P,'t58-y','subagent');await ident('t58-z',P,'t58-z','subagent');
 const wrapper=async(id,project,name,status,model,busy=false)=>{
  await pool.query('DELETE FROM agent_identitaet_wrapper_status WHERE identity_id=$1',[id]);
  if(status)await pool.query("INSERT INTO agent_identitaet_wrapper_status(identity_id,project,agent_name,status,busy,last_activity,heartbeat_enabled,model,wrapper_pid,socket_path) VALUES($1,$2,$3,$4,$5,NOW(),true,$6,4242,$7)",
   [id,project,name,status,busy,model,'/projects/'+project+'/.synapse/agents/'+name+'.sock']);
 };
 const spawnJob=async(id,project,name,ziel,model)=>{
  await pool.query("INSERT INTO specialist_jobs(project,action,args,target_identity_id,status) VALUES($1,'spawn',$2::jsonb,$3,'done')",
   [project,JSON.stringify({name,identity_id:id,model,expertise:'Test',task:'Testaufgabe',project,project_path:'/projects/'+project,target_runtime:ziel}),id]);
 };
 const jobs=async(id,action)=>(await pool.query('SELECT id,status,args FROM specialist_jobs WHERE target_identity_id=$1 AND action=$2 ORDER BY created_at DESC',[id,action])).rows;
 const ereignis=async art=>(await pool.query('SELECT runtime,art,ursache,details FROM runtime_ueberwachung_ereignisse WHERE art=$1 ORDER BY id DESC',[art])).rows;
 const umzug=async id=>(await pool.query("SELECT * FROM runtime_ueberwachung_umzuege WHERE identity_id=$1 ORDER BY id DESC LIMIT 1",[id])).rows[0];

 const zust={claude:{container:'laeuft',prozess:'ok'},codex:{container:'laeuft',prozess:'ok'}};
 const calls=[];
 const D={
  beobachte:async rt=>({container:zust[rt].container,prozess:zust[rt].container==='laeuft'?zust[rt].prozess:'unbekannt',status_alter_s:1,image:'synapse-agent-runtime:t',agent_runtime_image:true,fehler:null}),
  starteContainer:async rt=>{calls.push('start:'+rt);zust[rt].container='laeuft';},
  neustartContainer:async rt=>{calls.push('restart:'+rt);},
  mainRuntime:async()=>(await pool.query('SELECT runtime FROM agent_runtime_instances WHERE assigned_to_main')).rows[0]?.runtime??null,
  standardModell:async rt=>rt==='codex'?'codex':'sonnet',
  stoppeContainer:async rt=>{calls.push('stop:'+rt);zust[rt].container='gestoppt';},
  cliUpdate:async rt=>{calls.push('cli:'+rt);return {ok:true,exit_code:0,ausgabe:'aktualisiert'};},
 };
 const takt=o=>C.fuehreUeberwachungsTaktAus(D,o);
 const stand=async rt=>(await C.leseUeberwachungStaende())[rt];
 const setze=werte=>C.setzeRuntimeUeberwachungEinstellungen(USER,null,{werte,grund:'Test P22-T58'});
 const alt=async(rt,feld,sek)=>pool.query(`UPDATE runtime_ueberwachung_stand SET ${feld}=NOW()-make_interval(secs=>$2) WHERE runtime=$1`,[rt,sek]);
 const versucheAlt=async rt=>pool.query("UPDATE runtime_ueberwachung_stand SET versuche=(SELECT COALESCE(jsonb_agg(jsonb_set(v,'{zeit}',to_jsonb((NOW()-INTERVAL '60 seconds')::text))),'[]'::jsonb) FROM jsonb_array_elements(versuche) v) WHERE runtime=$1",[rt]);
 const reset=async()=>{
  await pool.query('DELETE FROM runtime_ueberwachung_stand');await pool.query('DELETE FROM runtime_ueberwachung_umzuege');
  await pool.query("UPDATE agent_runtime_auftraege SET status='cancelled' WHERE status IN ('pending','claimed','accepted')");
  await pool.query('DELETE FROM agent_identitaet_wrapper_status');
  await pool.query("UPDATE specialist_jobs SET status='done' WHERE status IN ('pending','running')");
  zust.claude={container:'laeuft',prozess:'ok'};zust.codex={container:'laeuft',prozess:'ok'};calls.length=0;
  await zugang('claude');await zugang('codex');
 };

 await section('A Schalter',async()=>{
  const s0=await C.leseRuntimeUeberwachungSchalter();
  check(!s0.aktiv&&s0.quelle==='standard','Standard AUS');
  const r=await takt();
  check(r.uebersprungen==='schalter_aus'&&calls.length===0,'AUS: kein Takt, keine Massnahme (Altverhalten)');
  const t=await takt({trocken:true});
  check(!t.uebersprungen&&t.runtimes.length===2,'trocken bewertet auch bei AUS');
  check(Number((await pool.query('SELECT count(*) FROM runtime_ueberwachung_stand')).rows[0].count)===0,'trocken schreibt keinen Stand');
  check(!(await C.leseRuntimeUeberwachungSchalter()).aktiv,"'alle' schaltet runtime_ueberwachung nicht");
  check(await err(()=>C.setzeRuntimeUeberwachungSchalter({art:'identitaet',principal:{art:'identity',identity_id:'t58-k',project:P,rolle:'koordinator'}},{aktiv:true,grund:'Test P22-T58'}))==='recht_fehlt','REST-Weg nur User');
  const s1=await C.setzeRuntimeUeberwachungSchalter(USER,{aktiv:true,grund:'Test P22-T58 EIN'});
  check(s1.aktiv&&s1.quelle==='produkt-schalter','User schaltet EIN (Produkt-Schalter)');
 });

 const KOORD={art:'identitaet',principal:{art:'identity',identity_id:'t58-k',project:P,rolle:'koordinator',agent_id:'t58-koord'}};
 const SUB={art:'identitaet',principal:{art:'identity',identity_id:'t58-s',project:P,rolle:'subagent',agent_id:'t58-sub'}};
 const adm=(args,akteur)=>C.fuehreW1bAdminAus('runtime_ueberwachung',args,{akteur});

 await section('B Einstellungen',async()=>{
  const e=await C.leseRuntimeUeberwachungEinstellungen();
  check(e.takt_sekunden.wert===15&&e.takt_sekunden.quelle==='standard','Standard mit Quelle');
  check(e.zurueck_automatisch.wert===true&&e.wiederbelebung_minuten.wert===10&&e.container_memory_mb.wert===2048&&e.cli_behalten.wert===4,'Standards laut Vertrag');
  check(!('cli_autoupdate' in e),'cli_autoupdate entfallen (Update aus der API)');
  const s=await setze({takt_sekunden:20});
  check(s.takt_sekunden.wert===20&&s.takt_sekunden.quelle==='einstellung'&&s.takt_sekunden.gesetzt_von==='user','setzen -> Quelle einstellung');
  check(await err(()=>setze({takt_sekunden:1}))==='einstellung_ungueltig','Grenze');
  check(await err(()=>setze({gibtsnicht:1}))==='einstellung_unbekannt','unbekannt');
  check(await err(()=>setze({failover_reihenfolge:['claude','gemini']}))==='einstellung_ungueltig','Reihenfolge nur bekannte Runtimes');
  check(await err(()=>setze({failover_reihenfolge:['claude','claude']}))==='einstellung_ungueltig','Reihenfolge ohne Doppel');
  check(await err(()=>C.setzeRuntimeUeberwachungEinstellungen(USER,null,{werte:{takt_sekunden:20}}))==='grund_fehlt','Grund Pflicht');
  const k=await adm({project:P,ueberwachung_modus:'setzen',ueberwachung_werte:{takt_sekunden:30},grund:'Test P22-T58 Koordinator'},KOORD);
  check(k.success&&k.einstellungen.takt_sekunden.wert===30&&k.einstellungen.takt_sekunden.gesetzt_von==='t58-k','Koordinator setzt (F6)');
  check((await adm({project:P,ueberwachung_modus:'status'},SUB)).error==='recht_fehlt','Subagent: recht_fehlt');
  const l=await adm({project:P,agent_id:'koordinator',ueberwachung_modus:'entfernen',ueberwachung_namen:['takt_sekunden'],grund:'Test P22-T58 Legacy'},null);
  check(l.success&&l.einstellungen.takt_sekunden.quelle==='standard','Legacy-Koordinator entfernt -> Code-Standard');
  check((await adm({ueberwachung_modus:'gibtsnicht'},USER)).error==='modus_unbekannt','unbekannter Modus');
 });

 await section('C Bewertung',async()=>{
  const e=await C.leseRuntimeUeberwachungWerte();
  const s=(x={})=>({runtime:'claude',zustand:'ok',ursache:null,seit:new Date().toISOString(),letzter_ok:null,versuche:[],container_soll_laufen:true,main_laeuft_seit:null,
   beobachtung:null,letzter_fehler:null,wiederbelebung_letzter:null,cli_update_am:null,cli_update_ergebnis:null,kontingent_bis:null,...x});
  const b=(x={})=>({container:'laeuft',prozess:'ok',status_alter_s:1,image:null,agent_runtime_image:true,fehler:null,api_verbunden:true,ack_haengt:false,ist_main:false,
   main_wrapper:null,main_soll_laufen:false,...x});
  const B=(bx,sx)=>C.bewerteRuntime(b(bx),s(sx),e);
  check(B().zustand==='ok'&&B().massnahme==='keine','gesund -> ok');
  check(B({container:'fehlt'},{container_soll_laufen:false}).zustand==='angehalten'&&B({container:'fehlt'},{container_soll_laufen:false}).massnahme==='keine','fehlt, nie gelaufen -> nichts');
  check(B({container:'fehlt'}).massnahme==='container_start'&&B({container:'gestoppt'}).massnahme==='container_start','fehlt/gestoppt + soll laufen -> Start');
  check(B({container:'fremd'}).massnahme==='keine'&&B({container:'fremd'}).ursache==='container_fremd','fremder Container: nur melden');
  check(B({prozess:'haengt'}).massnahme==='container_restart'&&B({prozess:'daemon_tot'}).massnahme==='container_restart','haengt/tot -> docker restart');
  check(B({api_verbunden:false}).ursache==='api_getrennt'&&B({api_verbunden:false}).massnahme==='keine','API getrennt: nur melden');
  check(B({ack_haengt:true}).ursache==='ack_haengt','ACK haengt');
  check(B({ist_main:true,main_soll_laufen:true,main_wrapper:'aus'}).massnahme==='wrapper_respawn','Main-Wrapper tot -> Respawn');
  check(B({ist_main:true,main_soll_laufen:false,main_wrapper:'aus'}).massnahme==='keine','Main nie gelaufen/gestoppt -> kein Respawn');
  check(B({kontingent_erschoepft:true}).zustand==='erschoepft'&&B({kontingent_erschoepft:true}).massnahme==='failover_faellig','Kontingent -> erschoepft');
  check(B({container:'gestoppt'},{zustand:'abgeloest'}).zustand==='abgeloest'&&B({container:'gestoppt'},{zustand:'abgeloest'}).massnahme==='keine','abgeloest: kein normaler Neustart');
  check(B({},{zustand:'abgeloest'}).zustand==='ok','abgeloest + gesund -> ok');
  const jetzt=new Date().toISOString(),vor=new Date(Date.now()-300_000).toISOString();
  check(B({prozess:'daemon_tot'},{versuche:[{zeit:jetzt,art:'container_restart',ursache:'daemon_tot'}]}).zustand==='neustart_laeuft','Erholungszeit abwarten');
  const aus=B({prozess:'daemon_tot'},{versuche:[{zeit:vor,art:'container_restart',ursache:'x'},{zeit:vor,art:'container_restart',ursache:'x'}]});
  check(aus.zustand==='ausgefallen'&&aus.massnahme==='failover_faellig','Versuche ausgeschoepft -> ausgefallen (alle Agenten)');
  const ohne=C.bewerteRuntime(b({prozess:'haengt'}),s(),{...e,neustart_erlaubt:false});
  check(ohne.massnahme==='keine'&&ohne.hinweis==='neustart_aus','neustart_erlaubt AUS');
 });

 await section('D Neustart, Fencing, Kette',async()=>{
  await reset();
  await setze({erholung_warte_sekunden:15});
  let r=await takt();
  check(r.aktiv&&r.runtimes.every(z=>z.entscheidung?.zustand==='ok'),'beide ok: '+JSON.stringify(r.runtimes.map(z=>[z.runtime,z.entscheidung?.zustand,z.entscheidung?.ursache,z.fehler])));
  check((await stand('claude')).container_soll_laufen,'laufend gesehen -> soll laufen');
  check((await ereignis('erkannt_ok')).length===2,'Ereignis erkannt_ok');
  zust.claude.prozess='daemon_tot';
  await takt();
  check(calls.includes('restart:claude')&&(await stand('claude')).versuche.length===1,'daemon_tot -> docker restart');
  calls.length=0;await takt();
  check(!calls.includes('restart:claude')&&(await stand('claude')).zustand==='neustart_laeuft','zweiter Takt wartet die Erholung ab');
  await versucheAlt('claude');await takt();
  check(calls.includes('restart:claude')&&(await stand('claude')).versuche.length===2,'zweiter Versuch nach der Erholungszeit');
  // Agenten im Claude-Container: Main + ein Nicht-Main
  await wrapper(MAIN,HP,'hauptagent','running','opus');
  await wrapper('t58-nm',P,'t58-nm','idle','opus');await spawnJob('t58-nm',P,'t58-nm','claude','opus');
  await versucheAlt('claude');calls.length=0;
  r=await takt();
  check(calls.includes('stop:claude'),'Fencing: alter Container angehalten');
  const sc=await stand('claude');
  check(sc.zustand==='abgeloest'&&!sc.container_soll_laufen,'Zustand abgeloest, soll nicht laufen');
  const a=(await pool.query("SELECT gewuenscht,erstellt_von,status FROM agent_runtime_auftraege WHERE identity_id=$1 AND art='runtime_wechsel' ORDER BY erstellt_am DESC LIMIT 1",[MAIN])).rows[0];
  check(a?.gewuenscht?.runtime==='codex'&&a.gewuenscht.failover==='ja'&&a.erstellt_von==='runtime-ueberwachung'&&a.status==='pending','Main: runtime_wechsel mit failover an Codex');
  check(a?.gewuenscht?.modell==='codex','Main: Modell passend zu Codex');
  const w=(await pool.query('SELECT status FROM agent_identitaet_wrapper_status WHERE identity_id=$1',['t58-nm'])).rows[0];
  check(w?.status==='crashed','Nicht-Main: Wrapper-Zeile crashed (CAS)');
  const sp=(await jobs('t58-nm','spawn'))[0];
  check(sp?.status==='pending'&&sp.args.target_runtime==='codex'&&sp.args.model==='codex'&&sp.args.project_path==='/projects/'+P&&sp.args.name==='t58-nm'&&sp.args.task==='Testaufgabe','Nicht-Main: spawn auf Codex mit alten Args');
  check(!JSON.stringify(sp?.args??{}).includes('sai_'),'kein Ausweis in Job-args');
  const u=await umzug('t58-nm');
  check(u?.status==='aktiv'&&u.ursprung_runtime==='claude'&&u.nach_runtime==='codex'&&u.modell_ursprung==='opus','Umzug protokolliert');
  check((await ereignis('abgeloest')).length===1&&(await ereignis('umzug')).length===2,'Ereignisse abgeloest + 2x umzug');
  calls.length=0;await takt();
  check(!calls.includes('start:claude')&&(await jobs('t58-nm','spawn')).length===2,'abgeloest: kein Neustart, kein zweiter Umzug');
  zust.claude.prozess='ok';await alt('claude','wiederbelebung_letzter',3600);
  await takt();
  check(calls.includes('start:claude'),'Wiederbelebung nach wiederbelebung_minuten');
 });

 await section('E Rueckkehr',async()=>{
  await pool.query("UPDATE agent_runtime_auftraege SET status='completed' WHERE identity_id=$1 AND status='pending'",[MAIN]);
  await wrapper('t58-nm',P,'t58-nm','running','codex',true);
  calls.length=0;
  const r=await takt();
  check((await stand('claude')).zustand==='ok','Claude wieder ok');
  const a=(await pool.query("SELECT gewuenscht,status FROM agent_runtime_auftraege WHERE identity_id=$1 AND art='runtime_wechsel' AND status='pending'",[MAIN])).rows[0];
  check(a?.gewuenscht?.runtime==='claude'&&a.gewuenscht.modell==='opus'&&!a.gewuenscht.failover,'Main: zurueck zu Claude mit Ursprungsmodell, ohne failover');
  check((await umzug(MAIN))?.status==='zurueck','Main-Umzug abgeschlossen');
  check(r.kette.some(k=>k.art==='warten_busy'&&k.identity_id==='t58-nm')&&(await umzug('t58-nm')).status==='aktiv','Nicht-Main busy -> wartet');
  await wrapper('t58-nm',P,'t58-nm','idle','codex',false);
  await takt();
  const u=await umzug('t58-nm'),stop=(await jobs('t58-nm','stop'))[0];
  check(u.status==='zurueck_stop'&&stop?.args.target_runtime==='codex'&&u.rueck_ziel==='claude','stop-Job auf Codex');
  await takt();
  check((await jobs('t58-nm','spawn')).filter(j=>j.args.target_runtime==='claude'&&j.status==='pending').length===0,'solange stop offen: kein spawn');
  await pool.query("UPDATE specialist_jobs SET status='done' WHERE id=$1",[stop.id]);
  await takt();
  const sp=(await jobs('t58-nm','spawn'))[0];
  check(sp.args.target_runtime==='claude'&&sp.args.model==='opus','spawn auf Claude mit Ursprungsmodell');
  check((await umzug('t58-nm')).status==='zurueck','Umzug zurueck');
 });

 await section('F kein Ziel, Free-Stufe, Nachzug',async()=>{
  await reset();await setze({neustart_versuche:0});
  await takt();
  await wrapper('t58-y',P,'t58-y','idle','codex');await spawnJob('t58-y',P,'t58-y','codex','codex');
  zust.claude.prozess='daemon_tot';zust.codex.prozess='daemon_tot';
  let r=await takt();
  check(calls.includes('stop:claude')&&calls.includes('stop:codex'),'beide gefenct');
  const kz=r.kette.find(k=>k.art==='kein_ziel'&&k.identity_id==='t58-y');
  check(!!kz&&kz.uebersprungen.some(u=>u.runtime==='free-pool'&&u.grund==='free_worker_fehlt'),'kein Ziel: Free-Stufe ohne Worker uebersprungen');
  check((await ereignis('failover_kein_ziel')).length>=1,'Ereignis failover_kein_ziel');
  const free=[];
  C.registriereFreeAusfuehrer({verfuegbar:async()=>({ja:true}),uebernehme:async x=>{free.push('ueb:'+x.identity_id);return {job_id:'free-1'};},beende:async x=>{free.push('ende:'+x.identity_id);}});
  const n=(await ereignis('failover_kein_ziel')).length;
  r=await takt();
  check(free.includes('ueb:t58-y')&&(await umzug('t58-y'))?.nach_runtime==='free-pool','Nachzug: Free uebernimmt');
  check((await ereignis('failover_kein_ziel')).length===n,'Nachzug ohne neue kein_ziel-Ereignisse');
  check((await C.leseRuntimeUeberwachung()).free_stufe==='registriert','Status zeigt Free-Stufe');
  zust.claude.prozess='ok';await alt('claude','wiederbelebung_letzter',3600);
  await takt();await takt();
  check((await stand('claude')).zustand==='ok','Claude wiederbelebt');
  const u=await umzug('t58-y');
  check(free.includes('ende:t58-y')&&u.nach_runtime==='claude'&&u.status==='aktiv'&&u.ursprung_runtime==='codex','von Free auf ein verfuegbares Abo (Ursprung bleibt Codex)');
  check((await jobs('t58-y','spawn'))[0].args.target_runtime==='claude','spawn auf Claude');
  C.registriereFreeAusfuehrer(null);
  await setze({neustart_versuche:2});
 });

 await section('G Kontingent',async()=>{
  await reset();await takt();
  await wrapper('t58-z',P,'t58-z','idle','sonnet');await spawnJob('t58-z',P,'t58-z','claude','sonnet');
  const reset1=Math.round(Date.now()/1000)+3600;
  const m=await C.meldeRuntimeKontingent({runtime:'claude',status:'rejected',resets_at:reset1,art:'five_hour',project:P,agent:'t58-z'});
  check(m.gemeldet&&Math.abs(Date.parse(m.kontingent_bis)-reset1*1000)<2000,'rejected mit resetsAt (Sekunden)');
  await C.meldeRuntimeKontingent({runtime:'claude',status:'rejected',resets_at:reset1,art:'five_hour',project:P,agent:'t58-z'});
  check((await ereignis('kontingent_erschoepft')).length===1,'ein Ereignis je Erschoepfung');
  calls.length=0;
  await takt();
  check((await stand('claude')).zustand==='erschoepft'&&!calls.includes('stop:claude'),'erschoepft, KEIN Fencing');
  const u=await umzug('t58-z'),stop=(await jobs('t58-z','stop'))[0];
  check(u?.status==='wechsel_stop'&&u.rueck_ziel==='codex'&&stop?.args.target_runtime==='claude','Wechsel: erst stop auf Claude');
  await pool.query("UPDATE specialist_jobs SET status='done' WHERE id=$1",[stop.id]);
  await wrapper('t58-z',P,'t58-z','stopped','sonnet');
  await takt();
  const sp=(await jobs('t58-z','spawn'))[0];
  check(sp.args.target_runtime==='codex'&&sp.args.model==='codex'&&(await umzug('t58-z')).nach_runtime==='codex'&&(await umzug('t58-z')).status==='aktiv','dann spawn auf Codex');
  await setze({kontingent_ausloeser:false});await takt();
  check((await stand('claude')).zustand==='ok','kontingent_ausloeser AUS -> kein Ausloeser');
  await setze({kontingent_ausloeser:true});
  const f=await C.meldeRuntimeKontingent({runtime:'claude',status:'allowed',project:P,agent:'t58-z'});
  check(f.gemeldet&&f.kontingent_bis===null&&(await ereignis('kontingent_frei')).length===1,'allowed -> frei');
  await wrapper('t58-z',P,'t58-z','idle','codex');
  await takt();
  check((await umzug('t58-z')).status==='zurueck_stop','nach Freigabe Rueckkehr (stop auf Codex)');
  const ohne=await C.meldeRuntimeKontingent({runtime:'codex',status:'rejected',project:P,agent:'x'});
  check(Math.abs(Date.parse(ohne.kontingent_bis)-(Date.now()+60*60_000))<5000,'ohne resetsAt: kontingent_ohne_reset_minuten');
  check(!(await C.meldeRuntimeKontingent({runtime:'free-pool',status:'rejected',project:P,agent:'x'})).gemeldet,'unbekannte Runtime ignoriert');
  check(C.resetZeitMs(1700000000)===1700000000000&&C.resetZeitMs(1700000000123)===1700000000123&&C.resetZeitMs('1700000000')===1700000000000
   &&C.resetZeitMs('2026-10-20T10:00:00Z')===Date.parse('2026-10-20T10:00:00Z')&&C.resetZeitMs(null)===null,'resetZeitMs');
 });

 await section('H Sperre, angehalten',async()=>{
  await reset();await takt();
  const c=await pool.connect();
  await c.query('SELECT pg_advisory_lock(hashtext($1))',['synapse-runtime-ueberwachung']);
  const r=await takt();
  check(r.uebersprungen==='andere_instanz','zweite Instanz handelt nicht');
  await c.query('SELECT pg_advisory_unlock(hashtext($1))',['synapse-runtime-ueberwachung']);c.release();
  await C.markiereRuntimeAngehalten('codex','user:stop');
  zust.codex.container='gestoppt';calls.length=0;
  await takt();
  check(!calls.includes('start:codex')&&(await stand('codex')).zustand==='angehalten','vom User angehalten -> kein Start');
  check((await ereignis('angehalten')).length>=1,'Ereignis angehalten');
 });

 await section('I CLI-Update',async()=>{
  await reset();await takt();calls.length=0;
  let r=await C.fuehreCliUpdatesAus(D);
  check(calls.includes('cli:claude')&&calls.includes('cli:codex')&&r.every(x=>x.ok===true),'beide aktualisiert');
  check(!!(await stand('claude')).cli_update_am&&(await ereignis('cli_update')).length>=2,'Stand + Ereignis');
  calls.length=0;r=await C.fuehreCliUpdatesAus(D);
  check(calls.length===0&&r.every(x=>x.uebersprungen==='nicht_faellig'),'nicht faellig');
  r=await C.fuehreCliUpdatesAus(D,{erzwingen:true});
  check(calls.length===2,'erzwingen');
  await setze({cli_update_automatisch:false});
  check((await C.fuehreCliUpdatesAus(D))[0]?.uebersprungen==='cli_update_aus','cli_update_automatisch AUS');
  await setze({cli_update_automatisch:true});
  await takt();
  const sv=await stand('claude');
  check(!!sv.cli_update_am,'Takt ueberschreibt cli_update_am nicht');
  // P22-T60 (H1, User 90b05805): Schalter AUS -> CLI-Update laeuft trotzdem (eigene Beobachtung, Stempel per Upsert ohne Takt-Zeile).
  await C.setzeRuntimeUeberwachungSchalter(USER,{aktiv:false,grund:'Test P22-T60 AUS'});
  await pool.query('DELETE FROM runtime_ueberwachung_stand');calls.length=0;
  zust.codex.container='gestoppt';
  r=await C.fuehreCliUpdatesAus(D);
  check(calls.includes('cli:claude')&&!calls.includes('cli:codex'),'AUS: laufender Container aktualisiert, gestoppter nicht');
  check(r.find(x=>x.runtime==='codex')?.uebersprungen==='container_gestoppt','AUS: Grund container_gestoppt');
  check(!!(await stand('claude')).cli_update_am&&!(await stand('codex')).cli_update_am,'AUS: Stempel per Upsert ohne Takt-Zeile');
  calls.length=0;r=await C.fuehreCliUpdatesAus(D);
  check(!calls.includes('cli:claude')&&r.find(x=>x.runtime==='claude')?.uebersprungen==='nicht_faellig','AUS: Faelligkeit gilt');
  check(!calls.some(c=>c.startsWith('start:')||c.startsWith('restart:')),'AUS: keine Massnahme am Container');
  zust.codex.container='laeuft';
  await C.setzeRuntimeUeberwachungSchalter(USER,{aktiv:true,grund:'Test P22-T60 EIN'});
 });

 await section('J admin und Status',async()=>{
  C.registriereUeberwachungsDienste(D);
  const t=await adm({ueberwachung_modus:'takt_trocken'},USER);
  check(t.success&&t.bericht.trocken===true,'admin takt_trocken');
  check((await adm({ueberwachung_modus:'takt_jetzt'},USER)).error==='grund_fehlt','takt_jetzt braucht Grund');
  const j=await adm({ueberwachung_modus:'takt_jetzt',grund:'Test P22-T58 Takt'},USER);
  check(j.success&&j.bericht.aktiv===true,'admin takt_jetzt');
  const st=await adm({ueberwachung_modus:'status'},USER);
  check(st.success&&Array.isArray(st.runtimes)&&Array.isArray(st.umzuege)&&st.takt_in_diesem_prozess===true&&!!st.einstellungen,'Status vollstaendig');
  const hs=await C.hauptagentStatus(USER);
  check(hs.ueberwachung?.aktiv===true&&Array.isArray(hs.ueberwachung.runtimes),'hauptagent_status.ueberwachung');
  C.registriereUeberwachungsDienste(null);
  check((await adm({ueberwachung_modus:'takt_jetzt',grund:'Test P22-T58 Takt'},USER)).error==='takt_nicht_in_diesem_prozess','ohne Dienste kein Takt');
  check(C.W1B_ADMIN_ACTIONS.includes('runtime_ueberwachung')&&!!C.W1B_ADMIN_PARAMETER.ueberwachung_modus,'admin-Aktion und Parameter registriert');
 });

 await section('K codexLimitAus',async()=>{
  const A=await load('packages/agents/dist/codex-runtime.js');
  const t0=Date.parse('2026-10-20T10:00:00Z');
  const a=A.codexLimitAus("You've hit your usage limit. Try again in 2 days 3 hours 5 minutes.",t0);
  check(a&&a.resetsAt===Math.round(t0/1000)+2*86400+3*3600+5*60,'relative Reset-Zeit');
  check(A.codexLimitAus('Usage limit reached. Upgrade to Pro.',t0)?.resetsAt===null,'ohne Zeitangabe -> null');
  check(A.codexLimitAus('codex endete mit Exit-Code 1',t0)===null,'anderer Fehler -> kein Limit');
 });
}finally{
 await core?.closePool?.().catch(()=>undefined);
 await pool?.end?.().catch(()=>undefined);
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>undefined);
 await admin.end();
}
console.log(`P22-T58: ${checks-failures.length}/${checks} Pruefungen bestanden`);
if(failures.length){console.error('FEHLER:\n- '+failures.join('\n- '));process.exit(1);}
