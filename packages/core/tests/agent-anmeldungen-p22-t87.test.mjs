/**
 * P22-T87 Stufe 1: admin(action:'anmeldungen') - Anmelde-Uebersicht je Agent (User-Vorgabe thought 9a8d7989).
 * Echte Anmeldungen ueber meldeAgentMitTokenAn (Audit + Lauf), Folgeaufruf ohne Anmeldung zaehlt nicht, Reihenfolge/Epoch/Abstand,
 * Anlass (erste_anmeldung, modellwechsel, neuer_lauf), Kontext (hauptagent_verlauf, wrapper_status, nicht_verfuegbar), erster Aufruf,
 * Filter (agent, seit, limit, nur_letzte), Legacy-Weg, Schalter AUS = funktion_aus, Rechte (User, Koordinator, Legacy-Koordinator, Main,
 * fremder Koordinator, Subagent), Dispatch ueber fuehreW1bAdminAus, keine Ausweiswerte in der Antwort.
 * Nur synapse_test:5433, eigenes privates Schema, keine Modelle/Netz/Daemon/Docker.
 *   node packages/core/tests/agent-anmeldungen-p22-t87.test.mjs
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
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_AUTH_DISABLED','SYNAPSE_W1B_DURCHSETZUNG','SYNAPSE_MAIN_SYNAPSE','SYNAPSE_HAUPTAGENT','SYNAPSE_AGENTEN_AUSWEIS'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',SYNAPSE_TOKEN_IDENTITAET:'1',
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
let network=0;
globalThis.fetch=async()=>{network++;throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t87_'+process.pid+'_'+randomUUID().slice(0,8);
const failures=[];let core,pool,checks=0;
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/gi,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label,detail){checks++;if(!ok){failures.push(label);console.error('FAIL '+label+(detail===undefined?'':' '+mask(JSON.stringify(detail))));}else console.log('ok   '+label);}
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
 await pool.query("CREATE SEQUENCE IF NOT EXISTS agent_ausweis_nr");
 const C=core,USER={art:'user'},P='p87',ANDERES='p87-anderes';
 const vor=min=>new Date(Date.now()-min*60000);
 const bezug=await C.leseAgentBezugModus();
 const A_=(args,akteur=USER)=>C.fuehreAgentAnmeldungenAdminAus('anmeldungen',{project:P,...args},akteur);
 let A,B,L=[];

 await section('Schalter AUS: funktion_aus (Standard bis Abnahme)',async()=>{
  const r=await A_({});
  check(r.success===false&&r.error==='funktion_aus'&&r.schalter?.aktiv===false,'Schalter AUS -> funktion_aus',r);
  check(C.PROFIL_PRODUKT_FUNKTIONEN.includes('agent_anmeldungen')&&C.NUR_AUSDRUECKLICH.includes('agent_anmeldungen'),'agent_anmeldungen im Katalog und nur ausdruecklich');
  const s=await C.leseProfilProduktSchalter('agent_anmeldungen',P);
  check(s.aktiv===false&&s.quelle==='standard','Standard AUS',s);
 });

 await section('Bestand: zwei Ausweis-Identitaeten mit echten Anmeldungen',async()=>{
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'agenten_ausweis',aktiv:true,grund:'Test T87 Ausweis-Kern'},{system:'user'});
  const va=await C.W12_DIENSTE.ausweis.agentVorbereiten({project:P,name:'anm-a',grund:'Test T87 Agent A'},USER);
  const vb=await C.W12_DIENSTE.ausweis.agentVorbereiten({project:P,name:'anm-b',grund:'Test T87 Agent B'},USER);
  A=(await pool.query('SELECT id,agent_id FROM agent_identitaeten WHERE id=$1',[va.identity_id])).rows[0];
  B=(await pool.query('SELECT id,agent_id FROM agent_identitaeten WHERE id=$1',[vb.identity_id])).rows[0];
  for(let n=0;n<3;n++){
   const p=await C.meldeAgentMitTokenAn(va.token,P,bezug);
   L.push(p.lauf_id);
   // Folgeaufruf im selben Lauf: KEINE Anmeldung
   const f=await C.pruefeAgentToken(va.token,P,bezug);
   check(f.lauf_id===p.lauf_id,'Folgeaufruf bleibt im Lauf '+(n+1));
  }
  await C.meldeAgentMitTokenAn(vb.token,P,bezug);
  // Zeiten festlegen: A1 vor 180 min, A2 vor 119 min, A3 vor 10 min; B1 vor 30 min.
  const setze=async(id,epoch,min)=>{
   await pool.query("UPDATE agent_identitaet_audit SET wann=$3 WHERE identity_id=$1 AND aktion='anmelden' AND neu->>'context_epoch'=$2::text",[id,String(epoch),vor(min)]);
   await pool.query('UPDATE agent_identitaet_laeufe SET erstellt_am=$3 WHERE identity_id=$1 AND context_epoch=$2',[id,epoch,vor(min)]);
  };
  await setze(A.id,1,180);await setze(A.id,2,119);await setze(A.id,3,10);await setze(B.id,1,30);
  const tc=(agent,tool,action,ts,iid,lauf,args=null)=>pool.query('INSERT INTO tool_calls (project,agent_id,tool_name,action,ok,ts,identity_id,lauf_id,args_preview) VALUES ($1,$2,$3,$4,true,$5,$6,$7,$8)',[P,agent,tool,action,ts,iid,lauf,args]);
  await tc(A.agent_id,'chat','anmelden',new Date(vor(180).getTime()+1000),A.id,L[0]);
  await tc(A.agent_id,'files','read',vor(150),A.id,L[0]);
  await tc(A.agent_id,'thought','add',vor(120),A.id,L[0]);
  await tc(A.agent_id,'chat','anmelden',new Date(vor(119).getTime()+500),A.id,L[1]);
  const v=(iid,lauf,modell,kontext)=>pool.query("INSERT INTO hauptagent_verlauf (identity_id,rolle,richtung,weg,text,lauf_id,modell,kontext) VALUES ($1,'ausgabe','aus','werkzeug','x',$2,$3,$4)",[iid,lauf,modell,kontext?JSON.stringify(kontext):null]);
  await v(A.id,L[0],'opus',null);
  await v(A.id,L[0],'opus',{tokens:150000,quelle:'gemessen',modell:'opus',fenster:200000,prozent:75,handoff:146000,rotation:176000,hard:176000,schwellen_quelle:'registry'});
  await v(A.id,L[1],'sonnet',null);
  await pool.query("INSERT INTO wrapper_status (agent_name,project,status,tokens_percent,tokens_input,context_ceiling,model,last_activity) VALUES ($1,$2,'running',12.5,25000,200000,'opus',NOW())",[A.agent_id,P]);
  // Legacy: register + index_stats(fortsetzung) zaehlen, chat(get) nicht.
  await tc('legacy-x','chat','register',vor(50),null,null,'{"action":"register","id":"legacy-x"}');
  await tc('legacy-x','admin','index_stats',vor(20),null,null,'{"action":"index_stats","sitzung":"fortsetzung","agent_id":"legacy-x"}');
  await tc('legacy-x','chat','get',vor(5),null,null,'{"action":"get"}');
  check(L.length===3&&new Set(L).size===3&&A&&B,'drei Laeufe fuer A, einer fuer B',{L});
  await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'agent_anmeldungen',aktiv:true,grund:'Test T87 Anmeldungen'},{system:'user'});
 });

 let alle;
 await section('Uebersicht: nur Anmeldungen, Reihenfolge, Felder',async()=>{
  alle=await A_({});
  check(alle.success===true,'Schalter projekt EIN -> success',alle);
  const a=alle.anmeldungen.filter(z=>z.identity_id===A.id),b=alle.anmeldungen.filter(z=>z.identity_id===B.id);
  check(a.length===3&&b.length===1&&alle.anzahl===4,'nur 4 Anmeldungen (Folgeaufrufe zaehlen nicht)',{a:a.length,b:b.length,anzahl:alle.anzahl});
  check(a.map(z=>z.context_epoch).join()==='3,2,1','A juengste zuerst (Epoch 3,2,1)',a.map(z=>z.context_epoch));
  check(a.map(z=>z.lauf_id).join()===[L[2],L[1],L[0]].join(),'lauf_id je Anmeldung');
  check(alle.anmeldungen[0].lauf_id===L[2]&&alle.anmeldungen[1].identity_id===B.id,'gesamt nach Zeit absteigend');
  check(a[0].lauf_status==='aktiv'&&a[1].lauf_status==='abgeloest'&&a[1].abgeloest_am?.iso,'Laufstatus aktiv/abgeloest',a.map(z=>z.lauf_status));
  check(typeof a[0].zeit?.iso==='string'&&/^\d\d\.\d\d\.\d{4}, \d\d:\d\d:\d\d$/.test(a[0].zeit.ortszeit),'Zeit ISO + Ortszeit',a[0].zeit);
  check(a[0].weg==='ausweis'&&a[0].agent===A.agent_id,'Weg ausweis + Agent');
  check(a[2].anlass==='erste_anmeldung'&&a[2].abstand_s===null,'A1 erste_anmeldung',a[2]);
  check(a[1].anlass==='modellwechsel'&&/opus -> sonnet/.test(a[1].anlass_quelle),'A2 modellwechsel (opus -> sonnet)',a[1]);
  check(a[0].anlass==='neuer_lauf'&&/nicht unterscheidbar/.test(a[0].anlass_quelle),'A3 neuer_lauf mit Hinweis',a[0]);
  check(Math.abs(a[1].abstand_s-61*60)<=2&&Math.abs(a[0].abstand_s-109*60)<=2,'Abstand zur vorherigen Anmeldung',[a[1].abstand_s,a[0].abstand_s]);
  check(Math.abs(a[1].pause_vorher_s-60)<=2,'Pause seit letzter Aktivitaet des Vorlaufs ~60 s',a[1].pause_vorher_s);
  check(a[2].aufruf==='chat(anmelden)'&&a[1].aufruf==='chat(anmelden)'&&a[0].aufruf===null,'erster Aufruf des Laufs (tool_calls)',a.map(z=>z.aufruf));
  check(a[2].kontext.quelle==='hauptagent_verlauf'&&a[2].kontext.prozent===75&&a[2].kontext.tokens===150000&&a[2].kontext.fenster===200000&&a[2].kontext.stand==='letzter_im_lauf','A1 Kontext aus Verlauf (75 %)',a[2].kontext);
  check(a[1].kontext.quelle==='nicht_verfuegbar','A2 ohne Kontextstand -> nicht_verfuegbar',a[1].kontext);
  check(a[0].kontext.quelle==='wrapper_status'&&a[0].kontext.prozent===12.5&&a[0].kontext.stand==='aktuell','A3 aktiver Lauf -> wrapper_status',a[0].kontext);
  check(b[0].kontext.quelle==='nicht_verfuegbar'&&b[0].anlass==='erste_anmeldung','B ohne Kontext',b[0]);
  check(alle.quellen?.zeit&&alle.quellen?.kontext&&alle.weg==='ausweis'&&alle.je_agent===10,'Quellen + Standardwerte',alle.quellen);
  check(alle.letzte_je_agent.length===2,'letzte_je_agent je Agent',alle.letzte_je_agent);
  check(!alle.anmeldungen.some(z=>z.agent==='legacy-x'),'Standard nur Ausweis');
  check(!a[0].debug,'ohne debug keine Debug-Felder');
 });

 await section('Filter: agent, limit, nur_letzte, seit',async()=>{
  const n=await A_({anmeldung_agent:'anm-a'});
  check(n.success&&n.anzahl===3&&n.anmeldungen.every(z=>z.identity_id===A.id),'Filter Name',n.anzahl);
  const i=await A_({anmeldung_agent:B.id});
  check(i.success&&i.anzahl===1&&i.anmeldungen[0].identity_id===B.id,'Filter identity_id',i.anzahl);
  const l=await A_({anmeldung_limit:2});
  check(l.anmeldungen.filter(z=>z.identity_id===A.id).length===2&&l.anzahl===3,'limit 2 je Agent',l.anzahl);
  const nl=await A_({anmeldung_nur_letzte:true});
  check(nl.anzahl===2&&nl.anmeldungen.find(z=>z.identity_id===A.id).lauf_id===L[2]&&nl.je_agent===1,'nur_letzte: je Agent die juengste',nl.anzahl);
  check(nl.anmeldungen.find(z=>z.identity_id===A.id).abstand_s>0,'nur_letzte behaelt Abstand zur Vorgaenger-Anmeldung');
  const s=await A_({anmeldung_seit:vor(60).toISOString()});
  check(s.anzahl===2&&s.anmeldungen.every(z=>new Date(z.zeit.iso)>=vor(61)),'seit filtert',s.anzahl);
  check((await A_({anmeldung_limit:0})).error==='limit_ungueltig','limit 0 abgewiesen');
  check((await A_({anmeldung_seit:'gestern'})).error==='seit_ungueltig','seit ungueltig abgewiesen');
  check((await A_({anmeldung_weg:'x'})).error==='weg_unbekannt','weg unbekannt abgewiesen');
 });

 await section('Legacy-Weg',async()=>{
  const g=await A_({anmeldung_weg:'legacy'});
  check(g.success&&g.anzahl===2&&g.anmeldungen.every(z=>z.weg==='legacy'&&z.agent==='legacy-x'),'legacy: register + index_stats, nicht chat get',g.anmeldungen);
  check(g.anmeldungen[0].anlass==='kontextwechsel_fortsetzung'&&g.anmeldungen[1].anlass==='start_register','Legacy-Anlass',g.anmeldungen.map(z=>z.anlass));
  check(g.anmeldungen[0].aufruf==='admin(index_stats, sitzung:fortsetzung)','Legacy-Aufruf',g.anmeldungen[0].aufruf);
  const be=await A_({anmeldung_weg:'beide'});
  check(be.anzahl===6,'beide: 4 Ausweis + 2 Legacy',be.anzahl);
 });

 await section('Debug-Felder',async()=>{
  const d=await A_({anmeldung_debug:true,anmeldung_agent:'anm-a'});
  const z=d.anmeldungen[2];
  check(z.debug&&z.debug.audit_id&&'beginn_art' in z.debug&&z.debug.abgeloest_durch===L[1],'Debug: audit_id, beginn_art, abgeloest_durch',{debug:z.debug,L,laeufe:(await pool.query('SELECT id,context_epoch,status,abgeloest_durch FROM agent_identitaet_laeufe WHERE identity_id=$1 ORDER BY context_epoch',[A.id])).rows});
  check(/hauptagent_verlauf/.test(z.debug.kontext_zuordnung)&&/tool_calls/.test(z.debug.aufruf_zuordnung),'Debug: Zuordnungsweg',z.debug);
  check(d.schalter?.aktiv===true&&d.leser==='user','Debug: Schalter + Leser');
 });

 await section('Rechte',async()=>{
  const ident=(id,name,rolle,project=P)=>pool.query("INSERT INTO agent_identitaeten (id,project,name,agent_id,rolle,erstellt_von) VALUES ($1,$2,$3,$3,$4,'test')",[id,project,name,rolle]);
  await ident('k87','koord-87','koordinator');await ident('k87x','koord-x','koordinator',ANDERES);await ident('s87','sub-87','subagent');
  const pr=(id,name,rolle,project=P)=>({art:'identitaet',principal:{art:'identity',project,agent_id:name,identity_id:id,rolle,modell:null,context_epoch:1,lauf_id:null}});
  check((await A_({},pr('k87','koord-87','koordinator'))).success===true,'Koordinator des Projekts darf lesen');
  check((await A_({},pr('k87x','koord-x','koordinator',ANDERES))).error==='recht_fehlt','fremder Koordinator: recht_fehlt');
  check((await A_({},pr('s87','sub-87','subagent'))).error==='recht_fehlt','Subagent: recht_fehlt');
  check((await A_({},pr('m87','synapse-hauptagent','main','synapse-hauptagent'))).success===true,'Main lesend in fremdem Projekt');
  check((await A_({},{art:'legacy_koordinator',agent_id:'koordinator'})).success===true,'Legacy-Koordinator darf lesen');
  check((await C.fuehreAgentAnmeldungenAdminAus('anmeldungen',{project:P},null)).error==='recht_fehlt','ohne Akteur: recht_fehlt');
  const ohneP=await C.fuehreAgentAnmeldungenAdminAus('anmeldungen',{},pr('k87','koord-87','koordinator'));
  check(ohneP.success===true&&ohneP.project===P,'Koordinator ohne project: eigenes Projekt');
 });

 await section('Dispatch, Parameter, keine Ausweiswerte',async()=>{
  check(C.istW1bAdminAction('anmeldungen')&&C.W1B_ADMIN_ACTIONS.includes('anmeldungen'),'anmeldungen im admin-Weg');
  for(const k of ['anmeldung_agent','anmeldung_seit','anmeldung_limit','anmeldung_nur_letzte','anmeldung_weg','anmeldung_debug'])check(!!C.W1B_ADMIN_PARAMETER[k],'Parameter '+k);
  const d=await C.fuehreW1bAdminAus('anmeldungen',{project:P,anmeldung_weg:'beide',anmeldung_debug:true},{akteur:USER});
  check(d.success===true&&d.action==='anmeldungen'&&d.anzahl===6,'Dispatch fuehreW1bAdminAus',d.anzahl);
  check(!/sai_/i.test(JSON.stringify(d))&&!/sai_/i.test(JSON.stringify(alle)),'keine Ausweiswerte in der Antwort');
  check(!/args_preview|"sitzung":"fortsetzung"/.test(JSON.stringify(d)),'keine Rohargumente in der Antwort');
 });
 check(network===0,'kein Netz',network);
}catch(e){failures.push('Aufbau: '+mask(e.message));console.error(mask(e.stack));}
finally{
 try{await core?.closePool?.();}catch{}
 try{await pool?.end?.();}catch{}
 try{await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}catch(e){console.error('Aufraeumen: '+mask(e.message));}
 await admin.end();
}
console.log(`\n${checks-failures.length}/${checks} Pruefungen ok`+(failures.length?`, FEHLER: ${failures.length}`:''));
if(failures.length){console.error(failures.map(f=>' - '+f).join('\n'));process.exit(1);}
