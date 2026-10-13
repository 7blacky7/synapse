/** RV10/W3: actual PG fixtures, own p18_rv10 schema in synapse_test:5433. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
const dsn=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(dsn.port,'5433');assert.equal(dsn.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
process.env.SYNAPSE_SKIP_EMBEDDINGS='1';process.env.QDRANT_URL='http://127.0.0.1:1';
const core=await import('../dist/index.js');
const {REVERSE_SCHEMA_SQL}=await import('../dist/db/reverse-schema.js');
const require=createRequire(new URL('../package.json',import.meta.url)),{Pool}=require('pg');
const raw=new Pool({connectionString:process.env.DATABASE_URL});
const schema='p18_rv10_'+process.pid,project='p18_rv10',agent='p18_rv10-agent',rid='rev-rv10-000001';
const pool={async connect(){const db=await raw.connect();try{await db.query('SET search_path TO '+schema+',public');return db;}catch(e){db.release();throw e;}},
 async query(...args){const db=await this.connect();try{return await db.query(...args);}finally{db.release();}}};
let demanded=0,seq=0,passed=0;
const service=core.createReverseToolService({pool,runtime:{analysieren:async(a,db)=>{
 demanded++;assert.equal(a.prioritaet,'interaktiv');assert.equal((await db.query('SELECT current_schema() AS s')).rows[0].s,schema);
 return {auftrag_id:randomUUID(),status:'wartet',schicht_angefragt:a.bisSchicht};
},containerStatus:async()=>({zustand:'laeuft',kaltstart_s:0})}});
const call=(action,args={})=>service.ausfuehren({action,project,agent_id:agent,reverse_id:rid,...args});
const ok=(r)=>{assert.equal(r.success,true,JSON.stringify(r));for(const k of ['format','arch','bits','schicht','schicht_angefragt','status','fehlercode','werkzeug','merkmale','fortschritt','container'])assert(Object.hasOwn(r,k));passed++;return r;};
const sha=s=>createHash('sha256').update(s).digest('hex');
async function file(path,stage,content,fp='fp-'+stage){
 const id='rv10-file-'+(++seq);
 await pool.query("INSERT INTO reverse_code_dateien(id,eintrag_id,file_path,file_name,file_type,content,content_hash,datei_id,schicht,fingerabdruck,tsv,tsv_zerlegt) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9,to_tsvector('english',$6),to_tsvector('simple',$6))",[id,rid,path,path.split('/').at(-1),path.split('.').at(-1),content,sha(content),stage,fp]);return id;
}
try{
 await pool.query('CREATE SCHEMA '+schema);
 assert.equal((await pool.query('SELECT current_database() AS d,current_schema() AS s')).rows[0].d,'synapse_test');
 for(const table of ['projects','agent_sessions','tool_aktivitaet','code_files'])await pool.query('CREATE TABLE '+schema+'.'+table+' (LIKE public.'+table+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 await pool.query(REVERSE_SCHEMA_SQL);
 await pool.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,'fixture','/synthetic/p18_rv10',true)",[project]);
 await pool.query("INSERT INTO agent_sessions(id,project,status) VALUES($1,$2,'active'),('p18_rv10-wrong','other','active')",[agent,project]);
 await pool.query("INSERT INTO reverse_eintraege(id,titel,status) VALUES($1,'Synthetic reverse','bestaetigt')",[rid]);
 await pool.query("INSERT INTO reverse_medien(id,eintrag_id,position,art) VALUES(1,$1,0,'ordner')",[rid]);
 await pool.query("INSERT INTO reverse_dateien(id,eintrag_id,medium_id,pfad,sha256,format,arch,bits,art,metadaten) VALUES(1,$1,1,'game.exe',$2,'pe','x86',32,'binaer','{\"merkmale\":[\"dotnet\"]}'),(2,$1,1,'pending.exe',$3,'pe','x64',64,'binaer','{}')",[rid,'a'.repeat(64),'b'.repeat(64)]);
 for(const stage of ['S1','S2','S3'])await pool.query("INSERT INTO reverse_schichten(datei_id,schicht,fingerabdruck,status,werkzeug,funktionen_gesamt,funktionen_fertig) VALUES(1,$1,$2,'fertig','fixture',300,300)",[stage,'fp-'+stage]);
 const path='game.exe@S3/00001000_Main.c',path2='game.exe@S3/00002000_Other.c';
 await file(path,'S3','int Main() {\n return SearchNeedle();\n}\npassword = "SyntheticSecret987654321";');
 await file(path2,'S3','int Other() {\n Main();\n SearchNeedle();\n}');
 await file('game.exe@S2/00001000_Main.asm','S2','call Main\nret');
 await file('game.exe@S1/strings.txt','S1','ab\nhello-world\nsecond-string\nthird-string\npassword = "SyntheticSecret987654321"');
 await file('game.exe@S3/old.c','S3','STALE_ONLY','old-fingerprint');
 await pool.query("INSERT INTO code_files(id,project,file_path,file_name,file_type,content) VALUES('rv10-project-only',$1,$2,'00001000_Main.c','c','PROJECT_ONLY_SAME_NAME')",[project,path]);
 await pool.query("INSERT INTO reverse_code_symbole(id,eintrag_id,file_path,symbol_type,name,line_start,line_end,params,is_exported,datei_id,schicht,fingerabdruck) SELECT 'rv10-fn-'||i,$1,$2,'function',CASE WHEN i=0 THEN 'Main' ELSE 'Function'||lpad(i::text,3,'0') END,i+1,i+1,ARRAY['int x'],true,1,'S3','fp-S3' FROM generate_series(0,299) i",[rid,path]);
 await pool.query("INSERT INTO reverse_code_symbole(id,eintrag_id,file_path,symbol_type,name,value,line_start,line_end,datei_id,schicht,fingerabdruck) VALUES('rv10-string',$1,$2,'string',NULL,'hello-world',1,1,1,'S1','fp-S1'),('rv10-stale',$1,'game.exe@S3/old.c','function','STALE_ONLY',NULL,1,1,1,'S3','old-fingerprint')",[rid,'game.exe@S1/strings.txt']);
 await pool.query("INSERT INTO reverse_code_verweise(id,eintrag_id,symbol_id,file_path,line_number,context) SELECT 'rv10-ref-'||i,$1,'rv10-fn-0',CASE WHEN i=2 THEN $2 ELSE $3 END,i+1,'Main call' FROM generate_series(0,2) i",[rid,path,path2]);
 await pool.query("INSERT INTO reverse_code_kanten(eintrag_id,file_path,caller_scope,callee_name,line_number,call_kind) SELECT $1,$2,'Other','Main',i+1,'direct' FROM generate_series(0,2) i",[rid,path2]);
 assert.equal((await call('file',{file_path:path})).fehlercode,'nicht_gebunden');
 ok(await call('binden'));
 const funcs=ok(await call('functions'));assert.equal(funcs.functions.length,200);assert.equal(funcs.total,300);assert.equal(funcs.naechster_offset,200);assert.equal(funcs.gekappt,true);
 const tail=ok(await call('functions',{offset:200}));assert.equal(tail.functions.length,100);assert.equal(tail.naechster_offset,null);
 assert(!JSON.stringify(funcs).includes('STALE_ONLY'));
 const filtered=ok(await call('functions',{name:'Main',file_path:path}));assert.equal(filtered.functions.length,1);assert.equal(filtered.total,1);
 const tree=ok(await call('tree',{limit:2}));assert.equal(tree.total,4);assert.equal(tree.gekappt,true);assert(!tree.baum.includes('old.c'));assert(!tree.baum.includes('PROJECT_ONLY'));
 const f=ok(await call('file',{file_path:path,from_line:2,to_line:2}));assert.equal(f.content.trim(),'return SearchNeedle();');assert.equal(f.format,'pe');assert.equal(f.bits,32);assert.equal(f.fortschritt.fertig,300);assert.equal(f.container.zustand,'laeuft');
 assert(!JSON.stringify(ok(await call('file',{file_path:path}))).includes('SyntheticSecret987654321'),'response text masked');
 assert.equal((await call('file',{file_path:'../etc/passwd'})).fehlercode,'pfad_gefahr');
 assert.equal((await call('file',{file_path:'game.exe'})).fehlercode,'pfad_gefahr');
 const strings=ok(await call('file',{file_path:'game.exe@S1/strings.txt',limit:2,min_laenge:5}));assert.equal(strings.total,4);assert.equal(strings.strings.length,2);assert.equal(strings.naechster_offset,2);
 const stringTail=ok(await call('file',{file_path:'game.exe@S1/strings.txt',limit:2,offset:2,min_laenge:5}));assert.equal(stringTail.strings.length,2);assert.equal(stringTail.naechster_offset,null);
 ok(await call('symbols',{symbol_type:'string',min_laenge:5}));
 const refs=ok(await call('references',{name:'Main',limit:1}));assert.equal(refs.references.length,1);assert.equal(refs.total,4);
 const {mitReverseCodeLeser,REVERSE_BEREICH}=await import('../dist/services/intel-bereich.js');
 const {getReferences}=await import('../dist/services/code-intel.js');
 const directRefs=await mitReverseCodeLeser(pool,()=>getReferences(rid,'Main',false,200,REVERSE_BEREICH));
 assert.equal(refs.total,directRefs.total_references,'same shared engine merges references and call edges');assert.equal(refs.naechster_offset,1);
 const scoped=ok(await call('references',{name:'Main',file_path:path,limit:10}));assert.equal(scoped.references.length,1);assert.equal(scoped.total,1);
 const calls=ok(await call('calls',{callee:'Main',limit:2}));assert.equal(calls.calls.length,2);assert.equal(calls.total,3);
 const search=ok(await call('search',{query:'SearchNeedle',limit:1,match_limit:1}));assert.equal(search.results.length,1);assert.equal(search.total,2);assert.equal(search.mode,'fulltext');
 assert.equal((await call('search',{query:'SearchNeedle',semantic:true})).fehlercode,'semantik_nicht_verfuegbar');
 assert.equal((await call('functions',{limit:501})).fehlercode,'werkzeug_fehler');
 assert.equal((await call('functions',{offset:-1})).fehlercode,'werkzeug_fehler');
 assert.equal((await call('file',{file_path:path,from_line:3,to_line:2})).fehlercode,'werkzeug_fehler');
 const missing=await call('file',{file_path:'pending.exe@S3/00000001_Foo.c'});assert.equal(missing.fehlercode,'schicht_nicht_fertig');assert(missing.auftrag_id);assert.equal(demanded,1);
 assert.equal((await service.ausfuehren({action:'file',agent_id:'p18_rv10-wrong',project,reverse_id:rid,file_path:path})).fehlercode,'keine_berechtigung');
 process.env.SYNAPSE_REVERSE_ANTWORT_MAX='1200';
 await pool.query("UPDATE reverse_code_dateien SET content=$2 WHERE file_path=$1",[path,'0123456789\n'.repeat(20000)]);
 const bounded=ok(await call('file',{file_path:path}));assert.equal(bounded.gekappt,true);assert(bounded.content.length<1200);assert.equal(bounded.returned_range.eof,false);
 delete process.env.SYNAPSE_REVERSE_ANTWORT_MAX;
 assert((await pool.query('SELECT count(*)::int AS n FROM tool_aktivitaet WHERE projekt=$1',[project])).rows[0].n>0);
 // Actual MCP SDK client/server -> loopback JSON-RPC -> the same PG-backed API dispatcher.
 const {createServer:createHttpServer}=await import('node:http'),{once}=await import('node:events');
 const {InMemoryTransport}=await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js');
 const {Client}=await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
 const {createServer:createMcpServer}=await import('../../mcp-server/dist/server.js');
 const received=[];
 const http=createHttpServer(async(req,res)=>{
  try{let body='';for await(const chunk of req)body+=chunk;const rpc=JSON.parse(body);received.push(rpc.params.arguments);
   const data=await service.ausfuehren(rpc.params.arguments);
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:core.baueToolErgebnis(data,{tool:'reverse',strukturiert:true})}));
  }catch(e){res.writeHead(500);res.end('fixture failure');}
 });
 const mcp=createMcpServer(),client=new Client({name:'rv10-fixture',version:'1'},{capabilities:{}});
 try{
  http.listen(0,'127.0.0.1');await once(http,'listening');
  process.env.SYNAPSE_API_URL='http://127.0.0.1:'+http.address().port+'/';process.env.SYNAPSE_API_TOKEN='rv10-fixture';
  const [ct,st]=InMemoryTransport.createLinkedPair();await mcp.connect(st);await client.connect(ct);
  for(const [action,extra] of [['tree',{limit:2}],['functions',{name:'Main',limit:2}],['symbols',{symbol_type:'string',limit:2}],['references',{name:'Main',limit:2}],['search',{query:'SearchNeedle',limit:2}],['file',{file_path:'game.exe@S1/strings.txt',limit:2}],['calls',{callee:'Main',limit:2}]]){
   const args={action,project,agent_id:agent,reverse_id:rid,...extra};
   const api=core.baueToolErgebnis(await service.ausfuehren(args),{tool:'reverse',strukturiert:true});
   assert.deepEqual(await client.callTool({name:'reverse',arguments:args}),api,'REST/stdio identical '+action);
   assert.deepEqual(received.at(-1),args,'stdio preserves arguments '+action);
  }
  assert.equal(received.length,7);
 }finally{await client.close();await mcp.close();http.closeAllConnections();await new Promise(resolve=>http.close(resolve));}
 console.log('RV10 TRANSPORT PASS: seven actual SDK MCP -> loopback HTTP -> PG actions equal API payload');

 console.log('RV10 PASS '+passed+' positive controls: paging/fingerprints/scope/masking/window/strings/refs/calls/search/pending/rights/budget');
}catch(error){console.error(error);process.exitCode=1;}
finally{delete process.env.SYNAPSE_REVERSE_ANTWORT_MAX;await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await raw.end();await core.closePool();}
process.exit(process.exitCode||0);
