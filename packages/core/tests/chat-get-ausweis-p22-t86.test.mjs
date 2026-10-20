/**
 * P22-T86: chat(action:"get") mit Ausweis liefert nur Nachrichten an die eigene Identitaet/den eigenen Namen (Befund thought 08eb5dd6).
 * Dienst-Ebene gegen synapse_test:5433, privates Schema.  node packages/core/tests/chat-get-ausweis-p22-t86.test.mjs
 * Geprueft: fremde Broadcasts/DMs und eigene Sendungen erscheinen nicht, eigene DMs (Identitaet + Legacy-Name) schon, neueste zuerst,
 * limit, sender_id_filter, leer + Hinweis channel(feed), Lesestand, message_id = Bestandsweg, Produkt-Schalter (Standard EIN,
 * AUS = Bestand, 'alle' wirkt nicht), intern-Override, Debugfeld filter.
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
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_INTERN_TOOL','SYNAPSE_W1B_DURCHSETZUNG','SYNAPSE_W1B_ANTWORTANPASSUNG',
  'SYNAPSE_W1B_TOKEN_HINWEIS_MS','SYNAPSE_AGENTEN_AUSWEIS','SYNAPSE_TOKEN_IDENTITAET','SYNAPSE_W1B_ANMELDUNG'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_INTERN_TOOL:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_AGENT_BEZUG_MODUS:'beide',
  SYNAPSE_HINWEIS_BUDGET_MS:'5000',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
  QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
globalThis.fetch=async()=>{throw Error('Testnetz gesperrt');};
const {Pool}=require('pg');
const admin=new Pool({connectionString:url.href});
const schema='p22_t86_'+process.pid+'_'+randomUUID().slice(0,8);
const H='p22-t86-heimat',SRV='srv-t86';
const failures=[];let checks=0;
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label,info){checks++;if(!ok){failures.push(label);console.error('FAIL '+label+(info!==undefined?' '+mask(JSON.stringify(info)):''));}else console.log('ok   '+label);}
async function abschnitt(name,fn){try{await fn();}catch(e){failures.push(name+': '+mask(e.message));console.error('FAIL Abschnitt '+name+': '+mask(e.stack));}}
const neuerAusweis=()=>'sai_'+randomBytes(32).toString('hex');

let pool;
try{
  await admin.query('CREATE SCHEMA '+schema);
  for(const {tablename} of (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows)await admin.query(`CREATE TABLE ${schema}."${tablename}" (LIKE public."${tablename}" INCLUDING ALL)`);
  const serials=await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%' ORDER BY table_name,column_name",[schema]);
  for(const [i,r]of serials.rows.entries()){
    const q=s=>'"'+s.replaceAll('"','""')+'"',seq=schema+'.t86_serial_'+i;
    await admin.query('CREATE SEQUENCE '+seq);
    await admin.query('ALTER TABLE '+schema+'.'+q(r.table_name)+' ALTER COLUMN '+q(r.column_name)+" SET DEFAULT nextval('"+seq+"'::regclass)");
  }
  const cl=await admin.connect();
  try{
    await cl.query('SET search_path TO '+schema);
    for(const f of ['111_agent_identitaet.sql','112_agent_bezug.sql','113_agent_profil.sql','114_agent_ausweis.sql','115_agent_ausweis_nr.sql',
      '117_agent_ausweis_fristen.sql','118_agent_ausweis_projekte.sql','126_agent_entfernung.sql','129_agent_umbenennung.sql'])await cl.query(readFileSync(join(repo,'packages/core/src/db/schema-sql/'+f),'utf8'));
  }finally{cl.release();}
  url.searchParams.set('options','-c search_path='+schema+',public');
  process.env.DATABASE_URL=url.href;
  const T=await load('packages/core/dist/services/agent-token-tools.js');
  const SCH=await load('packages/core/dist/services/agent-profil-schalter.js');
  const CA=await load('packages/core/dist/services/chat-ausweis-lesen.js');
  const {getPool}=await load('packages/core/dist/db/client.js');
  pool=getPool();

  await SCH.setzeProfilProduktSchalter({ebene:'global',funktion:'agenten_ausweis',aktiv:true,grund:'Test P22-T86 Kern EIN'},{system:'user'});
  const identitaet=async(id,agent,rolle)=>{
    await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,erstellt_von) VALUES($1,$2,$3,$3,$4,'test')",[id,H,agent,rolle]);
    const t=neuerAusweis();
    await pool.query('INSERT INTO agent_identitaet_tokens(id,identity_id,token_offen,token_praefix,ausweis_weg) VALUES($1,$2,$3,$4,$5)',[randomUUID(),id,t,t.slice(0,12),'register']);
    return t;
  };
  const tokIch=await identitaet('t86-ich','t86-ich','subagent');
  const tokLeer=await identitaet('t86-leer','t86-leer','subagent');
  await identitaet('t86-koord','t86-koord','koordinator');
  const msg=async(sender,recipient,content,tage,{si=null,ri=null}={})=>(await pool.query(
    "INSERT INTO chat_messages(project,sender_id,recipient_id,content,timestamp,sender_identity_id,recipient_identity_id) VALUES($1,$2,$3,$4,NOW()-($5||' days')::interval,$6,$7) RETURNING id",
    [H,sender,recipient,content,String(tage),si,ri])).rows[0].id;
  // Befund-Lage: alte globale Broadcasts und fremde DMs (April/Mai), dazu die eigenen DMs.
  const altBroadcast=await msg('quiz-erweiterer',null,'saar-geographie.html erweitert',180);
  const fremdeDm=await msg('quiz-designer','flow-p2-e','fremder Auftrag',170);
  const fremdeIdDm=await msg('t86-koord','t86-leer-nicht',"DM an andere Identitaet",1,{si:'t86-koord',ri:'t86-koord'});
  const eigeneSendung=await msg('t86-ich','t86-koord','von mir gesendet',0.5,{si:'t86-ich',ri:'t86-koord'});
  const legacyDm=await msg('altagent','t86-ich','Legacy-DM an meinen Namen',2);
  const idDmAlt=await msg('t86-koord','t86-ich','Auftrag alt',1,{si:'t86-koord',ri:'t86-ich'});
  const idDmNeu=await msg('t86-koord','t86-ich','Auftrag neu',0.1,{si:'t86-koord',ri:'t86-ich'});
  const aufruf=async(args)=>{let k;await T.mitAgentToolAufruf('chat',args,SRV,async x=>{k=x;return {success:true,handler:true};});return k;};

  await abschnitt('Schalter Standard',async()=>{
    const s=await CA.leseChatGetEigeneSchalter();
    check(s.aktiv===true&&s.quelle==='standard','chat_get_eigene Standard EIN',s);
    check(SCH.PROFIL_PRODUKT_FUNKTIONEN.includes('chat_get_eigene')&&SCH.NUR_AUSDRUECKLICH.includes('chat_get_eigene')&&SCH.STANDARD_EIN.includes('chat_get_eigene'),'im Katalog, nur ausdruecklich, Standard EIN');
  });

  await abschnitt('Nur eigene Nachrichten, neueste zuerst',async()=>{
    const k=await aufruf({action:'get',limit:5,token:tokIch});
    const a=k.antwort;const ids=(a?.messages??[]).map(m=>m.id);
    check(a?.success===true&&a.action==='get','Antwort vor dem Handler (Ausweis-Weg)',a);
    check(JSON.stringify(ids)===JSON.stringify([idDmNeu,idDmAlt,legacyDm]),'genau eigene DMs (Identitaet + Legacy-Name), neueste zuerst',ids);
    for(const [id,l] of [[altBroadcast,'alter Broadcast'],[fremdeDm,'fremde Legacy-DM'],[fremdeIdDm,'fremde Identitaets-DM'],[eigeneSendung,'eigene Sendung']])check(!ids.includes(id),l+' erscheint nicht');
    check(a?.reihenfolge==='neueste_zuerst'&&!a.hinweis,'reihenfolge sichtbar, kein Leer-Hinweis');
    check(a?.filter?.identity_id==='t86-ich'&&a.filter.agent_id==='t86-ich'&&a.filter.project===H&&a.filter.schalter?.quelle==='standard','Debugfeld filter (Identitaet, Name, Projekt, Schalterquelle)',a?.filter);
    const ls=(await pool.query('SELECT letzte_id FROM agent_identitaet_chat_lesestand WHERE project=$1 AND identity_id=$2',[H,'t86-ich'])).rows[0];
    check(Number(ls?.letzte_id)===Number(Math.max(idDmNeu,idDmAlt,legacyDm)),'Lesestand der Identitaet auf neueste gelieferte Nachricht',ls);
  });

  await abschnitt('limit und sender_id_filter',async()=>{
    const k1=await aufruf({action:'get',limit:1,token:tokIch});
    check(k1.antwort?.messages?.length===1&&k1.antwort.messages[0].id===idDmNeu,'limit 1 -> nur die neueste');
    const k2=await aufruf({action:'get',sender_id_filter:'altagent',token:tokIch});
    check(k2.antwort?.messages?.length===1&&k2.antwort.messages[0].id===legacyDm,'sender_id_filter nach Name');
    const k3=await aufruf({action:'get',sender_id_filter:'t86-koord',token:tokIch});
    check(JSON.stringify(k3.antwort?.messages?.map(m=>m.id))===JSON.stringify([idDmNeu,idDmAlt]),'sender_id_filter nach Identitaet');
  });

  await abschnitt('Leer mit Hinweis',async()=>{
    const k=await aufruf({action:'get',limit:5,token:tokLeer});
    check(k.antwort?.success===true&&k.antwort.count===0&&/channel\(action:"feed"/.test(k.antwort.hinweis??''),'ohne eigene Nachrichten: leer + Hinweis channel(feed)',k.antwort);
  });

  await abschnitt('message_id = Bestandsweg',async()=>{
    const k=await aufruf({action:'get',message_id:idDmNeu,token:tokIch});
    check(!k.antwort,'Einzelabruf geht an den Handler');
  });

  // P22-T80 Teil 3: Legacy-Agent t86-alt wurde vor 1 Tag zu archiv-20261019-t86-alt umbenannt; ein NEUER Agent (Identitaet) traegt den Namen.
  await abschnitt('Zusammen mit dem Archiv-Filter',async()=>{
    const ARCH='archiv-20261019-t86-alt';
    await pool.query("INSERT INTO agent_entfernungen(project,art,agent_id,entfernt_am,entfernt_grund,entfernt_von,lauf_id,frueherer_name,neuer_name) VALUES($1,'legacy',$2,NOW()-interval '1 day','Test T86','user','t86-lauf','t86-alt',$2)",[H,ARCH]);
    const tokAlt=await identitaet('t86-alt-neu','t86-alt','subagent');
    const vorher=await msg('quiz-koord','t86-alt','DM an den alten Traeger',3);
    const nachher=await msg('quiz-koord','t86-alt','DM an den neuen Traeger (Name)',0.2);
    const idDm=await msg('t86-koord','t86-alt','DM an die neue Identitaet',0.1,{si:'t86-koord',ri:'t86-alt-neu'});
    const k=await aufruf({action:'get',limit:10,token:tokAlt});
    const ids=(k.antwort?.messages??[]).map(m=>m.id);
    check(JSON.stringify(ids)===JSON.stringify([idDm,nachher]),'neuer Traeger: Identitaets-DM + Namens-DM nach der Umbenennung, neueste zuerst',ids);
    check(!ids.includes(vorher),'neuer Traeger: Namens-DM vor der Umbenennung gehoert dem Archiv');
    const arch=await CA.leseEigeneChatNachrichten(H,{identity_id:'t86-leer',agent_id:ARCH},{limit:10});
    const aids=arch.map(m=>m.id);
    check(aids.includes(vorher)&&!aids.includes(nachher)&&!aids.includes(idDm),'Archiv-Eintrag liest die Namens-DM vor der Umbenennung, nichts danach',aids);
  });

  await abschnitt('Produkt-Schalter',async()=>{
    await SCH.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:false,grund:'Test P22-T86 alle AUS'},{system:'user'});
    check((await CA.leseChatGetEigeneSchalter()).aktiv===true,"'alle' AUS wirkt nicht (nur ausdruecklich)");
    await pool.query("DELETE FROM agent_profil_schalter WHERE funktion='alle'");
    await SCH.setzeProfilProduktSchalter({ebene:'global',funktion:'chat_get_eigene',aktiv:false,grund:'Test P22-T86 AUS'},{system:'user'});
    const s=await CA.leseChatGetEigeneSchalter();
    check(s.aktiv===false&&s.quelle==='produkt-schalter','Produkt-Schalter AUS, Quelle sichtbar',s);
    const k=await aufruf({action:'get',limit:5,token:tokIch});
    check(!k.antwort&&k.args.agent_id==='t86-ich','AUS = Bestand (Handler, agent_id bezeugt)',k.antwort);
    await pool.query("INSERT INTO intern_schalter(name,aktiv,modus,bis) VALUES('chat_get_eigene',true,'freigegeben',NOW()+interval '1 hour') ON CONFLICT DO NOTHING").catch(e=>{throw Error('intern_schalter: '+e.message);});
    const si=await CA.leseChatGetEigeneSchalter();
    check(si.aktiv===true&&si.quelle==='intern'&&si.bis,'intern-Override geht dem Produkt-Schalter vor (befristet)',si);
    await pool.query("DELETE FROM intern_schalter WHERE name='chat_get_eigene'");
    await pool.query("DELETE FROM agent_profil_schalter WHERE funktion='chat_get_eigene'");
    check((await CA.leseChatGetEigeneSchalter()).quelle==='standard','Zeilen weg -> Standard');
  });
}catch(e){failures.push('setup: '+mask(e.message));console.error(mask(e.stack));}
finally{
  try{await pool?.end?.();}catch{}
  try{await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}catch{}
  await admin.end();
}
console.log(`\n${checks-failures.length}/${checks} Checks ok`+(failures.length?`, ${failures.length} Fehler`:''));
process.exit(failures.length?1:0);
