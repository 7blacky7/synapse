/**
 * P22-T49: Koordinator-Anmeldung mit Ausweis kurz + plan aktivieren (Punkt 8). synapse_test:5433, privates Schema (Harness wie P22-T43/T48).
 *   node packages/core/tests/koordinator-kurz-p22-t49.test.mjs
 * A plan aktivieren: Positivkontrolle (altes Einzel-UPDATE verletzt idx_plans_ein_aktiver), aktivierePlan und createPlan(aktiv) korrekt.
 * B Koordinator mit Ausweis: genau handoff, aktiver_plan, top3, regeln; keine Uebersichten; fortsetzung ohne abrufwege.
 * C Folgeaufruf im Lauf ohne erneute Ausgabe. D index_stats onboarding:true liefert weiter alles.
 * E ohne aktiven Plan, ohne high-Tasks, ohne Handoff. F Legacy-Koordinator unveraendert. G Subagent mit Typ wie P22-T48.
 * H profilverwaltung AUS -> volles Onboarding.
 * P22-T52: Subagent-Anmeldung kurz (nur Typ-Regeln, Regelnamen + Abrufzeile, eigene Channels/Tasks), '*'-Datenrest weg,
 *   volles Onboarding ohne fortsetzung-Parameter (index_stats onboarding:true), Groesse kurz vs. voll im Log (T52 GROESSE).
 */
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=p=>import(pathToFileURL(join(repo,p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_INTERN_TOOL','SYNAPSE_W1B_DURCHSETZUNG','SYNAPSE_W1B_ANTWORTANPASSUNG','SYNAPSE_W1B_TOKEN_HINWEIS_MS','SYNAPSE_AGENTEN_AUSWEIS'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_TOKEN_IDENTITAET:'1',SYNAPSE_W1B_ANMELDUNG:'1',
  SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_HINWEIS_BUDGET_MS:'5000',SYNAPSE_W1B_GATE_TTL_MS:'0',
  QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const {Pool}=require('pg');
const admin=new Pool({connectionString:url.href});
const schema='p22_t49_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t49-synthetic';
const SRV='srv-t49';
const failures=[];let checks=0;
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}else console.log('ok   '+label);}
const neuerAusweis=()=>'sai_'+randomBytes(32).toString('hex');
const task=(kurz,title,status,priority,extra={})=>({id:randomUUID(),kurz_id:kurz,title,description:'',status,priority,createdAt:new Date().toISOString(),...extra});

let pool;
try{
  await admin.query('CREATE SCHEMA '+schema);
  for(const {tablename} of (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows)await admin.query(`CREATE TABLE ${schema}."${tablename}" (LIKE public."${tablename}" INCLUDING ALL)`);
  const cl=await admin.connect();
  try{
    await cl.query('SET search_path TO '+schema);
    for(const f of ['111_agent_identitaet.sql','112_agent_bezug.sql','113_agent_profil.sql','114_agent_ausweis.sql','115_agent_ausweis_nr.sql','117_agent_ausweis_fristen.sql','118_agent_ausweis_projekte.sql'])await cl.query(readFileSync(join(repo,'packages/core/src/db/schema-sql/'+f),'utf8'));
    // wie live: hoechstens ein aktiver Plan je Projekt (nicht aufschiebbar)
    await cl.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_ein_aktiver ON plans (project) WHERE aktiv IS TRUE');
  }finally{cl.release();}
  url.searchParams.set('options','-c search_path='+schema+',public');
  process.env.DATABASE_URL=url.href;
  const T=await load('packages/core/dist/services/agent-token-tools.js');
  const L=await load('packages/core/dist/services/agent-lauf.js');
  const O=await load('packages/core/dist/services/agent-onboarding.js');
  const PL=await load('packages/core/dist/services/plans.js');
  const C=await load('packages/core/dist/services/chat.js');
  const SCH=await load('packages/core/dist/services/agent-profil-schalter.js');
  const {getPool}=await load('packages/core/dist/db/client.js');
  pool=getPool();

  for(const f of ['profilverwaltung','typkatalog','schattenprofile'])
    await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,$1,true,'Test P22-T49','user')",[f]);
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'agenten_ausweis',true,'Test P22-T49','user')",[P]);
  check((await SCH.leseAusweisKern(P)).aktiv===true,'Ausweis-Kern fuer Testprojekt EIN');
  const regel=(name,content,tags)=>pool.query("INSERT INTO memories(id,project,name,category,content,tags) VALUES($1,$2,$3,'rules',$4,$5)",[randomUUID(),P,name,content,tags]);
  await regel('regel-pflicht-x','Pflichtregel X',['pflicht']);
  await regel('regel-normal-y','Normale Regel Y',[]);
  await regel('regel-typ-a','Typ-Regel A',[]);
  const plan=(id,kurz,name,aktiv,prio,tasks,bis=null)=>pool.query(
    `INSERT INTO plans(id,project,name,description,goals,tasks,created_at,updated_at,kurz_id,aktiv,naechste_task_nr,prioritaet,zurueckgestellt_bis)
     VALUES($1,$2,$3,'',ARRAY[]::text[],$4,NOW(),NOW(),$5,$6,10,$7,$8)`,[id,P,name,JSON.stringify(tasks),kurz,aktiv,prio,bis]);
  // Reihenfolge absichtlich: Ziel P2 VOR dem aktiven P1 angelegt (Positivkontrolle des alten Einzel-UPDATEs)
  await plan('t49-p2','P2','Andere',false,'hoch',[task('P2-T1','High eins','todo','high'),task('P2-T2','High zwei','in_progress','high'),
    task('P2-T3','High drei','blocked','high'),task('P2-T4','High vier','todo','high'),task('P2-T5','High fertig','done','high'),task('P2-T6','Mittel','todo','medium')]);
  await plan('t49-p1','P1','Aktiv',true,'mittel',[task('P1-T1','Aufgabe A','todo','low'),task('P1-T2','Aufgabe B','done','high'),
    task('P1-T3','Aufgabe C','in_progress','medium'),task('P1-T4','Aufgabe D','blocked','high'),
    task('P1-T5','Aufgabe E zurueckgestellt','todo','high',{zurueckgestellt_bis:new Date(Date.now()+86400000).toISOString()})]);
  await plan('t49-p3','P3','Schlaeft',false,'hoch',[task('P3-T1','Schlafende High','todo','high')],new Date(Date.now()+86400000*3));
  const aktive=async()=>(await pool.query('SELECT kurz_id FROM plans WHERE project=$1 AND aktiv IS TRUE ORDER BY kurz_id',[P])).rows.map(r=>r.kurz_id).join(',');

  // ================= A: plan aktivieren (Punkt 8) =================
  let altFehler=null;
  const cA=await pool.connect();
  // Mechanismus des Live-Fehlers: der Index wird je Zeile sofort geprueft. Wird im alten Einzel-UPDATE die Zielzeile
  // vor der bisher aktiven bearbeitet (Reihenfolge datenabhaengig), entspricht das diesem Schritt -> duplicate key.
  try{await cA.query('BEGIN');await cA.query('UPDATE plans SET aktiv = true WHERE project = $1 AND id = $2',[P,'t49-p2']);}catch(e){altFehler=e;}finally{await cA.query('ROLLBACK').catch(()=>{});cA.release();}
  check(!!altFehler&&/idx_plans_ein_aktiver|duplicate key/.test(String(altFehler?.message)),'A Positivkontrolle: Ziel aktiv setzen, solange der alte aktiv ist, verletzt den Index ('+(altFehler?.message??'kein Fehler')+')');
  await PL.aktivierePlan(P,'P2');
  check(await aktive()==='P2','A aktivierePlan(P2): genau P2 aktiv');
  await PL.aktivierePlan(P,'P1');
  check(await aktive()==='P1','A zurueck auf P1: genau P1 aktiv');
  const neu=await PL.createPlan(P,'Neu aktiv','Test',[],{aktiv:true});
  check(await aktive()===neu.kurz_id,'A createPlan(aktiv:true) bei vorhandenem aktivem Plan: genau der neue aktiv ('+neu.kurz_id+')');
  await PL.aktivierePlan(P,'P1');
  check(await aktive()==='P1','A wieder P1 aktiv');

  // Handoffs: aelter/juenger eigene, juengster fremder, Legacy-Rueckfall nur ohne Identitaet
  const tokK=neuerAusweis();
  await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,erstellt_von) VALUES('t49-koord',$1,'koordinator','koordinator','koordinator','test')",[P]);
  await pool.query('INSERT INTO agent_identitaet_tokens(id,identity_id,token_offen,token_praefix,ausweis_weg) VALUES($1,$2,$3,$4,$5)',[randomUUID(),'t49-koord',tokK,tokK.slice(0,12),'vorbereitet']);
  const th=(id,source,iid,min,tags=['session-uebergabe'])=>pool.query(
    `INSERT INTO thoughts(id,project,source,content,tags,"timestamp",source_identity_id) VALUES($1,$2,$3,'Uebergabe',$4,NOW()-($5||' minutes')::interval,$6)`,[id,P,source,tags,String(min),iid]);
  await th('t49-h-alt','koordinator','t49-koord',30);
  await th('t49-h-neu','koordinator','t49-koord',10);
  await th('t49-h-fremd','anderer',null,1);
  await th('t49-h-ohne-tag','koordinator','t49-koord',0,['notiz']);
  const tokenAufruf=(tool,args,arbeit,optionen)=>T.mitAgentToolAufruf(tool,args,SRV,arbeit,undefined,undefined,optionen);
  const anmelden=tok=>tokenAufruf('chat',{action:'anmelden',token:tok},async k=>k.antwort,{herkunft:'Test'});

  // ================= B: kurze Koordinator-Ausgabe =================
  const a1=await anmelden(tokK);
  const ob=a1?.agentOnboarding;
  console.log('BEISPIEL '+JSON.stringify(a1));
  check(a1?.success===true&&ob?.zustellung?.koordinator_kurz===true,'B Anmeldung Koordinator: zustellung.koordinator_kurz');
  check(['handoff','aktiver_plan','top3','regeln'].every(k=>k in ob),'B die Felder handoff, aktiver_plan, top3, regeln vorhanden');
  check(['plaene','task_suche_hinweis','jev_hinweis','erklaerung_faelle','entscheidungen_durchsicht','volltext_hinweis','rules','regel_verzeichnis'].every(k=>!(k in ob)),'B keine Uebersichten/Hinweise/Regel-Volltexte');
  check(!('channels' in ob),'B/T50 channels: Identitaet ohne Channels (nie beigetreten) und ohne Standardchannel -> Feld fehlt ganz');
  check(/admin\(action:"index_stats"/.test(ob?.statistik_abruf??''),'B Statistiken/Jev nur als Abrufzeile');
  check(ob?.handoff?.id==='t49-h-neu'&&typeof ob.handoff.zeit==='string'&&ob.handoff.empfehlung==='Zuerst lesen: thought(action:"get", id:"t49-h-neu")','B handoff = neuester eigener session-uebergabe-Thought (ID + Zeit + Empfehlung Zuerst lesen)');
  check(ob?.aktiver_plan?.kurz_id==='P1'&&ob.aktiver_plan.titel==='Aktiv'&&ob.aktiver_plan.offen===3&&!('name' in ob.aktiver_plan)&&JSON.stringify(ob.aktiver_plan.tasks)==='["P1-T4 Aufgabe D","P1-T3 Aufgabe C","P1-T1 Aufgabe A"]','B aktiver_plan: Kurz-ID + kurzer Titel + Anzahl offen, nur offene, nicht zurueckgestellte Tasks (P22-T83: nach Prioritaet)');
  check(JSON.stringify(ob?.top3)==='["1 P2-T1 High eins","2 P2-T2 High zwei","3 P2-T3 High drei"]','B top3: drei offene high-Tasks anderer Plaene, nummeriert, ohne zurueckgestellten Plan');
  check(ob?.regeln?.namen?.includes('regel-pflicht-x')&&ob.regeln.namen.includes('regel-normal-y')&&!ob.regeln.voll&&/memory\(action:"read"/.test(ob.regeln.abruf??''),'B regeln: nur Namen + Abrufzeile (ohne Typ kein Volltext)');
  // P22-T50: Ballast raus - kein fortsetzung-Block, keine zustellung.quellen, kein zustellung.fortsetzung, keine Leerfelder.
  check(!('quellen' in (ob?.zustellung??{}))&&!('fortsetzung' in (ob?.zustellung??{})),'T50 zustellung ohne quellen und ohne fortsetzung');
  check(!('fortsetzung' in a1)&&!('open_plans' in a1),'T50 Anmeldung ohne fortsetzung-Block und ohne open_plans');
  check(!('profil' in ob)&&ob.zustellung?.profilblock===true,'T50 Profil ohne Inhalt (nur Revision) entfaellt, gilt als zugestellt');
  const leer=v=>v===null||v===''||(Array.isArray(v)&&!v.length)||(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===0);
  check(Object.entries(ob??{}).every(([,v])=>!leer(v)),'T50 keine leeren Felder in der Koordinator-Anmeldung');
  check(!('skills' in ob)&&!('skills_andere' in ob),'T50 Skills fehlen, solange keine festgelegt sind');

  // ================= T50 Nachtrag: eigene offene files-Plaene im Fenster (anmeldung_plaene_minuten) =================
  check(!('offene_plaene' in a1),'T50 keine eigenen offenen Plaene -> Zeile fehlt');
  const fp=(id,owner,iid,status,minAlt)=>pool.query(
    `INSERT INTO file_batch_plans(id,project,owner_agent_id,owner_identity_id,ops,expected_hashes,previews,status,created_at)
     VALUES($1,$2,$3,$4,'[]'::jsonb,'{}'::jsonb,'[]'::jsonb,$5,NOW()-($6||' minutes')::interval)`,[id,P,owner,iid,status,String(minAlt)]);
  await fp(495001,'koordinator','t49-koord','open',5);
  await fp(495002,'koordinator','t49-koord','committed',5);
  await fp(495003,'koordinator','t49-koord','cancelled',5);
  await fp(495004,'koordinator','t49-koord','open',60);
  await fp(495005,'fremder','t49-fremd-iid','open',5);
  const pl1=await anmelden(tokK);
  check(/^Eigene offene files-Plaene \(letzte 30 Min\): 495001 \(5 Min\) - pruefen: files\(action:"plan_status", plan_id\)/.test(pl1?.offene_plaene??''),'T50 offen im Fenster -> eine Zeile nur mit eigenem offenem Plan ('+pl1?.offene_plaene+')');
  check(!/495002|495003|495004|495005/.test(pl1?.offene_plaene??''),'T50 committed/cancelled/aelter/fremd erscheinen nicht');
  const FR=await load('packages/core/dist/services/agent-ausweis-fristen.js');
  await FR.setzeAusweisFristen({ebene:'projekt',project:P,werte:{anmeldung_plaene_minuten:90},grund:'Test P22-T50 Fenster'},{wer:'user',setter_identity_id:null});
  const pl2=await anmelden(tokK);
  check(/letzte 90 Min/.test(pl2?.offene_plaene??'')&&/495001/.test(pl2.offene_plaene)&&/495004 \(60 Min\)/.test(pl2.offene_plaene)&&!/495005/.test(pl2.offene_plaene),'T50 Fenster 90 Min (Projektwert) wirkt: aelterer eigener Plan erscheint ('+pl2?.offene_plaene+')');
  await FR.setzeAusweisFristen({ebene:'projekt',project:P,werte:{anmeldung_plaene_minuten:1},grund:'Test P22-T50 Fenster klein'},{wer:'user',setter_identity_id:null});
  const pl3=await anmelden(tokK);
  check(!('offene_plaene' in (pl3??{})),'T50 Fenster 1 Min: kein eigener offener Plan im Fenster -> Zeile fehlt');
  await FR.setzeAusweisFristen({ebene:'projekt',project:P,entfernen:['anmeldung_plaene_minuten'],grund:'Test P22-T50 zurueck'},{wer:'user',setter_identity_id:null});
  await pool.query('DELETE FROM file_batch_plans WHERE id BETWEEN 495001 AND 495005');

  // ================= C/D =================
  const f1=await tokenAufruf('thought',{action:'search',query:'x',token:tokK},async()=>O.holeAgentOnboarding({project:P,agentId:'koordinator',serverInstanceId:SRV}));
  check(f1===null,'C Folgeaufruf im selben Lauf ohne erneute Ausgabe');
  const st=await tokenAufruf('admin',{action:'index_stats',role:'koordinator',sitzung:'fortsetzung',onboarding:true,token:tokK},async k=>
    C.wendeSitzungsSignalAn({agentId:k.args.agent_id,project:k.args.project,sitzung:k.args.sitzung,role:k.args.role,onboarding:k.args.onboarding,serverInstanceId:SRV}));
  check(Array.isArray(st?.agentOnboarding?.rules)&&st.agentOnboarding.rules.some(r=>r.name==='regel-pflicht-x'&&r.vollstaendig)&&!st.agentOnboarding.zustellung?.koordinator_kurz,'D index_stats onboarding:true liefert weiter das volle Onboarding');

  // ================= K: Channels seit Ausweis (ausweis-fix 27970/27971) =================
  const kanal=async name=>Number((await pool.query("INSERT INTO specialist_channels(name,project,created_by) VALUES($1,$2,'test') RETURNING id",[name,P])).rows[0].id);
  const chStd=await kanal(P+'-general'),chLeg=await kanal('t49-legacy'),chNeu=await kanal('t49-neu'),chPost=await kanal('t49-post'); await kanal('t49-fremd');
  // Legacy-Mitgliedschaft (vor dem Ausweis) + von der Bruecke kopierte Identitaetszeile mit gleichem joined_at
  await pool.query("INSERT INTO specialist_channel_members(channel_id,agent_name,joined_at,last_read_message_id,last_notified_message_id,read_initialized_at) VALUES($1,'koordinator',NOW()-INTERVAL '2 days',0,0,NOW())",[chLeg]);
  await pool.query("INSERT INTO agent_identitaet_channel_mitglieder(channel_id,agent_name,identity_id,joined_at,last_read_message_id,last_notified_message_id,read_initialized_at) SELECT channel_id,'koordinator','t49-koord',joined_at,0,0,NOW() FROM specialist_channel_members WHERE channel_id=$1",[chLeg]);
  await pool.query("INSERT INTO agent_identitaet_channel_mitglieder(channel_id,agent_name,identity_id,joined_at,last_read_message_id,last_notified_message_id,read_initialized_at) VALUES($1,'koordinator','t49-koord',NOW(),0,0,NOW())",[chNeu]);
  await pool.query("INSERT INTO specialist_channel_messages(channel_id,sender,content,sender_identity_id) VALUES($1,'koordinator','m','t49-koord')",[chPost]);
  const k1=(await anmelden(tokK))?.agentOnboarding;
  check(JSON.stringify(k1?.channels?.aktiv)==='["t49-post","t49-neu"]','K aktiv = seit Ausweis beigetreten oder geschrieben; uebernommene Legacy-Mitgliedschaft zaehlt nicht ('+JSON.stringify(k1?.channels?.aktiv)+')');
  check(JSON.stringify(k1?.channels?.standard)===JSON.stringify([P+'-general'])&&/^5 Channels insgesamt/.test(k1?.channels?.zeile??''),'K Standardchannel + Gesamtzahl (5)');

  // ================= E =================
  await pool.query('UPDATE plans SET aktiv=false WHERE project=$1',[P]);
  const e1=(await anmelden(tokK))?.agentOnboarding;
  check(e1?.zustellung?.koordinator_kurz===true&&e1.aktiver_plan===null,'E ohne aktiven Plan: aktiver_plan null');
  await PL.aktivierePlan(P,'P1');
  await pool.query("UPDATE plans SET tasks=(SELECT jsonb_agg(jsonb_set(t,'{priority}','\"medium\"')) FROM jsonb_array_elements(tasks) t) WHERE project=$1 AND kurz_id<>'P1'",[P]);
  const e2=(await anmelden(tokK))?.agentOnboarding;
  check(e2?.zustellung?.koordinator_kurz===true&&!('top3' in e2),'E keine high-Tasks in anderen Plaenen: top3 fehlt');
  const tokK2=neuerAusweis();
  await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,erstellt_von) VALUES('t49-koord2',$1,'koordinator#2','koordinator-2','koordinator','test')",[P]);
  await pool.query('INSERT INTO agent_identitaet_tokens(id,identity_id,token_offen,token_praefix,ausweis_weg) VALUES($1,$2,$3,$4,$5)',[randomUUID(),'t49-koord2',tokK2,tokK2.slice(0,12),'vorbereitet']);
  const e3=(await anmelden(tokK2))?.agentOnboarding;
  check(e3?.zustellung?.koordinator_kurz===true&&!('handoff' in e3),'E ohne Handoff: Feld handoff fehlt');

  // ================= Z: abgeschlossener aktiver Plan (ausweis-fix 27979) =================
  await plan('t49-p9','P9','Fertig',false,'mittel',[task('P9-T1','Erledigt eins','done','high'),task('P9-T2','Erledigt zwei','done','low')]);
  await plan('t49-p8','P8','Auch fertig',false,'hoch',[task('P8-T1','Fertige High','done','high')]);
  await PL.aktivierePlan(P,'P9');
  const z1=(await anmelden(tokK))?.agentOnboarding;
  check(z1?.zustellung?.koordinator_kurz===true&&!('aktiver_plan' in z1)&&z1.aktiver_plan_hinweis==='Aktiver Plan P9 ist abgeschlossen – nächsten Plan aktivieren: plan(action:"aktivieren", plan_id:"P2")','Z abgeschlossener aktiver Plan: kein aktiver_plan, Hinweiszeile mit Vorschlag ('+(z1?.aktiver_plan_hinweis??'-')+')');
  check(!(z1?.top3??[]).some(t=>/P8-T1|P9-/.test(t))&&JSON.stringify(z1?.top3)==='["1 P1-T4 Aufgabe D"]','Z top3: Plaene ohne offene Tasks tragen nichts bei ('+JSON.stringify(z1?.top3)+')');
  await PL.aktivierePlan(P,'P2');
  const z2=(await anmelden(tokK))?.agentOnboarding;
  check(z2?.aktiver_plan?.kurz_id==='P2'&&z2.aktiver_plan.tasks.length===5&&z2.aktiver_plan.offen===5&&!('aktiver_plan_hinweis' in z2),'Z nach Aktivieren eines anderen Plans erscheinen dessen offene Tasks');
  // P22-T50: erste 5 + Anzahl, kurze Titel
  await plan('t49-p7','P7','Ein sehr langer Planname, der in der Anmeldung gekuerzt werden muss',false,'niedrig',
    Array.from({length:7},(_,i)=>task('P7-T'+(i+1),'Task '+(i+1)+' mit einem ausgesprochen langen Titel, der deutlich ueber sechzig Zeichen hinausgeht','todo','low')));
  await PL.aktivierePlan(P,'P7');
  const z3=(await anmelden(tokK))?.agentOnboarding;
  check(z3?.aktiver_plan?.offen===7&&z3.aktiver_plan.tasks.length===5&&z3.aktiver_plan.titel.length<=40&&z3.aktiver_plan.tasks.every(t=>t.length<=8+60),'T50 aktiver Plan: erste 5 von 7, Titel gekuerzt ('+JSON.stringify(z3?.aktiver_plan)+')');
  await PL.aktivierePlan(P,'P1');

  // ================= T50: '*' ist nie ein Projekt (jev abwesend) =================
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'mehrprojekt',true,'Test P22-T50','user')",[P]);
  const AP=await load('packages/core/dist/services/agent-ausweis-projekte.js'); AP.leereMehrprojektCache?.();
  let kStern;
  const stern=await tokenAufruf('jev',{action:'abwesend',modus:'status',project:'*',token:tokK},async k=>{kStern=k;return {project:k.args.project};});
  check(!kStern?.antwort&&stern?.project==='*','T50 jev(project:"*"): Aufruf laeuft, project bleibt "*" ('+JSON.stringify(kStern?.antwort??null)+')');
  check(!('ausweis_projekte_hinweis' in (stern??{}))&&!kStern?.bestaetigt?.ziel_project,'T50 "*" kein Fremdprojekt, kein Visum-/Koordinator-Hinweis');
  check((await pool.query("SELECT count(*)::int n FROM agent_ausweis_projekte WHERE project='*'").catch(()=>({rows:[{n:0}]}))).rows[0].n===0,'T50 "*" nicht im Ausweis eingetragen');
  check(await O.holeAgentOnboarding({project:'*',agentId:'koordinator',role:'koordinator',serverInstanceId:SRV,explizit:true})===null,'T50 kein Onboarding fuer "*"');
  const sternThought=await tokenAufruf('thought',{action:'search',query:'x',project:'*',token:tokK},async k=>({project:k.args.project}));
  check(sternThought?.project===P,'T50 anderes Tool mit "*" arbeitet in der Heimat');

  // ================= P22-T52: '*'-Datenrest, Nachschlagen ohne fortsetzung =================
  await pool.query("INSERT INTO agent_ausweis_projekte(identity_id,project) VALUES('t49-koord','*') ON CONFLICT DO NOTHING");
  const st52=await AP.ausweisProjekteStatus('t49-koord',P);
  check(!(st52?.projekte??[]).some(x=>x.project==='*'),'T52 "*"-Altzeile erscheint nicht im Ausweis-Status');
  const lauf52=(await pool.query("SELECT id FROM agent_identitaet_laeufe WHERE identity_id='t49-koord' ORDER BY erstellt_am DESC LIMIT 1")).rows[0]?.id;
  await pool.query('UPDATE agent_identitaet_laeufe SET zugestellt_projekte_stand=NULL WHERE id=$1',[lauf52]);
  const h52=await AP.ausweisProjekteHinweis({identity_id:'t49-koord',heimat:P,lauf_id:lauf52});
  check(!!lauf52&&!(h52??[]).some(t=>t.includes('"*"')),'T52 kein Hinweis "Im Projekt * gibt es keinen Koordinator" ('+JSON.stringify(h52)+')');
  const sql118=readFileSync(join(repo,'packages/core/src/db/schema-sql/118_agent_ausweis_projekte.sql'),'utf8');
  await pool.query(sql118);
  check((await pool.query("SELECT count(*)::int n FROM agent_ausweis_projekte WHERE project='*'")).rows[0].n===0,'T52 Schema 118 entfernt "*"-Altzeilen rueckwirkend');
  await pool.query(sql118);
  check(true,'T52 Schema 118 zweimal ausfuehrbar (idempotent)');
  const st52b=await tokenAufruf('admin',{action:'index_stats',role:'koordinator',onboarding:true,token:tokK},async k=>
    C.wendeSitzungsSignalAn({agentId:k.args.agent_id,project:k.args.project,sitzung:k.args.sitzung,role:k.args.role,onboarding:k.args.onboarding,serverInstanceId:SRV}));
  check(Array.isArray(st52b?.agentOnboarding?.rules)&&!st52b.agentOnboarding.zustellung?.koordinator_kurz&&!('ausweis_sitzung_hinweis' in (st52b??{})),'T52 index_stats(onboarding:true) OHNE sitzung: volles Onboarding, kein fortsetzung-Verweis');
  check(!/fortsetzung/.test(String(ob?.message)+String(ob?.statistik_abruf))&&/admin\(action:"index_stats", onboarding:true\)/.test(ob?.statistik_abruf??''),'T52 Koordinator-Kurzform: message/statistik_abruf ohne sitzung:"fortsetzung"');

  // ================= F: Legacy-Koordinator =================
  const lg=await O.holeAgentOnboarding({project:P,agentId:'koordinator-leg',role:'koordinator',serverInstanceId:SRV,explizit:true,koordinatorKurz:true});
  check(Array.isArray(lg?.rules)&&lg.rules.some(r=>r.name==='regel-pflicht-x'&&r.vollstaendig)&&!lg.zustellung&&!('handoff' in lg),'F Legacy-Koordinator (ohne Ausweis): unveraendert volles Onboarding');

  // ================= G: Subagent mit Typ wie P22-T48 =================
  await pool.query("INSERT INTO agent_typen(id,scope,project,schluessel,aktuelle_revision,erstellt_von) VALUES('t49-typ','projekt',$1,'t49-sub',1,'test')",[P]);
  await pool.query("INSERT INTO agent_typ_revisionen(typ_id,revision,inhalt,wer) VALUES('t49-typ',1,$1,'test')",[JSON.stringify({regeln:['regel-typ-a']})]);
  const tokS=neuerAusweis();
  await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,erstellt_von,typ_id) VALUES('t49-sub',$1,'sub','sub','subagent','test','t49-typ')",[P]);
  await pool.query('INSERT INTO agent_identitaet_tokens(id,identity_id,token_offen,token_praefix,ausweis_weg) VALUES($1,$2,$3,$4,$5)',[randomUUID(),'t49-sub',tokS,tokS.slice(0,12),'vorbereitet']);
  const sb=(await anmelden(tokS))?.agentOnboarding;
  check(sb?.rules?.map(r=>r.name).join()==='regel-typ-a'&&!('zustellung' in sb)&&!('handoff' in sb),'G Subagent mit Typ: wie P22-T48 (nur Typ-Regel voll), keine Koordinator-Kurzform');
  // P22-T52: kurze Subagent-Anmeldung
  const WEG52=['plaene','task_suche_hinweis','zustellung','rolle_hinweis','rolle_quelle','jev_hinweis','entscheidungen_durchsicht','volltext_hinweis','statistik_abruf','handoff','top3','aktiver_plan'];
  check(WEG52.every(k=>!(k in sb)),'T52 Subagent ohne Planliste/task_suche_hinweis/zustellung/rolle_hinweis/Uebersichten ('+Object.keys(sb??{}).join()+')');
  check(JSON.stringify(Object.keys(sb?.regel_verzeichnis??{}).sort())==='["abruf","regeln"]'&&sb.regel_verzeichnis.regeln.includes('regel-pflicht-x')&&/memory\(action:"read"/.test(sb.regel_verzeichnis.abruf??''),'T52 regel_verzeichnis nur Regelnamen + eine Abrufzeile ('+JSON.stringify(sb?.regel_verzeichnis)+')');
  check(!('channels' in sb)&&!('eigene_tasks' in sb),'T52 ohne eigene Channels/Tasks: Felder fehlen (fremde Channels nie)');
  const ch52=Number((await pool.query("INSERT INTO specialist_channels(name,project,created_by) VALUES('t52-eigen',$1,'test') RETURNING id",[P])).rows[0].id);
  await pool.query("INSERT INTO agent_identitaet_channel_mitglieder(channel_id,agent_name,identity_id,joined_at,last_read_message_id,last_notified_message_id,read_initialized_at) VALUES($1,'sub','t49-sub',NOW(),0,0,NOW())",[ch52]);
  const pt52=(kurz,title,status,bet)=>{const id=randomUUID();return pool.query("INSERT INTO plan_tasks(id,project,plan_id,task,plan_kurz_id,updated_at) VALUES($1,$2,'t52-plan',$3,'P52',$4)",[id,P,JSON.stringify({id,kurz_id:kurz,title,status,beteiligte:bet}),new Date().toISOString()]);};
  await pt52('P52-T1','Eigene Task','in_progress',[{agent_id:'sub',seit:'x',identity_id:'t49-sub'}]);
  await pt52('P52-T2','Eigene erledigt','done',[{agent_id:'sub',seit:'x',identity_id:'t49-sub'}]);
  await pt52('P52-T3','Fremde Task','todo',[{agent_id:'anderer',seit:'x'}]);
  const sb2raw=await anmelden(tokS); const sb2=sb2raw?.agentOnboarding;
  console.log('T52 BEISPIEL '+JSON.stringify(sb2raw));
  check(JSON.stringify(sb2?.channels)==='["t52-eigen"]','T52 channels = nur eigene Mitgliedschaften ('+JSON.stringify(sb2?.channels)+')');
  check(JSON.stringify(sb2?.eigene_tasks)==='["P52-T1 (in_progress): Eigene Task"]','T52 eigene offene Task (Beteiligung), keine erledigte, keine fremde ('+JSON.stringify(sb2?.eigene_tasks)+')');
  const vollSub=await tokenAufruf('admin',{action:'index_stats',role:'subagent',onboarding:true,token:tokS},async k=>
    C.wendeSitzungsSignalAn({agentId:k.args.agent_id,project:k.args.project,sitzung:k.args.sitzung,role:k.args.role,onboarding:k.args.onboarding,serverInstanceId:SRV}));
  const groesse=x=>Buffer.byteLength(JSON.stringify(x??null));
  console.log('T52 GROESSE anmelden(kurz, gesamt)='+groesse(sb2raw)+' B, agentOnboarding kurz='+groesse(sb2)+' B, volles Onboarding (Bestand)='+groesse(vollSub?.agentOnboarding)+' B');
  check(Array.isArray(vollSub?.agentOnboarding?.rules)&&groesse(sb2)<groesse(vollSub?.agentOnboarding),'T52 kurze Subagent-Anmeldung kleiner als das volle Onboarding');

  // ================= S: Skills (ausweis-fix 27972-27974) =================
  const DA=await load('packages/core/dist/services/agent-profil-dienst-a.js');
  let skOk=true; try{DA.pruefeProfilInhalt({skills:['superpowers-brainstorming','plugin:skill']});}catch{skOk=false;}
  let skBad=false; try{DA.pruefeProfilInhalt({skills:['kein gueltiger name!']});}catch(e){skBad=e?.code==='inhalt_ungueltig'||/inhalt_ungueltig/.test(String(e?.message));}
  check(skOk&&skBad,'S Validierung: skills als Liste gueltiger Skill-Namen (pruefeProfilInhalt)');
  await pool.query("UPDATE agent_identitaeten SET profil='{\"skills\":[\"superpowers-brainstorming\"]}'::jsonb WHERE id='t49-koord'");
  await pool.query("INSERT INTO agent_identitaet_skill_sections(punkt_id,skill_name,section,content,scope,project,agent,identity_id) VALUES(4949001,'eigene-section','regeln','x','agent',$1,'koordinator','t49-koord')",[P]);
  await pool.query("INSERT INTO agent_typen(id,scope,project,schluessel,aktuelle_revision,erstellt_von) VALUES('t49-andere','projekt',$1,'t49-andere',1,'test'),('t49-global','global',NULL,'t49-global',1,'test')",[P]);
  await pool.query("INSERT INTO agent_typ_revisionen(typ_id,revision,inhalt,wer) VALUES('t49-andere',1,$1,'test'),('t49-global',1,$2,'test')",[JSON.stringify({skills:['a','b','c']}),JSON.stringify({skills:['g1','g2']})]);
  await pool.query("UPDATE agent_identitaeten SET profil='{\"skills\":[\"sub-skill\"]}'::jsonb WHERE id='t49-sub'");
  // zugewiesene identitaetsgebundene Section einer ANDEREN Identitaet zaehlt mit; fremdes Projekt nicht
  await pool.query("INSERT INTO agent_identitaet_skill_sections(punkt_id,skill_name,section,content,scope,project,agent,identity_id) VALUES(4949002,'sub-section','regeln','x','agent',$1,'sub','t49-sub'),(4949003,'fremd-section','regeln','x','agent','anderes-projekt','sub','t49-sub')",[P]);
  const s1=(await anmelden(tokK))?.agentOnboarding;
  check(JSON.stringify(s1?.skills?.namen)==='["superpowers-brainstorming"]'&&JSON.stringify(s1?.skills?.identitaet)==='["eigene-section"]'&&/skills\(action:"get_full"/.test(s1?.skills?.abruf??'')&&!('content' in (s1?.skills??{})),'S Koordinator: eigene Skills nur Namen (Profil + Identitaets-Section) + Abrufzeile');
  check(JSON.stringify(s1?.skills_andere)==='["t49-andere » 3","t49-sub » 2"]','S andere nur Typ » Anzahl, nur dieses Projekt, ohne globale Typen ('+JSON.stringify(s1?.skills_andere)+')');
  const s2=(await anmelden(tokS))?.agentOnboarding;
  check(JSON.stringify(s2?.skills?.namen)==='["sub-skill"]'&&!('skills_andere' in (s2??{}))&&s2?.rules?.map(r=>r.name).join()==='regel-typ-a','S Typ-Agent: eigene Skills als Namen, keine Uebersicht anderer');

  // ================= H: profilverwaltung AUS =================
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'profilverwaltung',false,'Test P22-T49 aus','user')",[P]);
  L.leereLaufPuffer();
  const h1=(await anmelden(tokK))?.agentOnboarding;
  check(Array.isArray(h1?.rules)&&!h1.zustellung?.koordinator_kurz&&!('handoff' in h1),'H profilverwaltung AUS: volles Onboarding (Bestand)');
  L.leereLaufPuffer();
}catch(e){
  failures.push('Ausnahme: '+(e?.stack||e));console.error(e);
}finally{
  await pool?.end().catch(()=>{});
  await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>{});
  await admin.end();
}
console.log(`\nP22-T49: ${checks} Pruefungen, ${failures.length} Fehler`);
if(failures.length){console.error(failures.join('\n'));process.exit(1);}
