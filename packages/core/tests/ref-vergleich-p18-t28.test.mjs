/** P18-T28/RV18: eigenes synapse_test-Schema; echte REST/stdio-Handler, stdio-Reverse via Loopback-API.
 * P18_RV18_GOLDEN=1: nur unveränderte files(read)-Antworten als JSON (ohne dynamischen Embedding-Hinweis).
 * Testphase/Rotkontrolle durch Koordinator, nicht Autor.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {zieheSpaltenNach} from './_helfer/privatschema-spalten.mjs';
const {Pool}=createRequire(import.meta.url)('pg');
const target=new URL(process.env.DATABASE_URL);assert.equal(target.port,'5433');assert.equal(target.pathname,'/synapse_test');
const schema='p18_rv18_'+randomUUID().replaceAll('-',''),project='p18_rv18',agent='p18-rv18-agent',rid='rev-rv18-abcdef';
const raw=new Pool({connectionString:target.toString(),options:'-c search_path='+schema+',public'});
const db={connect:()=>raw.connect(),query:(...a)=>raw.query(...a)};
let core,http;
try{
 await raw.query('CREATE SCHEMA '+schema);
 for(const t of ['projects','agent_sessions','tool_aktivitaet','code_files','code_symbols','code_references'])await raw.query('CREATE TABLE '+schema+'.'+t+' (LIKE public.'+t+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 await raw.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,'fixture','/synthetic/p18_rv18',true)",[project]);
 await raw.query("INSERT INTO agent_sessions(id,project,status,sitzung_seit) VALUES($1,$2,'active',now())",[agent,project]);
 // Auch Initialisierer der importierten Handler sehen ausschließlich die Testdatenbank.
 target.searchParams.set('options','-c search_path='+schema+',public');
 process.env.DATABASE_URL=target.toString();process.env.SYNAPSE_DATABASE_URL=target.toString();process.env.SYNAPSE_SKIP_EMBEDDINGS='1';process.env.SYNAPSE_REVERSE_BIS_SCHICHT='S3';
 // (angepasst P25-T12, Fall A: Container-Profil wie reverse-pipeline-p18-rv8, damit der echte Dienst den S3-Auftrag anlegen kann)
 Object.assign(process.env,{SYNAPSE_REVERSE_CONTAINER_PROFIL:'rv18-fixture',SYNAPSE_REVERSE_WERKZEUG_VERSION:'rv18-1',SYNAPSE_REVERSE_RESOURCE_NEED:'{"cpu":1,"ram":64,"vram":0,"gpu":false}'});
 core=await import('../dist/index.js');
 const {mitLesePool}=await import('../dist/db/client.js');
 const {REVERSE_SCHEMA_SQL}=await import('../dist/db/reverse-schema.js');
 // (angepasst P25-T12, Fall A: Work-Jobs, Pipeline- und Policy-Schema sowie Produkt-Schalter privat, wie rv8/t64; Spalten aus public nachziehen)
 await raw.query((await import('../dist/db/work-jobs-schema.js')).WORK_JOBS_SCHEMA_SQL);
 await raw.query(REVERSE_SCHEMA_SQL);
 await raw.query((await import('../dist/db/reverse-pipeline-schema.js')).REVERSE_PIPELINE_SCHEMA_SQL);
 await raw.query((await import('../dist/db/reverse-analyse-policy-schema.js')).REVERSE_ANALYSE_POLICY_SCHEMA_SQL);
 await raw.query('CREATE TABLE '+schema+'.agent_profil_schalter (LIKE public.agent_profil_schalter INCLUDING DEFAULTS INCLUDING INDEXES)');
 await zieheSpaltenNach(raw,schema);
 // (angepasst P25-T12, P18-T86: ref_marken_max/antwort_bytes sind Einstellwerte; eigene Tabelle im privaten Schema, damit
 // Testwerte nicht in public.reverse_einstellungen landen)
 await raw.query('CREATE TABLE '+schema+'.reverse_einstellungen (LIKE public.reverse_einstellungen INCLUDING DEFAULTS)');
 const einstellung=async(name,wert)=>{await raw.query('DELETE FROM reverse_einstellungen WHERE ebene=$1 AND name=$2',['global',name]);
  if(wert!==null)await raw.query("INSERT INTO reverse_einstellungen(ebene,name,wert,grund,gesetzt_von) VALUES('global',$1,$2,'RV18 fixture','fixture')",[name,wert]);};
 await raw.query("INSERT INTO reverse_eintraege(id,titel,status) VALUES($1,'RV18','bestaetigt')",[rid]);
 const med=(await raw.query("INSERT INTO reverse_medien(eintrag_id,position,art) VALUES($1,0,'ordner') RETURNING id",[rid])).rows[0].id;
 const d=(await raw.query("INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,art,format) VALUES($1,$2,'game.exe','binaer','pe') RETURNING id",[rid,med])).rows[0].id;
 for(const stage of ['S2','S3']){
  await raw.query("INSERT INTO reverse_schichten(datei_id,schicht,fingerabdruck,status) VALUES($1,$2,$3,'fertig')",[d,stage,'fp-'+stage]);
  const path='game.exe@'+stage+'/00001000_Main.'+(stage==='S2'?'asm':'c'),content=stage==='S2'?'mov eax, 7\nret':'int Main() {\n return 7;\n}';
  await raw.query("INSERT INTO reverse_code_dateien(id,eintrag_id,file_path,file_name,file_type,content,content_hash,datei_id,schicht,fingerabdruck,adresse) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,4096)",['code-'+stage,rid,path,path.split('/').at(-1),stage==='S2'?'asm':'c',content,createHash('sha256').update(content).digest('hex'),d,stage,'fp-'+stage]);
  await raw.query("INSERT INTO reverse_code_symbole(id,eintrag_id,file_path,symbol_type,name,line_start,line_end,datei_id,schicht,fingerabdruck,adresse) VALUES($1,$2,$3,'function','Main',1,$4,$5,$6,$7,4096)",['fn-'+stage,rid,path,content.split('\n').length,d,stage,'fp-'+stage]);
 }
 const source='// @ref '+rid+':game.exe:Main\nfunction fresh() {\n  const literal = "@ref ignored";\n  return 1;\n}\n';
 await raw.query("INSERT INTO code_files(id,project,file_path,file_name,file_type,content) VALUES('rv18-code',$1,'new.js','new.js','js',$2)",[project,source]);
 await raw.query("INSERT INTO code_symbols(id,project,file_path,symbol_type,name,line_start,line_end,value) VALUES('rv18-comment',$1,'new.js','comment',NULL,1,1,$2),('rv18-fn',$1,'new.js','function','fresh',2,5,NULL)",[project,source.split('\n')[0]]);
 const rest=await import('../../rest-api/dist/routes/mcp.js'),stdio=await import('../../mcp-server/dist/tools/consolidated/files.js');
 const args={action:'read',project,file_path:'new.js',agent_id:agent};
 const api=(extra={})=>mitLesePool(raw,()=>rest.handleToolCall('files',{...args,...extra},agent));
 const local=(extra={})=>mitLesePool(raw,()=>stdio.filesTool.handler({...args,...extra}));
 const norm=r=>{const x={...r};delete x.embeddings_hint;return x;};
 const golden=[];
 for(const extra of [{},{from_line:2,to_line:4},{from_line:3,to_line:3,truncate_long_lines:12},{file_path:'missing.js'}]){
  const a=norm(await api(extra)),b=norm(await local(extra));assert.deepEqual(a,b,'REST und stdio identisch ohne Parameter');golden.push({extra,rest:a,stdio:b});
 }
 assert.equal(Object.hasOwn(golden[0].rest,'vergleiche'),false);
 if(process.env.P18_RV18_GOLDEN==='1'){console.log('RV18_GOLDEN '+JSON.stringify(golden));}
 else{
  const initial=await api({ref_vergleich:true});
  assert.equal(initial.success,true,JSON.stringify(initial));
  assert.equal(initial.vergleiche?.[0]?.fehlercode,'nicht_gebunden','Basis-Rotkontrolle am Ergebnis, kein fehlender Export');
  assert.equal(Object.hasOwn(initial.vergleiche[0].original,'content'),false);
  await raw.query("INSERT INTO reverse_bindungen(project,eintrag_id,gebunden_von) VALUES($1,$2,$3)",[project,rid,agent]);
  const service=core.createReverseToolService({pool:raw,runtime:{analysieren:async()=>({p20_auftrag_id:randomUUID(),container:{zustand:'startet',kaltstart_s:1}})}});
  const calls=[];
  http=createServer(async(req,res)=>{try{let body='';for await(const c of req)body+=c;const rpc=JSON.parse(body);calls.push(rpc.params.arguments);const result=await service.ausfuehren(rpc.params.arguments);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:core.baueToolErgebnis(result,{tool:'reverse',strukturiert:true})}));}catch{res.writeHead(500);res.end();}});
  http.listen(0,'127.0.0.1');await once(http,'listening');process.env.SYNAPSE_API_URL='http://127.0.0.1:'+http.address().port;process.env.SYNAPSE_API_TOKEN='synthetic-rv18';
  const compare=async(extra={})=>{
   const a=await api({ref_vergleich:true,...extra}),b=await local({ref_vergleich:true,...extra});
   assert.deepEqual(norm(a),norm(b),'Gleicher Kern auf REST und API-gestütztem stdio');
   return a;
  };
  let r=await compare();assert.equal(r.vergleiche.length,1);assert.equal(r.vergleiche[0].neue_funktion.name,'fresh');assert.equal(r.vergleiche[0].neue_funktion.from_line,2);assert.match(r.vergleiche[0].original.content,/return 7/);assert(calls.some(c=>c.action==='file'));
  // Die Zeichenfolge im Stringliteral wurde nicht als Kommentar indiziert und zählt nie.
  assert.equal(r.vergleiche.length,1);
  const mark=async(value,line=1)=>raw.query("UPDATE code_symbols SET value=$1,line_start=$2 WHERE id='rv18-comment'",[value,line]);
  await mark('// @ref '+rid+':game.exe:0x1000');r=await compare();assert.match(r.vergleiche[0].original.content,/return 7/);
  await mark('// @ref '+rid+':game.exe:Main:S2');r=await compare();assert.equal(r.vergleiche[0].original.schicht,'S2');assert.match(r.vergleiche[0].original.content,/mov eax/);
  await mark('/* first line\n @ref '+rid+':game.exe:Main\n */',2);r=await compare();assert.equal(r.vergleiche[0].neue_funktion.name,'fresh','umschließende Funktion bei mehrzeiligem Kommentar');
  assert.equal((await compare({name:'other'})).vergleiche.length,0);
  await mark('// @ref '+rid+':game.exe:Missing');r=await compare();assert.equal(r.vergleiche[0].fehlercode,'nicht_gefunden');
  await mark('// @ref rev-unknown-abcdef:game.exe:Main');r=await compare();assert.equal(r.vergleiche[0].fehlercode,'nicht_gefunden');assert.equal(Object.hasOwn(r.vergleiche[0].original,'content'),false);
  // (angepasst P25-T12, P18-T86: SYNAPSE_REF_VERGLEICH_MAX_MARKEN gilt nur noch als Migrationsvorschlag; Grenze ueber ref_marken_max)
  await einstellung('ref_marken_max',2);
  await mark(['Main','0x1000','Main:S2'].map(x=>'// @ref '+rid+':game.exe:'+x).join('\n'));
  r=await compare();assert.equal(r.vergleiche.length,2);assert.equal(r.vergleiche_gekappt,true);
  await einstellung('ref_marken_max',null);
  await mark('// @ref '+rid+':game.exe:Main');
  await raw.query("UPDATE reverse_code_dateien SET content=$1 WHERE schicht='S3'",['return 7;\n'.repeat(20000)]);
  await raw.query("UPDATE reverse_code_symbole SET line_end=20000 WHERE schicht='S3'");
  // (angepasst P25-T12, P18-T86: SYNAPSE_REVERSE_ANTWORT_MAX wirkt nicht mehr; Budget ueber antwort_bytes)
  await einstellung('antwort_bytes',1800);
  r=await compare();assert(Buffer.byteLength(JSON.stringify({vergleiche:r.vergleiche,vergleiche_gekappt:r.vergleiche_gekappt}))<=1800);assert.equal(r.vergleiche[0].original.gekappt,true);
  await einstellung('antwort_bytes',null);
  // Nicht fertige Schicht ohne Reverse-Runtime.
  // (angepasst P25-T12, P18-T64: ohne konfigurierte Runtime liefert analysieren gewollt kein_ausfuehrer und legt nichts an,
  // wie reverse-tool-p18-rv9 'ohneRuntime'; Koordinator-Entscheidung 28846 Option B. Der Fall 'interaktiver Auftrag mit Runtime'
  // kommt mit der Fake-Runtime aus P25-T13 dazu.)
  await raw.query("UPDATE reverse_schichten SET status='offen' WHERE schicht='S3'");
  r=await api({ref_vergleich:true});assert.equal(r.vergleiche[0].fehlercode,'kein_ausfuehrer',JSON.stringify(r.vergleiche[0]));
  assert.equal((await raw.query("SELECT count(*)::int n FROM reverse_auftraege WHERE datei_id=$1 AND schicht='S3'",[d])).rows[0].n,0,'ohne Runtime kein Auftrag');
  // Fall A mit Runtime: echter Dispatcher legt einen interaktiven Auftrag an.
  // (angepasst P25-T12, Koordinator 28847: echte ReversePipelineDienst-Runtime im privaten Schema, Muster rv8/t64. Voraussetzungen seit
  // P18-T69/T86/T104: Produkt-Schalter reverse_s3, Schichtgrenze S3 als Einstellwert, Quell-SHA fuer den Policy-Pin, S0/S1 fertig mit
  // den Versionen des Dienstes, damit S3 die naechste Stufe ist.)
  const pipeline=new core.ReversePipelineDienst({pool:raw,konfiguration:core.ladeAssetKonfiguration({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:'/unused-rv18'}),ausfuehrbareKinds:['reverse-S3']});
  await raw.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'reverse_s3',true,'RV18 fixture','fixture')",[project]);
  await raw.query("INSERT INTO reverse_einstellungen(ebene,name,wert_text,grund,gesetzt_von) VALUES('global','analyse_bis_schicht','S3','RV18 fixture','fixture')");
  await raw.query('UPDATE reverse_dateien SET sha256=$2 WHERE id=$1',[d,createHash('sha256').update('rv18-game.exe').digest('hex')]);
  for(const stage of ['S0','S1'])await raw.query("INSERT INTO reverse_schichten(datei_id,schicht,fingerabdruck,status,werkzeug_version,profil_version) VALUES($1,$2,$3,'fertig',$4,$5)",[d,stage,'fp-'+stage,pipeline.version,pipeline.profilFuer(stage)]);
  core.configureReverseRuntime({analysieren:(a,c)=>pipeline.analysieren(a,c)});
  try{
   r=await api({ref_vergleich:true});assert.equal(r.vergleiche[0].fehlercode,'schicht_nicht_fertig',JSON.stringify(r.vergleiche[0]));assert(r.vergleiche[0].original.auftrag_id,JSON.stringify(r.vergleiche[0]));
   assert.equal((await raw.query("SELECT prioritaet FROM reverse_auftraege WHERE datei_id=$1 AND schicht='S3'",[d])).rows[0]?.prioritaet,'interaktiv');
  }finally{core.configureReverseRuntime({});}
  console.log('RV18 PASS: REST/stdio, Name/Adresse/S2, Kommentarindex, Funktion, Rechte, unbekannt, Limits, ohne Runtime kein Auftrag, mit Runtime interaktiver Auftrag');
 }
}finally{
 if(http){http.closeAllConnections();await new Promise(resolve=>http.close(resolve));}
 if(core)await core.closePool();
 await raw.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await raw.end();
}
process.exit(0);
