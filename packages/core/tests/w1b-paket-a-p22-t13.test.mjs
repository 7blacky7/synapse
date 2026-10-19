/**
 * P22-T13 Paket A: Schattenprofil (24h, Dedupe, Bestaetigung atomar/idempotent, Ablehnung, Verfall, erster Koordinator),
 * Typ-Katalog global/projekt (Revisionen, Vererbung), Profil (CAS, Historie, Rollback, Eigenprofilregel, Validierung),
 * Schalter Standard AUS. Nur synapse_test:5433, eigenes privates Schema, keine Modelle/Netz/Daemon.
 *   node packages/core/tests/w1b-paket-a-p22-t13.test.mjs
 * P22_T13_ROOT=<stand> faehrt gegen einen anderen Baum (z. B. t109-Basis -> Positivkontrolle: rot).
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const root=process.env.P22_T13_ROOT||repo;
const load=(...p)=>import(pathToFileURL(join(root,...p)).href);
const require=createRequire(join(root,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_INTERN_TOOL','SYNAPSE_W1B_DURCHSETZUNG'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_TOKEN_IDENTITAET:'1',SYNAPSE_AGENT_BEZUG_MODUS:'alt',
 SYNAPSE_AGENT_TOKEN_SCHLUESSEL:'ab'.repeat(32),QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
let network=0;
globalThis.fetch=async()=>{network++;throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t13_a_'+process.pid+'_'+randomUUID().slice(0,8);
const failures=[],secrets=[];let checks=0,core,pool;
const P='pa-projekt',FREMD='pa-fremd';
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}}
async function section(name,fn){
 try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}
 catch(e){failures.push(name+': '+String(e.stack).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]'));console.error('FAIL Abschnitt '+name+': '+e.stack);}
}
const code=async fn=>{try{await fn();return null;}catch(e){return e.code??('X:'+e.message);}};
const rows=async(sql,v=[])=>(await pool.query(sql,v)).rows;
const one=async(sql,v=[])=>(await rows(sql,v))[0];
const user={art:'user'},daemon={art:'daemon'};
const pr=(id,rolle,p=P)=>({art:'identitaet',principal:{art:'identity',project:p,agent_id:id,identity_id:id,rolle,modell:null,context_epoch:1,lauf_id:null}});
const anlage=(agent,extra={},p=P,art='legacy_register',akteur=daemon)=>core.W1B_DIENSTE.schatten.legeSchattenprofilAn(
 {project:p,ursprung_agent_id:agent,ursprung_art:art,selbstangaben:{name:agent,modell:'m1',...extra}},akteur);
// W12 (P22-T24, V2 Weg A): der Schatten traegt KEINEN Token mehr; der Ausweis entsteht erst mit der Bestaetigung (token_offen).
const AUSWEIS=/^sai_[a-z0-9]{1,64}$/;
const bestaetige=(s,extra={},akteur=user)=>core.W1B_DIENSTE.schatten.bestaetigeSchattenprofil(
 {schattenprofil_id:s.id,erwartete_revision:s.revision,user_zustimmung:'User: bestaetigt im Test',grund:'Paket-A-Test',...extra},akteur);

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
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);await pool.query(sql);
 }
 await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,erstellt_von) VALUES('k1',$1,'k1','k1','koordinator','test'),('s1',$1,'s1','s1','subagent','test'),('kf',$2,'kf','kf','koordinator','test')",[P,FREMD]);
 const D=core.W1B_DIENSTE;

 await section('Schalter Standard AUS (Positivkontrolle) und Projekt-Schalter',async()=>{
  const aus=[()=>anlage('a0'),()=>D.schatten.listeSchattenprofile(P,user),()=>D.schatten.verfalleAbgelaufene&&D.typen.listeTypen(P,user),
   ()=>D.typen.legeTypAn({scope:'projekt',project:P,schluessel:'x',inhalt:{},grund:'g1g1g'},user),()=>D.profil.aendereProfil({identity_id:'s1',erwartete_revision:0,patch:{},grund:'g1g1g'},user),
   ()=>D.profil.profilHistorie('s1',user),()=>D.profil.rollbackProfil('s1',1,0,user,'g1g1g')];
  for(const [i,f]of aus.entries())check(await code(f)==='funktion_aus','AUS: Aufruf '+i+' abgelehnt (funktion_aus)');
  for(const t of ['agent_schattenprofile','agent_typen','agent_typ_revisionen','agent_profil_revisionen','agent_schattenprofil_audit'])
   check((await one('SELECT count(*)::int n FROM '+t)).n===0,'AUS: keine Schreibwirkung in '+t);
  check(await code(()=>core.setzeProfilProduktSchalter({ebene:'projekt',project:'pa-nur',funktion:'schattenprofile',aktiv:true,grund:'test p22 projekt'},{system:'user'}))===null,'Projektschalter setzen');
  const s=await anlage('nur1',{},'pa-nur');
  check(s.zustand==='pending','Projektschalter EIN: Anlage nur dort');
  check(await code(()=>anlage('nur2'))==='funktion_aus','anderes Projekt bleibt AUS');
  // P22-T31 Punkt 3: 'alle' EIN unterliegt der Modus-Pruefung (agent_bezug_modus beide) - nur fuer diesen Aufruf.
  process.env.SYNAPSE_AGENT_BEZUG_MODUS='beide';
  try{await core.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:true,grund:'test p22 global'},{system:'user'});}finally{process.env.SYNAPSE_AGENT_BEZUG_MODUS='alt';}
 });

 await section('Typ-Katalog: global/projekt, Revisionen, Vererbung, Rechte',async()=>{
  const T=D.typen;
  const glob=await T.legeTypAn({scope:'global',schluessel:'wissen',inhalt:{kontext_stufe:'kompakt',regeln:['g1'],briefing:'global'},grund:'Test global'},user);
  check(glob.scope==='global'&&glob.aktuelle_revision===1&&glob.project===null,'globaler Typ durch User');
  check(await code(()=>T.legeTypAn({scope:'global',schluessel:'k1typ',inhalt:{},grund:'Test global'},pr('k1','koordinator')))==='recht_fehlt','globaler Typ nur User');
  const proj=await T.legeTypAn({scope:'projekt',project:P,schluessel:'wissen',inhalt:{regeln:['p1']},grund:'Test projekt'},pr('k1','koordinator'));
  check(proj.scope==='projekt'&&proj.project===P,'Projekttyp durch Koordinator');
  check(await code(()=>T.legeTypAn({scope:'projekt',project:P,schluessel:'wissen',inhalt:{},grund:'Test dup'},user))==='typ_existiert','Typ-Schluessel je Scope eindeutig');
  check(await code(()=>T.legeTypAn({scope:'projekt',project:P,schluessel:'Gross',inhalt:{},grund:'Test'},user))==='typ_schluessel_ungueltig','Schluesselformat');
  check(await code(()=>T.legeTypAn({scope:'projekt',project:P,schluessel:'mitpersona',inhalt:{persona:'x'},grund:'Test'},user))==='inhalt_ungueltig','Persona nie Teil des Typs');
  check(await code(()=>T.legeTypAn({scope:'projekt',project:FREMD,schluessel:'fremd',inhalt:{},grund:'Test'},pr('k1','koordinator')))==='recht_fehlt','fremdes Projekt: Koordinator abgewiesen');
  check(await code(()=>T.legeTypAn({scope:'projekt',project:P,schluessel:'sub',inhalt:{},grund:'Test'},pr('s1','subagent')))==='recht_fehlt','Subagent darf keinen Typ anlegen');
  check(await code(()=>T.legeTypAn({scope:'projekt',project:P,schluessel:'forged',inhalt:{},grund:'Test'},pr('s1','koordinator')))==='recht_fehlt','behauptete Rolle ohne DB-Koordinator abgewiesen');
  const fremd=await T.legeTypAn({scope:'projekt',project:FREMD,schluessel:'nur-fremd',inhalt:{},grund:'Test'},user);
  const liste=await T.listeTypen(P,pr('k1','koordinator'));
  check(liste.some(t=>t.id===glob.id)&&liste.some(t=>t.id===proj.id)&&!liste.some(t=>t.id===fremd.id),'Liste: global + eigenes Projekt, nicht fremdes');
  const w=await core.leseWirksamenTypInhalt(proj.id);
  check(w.inhalt.kontext_stufe==='kompakt'&&JSON.stringify(w.inhalt.regeln)==='["p1"]'&&w.inhalt.briefing==='global','Vererbung: Projekt ergaenzt/ueberschreibt global');
  check(w.herkunft.kontext_stufe==='global_typ'&&w.herkunft.regeln==='projekt_typ','Herkunft je Feld');
  check(await code(()=>T.aendereTyp(proj.id,5,{regeln:['p2']},pr('k1','koordinator'),'Test CAS'))==='profil_revision_veraltet','Typ-CAS');
  const p2=await T.aendereTyp(proj.id,1,{regeln:['p2']},pr('k1','koordinator'),'Test neue Revision');
  check(p2.aktuelle_revision===2,'neue Typrevision');
  const r1=await T.leseTypRevision(proj.id,1),r2=await T.leseTypRevision(proj.id);
  check(JSON.stringify(r1.inhalt.regeln)==='["p1"]'&&JSON.stringify(r2.inhalt.regeln)==='["p2"]'&&r2.revision===2,'Revisionen unveraenderlich lesbar');
  check(await code(()=>T.aendereTyp(glob.id,1,{},pr('k1','koordinator'),'Test'))==='recht_fehlt','globalen Typ aendert nur User');
  check(await code(()=>T.aendereTyp(fremd.id,1,{},pr('k1','koordinator'),'Test'))==='recht_fehlt','fremden Projekttyp aendert kein fremder Koordinator');
  const race=await Promise.all([0,1].map(i=>code(()=>T.aendereTyp(proj.id,2,{regeln:['r'+i]},user,'Test parallel'))));
  check(race.filter(x=>x===null).length===1&&race.filter(x=>x==='profil_revision_veraltet').length===1,'parallele Typaenderung: genau eine gewinnt');
  globalThis.__typ=proj;
 });

 await section('Schattenprofil: Anlage, Dedupe, Frist, Token ungueltig, Rechte, CAS',async()=>{
  const weitere={token:'sai_'+'a'.repeat(64),notiz:'x sai_'+'b'.repeat(64),anderes:'ok'};
  const s=await anlage('luna',{channels:['c1'],rolle_vorschlag:'koordinator',weitere});
  check(s.zustand==='pending'&&s.revision===1&&s.ursprung_agent_id==='luna'&&s.identity_id===null,'Schattenprofil pending');
  check(Date.parse(s.ablauf_am)-Date.parse(s.erstellt_am)===core.AUSWEIS_FRIST_DEFINITIONEN.schatten_stunden.standard*3600e3,'Frist exakt 24 h (Standard der Einstellung schatten_stunden, P22-T45)');
  check(!JSON.stringify(s).includes('sai_')&&!('vorgesehener_token' in s),'Antwort ohne Token');
  const db=await one('SELECT selbstangaben,vorgesehener_token_verschluesselt c FROM agent_schattenprofile WHERE id=$1',[s.id]);
  check(!('token' in db.selbstangaben.weitere)&&db.selbstangaben.weitere.notiz==='x [ausweis]'&&db.selbstangaben.weitere.anderes==='ok','Selbstangaben ohne Zugangswerte, Rest erhalten');
  check(db.c===null&&(await one('SELECT vorgesehener_token_hash h FROM agent_schattenprofile WHERE id=$1',[s.id])).h===null,'Weg A (W12): Schatten traegt keinen Token (weder Hash noch Chiffre)');
  check((await one("SELECT count(*)::int n FROM agent_identitaet_tokens t JOIN agent_identitaeten i ON i.id=t.identity_id WHERE i.project=$1 AND i.agent_id='luna'",[P])).n===0,'keine Token-Zeile vor Bestaetigung');
  const gleich=await anlage('luna',{channels:['c1']});
  check(gleich.id===s.id&&gleich.revision===1,'wiederholte Meldung: derselbe Vorgang, keine Revision');
  const mehr=await anlage('luna',{channels:['c2'],effort:'hoch'});
  check(mehr.id===s.id&&mehr.revision===2&&JSON.stringify(mehr.selbstangaben.channels)==='["c1","c2"]'&&mehr.selbstangaben.effort==='hoch','Zusammenfuehrung mit neuer Selbstangabe');
  check(mehr.ablauf_am===s.ablauf_am,'Aktivitaet verlaengert die Frist nicht');
  check((await one('SELECT count(*)::int n FROM agent_schattenprofile WHERE project=$1 AND ursprung_agent_id=$2',[P,'luna'])).n===1,'ein Vorgang je Agent');
  check(await code(()=>anlage('k1'))==='identitaet_existiert','bestehende Identitaet: keine Schattenanlage');
  check(await code(()=>anlage('x',{},P,'koordinator_voranlage'))==='recht_fehlt','Voranlage nicht durch Daemon');
  check(await code(()=>anlage('x',{},P,'legacy_register',pr('s1','subagent')))==='recht_fehlt','Anlage nicht durch Subagent');
  const vor=await anlage('vor1',{},P,'koordinator_voranlage',pr('k1','koordinator'));
  check(vor.ursprung_art==='koordinator_voranlage','Voranlage durch Koordinator');
  // Rechte
  check((await D.schatten.listeSchattenprofile(P,user)).length>=2&&(await D.schatten.listeSchattenprofile(P,pr('k1','koordinator'))).length>=2,'Liste User/Koordinator');
  for(const [n,a]of [['Subagent',pr('s1','subagent')],['fremder Koordinator',pr('kf','koordinator',FREMD)],['Daemon',daemon],['gefaelschter Koordinator',pr('s1','koordinator')]])
   check(await code(()=>D.schatten.listeSchattenprofile(P,a))==='recht_fehlt','Liste verweigert: '+n);
  check(await code(()=>bestaetige(s,{},pr('s1','subagent')))==='recht_fehlt','Bestaetigung durch Subagent verweigert');
  check(await code(()=>bestaetige(s,{user_zustimmung:' '}))==='user_zustimmung_fehlt','Bestaetigung ohne Zustimmungsnachweis verweigert');
  check(await code(()=>bestaetige(s,{},daemon))==='recht_fehlt','Daemon bestaetigt kein Legacy-Profil');
  // Korrektur mit CAS
  check(await code(()=>D.schatten.korrigiereSchattenprofil(s.id,1,{kontext_stufe:'kompakt'},user,'Test'))==='profil_revision_veraltet','Korrektur-CAS');
  check(await code(()=>D.schatten.korrigiereSchattenprofil(s.id,2,{kontext_stufe:'riesig'},user,'Test'))==='inhalt_ungueltig','Korrektur validiert');
  const k=await D.schatten.korrigiereSchattenprofil(s.id,2,{rolle:'spezialist',modell:'korrigiert-modell',kontext_stufe:'kompakt',regeln:['r1']},pr('k1','koordinator'),'Typ/Modell korrigiert');
  check(k.revision===3&&k.korrektur.modell==='korrigiert-modell'&&k.selbstangaben.modell==='m1','Korrektur getrennt von Selbstangaben');
  const au=await rows("SELECT aktion,wer FROM agent_schattenprofil_audit WHERE schattenprofil_id=$1 ORDER BY id",[s.id]);
  check(au.map(x=>x.aktion).join()==='angelegt,selbstangaben_aktualisiert,korrigiert'&&au[2].wer==='k1','Audit je Schritt mit Akteur');
  globalThis.__luna=k;
 });

 await section('Bestaetigung: atomar, idempotent, Token aktiv, Rolle nur per Korrektur',async()=>{
  const s=globalThis.__luna,typ=globalThis.__typ;
  const [a,b]=await Promise.all([bestaetige(s,{typ_id:typ.id}),bestaetige(s,{typ_id:typ.id},pr('k1','koordinator'))]);
  check(a.identity_id===b.identity_id&&a.profil_revision===1,'Doppelbestaetigung (parallel): dieselbe Identitaet');
  check((await one("SELECT count(*)::int n FROM agent_identitaeten WHERE project=$1 AND agent_id='luna'",[P])).n===1,'genau eine Identitaet');
  check((await one('SELECT count(*)::int n FROM agent_identitaet_tokens WHERE identity_id=$1',[a.identity_id])).n===1,'genau ein Token');
  check((await one("SELECT count(*)::int n FROM agent_identitaet_audit WHERE identity_id=$1 AND aktion='token_ausstellen'",[a.identity_id])).n===1,'ein Token-Audit');
  const spaeter=await core.W1B_DIENSTE.schatten.bestaetigeSchattenprofil({schattenprofil_id:s.id,erwartete_revision:1,user_zustimmung:'noch einmal',grund:'spaet'},user);
  check(spaeter.identity_id===a.identity_id&&spaeter.schattenprofil.zustand==='bestaetigt','spaete Doppelbestaetigung idempotent (auch mit alter Revision)');
  const i=await one('SELECT * FROM agent_identitaeten WHERE id=$1',[a.identity_id]);
  check(i.rolle==='spezialist'&&i.modell_bestaetigt==='korrigiert-modell'&&i.modell_selbstauskunft==='m1'&&i.profil_revision===1&&i.typ_id===typ.id&&i.typ_revision>=1&&i.agent_id==='luna'&&i.name==='luna'&&i.instanz_nr===1,'Identitaet aus bestaetigtem Profil');
  check(i.profil.kontext_stufe==='kompakt'&&JSON.stringify(i.profil.regeln)==='["r1"]'&&!('rolle' in i.profil)&&!('modell' in i.profil),'Profil-Override ohne Spaltenfelder');
  const rv=await rows('SELECT * FROM agent_profil_revisionen WHERE identity_id=$1',[a.identity_id]);
  check(rv.length===1&&rv[0].revision===1&&rv[0].snapshot.rolle==='spezialist'&&rv[0].snapshot.modell_bestaetigt==='korrigiert-modell'&&rv[0].user_auftrag==='User: bestaetigt im Test','Profilrevision 1 mit Zustimmungsnachweis');
  const t=await one('SELECT * FROM agent_identitaet_tokens WHERE identity_id=$1',[a.identity_id]);
  secrets.push(t.token_offen);
  check(t.gueltig_bis===null&&t.start_art===null&&AUSWEIS.test(t.token_offen)&&t.token_hash===null&&t.token_verschluesselt===null&&t.ausweis_weg==='schatten_bestaetigt','Ausweis (W12) offen gespeichert, sofort aktiv/dauerhaft (schatten_bestaetigt)');
  const an=await core.pruefeAgentToken(t.token_offen,P);
  check(an.agent_id==='luna'&&an.rolle==='spezialist'&&an.identitaet.id===a.identity_id,'bestaetigter Token authentifiziert');
  const sh=await one('SELECT zustand,identity_id,vorgesehener_token_verschluesselt c,entschieden_von,user_zustimmung FROM agent_schattenprofile WHERE id=$1',[s.id]);
  check(sh.zustand==='bestaetigt'&&sh.identity_id===a.identity_id&&sh.c===null&&sh.user_zustimmung==='User: bestaetigt im Test','Schatten: bestaetigt, Chiffre entfernt, Nachweis');
  // Rolle nur per Korrektur: Vorschlag koordinator bleibt Vorschlag
  const sn=await anlage('sneaky',{rolle_vorschlag:'koordinator',typ_vorschlag:'koordinator'});
  const sb=await bestaetige(sn,{},pr('k1','koordinator'));
  check((await one('SELECT rolle FROM agent_identitaeten WHERE id=$1',[sb.identity_id])).rolle==='subagent','Selbstangabe Koordinator ohne Korrektur -> subagent');
  // deaktivierter Typ
  await pool.query("UPDATE agent_typen SET status='deaktiviert' WHERE id=$1",[typ.id]);
  const sd=await anlage('typtest');
  check(await code(()=>bestaetige(sd,{typ_id:typ.id}))==='typ_deaktiviert','deaktivierter Typ nicht zuweisbar');
  await pool.query("UPDATE agent_typen SET status='aktiv' WHERE id=$1",[typ.id]);
  check(await code(()=>bestaetige(sd,{typ_id:randomUUID()}))==='typ_unbekannt','unbekannter Typ');
  // Atomaritaet: Fehler nach Identitaetsanlage -> nichts bleibt
  const sk=await anlage('kaputt');
  // W12: Fehler beim Schreiben des Ausweises (Trigger wirft) -> kompletter Rollback.
  await pool.query("CREATE OR REPLACE FUNCTION w12_test_fail() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'w12 test'; END $f$");
  await pool.query('CREATE TRIGGER w12_test_fail BEFORE INSERT ON agent_identitaet_tokens FOR EACH ROW EXECUTE FUNCTION w12_test_fail()');
  check(await code(()=>bestaetige(sk))==='profil_speicher_fehler','Fehler beim Ausweisschreiben bei Bestaetigung');
  await pool.query('DROP TRIGGER w12_test_fail ON agent_identitaet_tokens');await pool.query('DROP FUNCTION w12_test_fail()');
  check((await one("SELECT count(*)::int n FROM agent_identitaeten WHERE agent_id='kaputt'")).n===0&&(await one('SELECT zustand FROM agent_schattenprofile WHERE id=$1',[sk.id])).zustand==='pending','keine halbe Identitaet (Rollback)');
  // Ablehnung
  const sa=await anlage('neinsager');
  check(await code(()=>D.schatten.lehneSchattenprofilAb(sa.id,9,user,'Test'))==='profil_revision_veraltet','Ablehnung-CAS');
  const ab=await D.schatten.lehneSchattenprofilAb(sa.id,sa.revision,pr('k1','koordinator'),'nicht gewollt');
  check(ab.zustand==='abgelehnt'&&(await D.schatten.lehneSchattenprofilAb(sa.id,99,user,'nochmal')).zustand==='abgelehnt','Ablehnung, idempotent');
  check(await code(()=>bestaetige(ab))==='schattenprofil_abgelehnt','abgelehnt nicht bestaetigbar');
  check((await one("SELECT count(*)::int n FROM agent_identitaeten WHERE project=$1 AND agent_id='neinsager'",[P])).n===0,'nach Ablehnung weder Identitaet noch Ausweis');
  check((await one('SELECT vorgesehener_token_verschluesselt c FROM agent_schattenprofile WHERE id=$1',[sa.id])).c===null,'Ablehnung entfernt Chiffre');
 });

 await section('Ablauf/Verfall ohne Datenverlust',async()=>{
  const s=await anlage('alt1',{channels:['x']});
  await pool.query("UPDATE agent_schattenprofile SET erstellt_am=NOW()-INTERVAL '2 days', ablauf_am=NOW()-INTERVAL '1 hour' WHERE id=$1",[s.id]);
  check((await D.schatten.listeSchattenprofile(P,user)).find(x=>x.id===s.id).zustand==='abgelaufen','pending nach Frist wirksam abgelaufen (ohne Verfallslauf)');
  check(await code(()=>bestaetige(s))==='schattenprofil_abgelaufen'&&await code(()=>D.schatten.korrigiereSchattenprofil(s.id,1,{},user,'Test'))==='schattenprofil_abgelaufen','abgelaufen: nicht bestaetigbar/korrigierbar');
  const n=await D.schatten.verfalleAbgelaufene(P);
  const z=await one('SELECT zustand,selbstangaben,vorgesehener_token_verschluesselt c,vorgesehener_token_hash h FROM agent_schattenprofile WHERE id=$1',[s.id]);
  check(n>=1&&z.zustand==='abgelaufen'&&z.c===null&&z.h===null&&z.selbstangaben.channels[0]==='x','Verfall: Zustand, kein Token (W12), Angaben bleiben');
  const neu=await anlage('alt1');
  check(neu.id!==s.id&&neu.zustand==='pending','neue bewusste Anmeldung: neuer Vorgang');
  const s2=await anlage('alt2');
  await pool.query("UPDATE agent_schattenprofile SET erstellt_am=NOW()-INTERVAL '2 days', ablauf_am=NOW()-INTERVAL '1 hour' WHERE id=$1",[s2.id]);
  const n2=await anlage('alt2');
  check(n2.id!==s2.id&&(await one('SELECT zustand FROM agent_schattenprofile WHERE id=$1',[s2.id])).zustand==='abgelaufen','Anlage ueber nicht ausgefegtem Ablauf: alter Vorgang abgelaufen, neuer pending');
  const f=await anlage('frist',{},'pa-nur');
  check(await D.schatten.verfalleAbgelaufene('pa-nur',new Date(Date.parse(f.erstellt_am)+23*3600e3))===0&&await D.schatten.verfalleAbgelaufene('pa-nur',new Date(Date.parse(f.erstellt_am)+25*3600e3))>=1,'Frist 24 h exakt: bei 23 h nicht, bei 25 h verfallen');
  check((await one('SELECT count(*)::int n FROM agent_identitaeten WHERE agent_id IN (\'alt1\',\'alt2\',\'frist\')')).n===0,'Verfall loescht/erzeugt keine Identitaet');
 });

 await section('Erster Koordinator (atomar je Projekt), weitere Koordinatoren',async()=>{
  const st=await anlage('koordinator',{rolle_vorschlag:'koordinator'},'pa-start','koordinator_start');
  const b=await bestaetige(st,{user_zustimmung:'User-Auftrag: melde dich als Koordinator an'},daemon);
  const i=await one('SELECT * FROM agent_identitaeten WHERE id=$1',[b.identity_id]);
  check(i.rolle==='koordinator'&&i.name==='koordinator'&&i.agent_id==='koordinator'&&i.project==='pa-start','erster Koordinator ohne Anfangstoken');
  check((await one('SELECT user_zustimmung u FROM agent_schattenprofile WHERE id=$1',[st.id])).u.includes('User-Auftrag'),'User-Auftrag im Audit/Nachweis');
  const zw=await anlage('koordinator-b',{},'pa-start','koordinator_start');
  check(await code(()=>bestaetige(zw,{},daemon))==='erster_koordinator_vergeben','zweiter Startfall nicht ohne vorhandenen Koordinator');
  const leg=await anlage('legacyx',{},'pa-start');
  check(await code(()=>bestaetige(leg,{},daemon))==='recht_fehlt','Daemon nur fuer Koordinator-Startfall');
  const kid=pr(b.identity_id,'koordinator','pa-start');
  const weitere=await anlage('koordinator-neu',{},'pa-start','koordinator_voranlage',kid);
  const wb=await bestaetige(weitere,{korrektur:{rolle:'koordinator'}},kid);
  check((await one('SELECT agent_id,rolle,instanz_nr FROM agent_identitaeten WHERE id=$1',[wb.identity_id])).agent_id==='koordinator#2','weiterer Koordinator koordinator#2 durch vorhandenen Koordinator');
  const ra=await Promise.allSettled([anlage('ka',{},'pa-start2','koordinator_start'),anlage('kb',{},'pa-start2','koordinator_start')]);
  const [sa,sb]=ra.map(r=>r.value);
  const rr=await Promise.allSettled([bestaetige(sa,{},daemon),bestaetige(sb,{},daemon)]);
  check(rr.filter(r=>r.status==='fulfilled').length===1&&rr.filter(r=>r.status==='rejected'&&r.reason.code==='erster_koordinator_vergeben').length===1,'gleichzeitige Startfaelle: genau einer');
  check((await one("SELECT count(*)::int n FROM agent_identitaeten WHERE project='pa-start2' AND rolle='koordinator'")).n===1,'ein Koordinator je Projekt');
  globalThis.__startKoord=b.identity_id;
 });

 await section('Profil: CAS, Historie, Rollback, Eigenprofilregel, Validierung',async()=>{
  const luna=(await one("SELECT id FROM agent_identitaeten WHERE project=$1 AND agent_id='luna'",[P])).id;
  const k1=pr('k1','koordinator'),A=D.profil;
  const ch=async(patch,rev,akteur=k1,extra={})=>A.aendereProfil({identity_id:luna,erwartete_revision:rev,patch,grund:'Test Aenderung',...extra},akteur);
  const r2=await ch({kontext_stufe:'minimal',modell:'neues-modell',hinweise:{open_plans:false}},1);
  check(r2.profil_revision===2,'Profilaenderung -> Revision 2');
  const i=await one('SELECT * FROM agent_identitaeten WHERE id=$1',[luna]);
  check(i.modell_bestaetigt==='neues-modell'&&i.profil.kontext_stufe==='minimal'&&i.profil.hinweise.open_plans===false&&JSON.stringify(i.profil.regeln)==='["r1"]'&&i.profil_revision===2,'DB-Stand sofort wirksam, uebrige Felder erhalten');
  check(await code(()=>ch({effort:'x'},1))==='profil_revision_veraltet','Profil-CAS');
  const ok=await Promise.all([0,1].map(n=>code(()=>ch({effort:'e'+n},2))));
  check(ok.filter(x=>x===null).length===1&&ok.filter(x=>x==='profil_revision_veraltet').length===1,'parallele Profilaenderung: genau eine gewinnt');
  check(await code(()=>ch({hinweise:{fehler:false}},3))==='hinweis_pflicht_nicht_abschaltbar','Pflichthinweis nicht abschaltbar');
  check(await code(()=>ch({briefing:'x sai_'+'c'.repeat(64)},3))==='inhalt_enthaelt_ausweis','keine Ausweise im Profiltext');
  check(await code(()=>ch({startrezept:{token:'x'}},3))==='inhalt_enthaelt_zugangswert','keine Zugangswerte im Startrezept');
  check(await code(()=>ch({persona:'x'},3))==='inhalt_ungueltig','Persona nicht im Profil-Override');
  check(await code(()=>ch({zuschnitt:{aktionen:{'files':'verweigert'}}},3))==='inhalt_ungueltig','Zuschnitt-Schluessel validiert');
  check(await code(()=>ch({zuschnitt:{intern_user_festgelegt:{user_auftrag:'U'}}},3))==='intern_festlegung_nur_user','intern-Festlegung nur User');
  check(await code(()=>ch({kontext_stufe:'normal'},3,pr('s1','subagent'),{}))==='recht_fehlt','Subagent aendert fremdes Profil nicht');
  check(await code(()=>ch({kontext_stufe:'normal'},3,pr('kf','koordinator',FREMD)))==='recht_fehlt','fremder Koordinator nicht');
  check(await code(()=>ch({kontext_stufe:'normal'},3,pr(luna,'spezialist')))==='eigenprofil_nicht_aenderbar','Agent (kein Koordinator) aendert sein eigenes Profil nicht (P22-T53)');
  check(await code(()=>A.aendereProfil({identity_id:luna,erwartete_revision:3,patch:{effort:'z'},grund:' '},user))==='grund_fehlt','Grund Pflicht');
  const r4=await ch({zuschnitt:{standard:'erlaubt',aktionen:{'files.commit':'verweigert'},intern_user_festgelegt:{user_auftrag:'User: intern gesperrt'}}},3,user,{user_auftrag:'User: Zuschnitt'});
  check(r4.profil_revision===4,'User setzt Zuschnitt inkl. intern-Festlegung');
  const typ=globalThis.__typ,r5=await ch({kontext_stufe:'kompakt'},4,user,{typ_id:null});
  check(r5.profil_revision===5&&(await one('SELECT typ_id FROM agent_identitaeten WHERE id=$1',[luna])).typ_id===null,'Typ entfernen');
  const r6=await ch({},5,k1,{typ_id:typ.id});
  check(r6.profil_revision===6&&(await one('SELECT typ_id,typ_revision FROM agent_identitaeten WHERE id=$1',[luna])).typ_revision>=2,'Typ zuweisen mit aktueller Typrevision');
  // Historie
  const h=await A.profilHistorie(luna,k1);
  check(h.length===6&&h.every((x,n)=>x.revision===n+1&&x.grund),'Historie lueckenlos, jede Revision mit Grund');
  check(h[3].user_auftrag==='User: Zuschnitt'&&h[1].wer==='k1','Akteur und User-Auftrag je Revision');
  check((await A.profilHistorie(luna,pr(luna,'spezialist'))).length===6,'Eigenprofil-Historie fuer den Agenten selbst lesbar');
  check(await code(()=>A.profilHistorie(luna,pr('s1','subagent')))==='recht_fehlt','fremde Historie nicht lesbar');
  // Rollback + Persona (K7)
  await pool.query("INSERT INTO agent_persona_vorlagen(id,scope,project,name,aktuelle_version,erstellt_von) VALUES('pv1','projekt',$1,'Test',1,'user')",[P]);
  await pool.query("INSERT INTO agent_persona_versionen(vorlage_id,version,inhalt,wer,user_auftrag) VALUES('pv1',1,'{}','user','User: Persona')");
  await pool.query("INSERT INTO agent_persona_zuweisungen(identity_id,vorlage_id,version,user_auftrag,gesetzt_von) VALUES($1,'pv1',1,'User: Persona','user')",[luna]);
  const r7=await ch({effort:'mit-persona'},6);
  check((await one('SELECT persona_vorlage_id v FROM agent_profil_revisionen WHERE identity_id=$1 AND revision=7',[luna])).v==='pv1','Revision haelt Persona-Bezug fest');
  await pool.query('DELETE FROM agent_persona_zuweisungen WHERE identity_id=$1',[luna]);
  check(await code(()=>A.rollbackProfil(luna,1,3,user,'Test'))==='profil_revision_veraltet','Rollback-CAS');
  check(await code(()=>A.rollbackProfil(luna,99,7,user,'Test'))==='revision_unbekannt','Rollback: unbekannte Revision');
  const rb=await A.rollbackProfil(luna,1,7,k1,'Zurueck auf Bestaetigung');
  const nach=await one('SELECT * FROM agent_identitaeten WHERE id=$1',[luna]);
  const rv=await rows('SELECT revision,snapshot,grund FROM agent_profil_revisionen WHERE identity_id=$1 ORDER BY revision',[luna]);
  check(rb.profil_revision===8&&rv.length===8,'Rollback = neue Revision, nichts geloescht');
  check(JSON.stringify(rv[7].snapshot)===JSON.stringify(rv[0].snapshot)&&rv[7].grund.startsWith('Rollback auf Revision 1'),'Rollback-Snapshot = Zielrevision');
  check(nach.modell_bestaetigt==='korrigiert-modell'&&nach.profil.kontext_stufe==='kompakt'&&!('effort' in nach.profil)&&!('hinweise' in nach.profil),'Identitaetsstand auf Zielrevision');
  check((await one('SELECT count(*)::int n FROM agent_persona_zuweisungen WHERE identity_id=$1',[luna])).n===0,'Rollback reaktiviert keine entfernte Persona (K7)');
  // Eigenprofilregel P22-T53 (User 58c38995, ersetzt F2): Koordinator aendert sein Eigenprofil jederzeit; CAS und Historie bleiben.
  const kid=globalThis.__startKoord,KS=pr(kid,'koordinator','pa-start');
  const ca=(patch,rev,extra={})=>A.aendereProfil({identity_id:kid,erwartete_revision:rev,patch,grund:'Eigenprofil',...extra},KS);
  check((await ca({briefing:'b'},1)).profil_revision===2,'Koordinator: Eigenprofil ohne User-Auftrag (P22-T53)');
  check((await ca({briefing:'noch'},2)).profil_revision===3,'Koordinator: Eigenprofil dauerhaft aenderbar');
  check(await code(()=>ca({briefing:'cas'},2))==='profil_revision_veraltet','Eigenprofil: CAS bleibt');
  check((await A.profilHistorie(kid,KS)).at(-1).wer===kid,'Eigenprofil: Historie mit Akteur');
  check((await A.aendereProfil({identity_id:'k1',erwartete_revision:0,patch:{effort:'x'},grund:'Test'},k1)).profil_revision===1,'Koordinator k1 aendert sein Eigenprofil');
  check((await A.aendereProfil({identity_id:'s1',erwartete_revision:0,patch:{effort:'x'},grund:'Test'},k1)).profil_revision===1,'Koordinator aendert Profil eines anderen (Revision 0 -> 1)');
  check((await A.aendereProfil({identity_id:'k1',erwartete_revision:1,patch:{effort:'y'},grund:'Test'},user)).profil_revision===2,'User aendert Koordinatorprofil');
 });

 await section('Keine Geheimnisse in Antworten/Audit, kein Netz',async()=>{
  const tabellen=['agent_schattenprofil_audit','agent_identitaet_audit','agent_profil_revisionen','agent_token_abruf_audit','agent_typ_revisionen','tool_calls'];
  let dump='';
  for(const t of tabellen)dump+=JSON.stringify(await rows('SELECT * FROM '+t));
  dump+=JSON.stringify(await rows('SELECT selbstangaben,korrektur,grund,user_zustimmung FROM agent_schattenprofile'));
  dump+=JSON.stringify(await rows('SELECT profil,startrezept FROM agent_identitaeten'));
  check(secrets.length>=1&&secrets.every(s=>!dump.includes(s)),'kein Token in Audit, Revisionen, Profilen ('+secrets.length+' geprueft)');
  check(!/sai_[a-z0-9]{1,64}/.test(dump),'kein Ausweis-Muster in Audit/Revisionen');
  check(network===0,'keine Netzwerk-/Modellaufrufe');
 });
 console.log('P22-T13 Paket A: '+checks+' Pruefungen, '+failures.length+' Fehler');
 if(failures.length)process.exitCode=1;
}catch(error){console.error(String(error.stack).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]'));process.exitCode=1;}
finally{
 if(core)await core.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(process.exitCode||0);
