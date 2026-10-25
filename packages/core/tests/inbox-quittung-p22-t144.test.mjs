/**
 * P22-T144: Inbox-Zustellung mit Quittungs-ID, Quittieren, Erinnerung nach Neuanmeldung, Daemon-Wechsel (Fehlerfix).
 * Fake-PC-Daemon (claimt specialist_jobs mit target_hostname wie der Daemon und baut den Text mit dem echten zustell-text.ts).
 *  A Schema 123 additiv (Spalten, idempotent, Spiegel SQL = TS)
 *  B Schalter inbox_quittung AUS: Zustellung wie heute (keine Quittung, kein Text-Zusatz, quittieren abgewiesen, nicht beworben)
 *  C Schalter EIN: Quittungs-ID im Job und im Text, quittung_seit gesetzt, beworben
 *  D quittieren eigen ok / fremd abgewiesen / doppelt idempotent / ungueltig; get per Quittung nur eigen
 *  E Erinnerung: gleiche Sitzung keine; neue daemon_id genau eine (nur IDs, kein Inhalt), danach keine weitere; nichts offen -> keine
 *  F nie zugestellte Nachricht -> normale Zustellung nach dem Wiederverbinden (keine Erinnerung)
 *  G Daemon-Wechsel: running-Job des alten Daemons -> failed daemon_neugestartet, Wartender sofort frei, pending sofort faellig;
 *    Job des aktuellen Daemons unberuehrt; Mod-Weg wartet 45 s statt Turnfrist
 * Nur synapse_test:5433, eigenes privates Schema, kein Netz.
 *   node --experimental-strip-types packages/core/tests/inbox-quittung-p22-t144.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||process.env.SYNAPSE_DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_HAUPTAGENT_TURN_MS','SYNAPSE_HAUPTAGENT_ZUSTELLUNG'])delete process.env[k];
const tmp=await mkdtemp(join(tmpdir(),'p22-t144-'));
Object.assign(process.env,{HOME:tmp,SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
globalThis.fetch=async()=>{throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t144_'+process.pid+'_'+randomUUID().slice(0,8);
const failures=[];let core,pool,checks=0;
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}}
async function section(name,fn){try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}catch(e){failures.push(name+': '+mask(e.message));console.error('FAIL Abschnitt '+name+': '+mask(e.stack));}}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const ergebnis=obj=>({content:[{type:'text',text:JSON.stringify(obj)}]});

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
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','agent-runtime-auftraege-schema','agent-zustellungen-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);await pool.query(sql);
 }
 const C=core;
 const Q=await load('packages/core/dist/services/inbox-quittung.js');
 const M=await load('packages/core/dist/services/mod-inbox.js');
 const Z=await load('packages/file-watcher-daemon-ts/src/zustell-text.ts');
 const P='p144-'+randomUUID().slice(0,6),HOST='host-t144',A='id-a-'+randomUUID().slice(0,8),B='id-b-'+randomUUID().slice(0,8);
 for(const [id,name]of [[A,'agent-a'],[B,'agent-b']])
  await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,erstellt_von) VALUES($1,$2,$3,$3,'subagent','test')",[id,P,name]);
 const schalter=async(funktion,aktiv)=>{
  await pool.query("DELETE FROM agent_profil_schalter WHERE ebene='global' AND funktion=$1",[funktion]);
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,$1,$2,'T144 Testfixture','user')",[funktion,aktiv]);
 };
 const inbox=async(an,text,von='koord')=>Number((await pool.query("INSERT INTO specialist_inbox(project,from_agent,to_agent,content,to_identity_id) VALUES($1,$2,'agent-a',$3,$4) RETURNING id",[P,von,text,an])).rows[0].id);
 // Fake-PC-Daemon: claimt Jobs fuer HOST; modus steuert die Antwort.
 let modus='zustellen';const erhalten=[];let daemonAus=false;
 const DAEMON='daemon-'+HOST+'-1';
 const lauf=(async()=>{while(!daemonAus){
  const job=await C.claimPendingSpecialistJob(P,DAEMON,HOST).catch(()=>null);
  if(!job){await pause(30);continue;}
  const z=job.args.zustellung;
  if(job.action!=='zustellen'){await C.completeSpecialistJob(job.id,{status:'failed',error:'x'});continue;}
  if(modus==='nicht_verbunden'){await C.completeSpecialistJob(job.id,{status:'done',result:ergebnis({success:true,zugestellt:false,grund:'nicht_verbunden'})});continue;}
  erhalten.push({z,text:Z.baueZustellText(z),schluessel:Z.zustellSchluessel(z),identity:job.args.identity_id});
  await C.completeSpecialistJob(job.id,{status:'done',result:ergebnis({success:true,zugestellt:true,weg:'mod_inbox'})});
 }})();
 let t=Date.now();
 const melde=(sitzung,daemon_id=DAEMON,id=A)=>M.meldeModSitzung({host:HOST,sitzung,identity_id:id,daemon_id,jetzt:t});
 const takt=async()=>{t+=10_000;await pool.query("UPDATE agent_zustellungen SET naechster_versuch=NOW() WHERE status='pending'");return M.fuehreModInboxZustellungenAus(t);};
 const S1=randomUUID(),S2=randomUUID();
 await schalter('mod_inbox',true);

 await section('A Schema 123 additiv',async()=>{
  const sp=(await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='agent_zustellungen'",[schema])).rows.map(r=>r.column_name);
  check(['quittung_seit','quittiert_am','erinnert_am'].every(s=>sp.includes(s)),'Spalten quittung_seit/quittiert_am/erinnert_am');
  const sql=await readFile(join(repo,'packages/core/src/db/schema-sql/123_agent_zustellungen.sql'),'utf8');
  const ts=(await load('packages/core/dist/db/agent-zustellungen-schema.js')).AGENT_ZUSTELLUNGEN_SCHEMA_SQL;
  check(sql.trim()===ts.trim(),'Spiegel 123 SQL = TS-Konstante');
  check(!/\b(DROP|DELETE|TRUNCATE|UPDATE)\b/i.test(sql.replace(/--.*$/gm,'')),'nur additiv');
  check(C.MOD_TURN_WARTE_MS===45_000&&M.MOD_TURN_WARTE_MS===45_000,'Mod-Weg wartet 45 s statt Turnfrist');
 });

 await section('B Schalter AUS: wie heute',async()=>{
  await schalter('inbox_quittung',false);
  check((await melde(S1)).aktiv===true,'Sitzung gemeldet');
  await takt(); // erster Lauf: verlustfreier Start
  const id=await inbox(A,'NACHRICHT-AUS');
  erhalten.length=0;await takt();
  const e=erhalten.find(x=>x.z.message_id===id);
  check(!!e&&e.z.quittung===undefined&&!e.text.includes('Quittung')&&!e.text.includes('quittieren'),'keine Quittung im Job/Text');
  check((await pool.query("SELECT quittung_seit FROM agent_zustellungen WHERE identity_id=$1 AND message_id=$2",[A,id])).rows[0]?.quittung_seit===null,'quittung_seit bleibt leer');
  const q=await Q.quittungsAntwort('quittieren',['q-1'],{identity_id:A,project:P});
  check(q.success===false&&q.error==='inbox_quittung_aus','quittieren bei AUS abgewiesen');
  const defs=[{name:'chat',inputSchema:{properties:{action:{type:'string',enum:['get','send']},project:{type:'string'}}}}];
  C.ergaenzeAgentTokenParameter(defs);
  check(defs[0].inputSchema.properties.action.enum.includes('quittieren')&&'quittung'in defs[0].inputSchema.properties,'Annahmevertrag kennt quittieren/quittung');
  const aus=(await C.beworbeneAgentTools(defs,{project:P})).find(d=>d.name==='chat');
  check(!aus.inputSchema.properties.action.enum.includes('quittieren')&&!('quittung'in aus.inputSchema.properties),'AUS: nicht beworben');
  await schalter('inbox_quittung',true);
  const an=(await C.beworbeneAgentTools(defs,{project:P})).find(d=>d.name==='chat');
  check(an.inputSchema.properties.action.enum.includes('quittieren')&&'quittung'in an.inputSchema.properties,'EIN: beworben');
  check(await Q.inboxQuittungIrgendwoAktiv()===true,'irgendwo aktiv (global)');
 });

 let q1,q2,q3,id2,id3;
 await section('C Schalter EIN: Quittungs-ID',async()=>{
  const id=await inbox(A,'NACHRICHT-EIN-1');
  erhalten.length=0;await takt();
  const e=erhalten.find(x=>x.z.message_id===id);
  const led=(await pool.query("SELECT id,quittung_seit FROM agent_zustellungen WHERE identity_id=$1 AND message_id=$2",[A,id])).rows[0];
  q1='q-'+led.id;
  check(e?.z.quittung===q1,'Job traegt die Quittungs-ID des Ledgers ('+e?.z.quittung+')');
  check(e.text.split('\n').includes('Quittung: '+q1)&&e.text.includes('ID: inbox:'+id)&&e.text.includes('NACHRICHT-EIN-1'),'Kopf: ID + Quittung, Inhalt vollstaendig');
  check(e.text.trimEnd().endsWith('Quittieren nach dem Lesen: chat(action:"quittieren", quittung:["'+q1+'"])'),'Fusszeile nennt den Aufruf');
  check(led.quittung_seit!==null,'quittung_seit gesetzt');
  check((await Q.offeneQuittungen(A)).anzahl===1,'eine offene Quittung');
  check((await melde(S1)).offene_quittungen?.anzahl===1,'Meldung liefert offene Quittungen (Debug)');
 });

 await section('D quittieren und get',async()=>{
  const fremd=await Q.quittungsAntwort('quittieren',[q1],{identity_id:B,project:P});
  check(fremd.success===true&&fremd.quittiert.length===0&&fremd.unbekannt_oder_fremd[0]===q1,'fremd abgewiesen');
  const g1=await Q.quittungsAntwort('get',q1,{identity_id:B,project:P});
  check(g1.success===false&&g1.error==='quittung_unbekannt','get fremd abgewiesen');
  const g2=await Q.quittungsAntwort('get',q1,{identity_id:A,project:P});
  check(g2.success===true&&g2.inhalt==='NACHRICHT-EIN-1'&&g2.weg==='inbox'&&g2.quittiert_am===null,'get eigen liefert Inhalt');
  const eigen=await Q.quittungsAntwort('quittieren',[q1,'kaputt'],{identity_id:A,project:P});
  check(eigen.success===true&&eigen.quittiert[0]===q1&&eigen.ungueltig?.[0]==='kaputt','eigen quittiert, ungueltig gemeldet');
  const nochmal=await Q.quittungsAntwort('quittieren',q1,{identity_id:A,project:P});
  check(nochmal.success===true&&nochmal.quittiert.length===0&&nochmal.schon_quittiert[0]===q1,'doppelt idempotent');
  check((await Q.offeneQuittungen(A)).anzahl===0,'nichts mehr offen');
  check((await Q.quittungsAntwort('quittieren',[],{identity_id:A,project:P})).error==='quittung_fehlt','leer -> quittung_fehlt');
 });

 await section('E Erinnerung nach Neuanmeldung',async()=>{
  id2=await inbox(A,'GEHEIMER-INHALT-2');id3=await inbox(A,'GEHEIMER-INHALT-3','user');
  erhalten.length=0;await takt();
  const led=(await pool.query("SELECT id,message_id FROM agent_zustellungen WHERE identity_id=$1 AND message_id=ANY($2::bigint[]) ORDER BY id",[A,[id2,id3]])).rows;
  q2='q-'+led[0].id;q3='q-'+led[1].id;
  check(erhalten.filter(x=>x.z.art!=='erinnerung').length===2,'zwei Nachrichten zugestellt');
  // gleiche Sitzung, gleicher Daemon: keine Erinnerung
  await melde(S1);erhalten.length=0;await takt();
  check(erhalten.length===0,'gleiche Sitzung: keine Erinnerung');
  // Daemon-Neustart: neue daemon_id
  await melde(S1,'daemon-'+HOST+'-2');erhalten.length=0;await takt();
  const er=erhalten.filter(x=>x.z.art==='erinnerung');
  check(er.length===1,'genau eine Erinnerung ('+er.length+')');
  const tx=er[0]?.text??'';
  check(tx.includes(q2)&&tx.includes(q3)&&tx.includes('inbox:'+id2)&&tx.includes('user'),'Erinnerung nennt IDs, Kennung, Absender');
  check(!tx.includes('GEHEIMER-INHALT'),'Erinnerung ohne Inhalt');
  check(er[0]?.z.absender?.agent_id==='system'&&tx.includes('Weg: System-Erinnerung')&&!tx.includes('Antworte bei Bedarf'),'Absender system, eigener Kopf');
  check(er[0]?.schluessel.startsWith('erinnerung:'),'eigener Uebergabe-Schluessel');
  check(tx.includes('chat(action:"quittieren", quittung:["'+q2+'","'+q3+'"])')&&tx.includes('chat(action:"get", quittung:"'+q2+'")'),'Aufrufe zum Abrufen/Quittieren');
  check((await pool.query("SELECT count(*)::int n FROM agent_zustellungen WHERE identity_id=$1 AND erinnert_am IS NOT NULL",[A])).rows[0].n===2,'erinnert_am gesetzt');
  check((await pool.query("SELECT count(*)::int n FROM agent_zustellungen WHERE identity_id=$1 AND (weg<>'inbox' OR message_id=0)",[A])).rows[0].n===0,'Erinnerung ohne Ledger-Zeile');
  erhalten.length=0;await melde(S1,'daemon-'+HOST+'-2');await takt();
  check(erhalten.length===0,'danach keine weitere Erinnerung');
  // neue Sitzung = Neuanmeldung, aber nichts offen -> keine Erinnerung
  await Q.quittungsAntwort('quittieren',[q2,q3],{identity_id:A,project:P});
  erhalten.length=0;await melde(S2,'daemon-'+HOST+'-2');await takt();
  check(erhalten.length===0,'nichts offen: keine Erinnerung');
  const st=M.modInboxStand(t).gemeldet.find(g=>g.identity_id===A);
  check(st?.erinnerung_faellig===false&&st.erinnerung_letzte?.grund==='nichts_offen'&&st.daemon_id==='daemon-'+HOST+'-2','Debug: Erinnerung und Daemon im Stand');
 });

 await section('F nie zugestellt -> normale Zustellung',async()=>{
  modus='nicht_verbunden';
  const id=await inbox(A,'SPAETER-ZUGESTELLT');
  erhalten.length=0;await takt();
  const z=(await pool.query("SELECT status,versuche FROM agent_zustellungen WHERE identity_id=$1 AND message_id=$2",[A,id])).rows[0];
  check(z?.status==='pending'&&z.versuche>=1,'Daemon ohne Sitzung: bleibt pending');
  modus='zustellen';
  await melde(S2,'daemon-'+HOST+'-3');erhalten.length=0;await takt();
  const n=erhalten.filter(x=>x.z.message_id===id&&x.z.art!=='erinnerung');
  check(n.length===1&&n[0].text.includes('SPAETER-ZUGESTELLT'),'nach dem Wiederverbinden normal zugestellt (mit Inhalt)');
  check(!erhalten.some(x=>x.z.art==='erinnerung'),'keine Erinnerung fuer nie zugestellte Nachricht');
 });

 await section('G Daemon-Wechsel gibt verwaiste Jobs frei',async()=>{
  daemonAus=true;await lauf;
  const ALT='daemon-'+HOST+'-alt',NEU='daemon-'+HOST+'-neu';
  await melde(S2,ALT);
  const job=await C.enqueueSpecialistJob({project:P,action:'zustellen',args:{name:'agent-a',identity_id:A,target_hostname:HOST,zustellung:{message_id:9,weg:'inbox'}}});
  const eigen=await C.enqueueSpecialistJob({project:P,action:'zustellen',args:{name:'agent-a',identity_id:A,target_hostname:HOST,zustellung:{message_id:10,weg:'inbox'}}});
  check((await C.claimPendingSpecialistJob(P,ALT,HOST))?.id===job.id,'alter Daemon claimt');
  check((await C.claimPendingSpecialistJob(P,NEU,HOST))?.id===eigen.id,'neuer Daemon claimt den zweiten');
  const id=await inbox(A,'WARTET');
  await pool.query("INSERT INTO agent_zustellungen(identity_id,weg,message_id,zustellung,naechster_versuch) VALUES($1,'inbox',$2,'{}'::jsonb,NOW()+interval '1 hour') ON CONFLICT DO NOTHING",[A,id]);
  const start=Date.now();
  const warten=C.waitForSpecialistJob(job.id,60_000);
  await pause(200);
  await melde(S2,NEU);
  const r=await warten;
  check(r.status==='failed'&&r.error==='daemon_neugestartet','alter Job failed daemon_neugestartet');
  check(Date.now()-start<10_000,'Wartender sofort frei ('+(Date.now()-start)+' ms)');
  check((await pool.query('SELECT status FROM specialist_jobs WHERE id=$1',[eigen.id])).rows[0].status==='running','Job des aktuellen Daemons unberuehrt');
  check((await pool.query("SELECT naechster_versuch<=NOW() AS f FROM agent_zustellungen WHERE identity_id=$1 AND message_id=$2",[A,id])).rows[0].f===true,'pending sofort faellig');
  const st=M.modInboxStand(t).gemeldet.find(g=>g.identity_id===A);
  check(st?.daemon_wechsel_letzter?.von===ALT&&st.daemon_wechsel_letzter.freigegeben.includes(job.id),'Debug: Daemon-Wechsel mit freigegebenen Jobs');
  await C.completeSpecialistJob(eigen.id,{status:'done',result:ergebnis({success:true,zugestellt:true})});
 });

 await section('H Daemon-Neustart waehrend der Uebergabe: keine zweite Vollzustellung',async()=>{
  const ALT='daemon-'+HOST+'-h1',NEU='daemon-'+HOST+'-h2';
  await pool.query("UPDATE agent_zustellungen SET status='zugestellt' WHERE identity_id=$1 AND status='pending'",[A]);
  let hModus='zustellen',claimId=ALT,hAus=false;const hErhalten=[];
  const hLauf=(async()=>{while(!hAus){
   const job=await C.claimPendingSpecialistJob(P,claimId,HOST).catch(()=>null);
   if(!job){await pause(30);continue;}
   // haengen = der alte Daemon stirbt waehrend der Uebergabe (Job bleibt running).
   if(hModus==='haengen'){hErhalten.push({haengt:job.args.zustellung});continue;}
   hErhalten.push({z:job.args.zustellung,text:Z.baueZustellText(job.args.zustellung)});
   await C.completeSpecialistJob(job.id,{status:'done',result:ergebnis({success:true,zugestellt:true,weg:'mod_inbox'})});
  }})();
  await melde(S2,ALT);await takt();
  await pool.query('UPDATE agent_zustellungen SET quittiert_am=NOW() WHERE identity_id=$1 AND quittiert_am IS NULL',[A]);
  hModus='haengen';hErhalten.length=0;
  const id=await inbox(A,'VOR-NEUSTART-UEBERGEBEN');
  const laufender=takt();
  for(let i=0;i<200&&!hErhalten.length;i++)await pause(50);
  check(hErhalten[0]?.haengt?.message_id===id,'alter Daemon hat den Job geclaimt');
  hModus='zustellen';claimId=NEU;
  const start=Date.now();
  await melde(S2,NEU);
  const takt1=await laufender;
  check(Date.now()-start<15_000,'Takt nach dem Neustart frei ('+(Date.now()-start)+' ms)');
  const led=(await pool.query('SELECT id,status,letzter_grund,quittung_seit FROM agent_zustellungen WHERE identity_id=$1 AND message_id=$2',[A,id])).rows[0];
  check(led?.status==='zugestellt'&&/daemon_neugestartet/.test(led.letzter_grund??'')&&led.quittung_seit!==null,'als zugestellt (Uebergabe unklar) gebucht');
  check(takt1?.agenten?.[0]?.ergebnis?.unklar===1,'Takt meldet unklar');
  const voll=hErhalten.filter(x=>x.z&&x.z.art!=='erinnerung'&&x.z.message_id===id);
  const er=hErhalten.filter(x=>x.z?.art==='erinnerung');
  check(voll.length===0,'keine zweite Vollzustellung');
  check(er.length===1&&er[0].text.includes('q-'+led.id)&&!er[0].text.includes('VOR-NEUSTART-UEBERGEBEN'),'nur die System-Erinnerung mit der ID');
  hAus=true;await hLauf;
 });
 if(!daemonAus){daemonAus=true;await lauf;}
}catch(e){failures.push('Abbruch: '+mask(e.stack));console.error(mask(e.stack));}
finally{
 // Aufraeumen: ein schon geschlossener Pool ist kein Testfehler.
 try{await core?.closePool?.();}catch{/* bereits geschlossen */}
 try{await pool?.end?.();}catch{/* bereits geschlossen */}
 try{await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}catch(e){console.error('Schema nicht entfernt: '+mask(e.message));}
 await admin.end();
}
console.log('P22-T144: '+checks+' Pruefungen, '+failures.length+' Fehler');
if(failures.length){console.error(failures.join('\n'));process.exit(1);}
process.exit(0);
