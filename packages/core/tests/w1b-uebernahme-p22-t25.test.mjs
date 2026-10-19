/**
 * P22-T25 (W12-B): Legacy-Uebernahme (TOKEN_BEREIT), Lauf-Zustellbuchhaltung, Uebernahme-Bruecke, Pflichtquellen,
 * Zustellung je Lauf im Onboarding, sai_-Schwaerzung. Dienst-Ebene gegen synapse_test:5433, privates Schema 111-114.
 *   node packages/core/tests/w1b-uebernahme-p22-t25.test.mjs
 * Testbetrieb (Vertrag W12): Modus 'beide', SYNAPSE_TOKEN_IDENTITAET=1, SYNAPSE_W1B_ANMELDUNG=1, Produkt-Schalter
 * schattenprofile EIN (global) -> leseAusweisKern aktiv.
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
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_INTERN_TOOL','SYNAPSE_W1B_DURCHSETZUNG','SYNAPSE_W1B_ANTWORTANPASSUNG','SYNAPSE_W1B_TOKEN_HINWEIS_MS'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_TOKEN_IDENTITAET:'1',SYNAPSE_W1B_ANMELDUNG:'1',
  SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_HINWEIS_BUDGET_MS:'5000',SYNAPSE_W1B_GATE_TTL_MS:'0',
  QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const {Pool}=require('pg');
const admin=new Pool({connectionString:url.href});
const schema='p22_t25_ue_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t25-synthetic';
const SRV='srv-t25';
const failures=[];let checks=0;
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}else console.log('ok   '+label);}
const user={art:'user'};
const warte=ms=>new Promise(r=>setTimeout(r,ms));

let pool;
try{
  await admin.query('CREATE SCHEMA '+schema);
  for(const {tablename} of (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows)await admin.query(`CREATE TABLE ${schema}."${tablename}" (LIKE public."${tablename}" INCLUDING ALL)`);
  const cl=await admin.connect();
  try{
    await cl.query('SET search_path TO '+schema);
    for(const f of ['111_agent_identitaet.sql','112_agent_bezug.sql','113_agent_profil.sql','114_agent_ausweis.sql'])await cl.query(readFileSync(join(repo,'packages/core/src/db/schema-sql/'+f),'utf8'));
  }finally{cl.release();}
  url.searchParams.set('options','-c search_path='+schema+',public');
  process.env.DATABASE_URL=url.href;
  const V=await load('packages/core/dist/services/agent-profil-vertrag.js');
  const A=await load('packages/core/dist/services/agent-anmeldung.js');
  const B=await load('packages/core/dist/services/agent-bezug.js');
  const H=await load('packages/core/dist/services/ausloeser-hinweise.js');
  const T=await load('packages/core/dist/services/agent-token-tools.js');
  const L=await load('packages/core/dist/services/agent-lauf.js');
  const O=await load('packages/core/dist/services/agent-onboarding.js');
  const CU=await load('packages/core/dist/services/chat-unread.js');
  const S=await load('packages/core/dist/services/tool-args-schwaerzen.js');
  const SCH=await load('packages/core/dist/services/agent-profil-schalter.js');
  const {getPool}=await load('packages/core/dist/db/client.js');
  pool=getPool();

  for(const f of ['profilverwaltung','typkatalog','schattenprofile'])
    await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,$1,true,'Test W12-B','user')",[f]);
  check((await SCH.leseAusweisKern(P)).aktiv===true,'Ausweis-Kern im Testbetrieb EIN');
  check(V.W12_PFLICHT_HINWEISQUELLEN.includes(V.HINWEIS_QUELLE_TOKEN_BEREIT)&&A.TOKEN_BEREIT_QUELLE.quelle_id===V.HINWEIS_QUELLE_TOKEN_BEREIT,'TOKEN_BEREIT = Vertrags-Pflichtquelle');
  await pool.query("INSERT INTO memories(id,project,name,category,content,tags) VALUES($1,$2,'regel-pflicht-x','rules','Pflichtregel X',ARRAY['pflicht']),($3,$2,'regel-normal-y','rules','Normale Regel Y',ARRAY[]::text[])",[randomUUID(),P,randomUUID()]);

  const bez={modus:'beide',standard:'beide',quelle:'standard',bis:null,letzter_fehler:null};
  const legacy=id=>({principal:{art:'legacy',project:P,agent_id:id},bezug:bez});
  const hinweise=(id,ctx=legacy(id))=>B.mitAgentAufrufKontext(ctx,()=>H.haengeAusloeserHinweiseAn({success:true},'thought',{project:P,action:'get'},id));
  const zeilen=r=>(r&&r.ausloeser_hinweise)||[];
  const bereit=r=>zeilen(r).filter(z=>z.includes('Agenten-Ausweis ist bereit'));
  const tokenAufruf=(tool,args,arbeit,optionen)=>T.mitAgentToolAufruf(tool,args,SRV,arbeit,undefined,undefined,optionen);

  // ---- Legacy-Agent leg1: Anmeldung, Onboarding, Channel, Lesestand, offene DM
  await A.registerChatAgent('leg1',P,'opus');
  const ob0=await B.mitAgentAufrufKontext(legacy('leg1'),()=>O.holeAgentOnboarding({project:P,agentId:'leg1',serverInstanceId:SRV,explizit:true}));
  check(!!ob0&&ob0.rules.some(r=>r.name==='regel-pflicht-x'&&r.vollstaendig),'Legacy-Onboarding liefert Pflichtregel voll');
  check(ob0&&!('zustellung' in ob0)&&!('neuinstanz_hinweis' in ob0),'Legacy-Onboarding: Bestandsform ohne W12-Felder');
  const ch=(await pool.query("INSERT INTO specialist_channels(name,project,created_by) VALUES('t25-ch',$1,'test') RETURNING id",[P])).rows[0].id;
  await pool.query('INSERT INTO specialist_channel_members(channel_id,agent_name,last_read_message_id,read_initialized_at) VALUES($1,$2,0,NOW())',[ch,'leg1']);
  await B.mitAgentAufrufKontext(legacy('leg1'),()=>CU.initialisiereChatLesestand(P,'leg1'));
  await pool.query("INSERT INTO chat_messages(project,sender_id,recipient_id,content) VALUES($1,'kollege','leg1','offene DM')",[P]);

  // ---- Weg A: Schatten -> Bestaetigung -> Ausweis aktiv
  const s=(await pool.query("SELECT id,revision,zustand FROM agent_schattenprofile WHERE project=$1 AND ursprung_agent_id='leg1'",[P])).rows[0];
  check(s?.zustand==='pending','Legacy-Anmeldung legt Schatten an (pending)');
  const best=await V.W1B_DIENSTE.schatten.bestaetigeSchattenprofil({schattenprofil_id:s.id,erwartete_revision:s.revision,user_zustimmung:'Test-Nachweis',grund:'Test W12-B'},user);
  const iid=best.identity_id;
  const tok=(await pool.query('SELECT id,token_offen,zuletzt_benutzt FROM agent_identitaet_tokens WHERE identity_id=$1 AND widerrufen_am IS NULL',[iid])).rows[0];
  check(!!tok?.token_offen&&/^sai_[a-f0-9]{64}$/.test(tok.token_offen)&&!tok.zuletzt_benutzt,'Bestaetigung: offener, unbenutzter Ausweis');
  const token=tok.token_offen;
  A.registriereW1bAnmeldungHinweise();

  // ---- laufender Legacy-Agent: Aufruf normal + TOKEN_BEREIT
  const vor=await tokenAufruf('thought',{action:'search',project:P,agent_id:'leg1',query:'x'},async k=>k);
  check(!vor.antwort&&B.aktuellerAgentPrincipal()===null,'Legacy-Aufruf ohne token laeuft normal (keine Ablehnung)');
  const h1=bereit(await hinweise('leg1'));
  check(h1.length===1&&h1[0].includes(token),'TOKEN_BEREIT mit Ausweis beim naechsten Legacy-Aufruf');
  check(h1[0]?.includes('nie chat(register)'),'TOKEN_BEREIT-Text vollstaendig (Pflichtquelle > 240 Zeichen)');
  check(bereit(await hinweise('leg1')).length===0,'entprellt: kein sofortiger Wiederholungshinweis');
  // Pflicht: Kontextprofil schaltet die Quelle ab -> trotzdem zugestellt
  await pool.query("INSERT INTO ausloeser_hinweis_profile(project,ziel,hinweise_aus,gesetzt_von) VALUES($1,'leg1',ARRAY['w1b.token_bereit'],'test')",[P]);
  await pool.query("UPDATE agent_sessions SET sitzung_seit=clock_timestamp() WHERE id='leg1' AND project=$1",[P]);
  const h2=bereit(await hinweise('leg1'));
  check(h2.length===1&&h2[0].includes(token),'nach Kontextverlust (neue Legacy-Sitzung) erneut, trotz hinweise_aus (Pflicht)');
  // Kern AUS -> kein Hinweis (Positivkontrolle)
  process.env.SYNAPSE_W1B_ANMELDUNG='0';
  await pool.query("UPDATE agent_sessions SET sitzung_seit=clock_timestamp() WHERE id='leg1' AND project=$1",[P]);
  check(bereit(await hinweise('leg1')).length===0,'Kern AUS: kein TOKEN_BEREIT');
  process.env.SYNAPSE_W1B_ANMELDUNG='1';
  // Die neue Legacy-Sitzung erhaelt ihre Regeln (index_stats sitzung neu) -> Onboarding-Nachweis fuer die Bruecke.
  await B.mitAgentAufrufKontext(legacy('leg1'),()=>O.holeAgentOnboarding({project:P,agentId:'leg1',serverInstanceId:SRV,explizit:true}));

  // ---- erster Token-Aufruf OHNE anmelden: Lauf 'uebernahme' + Bruecke
  let k1;
  const erst=await tokenAufruf('thought',{action:'search',project:P,query:'x',token},async k=>{
    k1=k;
    const hz=await H.haengeAusloeserHinweiseAn({success:true},'thought',{project:P,action:'get'},'leg1');
    const ob=await O.holeAgentOnboarding({project:P,agentId:'leg1',serverInstanceId:SRV});
    const unread=await CU.getUnreadChatHint(P,'leg1');
    return {hz,ob,unread};
  });
  check(!k1.antwort&&k1.principal?.identitaet?.id===iid,'Token-Aufruf ohne anmelden angenommen');
  check(!!k1.principal?.lauf_id,'Lauf beim ersten Token-Aufruf angelegt (lauf_id im Principal)');
  const lauf1=(await pool.query('SELECT * FROM agent_identitaet_laeufe WHERE id=$1',[k1.principal.lauf_id])).rows[0];
  check(lauf1?.beginn_art==='uebernahme'&&lauf1.uebernommen_aus?.agent_id==='leg1'&&lauf1.uebernommen_aus?.schattenprofil_id===s.id,'beginn_art uebernahme, uebernommen_aus = leg1/Schatten');
  check((await pool.query('SELECT 1 FROM agent_identitaet_sitzungen WHERE identity_id=$1',[iid])).rowCount===1,'Identitaets-Sitzung angelegt (kein hinweis_identitaet_sitzung_fehlt)');
  check(zeilen(erst.hz).filter(z=>z.includes('Agenten-Ausweis')).length===0,'Token-Aufruf: kein TOKEN_BEREIT');
  check(erst.ob===null||(Array.isArray(erst.ob.rules)&&erst.ob.rules.length===0),'keine erneuten Projektregeln nach Uebernahme');
  check(!!lauf1?.zugestellt_regeln_stand,'Regelstand aus Legacy-Onboarding uebernommen');
  check((await pool.query('SELECT 1 FROM agent_identitaet_onboardings WHERE identity_id=$1',[iid])).rowCount>=1,'Onboarding-Nachweis uebernommen');
  check((await pool.query('SELECT 1 FROM agent_identitaet_channel_mitglieder WHERE identity_id=$1 AND channel_id=$2',[iid,ch])).rowCount===1,'Channel-Mitgliedschaft uebernommen');
  check((await pool.query("SELECT 1 FROM chat_messages WHERE project=$1 AND recipient_id='leg1' AND recipient_identity_id=$2",[P,iid])).rowCount===1,'offene DM auf die Identitaet umgehaengt');
  check(erst.unread?.dms?.some(d=>d.from==='kollege'&&d.count===1),'offene Legacy-DM bleibt ungelesen (Hinweis an Identitaet)');
  check((await pool.query("SELECT 1 FROM agent_identitaet_audit WHERE identity_id=$1 AND aktion='legacy_uebernahme'",[iid])).rowCount===1,'Audit legacy_uebernahme');

  // ---- danach: TOKEN_BEREIT nie wieder, keine zweite Bruecke, Folgeaufruf ohne Onboarding
  await pool.query("UPDATE agent_sessions SET sitzung_seit=clock_timestamp() WHERE id='leg1' AND project=$1",[P]);
  check(bereit(await hinweise('leg1')).length===0,'nach erstem Token-Aufruf nie wieder TOKEN_BEREIT (auch neue Legacy-Sitzung)');
  L.leereLaufPuffer();
  let k2;
  const zweit=await tokenAufruf('thought',{action:'search',project:P,query:'x',token},async k=>{k2=k;return O.holeAgentOnboarding({project:P,agentId:'leg1',serverInstanceId:SRV});});
  check(k2.principal?.lauf_id===k1.principal.lauf_id,'Folgeaufruf: derselbe Lauf');
  check(zweit===null,'Folgeaufruf im selben Lauf: nichts doppelt');
  check((await pool.query('SELECT 1 FROM agent_identitaet_laeufe WHERE identity_id=$1 AND uebernommen_aus IS NOT NULL',[iid])).rowCount===1,'Bruecke genau einmal');
  const u2=await V.W12_DIENSTE.lauf.uebernehmeLegacy(iid,{agent_id:'leg1',sitzung:null,schattenprofil_id:s.id},k1.principal.lauf_id);
  check(u2.bereits_uebernommen===true,'uebernehmeLegacy idempotent (Vertragsdienst)');

  // ---- neuer Lauf aus anderem Transport: anmelden -> Pflichtregeln voll + Verzeichnis + Profilblock
  let k3;
  const anm=await tokenAufruf('chat',{action:'anmelden',token},async k=>{k3=k;return k.antwort;},{herkunft:'REST-Test'});
  check(anm?.success===true&&k3.principal.lauf_id!==k1.principal.lauf_id,'chat(anmelden): neuer Lauf');
  check(anm?.agentOnboarding?.rules?.some(r=>r.name==='regel-pflicht-x'&&r.vollstaendig)&&!!anm.agentOnboarding.regel_verzeichnis,'neuer Lauf: Pflichtregeln voll + regel_verzeichnis');
  check(anm?.agentOnboarding?.neuinstanz_hinweis===V.TEXT_NEUINSTANZ,'TEXT_NEUINSTANZ im Onboarding');
  check(!!anm?.fortsetzung?.profil,'neuer Lauf: Profilblock (W12-C)');
  const lauf3=(await pool.query('SELECT beginn_art,zugestellt_regeln_stand FROM agent_identitaet_laeufe WHERE id=$1',[k3.principal.lauf_id])).rows[0];
  check(lauf3?.beginn_art==='anmelden'&&!!lauf3.zugestellt_regeln_stand,'Lauf beginn_art anmelden, Regelstand markiert');
  const nach=await tokenAufruf('thought',{action:'search',project:P,query:'x',token},async()=>O.holeAgentOnboarding({project:P,agentId:'leg1',serverInstanceId:SRV}));
  check(nach===null,'nach Anmeldung: Folgeaufruf ohne erneute Regeln');

  // ---- geaenderte Pflichtregel -> im selben Lauf erneut voll (ohne Verzeichnis)
  await warte(20);
  await pool.query("UPDATE memories SET content='Pflichtregel X neu', updated_at=NOW() WHERE project=$1 AND name='regel-pflicht-x'",[P]);
  L.leereLaufPuffer();
  const neuR=await tokenAufruf('thought',{action:'search',project:P,query:'x',token},async()=>O.holeAgentOnboarding({project:P,agentId:'leg1',serverInstanceId:SRV}));
  check(neuR?.rules?.length===1&&neuR.rules[0].content==='Pflichtregel X neu'&&!('regel_verzeichnis' in neuR),'geaenderte Pflichtregel erneut voll, ohne Verzeichnis');

  // ---- Identitaet ohne Legacy-Ursprung: erster Token-Aufruf 'implizit'
  await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,erstellt_von) VALUES('t25-imp',$1,'imp','imp','subagent','test')",[P]);
  const tokImp='sai_'+randomBytes(32).toString('hex');
  await pool.query("INSERT INTO agent_identitaet_tokens(id,identity_id,token_offen,token_praefix,ausweis_weg) VALUES($1,'t25-imp',$2,$3,'vorbereitet')",[randomUUID(),tokImp,tokImp.slice(0,12)]);
  let ki;
  const imp=await tokenAufruf('thought',{action:'search',project:P,query:'x',token:tokImp},async k=>{ki=k;return O.holeAgentOnboarding({project:P,agentId:'imp',serverInstanceId:SRV});});
  const laufI=(await pool.query('SELECT beginn_art,uebernommen_aus FROM agent_identitaet_laeufe WHERE identity_id=$1',['t25-imp'])).rows;
  check(!ki.antwort&&laufI.length===1&&laufI[0].beginn_art==='implizit'&&laufI[0].uebernommen_aus===null,'Identitaet ohne Legacy: Lauf implizit, keine Bruecke');
  check(imp?.rules?.some(r=>r.name==='regel-pflicht-x')&&imp.regel_verzeichnis?.regeln?.includes('regel-normal-y'),'implizit: Pflichtregeln voll + Regelnamen im Verzeichnis');
  const imp2=await tokenAufruf('thought',{action:'search',project:P,query:'x',token:tokImp},async()=>O.holeAgentOnboarding({project:P,agentId:'imp',serverInstanceId:SRV}));
  check(imp2===null,'implizit: Folgeaufruf nichts doppelt');

  // ---- Schatten nach 24 h ohne Bestaetigung erloschen
  await A.registerChatAgent('leg2',P,'sonnet');
  const s2=(await pool.query("SELECT id,revision FROM agent_schattenprofile WHERE project=$1 AND ursprung_agent_id='leg2'",[P])).rows[0];
  await pool.query("UPDATE agent_schattenprofile SET erstellt_am=NOW()-INTERVAL '25 hours', ablauf_am=NOW()-INTERVAL '1 hour' WHERE id=$1",[s2.id]);
  let abgelehnt=false;
  try{await V.W1B_DIENSTE.schatten.bestaetigeSchattenprofil({schattenprofil_id:s2.id,erwartete_revision:s2.revision,user_zustimmung:'x',grund:'Test W12-B'},user);}catch{abgelehnt=true;}
  check(abgelehnt,'Schatten nach 24 h nicht mehr bestaetigbar');
  check(bereit(await hinweise('leg2')).length===0,'abgelaufener Schatten: kein Ausweis, kein TOKEN_BEREIT');

  // ---- Registry an wirksamen Schalter gekoppelt
  A.entregistriereW1bAnmeldungHinweise();
  await A.sichereW1bAnmeldungHinweise(true);
  let doppelt=false;
  try{H.registriereHinweisQuelle({quelle_id:'w1b.token_bereit',pruefe:()=>[]});}catch{doppelt=true;}
  check(doppelt,'sichereW1bAnmeldungHinweise registriert bei wirksamem Schalter');

  // ---- sai_-Schwaerzung (tool_calls)
  const sj=S.schwaerzeToolLogText(JSON.stringify({token,action:'search'}));
  const st=S.schwaerzeToolLogText('Dein Agenten-Ausweis ist bereit: '+token+'. Praefix '+token.slice(0,12));
  check(!sj.includes(token)&&!st.includes(token),'sai_-Ausweis in args und freiem Text geschwaerzt');
  check(st.includes(token.slice(0,12)),'Praefix bleibt als Zuordnung sichtbar');
  check(!JSON.stringify(await pool.query("SELECT args_preview,result FROM tool_calls WHERE args_preview LIKE '%sai_%' OR result LIKE '%sai_%'").then(r=>r.rows)).match(/sai_[a-f0-9]{64}/),'kein Ausweis im tool_calls-Log');
}catch(e){
  failures.push('Ausnahme: '+(e?.stack||e));console.error(e);
}finally{
  await pool?.end().catch(()=>{});
  await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>{});
  await admin.end();
}
console.log(`\nP22-T25 W12-B: ${checks} Pruefungen, ${failures.length} Fehler`);
if(failures.length){console.error(failures.join('\n'));process.exit(1);}
