/** P18-T28/RV18: eigenes synapse_test-Schema; echte REST/stdio-Handler, stdio-Reverse via Loopback-API.
 * P18_RV18_GOLDEN=1: nur unveränderte files(read)-Antworten als JSON (ohne dynamischen Embedding-Hinweis).
 * Testphase/Rotkontrolle durch Koordinator, nicht Autor.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
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
 core=await import('../dist/index.js');
 const {mitLesePool}=await import('../dist/db/client.js');
 const {REVERSE_SCHEMA_SQL}=await import('../dist/db/reverse-schema.js');
 await raw.query(REVERSE_SCHEMA_SQL);
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
  process.env.SYNAPSE_REF_VERGLEICH_MAX_MARKEN='2';
  await mark(['Main','0x1000','Main:S2'].map(x=>'// @ref '+rid+':game.exe:'+x).join('\n'));
  r=await compare();assert.equal(r.vergleiche.length,2);assert.equal(r.vergleiche_gekappt,true);
  delete process.env.SYNAPSE_REF_VERGLEICH_MAX_MARKEN;
  await mark('// @ref '+rid+':game.exe:Main');
  await raw.query("UPDATE reverse_code_dateien SET content=$1 WHERE schicht='S3'",['return 7;\n'.repeat(20000)]);
  await raw.query("UPDATE reverse_code_symbole SET line_end=20000 WHERE schicht='S3'");
  process.env.SYNAPSE_REVERSE_ANTWORT_MAX='1800';
  r=await compare();assert(Buffer.byteLength(JSON.stringify({vergleiche:r.vergleiche,vergleiche_gekappt:r.vergleiche_gekappt}))<=1800);assert.equal(r.vergleiche[0].original.gekappt,true);
  delete process.env.SYNAPSE_REVERSE_ANTWORT_MAX;
  // Nicht fertige Schicht: echter Dispatcher legt einen interaktiven Auftrag an.
  await raw.query("UPDATE reverse_schichten SET status='offen' WHERE schicht='S3'");
  r=await api({ref_vergleich:true});assert.equal(r.vergleiche[0].fehlercode,'schicht_nicht_fertig');assert(r.vergleiche[0].original.auftrag_id);
  assert.equal((await raw.query("SELECT prioritaet FROM reverse_auftraege WHERE datei_id=$1 AND schicht='S3'",[d])).rows[0].prioritaet,'interaktiv');
  console.log('RV18 PASS: REST/stdio, Name/Adresse/S2, Kommentarindex, Funktion, Rechte, unbekannt, Limits, interaktiver Auftrag');
 }
}finally{
 if(http){http.closeAllConnections();await new Promise(resolve=>http.close(resolve));}
 if(core)await core.closePool();
 await raw.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await raw.end();
}
process.exit(0);
