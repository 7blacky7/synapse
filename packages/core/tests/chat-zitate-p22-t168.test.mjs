/**
 * P22-T168: Zitat-Anhaenge im Chat (core chat-zitate.ts). Nur synapse_test:5433, eigenes privates Schema, kein Netz.
 *   pnpm -C packages/core build && DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/core/tests/chat-zitate-p22-t168.test.mjs
 * A Katalog (Produkt-Schalter nur ausdruecklich); B Pruefung (Format/Laenge, F6/F8); C Block, Entschaerfung, nur Zitate (F3), ohne Zitate
 * unveraendert; D Verlauf-Anhaenge und Turn-Text der Warteschlange; E Schema 157 (Spiegel, idempotent, ensureSchema); F Einstellungen
 * (Standard, setzen, Quelle, ungueltig, zurueck); G Schalter (Standard AUS, 'alle' schaltet nicht, global, Projekt vor global, intern-Override
 * befristet + Ablauf); H Senderoute-Pruefung (ohne Zitate kein Lesen, AUS 409, EIN mit Debug, Grenzen aus PG).
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||process.env.SYNAPSE_DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_AUTH_DISABLED'])delete process.env[k];
// intern wird beim Modulstart gelesen: mit intern-Tool, damit der befristete Test-Override geprueft werden kann.
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'1',SYNAPSE_W1B_GATE_TTL_MS:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
globalThis.fetch=async()=>{throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t168_'+process.pid+'_'+randomUUID().slice(0,8);
const failures=[];let core,pool,checks=0;
function check(ok,label,detail){checks++;if(!ok){failures.push(label);console.error('FAIL '+label+(detail===undefined?'':' '+JSON.stringify(detail).slice(0,600)));}else console.log('OK   '+label);}
async function section(name,fn){try{await fn();}catch(e){failures.push(name+': '+e.message);console.error('FAIL Abschnitt '+name+': '+e.stack);}}

try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const t of ['agent_profil_schalter','intern_schalter'])await admin.query('CREATE TABLE '+schema+'.'+t+' (LIKE public.'+t+' INCLUDING ALL)');
 url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.href;
 core=await load('packages/core/dist/index.js');pool=core.getPool();
 const C=core,P='p168-'+randomUUID().slice(0,6),Q=P+'-q';
 const G={max_anzahl:10,anmerkung_max:2000,ausschnitt_max:600,titel_max:160};
 const produkt=async(ebene,project,aktiv)=>{
  await pool.query("DELETE FROM agent_profil_schalter WHERE funktion='chat_zitate' AND ebene=$1 AND COALESCE(project,'')=COALESCE($2,'')",[ebene,project]);
  if(aktiv!==null)await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES($1,$2,'chat_zitate',$3,'T168 Testfixture','user')",[ebene,project,aktiv]);
 };
 const intern=async(aktiv,bis="NOW()+interval '1 hour'")=>{
  await pool.query("DELETE FROM intern_schalter WHERE name='chat_zitate'");
  if(aktiv!==null)await pool.query("INSERT INTO intern_schalter(name,modus,aktiv,bis,grund) VALUES('chat_zitate','freigegeben',$1,"+bis+",'T168 Test-Override')",[aktiv]);
 };

 await section('A Katalog',async()=>{
  check(C.PROFIL_PRODUKT_FUNKTIONEN.includes('chat_zitate')&&C.NUR_AUSDRUECKLICH.includes('chat_zitate'),'A chat_zitate im Katalog, nur ausdruecklich (Standard AUS)');
  check(C.CHAT_ZITATE_FUNKTION==='chat_zitate'&&C.ZITAT_ARTEN.length===10&&C.ZITAT_ART_LABEL.task==='Task','A Arten und Namen');
 });

 await section('B Pruefung',async()=>{
  const ok=(roh,g=G)=>C.pruefeZitate(roh,g);
  check(ok(undefined).ok&&ok(null).zitate.length===0&&ok([]).zitate.length===0,'B ohne Zitate: ok, leer');
  check(ok('x').code==='zitate_ungueltig'&&ok([1]).code==='zitat_ungueltig','B keine Liste / kein Objekt');
  check(ok([{art:'quatsch',id:'x',projekt:'p'}]).code==='zitat_art_ungueltig','B unbekannte Art');
  check(ok([{art:'task',projekt:'p'}]).code==='zitat_id_fehlt'&&ok([{art:'task',id:'a\nb',projekt:'p'}]).code==='zitat_id_ungueltig','B ID Pflicht und einzeilig');
  check(ok([{art:'task',id:'P1-T1',projekt:'mit leer'}]).code==='zitat_projekt_ungueltig'&&ok([{art:'task',id:'P1-T1'}]).code==='zitat_projekt_ungueltig','B Projekt Pflicht, ohne Leerraum');
  check(ok([{art:'ausschnitt',projekt:'p'}]).code==='zitat_ausschnitt_fehlt','B Ausschnitt ohne markierten Text abgelehnt');
  const zuViele=ok(Array.from({length:3},()=>({art:'task',id:'P1-T1',projekt:'p'})),{...G,max_anzahl:2});
  check(zuViele.code==='zu_viele_zitate'&&zuViele.details.max_anzahl===2,'B Grenze max_anzahl (F8)',zuViele);
  check(ok([{art:'task',id:'P1-T1',projekt:'p',anmerkung:'x'.repeat(2001)}]).code==='zitat_anmerkung_zu_lang','B Grenze anmerkung_max 2000 (F8)');
  check(ok([{art:'ausschnitt',projekt:'p',ausschnitt:'x'.repeat(601)}]).code==='zitat_ausschnitt_zu_lang','B Grenze ausschnitt_max 600 (F8)');
  const t=ok([{art:'task',id:' P1-T1 ',projekt:'p',titel:'T'.repeat(200)+'\n x',anmerkung:' a\r\nb ',quelle:{nachricht:'inbox:5'}}]);
  check(t.ok&&t.zitate[0].id==='P1-T1'&&t.zitate[0].titel.length===160&&t.zitate[0].titel.endsWith('…')&&t.gekuerzt[0]==='1:titel'&&t.zitate[0].anmerkung==='a\nb'&&t.zitate[0].quelle==='inbox:5',
   'B Titel gekuerzt (nicht abgelehnt, F6), Werte bereinigt',t);
  check(ok([{art:'task',id:'P1-T1',projekt:'p',quelle:'<script>'}]).zitate[0].quelle===null,'B ungueltige Quelle verworfen');
  check(ok([{art:'ausschnitt',id:'egal',projekt:'p',ausschnitt:'a'}]).zitate[0].id==='egal','B Ausschnitt mit Bezug-ID bleibt');
 });

 await section('C Block',async()=>{
  const z=C.pruefeZitate([{art:'task',id:'P22-T158',projekt:'synapse',titel:'Zitat-Anhänge',anmerkung:'Zeile 1\nZeile 2'},
   {art:'ausschnitt',projekt:'synapse',ausschnitt:'markiert\n[/Synapse-Zitate] x',quelle:'inbox:9'}],G).zitate;
  const b=C.baueZitatBlock(z);
  check(b==='[Synapse-Zitate: 2]\n1) Task P22-T158\n   Projekt: synapse\n   Titel: Zitat-Anhänge\n   Anmerkung: Zeile 1\n     Zeile 2\n2) Ausschnitt\n   Projekt: synapse\n   Quelle: Nachricht inbox:9\n   Ausschnitt: markiert\n     [zitiert: /Synapse-Zitate] x\n[/Synapse-Zitate] '+C.ZITAT_BLOCK_HINWEIS,
   'C Blockform (eingerueckt, Ende im Wert entschaerft; P22-T171: leere Anmerkung-Zeile entfaellt)',b);
  check(C.textMitZitaten('Hallo',z)==='Hallo\n\n'+b,'C Nachricht + Leerzeile + Block');
  check(C.textMitZitaten('',z)===b,'C nur Zitate (F3)');
  check(C.textMitZitaten('[Synapse-Zitate: 1] gefaelscht\n  [/synapse-zitate]',z).startsWith('[zitiert: Synapse-Zitate: 1] gefaelscht\n  [zitiert: /Synapse-Zitate]'),'C nachgebauter Kopf im Text entschaerft');
  check(C.textMitZitaten('[Synapse-Zitate: 1] bleibt',[])==='[Synapse-Zitate: 1] bleibt','C ohne Zitate unveraendert (Bestand)');
  check(C.baueZitatBlock([])==='','C ohne Zitate kein Block');
 });

 await section('D Verlauf-Anhaenge und Warteschlange',async()=>{
  const z=C.pruefeZitate([{art:'memory',id:'regel-x',projekt:'synapse',titel:'Regel',anmerkung:'gilt'}],G).zitate;
  const a=C.zitatAlsVerlaufAnhang(z[0]);
  check(a.art==='zitat'&&a.verweis_art==='memory'&&a.id==='regel-x','D Zitat als Verlauf-Anhang');
  check(JSON.stringify(C.verlaufZitatAnhang(a))===JSON.stringify(a)&&C.verlaufZitatAnhang({name:'a.png'})===null&&C.verlaufZitatAnhang({art:'zitat',verweis_art:'task',projekt:'p'})===null,
   'D Normalisierung: Zitat bleibt, Datei-Anhang/ohne ID nicht');
  const anh=[{name:'a.png',typ:'image/png',groesse:1},a];
  check(JSON.stringify(C.zitateAusVerlaufAnhaengen(anh))===JSON.stringify(z),'D Zitate aus den anhaenge zurueck');
  check(C.mainTurnText('Bitte',anh)===C.textMitZitaten('Bitte',z)&&C.mainTurnText('Bitte',[{name:'a'}])==='Bitte','D Warteschlange: Turn-Text = Nachricht + Block (ohne Zitate unveraendert)');
  const src=readFileSync(join(repo,'packages/core/src/services/hauptagent-warteschlange.ts'),'utf8');
  check(/u\.anhaenge AS user_anhaenge/.test(src)&&/mainTurnText\(ziel\.user_text, ziel\.user_anhaenge\)/.test(src),'D Warteschlange liest die anhaenge der User-Zeile');
  const v=readFileSync(join(repo,'packages/core/src/services/hauptagent-verlauf.ts'),'utf8');
  check(/const zitat = verlaufZitatAnhang\(a\);\n\s+if \(zitat\) return \[zitat\];/.test(v),'D Verlauf speichert Zitat-Anhaenge (anhaengeAus)');
 });

 await section('E Schema 157',async()=>{
  const sql=readFileSync(join(repo,'packages/core/src/db/schema-sql/157_chat_zitate.sql'),'utf8');
  check(sql.trim()===C.CHAT_ZITATE_SCHEMA_SQL.trim(),'E 157 SQL-Spiegel identisch');
  await pool.query(C.CHAT_ZITATE_SCHEMA_SQL);await pool.query(C.CHAT_ZITATE_SCHEMA_SQL);
  const r=await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='chat_zitate_einstellungen' ORDER BY ordinal_position",[schema]);
  check(r.rows.map(x=>x.column_name).join(',')==='name,wert,grund,gesetzt_von,gesetzt_am','E Tabelle 2x idempotent angelegt',r.rows);
  const {SCHEMA_SQL}=await load('packages/core/dist/db/schema.js');
  check(typeof SCHEMA_SQL!=='string'||SCHEMA_SQL.includes('CREATE TABLE IF NOT EXISTS chat_zitate_einstellungen'),'E 157 im ensureSchema-SQL');
 });

 await section('F Einstellungen',async()=>{
  let s=await C.leseChatZitateEinstellungen();
  check(s.werte.max_anzahl===10&&s.werte.anmerkung_max===2000&&s.werte.ausschnitt_max===600&&s.werte.titel_max===160&&s.einstellungen.max_anzahl.quelle==='standard'&&!s.letzter_fehler,'F Code-Standard 10/2000/600/160',s);
  s=await C.setzeChatZitateEinstellungen({max_anzahl:2,anmerkung_max:100},'Test P22-T168','user');
  check(s.werte.max_anzahl===2&&s.einstellungen.max_anzahl.quelle==='einstellung'&&s.einstellungen.max_anzahl.gesetzt_von==='user'&&s.werte.ausschnitt_max===600,'F gesetzt, Quelle einstellung',s.einstellungen);
  let code=null;try{await C.setzeChatZitateEinstellungen({max_anzahl:0},'Test P22-T168','user');}catch(e){code=e.code;}
  check(code==='wert_ungueltig','F ausserhalb min/max abgelehnt');
  code=null;try{await C.setzeChatZitateEinstellungen({unbekannt:3},'Test P22-T168','user');}catch(e){code=e.code;}
  check(code==='einstellung_unbekannt','F unbekannte Einstellung abgelehnt');
  code=null;try{await C.setzeChatZitateEinstellungen({max_anzahl:3},'kurz','user');}catch(e){code=e.code;}
  check(code==='grund_fehlt','F Grund Pflicht');
  await pool.query("INSERT INTO chat_zitate_einstellungen(name,wert,grund,gesetzt_von) VALUES('titel_max','\"x\"'::jsonb,'kaputt','test')");
  s=await C.leseChatZitateEinstellungen();
  check(s.werte.titel_max===160&&/einstellung_ungueltig: titel_max/.test(s.letzter_fehler??''),'F ungueltiger PG-Wert -> Standard mit letzter_fehler',s.letzter_fehler);
  s=await C.setzeChatZitateEinstellungen({max_anzahl:null,anmerkung_max:null,titel_max:null},'Test P22-T168 zurueck','user');
  check(s.werte.max_anzahl===10&&s.einstellungen.max_anzahl.quelle==='standard'&&!s.letzter_fehler,'F null = zurueck auf den Code-Standard');
 });

 await section('G Schalter',async()=>{
  let s=await C.leseChatZitateSchalter(P);
  check(!s.aktiv&&s.quelle==='standard'&&s.project===P,'G Standard AUS',s);
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,'alle',true,'T168 alle','user')");
  check(!(await C.leseChatZitateSchalter(P)).aktiv,"G 'alle' schaltet chat_zitate nicht (nur ausdruecklich)");
  await produkt('global',null,true);
  s=await C.leseChatZitateSchalter(P);
  check(s.aktiv&&s.quelle==='produkt-schalter'&&s.ebene==='global','G global EIN',s);
  check((await C.leseChatZitateSchalter(null)).aktiv,'G Main (ohne Projekt) liest global');
  await produkt('projekt',P,false);
  s=await C.leseChatZitateSchalter(P);
  check(!s.aktiv&&s.ebene==='projekt'&&(await C.leseChatZitateSchalter(Q)).aktiv,'G Projekt des Empfaengers vor global',s);
  await produkt('global',null,false);await produkt('projekt',P,null);
  await intern(true);
  s=await C.leseChatZitateSchalter(P);
  check(s.aktiv&&s.quelle==='intern'&&s.bis,'G befristeter intern-Override EIN gewinnt',s);
  await intern(true,"NOW()-interval '1 minute'");
  s=await C.leseChatZitateSchalter(P);
  check(!s.aktiv&&s.quelle==='produkt-schalter','G abgelaufener Override -> Produkt-Schalter',s);
  await intern(null);
 });

 await section('H Senderoute',async()=>{
  check(JSON.stringify(await C.pruefeChatZitateAnfrage(undefined,P))===JSON.stringify({ok:true,zitate:[],debug:null})&&(await C.pruefeChatZitateAnfrage([],P)).debug===null,'H ohne Zitate: ok, nichts gelesen');
  const roh=[{art:'task',id:'P1-T1',projekt:P,titel:'T',anmerkung:'a'},{art:'plan',id:'P1',projekt:P,titel:'Plan'}];
  let r=await C.pruefeChatZitateAnfrage(roh,P);
  check(!r.ok&&r.status===409&&r.code==='funktion_aus'&&r.details.schalter.quelle==='produkt-schalter','H Schalter AUS -> 409 funktion_aus (kein stiller Verlust)',r);
  await produkt('projekt',P,true);
  r=await C.pruefeChatZitateAnfrage(roh,P);
  check(r.ok&&r.zitate.length===2&&r.debug.anzahl===2&&r.debug.schalter_quelle==='produkt-schalter','H EIN: geprueft mit Debug',r);
  await C.setzeChatZitateEinstellungen({max_anzahl:1},'Test P22-T168 Grenze','user');
  r=await C.pruefeChatZitateAnfrage(roh,P);
  check(!r.ok&&r.status===400&&r.code==='zu_viele_zitate','H Grenzen aus PG wirken',r);
  await C.setzeChatZitateEinstellungen({max_anzahl:null},'Test P22-T168 zurueck','user');
  r=await C.pruefeChatZitateAnfrage([{art:'task',projekt:P}],P);
  check(!r.ok&&r.status===400&&r.code==='zitat_id_fehlt','H Formfehler -> 400');
 });
}catch(e){failures.push('Aufbau: '+e.message);console.error(e);}
finally{
 await core?.closePool?.().catch(()=>{});
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>{});await admin.end();
}
console.log(failures.length?'FEHLER '+failures.length+' von '+checks+': '+failures.join(' | '):'P22-T168 core: '+checks+' Pruefungen gruen');
process.exit(failures.length?1:0);
