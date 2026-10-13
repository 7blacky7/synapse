/** R4.1 Legacy-Heartbeat-Golden: Altstand zuerst, ausschließlich serverTime normalisieren. Kein SQL/Netz/Dateischreiben. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
const root=process.argv[2]??process.cwd(),mode=process.argv[3]??'verify';
Object.assign(process.env,{SYNAPSE_COMPUTE_NODE:'1',DATABASE_URL:'',SYNAPSE_DATABASE_URL:'',OLLAMA_MODEL:'r41-legacy-fixture',SYNAPSE_OLLAMA_MODEL_DIGEST:'a'.repeat(64),SYNAPSE_OLLAMA_NATIVE_DIMENSION:'8',EMBEDDING_TARGET_DIM:'4',EMBEDDING_NUM_CTX:'512',SYNAPSE_GPU_REQUIRED_TOTAL_MB:'100',SYNAPSE_GPU_REQUIRED_FREE_MB:'50',EMBEDDING_QUERY_PREFIX:'q: ',EMBEDDING_DOC_PREFIX:'d: ',OLLAMA_URL:'http://127.0.0.1:9',SYNAPSE_API_FEATURES:'compute_control'});
const previousFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw Error('Legacy-Golden darf kein Netz benutzen');};
const req=createRequire(pathToFileURL(root+'/packages/rest-api/package.json'));
const Fastify=req('fastify');
const {createEmbeddingNodeRoutes}=await import(pathToFileURL(root+'/packages/rest-api/dist/routes/embedding-nodes.js'));
const boot='11111111-1111-4111-8111-111111111111',nodeId='r41-legacy',snapshot={};
let sequence=0;
const node={node_id:nodeId,boot_id:boot,features:['compute_control'],gesperrt_vom_user:false,aktualisiert_am:new Date()};
const db={async query(sql,values){
 assert.match(sql,/UPDATE embedding_knoten/);
 if(values[2]!==boot||values[3]<=sequence)return{rows:[]};
 sequence=values[3];return{rows:[node],rowCount:1};
}};
const app=Fastify({logger:false});
try{
 await app.register(createEmbeddingNodeRoutes({db,validateToken:async token=>token==='own-token'?{kind:'service',scope:'compute-node:'+nodeId,token_hash:'own-hash'}:null}));
 const body={status:'ready',vramFreeMb:100,activeJobs:0,bootId:boot,sequence:1,model:'r41-legacy-fixture',modelDigest:'a'.repeat(64),nativeDimension:8,targetDimension:4,numCtx:512};
 for(const [name,payload,headers,status]of [
  ['ready_ohne_verhandlung',body,{},200],
  ['busy_unterstuetzung_unbekannt',{...body,status:'busy',activeJobs:1,sequence:2},{'x-synapse-contract-version':'2'},200],
  ['alter_stand',{...body,sequence:1},{},409],
  ['ungueltiger_heartbeat',{...body,sequence:0},{},400],
  ['falscher_ausweis',body,{authorization:'Bearer wrong'},403],
 ]){
  const r=await app.inject({method:'POST',url:'/api/embedding-nodes/'+nodeId+'/heartbeat',headers:{authorization:'Bearer own-token',...headers},payload});
  assert.equal(r.statusCode,status,r.body);const value=r.json();
  if(Object.hasOwn(value,'serverTime')){assert.ok(Number.isFinite(Date.parse(value.serverTime)));value.serverTime='<zeit>';}
  assert.equal(Object.hasOwn(value,'control'),false,'ohne Verhandlung kein neues Feld');
  snapshot[name]={status:r.statusCode,body:value};
 }
 const serialized=JSON.stringify(snapshot);
 if(mode==='capture')console.log('GOLDEN='+serialized);
 else{const golden=JSON.parse(await readFile(new URL('./fixtures/compute-heartbeat-p20-r41-t85.golden.json',import.meta.url),'utf8'));assert.equal(serialized,JSON.stringify(golden));console.log('R41_LEGACY_HEARTBEAT_T85_BYTEGLEICH_5');}
}finally{await app.close();globalThis.fetch=previousFetch;}
