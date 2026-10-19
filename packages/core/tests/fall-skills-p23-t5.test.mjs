/**
 * P23-T5: Fall-Skills.
 * A Seed (skills/seed): gueltig; jeder Skill aus der Fehlercode-Tabelle und jede Erwaehnung fall-* in den Kurztexten existiert,
 *   Varianten tragen den passenden weg; je Tool-Bereich eine Uebersicht.
 * B Kurze Beschreibungen: Struktur (Namen, Typen, Enums, Pflichtfelder) unveraendert, token/agent_id-Texte unveraendert,
 *   alle Parameter abgedeckt, REST und stdio deutlich kleiner.
 * C Tabelle Fehlercode -> Fall-Skill je Weg (Ausweis/Legacy, nie die andere Variante), Toolbindung, abgeleitete Faelle.
 * D Schalter gegen synapse_test (eigenes Schema): Standard AUS = Altverhalten (gleiches Objekt, Langtexte),
 *   Produkt-Schalter EIN -> Hinweis einmal je Sitzung und Skill, kurze Liste; 'alle' schaltet nicht mit; Projekt AUS schlaegt global EIN.
 *   node packages/core/tests/fall-skills-p23-t5.test.mjs
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
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_AGENT_NAME'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',SYNAPSE_W1B_GATE_TTL_MS:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
globalThis.fetch=async()=>{throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p23_t5_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p23-t5-projekt';
const failures=[];let core,pool,checks=0;
function check(ok,label,detail){checks++;if(!ok){failures.push(label);console.error('FAIL '+label+(detail!==undefined?' - '+JSON.stringify(detail).slice(0,600):''));}}
async function section(name,fn){try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}catch(e){failures.push(name+': '+e.message);console.error('FAIL Abschnitt '+name+': '+e.stack);}}

/** Struktur ohne Beschreibungstexte (rekursiv alle description-Felder entfernt). */
const ohneTexte=(x)=>Array.isArray(x)?x.map(ohneTexte):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).filter(([k])=>k!=='description').map(([k,v])=>[k,ohneTexte(v)])):x;

try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){
  const q='"'+tablename.replaceAll('"','""')+'"';
  await admin.query('CREATE TABLE '+schema+'.'+q+' (LIKE public.'+q+' INCLUDING ALL)');
 }
 url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.href;
 core=await load('packages/core/dist/index.js');pool=core.getPool();
 const {ladeSeed}=await load('scripts/skills-seed-laden.mjs');
 const seed=await ladeSeed(join(repo,'skills','seed'));
 const seedNamen=new Map(seed.skills.map(s=>[s.skill_name,s]));
 const {MCP_TOOLS}=await load('packages/rest-api/dist/routes/mcp.js');
 const stdioMod=await load('packages/mcp-server/dist/tools/consolidated/index.js');
 const stdio=[];const sammle=x=>{if(Array.isArray(x))return x.forEach(sammle);if(x&&typeof x==='object'&&x.definition?.name)stdio.push(x.definition);else if(x&&typeof x==='object'&&x.name&&x.inputSchema)stdio.push(x);};
 Object.values(stdioMod).forEach(sammle);

 await section('A Seed vollstaendig und je Weg passend',async()=>{
  check(seed.fehler.length===0,'Seed ohne Fehler',seed.fehler);
  check(seed.skills.length>=80,'mindestens 80 Fall-Skills',seed.skills.length);
  for(const e of core.FALL_SKILL_TABELLE){
   // skill = fuer beide Wege; Ausnahme fall-querschnitt-ausweis-token (agent_token_fehlt trifft nur Ausweis-Inhaber).
   if(e.skill)check(seedNamen.has(e.skill)&&(seedNamen.get(e.skill).weg==='beide'||e.skill==='fall-querschnitt-ausweis-token'),'Tabellen-Skill im Seed (weg beide): '+e.skill,seedNamen.get(e.skill)?.weg);
   if(e.ausweis)check(seedNamen.get(e.ausweis)?.weg==='ausweis','Ausweis-Variante im Seed mit weg ausweis: '+e.ausweis,seedNamen.get(e.ausweis)?.weg);
   if(e.legacy)check(seedNamen.get(e.legacy)?.weg==='legacy','Legacy-Variante im Seed mit weg legacy: '+e.legacy,seedNamen.get(e.legacy)?.weg);
  }
  const erwaehnt=new Set();
  for(const k of Object.values(core.KURZ_BESCHREIBUNGEN)){for(const t of [k.b,...Object.values(k.p)])for(const m of t.match(/fall-[a-z0-9-]*[a-z0-9]/g)??[])erwaehnt.add(m);}
  for(const n of erwaehnt)check(seedNamen.has(n),'Kurztext verweist auf vorhandenen Fall-Skill: '+n);
  for(const s of seed.skills)check(s.sections.some(x=>x.section==='uebersicht'),'uebersicht in '+s.skill_name);
 });

 await section('B kurze Beschreibungen: strukturgleich, Ausnahmen, kleiner',async()=>{
  for(const [name,defs] of [['rest',MCP_TOOLS],['stdio',stdio]]){
   let vor=0,nach=0;
   for(const d of defs){
    const k=core.kuerzeToolDefinition(d);
    check(JSON.stringify(ohneTexte(k))===JSON.stringify(ohneTexte(d)),name+'/'+d.name+': Struktur ohne Texte unveraendert');
    check(k!==d||!core.KURZ_BESCHREIBUNGEN[d.name],name+'/'+d.name+': Kopie statt Original');
    for(const p of ['token','agent_id']){
     const a=d.inputSchema?.properties?.[p]?.description,b=k.inputSchema?.properties?.[p]?.description;
     if(a!==undefined)check(a===b,name+'/'+d.name+'.'+p+': Text unveraendert (P22-T55)');
    }
    vor+=JSON.stringify(d).length;nach+=JSON.stringify(k).length;
   }
   check(nach<vor*0.65,name+': mindestens 35 % kleiner',{vor,nach});
   console.log(`  ${name}: ${vor} -> ${nach} Zeichen (${Math.round(100-nach*100/vor)} % kleiner)`);
   check(core.fehlendeKurztexte(defs).length===0,name+': alle Parameter mit Kurztext',core.fehlendeKurztexte(defs));
  }
  const vorher=JSON.stringify(MCP_TOOLS.find(t=>t.name==='files'));
  core.kuerzeToolDefinition(MCP_TOOLS.find(t=>t.name==='files'));
  check(JSON.stringify(MCP_TOOLS.find(t=>t.name==='files'))===vorher,'Original-Definition bleibt unveraendert');
 });

 await section('C Tabelle je Weg',async()=>{
  const f=(tool,a,weg,args)=>core.ermittleFallSkill(tool,a,weg,args)?.name??null;
  check(f('plan',{success:false,error:'agent_token_fehlt'},'legacy')==='fall-querschnitt-ausweis-token','agent_token_fehlt -> Ausweis-Skill (auch ohne Principal)');
  check(f('shell',{success:false,error:'agent_fehlt'},'ausweis')==='fall-querschnitt-ausweis-token','agent_fehlt Ausweis -> token-Hilfe');
  check(f('shell',{success:false,error:'agent_fehlt'},'legacy')==='fall-querschnitt-agent-id-legacy','agent_fehlt Legacy -> agent_id-Hilfe');
  check(f('shell',{success:false,stufe:'rueckfrage',error:'shell_rueckfrage'},'ausweis')==='fall-shell-rueckfrage-ausweis','Rueckfrage Ausweis');
  check(f('shell',{success:false,stufe:'rueckfrage',error:'shell_rueckfrage'},'legacy')==='fall-shell-rueckfrage-legacy','Rueckfrage Legacy');
  check(f('plan',{success:false,error:'grund_noetig'},'ausweis')===null,'grund_noetig Ausweis -> keine (Legacy-Variante wird nie gezeigt)');
  check(f('plan',{success:false,error:'grund_noetig'},'legacy')==='fall-plan-grund-legacy','grund_noetig Legacy');
  check(f('files',{success:false,error:'anchor_mismatch'},'ausweis')==='fall-files-anker','anchor_mismatch files');
  check(f('memory',{success:false,error:'anchor_mismatch'},'ausweis')===null,'anchor_mismatch nur fuer files');
  check(f('files',{success:false,error:'Fehler im Tool "files": pfad_gesperrt: .env'},'legacy')==='fall-files-pfad','Code im geworfenen Fehlertext');
  check(f('files',{success:false,count:2,lines:[3,9],error:'Suchtext ist mehrdeutig'},'legacy')==='fall-files-suchtext','search_replace Trefferzahl');
  check(f('files',{success:true,applied:false,message:'Pfad "a" existiert bereits - deshalb NICHT direkt geschrieben'},'legacy')==='fall-files-create-existiert','create auf bestehende Datei');
  check(f('files',{success:true,entries:[]},'legacy',{action:'history',agent_id:'x'})==='fall-files-history-filter-legacy','history leer mit agent_id (Legacy)');
  check(f('files',{success:true,entries:[]},'ausweis',{action:'history',agent_id:'x'})===null,'history-Filter nur Legacy');
  check(f('code_intel',{success:false,error:'unbekannter_parameter',unbekannte_parameter:['x']},'ausweis')==='fall-querschnitt-unbekannter-parameter','unbekannter_parameter');
  check(f('plan',{success:true,id:'1'},'legacy')===null,'Erfolg -> kein Fall');
  check(f('plan',[{error:'agent_fehlt'}],'legacy')===null,'Array -> kein Fall');
 });

 await section('D Schalter, Entprellung, tools/list',async()=>{
  core.leereFallSkillEntprellung();core.leereFallSkillSchalterPuffer();
  const fehler={success:false,error:'anchor_mismatch',message:'x'};
  const s0=await core.leseFallSkillSchalter('hinweis',P);
  check(s0.aktiv===false&&s0.quelle==='standard','Standard AUS',s0);
  const r0=await core.haengeFallSkillHinweisAn(fehler,'files',{weg:'legacy',schluessel:'a1',project:P});
  check(r0===fehler,'AUS: gleiches Objekt, kein Feld');
  const lang=await core.beworbeneAgentTools(MCP_TOOLS,{project:P});
  check(lang.find(t=>t.name==='files').description===MCP_TOOLS.find(t=>t.name==='files').description,'AUS: tools/list mit Langtexten');
  // 'alle' schaltet die Fall-Skill-Funktionen nicht mit
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,'alle',true,'Test P23-T5 alle','user')");
  check((await core.leseFallSkillSchalter('hinweis',P)).aktiv===false,"'alle' EIN schaltet fall_skill_hinweis nicht ein");
  check((await core.leseFallSkillSchalter('kurz',P)).aktiv===false,"'alle' EIN schaltet tool_beschreibungen_kurz nicht ein");
  await pool.query("DELETE FROM agent_profil_schalter WHERE funktion='alle'");
  // Produkt-Schalter global EIN
  await core.setzeProfilProduktSchalter({ebene:'global',funktion:'fall_skill_hinweis',aktiv:true,grund:'Test P23-T5 EIN'},{system:'user'});
  await core.setzeProfilProduktSchalter({ebene:'global',funktion:'tool_beschreibungen_kurz',aktiv:true,grund:'Test P23-T5 EIN'},{system:'user'});
  const s1=await core.leseFallSkillSchalter('hinweis',P);
  check(s1.aktiv===true&&s1.quelle==='produkt-schalter','EIN ueber Produkt-Schalter, Quelle sichtbar',s1);
  const r1=await core.haengeFallSkillHinweisAn(fehler,'files',{weg:'legacy',schluessel:'a1',project:P});
  check(r1.fall_skill?.name==='fall-files-anker'&&r1.fall_skill.abruf.includes('get_full')&&r1.fall_skill.ausloeser==='anchor_mismatch','EIN: fall_skill mit Name, Abruf, Ausloeser',r1.fall_skill);
  check(fehler.fall_skill===undefined,'Original unveraendert');
  const r2=await core.haengeFallSkillHinweisAn(fehler,'files',{weg:'legacy',schluessel:'a1',project:P});
  check(r2===fehler,'zweites Auftreten in derselben Sitzung: kein Hinweis');
  const r3=await core.haengeFallSkillHinweisAn(fehler,'files',{weg:'legacy',schluessel:'a2',project:P});
  check(r3.fall_skill?.name==='fall-files-anker','andere Sitzung: Hinweis wieder');
  const ra=await core.haengeFallSkillHinweisAn({success:false,error:'agent_fehlt'},'shell',{weg:'ausweis',schluessel:'id:1',project:P});
  const rl=await core.haengeFallSkillHinweisAn({success:false,error:'agent_fehlt'},'shell',{weg:'legacy',schluessel:'leg',project:P});
  check(ra.fall_skill?.name==='fall-querschnitt-ausweis-token'&&rl.fall_skill?.name==='fall-querschnitt-agent-id-legacy','je Weg genau eine Variante',[ra.fall_skill,rl.fall_skill]);
  const txt={content:[{type:'text',text:JSON.stringify({success:false,error:'pfad_gesperrt'})}]};
  await core.haengeFallSkillTextHinweisAn(txt,'files',{weg:'legacy',schluessel:'t1',project:P});
  check(JSON.parse(txt.content[0].text).fall_skill?.name==='fall-files-pfad','stdio-Textweg haengt an');
  const kurz=await core.beworbeneAgentTools(MCP_TOOLS,{project:P});
  const fk=kurz.find(t=>t.name==='files');
  check(fk.description===core.KURZ_BESCHREIBUNGEN.files.b,'EIN: tools/list mit Kurztext');
  check(JSON.stringify(ohneTexte(fk))===JSON.stringify(ohneTexte(lang.find(t=>t.name==='files'))),'EIN: Struktur der Liste gleich');
  const diag=core.fallSkillDiagnose();
  check(diag.zaehler.ausgeliefert>=4&&diag.zaehler.entprellt>=1,'Diagnose zaehlt',diag.zaehler);
  // Projekt AUS schlaegt global EIN
  await core.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'fall_skill_hinweis',aktiv:false,grund:'Test P23-T5 Projekt AUS'},{system:'user'});
  const r4=await core.haengeFallSkillHinweisAn(fehler,'files',{weg:'legacy',schluessel:'a9',project:P});
  check(r4===fehler,'Projekt AUS schlaegt global EIN');
  // Recht: Subagent ohne Koordinator-Rolle darf nicht schalten
  let abgelehnt=false;try{await core.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'fall_skill_hinweis',aktiv:true,grund:'Test P23-T5 fremd'},{identity_id:'keine-identitaet'});}catch(e){abgelehnt=e.code==='recht_fehlt';}
  check(abgelehnt,'nur Koordinator/User duerfen schalten');
 });
}finally{
 try{await pool?.end?.();}catch(e){console.error('Aufraeumen: Pool schliessen fehlgeschlagen',e.message);}
 try{await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}catch(e){console.error('Aufraeumen: Testschema bleibt',schema,e.message);}
 await admin.end();
}
console.log(`P23-T5: ${checks} Pruefungen, ${failures.length} Fehler`);
process.exit(failures.length?1:0);
