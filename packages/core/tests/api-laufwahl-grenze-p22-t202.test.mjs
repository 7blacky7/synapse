/**
 * P22-T202 P1-Fix (Abnahme d317829a, Auftrag thought 40f496c6): CLI/API-Ausschluss an der gemeinsamen Runtime-Auftragsgrenze.
 * Prueft core api-wahl-sperre.ts, hauptagent-dienst.ts legeRuntimeAuftragAn und runtime-auftraege-ausfuehrung.ts claimeRuntimeAuftraege:
 *  - API-Wahl (jede Phase) bzw. laufende API-Lease -> kein neuer CLI-Auftrag (neustart/modellwechsel/runtime_wechsel), stop bleibt erlaubt
 *  - alte pending / claimed (Lease abgelaufen) / accepted (Lease abgelaufen) Auftraege und direkt eingefuegte Ueberwachungsauftraege
 *    werden beim Claim sichtbar abgelehnt (rejected, Audit) statt dem Daemon bzw. der API geliefert
 *  - beide zeitlichen Richtungen unter derselben Sperre: Anlegen wartet auf eine laufende API-Wahl und scheitert danach; der Claim
 *    ueberspringt eine gehaltene Identitaet nicht blockierend; ein geclaimter CLI-Auftrag ist fuer die API-Wahl unter der Sperre sichtbar
 * Nur synapse_test:5433, eigenes privates Schema, kein Daemon/Anbieter/Netz.
 *   DATABASE_URL=postgres://...:5433/synapse_test node packages/core/tests/api-laufwahl-grenze-p22-t202.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const require=createRequire(new URL('../package.json',import.meta.url)),{Pool}=require('pg');
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_MAIN_SYNAPSE','SYNAPSE_HAUPTAGENT'])delete process.env[k];
const tmp=await mkdtemp(join(tmpdir(),'p22-t202-p1-'));
Object.assign(process.env,{HOME:tmp,SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
let netz=0;globalThis.fetch=async()=>{netz++;throw Error('Testnetz gesperrt');};
const admin=new Pool({connectionString:url.href}),schema='p22_t202_p1_'+process.pid+'_'+randomUUID().slice(0,8);
let pool,checks=0;const fehlerListe=[];
const check=(ok,label,wert)=>{checks++;if(!ok){fehlerListe.push(label);console.error('FAIL P22-T202-P1 '+label+' | tatsaechlich '+JSON.stringify(wert));}};
const err=async f=>{try{await f();return 'kein_fehler';}catch(e){return e.code??e.message;}};
const pause=ms=>new Promise(r=>setTimeout(r,ms));

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
 const C=await import('../dist/index.js');pool=C.getPool();
 await pool.query('CREATE SEQUENCE IF NOT EXISTS agent_ausweis_nr');
 const USER={art:'user'},HP=C.HAUPTAGENT_PROJEKT;
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:true,grund:'Test P22-T202 P1 alle'},{system:'user'});
 await C.setzeHauptagentSchalter(USER,{aktiv:true,grund:'Test P22-T202 P1 EIN'});
 const MAIN=(await C.stelleMainIdentitaetSicher(USER,{modell:'opus',runtime:'claude'})).identity_id;
 const extra={modellwechsel:{gewuenscht:{modell:'sonnet'}},runtime_wechsel:{gewuenscht:{runtime:'codex'}}};
 const auftrag=(art)=>C.legeRuntimeAuftragAn(USER,{art,grund:'P22-T202 P1 Test '+art,...(extra[art]??{})});
 const status=async id=>(await pool.query('SELECT status,letzter_fehler,abgeschlossen_von FROM agent_runtime_auftraege WHERE id=$1',[id])).rows[0];
 const raeumen=()=>pool.query("UPDATE agent_runtime_auftraege SET status='completed',abgeschlossen_am=NOW() WHERE status IN ('pending','claimed','accepted')");
 const wahl=w=>C.mitApiWahlSperre([MAIN],db=>C.schreibeApiLaufWahl(db,MAIN,w));
 const W={laufart:'api',modell:'or-deepseek-chat',anbieter:'openrouter-api',phase:'aktiv',grund:'P22-T202 P1 Test',wer:'user',am:new Date().toISOString()};

 // 1. Grundfall ohne API-Wahl: unveraendert anlegen und claimen.
 const a1=await auftrag('neustart');
 check(a1.auftrag.status==='pending','ohne API-Wahl: neustart angelegt',a1);
 const c1=await C.claimeRuntimeAuftraege({projekte:[HP]});
 check(c1.length===1&&c1[0].auftrag_id===a1.auftrag.auftrag_id&&c1[0].status==='claimed'&&c1[0].claim_revision===1,'ohne API-Wahl: Claim liefert den Auftrag',c1);
 await raeumen();

 // 2. API gewaehlt (jede Phase): CLI-Auftraege abgelehnt, stop erlaubt.
 for(const phase of ['wechsel','aktiv','fehler']){
  await wahl({...W,phase});
  for(const art of ['neustart','modellwechsel','runtime_wechsel'])check(await err(()=>auftrag(art))==='api_lauf_gewaehlt','API-Wahl '+phase+': '+art+' abgelehnt');
 }
 check((await pool.query("SELECT count(*)::int n FROM agent_runtime_auftraege WHERE status='pending'")).rows[0].n===0,'bei API-Wahl kein CLI-Auftrag angelegt');
 const stop=await auftrag('stop');
 check(stop.auftrag.status==='pending','stop trotz API-Wahl erlaubt (startet nichts)',stop);
 const cs=await C.claimeRuntimeAuftraege({projekte:[HP]});
 check(cs.length===1&&cs[0].art==='stop','stop wird trotz API-Wahl geclaimt',cs);
 await raeumen();

 // 3. Alte Auftraege aus der Zeit vor der Wahl: Claim lehnt sichtbar ab statt zu liefern.
 await wahl(null);
 const alt=await auftrag('neustart'),altM=await auftrag('modellwechsel'),altR=await auftrag('runtime_wechsel');
 await pool.query("UPDATE agent_runtime_auftraege SET status='claimed',claim_revision=1,lease_bis=NOW()-interval '1 minute' WHERE id=$1",[altM.auftrag.auftrag_id]);
 await pool.query("UPDATE agent_runtime_auftraege SET status='accepted',claim_revision=1,lease_bis=NOW()-interval '1 minute' WHERE id=$1",[altR.auftrag.auftrag_id]);
 await wahl(W);
 const c3=await C.claimeRuntimeAuftraege({projekte:[HP]}),c3r=await C.claimeRuntimeAuftraege({projekte:[HP],arten:['runtime_wechsel']});
 check(c3.length===0&&c3r.length===0,'Claim liefert Daemon und API-Ausfuehrer nichts bei API-Wahl',{c3,c3r});
 for(const [x,label]of [[alt,'pending'],[altM,'claimed, Lease abgelaufen'],[altR,'accepted, Lease abgelaufen']]){
  const s=await status(x.auftrag.auftrag_id);
  check(s.status==='rejected'&&s.letzter_fehler.startsWith('api_lauf_gewaehlt')&&s.abgeschlossen_von==='api-laufwahl-sperre','alter Auftrag ('+label+') sichtbar abgelehnt',s);
 }
 const audit=(await pool.query("SELECT count(*)::int n FROM agent_identitaet_audit WHERE identity_id=$1 AND wer='api-laufwahl-sperre' AND aktion='runtime_auftrag_abgelehnt'",[MAIN])).rows[0].n;
 check(audit===3,'Ablehnungen im Audit',audit);
 check(await err(()=>C.meldeRuntimeAuftrag({projekte:[HP],auftrag_id:altM.auftrag.auftrag_id,claim_revision:1,meldung:{schritt:'accepted'}}))==='auftrag_nicht_eigen','abgeloester Ausfuehrer kann den abgelehnten Auftrag nicht mehr melden');

 // 4. Laufende API-Lease ohne Wahl (z. B. Rueckfall-Zwischenstand) sperrt ebenso; auch direkt eingefuegte Ueberwachungsauftraege.
 await wahl(null);
 await C.legeApiLaufAn({identity_id:MAIN,project:HP,agent_id:'hauptagent',rolle:'main',modell:'or-deepseek-chat',anbieter:'openrouter-api',system_prompt:'t',gestartet_von:'user'});
 await pool.query("UPDATE api_agent_laeufe SET lease_token=gen_random_uuid(),lease_bis=NOW()+interval '1 minute' WHERE identity_id=$1",[MAIN]);
 check(await err(()=>auftrag('neustart'))==='api_lauf_gewaehlt','laufende API-Lease: neustart abgelehnt');
 const direkt=randomUUID();
 await pool.query("INSERT INTO agent_runtime_auftraege(id,identity_id,art,status,gewuenscht,grund,erstellt_von) VALUES($1,$2,'neustart','pending','{}'::jsonb,'Ueberwachung direkt','runtime-ueberwachung')",[direkt,MAIN]);
 const c4=await C.claimeRuntimeAuftraege({projekte:[HP]});
 check(c4.length===0&&(await status(direkt)).letzter_fehler.includes('api_lease_aktiv'),'direkt eingefuegter Ueberwachungsauftrag bei laufender Lease abgelehnt',await status(direkt));
 await pool.query('UPDATE api_agent_laeufe SET lease_token=NULL,lease_bis=NULL WHERE identity_id=$1',[MAIN]);

 // 5a. API-Wahl haelt die Sperre: Claim ueberspringt (nichts abgelehnt), Anlegen wartet und scheitert nach der Wahl.
 const p=await auftrag('neustart');
 let frei,drin;const gehalten=new Promise(r=>{frei=r;}),istDrin=new Promise(r=>{drin=r;});
 const halter=C.mitApiWahlSperre([MAIN],async db=>{drin();await gehalten;await C.schreibeApiLaufWahl(db,MAIN,W);});
 await istDrin;
 const waehrend=await C.claimeRuntimeAuftraege({projekte:[HP]});
 check(waehrend.length===0&&(await status(p.auftrag.auftrag_id)).status==='pending','Claim ueberspringt gehaltene Identitaet nicht blockierend',waehrend);
 let angelegt='offen';
 const lege=auftrag('modellwechsel').then(()=>{angelegt='angelegt';},e=>{angelegt=e.code??e.message;});
 await pause(400);
 check(angelegt==='offen','Anlegen wartet auf die Sperre der API-Wahl',angelegt);
 frei();await halter;await lege;
 check(angelegt==='api_lauf_gewaehlt','Anlegen nach der API-Wahl abgelehnt',angelegt);
 const nach=await C.claimeRuntimeAuftraege({projekte:[HP]});
 check(nach.length===0&&(await status(p.auftrag.auftrag_id)).status==='rejected','vorher angelegter Auftrag beim naechsten Claim abgelehnt',nach);

 // 5b. Rueckrichtung: geclaimter CLI-Auftrag ist unter der Sperre sichtbar (rest-api starteApiAuswahl -> wechsel_offen).
 await wahl(null);
 const q=await auftrag('neustart');
 const cq=await C.claimeRuntimeAuftraege({projekte:[HP]});
 const offen=await C.mitApiWahlSperre([MAIN],db=>db.query("SELECT id FROM agent_runtime_auftraege WHERE identity_id=$1 AND status IN ('pending','claimed','accepted')",[MAIN]));
 check(cq.length===1&&offen.rows.some(z=>z.id===q.auftrag.auftrag_id),'geclaimter CLI-Auftrag unter der Sperre sichtbar',offen.rows);
 check(netz===0,'kein Netz',netz);
 if(fehlerListe.length)throw Error(fehlerListe.length+' von '+checks+' Pruefungen rot: '+fehlerListe.join(' | '));
 console.log('P22-T202 P1 '+checks+' Pruefungen gruen; network='+netz);
}finally{
 if(pool)await pool.end();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
