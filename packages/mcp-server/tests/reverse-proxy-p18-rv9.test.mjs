/** RV9: echter MCP-Client/Server/HTTP-Proxy, nur loopback; keine DB/Bytes im stdio-Pfad. */
import assert from 'node:assert/strict';
import {createServer as createHttpServer} from 'node:http';
import {once} from 'node:events';
import {InMemoryTransport} from '../node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import {Client} from '../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {createServer} from '../dist/server.js';
import {rufeReverseApi} from '../dist/tools/consolidated/reverse.js';
import {baueReverseAntwort,baueToolErgebnis,closePool} from '../../core/dist/index.js';
const secret='rv9-fixture-only';
const calls=[];
const args={action:'status',agent_id:'p18_rv9-proxy',project:'p18_rv9',reverse_id:'rev-proxy-fixture',datei:'cd1/game.exe',warten_sekunden:50};
const payload=baueReverseAntwort(args,{status:'fertig',schicht:'S1',bits:32,werkzeug:'fixture',container:{zustand:'laeuft',kaltstart_s:0}});
payload.pending_events=[{event_id:123,event_type:'FIXTURE',summary:'Einmal aus API'}];
payload.werkzeug_regeln=[{name:'fixture-regel',inhalt:'API-Hook'}];
const expected=baueToolErgebnis(payload,{tool:'reverse',strukturiert:true});
const http=createHttpServer(async(req,res)=>{
 try {
  assert.equal(req.method,'POST');assert.equal(req.url,'/');
  assert.equal(req.headers.authorization,'Bearer '+secret);
  let body='';for await(const chunk of req)body+=chunk;
  const rpc=JSON.parse(body);calls.push(rpc);
  assert.equal(rpc.method,'tools/call');assert.equal(rpc.params.name,'reverse');
  const input=rpc.params.arguments;
  const result=input.typo===undefined?expected:baueToolErgebnis(baueReverseAntwort(input,{unbekannt:['typo']},'werkzeug_fehler','unbekannte_parameter'),{tool:'reverse',strukturiert:true});
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
 }catch(e){res.writeHead(500);res.end('Fixturefehler');console.error(e);}
});
const server=createServer(),client=new Client({name:'rv9-fixture',version:'1'},{capabilities:{}});
try {
 http.listen(0,'127.0.0.1');await once(http,'listening');
 process.env.SYNAPSE_API_URL='http://127.0.0.1:'+http.address().port+'/';
 process.env.SYNAPSE_API_TOKEN=secret;
 const [ct,st]=InMemoryTransport.createLinkedPair();
 await server.connect(st);await client.connect(ct);
 const result=await client.callTool({name:'reverse',arguments:args});
 assert.deepEqual(result,expected,'API-Hülle mit Hooks bleibt genau einmal erhalten');
 assert.deepEqual(calls[0].params.arguments,args,'stdio ändert weder Agent noch Projekt noch Parameter');
 assert.equal(calls.length,1);
 for(const key of ['bits','schicht','schicht_angefragt','fehlercode','werkzeug'])assert(Object.hasOwn(result.structuredContent,key));
 const bad=await client.callTool({name:'reverse',arguments:{...args,typo:1}});
 assert.equal(bad.structuredContent.fehler,'unbekannte_parameter');assert.deepEqual(bad.structuredContent.unbekannt,['typo']);
 assert.equal(calls.length,2,'Unbekannte Parameter werden API-seitig geprüft');
 for(const status of [401,403]){
  const denied=await rufeReverseApi(args,{url:process.env.SYNAPSE_API_URL,token:secret,fetchImpl:async()=>new Response('',{status})});
  assert.equal(denied.structuredContent.fehlercode,'keine_berechtigung');
 }
 let fetched=false;
 for(const url of ['file:///etc/passwd','http://user:secret@127.0.0.1/']){
  const invalid=await rufeReverseApi(args,{url,token:secret,fetchImpl:async()=>{fetched=true;throw new Error('unexpected')}});
  assert.equal(invalid.structuredContent.fehlercode,'werkzeug_fehler');
 }
 assert.equal(fetched,false,'Unsichere API-Adresse vor HTTP abgewiesen');
 const malformed=await rufeReverseApi(args,{url:process.env.SYNAPSE_API_URL,token:secret,fetchImpl:async()=>new Response(JSON.stringify({jsonrpc:'2.0',error:{code:-1,message:'internal-secret'}}),{status:200})});
 assert.equal(malformed.structuredContent.fehlercode,'werkzeug_fehler');
 assert(!JSON.stringify(malformed).includes('internal-secret'),'API-Interna werden nicht durchgereicht');
 console.error('RV9 PROXY PASS: actual MCP Client/Server -> loopback HTTP; request/auth/50s args/hooks exactly once/errors/nulls/protocol');
}finally{await client.close();await server.close();http.closeAllConnections();await new Promise(resolve=>http.close(resolve));await closePool();}
process.exit(0);
