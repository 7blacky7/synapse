/**
 * P22-T24 (W12-A): Agenten-Ausweis offen speichern, Weg A und Weg B, Erstnutzung, Verfall, Respawn mit gleichem Ausweis,
 * Abruf/Loeschen (User, Koordinator, Legacy-Koordinator; Subagent nie), Daemon-Start, admin-Dispatcher, REST-Routen, MCP-Transport.
 * Nur synapse_test:5433, eigenes privates Schema/Sequenzen, keine Modelle/Netz/Daemon.
 *   node packages/core/tests/w1b-ausweis-p22-t24.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const root=process.env.P22_T24_ROOT||repo;
const load=(...p)=>import(pathToFileURL(join(root,...p)).href);
const require=createRequire(join(root,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_W1B_DURCHSETZUNG',
 'SYNAPSE_W1B_ANTWORTANPASSUNG','SYNAPSE_AGENT_TOKEN_SCHLUESSEL','SYNAPSE_MAIN_SYNAPSE'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',
 SYNAPSE_INTERN_TOOL:'0',SYNAPSE_TOKEN_IDENTITAET:'1',SYNAPSE_W1B_ANMELDUNG:'1',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_AGENT_START_TOKEN_TTL_MIN:'10',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
let network=0;
globalThis.fetch=async()=>{network++;throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t24_a_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t24-a',Q='p22-t24-a-fremd';
const bearer=randomUUID()+randomUUID(),secrets=[bearer],close=[],failures=[];
let core,pool,seq=0,checks=0;
const unwrap=r=>r.structuredContent??JSON.parse(r.content.find(c=>c.type==='text').text);
const mask=s=>secrets.reduce((s,x)=>s.replaceAll(x,'[GEHEIM]'),String(s))
 .replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}}
async function section(name,fn){
 try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}
 catch(e){failures.push(name+': '+mask(e.message));console.error('FAIL Abschnitt '+name+': '+mask(e.stack));}
}
const fehler=async fn=>{try{await fn();return null;}catch(e){return e.code??('?'+mask(e.message));}};
const AUS=/^sai_[a-z0-9]{1,64}$/;

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
 // Schemas 111..114 zweimal (idempotent), 114 auch ohne vorherige Kopie der Spalten.
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);await pool.query(sql);
 }
 await pool.query("INSERT INTO auth_tokens(token_hash,kind,scope,expires_at) VALUES($1,'access','mcp:tools',NOW()+INTERVAL '1 hour')",[createHash('sha256').update(bearer).digest('hex')]);

 const C=core,USER={art:'user'},DAEMON={art:'daemon'},V=C.W12_DIENSTE.ausweis;
 const bz=await C.leseAgentBezugModus();
 check(bz.modus==='beide','Testbetrieb: agent_bezug_modus beide');
 const ident=async(id,project,name,rolle)=>pool.query('INSERT INTO agent_identitaeten(id,project,name,instanz_nr,agent_id,rolle,erstellt_von) VALUES($1,$2,$3,1,$3,$4,$5)',[id,project,name,rolle,'test']);
 const akt=(id,project,rolle)=>({art:'identitaet',principal:{art:'identity',project,agent_id:id,identity_id:id,rolle,modell:null,context_epoch:1,lauf_id:null}});
 const zeilen=async(identityId)=>(await pool.query('SELECT * FROM agent_identitaet_tokens WHERE identity_id=$1 AND widerrufen_am IS NULL AND token_offen IS NOT NULL',[identityId])).rows;
 const merke=t=>{if(t&&!secrets.includes(t))secrets.push(t);return t;};
 const legacy=(agent_id)=>({art:'legacy_koordinator',agent_id});

 await ident('t24-k',P,'t24-koord','koordinator');await ident('t24-s',P,'t24-sub','subagent');await ident('t24-kq',Q,'t24-koord-q','koordinator');
 const Kk=akt('t24-k',P,'koordinator'),Ss=akt('t24-s',P,'subagent'),Kq=akt('t24-kq',Q,'koordinator');

 await section('Kern AUS: nichts passiert',async()=>{
  check(await fehler(()=>V.agentVorbereiten({project:P,name:'k-aus',grund:'Test Kern aus'},USER))==='ausweis_kern_aus','Kern AUS -> ausweis_kern_aus');
  check(await fehler(()=>V.rufeAusweisAb(P,'t24-s',USER,'Test'))==='ausweis_kern_aus','Abruf bei Kern AUS abgelehnt');
  check((await pool.query("SELECT count(*)::int n FROM agent_identitaeten WHERE agent_id='k-aus'")).rows[0].n===0,'bei Kern AUS wurde nichts angelegt');
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:true,grund:'test p22 T24'},{system:'user'});
  const k=await C.leseAusweisKern(P);
  check(k.aktiv===true&&k.agent_bezug_modus==='beide','Kern EIN (Altschalter-Rumpf + Modus beide)');
 });

 let a;
 await section('Weg B: vorbereiten, Erstnutzung = Bestaetigung (V2)',async()=>{
  a=await V.agentVorbereiten({project:P,name:'t24-w-sub',grund:'Test Weg B',profil:{regeln:['regel-x'],briefing:'Briefing T24'}},USER);merke(a.token);
  check(AUS.test(a.token)&&a.zustand==='ausgestellt'&&a.neu_angelegt===true&&a.legacy_uebernahme===false&&a.ausweis_weg==='vorbereitet','Ausgabe ausgestellt/vorbereitet');
  const rest=new Date(a.erstnutzung_bis).getTime()-Date.now();
  check(rest>9*60_000&&rest<=10*60_000+5000,'Erstnutzungsfrist ~10 Minuten');
  check(a.startkonfiguration.startsatz.includes(a.token)&&!a.startkonfiguration.startsatz_vorlage.includes(a.token)&&a.startkonfiguration.startsatz_vorlage.includes('{TOKEN}'),'Startsatz mit Ausweis, Vorlage nur Platzhalter');
  check(a.startkonfiguration.erste_aktion.tool==='chat'&&a.startkonfiguration.erste_aktion.argumente.action==='anmelden'&&a.startkonfiguration.erste_aktion.argumente.token===a.token,'erste Aktion chat(anmelden, token)');
  const z=(await zeilen(a.identity_id));
  check(z.length===1&&z[0].token_offen===a.token&&z[0].token_hash===null&&z[0].token_verschluesselt===null&&z[0].start_art===null&&z[0].ausweis_weg==='vorbereitet'&&z[0].zuletzt_benutzt===null,'offen gespeichert (kein Hash, kein Tresor, kein Start-Ausweis)');
  const i=(await pool.query('SELECT profil_revision,profil FROM agent_identitaeten WHERE id=$1',[a.identity_id])).rows[0];
  check(i.profil_revision===1&&a.profil_revision===1&&i.profil.regeln[0]==='regel-x'&&i.profil.briefing==='Briefing T24','Profil Revision 1 in derselben Transaktion');
  check((await pool.query('SELECT count(*)::int n FROM agent_profil_revisionen WHERE identity_id=$1 AND revision=1',[a.identity_id])).rows[0].n===1,'Profilrevision 1 geschrieben');
  // erste erfolgreiche Anmeldung = Bestaetigung, danach dauerhaft
  const p1=await C.meldeAgentMitTokenAn(a.token,P,bz);
  check(p1.agent_id==='t24-w-sub'&&p1.lauf_id,'Anmeldung mit Ausweis');
  const z2=(await zeilen(a.identity_id))[0];
  check(z2.gueltig_bis===null&&z2.zuletzt_benutzt!==null,'erste Anmeldung: gueltig_bis NULL, zuletzt_benutzt gesetzt');
  await C.pruefeAgentToken(a.token,P,bz);
  check((await pool.query("SELECT count(*)::int n FROM agent_identitaet_audit WHERE identity_id=$1 AND aktion='ausweis_bestaetigt'",[a.identity_id])).rows[0].n===1,'Bestaetigung genau einmal auditiert');
  const ab=await V.rufeAusweisAb(P,a.identity_id,USER,'Test Abruf');
  check(ab.token===a.token&&ab.zustand==='aktiv'&&ab.erstnutzung_bis===null&&ab.zuletzt_benutzt!==null&&ab.ausweis_weg==='vorbereitet','Abruf: aktiv, gleicher Wert');
  // jeder Toolaufruf (nicht nur anmelden) bestaetigt
  const b=await V.agentVorbereiten({project:P,name:'t24-w-pruef',grund:'Test Pruefung als Bestaetigung'},USER);merke(b.token);
  await C.pruefeAgentToken(b.token,P,bz);
  check((await zeilen(b.identity_id))[0].gueltig_bis===null,'auch ein Folgeaufruf (Pruefung) bestaetigt den Ausweis');
  check(await fehler(()=>C.pruefeAgentToken(b.token,Q,bz))==='agent_token_fremdes_projekt','Ausweis nur im eigenen Projekt');
  check(await fehler(()=>C.pruefeAgentToken('sai_'+'0'.repeat(64),P,bz))==='agent_token_ungueltig','unbekannter Ausweis ungueltig');
 });

 await section('Verfall nach Frist, danach neu (V2)',async()=>{
  const e=await V.agentVorbereiten({project:P,name:'t24-w-exp',grund:'Test Verfall'},USER);merke(e.token);
  await pool.query("UPDATE agent_identitaet_tokens SET gueltig_bis=NOW()-INTERVAL '1 minute' WHERE token_offen=$1",[e.token]);
  check(await fehler(()=>C.pruefeAgentToken(e.token,P,bz))==='agent_token_ungueltig','nach Frist ungenutzt -> agent_token_ungueltig');
  check(await fehler(()=>C.meldeAgentMitTokenAn(e.token,P,bz))==='agent_token_ungueltig','auch Anmeldung nach Frist abgelehnt');
  const ab=await V.rufeAusweisAb(P,e.identity_id,USER,'Test Verfall');
  check(ab.zustand==='verfallen'&&ab.token===e.token,'Abruf zeigt verfallen');
  const e2=await V.agentVorbereiten({project:P,identity_id:e.identity_id,grund:'Neu nach Verfall'},USER);merke(e2.token);
  check(e2.token!==e.token&&e2.zustand==='ausgestellt'&&e2.neu_angelegt===false&&e2.ausweis_weg==='neu_ausgestellt','nach Verfall neuer Ausweis mit Frist');
  const alt=(await pool.query("SELECT widerrufen_am,widerrufen_grund FROM agent_identitaet_tokens WHERE token_offen=$1",[e.token])).rows[0];
  check(alt.widerrufen_am!==null&&alt.widerrufen_grund==='erstnutzung_verfallen','verfallener Ausweis geloescht (erstnutzung_verfallen)');
  check((await zeilen(e.identity_id)).length===1,'je Identitaet genau EIN nicht geloeschter Ausweis');
  check(await fehler(()=>C.pruefeAgentToken(e.token,P,bz))==='agent_token_ungueltig','alter Ausweis bleibt ungueltig');
  await C.meldeAgentMitTokenAn(e2.token,P,bz);
 });

 await section('Respawn/Neustart/Daemon-Start: derselbe Ausweis, keine Rotation',async()=>{
  const r=await V.agentVorbereiten({project:P,identity_id:a.identity_id,grund:'Respawn'},USER);
  check(r.token===a.token&&r.zustand==='aktiv'&&r.neu_angelegt===false,'Respawn liefert denselben Ausweis');
  const s=await V.ausweisFuerStart(P,a.identity_id,DAEMON);
  check(s.token===a.token&&s.neu===false&&s.zustand==='aktiv','Daemon-Start: vorhandener aktiver Ausweis, keine Start-Rotation');
  const s2=await V.ausweisFuerStart(P,a.identity_id,DAEMON);
  check(s2.token===a.token&&(await zeilen(a.identity_id)).length===1,'wiederholter Start: weiterhin genau ein Ausweis');
  check((await pool.query("SELECT count(*)::int n FROM agent_identitaet_tokens WHERE identity_id=$1",[a.identity_id])).rows[0].n===1,'keine zweite Tokenzeile entstanden');
  // Modellwechsel: derselbe Ausweis, Anmeldung mit demselben Token
  const p=await C.meldeAgentMitTokenAn(a.token,P,bz);
  check(p.identitaet.id===a.identity_id,'Neustart: Anmeldung mit demselben Ausweis');
  // ungenutzt ausgestellt, Daemon-Start innerhalb der Frist -> derselbe
  const g=await V.agentVorbereiten({project:P,name:'t24-w-start',grund:'Test Start'},USER);merke(g.token);
  const sg=await V.ausweisFuerStart(P,g.identity_id,DAEMON);
  check(sg.token===g.token&&sg.neu===false&&sg.zustand==='ausgestellt','Start innerhalb der Frist: derselbe, noch ausgestellt');
  // Altzeile (nur Hash, kein token_offen) ist kein Ausweis mehr
  await ident('t24-alt',P,'t24-alt-hash','subagent');
  const altTok='sai_'+'1'.repeat(64);merke(altTok);
  await pool.query("INSERT INTO agent_identitaet_tokens(id,identity_id,token_hash,token_praefix) VALUES($1,'t24-alt',$2,'sai_1111')",[randomUUID(),createHash('sha256').update(altTok).digest('hex')]);
  check(await fehler(()=>C.pruefeAgentToken(altTok,P,bz))==='agent_token_ungueltig','Hash-Altzeile gilt nicht mehr');
  check(await fehler(()=>V.rufeAusweisAb(P,'t24-alt',USER,'Test Altzeile'))==='ausweis_fehlt','Abruf Altzeile: ausweis_fehlt');
  const sa=await V.ausweisFuerStart(P,'t24-alt',DAEMON);merke(sa.token);
  check(sa.neu===true&&sa.ausweis_weg==='daemon_start'&&sa.zustand==='ausgestellt'&&AUS.test(sa.token),'Daemon-Start ohne Ausweis: neu mit Erstnutzungsfrist');
  check(await fehler(()=>V.ausweisFuerStart(P,'gibt-es-nicht',DAEMON))==='identitaet_unbekannt','Daemon legt nie eine Identitaet an');
  check((await pool.query("SELECT count(*)::int n FROM agent_identitaeten WHERE id='gibt-es-nicht'")).rows[0].n===0,'keine Anlage durch ausweisFuerStart');
  check(await fehler(()=>V.ausweisFuerStart(Q,'t24-s',DAEMON))==='identitaet_unbekannt','fremdes Projekt: Identitaet unbekannt');
 });

 await section('Rechte: User, Koordinator, Legacy-Koordinator ja; Subagent, Daemon, fremdes Projekt nein',async()=>{
  const ziel=a.identity_id;
  check((await V.rufeAusweisAb(P,ziel,USER,'User-Abruf')).token===a.token,'User darf abrufen');
  check((await V.rufeAusweisAb(P,ziel,Kk,'Koordinator-Abruf')).token===a.token,'Koordinator darf abrufen');
  check((await V.rufeAusweisAb(P,ziel,legacy('koordinator-legacy'),'Legacy-Koordinator-Abruf')).token===a.token,'Legacy-Koordinator (ohne Ausweis) darf abrufen');
  check(await fehler(()=>V.rufeAusweisAb(P,ziel,Ss,'Subagent'))==='recht_fehlt','Subagent darf nicht abrufen');
  check(await fehler(()=>V.rufeAusweisAb(P,ziel,Kq,'fremder Koordinator'))==='recht_fehlt','Koordinator fremden Projekts darf nicht abrufen');
  check(await fehler(()=>V.rufeAusweisAb(P,ziel,DAEMON,'Daemon'))==='recht_fehlt','Daemon darf nicht abrufen');
  check(await fehler(()=>V.rufeAusweisAb(P,ziel,legacy('subagent-legacy'),'Legacy-Subagent'))==='recht_fehlt','Legacy-Subagent darf nicht abrufen');
  check(await fehler(()=>V.rufeAusweisAb(P,ziel,legacy('t24-koord'),'Name einer Token-Identitaet'))==='recht_fehlt','Legacy-Nachweis zaehlt nicht fuer den Namen einer Token-Identitaet (t24-koord ist ohnehin kein Koordinator-Muster)');
  await ident('t24-kn',P,'koordinator-eigen','koordinator');
  check(await fehler(()=>V.rufeAusweisAb(P,ziel,legacy('koordinator-eigen'),'Name gehoert Token-Identitaet'))==='recht_fehlt','Koordinatormuster-Name einer Token-Identitaet ist kein Legacy-Nachweis');
  check(await fehler(()=>V.rufeAusweisAb(P,ziel,USER,''))==='anlass_fehlt','Anlass Pflicht');
  check(await fehler(()=>V.rufeAusweisAb(P,'gibt-es-nicht',USER,'Test'))==='identitaet_unbekannt','unbekannte Identitaet');
  check(await fehler(()=>V.rufeAusweisAb(Q,ziel,Kq,'fremdes Ziel'))==='identitaet_unbekannt','Ziel gehoert nicht zum Projekt');
  const au=(await pool.query('SELECT wer,erfolg,fehler,anlass FROM agent_token_abruf_audit WHERE ziel_identity_id=$1 ORDER BY id',[ziel])).rows;
  check(au.some(x=>x.erfolg&&x.wer==='user')&&au.some(x=>x.erfolg&&x.wer==='t24-k')&&au.some(x=>x.erfolg&&x.wer==='legacy:koordinator-legacy'),'Abruf-Audit: User, Koordinator, Legacy-Koordinator');
  check(au.some(x=>!x.erfolg&&x.fehler==='recht_fehlt'),'verweigerter Abruf auditiert');
  // vorbereiten
  const v1=await V.agentVorbereiten({project:P,name:'t24-v-koord',grund:'Koordinator bereitet vor',rolle:'reviewer'},Kk);merke(v1.token);
  check(v1.rolle==='reviewer'&&v1.zustand==='ausgestellt','Koordinator bereitet vor (Rolle reviewer)');
  const v2=await V.agentVorbereiten({project:P,name:'t24-v-legacy',grund:'Legacy-Koordinator bereitet vor'},legacy('koordinator-legacy'));merke(v2.token);
  check(v2.zustand==='ausgestellt'&&v2.neu_angelegt===true,'Legacy-Koordinator bereitet vor');
  check((await pool.query("SELECT erstellt_von FROM agent_identitaeten WHERE id=$1",[v2.identity_id])).rows[0].erstellt_von==='legacy:koordinator-legacy','Herkunft im Audit: legacy:<agent_id>');
  check(await fehler(()=>V.agentVorbereiten({project:P,name:'t24-v-sub',grund:'Subagent versucht'},Ss))==='recht_fehlt','Subagent darf nicht vorbereiten');
  check(await fehler(()=>V.agentVorbereiten({project:P,name:'t24-v-daemon',grund:'Daemon versucht'},DAEMON))==='recht_fehlt','Daemon darf nicht vorbereiten');
  // P22-T34 (User-Grundsatz 'User und Koordinator jederzeit'): Koordinator-Rolle auch durch Koordinator und Legacy-Koordinator.
  const vkl=await V.agentVorbereiten({project:P,name:'t24-v-k1',rolle:'koordinator',grund:'Koordinator-Rolle (Legacy)'},legacy('koordinator-legacy'));merke(vkl.token);
  check(vkl.rolle==='koordinator','Legacy-Koordinator darf Koordinator-Rolle vorbereiten');
  const vkk=await V.agentVorbereiten({project:P,name:'t24-v-k2',rolle:'koordinator',grund:'Koordinator-Rolle'},Kk);merke(vkk.token);
  check(vkk.rolle==='koordinator','Koordinator darf Koordinator-Rolle vorbereiten');
  check(await fehler(()=>V.agentVorbereiten({project:P,name:'t24-v-k3',rolle:'koordinator',grund:'Subagent versucht Koordinator'},Ss))==='recht_fehlt','Subagent darf keine Koordinator-Rolle vorbereiten');
  const vk=await V.agentVorbereiten({project:P,name:'koordinator',grund:'User legt Koordinator an'},USER);merke(vk.token);
  check(vk.rolle==='koordinator'&&vk.agent_id.startsWith('koordinator'),'User darf Koordinator vorbereiten');
  // Eingabe
  check(await fehler(()=>V.agentVorbereiten({project:P,grund:'ohne Namen'},USER))==='name_ungueltig','weder Name noch Identitaet');
  check(await fehler(()=>V.agentVorbereiten({project:P,name:'a',identity_id:'b',grund:'beides'},USER))==='name_ungueltig','Name und Identitaet zugleich');
  check(await fehler(()=>V.agentVorbereiten({project:P,name:'x#2',grund:'Raute'},USER))==='name_ungueltig','Name mit # abgelehnt');
  check(await fehler(()=>V.agentVorbereiten({project:P,name:'user',grund:'Name user'},USER))==='name_ungueltig','Name user abgelehnt');
  check(await fehler(()=>V.agentVorbereiten({project:P,name:'t24-w-sub',grund:'Name vergeben'},USER))==='identitaet_existiert','vorhandener Name: identitaet_existiert');
  check(await fehler(()=>V.agentVorbereiten({project:P,name:'t24-v-x',grund:''},USER))==='grund_fehlt','Grund Pflicht');
  check(await fehler(()=>V.agentVorbereiten({project:P,identity_id:'gibt-es-nicht',grund:'Test unbekannt'},USER))==='identitaet_unbekannt','unbekannte Identitaet');
  check(await fehler(()=>V.agentVorbereiten({project:Q,identity_id:ziel,grund:'fremdes Projekt'},Kq))==='identitaet_unbekannt','Identitaet eines anderen Projekts');
 });

 await section('Loeschen (V4)',async()=>{
  const d=await V.agentVorbereiten({project:P,name:'t24-w-del',grund:'Test Loeschen'},USER);merke(d.token);
  await C.pruefeAgentToken(d.token,P,bz);
  check(await fehler(()=>V.loescheAusweis(P,d.identity_id,Ss,'Subagent loescht'))==='recht_fehlt','Subagent darf nicht loeschen');
  check(await fehler(()=>V.loescheAusweis(P,d.identity_id,USER,'  '))==='grund_fehlt','Grund Pflicht');
  const l=await V.loescheAusweis(P,d.identity_id,Kk,'Test: Ausweis widerrufen');
  check(l.geloescht===true&&l.identity_id===d.identity_id&&typeof l.token_id==='string','Koordinator loescht');
  check(await fehler(()=>C.pruefeAgentToken(d.token,P,bz))==='agent_token_ungueltig','geloeschter Ausweis ungueltig');
  const l2=await V.loescheAusweis(P,d.identity_id,USER,'zweites Loeschen');
  check(l2.geloescht===false&&l2.token_id===null,'zweites Loeschen idempotent');
  check(await fehler(()=>V.rufeAusweisAb(P,d.identity_id,USER,'Test'))==='ausweis_fehlt','Abruf nach Loeschen: ausweis_fehlt');
  check((await pool.query("SELECT status FROM agent_identitaeten WHERE id=$1",[d.identity_id])).rows[0].status==='aktiv','Identitaet bleibt bestehen');
  const au=(await pool.query("SELECT wer,grund FROM agent_identitaet_audit WHERE identity_id=$1 AND aktion='token_widerrufen'",[d.identity_id])).rows;
  check(au.length===1&&au[0].wer==='t24-k'&&au[0].grund==='Test: Ausweis widerrufen','Loeschen auditiert (Akteur, Grund)');
  const d2=await V.agentVorbereiten({project:P,identity_id:d.identity_id,grund:'Neu nach Loeschen'},USER);merke(d2.token);
  check(d2.token!==d.token&&d2.zustand==='ausgestellt','nach Loeschen neuer Ausweis mit Frist');
  const lg=await V.loescheAusweis(P,d.identity_id,legacy('koordinator-legacy'),'Legacy-Koordinator loescht');
  check(lg.geloescht===true,'Legacy-Koordinator darf loeschen');
 });

 await section('Weg A: Schatten ohne Token, Bestaetigung erzeugt aktiven Ausweis (V2)',async()=>{
  const sh=await C.W1B_DIENSTE.schatten.legeSchattenprofilAn({project:P,ursprung_agent_id:'t24-a-legacy',ursprung_art:'legacy_register',selbstangaben:{name:'t24-a-legacy',modell:'m1'}},DAEMON);
  const row=(await pool.query('SELECT vorgesehener_token_hash h,vorgesehener_token_verschluesselt c FROM agent_schattenprofile WHERE id=$1',[sh.id])).rows[0];
  check(row.h===null&&row.c===null,'Schatten traegt keinen Token');
  check((await pool.query("SELECT count(*)::int n FROM agent_identitaeten WHERE agent_id='t24-a-legacy'")).rows[0].n===0,'vor Bestaetigung keine Identitaet/Ausweis');
  const b=await C.W1B_DIENSTE.schatten.bestaetigeSchattenprofil({schattenprofil_id:sh.id,erwartete_revision:sh.revision,user_zustimmung:'Test-Zustimmung',grund:'Test Weg A'},USER);
  const z=await zeilen(b.identity_id);
  check(z.length===1&&AUS.test(z[0].token_offen)&&z[0].ausweis_weg==='schatten_bestaetigt'&&z[0].gueltig_bis===null&&z[0].token_hash===null&&z[0].token_verschluesselt===null,'Bestaetigung: offener, sofort aktiver Ausweis');
  merke(z[0].token_offen);
  const ab=await V.rufeAusweisAb(P,b.identity_id,Kk,'Test Weg A');
  check(ab.token===z[0].token_offen&&ab.zustand==='aktiv'&&ab.ausweis_weg==='schatten_bestaetigt','Abruf: aktiv, Weg A');
  const p=await C.pruefeAgentToken(z[0].token_offen,P,bz);
  check(p.agent_id==='t24-a-legacy','Ausweis aus Weg A identifiziert den Agenten');
  const b2=await C.W1B_DIENSTE.schatten.bestaetigeSchattenprofil({schattenprofil_id:sh.id,erwartete_revision:sh.revision,user_zustimmung:'Test-Zustimmung',grund:'Test Weg A'},USER);
  check(b2.identity_id===b.identity_id&&(await zeilen(b.identity_id)).length===1,'Doppelbestaetigung: kein zweiter Ausweis');
 });

 await section('Legacy-Uebernahme: laufende Legacy-Sitzung -> sofort aktiv',async()=>{
  await pool.query("INSERT INTO agent_sessions(id,project,status) VALUES('t24-lg-name',$1,'active') ON CONFLICT (id) DO NOTHING",[P]);
  const u=await V.agentVorbereiten({project:P,name:'t24-lg-name',grund:'Test Uebernahme'},USER);merke(u.token);
  check(u.legacy_uebernahme===true&&u.zustand==='aktiv'&&u.ausweis_weg==='uebernahme'&&u.erstnutzung_bis===null,'Uebernahme: sofort aktiv, keine Frist');
  const z=(await zeilen(u.identity_id))[0];
  check(z.gueltig_bis===null&&z.zuletzt_benutzt===null,'aktiv, aber noch nie benutzt (Zustellung per Hinweis moeglich)');
  check(u.startkonfiguration.erstnutzung_bis===null&&!u.startkonfiguration.startsatz.includes('verfaellt'),'Startsatz ohne Frist');
 });

 await section('admin-Dispatcher: Aktionen, Legacy-Koordinator, Parameter',async()=>{
  for(const x of ['agent_vorbereiten','token_abrufen','token_loeschen'])check(C.W1B_ADMIN_ACTIONS.includes(x),'Aktion '+x+' registriert');
  check(['agent_name','rolle','startart'].every(x=>x in C.W1B_ADMIN_PARAMETER),'neue Parameter agent_name/rolle/startart');
  const L={agent_id:'koordinator-legacy'};
  const r=await C.fuehreW1bAdminAus('agent_vorbereiten',{project:P,agent_name:'t24-adm-1',grund:'Test admin Legacy',...L},{akteur:null});
  check(r.success===true&&AUS.test(r.token)&&r.zustand==='ausgestellt'&&r.startkonfiguration&&typeof r.hinweis==='string','admin agent_vorbereiten als Legacy-Koordinator');
  merke(r.token);
  const ab=await C.fuehreW1bAdminAus('token_abrufen',{project:P,ziel_identity_id:r.identity_id,anlass:'admin Test',...L},{akteur:null});
  check(ab.success===true&&ab.token===r.token,'admin token_abrufen als Legacy-Koordinator');
  check((await C.fuehreW1bAdminAus('token_abrufen',{project:P,ziel_identity_id:r.identity_id,anlass:'admin Test',agent_id:'subagent-x'},{akteur:null})).error==='recht_fehlt','admin: Legacy-Subagent -> recht_fehlt');
  check((await C.fuehreW1bAdminAus('token_abrufen',{project:P,ziel_identity_id:r.identity_id,anlass:'admin Test'},{akteur:null})).error==='recht_fehlt','admin: ohne Akteur und agent_id -> recht_fehlt');
  check((await C.fuehreW1bAdminAus('token_abrufen',{project:P,ziel_identity_id:r.identity_id,anlass:'admin Test'},{akteur:Ss})).error==='recht_fehlt','admin: Subagent mit Ausweis -> recht_fehlt');
  check((await C.fuehreW1bAdminAus('token_abrufen',{project:P,ziel_identity_id:'t24-s',anlass:'admin Test'},{akteur:USER})).error==='ausweis_fehlt','admin: Identitaet ohne Ausweis -> ausweis_fehlt');
  check(C.w1bFehlerStatus('ausweis_fehlt')===404&&C.w1bFehlerStatus('ausweis_kern_aus')===409&&C.w1bFehlerStatus('recht_fehlt')===403,'HTTP-Status der neuen Codes');
  const lo=await C.fuehreW1bAdminAus('token_loeschen',{project:P,ziel_identity_id:r.identity_id,grund:'admin Test loeschen',...L},{akteur:null});
  check(lo.success===true&&lo.geloescht===true,'admin token_loeschen als Legacy-Koordinator');
  const uebersicht=await C.fuehreW1bAdminAus('profil_uebersicht',{project:P},{akteur:USER});
  const zust=Object.fromEntries(uebersicht.profile.map(x=>[x.agent_id,x.ausweis_zustand]));
  check(uebersicht.success===true&&zust['t24-w-sub']==='aktiv'&&zust['t24-v-legacy']==='ausgestellt'&&JSON.stringify(uebersicht).search(/sai_[a-z0-9]{1,64}/)<0,'Uebersicht: Ausweiszustand, nie ein Wert');
  check(uebersicht.profile.find(x=>x.agent_id==='t24-w-sub').token_abrufbar===true,'Uebersicht: token_abrufbar aus offener Ablage');
 });

 await section('REST-Routen (Web-UI-Sitzung) und MCP-Transport',async()=>{
  const fastify=(await load('packages/rest-api/node_modules/fastify/fastify.js')).default;
  const {registerAgentProfilRoutes}=await load('packages/rest-api/dist/routes/agent-profil.js');
  const app=fastify({logger:false});
  await registerAgentProfilRoutes(app,{validateToken:async t=>t==='sess'?{kind:'session',scope:null,token_hash:'x'}:null});await app.ready();close.push(()=>app.close());
  const H={authorization:'Bearer sess'},B='/api/projects/'+P+'/agent-profile';
  const v=await app.inject({method:'POST',url:B+'/vorbereiten',headers:H,payload:{agent_name:'t24-rest-1',grund:'Test REST'}});
  const vj=v.json();merke(vj.token);
  check(v.statusCode===200&&AUS.test(vj.token)&&vj.zustand==='ausgestellt'&&v.headers['cache-control']==='no-store','REST POST /vorbereiten');
  const g=await app.inject({method:'GET',url:B+'/profile/'+vj.identity_id+'/token?anlass=REST-Test',headers:H});
  check(g.statusCode===200&&g.json().token===vj.token,'REST GET .../token liest den Ausweis');
  const g0=await app.inject({method:'GET',url:B+'/profile/'+vj.identity_id+'/token',headers:H});
  check(g0.statusCode===400&&g0.json().error.code==='anlass_fehlt','REST GET ohne anlass: 400 anlass_fehlt');
  const nu=await app.inject({method:'GET',url:B+'/profile/'+vj.identity_id+'/token?anlass=x'});
  check(nu.statusCode===401,'REST ohne Bearer: 401');
  const d=await app.inject({method:'DELETE',url:B+'/profile/'+vj.identity_id+'/token?grund=REST-Test%20loeschen',headers:H});
  check(d.statusCode===200&&d.json().geloescht===true,'REST DELETE .../token loescht');
  const g2=await app.inject({method:'GET',url:B+'/profile/'+vj.identity_id+'/token?anlass=REST-Test',headers:H});
  check(g2.statusCode===404&&g2.json().error.code==='ausweis_fehlt','REST nach Loeschen: 404 ausweis_fehlt');

  // MCP/REST-Transport: Legacy-Koordinator ueber das admin-Tool, Ausweis dann bei JEDEM Aufruf als token-Parameter
  const {mcpRoutes}=await load('packages/rest-api/dist/routes/mcp.js');
  const {registerAuthHook}=await load('packages/rest-api/dist/middleware/auth-hook.js');
  const app2=fastify({logger:false});registerAuthHook(app2);await app2.register(mcpRoutes);await app2.ready();close.push(()=>app2.close());
  const rpc=async(name,args)=>{
   const r=await app2.inject({method:'POST',url:'/mcp/messages',headers:{authorization:'Bearer '+bearer,'mcp-session-id':'p22-t24-a'},
    payload:{jsonrpc:'2.0',id:++seq,method:'tools/call',params:{name,arguments:args}}});
   assert.equal(r.statusCode,200,'HTTP 200');return unwrap(r.json().result);
  };
  const mv=await rpc('admin',{action:'agent_vorbereiten',project:P,agent_id:'koordinator-legacy',agent_name:'t24-mcp-1',grund:'Test MCP Legacy-Koordinator'});
  merke(mv.token);
  check(mv.success===true&&AUS.test(mv.token),'MCP admin agent_vorbereiten (Legacy-Koordinator)');
  const ma=await rpc('admin',{action:'token_abrufen',project:P,agent_id:'koordinator-legacy',ziel_identity_id:mv.identity_id,anlass:'MCP-Test'});
  check(ma.success===true&&ma.token===mv.token,'MCP admin token_abrufen (Legacy-Koordinator)');
  const sub=await rpc('admin',{action:'token_abrufen',project:P,agent_id:'sub-legacy',ziel_identity_id:mv.identity_id,anlass:'MCP-Test'});
  check(sub.success===false&&sub.error==='recht_fehlt','MCP: Legacy-Subagent abgelehnt');
  // Erster Toolaufruf mit token = Bestaetigung
  check((await zeilen(mv.identity_id))[0].gueltig_bis!==null,'vor dem ersten Aufruf noch in der Frist');
  const idt=await rpc('chat',{action:'identitaet',token:mv.token});
  check(idt.success===true,'Toolaufruf mit Ausweis erkannt');
  const z=(await zeilen(mv.identity_id))[0];
  check(z.gueltig_bis===null&&z.zuletzt_benutzt!==null,'erster Toolaufruf bestaetigt den Ausweis dauerhaft');
  const logs=JSON.stringify((await pool.query('SELECT * FROM tool_calls')).rows);
  check(!/sai_[a-z0-9]{1,64}/.test(logs)&&secrets.every(s=>!logs.includes(s)),'Ausweiswert nie in tool_calls (args und result)');
 });

 await section('Geheimnisfreiheit: Audit, Revisionen, Thoughts',async()=>{
  const dump=JSON.stringify([
   (await pool.query('SELECT * FROM agent_identitaet_audit')).rows,(await pool.query('SELECT * FROM agent_token_abruf_audit')).rows,
   (await pool.query('SELECT * FROM agent_schattenprofil_audit')).rows,(await pool.query('SELECT * FROM agent_profil_revisionen')).rows,
   (await pool.query('SELECT * FROM agent_schattenprofile')).rows,(await pool.query('SELECT * FROM thoughts')).rows]);
  check(!/sai_[a-z0-9]{1,64}/.test(dump)&&secrets.every(s=>!dump.includes(s)),'Ausweiswert nie in Audit/Revisionen/Schatten/Thoughts');
  check((await pool.query('SELECT count(*)::int n FROM agent_identitaet_tokens WHERE token_offen IS NOT NULL AND token_hash IS NOT NULL')).rows[0].n===0,'neue Zeilen tragen keinen Hash');
  check((await pool.query('SELECT count(*)::int n FROM (SELECT identity_id FROM agent_identitaet_tokens WHERE widerrufen_am IS NULL AND token_offen IS NOT NULL GROUP BY identity_id HAVING count(*)>1) x')).rows[0].n===0,'nie mehr als ein nicht geloeschter Ausweis je Identitaet');
  const idx=(await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND tablename='agent_identitaet_tokens'",[schema])).rows.map(x=>x.indexname);
  check(idx.includes('uq_agent_identitaet_tokens_offen')&&idx.includes('uq_agent_identitaet_tokens_einer'),'Schema 114: unique token_offen und je Identitaet einer');
 });
 check(network===0,'keine echten Netzwerk-/Modellaufrufe');
 console.log('P22-T24 W12-A: '+checks+' Pruefungen, '+failures.length+' Fehler');
 if(failures.length)process.exitCode=1;
}catch(error){console.error(mask(error.stack));process.exitCode=1;}
finally{
 for(const fn of close.reverse())try{await fn();}catch(error){console.error(mask('Cleanup: '+error.message));}
 if(core)await core.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(process.exitCode||0);
