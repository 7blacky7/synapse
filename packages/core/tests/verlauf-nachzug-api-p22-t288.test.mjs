/**
 * P22-T288 W6 (Analyse efbe02f1): admin verlauf_nachzug_api - einmaliger, idempotenter Nachzug api_agent_verlauf -> hauptagent_verlauf
 * ueber die eine Schreibstelle importiereSitzungsEintraege (herkunft api).
 *  - ohne Akteur recht_fehlt; Vorschau (Standard) zaehlt je Sitzung, schreibt nichts
 *  - nachzug_ausfuehren bei api_verlauf_hauptverlauf AUS -> funktion_aus; EIN -> schreibt; zweiter Lauf 0 (idempotent)
 *  - Live-Grenze: Sitzung mit Live-Zeile 'api:<sitzung>:3:0' -> nur nr < 3 nachgezogen, Live-Zeile unberuehrt
 *  - User-Text als eingabe, zeit = erstellt_am, Tokens des Zugs an der letzten Antwort (anbieter_gemessen)
 * Nur synapse_test:5433, eigenes privates Schema, kein Netz.
 *   node packages/core/tests/verlauf-nachzug-api-p22-t288.test.mjs
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
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
globalThis.fetch=async()=>{throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t288n_'+process.pid+'_'+randomUUID().slice(0,8);
const failures=[];let checks=0,pool;
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label,detail){checks++;if(!ok){failures.push(label);console.error('FAIL '+label+(detail===undefined?'':' '+mask(JSON.stringify(detail))));}}
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
 const C=await load('packages/core/dist/index.js');pool=C.getPool();
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','hauptagent-verlauf-schema','agent-startkontext-schema','api-agent-lauf-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);await pool.query(sql);
 }
 await pool.query("CREATE SEQUENCE IF NOT EXISTS agent_ausweis_nr");
 const USER={art:'user'},P='p288n-'+randomUUID().slice(0,6);
 await pool.query("INSERT INTO projects(name,path,hostname,enabled) VALUES($1,$2,'pc-host',true)",[P,'/home/test/'+P]);
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:true,grund:'Test P22-T288 alle'},{system:'user'});
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'api_verlauf_hauptverlauf',aktiv:false,grund:'Test T288 Ausgang AUS'},{system:'user'});
 const vb=await C.mitUserHerkunft('web-ui-chat',()=>C.fuehreW1bAdminAus('agent_vorbereiten',{project:P,agent_name:'deepseek-x',grund:'Test T288 W6'},{akteur:USER}));
 const A=vb.identity_id;
 check(!!A,'Identitaet deepseek-x vorbereitet',vb);
 const S1=randomUUID(),S2=randomUUID(),t0=Date.parse('2026-11-08T15:36:00Z');
 const zeit=s=>new Date(t0+s*1000).toISOString();
 const nachricht=(sitzung,nr,inhalt,s,art='nachricht')=>pool.query('INSERT INTO api_agent_verlauf(identity_id,sitzung,nr,art,inhalt,erstellt_am) VALUES($1,$2,$3,$4,$5::jsonb,$6)',[A,sitzung,nr,art,JSON.stringify(inhalt),zeit(s)]);
 await nachricht(S1,1,{rolle:'user',inhalt:[{typ:'text',text:'Auftrag P22-T286 S1'}]},0);
 await nachricht(S1,2,{rolle:'assistant',inhalt:[{typ:'text',text:'Ich lese den Auftrag.'},{id:'c1',typ:'werkzeug_aufruf',name:'mcp__synapse__thought',eingabe:{action:'get',id:'a1f2658f'}}]},1);
 await nachricht(S1,3,{id:'c1',name:'mcp__synapse__thought',zeit:zeit(1)},1,'aufruf');
 await nachricht(S1,4,{rolle:'user',inhalt:[{typ:'werkzeug_ergebnis',aufruf_id:'c1',fehler:false,inhalt:[{typ:'text',text:'Inhalt a1f2658f'}]}]},2);
 await nachricht(S1,5,{rolle:'assistant',inhalt:[{typ:'roh',block:{type:'reasoning',text:'x'},anbieter:'openai'},{typ:'text',text:'Fertig mit S1.'}]},3);
 await nachricht(S2,1,{rolle:'user',inhalt:[{typ:'text',text:'Zweite Sitzung'}]},10);
 await nachricht(S2,2,{rolle:'assistant',inhalt:[{typ:'text',text:'alt'}]},11);
 await nachricht(S2,3,{rolle:'assistant',inhalt:[{typ:'text',text:'live'}]},12);
 await pool.query("INSERT INTO hauptagent_verlauf(identity_id,rolle,richtung,weg,quelle_ref,status,text) VALUES($1,'ausgabe','aus','lauf',$2,'fertig','live')",[A,'api:'+S2+':3:0']);
 await pool.query('INSERT INTO api_agent_turns(identity_id,sitzung,modell,gestartet_am,beendet_am,input_tokens,output_tokens,kontext_tokens) VALUES($1,$2,$3,$4,$5,1000,50,1200)',
  [A,S1,'ds-flash',zeit(-1),zeit(4)]);
 const nachzug=(extra={})=>C.fuehreW1bAdminAus('verlauf_nachzug_api',{project:P,ziel_identity_id:A,...extra},{akteur:USER});
 const zeile=async ref=>(await pool.query('SELECT rolle, richtung, text, tokens, modell, erstellt_am FROM hauptagent_verlauf WHERE identity_id=$1 AND quelle_ref=$2',[A,ref])).rows[0]??null;

 await section('Rechte und Eingaben',async()=>{
  check((await C.fuehreApiVerlaufNachzugAdminAus('verlauf_nachzug_api',{ziel_identity_id:A},null)).error==='recht_fehlt','ohne Akteur recht_fehlt');
  check((await C.fuehreW1bAdminAus('verlauf_nachzug_api',{project:P},{akteur:USER})).error==='ziel_identity_id_fehlt','ohne ziel_identity_id');
  check((await C.fuehreW1bAdminAus('verlauf_nachzug_api',{project:P,ziel_identity_id:randomUUID()},{akteur:USER})).error==='identitaet_unbekannt','unbekannte Identitaet');
  check((await C.fuehreW1bAdminAus('verlauf_nachzug_api',{project:'anderes',ziel_identity_id:A},{akteur:USER})).error==='projekt_passt_nicht','fremdes Projekt');
  check(C.W1B_ADMIN_ACTIONS.includes('verlauf_nachzug_api'),'im admin-Katalog');
 });

 await section('Vorschau: Zahlen je Sitzung, Live-Grenze, nichts geschrieben',async()=>{
  const v=await nachzug();
  check(v.success===true&&v.modus==='vorschau','Vorschau ist Standard',v);
  check(v.summe?.nachrichten===6&&v.summe?.eintraege===7&&v.summe?.neu===7&&v.summe?.vorhanden===0,'Summe 6 Nachrichten / 7 Eintraege neu',v.summe);
  check(v.summe?.uebersprungen_live===1&&v.summe?.zuege_mit_tokens===1,'1 Live-Nachricht uebersprungen, 1 Zug mit Tokens',v.summe);
  const s2=v.sitzungen?.find(s=>s.sitzung===S2);
  check(s2?.live_ab_nr===3,'Live-Grenze S2 = 3',s2);
  check(v.schalter?.api_verlauf_hauptverlauf?.aktiv===false,'Schalterstand in der Antwort',v.schalter);
  const n=(await pool.query("SELECT count(*)::int n FROM hauptagent_verlauf WHERE identity_id=$1 AND quelle_ref LIKE 'api:nachzug:%'",[A])).rows[0].n;
  check(n===0,'Vorschau schreibt nichts',n);
 });

 await section('Ausfuehren: Schalter, Inhalt, Tokens, idempotent',async()=>{
  const aus=await nachzug({nachzug_ausfuehren:true});
  check(aus.success===false&&aus.error==='funktion_aus','Schalter AUS -> funktion_aus',aus);
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'api_verlauf_hauptverlauf',aktiv:true,grund:'Test T288 EIN'},{system:'user'});
  const r=await nachzug({nachzug_ausfuehren:true});
  check(r.success===true&&r.modus==='ausgefuehrt'&&r.aufgenommen===7&&r.grund===null,'7 Eintraege geschrieben',r);
  const ein=await zeile('api:nachzug:'+S1+':1:0');
  check(ein&&ein.rolle==='nachricht'&&ein.richtung==='ein'&&ein.text==='Auftrag P22-T286 S1','User-Text als eingabe',ein);
  check(ein&&new Date(ein.erstellt_am).toISOString()===zeit(0),'zeit = erstellt_am der API-Zeile',ein?.erstellt_am);
  const auf=await zeile('api:nachzug:'+S1+':2:1');
  check(auf&&auf.text.includes('a1f2658f')&&auf.modell==='ds-flash','Werkzeug-Aufruf mit Modell des Zugs',auf);
  const fertig=await zeile('api:nachzug:'+S1+':5:1');
  const g=fertig?.tokens?.gemessen;
  check(g&&g.input===1000&&g.output===50&&g.kontext===1200&&g.quelle==='anbieter_gemessen','Tokens des Zugs an der letzten Antwort',fertig?.tokens);
  check(!(await zeile('api:nachzug:'+S1+':2:0'))?.tokens?.gemessen,'nur die letzte Antwort traegt Tokens');
  check(!(await zeile('api:nachzug:'+S2+':3:0')),'Live-Nachricht nicht nachgezogen');
  check((await zeile('api:'+S2+':3:0'))?.text==='live','Live-Zeile unberuehrt');
  const nochmal=await nachzug({nachzug_ausfuehren:true});
  check(nochmal.success===true&&nochmal.aufgenommen===0,'zweiter Lauf schreibt nichts (idempotent)',nochmal);
  const v=await nachzug();
  check(v.summe?.vorhanden===7&&v.summe?.neu===0,'Vorschau danach: alles vorhanden',v.summe);
 });

 // Pruefung claude-linde: keine Doppelzeilen gegen live (Eingabe des ersten Live-Zugs) und gegen P22-T202-Sichtzeilen turn:<id>:*.
 await section('Pruefung: Eingabe des ersten Live-Zugs und T202-Sichtzeilen nicht doppelt',async()=>{
  const vb2=await C.mitUserHerkunft('web-ui-chat',()=>C.fuehreW1bAdminAus('agent_vorbereiten',{project:P,agent_name:'deepseek-y',grund:'Test T288 W6 Pruefung'},{akteur:USER}));
  const B=vb2.identity_id,S3=randomUUID(),S4=randomUUID();
  const msg=(sitzung,nr,inhalt,s)=>pool.query("INSERT INTO api_agent_verlauf(identity_id,sitzung,nr,art,inhalt,erstellt_am) VALUES($1,$2,$3,'nachricht',$4::jsonb,$5)",[B,sitzung,nr,JSON.stringify(inhalt),zeit(s)]);
  // S3: Zug 1 vor dem Schalter (nr 1-2), Zug 2 live (Eingabe nr 3 live als eingang:<id>, Antwort nr 4 live).
  await msg(S3,1,{rolle:'user',inhalt:[{typ:'text',text:'vor dem Schalter'}]},20);
  await msg(S3,2,{rolle:'assistant',inhalt:[{typ:'text',text:'alte Antwort'}]},21);
  await msg(S3,3,{rolle:'user',inhalt:[{typ:'text',text:'erster Live-Auftrag'}]},22);
  await msg(S3,4,{rolle:'assistant',inhalt:[{typ:'text',text:'Live-Antwort'}]},23);
  await pool.query("INSERT INTO hauptagent_verlauf(identity_id,rolle,richtung,weg,quelle_ref,status,text) VALUES($1,'nachricht','ein','lauf','api:eingang:77','fertig','erster Live-Auftrag'),($1,'ausgabe','aus','lauf',$2,'fertig','Live-Antwort')",[B,'api:'+S3+':4:0']);
  // S4: Zug mit P22-T202-Sichtzeilen (Schalter AUS, Laufwahl aktiv): Eingabe + Gesamttext stehen schon als turn:<id>:*.
  const tz=(await pool.query("INSERT INTO api_agent_turns(identity_id,sitzung,modell,gestartet_am,beendet_am,input_tokens,output_tokens,kontext_tokens) VALUES($1,$2,'ds-flash',$3,$4,500,20,600) RETURNING id::text AS id",[B,S4,zeit(29),zeit(40)])).rows[0].id;
  await msg(S4,1,{rolle:'user',inhalt:[{typ:'text',text:'sichtbarer Auftrag'}]},30);
  await msg(S4,2,{rolle:'assistant',inhalt:[{typ:'text',text:'Zwischentext'},{id:'w9',typ:'werkzeug_aufruf',name:'mcp__synapse__plan',eingabe:{action:'get'}}]},31);
  await msg(S4,3,{rolle:'user',inhalt:[{typ:'werkzeug_ergebnis',aufruf_id:'w9',fehler:false,inhalt:[{typ:'text',text:'Plan'}]}]},32);
  await msg(S4,4,{rolle:'assistant',inhalt:[{typ:'text',text:'Ende'}]},33);
  await pool.query("INSERT INTO hauptagent_verlauf(identity_id,rolle,richtung,weg,quelle_ref,status,text) VALUES($1,'nachricht','ein','lauf',$2,'fertig','sichtbarer Auftrag'),($1,'ausgabe','aus','lauf',$3,'fertig','Zwischentext Ende')",[B,'api:turn:'+tz+':eingabe','api:turn:'+tz+':antwort']);
  // S5: Main-Chat-Zug (Eingang main_chat) - steht als Web-UI-Antwortzeile schon im Verlauf.
  const S5=randomUUID();
  const tz5=(await pool.query("INSERT INTO api_agent_turns(identity_id,sitzung,modell,gestartet_am,beendet_am,input_tokens,output_tokens) VALUES($1,$2,'ds-flash',$3,$4,300,10) RETURNING id::text AS id",[B,S5,zeit(49),zeit(60)])).rows[0].id;
  await pool.query("INSERT INTO api_agent_eingang(identity_id,text,quelle,turn_id) VALUES($1,'Hallo Main','main_chat',$2)",[B,tz5]);
  await msg(S5,1,{rolle:'user',inhalt:[{typ:'text',text:'Hallo Main'}]},50);
  await msg(S5,2,{rolle:'assistant',inhalt:[{typ:'text',text:'Hallo zurueck'},{id:'w5',typ:'werkzeug_aufruf',name:'mcp__synapse__plan',eingabe:{action:'list'}}]},51);
  const v=await C.fuehreW1bAdminAus('verlauf_nachzug_api',{project:P,ziel_identity_id:B},{akteur:USER});
  const s3=v.sitzungen?.find(s=>s.sitzung===S3),s4=v.sitzungen?.find(s=>s.sitzung===S4),s5=v.sitzungen?.find(s=>s.sitzung===S5);
  check(s5?.neu===0&&s5.uebersprungen_sichtbar===3&&s5.zuege_mit_tokens===0,'S5: Main-Chat-Zug ganz ausgelassen (steht als Web-UI-Zeile im Verlauf)',s5);
  check(s3?.live_ab_nr===4&&s3.uebersprungen_live===2&&s3.neu===2,'S3: Live-Antwort UND Eingabe des ersten Live-Zugs uebersprungen, nur Zug 1 (2 Eintraege)',s3);
  check(s4?.uebersprungen_sichtbar===3&&s4.neu===2&&s4.zuege_mit_tokens===0,'S4: Eingabe und 2 Texte (T202) uebersprungen, Werkzeug-Aufruf/-Ergebnis nachgezogen, keine zweiten Tokens',s4);
  check(v.summe?.uebersprungen_sichtbar===6,'Summe nennt uebersprungen_sichtbar (T202 3 + Main-Chat 3)',v.summe);
  const r=await C.fuehreW1bAdminAus('verlauf_nachzug_api',{project:P,ziel_identity_id:B,nachzug_ausfuehren:true},{akteur:USER});
  check(r.success===true&&r.aufgenommen===4,'4 Eintraege geschrieben',r);
  const refs=(await pool.query("SELECT quelle_ref FROM hauptagent_verlauf WHERE identity_id=$1 AND quelle_ref LIKE 'api:nachzug:%' ORDER BY quelle_ref",[B])).rows.map(x=>x.quelle_ref);
  check(!refs.includes('api:nachzug:'+S3+':3:0'),'Eingabe des ersten Live-Zugs nicht doppelt',refs);
  check(!refs.some(x=>x.startsWith('api:nachzug:'+S4+':1:')||x==='api:nachzug:'+S4+':2:0'||x.startsWith('api:nachzug:'+S4+':4:')),'T202-Eingabe/-Texte nicht doppelt',refs);
  check(refs.includes('api:nachzug:'+S4+':2:1')&&refs.includes('api:nachzug:'+S4+':3:0'),'Werkzeugzeilen des T202-Zugs nachgezogen',refs);
  const dopp=(await pool.query("SELECT text, count(*)::int n FROM hauptagent_verlauf WHERE identity_id=$1 GROUP BY text HAVING count(*)>1",[B])).rows;
  check(dopp.length===0,'kein Text doppelt im Verlauf',dopp);
 });
}catch(e){failures.push('Lauf: '+mask(e.message));console.error(mask(e.stack));}
finally{
 try{await pool?.end();}catch(e){console.error('[t288n] Pool schliessen:',e.message);}
 try{await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}catch(e){console.error('[t288n] Schema entfernen:',e.message);}
 await admin.end();
}
console.log(failures.length?'FEHLER '+failures.length+'/'+checks:'OK '+checks+'/'+checks);
process.exit(failures.length?1:0);
