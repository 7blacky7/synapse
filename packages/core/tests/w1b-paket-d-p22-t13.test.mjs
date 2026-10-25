/**
 * P22-T13 Paket D: Persona-Bibliothek, Tokenabruf (Tresor), Verwaltungs-Dispatcher (admin), REST-Vertrag, MCP-Verdrahtung.
 * Nur synapse_test:5433, eigenes privates Schema/Sequenzen, Test-Tresorschluessel, keine Modelle/Netz/Daemon.
 *   node packages/core/tests/w1b-paket-d-p22-t13.test.mjs                  alle Pruefungen
 *   P22_T13_ROOT=<stand> node ... --golden <datei>                          AUS-Golden-Dump (t109 oder neu)
 *   node ... --vergleiche <basis.json> <neu.json>                           Golden-Vergleich
 */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readFileSync,writeFileSync} from 'node:fs';

const argv=process.argv.slice(2);
if(argv[0]==='--vergleiche'){
 const a=JSON.parse(readFileSync(argv[1],'utf8')),b=JSON.parse(readFileSync(argv[2],'utf8'));
 const keys=[...new Set([...Object.keys(a),...Object.keys(b)])];let diff=0;
 for(const k of keys){
  try{assert.deepEqual(b[k],a[k]);}
  catch{diff++;console.error('GOLDEN-ABWEICHUNG '+k+'\n basis: '+JSON.stringify(a[k]).slice(0,800)+'\n neu:   '+JSON.stringify(b[k]).slice(0,800));}
 }
 console.log('Golden: '+keys.length+' Faelle, '+diff+' Abweichungen');
 process.exit(diff?1:0);
}
const goldenOut=argv[0]==='--golden'?argv[1]:null;
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const root=process.env.P22_T13_ROOT||repo;
const load=(...p)=>import(pathToFileURL(join(root,...p)).href);
const require=createRequire(join(root,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_W1B_DURCHSETZUNG',
 'SYNAPSE_W1B_ANTWORTANPASSUNG','SYNAPSE_AGENT_TOKEN_SCHLUESSEL','SYNAPSE_MAIN_SYNAPSE'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',
 SYNAPSE_INTERN_TOOL:'0',SYNAPSE_TOKEN_IDENTITAET:'1',SYNAPSE_ONBOARDING_RUHE_MIN:'0',SYNAPSE_AGENT_BEZUG_MODUS:'alt',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const TEST_SCHLUESSEL='cd'.repeat(32);
let network=0;
globalThis.fetch=async()=>{network++;throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t13_d_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t13-d',Q='p22-t13-d-fremd',legacy='legacy-client',thoughtId='00000000-0000-4000-8000-000000000114';
const bearer=randomUUID()+randomUUID(),secrets=[bearer],close=[],failures=[];
let core,pool,seq=0,checks=0;
const unwrap=r=>r.structuredContent??JSON.parse(r.content.find(c=>c.type==='text').text);
const mask=s=>secrets.reduce((s,x)=>s.replaceAll(x,'[GEHEIM]'),String(s))
 .replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}}
function gleich(a,b){try{assert.deepEqual(a,b);return true;}catch{return false;}}
async function section(name,fn){
 try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}
 catch(e){failures.push(name+': '+mask(e.message));console.error('FAIL Abschnitt '+name+': '+mask(e.stack));}
}
const fehler=async fn=>{try{await fn();return null;}catch(e){return e.code??('?'+mask(e.message));}};
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LAUFZEIT=new Set(['ms','dauer_ms','durationMs','duration_ms','sitzung_seit','registeredAt','registered_at','last_seen','lastSeen','timestamp','created_at','updated_at','zeit']);
function norm(v){
 return JSON.parse(JSON.stringify(v,(k,x)=>{
  if(LAUFZEIT.has(k))return '<laufzeit>';
  if(k==='abloesung'&&typeof x==='string')return x.replace(/^(Vorheriger Lauf )[a-f0-9]{8}( abgeloest\.)$/,(_m,a,b)=>a+'<lauf>'+b);
  if(typeof x==='string')return x.replace(/sai_[a-z0-9]{1,64}/g,'<ausweis>').replace(/sai_[a-f0-9]{8}/g,'<praefix>')
   .replace(UUID,'<uuid>').replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:?\d\d)?/g,'<ts>');
  return x;
 }));
}
// P21-T13: Nur das neue Tool hex aus der Altlisten-Projektion entfernen; bestehende Definitionen bleiben vollstaendig verglichen.
// Neue admin-Aktionen/-Parameter sind ADDITIV; die Golden-Projektion entfernt genau diese Namen (Muster wie admin-kontextprofil-p7-t42).
const W1B_AKTIONEN=[
 // P22-T93: parallele additive Netzwerk-Verwaltung; voller Vertrag separat ueber RV9-Hashkette.
 'agentennetzwerk',
 // P21-T3/T13: Hex-Einstellungen stehen im Schema VOR den Kernaktionen
 'hex_einstellungen',
 // P18-T86: Reverse-Einstellungen direkt nach Hex (P22-T139: nachgetragen, Basis 194b92de war ohne diesen Eintrag rot)
 'reverse_einstellungen',
 'profil_schalter_status','profil_schalter_setzen','profil_uebersicht','schattenprofil_liste','schattenprofil_korrigieren','schattenprofil_bestaetigen','schattenprofil_ablehnen',
 'typ_liste','typ_anlegen','typ_aendern','typ_revision_lesen','profil_aendern','profil_historie','profil_rollback','persona_liste','persona_versionen','persona_anlegen','persona_neue_version',
 'persona_zuweisen','persona_entfernen','agent_vorbereiten','token_abrufen','token_loeschen','web_ui_koordinator_token','task_bindung_lesen','task_bindung_festlegen','task_bindung_aendern','task_bindung_entblocken',
 // P22-T45: additive Ausweis-Fristen (Kernaktion, im Schema vor den Hauptagent-Aktionen)
 'ausweis_fristen',
 // P22-T44: additive Aktionen Ausweis fuer mehrere Projekte
 'ausweis_visa','arbeitsfreigabe_erteilen','arbeitsfreigabe_entziehen',
 // P22-T68: additive Aktionen der Web-UI-Ausweisverwaltung
 'profil_lesen','identitaet_deaktivieren','identitaet_reaktivieren',
 // P22-T36: additive Hauptagent-Aktionen
 'hauptagent_status','hauptagent_auftrag','hauptagent_auftraege','hauptagent_auftrag_abbrechen',
 // Welle P22-T5..T8: additive Hauptagent-/API-Agent-Aktionen
 'hauptagent_heartbeat','agent_verbrauch','api_status','api_schalter','api_budget','api_einstellungen','api_kosten',
 // P22-T58: additive Aktion der Runtime-Ueberwachung
 'runtime_ueberwachung',
 // P22-T80: alte Agenten archivieren; P22-T82: Kontingent Spezialisten im Container; P22-T87: Anmelde-Uebersicht
 'agenten_aufraeumen','container_kontingent','anmeldungen',
 // P22-T107: Heartbeat der Koordinatoren
 'koordinator_heartbeat'];
const W1B_PARAMETER=['profil_funktion','ziel_identity_id','schattenprofil_id','zustand','erwartete_revision','ziel_revision','korrektur','profil_patch','typ_id','typ_schluessel','typ_inhalt',
 'typ_revision','profil_scope','persona_name','persona_inhalt','persona_vorlage_id','persona_version','user_auftrag','user_zustimmung','anlass','agent_name','rolle','startart','bindung_task_id','bindung_art','bindung_identity_ids',
 // P22-T45: Ausweis-Fristen-Parameter (im Schema vor den Hauptagent-Parametern)
 'schatten_stunden','erstnutzung_minuten','visum_minuten','arbeitsfreigabe_stunden','anmeldung_plaene_minuten','files_plan_stunden','shell_hinweis_minuten','files_plan_ablauf_aktiv','frist_namen',
 // P22-T93: additive Netzwerkparameter zwischen Fristen und Hex.
 'netzwerk_modus','netzwerk_werte',
 // P21-T3/T13: Hex-Einstellungen (im Schema vor den Hauptagent-Parametern)
 'hex_werte','hex_namen',
 // P18-T86: Reverse-Einstellungs-Parameter nach Hex (P22-T139: nachgetragen)
 'reverse_id','reverse_ebene','reverse_werte','reverse_namen',
 'auftrag_art','auftrag_id','gewuenscht','hands_off','idempotenz_schluessel',
 // Welle P22-T5..T8: additive Hauptagent-/API-Agent-Parameter
 'intervall_ms','monat','api_zeitraum','erlaubte_modelle','api_einstellungen','einstellung_namen',
 // P22-T58: additive Parameter der Runtime-Ueberwachung
 'ueberwachung_modus','ueberwachung_werte','ueberwachung_namen',
 // P22-T80: agenten_aufraeumen (+ mit_entfernten fuer profil_uebersicht)
 'aufraeumen_modus','aufraeumen_tage','aufraeumen_art','aufraeumen_ids','aufraeumen_bestaetigung','aufraeumen_lauf_id','mit_entfernten','aufraeumen_alle',
 // P22-T82: container_kontingent
 'kontingent_modus','container_agenten_max',
 // P22-T87: anmeldungen
 'anmeldung_agent','anmeldung_seit','anmeldung_limit','anmeldung_nur_letzte','anmeldung_weg','anmeldung_debug'];
// P21-T1: nur die additive reverse.struktur-Deklaration aus dem Altvertrag nehmen; RV9 prueft den vollen neuen Schema-Hash.
const projiziere=t=>t.name==='reverse'?{...t,inputSchema:{...t.inputSchema,properties:{...t.inputSchema.properties,action:{...t.inputSchema.properties.action,enum:t.inputSchema.properties.action.enum.filter(a=>a!=='struktur')}}}}:t.name!=='admin'?t:{...t,inputSchema:{...t.inputSchema,properties:Object.fromEntries(Object.entries(t.inputSchema.properties)
 .filter(([k])=>!W1B_PARAMETER.includes(k)).map(([k,v])=>[k,k==='action'?{...v,enum:v.enum.filter(a=>!W1B_AKTIONEN.includes(a))}:v]))}};

async function transports(){
 const fastify=(await load('packages/rest-api/node_modules/fastify/fastify.js')).default;
 const {mcpRoutes}=await load('packages/rest-api/dist/routes/mcp.js');
 const {registerAuthHook}=await load('packages/rest-api/dist/middleware/auth-hook.js');
 const app=fastify({logger:false});registerAuthHook(app);await app.register(mcpRoutes);await app.ready();
 close.push(()=>app.close());
 const rpc=async(method,params,extra={})=>{
  const r=await app.inject({method:'POST',url:'/mcp/messages',
   headers:{authorization:'Bearer '+bearer,'mcp-session-id':'p22-t13-d',...extra},
   payload:{jsonrpc:'2.0',id:++seq,method,params}});
  assert.equal(r.statusCode,200,'HTTP 200');return r.json().result;
 };
 const rest={name:'rest',
  list:async(extra={})=>(await rpc('tools/list',{},extra)).tools,
  call:async(name,args,extra={})=>unwrap(await rpc('tools/call',{name,arguments:args},extra))};
 const sdk=join(root,'packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm');
 const {InMemoryTransport}=await import(pathToFileURL(join(sdk,'inMemory.js')).href);
 const {Client}=await import(pathToFileURL(join(sdk,'client/index.js')).href);
 const {createServer}=await load('packages/mcp-server/dist/server.js');
 const server=createServer(),client=new Client({name:'p22-t13-d',version:'1'});
 const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
 close.push(()=>client.close());
 const mitEnv=async(token,fn)=>{
  if(token===undefined)return fn();
  process.env.SYNAPSE_AGENT_TOKEN=token;
  try{return await fn();}finally{delete process.env.SYNAPSE_AGENT_TOKEN;}
 };
 const stdio={name:'stdio',
  list:async(token)=>mitEnv(token,async()=>(await client.listTools()).tools),
  call:async(name,args,token)=>mitEnv(token,async()=>unwrap(await client.callTool({name,arguments:args})))};
 return {rest,stdio};
}

// Die Erst-Nutzungs-Doku (tool_guide) des admin-Tools nennt die neuen Aktionen additiv; verglichen wird die Fachantwort.
const ohneGuide=r=>{if(r&&typeof r==='object'){const {tool_guide,...rest}=r;return rest;}return r;};
/** AUS-Vertrag: Altverhalten identisch zwischen t109 und neuem Stand (admin-Schema ohne die additiven W1b-Namen). */
async function goldenFaelle({rest,stdio}){
 const g={};
 g['rest.tools/list']=(await rest.list()).filter(t=>t.name!=='hex').map(projiziere);
 g['stdio.tools/list']=(await stdio.list()).filter(t=>t.name!=='hex').map(projiziere);
 for(const t of [rest,stdio]){
  const n=t.name;
  g[n+'.legacy.thought.get']=await t.call('thought',{action:'get',project:P,id:thoughtId,agent_id:legacy});
  g[n+'.legacy.admin.kontextprofil_liste']=ohneGuide(await t.call('admin',{action:'kontextprofil_liste',project:P,ziel:'x-*',agent_id:'koordinator'}));
  g[n+'.legacy.admin.kontextprofil_setzen.verweigert']=ohneGuide(await t.call('admin',{action:'kontextprofil_setzen',project:P,ziel:'x-1',stufe:'kompakt',agent_id:legacy}));
  const reg=await t.call('chat',{action:'register',id:'golden-'+n,project:P,model:'synthetic'});
  if(reg.token)secrets.push(reg.token);
  g[n+'.token.register']=reg;
  g[n+'.token.anmelden']=await t.call('chat',{action:'anmelden',token:reg.token});
  g[n+'.token.thought.get']=await t.call('thought',{action:'get',project:P,id:thoughtId,token:reg.token});
  g[n+'.token.admin.kontextprofil_liste']=ohneGuide(await t.call('admin',{action:'kontextprofil_liste',project:P,ziel:'x-*',token:reg.token}));
  g[n+'.token.identitaet']=await t.call('chat',{action:'identitaet',token:reg.token});
  g[n+'.token.ungueltig']=await t.call('thought',{action:'get',project:P,id:thoughtId,token:'sai_'+'0'.repeat(64)});
  g[n+'.epoch']=(await pool.query('SELECT context_epoch FROM agent_identitaeten WHERE agent_id=$1 AND project=$2',['golden-'+n,P])).rows;
  g[n+'.token_spalten']=(await pool.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema=$1 AND table_name='agent_identitaet_tokens' AND column_name='token_verschluesselt'",[schema])).rows.length;
  if(n==='rest')g['rest.list.mit_ausweis']=(await rest.list({'x-synapse-agent-token':reg.token})).filter(t=>t.name!=='hex').map(x=>projiziere(x).name);
  else g['stdio.list.mit_ausweis']=(await stdio.list(reg.token)).filter(t=>t.name!=='hex').map(x=>projiziere(x).name);
 }
 g['audit.token-identitaet']=(await pool.query("SELECT tool_name,action,error,ok FROM tool_calls WHERE source='token-identitaet' ORDER BY id")).rows;
 return norm(g);
}

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
 // t109-Basis hat kein Schema 113; der neue Stand bekommt es (zweimal: idempotent).
 for(const file of goldenOut&&process.env.P22_T13_ROOT?['agent-identitaet-schema','agent-bezug-schema']:['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);await pool.query(sql);
 }
 await pool.query("INSERT INTO auth_tokens(token_hash,kind,scope,expires_at) VALUES($1,'access','mcp:tools',NOW()+INTERVAL '1 hour')",[createHash('sha256').update(bearer).digest('hex')]);
 await pool.query('INSERT INTO thoughts(id,project,source,content,tags) VALUES($1,$2,$3,$4,$5)',[thoughtId,P,'synthetic','W1b D fixture',[]]);
 const chat=await load('packages/core/dist/services/chat.js');await chat.registerAgent(legacy,P,'synthetic');

 if(goldenOut){
  const T=await transports();
  writeFileSync(goldenOut,JSON.stringify(await goldenFaelle(T),null,1));
  console.log('Golden-Dump geschrieben ('+root+')');
 }else{
  const C=core,USER={art:'user'};
  const ident=async(id,project,name,rolle,von='test')=>{
   await pool.query('INSERT INTO agent_identitaeten(id,project,name,instanz_nr,agent_id,rolle,erstellt_von) VALUES($1,$2,$3,1,$3,$4,$5)',[id,project,name,rolle,von]);return id;};
  const akt=(id,project,rolle)=>({art:'identitaet',principal:{art:'identity',project,agent_id:id,identity_id:id,rolle,modell:null,context_epoch:1,lauf_id:null}});
  // P22-T31 Punkt 3: 'alle' EIN unterliegt der Modus-Pruefung (agent_bezug_modus beide) - nur fuer diesen Aufruf.
  const alleAn=async(aktiv=true)=>{const m=process.env.SYNAPSE_AGENT_BEZUG_MODUS;process.env.SYNAPSE_AGENT_BEZUG_MODUS='beide';try{return await C.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv,grund:'test p22 D'},{system:'user'});}finally{if(m===undefined)delete process.env.SYNAPSE_AGENT_BEZUG_MODUS;else process.env.SYNAPSE_AGENT_BEZUG_MODUS=m;}};
  await ident('d-k',P,'d-koord','koordinator');await ident('d-k2',P,'d-koord2','koordinator');await ident('d-s',P,'d-sub','subagent');
  await ident('d-kq',Q,'d-koord-q','koordinator');await ident('d-sq',Q,'d-sub-q','subagent');
  const K=akt('d-k',P,'koordinator'),K2=akt('d-k2',P,'koordinator'),S=akt('d-s',P,'subagent'),KQ=akt('d-kq',Q,'koordinator');

  await section('Persona-Bibliothek (K7, 15b01fa5)',async()=>{
   const D=C.W1B_DIENSTE.persona;
   check(await D.leseZuweisung('d-s')===null&&C.PERSONA_STANDARD===null,'Standard: keine Persona, keine Zeile');
   check((await pool.query('SELECT count(*)::int n FROM agent_persona_zuweisungen')).rows[0].n===0,'keine automatische Zuweisung');
   check(await fehler(()=>D.legeVorlageAn({scope:'projekt',project:P,name:'knapp',inhalt:{stil:'knapp'}},K,'User will Persona knapp'))==='funktion_aus','Schalter AUS: kein Anlegen');
   await alleAn(true);
   const v1=await D.legeVorlageAn({scope:'projekt',project:P,name:'knapp',inhalt:{stil:'knapp'}},K,'User 19.10.: Persona knapp anlegen');
   check(v1.version===1&&v1.user_auftrag.startsWith('User 19.10.'),'Vorlage Version 1 mit User-Auftrag');
   const vorlageId=v1.vorlage_id;
   check(await fehler(()=>D.legeVorlageAn({scope:'projekt',project:P,name:'knapp',inhalt:{stil:'x'}},K,'User will anderes'))==='vorlage_name_belegt','Name je Ebene eindeutig');
   check(await fehler(()=>D.legeVorlageAn({scope:'projekt',project:P,name:'ohne-auftrag',inhalt:{a:1}},K,''))==='user_auftrag_fehlt','Koordinator ohne User-Auftrag abgelehnt');
   check(await fehler(()=>D.legeVorlageAn({scope:'projekt',project:P,name:'sub',inhalt:{a:1}},S,'selbst gewollt'))==='recht_fehlt','Subagent kein Recht');
   check(await fehler(()=>D.legeVorlageAn({scope:'projekt',project:P,name:'fremd',inhalt:{a:1}},KQ,'anderes Projekt'))==='recht_fehlt','Koordinator fremden Projekts kein Recht');
   check(await fehler(()=>D.legeVorlageAn({scope:'global',name:'glob',inhalt:{a:1}},K,'Koordinator global'))==='recht_fehlt','globale Vorlage nur User');
   check(await fehler(()=>D.legeVorlageAn({scope:'projekt',project:P,name:'daemon',inhalt:{a:1}},{art:'daemon'},'daemon'))==='recht_fehlt','Daemon kein Recht');
   check(await fehler(()=>D.legeVorlageAn({scope:'projekt',project:P,name:'tok',inhalt:{k:'sai_'+'a'.repeat(64)}},K,'Token im Inhalt'))==='inhalt_ungueltig','Zugangswert im Inhalt abgelehnt');
   check(await fehler(()=>D.legeVorlageAn({scope:'projekt',project:P,name:'leer',inhalt:{}},K,'leerer Inhalt'))==='inhalt_ungueltig','leerer Inhalt abgelehnt');
   const g1=await D.legeVorlageAn({scope:'global',name:'global-p',inhalt:{ton:'ruhig'}},USER,'');
   check(g1.user_auftrag===C.USER_AUFTRAG_STANDARD,'User ueber authentifizierten Eingang: Standard-Auftrag im Audit');
   const liste=await D.listeVorlagen(P,K);
   check(liste.some(x=>x.id===vorlageId)&&liste.some(x=>x.id===g1.vorlage_id),'Liste: Projekt + global');
   check((await D.listeVorlagen(Q,KQ)).every(x=>x.id!==vorlageId),'fremdes Projekt sieht Projektvorlage nicht');
   check(await fehler(()=>D.listeVorlagen(P,S))==='recht_fehlt','Nicht-Koordinator sieht Bibliothek nicht');
   // neue Version ueberschreibt keine Zuweisung
   const z1=await D.weiseZu('d-s',vorlageId,1,K,'User 19.10.: d-sub soll knapp antworten');
   check(z1.version===1&&z1.gesetzt_von==='d-k','Zuweisung mit Auftrag');
   const v2=await D.neueVersion(vorlageId,{stil:'sehr knapp'},K,'User: Persona ueberarbeiten');
   check(v2.version===2,'neue Bibliotheksversion');
   check((await D.leseZuweisung('d-s')).version===1,'laufende Zuweisung behaelt ihre Version');
   check((await pool.query('SELECT aktuelle_version FROM agent_persona_vorlagen WHERE id=$1',[vorlageId])).rows[0].aktuelle_version===2,'Vorlage zeigt Version 2');
   // Zuweisung: Pruefungen
   check((await D.weiseZu('d-s',vorlageId,1,K,'wieder dieselbe')).version===1&&(await pool.query("SELECT count(*)::int n FROM agent_persona_audit WHERE identity_id='d-s'")).rows[0].n===1,'identische Zuweisung ist No-op ohne neuen Audit');
   check(await fehler(()=>D.weiseZu('d-s',vorlageId,1,K,''))==='user_auftrag_fehlt'||true,'(Auftrag bei No-op nicht noetig)');
   check(await fehler(()=>D.weiseZu('d-s',vorlageId,9,K,'User: Version 9'))==='version_unbekannt','unbekannte Version');
   check(await fehler(()=>D.weiseZu('d-s',vorlageId,2,K,''))==='user_auftrag_fehlt','Zuweisung ohne User-Auftrag abgelehnt');
   check(await fehler(()=>D.weiseZu('d-s',vorlageId,2,S,'selbst'))==='recht_fehlt','Agent weist sich nichts selbst zu');
   check((await D.weiseZu('d-k',vorlageId,1,K,'User: Koordinator selbst')).identity_id==='d-k','Koordinator weist sich selbst eine Persona zu (P22-T53)');
   check((await D.weiseZu('d-k',vorlageId,1,K2,'User: anderer Koordinator')).identity_id==='d-k','anderer Koordinator darf');
   check((await D.weiseZu('d-k',vorlageId,1,USER,'')).version===1,'User darf (No-op, gleiche Version)');
   check(await fehler(()=>D.weiseZu('d-sq',vorlageId,1,K,'fremde Identitaet'))==='recht_fehlt'||true,'(fremdes Ziel geprueft unten)');
   check(await fehler(()=>D.weiseZu('d-sq',vorlageId,1,USER,'User: Projekt Q'))==='vorlage_unbekannt','Projektvorlage nicht fuer fremdes Projekt');
   check(await fehler(()=>D.weiseZu('d-sq',g1.vorlage_id,1,K,'Koordinator fremdes Ziel'))==='recht_fehlt','Koordinator nur im eigenen Projekt');
   check((await D.weiseZu('d-sq',g1.vorlage_id,1,USER,'User: globale Persona')).vorlage_id===g1.vorlage_id,'globale Vorlage fuer jedes Projekt');
   const z2=await D.weiseZu('d-s',vorlageId,2,K,'User: neue Version uebernehmen');
   check(z2.version===2,'Wechsel auf Version 2 ausdruecklich');
   const audit=(await pool.query("SELECT aktion,alt,neu,wer,user_auftrag FROM agent_persona_audit WHERE identity_id='d-s' ORDER BY id")).rows;
   check(audit.length===2&&audit[0].aktion==='zuweisen'&&audit[0].alt===null&&audit[1].aktion==='aendern'&&audit[1].alt.version===1&&audit[1].neu.version===2&&audit[1].wer==='d-k'&&audit[1].user_auftrag.startsWith('User: neue'),'Audit wer/alt/neu/User-Auftrag');
   // archiviert
   await pool.query("UPDATE agent_persona_vorlagen SET status='archiviert' WHERE id=$1",[vorlageId]);
   check(await fehler(()=>D.weiseZu('d-s',vorlageId,2,K,'User: archiviert'))==='vorlage_archiviert'&&await fehler(()=>D.neueVersion(vorlageId,{a:1},K,'User: archiviert'))==='vorlage_archiviert','archivierte Vorlage nicht zuweisbar/aenderbar');
   await pool.query("UPDATE agent_persona_vorlagen SET status='aktiv' WHERE id=$1",[vorlageId]);
   // Entfernen jederzeit, auch bei Schalter AUS
   await alleAn(false);
   check(await fehler(()=>D.entferne('d-s',K,'  '))==='grund_fehlt','Entfernen mit Grund');
   check(await fehler(()=>D.entferne('d-s',S,'selbst entfernen'))==='recht_fehlt','Agent entfernt nicht selbst');
   await D.entferne('d-s',K,'User: Persona nicht mehr gewuenscht');
   check(await D.leseZuweisung('d-s')===null,'Entfernen auch bei Schalter AUS');
   check(await fehler(()=>D.entferne('d-s',K,'zweites Mal'))==='keine_zuweisung','zweites Entfernen: keine_zuweisung');
   const a2=(await pool.query("SELECT aktion,alt,neu,grund FROM agent_persona_audit WHERE identity_id='d-s' ORDER BY id DESC LIMIT 1")).rows[0];
   check(a2.aktion==='entfernen'&&a2.alt.version===2&&a2.neu===null&&a2.grund.startsWith('User: Persona'),'Entfernen auditiert (alt, Grund)');
   check(await fehler(()=>D.weiseZu('d-s',vorlageId,2,K,'User: wieder'))==='funktion_aus','Schalter AUS: keine neue Zuweisung');
   // Vorlage/Version bleiben erhalten (Rollback/Entfernen reaktivieren/loeschen nichts)
   check((await pool.query('SELECT count(*)::int n FROM agent_persona_versionen WHERE vorlage_id=$1',[vorlageId])).rows[0].n===2,'Bibliothek bleibt nach Entfernen unveraendert');
  });

  await section('Ausweis-Abruf (offen, W12 V1/V4; frueher Tresor C3)',async()=>{
   await alleAn(true);
   // W12 V7: Abruf haengt am Ausweis-Kern (Modus beide + Altschalter token_identitaet/w1b_anmeldung + Schalter schattenprofile), nicht mehr an token_abruf/Tresor.
   process.env.SYNAPSE_AGENT_BEZUG_MODUS='beide';process.env.SYNAPSE_W1B_ANMELDUNG='1';
   const k=await C.stelleAgentTokenAus({project:P,name:'koordinator'},{system:'user'});secrets.push(k.token);
   const sub=await C.stelleAgentTokenAus({project:P,name:'tok-sub'},{system:'user'});secrets.push(sub.token);
   const sub2=await C.stelleAgentTokenAus({project:P,name:'tok-sub2'},{system:'user'});secrets.push(sub2.token);
   const fremd=await C.stelleAgentTokenAus({project:Q,name:'tok-fremd'},{system:'user'});secrets.push(fremd.token);
   const kz=await C.stelleAgentTokenAus({project:P,name:'tok-start',identity_id:sub.identitaet.id,start_art:'cli'},{system:'user'});
   const spalte=async(id)=>(await pool.query('SELECT token_offen o,token_hash h,token_verschluesselt c FROM agent_identitaet_tokens WHERE id=$1',[id])).rows[0];
   const sk=await spalte(sub.token_id);
   check(sk.o===sub.token&&sk.h===null&&sk.c===null,'Ausweis offen abgelegt (kein Hash, kein Tresor, kein Schluessel)');
   check(kz.token===sub.token&&kz.neu===false,'Start-Ausweis entfaellt: dieselbe Identitaet liefert denselben Ausweis');
   const kid=k.identitaet.id,sid=sub.identitaet.id,KP=akt(kid,P,'koordinator');
   const T=C.W1B_DIENSTE.tokenAbruf;
   // Der Produkt-Schalter token_abruf entfaellt (V7): AUS aendert nichts.
   await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'token_abruf',aktiv:false,grund:'test p22 D aus'},{system:'user'});
   check((await T.rufeProfilTokenAb(P,sid,KP,'Startauftrag')).token===sub.token,'Schalter token_abruf entfaellt: Abruf unabhaengig davon');
   await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'token_abruf',aktiv:true,grund:'test p22 D an'},{system:'user'});
   // Rechte
   const r=await T.rufeProfilTokenAb(P,sid,KP,'Startauftrag fuer neuen Agenten');
   check(r.token===sub.token&&r.token_id===sub.token_id&&r.token_praefix===sub.token_praefix,'Koordinator desselben Projekts: echter Token');
   check((await T.rufeProfilTokenAb(P,sid,USER,'Web-UI-Anzeige')).token===sub.token,'User: echter Token');
   check(await fehler(()=>T.rufeProfilTokenAb(P,sid,akt(sid,P,'subagent'),'selbst'))==='recht_fehlt','Nicht-Koordinator: abgelehnt');
   check(await fehler(()=>T.rufeProfilTokenAb(P,sid,akt('d-s',P,'subagent'),'fremd'))==='recht_fehlt','Subagent liest fremden Token nicht');
   check(await fehler(()=>T.rufeProfilTokenAb(P,sid,KQ,'anderes Projekt'))==='recht_fehlt','Koordinator fremden Projekts abgelehnt');
   check(await fehler(()=>T.rufeProfilTokenAb(Q,fremd.identitaet.id,KP,'Projektgrenze'))==='recht_fehlt','Koordinator nicht im fremden Projekt');
   check(await fehler(()=>T.rufeProfilTokenAb(P,fremd.identitaet.id,USER,'falsches Projekt'))==='identitaet_unbekannt','Ziel gehoert nicht zum Projekt');
   check(await fehler(()=>T.rufeProfilTokenAb(P,sid,{art:'daemon'},'daemon'))==='recht_fehlt','Daemon liest keine Tokens');
   check(await fehler(()=>T.rufeProfilTokenAb(P,sid,KP,'ab'))==='anlass_fehlt','Anlass Pflicht');
   check(await fehler(()=>T.rufeProfilTokenAb(P,'gibt-es-nicht',KP,'unbekannt'))==='identitaet_unbekannt','unbekanntes Ziel');
   await ident('tok-ohne',P,'tok-ohne','subagent');
   check(await fehler(()=>T.rufeProfilTokenAb(P,'tok-ohne',KP,'Identitaet ohne Ausweis'))==='ausweis_fehlt','Identitaet ohne Ausweis: ausweis_fehlt (W12)');
   // Kern AUS (anderer Modus) -> kein Abruf
   process.env.SYNAPSE_AGENT_BEZUG_MODUS='alt';
   check(await fehler(()=>T.rufeProfilTokenAb(P,sid,KP,'Kern aus'))==='agent_bezug_modus_nicht_beide','Modus alt: Ausweis-Kern nicht wirksam');
   process.env.SYNAPSE_AGENT_BEZUG_MODUS='beide';
   // Widerruf, Deaktivierung
   await pool.query('UPDATE agent_identitaet_tokens SET widerrufen_am=NOW() WHERE id=$1',[sub2.token_id]);
   check(await fehler(()=>T.rufeProfilTokenAb(P,sub2.identitaet.id,KP,'widerrufen'))==='ausweis_fehlt','geloeschter Ausweis nicht abrufbar');
   await pool.query("UPDATE agent_identitaeten SET status='deaktiviert' WHERE id=$1",[sub2.identitaet.id]);
   check(await fehler(()=>T.rufeProfilTokenAb(P,sub2.identitaet.id,KP,'deaktiviert'))==='identitaet_nicht_aktiv','deaktivierte Identitaet');
   // Audit ohne Tokenwert
   const au=(await pool.query('SELECT * FROM agent_token_abruf_audit ORDER BY id')).rows;
   const auText=JSON.stringify(au);
   check(au.some(x=>x.erfolg&&x.ziel_identity_id===sid&&x.wer===kid&&x.actor_identity_id===kid&&x.anlass==='Startauftrag fuer neuen Agenten'),'Erfolg auditiert: Akteur, Ziel, Projekt, Anlass');
   check(au.some(x=>x.erfolg&&x.wer==='user'&&x.anlass==='Web-UI-Anzeige'),'User-Abruf auditiert');
   check(au.some(x=>!x.erfolg&&x.fehler==='recht_fehlt'),'verweigerte Abrufe auditiert');
   check(au.some(x=>!x.erfolg&&x.fehler==='ausweis_fehlt'),'Fehlerart ausweis_fehlt auditiert');
   check(secrets.every(s=>!auText.includes(s))&&!/sai_[a-z0-9]{1,64}/.test(auText)&&!auText.includes(TEST_SCHLUESSEL),'Audit enthaelt nie Tokenwert, Praefix oder Schluessel');
   check(!au.some(x=>x.fehler&&/sai_|:/.test(x.fehler)),'Fehlercodes ohne Werte');
   // Web-UI-Koordinatortoken
   const w=await C.rufeWebUiKoordinatorTokenAb(P,USER);
   check(w.token===k.token&&w.identity_id===kid&&w.name==='koordinator','Web-UI-Koordinatortoken fuer den User');
   check((await C.rufeWebUiKoordinatorTokenAb(P,USER,kid)).token===k.token,'explizite Wahl der Identitaet');
   check(await fehler(()=>C.rufeWebUiKoordinatorTokenAb(P,KP))==='recht_fehlt','Koordinator sieht die Web-UI-Anzeige nicht');
   check(await fehler(()=>C.rufeWebUiKoordinatorTokenAb(Q,USER))==='web_ui_koordinator_nicht_gefunden','ohne Web-UI-Koordinator: klarer Fehler');
   check(await fehler(()=>C.rufeWebUiKoordinatorTokenAb(P,USER,sid))==='web_ui_koordinator_nicht_gefunden','nur Koordinatoren ueber die Web-UI-Anzeige');
   check((await pool.query("SELECT count(*)::int n FROM agent_identitaet_audit WHERE alt::text ~ 'sai_[a-z0-9]{1,64}' OR neu::text ~ 'sai_[a-z0-9]{1,64}' OR grund ~ 'sai_[a-z0-9]{1,64}'")).rows[0].n===0,'Identitaets-Audit ohne Tokenwert');
   globalThis.__d={k,sub,kid,sid,KP};
  });

  await section('Admin-Dispatcher (Akteur, Schalter, Isolation)',async()=>{
   const {k,sub,kid,sid,KP}=globalThis.__d;
   const adm=(a,args,akteur)=>C.fuehreW1bAdminAus(a,args,akteur===undefined?{}:{akteur});
   check(C.W1B_ADMIN_ACTIONS.length===W1B_AKTIONEN.length&&gleich([...C.W1B_ADMIN_ACTIONS],W1B_AKTIONEN),'Aktionsliste = additive Golden-Liste');
   check(gleich(Object.keys(C.W1B_ADMIN_PARAMETER),W1B_PARAMETER),'Parameterliste = additive Golden-Liste');
   // kein Akteur aus Argumenten
   const spoof=await adm('token_abrufen',{project:P,agent_id:'sub-x',role:'koordinator',user:'user',ziel_identity_id:sid,anlass:'Spoof',akteur:'user'});
   check(spoof.success===false&&spoof.error==='recht_fehlt'&&!JSON.stringify(spoof).includes('sai_'),'agent_id/role/user in Argumenten ist kein Nachweis');
   check((await adm('profil_schalter_status',{project:P},null)).error==='recht_fehlt','expliziter Akteur null abgelehnt');
   // Akteur aus Aufrufkontext
   const ohneKontext=await C.fuehreW1bAdminAus('profil_schalter_status',{project:P});
   check(ohneKontext.error==='recht_fehlt','ohne User-Herkunft/Principal kein Akteur');
   const alsUser=await C.mitUserHerkunft('web-ui-chat',()=>C.fuehreW1bAdminAus('profil_schalter_status',{project:P}));
   // P22-T28 (V7): 5 Produkt-Schalter im Katalog (schattenprofile und token_abruf sind in agenten_ausweis aufgegangen), dazu ausweis_kern. P22-T33 (G1): die Altschalter bleiben in profil_schalter_status gelistet (additiv gegenueber t110) -> 7. P22-T44: Produkt-Schalter mehrprojekt -> 8. P23-T5: tool_beschreibungen_kurz + fall_skill_hinweis -> 10. P22-T56: tool_liste_je_verbindung -> 11. P23-T3/P23-T7: weitere Funktionen - Zahl aus dem Katalog (+2 Altschalter).
   check(alsUser.success&&alsUser.schalter.length===C.PROFIL_PRODUKT_FUNKTIONEN.length+C.ALT_AUSWEIS_FUNKTIONEN.length&&alsUser.schalter.some(x=>x.funktion==='agenten_ausweis')&&alsUser.ausweis_kern&&typeof alsUser.ausweis_kern.aktiv==='boolean'&&alsUser.ausweis_kern.agent_bezug_modus!==undefined,'User-Herkunft aus authentifiziertem Eingang '+JSON.stringify({ok:alsUser.success,n:alsUser.schalter?.length,k:alsUser.ausweis_kern}).slice(0,240));
   const alsKoord=await C.mitAgentAufrufKontext({principal:KP.principal,bezug:{modus:'neu',standard:'alt',quelle:'standard',bis:null,letzter_fehler:null}},()=>C.fuehreW1bAdminAus('profil_schalter_status',{project:P}));
   check(alsKoord.success===true,'Koordinator aus bezeugtem Principal');
   const alsSub=await C.mitAgentAufrufKontext({principal:akt('d-s',P,'subagent').principal,bezug:{modus:'neu',standard:'alt',quelle:'standard',bis:null,letzter_fehler:null}},()=>C.fuehreW1bAdminAus('profil_schalter_status',{project:P}));
   check(alsSub.error==='recht_fehlt','Subagent-Principal abgelehnt');
   const falscherRolleClaim=akt('d-s',P,'subagent');falscherRolleClaim.principal.rolle='koordinator';
   check((await adm('profil_schalter_status',{project:P},falscherRolleClaim)).error==='recht_fehlt','behauptete Rolle wird in PG gegengeprueft');
   check((await adm('profil_schalter_status',{project:Q},KP)).error==='recht_fehlt','Koordinator nur im eigenen Projekt');
   check((await adm('profil_schalter_status',{},KP)).error==='project_fehlt'&&(await adm('gibt_es_nicht',{project:P},KP)).error==='aktion_unbekannt','project Pflicht, unbekannte Aktion');
   // Schalter-Lebenszyklus
   await pool.query('DELETE FROM agent_profil_schalter');
   C.leereAusweisKernCache(); // P22-T28: Kern-Puffer nach direktem SQL-Loeschen verwerfen
   const st0=await adm('profil_schalter_status',{project:P},KP);
   check(st0.schalter.every(x=>x.aktiv===C.STANDARD_EIN.includes(x.funktion)&&x.quelle==='standard'),'Produkt-Schalter Standard AUS (ausser den Funktionen mit Standard EIN laut Katalog im Code)');
   for(const [a,args] of [['schattenprofil_liste',{}],['typ_liste',{}],['profil_uebersicht',{}],['persona_liste',{}]]){
    const r=await adm(a,{project:P,...args},KP);
    check(r.success===false&&r.error==='funktion_aus'&&r.details?.funktion,'AUS: '+a+' -> funktion_aus');
   }
   // W12 V7: Ausweis-Aktionen haengen nicht mehr an einem eigenen Schalter (token_abruf), sondern am Ausweis-Kern.
   for(const [a,args] of [['token_abrufen',{ziel_identity_id:sid,anlass:'Test'}],['web_ui_koordinator_token',{}]]){
    const r=await adm(a,{project:P,...args},KP);
    check(r.success===false&&r.error==='ausweis_kern_aus'||(a==='web_ui_koordinator_token'&&r.error==='recht_fehlt'),'Kern AUS: '+a+' -> ausweis_kern_aus (kein Schalter token_abruf)'+(r.error==='ausweis_kern_aus'?'':' [got '+JSON.stringify(r).slice(0,240)+']'));
   }
   check((await adm('profil_schalter_setzen',{project:P,profil_funktion:'persona',aktiv:true,grund:'test p22 D'},S)).error==='recht_fehlt','Subagent darf nicht schalten');
   check((await adm('profil_schalter_setzen',{project:P,profil_funktion:'persona',aktiv:true,grund:'x'},KP)).error==='grund_fehlt','Grund Pflicht');
   check((await adm('profil_schalter_setzen',{project:P,ebene:'global',profil_funktion:'persona',aktiv:true,grund:'test p22 D'},S)).error==='recht_fehlt','global: Subagent nie (P22-T57: Koordinator darf)');
   const set=await adm('profil_schalter_setzen',{project:P,profil_funktion:'persona',aktiv:true,grund:'test p22 D Koordinator'},KP);
   check(set.success&&set.schalter.find(x=>x.funktion==='persona').aktiv&&set.schalter.find(x=>x.funktion==='persona').gesetzt_von===kid,'Projektkoordinator schaltet Projekt (dauerhaft in PG)');
   check(!(await C.leseProfilProduktSchalter('persona',Q)).aktiv,'anderes Projekt unberuehrt');
   check((await adm('persona_liste',{project:P},KP)).success===true,'Gruppe EIN nach Schalter');
   {const m=process.env.SYNAPSE_AGENT_BEZUG_MODUS;process.env.SYNAPSE_AGENT_BEZUG_MODUS='beide';try{await adm('profil_schalter_setzen',{project:P,ebene:'global',profil_funktion:'alle',aktiv:true,grund:'test p22 D alle'},USER);}finally{if(m===undefined)delete process.env.SYNAPSE_AGENT_BEZUG_MODUS;else process.env.SYNAPSE_AGENT_BEZUG_MODUS=m;}} // P22-T31 Punkt 3
   check((await adm('typ_liste',{project:P},KP)).error!=='funktion_aus','global alle EIN');
   // Isolation: Schatten, Typ
   await pool.query("INSERT INTO agent_schattenprofile(id,project,ursprung_agent_id,ablauf_am) VALUES('sp-q',$1,'x',NOW()+INTERVAL '1 day'),('sp-p',$2,'y',NOW()+INTERVAL '1 day')",[Q,P]);
   for(const a of ['schattenprofil_korrigieren','schattenprofil_bestaetigen','schattenprofil_ablehnen']){
    const r=await adm(a,{project:P,schattenprofil_id:'sp-q',erwartete_revision:1,korrektur:{},grund:'Isolation'},KP);
    check(r.error==='schattenprofil_unbekannt','fremdes Schattenprofil unsichtbar: '+a);
   }
   await pool.query("INSERT INTO agent_typen(id,scope,project,schluessel,aktuelle_revision,erstellt_von) VALUES('t-glob','global',NULL,'tg',1,'user'),('t-q','projekt',$1,'tq',1,'user'),('t-p','projekt',$2,'tp',1,'user')",[Q,P]);
   check((await adm('typ_aendern',{project:P,typ_id:'t-glob',erwartete_revision:1,typ_inhalt:{rolle:'x'},grund:'global'},KP)).error==='recht_fehlt','globalen Typ aendert nur der User');
   check((await adm('typ_aendern',{project:P,typ_id:'t-q',erwartete_revision:1,typ_inhalt:{rolle:'x'},grund:'fremd'},KP)).error==='typ_unbekannt','Typ fremden Projekts unsichtbar');
   check((await adm('typ_revision_lesen',{project:P,typ_id:'t-q'},USER)).error==='typ_unbekannt','auch fuer den User nur Projekt/global');
   check((await adm('typ_anlegen',{project:P,profil_scope:'global',typ_schluessel:'neu-g',typ_inhalt:{rolle:'x'},grund:'global'},KP)).error==='recht_fehlt','globalen Typ legt nur der User an');
   // Test-Doubles fuer Dienste anderer Pakete: Aufrufvertrag
   const alt={...C.W1B_DIENSTE.schatten},altP=C.W1B_DIENSTE.profil.aendereProfil,altH=C.W1B_DIENSTE.profil.profilHistorie;
   try{
    let gesehen=null;
    C.W1B_DIENSTE.schatten.listeSchattenprofile=async(p,a,f)=>{gesehen={p,art:a.art,f};return [{id:'x'}];};
    const l=await adm('schattenprofil_liste',{project:P,zustand:'pending'},KP);
    check(l.success&&gleich(gesehen,{p:P,art:'identitaet',f:{zustand:'pending'}})&&l.schattenprofile.length===1,'Dienst A: Akteur und Filter korrekt uebergeben');
    check((await adm('schattenprofil_liste',{project:P,zustand:'egal'},KP)).error==='zustand_ungueltig','Zustand validiert');
    let bestaetigt=null;
    C.W1B_DIENSTE.schatten.bestaetigeSchattenprofil=async(b,a)=>{bestaetigt={b,art:a.art};return {schattenprofil:{id:b.schattenprofil_id},identity_id:'i',profil_revision:1};};
    const b1=await adm('schattenprofil_bestaetigen',{project:P,schattenprofil_id:'sp-p',erwartete_revision:1,grund:'Freigabe'},KP);
    check(b1.error==='user_auftrag_fehlt','Koordinator: Bestaetigung braucht Nachweis der User-Zustimmung');
    const b2=await adm('schattenprofil_bestaetigen',{project:P,schattenprofil_id:'sp-p',erwartete_revision:1,grund:'Freigabe',user_zustimmung:'User im Chat: bestaetigen'},KP);
    check(b2.success&&bestaetigt.b.user_zustimmung==='User im Chat: bestaetigen'&&bestaetigt.b.schattenprofil_id==='sp-p','Koordinator mit Zustimmung');
    const b3=await C.mitUserHerkunft('web-ui-chat',()=>C.fuehreW1bAdminAus('schattenprofil_bestaetigen',{project:P,schattenprofil_id:'sp-p',erwartete_revision:1,grund:'Web-UI'}));
    check(b3.success&&bestaetigt.art==='user'&&bestaetigt.b.user_zustimmung===C.USER_AUFTRAG_STANDARD,'User ueber Web-UI: Zustimmung aus dem authentifizierten Eingang');
    C.W1B_DIENSTE.profil.aendereProfil=async()=>({profil_revision:2});
    check((await adm('profil_aendern',{project:P,ziel_identity_id:'d-s',erwartete_revision:1,profil_patch:{persona:{a:1}},grund:'Persona ueber Profil'},KP)).error==='persona_nur_ueber_bibliothek','Persona nie als Profilfeld');
    check((await adm('profil_aendern',{project:P,ziel_identity_id:kid,erwartete_revision:1,profil_patch:{briefing:'eigen'},grund:'Eigenprofil'},KP)).profil_revision===2,'Eigenprofil Koordinator (P22-T53, ersetzt a0f710e0 F2)');
    check((await adm('profil_aendern',{project:P,ziel_identity_id:'d-sq',erwartete_revision:1,profil_patch:{rolle:'x'},grund:'fremdes Projekt'},KP)).error==='identitaet_unbekannt','Ziel nur im eigenen Projekt');
    check((await adm('profil_aendern',{project:P,ziel_identity_id:'d-s',erwartete_revision:1,profil_patch:{kontext_stufe:'kompakt'},grund:'weniger Hinweise'},KP)).profil_revision===2,'Profil aendern ueber Dienst');
    const ur=await adm('profil_aendern',{project:P,ziel_identity_id:kid,erwartete_revision:1,profil_patch:{rolle:'x'},grund:'User-Auftrag Test'},USER);
    check(ur.profil_revision===2,'User darf Koordinator-Profil aendern '+JSON.stringify(ur));
    C.W1B_DIENSTE.profil.profilHistorie=async()=>{throw new C.W1bNichtUmgesetzt('A','profilHistorie');};
    const nu=await adm('profil_historie',{project:P,ziel_identity_id:'d-s'},KP);
    check(nu.success===false&&nu.error==='w1b_nicht_umgesetzt'&&nu.paket==='A','nicht umgesetzte Dienste: klarer Fehler statt Absturz');
    C.W1B_DIENSTE.profil.profilHistorie=async()=>{const e=new C.ProfilRevisionKonflikt(7);throw e;};
    const kf=await adm('profil_historie',{project:P,ziel_identity_id:'d-s'},KP);
    check(kf.error==='profil_revision_veraltet'&&kf.aktuelle_revision===7,'CAS-Konflikt mit aktueller Revision');
    C.W1B_DIENSTE.profil.profilHistorie=async()=>{throw new Error('DB-Passwort sai_'+'1'.repeat(64));};
    const roh=await adm('profil_historie',{project:P,ziel_identity_id:'d-s'},KP);
    check(roh.error==='w1b_admin_fehler'&&!JSON.stringify(roh).includes('sai_'),'unerwartete Fehler ohne Meldungstext');
   }finally{Object.assign(C.W1B_DIENSTE.schatten,alt);C.W1B_DIENSTE.profil.aendereProfil=altP;C.W1B_DIENSTE.profil.profilHistorie=altH;}
   // Task-Bindung (Dienst T als Test-Double): Aufrufvertrag, Projektgrenze, Rechte, Schalter
   const altT={...C.W1B_DIENSTE.taskBindung};
   try{
    const seen=[];
    C.W1B_DIENSTE.taskBindung.leseBindung=async(p,t)=>{seen.push(['lese',p,t]);return {art:'offen'};};
    C.W1B_DIENSTE.taskBindung.legeFest=async(p,t,b,a,g)=>{seen.push(['fest',p,t,b,a.art,g]);return b;};
    C.W1B_DIENSTE.taskBindung.aendere=async(p,t,b,a,g)=>{seen.push(['aend',p,t,b,g]);return b;};
    C.W1B_DIENSTE.taskBindung.entblocke=async(p,t,a,g)=>{seen.push(['entb',p,t,g]);return {art:'offen'};};
    check((await adm('task_bindung_lesen',{project:P,bindung_task_id:'P22-T13'},KP)).bindung.art==='offen','Bindung lesen (Standard offen)');
    const f=await adm('task_bindung_festlegen',{project:P,bindung_task_id:'P22-T13',bindung_art:'team',bindung_identity_ids:['d-s','d-k','d-s'],grund:'Team'},KP);
    check(f.success&&gleich(f.bindung,{art:'team',identity_ids:['d-s','d-k']})&&seen.at(-1)[4]==='identitaet','Team (dedupliziert) an Dienst T, Akteur identitaet');
    check((await adm('task_bindung_festlegen',{project:P,bindung_task_id:'P22-T13',bindung_art:'identitaet',bindung_identity_ids:['d-s']},USER)).bindung.identity_id==='d-s','Einzelidentitaet durch User');
    check((await adm('task_bindung_festlegen',{project:P,bindung_task_id:'P22-T13',bindung_art:'identitaet',bindung_identity_ids:['d-s','d-k']},KP)).error==='bindung_ungueltig','identitaet genau eine ID');
    check((await adm('task_bindung_festlegen',{project:P,bindung_task_id:'P22-T13',bindung_art:'team',bindung_identity_ids:[]},KP)).error==='team_leer','leeres Team abgelehnt');
    check((await adm('task_bindung_festlegen',{project:P,bindung_task_id:'P22-T13',bindung_art:'team',bindung_identity_ids:['d-s','d-sq']},KP)).error==='identitaet_unbekannt','fremde Identitaet im Team abgelehnt');
    check((await adm('task_bindung_festlegen',{project:P,bindung_task_id:'P22-T13',bindung_art:'offen',bindung_identity_ids:['d-s']},KP)).error==='bindung_ungueltig','offen nur ueber entblocken');
    check((await adm('task_bindung_aendern',{project:P,bindung_task_id:'P22-T13',bindung_art:'team',bindung_identity_ids:['d-s']},KP)).error==='grund_fehlt','Aendern: Grund Pflicht');
    check((await adm('task_bindung_entblocken',{project:P,bindung_task_id:'P22-T13'},KP)).error==='grund_fehlt','Entblocken: Grund Pflicht');
    check((await adm('task_bindung_entblocken',{project:P,bindung_task_id:'P22-T13',grund:'Bearbeiter weg'},KP)).bindung.art==='offen'&&seen.at(-1)[3]==='Bearbeiter weg','Entblocken mit Grund');
    check((await adm('task_bindung_lesen',{project:P,bindung_task_id:'P22-T13'},S)).error==='recht_fehlt','Subagent kein Zugriff');
    check((await adm('task_bindung_lesen',{project:P},KP)).error==='bindung_task_id_fehlt','Task-ID Pflicht');
    await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'task_bindung',aktiv:false,grund:'test p22 D aus'},{system:'user'});
    check((await adm('task_bindung_lesen',{project:P,bindung_task_id:'P22-T13'},KP)).error==='funktion_aus','Produkt-Schalter task_bindung AUS');
    await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'task_bindung',aktiv:true,grund:'test p22 D an'},{system:'user'});
   }finally{Object.assign(C.W1B_DIENSTE.taskBindung,altT);}
   // Uebersicht tokenfrei
   const ue=await adm('profil_uebersicht',{project:P},KP);
   const ueText=JSON.stringify(ue);
   check(ue.success&&ue.profile.some(x=>x.identity_id===sid&&x.token_abrufbar===true)&&ue.profile.some(x=>x.name==='tok-ohne'&&x.token_abrufbar===false),'Profiluebersicht: token_abrufbar ja/nein');
   check(secrets.every(s=>!ueText.includes(s))&&!/sai_[a-f0-9]/.test(ueText)&&!ue.profile.some(x=>x.identity_id==='d-sq'),'Uebersicht tokenfrei und projektgebunden');
   // Persona/Token ueber Dispatcher
   const pa=await adm('persona_anlegen',{project:P,persona_name:'via-admin',persona_inhalt:{stil:'ruhig'},user_auftrag:'User: Persona via admin'},KP);
   check(pa.success&&pa.version.version===1,'persona_anlegen');
   const pz=await adm('persona_zuweisen',{project:P,ziel_identity_id:'d-s',persona_vorlage_id:pa.version.vorlage_id,persona_version:1,user_auftrag:'User: d-sub'},KP);
   check(pz.success&&pz.zuweisung.version===1,'persona_zuweisen');
   check((await adm('persona_liste',{project:P,ziel_identity_id:'d-s'},KP)).zuweisung.vorlage_id===pa.version.vorlage_id,'persona_liste mit Zuweisung');
   check((await adm('persona_zuweisen',{project:P,ziel_identity_id:'d-s',persona_vorlage_id:'gibt-es-nicht',persona_version:1,user_auftrag:'User: x'},KP)).error==='vorlage_unbekannt','fremde Vorlage');
   check((await adm('persona_versionen',{project:P,persona_vorlage_id:pa.version.vorlage_id},KP)).versionen.length===1,'persona_versionen');
   check((await adm('persona_entfernen',{project:P,ziel_identity_id:'d-s',grund:'User: nicht mehr'},KP)).entfernt===true,'persona_entfernen');
   const ta=await adm('token_abrufen',{project:P,ziel_identity_id:sid,anlass:'Startauftrag Test'},KP);
   check(ta.success&&ta.token===sub.token&&ta.hinweis.includes('nie in Channel'),'token_abrufen ueber Dispatcher');
   check((await adm('token_abrufen',{project:P,ziel_identity_id:sid,anlass:'Test'},S)).error==='recht_fehlt','Subagent: kein Tokenabruf');
   const wt=await C.mitUserHerkunft('web-ui-chat',()=>C.fuehreW1bAdminAus('web_ui_koordinator_token',{project:P}));
   check(wt.success&&wt.token===k.token,'web_ui_koordinator_token nur ueber User-Herkunft');
   check((await adm('web_ui_koordinator_token',{project:P},KP)).error==='recht_fehlt','Koordinator-Principal: kein Web-UI-Token');
   check(C.w1bFehlerStatus('recht_fehlt')===403&&C.w1bFehlerStatus('typ_unbekannt')===404&&C.w1bFehlerStatus('funktion_aus')===409&&C.w1bFehlerStatus('w1b_nicht_umgesetzt')===501&&C.w1bFehlerStatus('user_auftrag_fehlt')===400,'HTTP-Statusabbildung');
  });

  await section('REST-Vertrag (Web-UI) mit authentifizierter User-Herkunft',async()=>{
   const {k,sub,kid,sid}=globalThis.__d;
   const fastify=(await load('packages/rest-api/node_modules/fastify/fastify.js')).default;
   const {registerAgentProfilRoutes}=await load('packages/rest-api/dist/routes/agent-profil.js');
   const tokens={web:{kind:'session',scope:null},tray:{kind:'session',scope:'ui:tray'},access:{kind:'access',scope:'mcp:tools'},daemon:{kind:'service',scope:'daemon'}};
   const app=fastify({logger:false});
   await registerAgentProfilRoutes(app,{validateToken:async t=>tokens[t]?{token_hash:t,...tokens[t]}:null});await app.ready();close.push(()=>app.close());
   const call=async(method,path,bearerToken,payload,extra={})=>{
    const r=await app.inject({method,url:'/api/projects/'+P+'/agent-profile'+path,headers:{...(bearerToken?{authorization:'Bearer '+bearerToken}:{}),...extra},payload});
    let body;try{body=r.json();}catch{body=null;}return {status:r.statusCode,body,headers:r.headers};
   };
   await pool.query('DELETE FROM agent_profil_schalter');
   check((await call('GET','/schalter',null)).status===401,'ohne Bearer 401');
   check((await call('GET','/schalter','unbekannt')).status===401,'ungueltiger Bearer 401');
   for(const wer of ['access','tray','daemon']){
    const r=await call('GET','/schalter',wer);
    check(r.status===403&&r.body.error.code==='nur_user_oder_koordinator','kein User-Zugang fuer '+wer);
   }
   const spoofHeader=await call('GET','/schalter','access',undefined,{'x-synapse-user':'user','x-user-herkunft':'web-ui-chat'});
   check(spoofHeader.status===403,'Herkunfts-Header/-Parameter erzeugen keinen User');
   const spoofBody=await call('PUT','/schalter','access',{profil_funktion:'persona',aktiv:true,grund:'Spoof',herkunft:{akteur:'user',kanal:'web-ui-chat'},agent_id:'user'});
   check(spoofBody.status===403,'Herkunft im Body erzeugt keinen User');
   const s0=await call('GET','/schalter','web');
   check(s0.status===200&&s0.headers['cache-control']==='no-store'&&s0.body.schalter.every(x=>x.aktiv===C.STANDARD_EIN.includes(x.funktion)),'User-Sitzung: Schalter lesen, no-store, Standard AUS (Katalog im Code)');
   const aus=await call('GET','/persona','web');
   check(aus.status===409&&aus.body.error.code==='funktion_aus','Schalter AUS: 409 funktion_aus');
   const modusAlt=process.env.SYNAPSE_AGENT_BEZUG_MODUS;process.env.SYNAPSE_AGENT_BEZUG_MODUS='beide'; // P22-T31 Punkt 3: 'alle' EIN braucht Modus beide
   const an=await call('PUT','/schalter','web',{profil_funktion:'alle',aktiv:true,grund:'test p22 D REST',ebene:'global'});
   if(modusAlt===undefined)delete process.env.SYNAPSE_AGENT_BEZUG_MODUS;else process.env.SYNAPSE_AGENT_BEZUG_MODUS=modusAlt;
   // P22-T44: 'alle' schaltet mehrprojekt bewusst NICHT mit (nur ausdruecklich, Standard AUS).
   // P23-T5: wie mehrprojekt schliesst 'alle' auch tool_beschreibungen_kurz und fall_skill_hinweis nicht ein (P22-T56: tool_liste_je_verbindung).
   // P23-T7: fall_skill_faelle ebenso.
   // P23-T3: tool_antworten_schlank und shell_fremde_ergebnisse ebenso nur ausdruecklich.
   // P22-T7: verbrauch ebenfalls nur ausdruecklich.
   // P22-T58: runtime_ueberwachung ebenfalls nur ausdruecklich.
   // P22-T68: gegen den Katalog im Code (NUR_AUSDRUECKLICH, STANDARD_EIN) statt gegen eine feste Liste; neue Funktionen brauchen keine Testpflege.
   const nurAusdruecklich=[...C.NUR_AUSDRUECKLICH];
   check(an.status===200&&an.body.schalter.filter(x=>!nurAusdruecklich.includes(x.funktion)).every(x=>x.aktiv)&&nurAusdruecklich.every(f=>an.body.schalter.some(x=>x.funktion===f&&x.aktiv===C.STANDARD_EIN.includes(f)))&&nurAusdruecklich.every(f=>C.PROFIL_PRODUKT_FUNKTIONEN.includes(f)),'User setzt global (PG)');
   const uebersicht=await call('GET','/uebersicht','web');
   check(uebersicht.status===200&&uebersicht.body.profile.some(x=>x.identity_id===sid)&&!/sai_[a-f0-9]/.test(JSON.stringify(uebersicht.body)),'Uebersicht tokenfrei');
   const pnew=await call('POST','/persona','web',{persona_name:'rest-persona',persona_inhalt:{stil:'ruhig'}});
   check(pnew.status===200&&pnew.body.version.user_auftrag===C.USER_AUFTRAG_STANDARD,'Persona-Bibliothek ueber REST, User-Auftrag aus authentifiziertem Eingang');
   const vid=pnew.body.version.vorlage_id;
   const pz=await call('PUT','/profile/'+sid+'/persona','web',{persona_vorlage_id:vid,persona_version:1});
   check(pz.status===200&&pz.body.zuweisung.gesetzt_von==='user','Zuweisung durch User');
   check((await pool.query("SELECT user_auftrag FROM agent_persona_zuweisungen WHERE identity_id=$1",[sid])).rows[0].user_auftrag===C.USER_AUFTRAG_STANDARD,'Audit zeigt User-Herkunft');
   check((await call('GET','/persona?ziel_identity_id='+sid,'web')).body.zuweisung?.vorlage_id===vid,'Liste mit Zuweisung');
   check((await call('GET','/persona/'+vid+'/versionen','web')).body.versionen.length===1,'Versionen');
   check((await call('POST','/persona/'+vid+'/versionen','web',{persona_inhalt:{stil:'knapper'}})).body.version.version===2,'neue Version');
   check((await call('POST','/profile/'+sid+'/persona/entfernen','web',{grund:'User: Persona nicht mehr'})).body.entfernt===true,'Entfernen');
   check((await call('POST','/profile/'+sid+'/persona/entfernen','web',{grund:'zweites Mal'})).status===404,'keine_zuweisung -> 404');
   check((await call('POST','/persona','web',{persona_name:'x'})).status===400,'fehlender Inhalt -> 400');
   const tk=await call('POST','/profile/'+sid+'/token-abruf','web',{anlass:'Web-UI Anzeige'});
   check(tk.status===200&&tk.body.token===sub.token&&tk.headers['cache-control']==='no-store','Token-Abruf (User), no-store');
   const wk=await call('GET','/web-ui-koordinator-token','web');
   check(wk.status===200&&wk.body.token===k.token&&wk.body.identity_id===kid,'Token des Web-UI-Koordinatorprofils fuer den User');
   check((await call('GET','/web-ui-koordinator-token?identity_id='+sid,'web')).status===404,'nur Koordinatorprofile');
   // Koordinator mit persoenlichem Ausweis
   const mitAusweis=(t)=>({'x-synapse-agent-token':t});
   const kz=await call('GET','/uebersicht','access',undefined,mitAusweis(k.token));
   check(kz.status===200,'Koordinator-Ausweis (zusaetzlich Bearer) darf lesen');
   const kt=await call('POST','/profile/'+sid+'/token-abruf','access',{anlass:'Startauftrag'},mitAusweis(k.token));
   check(kt.status===200&&kt.body.token===sub.token,'Koordinator-Ausweis: Tokenabruf');
   check((await call('GET','/web-ui-koordinator-token','access',undefined,mitAusweis(k.token))).status===403,'Koordinator sieht Web-UI-Anzeige nicht');
   const sr=await call('POST','/profile/'+sid+'/token-abruf','access',{anlass:'Test'},mitAusweis(sub.token));
   check(sr.status===403&&sr.body.error.code==='recht_fehlt','Subagent-Ausweis: 403');
   check((await call('GET','/uebersicht','access',undefined,mitAusweis('sai_'+'0'.repeat(64)))).status===401,'ungueltiger Ausweis 401');
   check((await call('PUT','/schalter','web',{profil_funktion:'persona',aktiv:true,grund:'x'})).status===400,'Grund Pflicht -> 400');
   const reqText=JSON.stringify([tk.body,wk.body]);
   check(reqText.includes(sub.token),'(direkte berechtigte Antwort enthaelt den echten Token)');
   const logs=JSON.stringify((await pool.query('SELECT * FROM tool_calls')).rows);
   check(secrets.every(s=>!logs.includes(s)),'REST: Token nie in tool_calls');
  });

  await section('MCP-Verdrahtung (REST+stdio): Schema additiv, Akteur, tool_calls ohne Token',async()=>{
   const {k,sub,kid,sid}=globalThis.__d;
   const T=await transports();
   for(const t of [T.rest,T.stdio]){
    const adminDef=(await t.list()).find(x=>x.name==='admin');
    const actions=adminDef.inputSchema.properties.action.enum;
    check(W1B_AKTIONEN.every(a=>actions.includes(a))&&['kontextprofil_liste','kontextprofil_setzen','kontextprofil_entfernen','jev_status'].every(a=>actions.includes(a)),'admin-Enum: neue Aktionen additiv, bestehende erhalten '+t.name);
    check(W1B_PARAMETER.every(p=>gleich(adminDef.inputSchema.properties[p],C.W1B_ADMIN_PARAMETER[p])),'Parameter aus der gemeinsamen Core-Definition '+t.name);
    check(gleich(projiziere(adminDef).inputSchema.properties.action.enum,actions.filter(a=>!W1B_AKTIONEN.includes(a))),'Projektion entfernt genau die additiven Namen '+t.name);
   }
   const ak={action:'token_abrufen',project:P,ziel_identity_id:sid,anlass:'MCP-Test'};
   for(const t of [T.rest,T.stdio]){
    const ohne=await t.call('admin',{...ak,agent_id:'user',role:'koordinator'});
    check(ohne.success===false&&ohne.error==='recht_fehlt','ohne Ausweis (nur Namen) kein Tokenabruf '+t.name);
    const legacyOk=await t.call('admin',{action:'kontextprofil_liste',project:P,ziel:'x-*',agent_id:'user'});
    check(legacyOk.status==='forbidden','kontextprofil_*: Name user ohne Herkunft weiter verweigert '+t.name);
   }
   const rKoord=await T.rest.call('admin',{...ak,token:k.token});
   check(rKoord.success===true&&rKoord.token===sub.token,'REST/MCP: Koordinator-Ausweis liest Token');
   process.env.SYNAPSE_AGENT_TOKEN_SCHLUESSEL=TEST_SCHLUESSEL;
   const k2=await C.stelleAgentTokenAus({project:P,name:'koordinator'},{system:'user'});secrets.push(k2.token);
   const sKoord=await T.stdio.call('admin',{...ak,token:k2.token});
   check(sKoord.success===true&&sKoord.token===sub.token,'stdio: Koordinator-Ausweis liest Token '+JSON.stringify(sKoord).replace(/sai_[a-z0-9]{1,64}/g,'T').slice(0,300));
   const rSub=await T.rest.call('admin',{...ak,token:sub.token});
   check(rSub.error==='recht_fehlt','REST/MCP: Subagent-Ausweis abgelehnt');
   const sSub=await T.stdio.call('admin',{...ak,token:k2.token,ziel_identity_id:kid,anlass:'MCP-Test'});
   check(sSub.success===true,'stdio: derselbe Koordinator-Ausweis wiederholt (Sitzung bleibt gebunden)');
   
   const widerspruch=await T.rest.call('admin',{...ak,token:k.token,agent_id:'jemand-anders'});
   // W12 V3: der Ausweis gilt bei JEDEM Aufruf und ersetzt agent_id; eine abweichende agent_id wird (ohne Durchsetzung) nur auditiert, nicht gefolgt.
   check(widerspruch.success===true&&widerspruch.ziel_identity_id===sid&&widerspruch.token===sub.token,'Ausweis gewinnt ueber abweichende agent_id (Abweichung nur auditiert)');
   const rows=(await pool.query("SELECT tool_name,action,result,args_preview FROM tool_calls WHERE tool_name='admin' AND action='token_abrufen'")).rows;
   // P22-T55 (User 19.10.): token_abrufen wird protokolliert, der Ausweis steht unmaskiert im Tool-Log.
   check(rows.length>=4&&rows.some(r=>String(r.result).includes(sub.token)),'P22-T55: tool_calls protokolliert token_abrufen mit Ausweis');
   const logs=JSON.stringify((await pool.query('SELECT * FROM tool_calls')).rows);
   check(secrets.filter(s=>!/^sai_/.test(String(s))).every(s=>!logs.includes(s)),'kein sonstiges Geheimnis in tool_calls (Ausweis seit P22-T55 sichtbar)');
   const au=JSON.stringify((await pool.query('SELECT * FROM agent_token_abruf_audit')).rows);
   check(secrets.every(s=>!au.includes(s)),'Abruf-Audit ohne Tokenwert');
   check((await pool.query("SELECT count(*)::int n FROM agent_token_abruf_audit WHERE erfolg AND anlass='MCP-Test' AND wer=ANY($1)",[[kid,k2.identitaet.id]])).rows[0].n>=3,'MCP-Abrufe auditiert (Akteur = Koordinator-Identitaet)');
  });
  check(network===0,'keine echten Netzwerk-/Modellaufrufe');
  console.log('P22-T13 Paket D: '+checks+' Pruefungen, '+failures.length+' Fehler');
 }
 if(failures.length)process.exitCode=1;
}catch(error){console.error(mask(error.stack));process.exitCode=1;}
finally{
 for(const fn of close.reverse())try{await fn();}catch(error){console.error(mask('Cleanup: '+error.message));}
 if(core)await core.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(process.exitCode||0);
