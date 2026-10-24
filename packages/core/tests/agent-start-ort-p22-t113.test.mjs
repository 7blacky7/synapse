/**
 * P22-T113: Startort jedes Agenten in PG (agent_identitaeten.start_ort), Schalter agent_start_ort Standard AUS.
 * Nur synapse_test:5433, eigenes privates Schema, kein Netz.
 *   node packages/core/tests/agent-start-ort-p22-t113.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_AUTH_DISABLED','SYNAPSE_MAIN_SYNAPSE','SYNAPSE_HAUPTAGENT','SYNAPSE_AGENTEN_AUSWEIS'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
globalThis.fetch=async()=>{throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t113_'+process.pid+'_'+randomUUID().slice(0,8);
const failures=[];let pool,checks=0;
function check(ok,label,detail){checks++;if(!ok){failures.push(label);console.error('FAIL '+label+(detail===undefined?'':' '+JSON.stringify(detail)));}}

try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){
  const q='"'+tablename.replaceAll('"','""')+'"';
  await admin.query('CREATE TABLE '+schema+'.'+q+' (LIKE public.'+q+' INCLUDING ALL)');
 }
 url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.href;
 const C=await load('packages/core/dist/index.js');pool=C.getPool();
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-start-ort-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);await pool.query(sql);
 }
 const P='p113-'+randomUUID().slice(0,6),A=randomUUID(),B=randomUUID(),X=randomUUID();
 const ident=(id,agent,rolle)=>pool.query("INSERT INTO agent_identitaeten(id,project,agent_id,name,rolle,status,erstellt_von) VALUES($1,$2,$3,$3,$4,'aktiv','test-t113')",[id,P,agent,rolle]);
 await ident(A,'spez-container','subagent');await ident(B,'spez-pc','subagent');await ident(X,'koord-cli','koordinator');
 const ort=async id=>(await pool.query('SELECT start_ort,start_ziel,start_ort_quelle FROM agent_identitaeten WHERE id=$1',[id])).rows[0];

 // Schalter AUS: nichts wird geschrieben, Weg unbekannt.
 check((await C.leseProfilProduktSchalter('agent_start_ort',P)).aktiv===false,'agent_start_ort Standard AUS');
 check(await C.merkeStartOrtAusJob({project:P,action:'spawn',args:{identity_id:A,target_runtime:'claude'},quelle:'t'})===false,'AUS schreibt nichts');
 check((await ort(A)).start_ort===null,'AUS: start_ort leer');
 check((await C.zustellWegFuer(A)).weg==='unbekannt','AUS: Weg unbekannt');
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:true,grund:'Test T113 alle'},{system:'user'});
 check((await C.leseProfilProduktSchalter('agent_start_ort',P)).aktiv===false,'alle schaltet agent_start_ort nicht');
 await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'agent_start_ort',aktiv:true,grund:'Test T113 EIN'},{system:'user'});

 // Container-Spawn, PC-Spawn per Name + Claim, Anmeldung extern.
 await C.merkeStartOrtAusJob({project:P,action:'spawn',args:{identity_id:A,target_runtime:'claude'},quelle:'specialist_jobs:auftrag'});
 let o=await ort(A);check(o.start_ort==='container'&&o.start_ziel==='claude','Container-Spawn -> container/claude',o);
 await C.merkeStartOrtAusJob({project:P,action:'spawn',args:{name:'spez-pc'},quelle:'specialist_jobs:auftrag'});
 check((await ort(B)).start_ort==='daemon','PC-Spawn per Name -> daemon');
 await C.merkeStartOrtAusJob({project:P,action:'spawn',args:{name:'spez-pc'},hostname:'pc-1',quelle:'specialist_jobs:claim'});
 o=await ort(B);check(o.start_ziel==='pc-1'&&o.start_ort_quelle==='specialist_jobs:claim','Claim traegt Hostname nach',o);
 check(await C.merkeStartOrtAusJob({project:P,action:'stop',args:{identity_id:A},quelle:'t'})===false,'stop ist kein Start');
 await C.merkeStartOrt({project:P,identity_id:X,ort:'extern',ziel:'CLI (Claude Code)',quelle:'anmeldung'});
 check((await ort(X)).start_ort==='extern','Anmeldung ohne Ort -> extern');
 await C.merkeStartOrt({project:P,identity_id:A,ort:'extern',ziel:'CLI',quelle:'anmeldung'});
 check((await ort(A)).start_ort==='container','extern ueberschreibt Container-Ort nicht');
 await C.merkeStartOrtAusJob({project:P,action:'wake',args:{identity_id:X,target_runtime:'codex'},quelle:'t'});
 check((await ort(X)).start_ort==='container','Daemon-Start ueberschreibt extern');

 // Zustellweg.
 const wa=await C.zustellWegFuer(A),wb=await C.zustellWegFuer(B);
 check(wa.weg==='container_daemon'&&wa.runtime==='claude'&&wa.heartbeat_noetig===false,'Weg Container',wa);
 check(wb.weg==='pc_daemon'&&wb.hostname==='pc-1'&&wb.heartbeat_noetig===false,'Weg PC',wb);
 await C.merkeStartOrt({project:P,identity_id:randomUUID(),ort:'extern',quelle:'t'});
 check((await C.zustellWegFuer(randomUUID())).weg==='unbekannt','unbekannte Identitaet -> unbekannt');

 // Abnahme R1 (6b204c00): wake ohne Ziel loescht den bekannten Host nicht; wake ueberschreibt keinen anderen Ort.
 await C.merkeStartOrtAusJob({project:P,action:'wake',args:{identity_id:B},quelle:'specialist_jobs:auftrag'});
 o=await ort(B);check(o.start_ort==='daemon'&&o.start_ziel==='pc-1','R1 wake ohne Host behaelt pc-1',o);
 await C.merkeStartOrtAusJob({project:P,action:'wake',args:{identity_id:A},quelle:'t'});
 check((await ort(A)).start_ort==='container','R1 wake (PC) ueberschreibt Container-Ort nicht');
 // R1 ueber den echten Weg: enqueueSpecialistJob + claimPendingSpecialistJob (nur PG, kein Daemon).
 await C.enqueueSpecialistJob({project:P,action:'wake',args:{identity_id:B,name:'spez-pc'}}).catch(e=>console.error('enqueue wake',e?.message));
 o=await ort(B);check(o.start_ziel==='pc-1','R1 echter enqueue wake behaelt Host',o);
 const claim=await C.claimPendingSpecialistJob(P,'daemon-test','pc-2').catch(()=>null);
 if(claim){o=await ort(B);check(o.start_ziel==='pc-2'&&o.start_ort_quelle==='specialist_jobs:claim','R1 Claim traegt neuen Host nach',o);}

 // Abnahme R2: spawn_batch je Mitglied (Container-Ziel auf Job-Ebene, PC-Ziel je Mitglied).
 const D=randomUUID(),E=randomUUID();await ident(D,'batch-a','subagent');await ident(E,'batch-b','subagent');
 await C.merkeStartOrtAusJob({project:P,action:'spawn_batch',args:{target_runtime:'codex',specialists:[{name:'batch-a'}]},quelle:'specialist_jobs:auftrag'});
 o=await ort(D);check(o.start_ort==='container'&&o.start_ziel==='codex','R2 spawn_batch Container',o);
 await C.enqueueSpecialistJob({project:P,action:'spawn_batch',args:{specialists:[{name:'batch-b',model:'x',expertise:'x',task:'x'}]}}).catch(e=>console.error('enqueue batch',e?.message));
 check((await ort(E)).start_ort==='daemon','R2 echter enqueue spawn_batch -> daemon');

 // Stufe 2: Anzeige, Art (nur vorbereitet), Vorgabe.
 check(C.startOrtAnzeige({start_ort:'container',start_ziel:'claude'})?.bezeichnung==='Plattform (Container claude)','Anzeige Plattform');
 check(C.startOrtAnzeige({start_ort:'daemon',start_ziel:'pc-1'})?.bezeichnung==='Daemon/Tray (PC pc-1)','Anzeige Daemon/Tray');
 check(C.startOrtAnzeige({start_ort:'extern',start_ziel:'CLI (Claude Code)'})?.bezeichnung.startsWith('Extern'),'Anzeige extern ohne Art');
 check(C.startOrtAnzeige({start_ort:'extern',start_ort_art:'desktop_cli'})?.bezeichnung==='Desktop-CLI','Anzeige Desktop-CLI (vorbereitet)');
 check(C.startOrtAnzeige({start_ort:'extern',start_ort_art:'web_ki',start_ziel:'chatgpt.com'})?.bezeichnung==='Web-KI · chatgpt.com','Anzeige Web-KI (vorbereitet)');
 const v=C.startOrtAnzeige({vorgabe:{ort:'daemon',ziel:'pc-9'}});check(v?.vorgabe===true&&v.bezeichnung.startsWith('Vorgabe:'),'Vorgabe ohne Start',v);
 check(C.startOrtAnzeige({start_ort:'container',start_ziel:'claude',vorgabe:{ort:'daemon'}})?.vorgabe===false,'tatsaechlicher Start schlaegt Vorgabe');
 check(C.startOrtAnzeige({})===null,'nichts bekannt -> null');
 await pool.query("UPDATE agent_identitaeten SET start_ort_art='desktop_cli' WHERE id=$1",[X]);
 await C.merkeStartOrtAusJob({project:P,action:'spawn',args:{identity_id:X,target_runtime:'claude'},quelle:'t'});
 check((await pool.query('SELECT start_ort_art FROM agent_identitaeten WHERE id=$1',[X])).rows[0].start_ort_art===null,'Daemon-Start leert start_ort_art');

 // Stufe 2 Zustell-Takt: ohne lebenden Wrapper keine Kandidaten, kein Wurf.
 const takt=await C.fuehreStartOrtZustellungenAus(Date.now()+60_000);
 check(takt===null||Array.isArray(takt.agenten),'Zustell-Takt wirft nie',takt);

 // Abnahme R4 (a6f599ad): eine VOR dem ersten Takt wartende Inbox-Nachricht wird zuerst zugestellt (Ledger), nicht uebersprungen.
 // Abnahme/Korrektur User: der Heartbeat wird dabei nie umgeschaltet.
 const spalten=async t=>(await pool.query("SELECT column_name,is_nullable,column_default,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2",[schema,t])).rows;
 const fuelle=async(t,w)=>{for(const c of await spalten(t))if(!(c.column_name in w)&&c.is_nullable==='NO'&&c.column_default==null)w[c.column_name]=c.data_type.includes('time')?new Date():c.data_type==='boolean'?false:c.data_type.includes('int')?0:c.data_type==='jsonb'?'{}':'x';
  const k=Object.keys(w);await pool.query('INSERT INTO '+t+'('+k.join(',')+') VALUES('+k.map((_,i)=>'$'+(i+1)).join(',')+')',Object.values(w));};
 await fuelle('specialist_inbox',{project:P,to_identity_id:B,to_agent:'spez-pc',from_agent:'user',content:'wartet schon',processed:false});
 await fuelle('agent_identitaet_wrapper_status',{identity_id:B,project:P,agent_name:'spez-pc',status:'running',heartbeat_enabled:true});
 const hb=async()=>(await pool.query('SELECT heartbeat_enabled FROM agent_identitaet_wrapper_status WHERE identity_id=$1',[B])).rows[0]?.heartbeat_enabled;
 // Zustellung mit sehr kurzer Wartezeit: kein Daemon antwortet -> Nachricht muss als pending im Ledger stehen.
 const erg=await C.fuehreIdentitaetsZustellungAus({identity_id:B,project:P,agent_id:'spez-pc',ziel:{target_hostname:'pc-2'},
  optionen:{aktiv:true,channel_modus:'alle',turn_warte_ms:200},max:1}).catch(e=>({fehler:e?.message}));
 check(erg.gesammelt>=1,'R4 wartende Inbox gesammelt',erg);
 const led=(await pool.query("SELECT status,zustellung FROM agent_zustellungen WHERE identity_id=$1 AND weg='inbox'",[B])).rows;
 check(led.length===1&&led[0].zustellung.inhalt==='wartet schon'&&led[0].zustellung.empfaenger.agent_id==='spez-pc','R4 Ledger enthaelt die wartende Nachricht',led);
 const job=(await pool.query("SELECT args FROM specialist_jobs WHERE project=$1 AND action='zustellen' ORDER BY created_at DESC LIMIT 1",[P])).rows[0];
 check(job?.args?.target_hostname==='pc-2'&&job.args.name==='spez-pc','Zustelljob an den PC-Daemon des Startorts',job?.args);
 check(await hb()===true,'Heartbeat nach Zustellversuch unveraendert EIN');
 await pool.query('UPDATE agent_identitaet_wrapper_status SET heartbeat_enabled=false WHERE identity_id=$1',[B]);
 await C.fuehreStartOrtZustellungenAus(Date.now()+120_000);
 check(await hb()===false,'Heartbeat bewusst AUS bleibt AUS (Takt schaltet nichts)');
 await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'agent_start_ort',aktiv:false,grund:'Test T113 AUS'},{system:'user'});
 await C.fuehreStartOrtZustellungenAus(Date.now()+180_000);
 check(await hb()===false,'Schalter AUS aendert den Heartbeat nicht');

 // Abnahme R6: Takt-Werte aus PG (runtime_ueberwachung-Katalog), ENV nur Rueckfall.
 const werte=await C.leseStartOrtZustellWerte(Date.now(),true);
 check(werte.quelle==='pg'&&werte.takt_ms===5000&&werte.je_takt===3,'Takt-Werte aus PG-Katalog (Standard 5 s / 3)',werte);
}catch(e){failures.push('Ausnahme '+(e?.stack||e));console.error(e);}
finally{
 try{await pool?.end();}catch{}
 try{await admin.query('DROP SCHEMA '+schema+' CASCADE');}catch{}
 await admin.end();
}
console.log((failures.length?'FAIL':'OK')+' P22-T113 '+(checks-failures.length)+'/'+checks);
process.exit(failures.length?1:0);
