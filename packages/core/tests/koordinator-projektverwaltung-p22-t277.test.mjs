/**
 * P22-T277 (User 06.11.2026): Koordinatoren verwalten jedes Projekt ausser synapse (Schalter koordinator_projektverwaltung, global,
 * Standard AUS). Prueft packages/core/src/services/koordinator-projektverwaltung.ts und den erweiterten Rechteweg (agent-token-tools.ts
 * Ausweis-Grenze, agent-profil-verwalter.ts koordinatorVerwaltetProjekt, agent-token-abruf.ts, agent-identitaet.ts berechtigung,
 * agent-profil-schalter.ts setzeProfilProduktSchalter) durch die ECHTE Ausweis-Grenze (mitAgentToolAufruf):
 *  A Katalog (nur ausdruecklich, Standard AUS, alle schaltet ihn nicht), Positivliste, Ausnahmen
 *  B Schalter AUS -> Bestand (fremdes Projekt abgewiesen, nichts geschrieben)
 *  C EIN: synapse-Koordinator setzt/liest Projektschalter in B (B ohne Koordinator), Herkunftsvermerk, berechtigung_weg, Audit-Zeile
 *  D EIN: Projektschalter in C (mit vorhandenem Koordinator); build_einstellungen setzen nur Projektwerte
 *  E EIN: Koordinator-Ausweis in B anlegen; vorhandene Koordinator-Identitaet in C neu vorbereiten + token_abrufen
 *  F Abweisungen: ebene global, ohne grund/user_auftrag, Projekt synapse, Nicht-Koordinator, Aktion ausserhalb der Positivliste,
 *    Fachdienste ohne Kontext-Flag
 *  G Schalter wieder AUS -> Bestand
 * Nur synapse_test:5433, eigenes privates Schema (alle Tabellen LIKE public, eigene Sequenzen), mehrprojekt bleibt AUS.
 *   node packages/core/tests/koordinator-projektverwaltung-p22-t277.test.mjs
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
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_AUTH_DISABLED','SYNAPSE_W1B_DURCHSETZUNG','SYNAPSE_W1B_ANTWORTANPASSUNG',
 'SYNAPSE_MAIN_SYNAPSE','SYNAPSE_HAUPTAGENT','SYNAPSE_AGENTEN_AUSWEIS','SYNAPSE_TOKEN_IDENTITAET','SYNAPSE_W1B_ANMELDUNG'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',SYNAPSE_HINWEIS_BUDGET_MS:'5000',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
globalThis.fetch=async()=>{throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t277_'+process.pid+'_'+randomUUID().slice(0,8);
const H='synapse',B='p22-t277-b',C2='p22-t277-c',H2='p22-t277-h',SRV='srv-t277';
const failures=[];let core,checks=0;
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label,detail){checks++;if(!ok){failures.push(label);console.error('FAIL '+label+(detail===undefined?'':' '+mask(JSON.stringify(detail)).slice(0,600)));}else console.log('ok   '+label);}

try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){
  const q='"'+tablename.replaceAll('"','""')+'"';
  await admin.query('CREATE TABLE '+schema+'.'+q+' (LIKE public.'+q+' INCLUDING ALL)');
 }
 const serials=await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%' ORDER BY table_name,column_name",[schema]);
 for(const [i,r]of serials.rows.entries()){
  const quote=s=>'"'+s.replaceAll('"','""')+'"',sequence=schema+'.t277_serial_'+i;
  await admin.query('CREATE SEQUENCE '+sequence);
  await admin.query('ALTER TABLE '+schema+'.'+quote(r.table_name)+' ALTER COLUMN '+quote(r.column_name)+" SET DEFAULT nextval('"+sequence+"'::regclass)");
 }
 url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.href;
 core=await load('packages/core/dist/index.js');const pool=core.getPool();
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','agent-runtime-auftraege-schema','agent-verbrauch-schema','agent-entfernung-schema','build-pruefung-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);
 }
 for(const f of ['117_agent_ausweis_fristen.sql','118_agent_ausweis_projekte.sql','124_hauptagent_verlauf.sql','128_agent_startkontext.sql'])await pool.query(readFileSync(join(repo,'packages/core/src/db/schema-sql/'+f),'utf8'));
 await pool.query("CREATE SEQUENCE IF NOT EXISTS agent_ausweis_nr");
 const C=core,USER={art:'user'};
 const T=await load('packages/core/dist/services/agent-token-tools.js');
 const V=await load('packages/core/dist/services/agent-profil-verwalter.js');
 const KP=await load('packages/core/dist/services/koordinator-projektverwaltung.js');
 const BP=await load('packages/core/dist/services/build-pruefung.js');
 const aufruf=async(tool,args,arbeit)=>{let k;const r=await T.mitAgentToolAufruf(tool,args,SRV,async x=>{k=x;if(x.antwort)return x.antwort;return arbeit?arbeit(x):{success:true};});return {k,r};};
 const sp=(await pool.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='projects' AND is_nullable='NO' AND column_default IS NULL",[schema])).rows;
 for(const name of [H,B,C2,H2]){
  const werte={name,path:'/tmp/'+name,enabled:true};
  await pool.query(`INSERT INTO projects(${sp.map(s=>'"'+s.column_name+'"').join(',')}) VALUES(${sp.map((_,i)=>'$'+(i+1)).join(',')})`,
   sp.map(s=>werte[s.column_name]??(s.data_type==='boolean'?false:s.data_type.includes('int')?0:s.data_type.includes('json')?'{}':s.data_type.includes('time')?new Date():'x')));
 }
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'agenten_ausweis',aktiv:true,grund:'Test T277 Ausweis-Kern'},{system:'user'});
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:true,grund:'Test T277 alle'},{system:'user'});
 const neu=async(project,name,rolle)=>{
  const r=await C.fuehreW1bAdminAus('agent_vorbereiten',{project,agent_name:name,rolle,grund:'Test T277 Anlage durch User',user_auftrag:'Test T277'},{akteur:USER});
  check(r.success===true&&typeof r.token==='string','Anlage '+project+'/'+name,r);return r;
 };
 const K=await neu(H,'koordinator','koordinator');           // Koordinator von synapse (wie sai_3)
 const KH=await neu(H2,'koordinator','koordinator');         // Koordinator eines anderen Projekts
 const SP=await neu(H,'t277-spezialist','subagent');        // Nicht-Koordinator
 const KC=await neu(C2,'koordinator-opus','koordinator');    // vorhandener (ruhender) Koordinator in C
 const setzen=(tok,project,extra={})=>aufruf('admin',{action:'profil_schalter_setzen',project,profil_funktion:'verbrauch',aktiv:true,
  grund:'Test T277 Projektschalter setzen',user_auftrag:'User 06.11.: Projektschalter in fremden Projekten setzen',...extra,token:tok},
  x=>C.fuehreW1bAdminAus('profil_schalter_setzen',x.args));
 const zeile=async(project)=>(await pool.query("SELECT ebene,project,aktiv,gesetzt_von,grund FROM agent_profil_schalter WHERE funktion='verbrauch' AND COALESCE(project,'')=$1",[project??''])).rows[0];
 const weg=r=>JSON.stringify(r?.berechtigung_weg??null).includes('koordinator_projektverwaltung');

 // A Katalog, Positivliste, Ausnahmen
 check(C.PROFIL_PRODUKT_FUNKTIONEN.includes('koordinator_projektverwaltung')&&C.NUR_AUSDRUECKLICH.includes('koordinator_projektverwaltung'),'A Katalog, nur ausdruecklich');
 check(await KP.koordinatorVerwaltungAktiv()===false,'A Standard AUS (alle schaltet ihn nicht)');
 check(KP.koordinatorVerwaltungErlaubt('admin','profil_schalter_setzen')&&KP.koordinatorVerwaltungErlaubt('admin','agent_vorbereiten')&&KP.koordinatorVerwaltungErlaubt('code_check','build_einstellungen')
  &&!KP.koordinatorVerwaltungErlaubt('admin','identitaet_deaktivieren')&&!KP.koordinatorVerwaltungErlaubt('thought','add'),'A Positivliste');
 check(KP.istKoordinatorVerwaltungAusgenommen('synapse')&&KP.istKoordinatorVerwaltungAusgenommen(C.HAUPTAGENT_PROJEKT)&&!KP.istKoordinatorVerwaltungAusgenommen(B),'A Ausnahmen synapse + Hauptagent-Bereich');

 // B AUS = Bestand
 {const {k,r}=await setzen(K.token,B);
  check(k.antwort?.success===false&&!weg(r)&&!(await zeile(B)),'B AUS: fremdes Projekt abgewiesen, nichts geschrieben',k.antwort);}

 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'koordinator_projektverwaltung',aktiv:true,grund:'Test T277 EIN'},{system:'user'});
 check(await KP.koordinatorVerwaltungAktiv()===true,'EIN gesetzt');

 // C Projektschalter in B (kein Koordinator in B)
 {const {k,r}=await setzen(K.token,B);
  check(!k.antwort&&k.args.project===B,'C Ausweis-Grenze laesst profil_schalter_setzen in B durch',k.antwort);
  check(r.success===true,'C Schalter in B gesetzt',r);
  check(weg(r),'C Debug berechtigung_weg',r?.berechtigung_weg);
  const z=await zeile(B);
  check(z?.ebene==='projekt'&&z.aktiv===true&&z.gesetzt_von===K.identity_id,'C Zeile Projektebene B, gesetzt_von = Identitaet',z);
  check(/koordinator_projektverwaltung: koordinator \(/.test(z?.grund??'')&&z.grund.includes(' aus '+H+' -> '+B+', admin.profil_schalter_setzen'),'C Herkunftsvermerk im Schalterverlauf',z?.grund);
  const a=(await pool.query("SELECT args_preview FROM tool_calls WHERE project=$1 AND source='koordinator-projektverwaltung' ORDER BY id DESC LIMIT 1",[B]).catch(()=>({rows:[]}))).rows[0];
  check(!a||String(a.args_preview).includes('"heimat":"'+H+'"'),'C Audit-Zeile in B nennt Heimat (sofern tool_calls lesbar)',a);
  const {k:ks,r:rs}=await aufruf('admin',{action:'profil_schalter_status',project:B,token:K.token},x=>C.fuehreW1bAdminAus('profil_schalter_status',x.args));
  check(!ks.antwort&&rs.success===true&&Array.isArray(rs.schalter)&&rs.project===B,'C Status in B lesbar',rs);}

 // D Projekt mit vorhandenem Koordinator + build_einstellungen
 {const {r}=await setzen(K.token,C2);
  check(r.success===true&&(await zeile(C2))?.gesetzt_von===K.identity_id,'D Schalter in C (vorhandener Koordinator) gesetzt',r);
  const build=(extra)=>aufruf('code_check',{action:'build_einstellungen',project:B,modus:'setzen',grund:'Test T277 Build-Tor in B',...extra,token:K.token},
   x=>BP.fuehreBuildActionAus('build_einstellungen',x.args,typeof x.args.agent_id==='string'?x.args.agent_id:null));
  const {k:kb,r:rb}=await build({aktiv:false});
  const bz=(await pool.query("SELECT werte,gesetzt_von,grund FROM build_pruefung_einstellungen WHERE bereich=$1",['projekt:'+B])).rows[0];
  check(!kb.antwort&&rb.success===true&&bz?.werte?.aktiv===false&&String(bz.grund).includes('code_check.build_einstellungen'),'D build_einstellungen setzen: Projektwert in B mit Vermerk',{a:kb.antwort,rb,bz});
  const {k:kx}=await build({speicher_mb:1024});
  const pc=(await pool.query("SELECT 1 FROM build_pruefung_einstellungen WHERE bereich='pruefcontainer'")).rows[0];
  check(kx.antwort?.error==='nur_projektwerte'&&!pc,'D Pruefcontainer-Budget abgewiesen',kx.antwort);
  const {k:kg}=await build({zuruecksetzen:'global'});
  check(kg.antwort?.error==='nur_projektwerte','D zuruecksetzen global abgewiesen',kg.antwort);}

 // E Ausweise
 {const vorbereiten=(project,extra)=>aufruf('admin',{action:'agent_vorbereiten',project,grund:'Test T277 Koordinator-Ausweis ausstellen',
   user_auftrag:'User 06.11.: Koordinator-Ausweis fuer das Projekt',...extra,token:K.token},x=>C.fuehreW1bAdminAus('agent_vorbereiten',x.args));
  const {k,r}=await vorbereiten(B,{agent_name:'koordinator-b',rolle:'koordinator'});
  check(!k.antwort&&r.success===true&&r.rolle==='koordinator'&&r.project===B&&typeof r.token==='string','E Koordinator-Ausweis in B ausgestellt',mask(JSON.stringify(r)));
  const i=(await pool.query("SELECT project,rolle,erstellt_von FROM agent_identitaeten WHERE id=$1",[r.identity_id])).rows[0];
  check(i?.project===B&&i.rolle==='koordinator'&&i.erstellt_von===K.identity_id,'E Identitaet in B, Rolle koordinator, erstellt_von = fremder Koordinator',i);
  const au=(await pool.query("SELECT wer,grund FROM agent_identitaet_audit WHERE identity_id=$1 ORDER BY id",[r.identity_id])).rows;
  check(au.some(z=>z.wer===K.identity_id&&String(z.grund).includes('koordinator_projektverwaltung')),'E Audit von B nennt wer + Herkunft',au);
  const {r:rs}=await vorbereiten(B,{agent_name:'t277-sub'});
  check(rs.success===true&&rs.rolle==='subagent','E Spezialist/Subagent in B ebenfalls',mask(JSON.stringify(rs)));
  const {r:rc}=await vorbereiten(C2,{ziel_identity_id:KC.identity_id});
  check(rc.success===true&&rc.identity_id===KC.identity_id&&rc.token===KC.token,'E vorhandene Koordinator-Identitaet in C neu vorbereitet (gleicher gueltiger Ausweis)',mask(JSON.stringify(rc)));
  const {k:ka,r:ra}=await aufruf('admin',{action:'token_abrufen',project:C2,ziel_identity_id:KC.identity_id,anlass:'Test T277 Abruf',token:K.token},x=>C.fuehreW1bAdminAus('token_abrufen',x.args));
  check(!ka.antwort&&ra.success===true&&ra.token===KC.token,'E token_abrufen fuer den Koordinator von C',mask(JSON.stringify(ra)));}

 // F Abweisungen
 {const {k}=await setzen(K.token,B,{ebene:'global'});
  check(k.antwort?.error==='nur_projektebene'&&!(await zeile(null)),'F ebene global abgewiesen, keine globale Zeile',k.antwort);
  const {k:k2}=await setzen(K.token,B,{user_auftrag:undefined});
  check(k2.antwort?.error==='user_auftrag_fehlt','F ohne user_auftrag',k2.antwort);
  const {k:k3}=await setzen(K.token,B,{grund:'zu kurz'});
  check(k3.antwort?.error==='grund_fehlt','F grund unter 10 Zeichen',k3.antwort);
  const {k:k4,r:r4}=await setzen(KH.token,H);
  check(k4.antwort?.success===false&&!weg(r4)&&!(await zeile(H)),'F Projekt synapse ausgenommen (Koordinator eines anderen Projekts)',k4.antwort);
  const {k:k5}=await setzen(SP.token,B,{grund:'Test T277 Spezialist versucht es'});
  check(k5.antwort?.success===false&&(await zeile(B))?.gesetzt_von===K.identity_id,'F Nicht-Koordinator abgewiesen',k5.antwort);
  const {k:k6}=await aufruf('thought',{action:'add',project:B,content:'T277 sollte nicht',token:K.token});
  check(k6.antwort?.success===false,'F thought add (ausserhalb der Positivliste) bleibt abgewiesen',k6.antwort);
  const {k:k7}=await aufruf('admin',{action:'identitaet_deaktivieren',project:B,ziel_identity_id:SP.identity_id,grund:'Test T277 ausserhalb',token:K.token});
  check(k7.antwort?.success===false,'F admin identitaet_deaktivieren (ausserhalb der Positivliste) abgewiesen',k7.antwort);
  const KA={art:'identitaet',principal:{art:'identity',identity_id:K.identity_id,project:H,rolle:'koordinator',agent_id:'koordinator'}};
  let f=null;try{await V.pruefeProfilVerwalter(KA,B);}catch(e){f=e.code;}
  check(f==='recht_fehlt','F pruefeProfilVerwalter ohne Kontext-Flag -> recht_fehlt',f);
  check(await V.koordinatorVerwaltetProjekt(KA,B)===null,'F koordinatorVerwaltetProjekt ohne Flag -> null');
  let g=null;try{await C.setzeProfilProduktSchalter({ebene:'projekt',project:B,funktion:'verbrauch',aktiv:false,grund:'Test T277 direkt'},{identity_id:K.identity_id,aufruf_project:B});}catch(e){g=e.code??e.message;}
  check(g==='recht_fehlt'&&(await zeile(B))?.aktiv===true,'F setzeProfilProduktSchalter ohne Kontext-Flag -> recht_fehlt',g);}

 // G AUS wieder = Bestand
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'koordinator_projektverwaltung',aktiv:false,grund:'Test T277 AUS'},{system:'user'});
 {const {k,r}=await setzen(K.token,B,{aktiv:false});
  check(k.antwort?.success===false&&!weg(r)&&(await zeile(B))?.aktiv===true,'G AUS danach: wieder abgewiesen, nichts geaendert',k.antwort);}
 console.log('P22-T277 Koordinator-Projektverwaltung: '+checks+' Pruefungen, '+failures.length+' Fehler');
 if(failures.length)process.exitCode=1;
}catch(error){console.error(mask(error.stack));process.exitCode=1;}
finally{
 if(core)await core.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(process.exitCode||0);
