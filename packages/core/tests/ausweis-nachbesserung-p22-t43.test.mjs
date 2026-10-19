/**
 * P22-T43: Ausweis-Nachbesserung (B1, B2, D2-D6, D8, D9). Dienst-Ebene gegen synapse_test:5433, privates Schema.
 *   node packages/core/tests/ausweis-nachbesserung-p22-t43.test.mjs
 * Testbetrieb wie P22-T25: Modus 'beide', Altschalter EIN (SYNAPSE_TOKEN_IDENTITAET/W1B_ANMELDUNG + schattenprofile), dazu
 * Produkt-Schalter agenten_ausweis fuer das Testprojekt. D9 schaltet die Altschalter (Env) kurz AUS.
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
const schema='p22_t43_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t43-synthetic';
const SRV='srv-t43';
const failures=[];let checks=0;
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}else console.log('ok   '+label);}
const neuerAusweis=()=>'sai_'+randomBytes(32).toString('hex');

let pool;
try{
  await admin.query('CREATE SCHEMA '+schema);
  for(const {tablename} of (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows)await admin.query(`CREATE TABLE ${schema}."${tablename}" (LIKE public."${tablename}" INCLUDING ALL)`);
  const cl=await admin.connect();
  try{
    await cl.query('SET search_path TO '+schema);
    for(const f of ['111_agent_identitaet.sql','112_agent_bezug.sql','113_agent_profil.sql','114_agent_ausweis.sql','115_agent_ausweis_nr.sql'])await cl.query(readFileSync(join(repo,'packages/core/src/db/schema-sql/'+f),'utf8'));
  }finally{cl.release();}
  url.searchParams.set('options','-c search_path='+schema+',public');
  process.env.DATABASE_URL=url.href;
  const A=await load('packages/core/dist/services/agent-anmeldung.js');
  const B=await load('packages/core/dist/services/agent-bezug.js');
  const T=await load('packages/core/dist/services/agent-token-tools.js');
  const L=await load('packages/core/dist/services/agent-lauf.js');
  const O=await load('packages/core/dist/services/agent-onboarding.js');
  const CH=await load('packages/core/dist/services/channel-unread.js');
  const C=await load('packages/core/dist/services/chat.js');
  const PL=await load('packages/core/dist/services/plans.js');
  const SCH=await load('packages/core/dist/services/agent-profil-schalter.js');
  const {getPool}=await load('packages/core/dist/db/client.js');
  pool=getPool();

  for(const f of ['profilverwaltung','typkatalog','schattenprofile'])
    await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,$1,true,'Test P22-T43','user')",[f]);
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'agenten_ausweis',true,'Test P22-T43','user')",[P]);
  check((await SCH.leseAusweisKern(P)).aktiv===true,'Ausweis-Kern fuer Testprojekt EIN');
  await pool.query("INSERT INTO memories(id,project,name,category,content,tags) VALUES($1,$2,'regel-pflicht-x','rules','Pflichtregel X',ARRAY['pflicht'])",[randomUUID(),P]);
  const tokenAufruf=(tool,args,arbeit,optionen)=>T.mitAgentToolAufruf(tool,args,SRV,arbeit,undefined,undefined,optionen);
  const identitaet=async(id,agent,weg)=>{
    await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,erstellt_von) VALUES($1,$2,$3,$3,'subagent','test')",[id,P,agent]);
    const t=neuerAusweis();
    await pool.query('INSERT INTO agent_identitaet_tokens(id,identity_id,token_offen,token_praefix,ausweis_weg) VALUES($1,$2,$3,$4,$5)',[randomUUID(),id,t,t.slice(0,12),weg]);
    return t;
  };
  const kanal=async name=>(await pool.query("INSERT INTO specialist_channels(name,project,created_by) VALUES($1,$2,'test') RETURNING id",[name,P])).rows[0].id;
  const post=async(ch,sender)=>Number((await pool.query('INSERT INTO specialist_channel_messages(channel_id,sender,content) VALUES($1,$2,$3) RETURNING id',[ch,sender,'m'])).rows[0].id);

  // ================= B1: Uebernahme-Bruecke, eigene Legacy-Posts sind nicht ungelesen =================
  await A.registerChatAgent('legb',P,'opus');
  const chA=await kanal('t43-a'), chB=await kanal('t43-b'), chC=await kanal('t43-c');
  const a1=await post(chA,'fremd'); await post(chA,'legb'); const a3=await post(chA,'legb');
  const b4=await post(chB,'fremd'); await post(chB,'legb'); const b6=await post(chB,'fremd'); const b7=await post(chB,'legb');
  const c8=await post(chC,'fremd');
  const mitglied=(ch,lr,ln)=>pool.query('INSERT INTO specialist_channel_members(channel_id,agent_name,last_read_message_id,last_notified_message_id,read_initialized_at) VALUES($1,$2,$3,$4,NOW())',[ch,'legb',lr,ln]);
  await mitglied(chA,a1,a1); await mitglied(chB,b4,b6); await mitglied(chC,0,0);
  const tokB=await identitaet('t43-legb','legb','uebernahme');
  let kb;
  const hints=await tokenAufruf('thought',{action:'search',project:P,query:'x',token:tokB},async k=>{kb=k;return CH.claimUnreadChannelHints('legb');});
  check(!kb.antwort&&kb.principal?.identitaet?.id==='t43-legb','B1: Token-Aufruf der uebernommenen Identitaet angenommen');
  const lauf=(await pool.query('SELECT beginn_art FROM agent_identitaet_laeufe WHERE identity_id=$1',['t43-legb'])).rows[0];
  check(lauf?.beginn_art==='uebernahme','B1: Bruecke gelaufen (beginn_art uebernahme)');
  const namen=hints.map(h=>h.channel).sort();
  check(!namen.includes('t43-a'),'B1: nur eigene Legacy-Posts ungelesen -> kein Hinweis (vorher erneut gemeldet)');
  check(!namen.includes('t43-b'),'B1: fremde Ungelesene schon gemeldet, danach eigener Post -> kein erneuter Hinweis');
  check(namen.includes('t43-c')&&hints.find(h=>h.channel==='t43-c')?.count===1,'B1: echte fremde ungemeldete Nachricht bleibt gemeldet (Positivkontrolle)');
  const mA=(await pool.query('SELECT last_read_message_id lr,last_notified_message_id ln FROM agent_identitaet_channel_mitglieder WHERE identity_id=$1 AND channel_id=$2',['t43-legb',chA])).rows[0];
  check(Number(mA?.lr)===a3&&Number(mA?.ln)===a3,'B1: Lesemarken ueber eigene Posts vorgezogen');
  const mB=(await pool.query('SELECT last_read_message_id lr,last_notified_message_id ln FROM agent_identitaet_channel_mitglieder WHERE identity_id=$1 AND channel_id=$2',['t43-legb',chB])).rows[0];
  check(Number(mB?.lr)===b6-1&&Number(mB?.ln)===b7,'B1: fremde Ungelesene bleiben ungelesen (last_read vor erster fremder), last_notified = neueste');

  // ================= B2: chat(identitaet).schalter aus dem wirksamen Kern =================
  // wie im Live-Befund 1d699e28: global/Altschalter AUS, wirksam nur der Produkt-Schalter des Projekts (Aufruf ohne project)
  process.env.SYNAPSE_TOKEN_IDENTITAET='0'; process.env.SYNAPSE_W1B_ANMELDUNG='0';
  let ki;
  await tokenAufruf('chat',{action:'identitaet',token:tokB},async k=>{ki=k;return null;});
  process.env.SYNAPSE_TOKEN_IDENTITAET='1'; process.env.SYNAPSE_W1B_ANMELDUNG='1';
  const sch=ki.antwort?.schalter;
  check(ki.antwort?.success===true&&sch?.freigegeben===true,'B2: chat(identitaet) ok, freigegeben');
  check(sch?.quelle==='produkt-schalter'&&sch?.ausweis_kern?.aktiv===true&&sch?.ausweis_kern?.quelle==='produkt-schalter','B2: quelle aus leseAusweisKern (produkt-schalter), nicht alter Einzelschalter');
  check(sch?.bis===null&&sch?.alt_schalter&&sch.alt_schalter.quelle==='standard','B2: alter Schalter nur als Detail alt_schalter');

  // ================= D2/D5: Profil genau einmal je Lauf, Fortsetzungs-Text =================
  const tokD=await identitaet('t43-dneu','dneu','vorbereitet');
  let kd1;
  const anm1=await tokenAufruf('chat',{action:'anmelden',token:tokD},async k=>{kd1=k;return k.antwort;},{herkunft:'Test'});
  check(anm1?.success===true,'D2: erste Anmeldung ok');
  check(anm1?.agentOnboarding?.isFirstVisit===true&&/WILLKOMMEN/.test(anm1.agentOnboarding.message),'D5: erste Anmeldung einer neuen Identitaet = Begruessung');
  // P22-T50: kein fortsetzung-Block mehr; das Profil kommt (einmal je Lauf) im Onboarding.
  check(!('fortsetzung' in (anm1??{}))&&!('profil' in (anm1?.agentOnboarding??{})),'D2/T50: anmelden ohne fortsetzung; Profil ohne Inhalt (nur Revision) entfaellt');
  check(anm1?.agentOnboarding?.zustellung?.profilblock===true&&!('fortsetzung' in anm1.agentOnboarding.zustellung),'D2/T50: zustellung.profilblock true, ohne zustellung.fortsetzung');
  check(!('abloesung' in (anm1??{})),'T50: erste Anmeldung ohne Abloesungszeile');
  const folge1=await tokenAufruf('thought',{action:'search',project:P,query:'x',token:tokD},async()=>O.holeAgentOnboarding({project:P,agentId:'dneu',serverInstanceId:SRV}));
  check(folge1===null,'D2: Folgeaufruf nach anmelden ohne erneutes Profil');
  const anm2=await tokenAufruf('chat',{action:'anmelden',token:tokD},async k=>k.antwort,{herkunft:'Test'});
  check(anm2?.agentOnboarding?.isFirstVisit===false&&/ANMELDUNG/.test(anm2.agentOnboarding.message)&&!/FORTSETZUNG|neuer Agent/.test(anm2.agentOnboarding.message),'D5/T50: Anmeldung bestehender Identitaet = Neuanmeldung (ANMELDUNG, nicht FORTSETZUNG)');
  check(/^Vorheriger Lauf [0-9a-f-]{8} abgeloest\.$/.test(anm2?.abloesung??'')&&!('fortsetzung' in (anm2??{})),'T50: Abloesung des vorigen Laufs als eine Zeile ('+anm2?.abloesung+')');
  // P22-T50: index_stats(sitzung:'fortsetzung') mit Ausweis = kein Sitzungssignal (kein neuer Lauf), Verweis auf chat(anmelden);
  // onboarding:true liefert das volle Onboarding weiter als Nachschlagen (Profil ist im Lauf schon zugestellt).
  let ks;
  const st=await tokenAufruf('admin',{action:'index_stats',project:P,role:'subagent',sitzung:'fortsetzung',onboarding:true,token:tokD},async k=>{
    ks=k;
    return C.wendeSitzungsSignalAn({agentId:k.args.agent_id,project:k.args.project,sitzung:k.args.sitzung,role:k.args.role,onboarding:k.args.onboarding,serverInstanceId:SRV});
  });
  check(!ks.antwort&&!!st?.agentOnboarding,'D2: index_stats fortsetzung liefert Onboarding im Handler');
  check(ks.principal?.lauf_id===anm2?.principal?.lauf_id&&ks.principal?.context_epoch===anm2?.principal?.context_epoch,'T50: index_stats fortsetzung mit Ausweis beginnt keinen neuen Lauf (Epoch unveraendert)');
  check(/chat\(action:"anmelden"/.test(st?.ausweis_sitzung_hinweis??''),'T50: Verweis auf chat(anmelden) (ausweis_sitzung_hinweis)');
  check(!st?.agentOnboarding?.profil&&st?.agentOnboarding?.zustellung?.profilblock===false,'T50: Profil im Lauf schon zugestellt -> nicht erneut');
  const st2=await tokenAufruf('admin',{action:'index_stats',project:P,role:'subagent',sitzung:'fortsetzung',token:tokD},async k=>({sitzung:k.args.sitzung??null}));
  check(st2?.sitzung===null&&/chat\(action:"anmelden"/.test(st2?.ausweis_sitzung_hinweis??''),'T50: ohne onboarding:true wird sitzung entfernt, nur Verweis');
  check(st?.agentOnboarding?.isFirstVisit===false,'D5: Sitzungssignal einer bestehenden Identitaet = Fortsetzung');
  const folge2=await tokenAufruf('thought',{action:'search',project:P,query:'x',token:tokD},async()=>O.holeAgentOnboarding({project:P,agentId:'dneu',serverInstanceId:SRV}));
  check(folge2===null,'D2: nach Sitzungssignal kein erneutes Profil beim Folgeaufruf');

  // ================= D10: geaenderte Pflichtregel im laufenden Lauf -> nur diese voll =================
  await pool.query("INSERT INTO memories(id,project,name,category,content,tags) VALUES($1,$2,'regel-pflicht-z','rules','Pflichtregel Z',ARRAY['pflicht'])",[randomUUID(),P]);
  L.leereLaufPuffer();
  const anm10=await tokenAufruf('chat',{action:'anmelden',token:tokD},async k=>k.antwort,{herkunft:'Test'});
  check(anm10?.agentOnboarding?.rules?.filter(r=>r.vollstaendig).length===2,'D10: Anmeldung liefert beide Pflichtregeln');
  await new Promise(r=>setTimeout(r,30));
  await pool.query("UPDATE memories SET content='Pflichtregel Z neu', updated_at=NOW() WHERE project=$1 AND name='regel-pflicht-z'",[P]);
  L.leereLaufPuffer();
  const d10=await tokenAufruf('thought',{action:'search',project:P,query:'x',token:tokD},async()=>O.holeAgentOnboarding({project:P,agentId:'dneu',serverInstanceId:SRV}));
  check(d10?.rules?.length===1&&d10.rules[0].name==='regel-pflicht-z'&&d10.rules[0].content==='Pflichtregel Z neu','D10: nur die geaenderte Pflichtregel voll (vorher alle)');
  L.leereLaufPuffer();
  const d10b=await tokenAufruf('thought',{action:'search',project:P,query:'x',token:tokD},async()=>O.holeAgentOnboarding({project:P,agentId:'dneu',serverInstanceId:SRV}));
  check(d10b===null,'D10: danach nichts erneut');

  // ================= D3/D4: fortsetzung handoff + channels =================
  await pool.query("INSERT INTO thoughts(id,project,source,content,tags,timestamp,source_identity_id) VALUES($1,$2,'dneu','alt',ARRAY['auto-handoff'],NOW()-INTERVAL '1 hour','t43-dneu')",['t43-alt-'+randomUUID().slice(0,8),P]);
  const uebergabe='t43-ueb-'+randomUUID().slice(0,8);
  await pool.query("INSERT INTO thoughts(id,project,source,content,tags,timestamp,source_identity_id) VALUES($1,$2,'dneu','neu',ARRAY['session-uebergabe'],NOW(),'t43-dneu')",[uebergabe,P]);
  const chArch=await kanal('~archiv-20260815-x'), chRuhig=await kanal('aaa-ruhig'), chAktiv=await kanal('zzz-aktiv');
  await post(chRuhig,'fremd'); await post(chAktiv,'fremd'); await post(chArch,'fremd');
  for(const ch of [chArch,chRuhig,chAktiv])await pool.query("INSERT INTO agent_identitaet_channel_mitglieder(channel_id,agent_name,identity_id,last_read_message_id,last_notified_message_id,read_initialized_at) VALUES($1,'dneu','t43-dneu',0,0,NOW())",[ch]);
  const anm3=await tokenAufruf('chat',{action:'anmelden',token:tokD},async k=>k.antwort,{herkunft:'Test'});
  check(!('fortsetzung' in (anm3??{})),'T50: Anmeldung ohne fortsetzung-Block');
  // fortsetzungsInfo bleibt als Dienst bestehen (D3/D4 dort weiter geprueft), nur die Anmeldeantwort traegt sie nicht mehr.
  const pr=anm3?.principal??{};
  const fz=(await A.fortsetzungFuerAntwort({art:'identity',project:P,agent_id:'dneu',identity_id:'t43-dneu',rolle:pr.rolle,modell:pr.modell??null,context_epoch:pr.context_epoch,lauf_id:pr.lauf_id})).fortsetzung;
  const wege=fz?.abrufwege??[];
  check(wege.find(w=>w.art==='handoff')?.id===uebergabe,'D3: handoff = neueste Uebergabe mit Tag session-uebergabe');
  const chs=wege.filter(w=>w.art==='channel').map(w=>w.id);
  check(!chs.some(n=>n.startsWith('~archiv-')),'D4: Archiv-Channels ausgelassen');
  check(chs.indexOf('zzz-aktiv')>=0&&chs.indexOf('zzz-aktiv')<chs.indexOf('aaa-ruhig'),'D4: nach letzter Aktivitaet sortiert (nicht alphabetisch)');

  // ================= D6: chat(get, limit) ohne since = letzte N =================
  const ids=[];
  for(let i=0;i<5;i++)ids.push(Number((await pool.query("INSERT INTO chat_messages(project,sender_id,content,timestamp) VALUES($1,'s',$2,NOW()+($3||' seconds')::interval) RETURNING id",[P,'n'+i,String(i)])).rows[0].id));
  const letzte=await C.getMessages(P,{limit:2});
  check(letzte.map(m=>Number(m.id)).join(',')===ids.slice(3).join(','),'D6: ohne since die letzten 2, chronologisch');
  const ab=await C.getMessages(P,{limit:2,since:'2000-01-01T00:00:00Z'});
  check(ab.map(m=>Number(m.id)).join(',')===ids.slice(0,2).join(','),'D6: mit since unveraendert (aelteste zuerst, Polling)');
  const bez={modus:'beide',standard:'beide',quelle:'standard',bis:null,letzter_fehler:null};
  const idPfad=await B.mitAgentAufrufKontext({principal:null,bezug:bez},()=>C.getMessages(P,{limit:2}));
  check(idPfad.map(m=>Number(m.id)).join(',')===ids.slice(3).join(','),'D6: auch im ID-Bezug-Pfad die letzten 2');

  // ================= D8: plan(get, task_id) ohne plan_id =================
  const p1=await PL.createPlan(P,'t43-plan-1','eins',[],{aktiv:true});
  const p2=await PL.createPlan(P,'t43-plan-2','zwei',[]);
  const t1=await PL.addTask(P,'Task eins','x','medium',p1.id);
  const t2=await PL.addTask(P,'Task zwei','x','medium',p2.id);
  check(!!t2?.kurz_id&&(await PL.planRefFuerTaskIds(P,[t2.kurz_id]))===p2.id,'D8: Kurz-ID aus nicht aktivem Plan -> dieser Plan');
  check((await PL.planRefFuerTaskIds(P,[t2.id]))===p2.id,'D8: UUID aus nicht aktivem Plan -> dieser Plan');
  check((await PL.planRefFuerTaskIds(P,[t1.kurz_id,t2.kurz_id]))===null,'D8: Tasks aus zwei Plaenen -> null (aktiver Plan wie bisher)');
  check((await PL.planRefFuerTaskIds(P,['P999-T1']))===null&&(await PL.planRefFuerTaskIds(P,undefined))===null,'D8: unbekannt/leer -> null');

  // ================= D9: Ausweis eines anderen Projekts =================
  process.env.SYNAPSE_TOKEN_IDENTITAET='0'; process.env.SYNAPSE_W1B_ANMELDUNG='0';
  check((await SCH.leseAusweisKern('t43-fremd')).aktiv===false&&(await SCH.leseAusweisKern(P)).aktiv===true,'D9: Kern nur im Testprojekt EIN (Altschalter AUS)');
  let kf;
  await tokenAufruf('thought',{action:'search',project:'t43-fremd',query:'x',token:tokB},async k=>{kf=k;return null;});
  check(kf.antwort?.error==='agent_token_fremdes_projekt','D9: fremdes Projekt -> agent_token_fremdes_projekt (vorher token_identitaet_aus)');
  let ko;
  await tokenAufruf('thought',{action:'search',project:P,query:'x',token:tokB},async k=>{ko=k;return null;});
  check(!ko.antwort,'D9: eigenes Projekt weiterhin angenommen');
  let ku;
  await tokenAufruf('thought',{action:'search',project:'t43-fremd',query:'x',token:neuerAusweis()},async k=>{ku=k;return null;});
  check(ku.antwort?.error==='token_identitaet_aus'&&ku.antwort.schalter?.quelle!=='intern'&&/nicht wirksam/.test(ku.antwort.message??''),'D9: unbekannter Ausweis -> token_identitaet_aus mit klarer Meldung');
  process.env.SYNAPSE_TOKEN_IDENTITAET='1'; process.env.SYNAPSE_W1B_ANMELDUNG='1';
  L.leereLaufPuffer();
}catch(e){
  failures.push('Ausnahme: '+(e?.stack||e));console.error(e);
}finally{
  await pool?.end().catch(()=>{});
  await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>{});
  await admin.end();
}
console.log(`\nP22-T43: ${checks} Pruefungen, ${failures.length} Fehler`);
if(failures.length){console.error(failures.join('\n'));process.exit(1);}
