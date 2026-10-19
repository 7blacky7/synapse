/**
 * P22-T44: Agenten-Ausweis fuer mehrere Projekte (Heimat, Visum, Arbeitsfreigabe). Dienst-Ebene gegen synapse_test:5433, privates Schema.
 *   node packages/core/tests/ausweis-mehrprojekt-p22-t44.test.mjs
 * Testbetrieb: Modus 'beide', Ausweis-Kern ueber Produkt-Schalter agenten_ausweis (global), Altschalter AUS.
 * Projekte: H (Heimat des Agenten ag1 und des Koordinators ka), B (eigener Koordinator kb), F (kein Koordinator).
 * Geprueft: Schalter AUS = Altverhalten (Abweisung), 'alle' schaltet mehrprojekt nicht, Heimat ohne project, F ohne Koordinator
 * alles, B mit Koordinator Visum (lesen + Channel ja, Schreiben nein), Visum-Ablauf + Neuausstellung, Arbeitsfreigabe durch
 * Koordinator B ja / Koordinator A nein / User ja, Entziehen und Ablauf -> wieder Visum, Hinweistexte + Anzeige je Lauf,
 * Pflichtregeln von B einmal je Lauf, chat(identitaet)-Debug, admin ausweis_visa, Koordinator-Hinweisquelle, intern-Override.
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
// intern-Tool wird beim Modulstart gelesen (INTERN_TOOL_BEIM_START): fuer den Override-Abschnitt von Anfang an EIN; ohne Zeilen gilt ueberall der Standard.
Object.assign(process.env,{SYNAPSE_INTERN_TOOL:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_AGENT_BEZUG_MODUS:'beide',
  SYNAPSE_HINWEIS_BUDGET_MS:'5000',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
  QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
let network=0;
globalThis.fetch=async()=>{network++;throw Error('Testnetz gesperrt');};
const {Pool}=require('pg');
const admin=new Pool({connectionString:url.href});
const schema='p22_t44_'+process.pid+'_'+randomUUID().slice(0,8);
const H='p22-t44-heimat',B='p22-t44-mit-koord',F='p22-t44-frei';
const SRV='srv-t44';
const failures=[];let checks=0;
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}else console.log('ok   '+label);}
async function abschnitt(name,fn){try{await fn();}catch(e){failures.push(name+': '+mask(e.message));console.error('FAIL Abschnitt '+name+': '+mask(e.stack));}}
const neuerAusweis=()=>'sai_'+randomBytes(32).toString('hex');

let pool;
try{
  await admin.query('CREATE SCHEMA '+schema);
  for(const {tablename} of (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows)await admin.query(`CREATE TABLE ${schema}."${tablename}" (LIKE public."${tablename}" INCLUDING ALL)`);
  const serials=await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%' ORDER BY table_name,column_name",[schema]);
  for(const [i,r]of serials.rows.entries()){
    const q=s=>'"'+s.replaceAll('"','""')+'"',seq=schema+'.t44_serial_'+i;
    await admin.query('CREATE SEQUENCE '+seq);
    await admin.query('ALTER TABLE '+schema+'.'+q(r.table_name)+' ALTER COLUMN '+q(r.column_name)+" SET DEFAULT nextval('"+seq+"'::regclass)");
  }
  const cl=await admin.connect();
  try{
    await cl.query('SET search_path TO '+schema);
    for(const f of ['111_agent_identitaet.sql','112_agent_bezug.sql','113_agent_profil.sql','114_agent_ausweis.sql','115_agent_ausweis_nr.sql',
      '117_agent_ausweis_fristen.sql','118_agent_ausweis_projekte.sql','118_agent_ausweis_projekte.sql'])await cl.query(readFileSync(join(repo,'packages/core/src/db/schema-sql/'+f),'utf8'));
  }finally{cl.release();}
  url.searchParams.set('options','-c search_path='+schema+',public');
  process.env.DATABASE_URL=url.href;
  const T=await load('packages/core/dist/services/agent-token-tools.js');
  const BZ=await load('packages/core/dist/services/agent-bezug.js');
  const O=await load('packages/core/dist/services/agent-onboarding.js');
  const SCH=await load('packages/core/dist/services/agent-profil-schalter.js');
  const AP=await load('packages/core/dist/services/agent-ausweis-projekte.js');
  const ADM=await load('packages/core/dist/services/agent-profil-admin.js');
  const AN=await load('packages/core/dist/services/agent-anmeldung.js');
  const {getPool}=await load('packages/core/dist/db/client.js');
  pool=getPool();

  await abschnitt('Schema 118',async()=>{
    const sql=readFileSync(join(repo,'packages/core/src/db/schema-sql/118_agent_ausweis_projekte.sql'),'utf8');
    const {AGENT_AUSWEIS_PROJEKTE_SCHEMA_SQL:ts}=await load('packages/core/dist/db/agent-ausweis-projekte-schema.js');
    check(sql.trim()===ts.trim(),'118 SQL-Spiegel identisch');
    const {SCHEMA_SQL}=await load('packages/core/dist/db/schema.js');
    check(typeof SCHEMA_SQL!=='string'||SCHEMA_SQL.includes('CREATE TABLE IF NOT EXISTS agent_ausweis_projekte'),'118 im ensureSchema-SQL');
    check((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='agent_identitaet_laeufe' AND column_name='zugestellt_projekte_stand'",[schema])).rowCount===1,'118: Spalte zugestellt_projekte_stand (2x idempotent)');
  });

  await SCH.setzeProfilProduktSchalter({ebene:'global',funktion:'agenten_ausweis',aktiv:true,grund:'Test P22-T44 Kern EIN'},{system:'user'});
  check((await SCH.leseAusweisKern(H)).aktiv===true,'Ausweis-Kern EIN (Produkt-Schalter global)');
  const identitaet=async(id,project,agent,rolle)=>{
    await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,erstellt_von) VALUES($1,$2,$3,$3,$4,'test')",[id,project,agent,rolle]);
    const t=neuerAusweis();
    await pool.query('INSERT INTO agent_identitaet_tokens(id,identity_id,token_offen,token_praefix,ausweis_weg) VALUES($1,$2,$3,$4,$5)',[randomUUID(),id,t,t.slice(0,12),'register']);
    return t;
  };
  const tok1=await identitaet('t44-ag1',H,'t44-ag1','subagent');
  const tokKA=await identitaet('t44-ka',H,'t44-ka','koordinator');
  await identitaet('t44-kb',B,'t44-kb','koordinator');
  await pool.query("INSERT INTO memories(id,project,name,category,content,tags) VALUES($1,$2,'regel-b-pflicht','rules','Pflichtregel von B',ARRAY['pflicht'])",[randomUUID(),B]);
  const KB={art:'identitaet',principal:{art:'identity',project:B,agent_id:'t44-kb',identity_id:'t44-kb',rolle:'koordinator',modell:null,context_epoch:1,lauf_id:null}};
  const KA={art:'identitaet',principal:{art:'identity',project:H,agent_id:'t44-ka',identity_id:'t44-ka',rolle:'koordinator',modell:null,context_epoch:1,lauf_id:null}};
  const USER={art:'user'};
  const aufruf=async(tool,args,arbeit)=>{let k;const r=await T.mitAgentToolAufruf(tool,args,SRV,async x=>{k=x;return arbeit?arbeit(x):{success:true};});return {k,r};};
  const eintrag=async(id,p)=>(await pool.query('SELECT * FROM agent_ausweis_projekte WHERE identity_id=$1 AND project=$2',[id,p])).rows[0];

  await abschnitt('Schalter AUS = Altverhalten',async()=>{
    const st=await AP.leseMehrprojektSchalter(H);
    check(st.aktiv===false&&st.quelle==='standard','mehrprojekt Standard AUS');
    const {k}=await aufruf('thought',{action:'search',project:B,query:'x',token:tok1});
    check(k.antwort?.error==='agent_token_fremdes_projekt','AUS: Ausweis + anderes Projekt -> agent_token_fremdes_projekt');
    check(!(await eintrag('t44-ag1',B)),'AUS: kein Eintrag im Ausweis');
    await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'alle',true,'Test P22-T44','user')",[H]);
    check((await AP.leseMehrprojektSchalter(H)).aktiv===false,"'alle' EIN schaltet mehrprojekt NICHT ein");
    await pool.query("DELETE FROM agent_profil_schalter WHERE funktion='alle'");
    check(SCH.PROFIL_PRODUKT_FUNKTIONEN.includes('mehrprojekt'),'Katalog enthaelt mehrprojekt');
  });

  await SCH.setzeProfilProduktSchalter({ebene:'projekt',project:H,funktion:'mehrprojekt',aktiv:true,grund:'Test P22-T44 EIN'},{system:'user'});
  await abschnitt('Schalter EIN nach Heimat',async()=>{
    const st=await AP.leseMehrprojektSchalter(H);
    check(st.aktiv===true&&st.quelle==='produkt-schalter'&&st.ausweis_kern===true,'mehrprojekt EIN fuer H (Quelle produkt-schalter)');
    check((await AP.leseMehrprojektSchalter(B)).aktiv===false,'B selbst bleibt AUS (Schalter wirkt je Heimat)');
  });

  await abschnitt('Heimat ohne project',async()=>{
    const {k}=await aufruf('thought',{action:'search',query:'x',token:tok1});
    check(!k.antwort&&k.args.project===H&&!k.bestaetigt?.ziel_project,'ohne project -> Heimat, keine Zusatzparameter');
    const {k:k2}=await aufruf('thought',{action:'add',content:'x',token:tok1},async()=>({success:true}));
    check(!k2.antwort,'Heimat: Schreiben wie bisher');
  });

  await abschnitt('B mit Koordinator: Visum',async()=>{
    let prin,ob;
    const {k}=await aufruf('thought',{action:'search',project:B,query:'x',token:tok1},async x=>{prin=BZ.aktuellerAgentPrincipal();
      ob=await O.holeAgentOnboarding({project:B,agentId:'t44-ag1',role:x.args.role,serverInstanceId:SRV});return {success:true};});
    check(!k.antwort&&k.args.project===B,'Visum: lesen in B erlaubt, project bleibt B');
    check(prin?.art==='legacy'&&prin.project===B&&prin.agent_id==='t44-ag1','in B: Principal legacy im Namensraum von B');
    check(k.bestaetigt?.ziel_project===B&&k.bestaetigt?.zugang==='visum'&&k.bestaetigt?.project===H,'bestaetigt: Heimat H, ziel B, zugang visum');
    const e=await eintrag('t44-ag1',B);
    check(!!e&&e.zugang_zuletzt==='visum'&&new Date(e.visum_bis)>new Date()&&Number(e.visa_anzahl)===1,'B dauerhaft im Ausweis eingetragen, Visum ausgestellt');
    const dauer=(new Date(e.visum_bis)-new Date(e.visum_ausgestellt_am))/60000;
    check(Math.abs(dauer-30)<0.1,'Visum-Dauer Standard 30 min (Frist von B)');
    check(!!ob&&(ob.rules??[]).some(r=>r.name==='regel-b-pflicht'),'Pflichtregeln von B beim ersten Aufruf im Lauf');
    let ob2;
    await aufruf('thought',{action:'search',project:B,query:'x',token:tok1},async x=>{ob2=await O.holeAgentOnboarding({project:B,agentId:'t44-ag1',role:x.args.role,serverInstanceId:SRV});return {success:true};});
    check(ob2===null,'Pflichtregeln von B im selben Lauf nicht erneut');
    for(const [tool,args] of [['channel',{action:'join',channel_name:'c'}],['channel',{action:'post',channel_name:'c',content:'hallo'}],['channel',{action:'feed',channel_name:'c'}],
      ['plan',{action:'get'}],['memory',{action:'read',name:'x'}],['code_intel',{action:'tree'}],['files',{action:'read',file_path:'a'}]]){
      const {k:x}=await aufruf(tool,{...args,project:B,token:tok1});
      check(!x.antwort,'Visum erlaubt '+tool+'.'+args.action);
    }
    for(const [tool,args] of [['thought',{action:'add',content:'x'}],['files',{action:'create',file_path:'a',content:'x'}],['memory',{action:'write',name:'x',content:'y'}],
      ['plan',{action:'update_task',task_id:'P1-T1'}],['shell',{action:'exec',command:'ls'}],['channel',{action:'create',name:'neu'}],['admin',{action:'arbeitsfreigabe_erteilen',ziel_identity_id:'t44-ag1',grund:'selbst'}]]){
      const {k:x}=await aufruf(tool,{...args,project:B,token:tok1});
      check(x.antwort?.error==='visum_nur_lesen','Visum lehnt ab: '+tool+'.'+args.action);
    }
    const {k:w}=await aufruf('thought',{action:'add',content:'x',project:B,token:tok1});
    check(/Visum/.test(w.antwort?.message??'')&&w.antwort.message.includes('arbeitsfreigabe_erteilen')&&w.antwort.message.includes('t44-ag1')&&w.antwort.message.includes(B),'Abweisung nennt Visum und konkreten Freigabe-Aufruf');
  });

  await abschnitt('Visum-Ablauf und Neuausstellung',async()=>{
    await pool.query("UPDATE agent_ausweis_projekte SET visum_bis=NOW()-INTERVAL '1 minute' WHERE identity_id='t44-ag1' AND project=$1",[B]);
    const {k}=await aufruf('code_intel',{action:'tree',project:B,token:tok1});
    const e=await eintrag('t44-ag1',B);
    check(!k.antwort&&new Date(e.visum_bis)>new Date()&&Number(e.visa_anzahl)===2,'nach Ablauf: naechste Anfrage stellt neues Visum aus');
    const au=(await pool.query("SELECT count(*)::int n FROM agent_identitaet_audit WHERE identity_id='t44-ag1' AND aktion='visum_ausgestellt'")).rows[0].n;
    check(au===2,'Audit visum_ausgestellt je Ausstellung');
    await pool.query("UPDATE agent_ausweis_fristen SET wert=wert WHERE false");
    await pool.query("INSERT INTO agent_ausweis_fristen(ebene,project,name,wert,grund,gesetzt_von) VALUES('projekt',$1,'visum_minuten',5,'Test P22-T44','user')",[B]);
    await pool.query("UPDATE agent_ausweis_projekte SET visum_bis=NOW()-INTERVAL '1 second' WHERE identity_id='t44-ag1' AND project=$1",[B]);
    await aufruf('code_intel',{action:'tree',project:B,token:tok1});
    const e2=await eintrag('t44-ag1',B);
    const dauer=(new Date(e2.visum_bis)-new Date(e2.visum_ausgestellt_am))/60000;
    check(Math.abs(dauer-5)<0.1,'Visum-Dauer aus der Einstellung von B (visum_minuten 5)');
    await pool.query("DELETE FROM agent_ausweis_fristen WHERE project=$1",[B]);
  });

  await abschnitt('Koordinator sieht Visa',async()=>{
    const v=await AP.offeneVisa(B);
    check(v.some(x=>x.identity_id==='t44-ag1'&&x.heimat===H),'offeneVisa(B) listet ag1 (Hinweisquelle)');
    const h=await BZ.mitAgentAufrufKontext({principal:{art:'identity',project:B,agent_id:'t44-kb',identity_id:'t44-kb',rolle:'koordinator',modell:null,context_epoch:1,lauf_id:null},bezug:await BZ.leseAgentBezugModus()},
      ()=>AN.VISUM_KOORDINATOR_QUELLE.pruefe({tool:'thought',projekt:B,agent_id:'t44-kb',sitzung:'s',pfade:[],ids:[],felder:{},argumente:{},signal:new AbortController().signal}));
    check(h.length===1&&h[0].text.includes('arbeitsfreigabe_erteilen')&&h[0].text.includes('t44-ag1'),'Koordinator-Hinweis mit Freigabe-Aufruf');
    const s=await AN.VISUM_KOORDINATOR_QUELLE.pruefe({tool:'thought',projekt:B,agent_id:'t44-sub',sitzung:'s',pfade:[],ids:[],felder:{},argumente:{},signal:new AbortController().signal});
    check(s.length===0,'Nicht-Koordinator sieht keinen Visum-Hinweis');
    const l=await ADM.fuehreW1bAdminAus('ausweis_visa',{project:B},{akteur:KB});
    check(l.success===true&&l.agenten.some(a=>a.identity_id==='t44-ag1'&&a.zugang==='visum'&&a.heimat===H),'admin ausweis_visa (Koordinator B)');
    check((await ADM.fuehreW1bAdminAus('ausweis_visa',{project:B},{akteur:KA})).error==='recht_fehlt','admin ausweis_visa: Koordinator A in B -> recht_fehlt');
  });

  await abschnitt('Arbeitsfreigabe',async()=>{
    check((await ADM.fuehreW1bAdminAus('arbeitsfreigabe_erteilen',{project:B,ziel_identity_id:'t44-ag1',grund:'Koordinator A'},{akteur:KA})).error==='recht_fehlt','Koordinator A kann fuer B nicht freigeben');
    const {k:ka}=await aufruf('admin',{action:'arbeitsfreigabe_erteilen',project:B,ziel_identity_id:'t44-ag1',grund:'Koordinator A per Ausweis',token:tokKA});
    check(ka.antwort?.error==='visum_nur_lesen','Koordinator A mit Ausweis in B: nur Visum, keine Freigabe');
    const leg=await BZ.mitAgentAufrufKontext({principal:{art:'legacy',project:B,agent_id:'koordinator'},bezug:await BZ.leseAgentBezugModus(),
      fremdprojekt:{project:B,heimat:H,zugang:'visum',identity_id:'t44-ka'}},()=>ADM.fuehreW1bAdminAus('arbeitsfreigabe_erteilen',{project:B,agent_id:'koordinator',ziel_identity_id:'t44-ag1',grund:'Legacy-Name im Visum'},{}));
    check(leg.error==='recht_fehlt','im fremden Projekt gilt ein Gast nie als Legacy-Koordinator');
    check((await ADM.fuehreW1bAdminAus('arbeitsfreigabe_erteilen',{project:B,ziel_identity_id:'t44-kb',grund:'eigener Agent'},{akteur:KB})).error==='identitaet_im_eigenen_projekt','Freigabe nur fuer Agenten anderer Projekte');
    const g=await ADM.fuehreW1bAdminAus('arbeitsfreigabe_erteilen',{project:B,ziel_identity_id:'t44-ag1',grund:'Hilft bei P22-T44'},{akteur:KB});
    check(g.success===true&&g.erteilt_von==='t44-kb','Koordinator B erteilt Arbeitsfreigabe');
    const e=await eintrag('t44-ag1',B);
    const std=(new Date(e.arbeitsfreigabe_bis)-new Date(e.arbeitsfreigabe_am))/3600000;
    check(Math.abs(std-24)<0.01,'Arbeitsfreigabe Standard 24 h');
    const {k}=await aufruf('thought',{action:'add',content:'x',project:B,token:tok1},async()=>({success:true}));
    check(!k.antwort&&k.bestaetigt?.zugang==='arbeitsfreigabe'&&k.args.project===B,'mit Arbeitsfreigabe: Schreiben in B erlaubt');
    const ent=await ADM.fuehreW1bAdminAus('arbeitsfreigabe_entziehen',{project:B,ziel_identity_id:'t44-ag1',grund:'Arbeit erledigt'},{akteur:USER});
    check(ent.success===true,'User entzieht Arbeitsfreigabe');
    const {k:k2}=await aufruf('thought',{action:'add',content:'x',project:B,token:tok1});
    check(k2.antwort?.error==='visum_nur_lesen','nach Entziehen wieder Visum');
    const u=await ADM.fuehreW1bAdminAus('arbeitsfreigabe_erteilen',{project:B,ziel_identity_id:'t44-ag1',grund:'User gibt frei'},{akteur:USER});
    check(u.success===true&&u.erteilt_von==='user','User erteilt Arbeitsfreigabe');
    const {k:k3}=await aufruf('thought',{action:'add',content:'x',project:B,token:tok1});
    check(!k3.antwort,'User-Freigabe wirkt');
    await pool.query("UPDATE agent_ausweis_projekte SET arbeitsfreigabe_bis=NOW()-INTERVAL '1 second' WHERE identity_id='t44-ag1' AND project=$1",[B]);
    const {k:k4}=await aufruf('thought',{action:'add',content:'x',project:B,token:tok1});
    check(k4.antwort?.error==='visum_nur_lesen','nach Ablauf der Arbeitsfreigabe wieder Visum');
    const au=(await pool.query("SELECT aktion FROM agent_identitaet_audit WHERE identity_id='t44-ag1' AND aktion LIKE 'arbeitsfreigabe_%' ORDER BY id")).rows.map(r=>r.aktion);
    check(au.join(',')==='arbeitsfreigabe_erteilt,arbeitsfreigabe_entzogen,arbeitsfreigabe_erteilt','Audit erteilt/entzogen');
  });

  await abschnitt('F ohne Koordinator: alles',async()=>{
    const {k}=await aufruf('thought',{action:'add',content:'x',project:F,token:tok1},async()=>({success:true}));
    check(!k.antwort&&k.bestaetigt?.zugang==='frei'&&k.args.project===F,'F ohne Koordinator: Schreiben erlaubt (frei)');
    const {k:k2}=await aufruf('files',{action:'create',file_path:'x',content:'y',project:F,token:tok1});
    check(!k2.antwort,'F: files create erlaubt');
  });

  await abschnitt('Hinweistexte',async()=>{
    check(AP.ausweisProjekteTexte(H,['moo'],[],[])[0]==='Du hast ein Visum im Projekt "moo". Wenn du dort schauen willst, musst du den project-Parameter mit angeben.','Visum-Text (Wortlaut 8076a319)');
    const t=AP.ausweisProjekteTexte(H,[],['A','B'],[])[0];
    check(t.startsWith('Du bist Einwanderer in den Projekten: "A", "B".')&&t.includes('etwas ändern willst, musst du den project-Parameter benutzen')&&t.includes('Deine Nationalität kommt aus dem Projekt "'+H+'"')&&t.includes('keine Zusatzparameter'),'Einwanderungs-Text (Wortlaut 8076a319)');
    check(AP.ausweisProjekteTexte(H,[],['A'],[])[0].startsWith('Du bist Einwanderer im Projekt "A".'),'Einwanderung Einzahl');
  });

  await abschnitt('Anzeige je Lauf und bei Aenderung',async()=>{
    // Die Anzeige kommt mit dem ersten Aufruf des neuen Laufs, hier also schon mit chat(anmelden).
    const neu=await aufruf('chat',{action:'anmelden',token:tok1},async()=>({content:[{type:'text',text:'{"success":true}'}]}));
    check(!neu.k.antwort?.error,'neuer Lauf (chat anmelden)');
    const zeilen=neu.k.ausweis_hinweise??[];
    check(zeilen.some(z=>z.includes('Visum im Projekt "'+B+'"'))&&zeilen.some(z=>z.includes('"'+F+'"')),'neuer Lauf: Visum B + freies F angezeigt (erster Aufruf des Laufs)');
    const feld=JSON.parse(neu.r.content[0].text).ausweis_projekte_hinweis;
    check(Array.isArray(feld)&&feld.length===zeilen.length,'Anzeige haengt als ausweis_projekte_hinweis an der MCP-Antwort');
    const a2=await aufruf('thought',{action:'search',query:'x',token:tok1},async()=>({success:true}));
    check(!a2.k.ausweis_hinweise&&!('ausweis_projekte_hinweis' in a2.r),'gleicher Lauf, keine Aenderung -> keine Anzeige');
    await ADM.fuehreW1bAdminAus('arbeitsfreigabe_erteilen',{project:B,ziel_identity_id:'t44-ag1',grund:'Anzeige pruefen'},{akteur:KB});
    const a3=await aufruf('thought',{action:'search',query:'x',token:tok1},async()=>({success:true}));
    check((a3.k.ausweis_hinweise??[]).some(z=>z.startsWith('Du bist Einwanderer im Projekt "'+B+'"')&&z.includes('Nationalität kommt aus dem Projekt "'+H+'"')),'Aenderung (Arbeitsfreigabe) -> Einwanderungs-Hinweis');
    check(a3.r.ausweis_projekte_hinweis?.length>=1,'Anzeige am einfachen Antwortobjekt');
    let ob;
    await aufruf('thought',{action:'search',project:B,query:'x',token:tok1},async x=>{ob=await O.holeAgentOnboarding({project:B,agentId:'t44-ag1',role:x.args.role,serverInstanceId:SRV});return {success:true};});
    check(!!ob&&(ob.rules??[]).some(r=>r.name==='regel-b-pflicht'),'neuer Lauf: Pflichtregeln von B wieder einmal');
  });

  await abschnitt('reverse-Tool ausgenommen (44dc299e)',async()=>{
    const vorher=await eintrag('t44-ag1',B);
    await pool.query("UPDATE agent_identitaet_laeufe SET zugestellt_projekte_stand=NULL WHERE identity_id='t44-ag1' AND status='aktiv'");
    const {k}=await aufruf('reverse',{action:'liste',project:B,token:tok1});
    check(k.antwort?.error!=='visum_nur_lesen'&&!k.bestaetigt?.ziel_project,'reverse mit Ausweis + fremdem project: keine Visum-Pruefung (wie bisher)');
    check(!k.ausweis_hinweise,'reverse: kein Visum-/Einwanderungs-Hinweis');
    const nach=await eintrag('t44-ag1',B);
    check(String(nach.zuletzt_aufruf)===String(vorher.zuletzt_aufruf)&&Number(nach.visa_anzahl)===Number(vorher.visa_anzahl),'reverse: Ausweis-Eintrag/Visum unberuehrt');
    const {k:k2}=await aufruf('reverse',{action:'liste',token:tok1});
    check(!k2.antwort&&!k2.ausweis_hinweise,'reverse ohne project: Heimat wie bisher, keine Anzeige');
  });

  await abschnitt('chat(identitaet) Debug',async()=>{
    const {k}=await aufruf('chat',{action:'identitaet',token:tok1});
    const ap=k.antwort?.ausweis_projekte;
    check(ap?.heimat===H&&ap.schalter?.aktiv===true&&ap.schalter?.quelle==='produkt-schalter','identitaet: Heimat + Schalter mit Quelle');
    check(ap.projekte.some(p=>p.project===B&&p.zugang==='arbeitsfreigabe'&&p.arbeitsfreigabe_bis)&&ap.projekte.some(p=>p.project===F&&p.zugang==='frei'),'identitaet: Projekte mit Zugang und Ablauf');
  });

  await abschnitt('intern-Override',async()=>{
    const hat=(await pool.query("SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='intern_schalter'",[schema])).rowCount;
    if(!hat){check(true,'intern_schalter fehlt im Testschema - uebersprungen');return;}
    try{
      await pool.query("INSERT INTO intern_schalter(name,aktiv,modus,bis,grund,gesetzt_von) VALUES('mehrprojekt',false,'freigegeben',NOW()+INTERVAL '1 hour','Test P22-T44','test')");
      const st=await AP.leseMehrprojektSchalter(H);
      check(st.aktiv===false&&st.quelle==='intern'&&st.bis,'intern-Override AUS geht dem Produkt-Schalter vor (befristet)');
      const {k}=await aufruf('thought',{action:'search',project:B,query:'x',token:tok1});
      check(k.antwort?.error==='agent_token_fremdes_projekt','intern AUS -> Altverhalten');
      await pool.query("UPDATE intern_schalter SET bis=NOW()-INTERVAL '1 second' WHERE name='mehrprojekt'");
      check((await AP.leseMehrprojektSchalter(H)).quelle==='produkt-schalter','Ablauf intern -> Produkt-Schalter');
    }finally{await pool.query("DELETE FROM intern_schalter WHERE name='mehrprojekt'");}
  });

  await abschnitt('Schalter wieder AUS',async()=>{
    await SCH.setzeProfilProduktSchalter({ebene:'projekt',project:H,funktion:'mehrprojekt',aktiv:false,grund:'Test P22-T44 AUS'},{system:'user'});
    const {k}=await aufruf('thought',{action:'search',project:B,query:'x',token:tok1});
    check(k.antwort?.error==='agent_token_fremdes_projekt','AUS: wieder Abweisung (Eintraege bleiben, ohne Wirkung)');
    const {k:k2}=await aufruf('thought',{action:'search',query:'x',token:tok1});
    check(!k2.antwort&&k2.args.project===H&&!k2.ausweis_hinweise,'AUS: Heimat unveraendert, keine Anzeige');
  });

  check(network===0,'keine echten Netzwerk-/Modellaufrufe');
  console.log(`\nP22-T44 Mehrprojekt: ${checks} Pruefungen, ${failures.length} Fehler`);
  if(failures.length)process.exitCode=1;
}catch(e){console.error(mask(e.stack));process.exitCode=1;}
finally{
  try{await pool?.end();}catch{}
  try{await admin.query('DROP SCHEMA '+schema+' CASCADE');}catch{}
  await admin.end();
}
