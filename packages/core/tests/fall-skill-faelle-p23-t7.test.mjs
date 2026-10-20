/**
 * P23-T7: ungenuegende Fall-Skill-Hinweise als offene Tool-Faelle im Erklaerungs-Topf (Familie tool:<tool>:<code>).
 * A Hilfen: strukturierter Fehlercode, Ausschnitt ohne Geheimnisse.
 * B Schalter fall_skill_faelle Standard AUS: kein Fall; 'alle' schaltet ihn nicht mit.
 * C EIN: derselbe Fehlercode nach dem Hinweis im selben Lauf -> Fall (einmal je Lauf); Code ohne Fall-Skill -> Fall; Erfolg -> nichts.
 * D Liste (familie tool:), Onboarding-Zeile nur fuer den Koordinator.
 * E Antwort nur Koordinator/User: sofort verifiziert, Fall weg, Vorschlag-Section am Fall-Skill, seed_nachziehen.
 * F Gleicher Fall spaeter: Jev waehlt die Antwort (Tool-Anweisung), kein neuer Fall, Hinweis an den Agenten.
 * G Debug: tool_faelle je Code, Zaehler. H Seed-Skript behaelt Vorschlag-Sections.
 *   DATABASE_URL=postgres://...:5433/synapse_test node packages/core/tests/fall-skill-faelle-p23-t7.test.mjs
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
 JEV_SCHALTER_CACHE_MS:'0',JEV_OPENROUTER_API_KEY:'test-only-jev-key',FEHLERMUSTER_WARTE_MS:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
let choice='a',confidence=0.95;const jevCalls=[];
const fake=async(u,init)=>{
 if(!String(u).includes('openrouter'))throw Error('Testnetz gesperrt');
 const body=JSON.parse(init.body);jevCalls.push(body);
 return new Response(JSON.stringify({answers:{erklaerung:{choice,confidence}},usage:{input_tokens:1,output_tokens:1,cost:0}}),{status:200});
};
globalThis.fetch=fake;
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p23_t7_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p23-t7-projekt',AGENT='p23t7-agent',GEHEIM='GEHEIM_P23T7_WERT';
const failures=[];let core,E,A,pool,checks=0;
function check(ok,label,detail){checks++;if(!ok){failures.push(label);console.error('FAIL '+label+(detail!==undefined?' - '+JSON.stringify(detail).slice(0,600):''));}}
async function section(name,fn){try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}catch(e){failures.push(name+': '+e.message);console.error('FAIL Abschnitt '+name+': '+e.stack);}}
const ruhe=async()=>{await new Promise(r=>setTimeout(r,80));await E._erklaerungenLeerlauf();};
const anker={success:false,error:'anchor_mismatch',message:'Anker nicht gefunden'};
const opt=(schluessel,extra={})=>({weg:'legacy',schluessel,project:P,args:{action:'update',project:P,agent_id:AGENT,file_path:'src/a.ts',anchor_text:'x',token:GEHEIM,...extra}});
const toolFaelle=async()=>(await pool.query("SELECT * FROM erklaerung_faelle WHERE project=$1 AND left(familie,5)='tool:' ORDER BY id",[P])).rows;
const TEXTE={
 lage_de:'Ein Update mit Anker scheitert, weil der Ankertext nicht mehr im aktuellen Dateiinhalt steht.',
 wieso_de:'Die Datei wurde seit dem Lesen geaendert oder der Anker wurde nicht exakt kopiert.',
 abhilfe_de:'Datei neu lesen, anchor_text exakt aus dem frischen Inhalt kopieren und erneut planen.',
 lage_en:'An update with an anchor fails because the anchor text is no longer in the current file content.',
 wieso_en:'The file changed since it was read or the anchor was not copied exactly.',
 abhilfe_en:'Read the file again, copy anchor_text exactly from the fresh content and plan again.',
};

try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){
  const q='"'+tablename.replaceAll('"','""')+'"';
  await admin.query('CREATE TABLE '+schema+'.'+q+' (LIKE public.'+q+' INCLUDING ALL)');
 }
 url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.href;
 core=await load('packages/core/dist/index.js');pool=core.getPool();
 E=await load('packages/core/dist/services/erklaerungen.js');
 A=await load('packages/core/dist/services/fehlermuster-auslieferung.js');
 E._setzeErklaerungDeps({fetch:fake});
 await pool.query("INSERT INTO skill_names(skill_name,section_count,aktualisiert_am) VALUES('fall-files-anker',0,NOW()) ON CONFLICT DO NOTHING");

 await section('A Hilfen',async()=>{
  check(core.primaererFehlercode({success:false,error:'anchor_mismatch'})==='anchor_mismatch','Fehlercode aus error');
  check(core.primaererFehlercode({success:false,error:{code:'plan_failed',message:'x'}})==='plan_failed','Fehlercode aus error.code');
  check(core.primaererFehlercode({success:false,error:'Fehler im Tool: kaputt'})===null,'Freitext ist kein strukturierter Code');
  check(core.primaererFehlercode({success:false,error:'fehler'})===null,'allgemeiner Code zaehlt nicht');
  check(core.primaererFehlercode({success:true,error:'anchor_mismatch'})===null,'Erfolg -> kein Code');
  const t=core.toolFallText({tool:'files',aktion:'update',code:'anchor_mismatch',fall_skill:'fall-files-anker',art:'wiederholt',weg:'legacy',agent_id:AGENT,identity_id:null,lauf_id:null},
   {token:GEHEIM,api_key:GEHEIM,content:'x'.repeat(500)},{...anker,skill_suggestions:[1]});
  check(!t.includes(GEHEIM)&&t.includes('[ENTFERNT]'),'Geheimnis-Schluessel entfernt');
  check(t.includes('fall-files-anker')&&t.includes('anchor_mismatch')&&!t.includes('skill_suggestions'),'Kopf und Antwort ohne fremde Anhaenge');
  check(!t.includes('x'.repeat(250)),'lange Werte gekuerzt');
 });

 await section('B Schalter AUS',async()=>{
  core.leereFallSkillEntprellung();core.leereFallSkillSchalterPuffer();
  const s=await core.leseFallSkillSchalter('faelle',P);
  check(s.aktiv===false&&s.quelle==='standard','Standard AUS',s);
  await core.setzeProfilProduktSchalter({ebene:'global',funktion:'fall_skill_hinweis',aktiv:true,grund:'Test P23-T7 Hinweis EIN'},{system:'user'});
  for(let i=0;i<3;i++)await core.haengeFallSkillHinweisAn(anker,'files',opt('b1'));
  await core.haengeFallSkillHinweisAn({success:false,error:'xyz_kaputt'},'plan',opt('b1'));
  await ruhe();
  check((await toolFaelle()).length===0,'AUS: kein Tool-Fall');
  check(core.fallSkillDiagnose().zaehler.fall_schalter_aus>=1,'AUS gezaehlt',core.fallSkillDiagnose().zaehler);
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,'alle',true,'Test P23-T7 alle','user')");
  check((await core.leseFallSkillSchalter('faelle',P)).aktiv===false,"'alle' schaltet fall_skill_faelle nicht ein");
  await pool.query("DELETE FROM agent_profil_schalter WHERE funktion='alle'");
 });

 await section('C Erkennen und Sammeln',async()=>{
  core.leereFallSkillEntprellung();
  await core.setzeProfilProduktSchalter({ebene:'global',funktion:'fall_skill_faelle',aktiv:true,grund:'Test P23-T7 Faelle EIN'},{system:'user'});
  const r1=await core.haengeFallSkillHinweisAn(anker,'files',opt('c1'));
  check(r1.fall_skill?.name==='fall-files-anker','erstes Auftreten: Hinweis');
  await ruhe();
  check((await toolFaelle()).length===0,'erstes Auftreten: noch kein Fall');
  const r2=await core.haengeFallSkillHinweisAn(anker,'files',opt('c1'));
  check(r2===anker,'Wiederholung: Antwort unveraendert (gleiches Objekt)');
  await ruhe();
  let f=await toolFaelle();
  check(f.length===1&&f[0].familie==='tool:files:anchor_mismatch','Wiederholung -> Fall tool:files:anchor_mismatch',f.map(x=>x.familie));
  check(f[0]?.schatten?.tool_fall?.fall_skill==='fall-files-anker'&&f[0].schatten.tool_fall.art==='wiederholt'&&f[0].schatten.tool_fall.aktion==='update'&&f[0].agent_id===AGENT,'Kontext im Fall',f[0]?.schatten?.tool_fall);
  check(!JSON.stringify(f[0]).includes(GEHEIM),'kein Geheimnis im Fall');
  await core.haengeFallSkillHinweisAn(anker,'files',opt('c1'));
  await ruhe();
  f=await toolFaelle();
  check(f.length===1&&f[0].haeufigkeit===1,'einmal je Lauf',f.map(x=>[x.familie,x.haeufigkeit]));
  await core.haengeFallSkillHinweisAn({success:false,error:'xyz_kaputt',message:'nichts'},'plan',opt('c1',{action:'get'}));
  await core.haengeFallSkillHinweisAn({success:true,id:'1'},'plan',opt('c1'));
  await ruhe();
  f=await toolFaelle();
  const ohne=f.find(x=>x.familie==='tool:plan:xyz_kaputt');
  check(f.length===2&&ohne?.schatten?.tool_fall?.art==='ohne_skill'&&ohne.schatten.tool_fall.fall_skill===null,'Code ohne Fall-Skill -> Fall; Erfolg -> nichts',f.map(x=>x.familie));
 });

 await section('D Liste und Onboarding',async()=>{
  const l=await E.listeOffeneFaelle({project:P,familie:'tool:'});
  check(l.success&&l.anzahl===2&&l.faelle.every(x=>x.tool_fall&&x.familie.startsWith('tool:')),'Liste familie tool: kompakt mit tool_fall',l.faelle);
  const ex=await E.listeOffeneFaelle({project:P,familie:'tool:files:anchor_mismatch'});
  check(ex.anzahl===1,'exakte Familie');
  const k=await E.erklaerungsFaelleZeile({project:P,agent_id:'koordinator',koordinator:true});
  check(typeof k==='string'&&k.includes('2 Tool-Faelle'),'Koordinator sieht Tool-Faelle',k);
  const s=await E.erklaerungsFaelleZeile({project:P,agent_id:AGENT,koordinator:false});
  check(s===undefined,'betroffener Agent bekommt keine Tool-Faelle angeboten',s);
 });

 let erklaerungId;
 await section('E Antwort des Koordinators',async()=>{
  const f=(await toolFaelle()).find(x=>x.familie==='tool:files:anchor_mismatch');
  const fremd=await E.fuehreErklaerungsActionAus('erklaerung_ablegen',{fall_id:f.id,...TEXTE},AGENT);
  check(fremd.success===false&&fremd.error==='nur_koordinator','betroffener Agent darf Tool-Fall nicht beantworten',fremd);
  const g=await E.fuehreErklaerungsActionAus('fall',{id:f.id},'koordinator');
  check(g.success&&String(g.naechster_schritt).includes('nur Koordinator'),'fall nennt den Koordinator-Weg',g.naechster_schritt);
  const r=await E.fuehreErklaerungsActionAus('erklaerung_ablegen',{fall_id:f.id,...TEXTE},'koordinator');
  check(r.success&&r.verifikation?.verifiziert===true&&r.erklaerung?.status==='verifiziert','Antwort sofort verifiziert',r);
  erklaerungId=r.erklaerung?.id;
  check((await toolFaelle()).every(x=>x.id!==f.id),'Fall geloescht');
  check(r.fall_skill_vorschlag?.skill_name==='fall-files-anker'&&r.fall_skill_vorschlag.section==='vorschlag-anchor-mismatch','Vorschlag am gezeigten Fall-Skill',r.fall_skill_vorschlag);
  const sec=(await pool.query("SELECT content,tags FROM skill_sections WHERE skill_name='fall-files-anker' AND section='vorschlag-anchor-mismatch'")).rows[0];
  check(sec&&sec.content.includes(TEXTE.abhilfe_de)&&sec.tags.includes('vorschlag'),'Section in PG',sec);
  check(r.seed_nachziehen?.eintrag?.section==='vorschlag-anchor-mismatch'&&r.seed_nachziehen.eintrag.tags.includes('vorschlag'),'seed_nachziehen',r.seed_nachziehen);
  const o=(await toolFaelle()).find(x=>x.familie==='tool:plan:xyz_kaputt');
  const r2=await E.fuehreErklaerungsActionAus('erklaerung_ablegen',{fall_id:o.id,...TEXTE,lage_de:'Eine Aktion meldet einen Code, fuer den es keinen Fall-Skill gibt.',lage_en:'An action reports a code that has no case skill.'},'koordinator');
  check(r2.success&&r2.fall_skill_vorschlag?.skill_name==='fall-querschnitt','ohne vorhandenen Uebersichts-Skill -> fall-querschnitt',r2.fall_skill_vorschlag);
 });

 await section('F Jev waehlt die Antwort',async()=>{
  jevCalls.length=0;choice='a';confidence=0.95;
  // Anderer Aufruf (sonst entprellt der Erklaerungs-Topf denselben Ausschnitt 10 Minuten als 'doppelt').
  await core.haengeFallSkillHinweisAn(anker,'files',opt('f1',{file_path:'src/b.ts'}));
  await core.haengeFallSkillHinweisAn(anker,'files',opt('f1',{file_path:'src/b.ts'}));
  await ruhe();
  check(jevCalls.length===1&&String(jevCalls[0].questions?.erklaerung?.instructions).includes('Synapse tool call'),'ein Jev-Aufruf mit Tool-Anweisung',jevCalls[0]?.questions);
  check(!JSON.stringify(jevCalls[0]??{}).includes(GEHEIM),'kein Geheimnis an Jev');
  check((await toolFaelle()).every(x=>x.familie!=='tool:files:anchor_mismatch'),'verifizierte Antwort gewaehlt -> kein neuer Fall');
  const h=await A.holeFehlermusterHinweise(AGENT);
  check(h?.treffer?.some(t=>t.erklaerung?.id===erklaerungId),'Hinweis mit der Antwort an den Agenten',h);
 });

 await section('G Debug',async()=>{
  const st=await E.erklaerungstopfStatus();
  check(st.tool_faelle&&st.tool_faelle.je_code['files:anchor_mismatch']?.beantwortet===1&&st.tool_faelle.offen===0,'tool_faelle je Code',st.tool_faelle);
  const z=core.fallSkillDiagnose().zaehler;
  check(z.fall_wiederholt>=2&&z.fall_ohne_skill>=1,'Zaehler',z);
  const {fuehreJevAdminAus}=await load('packages/core/dist/services/jev-admin.js');
  const adm=await fuehreJevAdminAus('jev_erklaerungstopf',{project:P},'koordinator');
  check(adm.success&&adm.fall_skill_zaehler&&adm.topf?.tool_faelle,'admin jev_erklaerungstopf zeigt Tool-Faelle und Zaehler',adm);
 });

 await section('H Seed-Skript behaelt Vorschlaege',async()=>{
  const {offeneVorschlaege,gleich}=await load('scripts/skills-seed-laden.mjs');
  const seed={sections:[{section:'uebersicht',content:'A'}]};
  const voll={sections:[{section:'uebersicht',content:'A',tags:[]},{section:'vorschlag-x',content:'B',tags:['vorschlag']}]};
  check(offeneVorschlaege(seed,voll).map(s=>s.section).join()==='vorschlag-x','offene Vorschlaege erkannt');
  check(gleich(seed,voll)===true,'Vorschlag zaehlt nicht als Abweichung');
  check(gleich(seed,{sections:[{section:'uebersicht',content:'C',tags:[]},voll.sections[1]]})===false,'echte Abweichung bleibt');
 });
}finally{
 try{await E?._erklaerungenLeerlauf?.();}catch(e){console.error('Aufraeumen: Erklaerungs-Warteschlange',e.message);}
 try{await pool?.end?.();}catch(e){console.error('Aufraeumen: Pool schliessen fehlgeschlagen',e.message);}
 try{await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}catch(e){console.error('Aufraeumen: Testschema bleibt',schema,e.message);}
 await admin.end();
}
console.log(`P23-T7: ${checks} Pruefungen, ${failures.length} Fehler`);
process.exit(failures.length?1:0);
