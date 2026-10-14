/** P9-T28: lokale API-Weiterleitung — zwei Fake-API-Server auf Loopback ("LAN" und "Tunnel"),
 * keine Datenbank, keine echte config.json (eigene mkdtemp-Wurzel als HOME). */
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const dist=process.env.T28_MODULE_ROOT??new URL('../dist/',import.meta.url).pathname;
let mod,buildApi,root;
const offen=[];

before(async()=>{
  delete process.env.DATABASE_URL;delete process.env.SYNAPSE_DATABASE_URL;
  root=await fs.mkdtemp(join(os.tmpdir(),'p9-t28-'));
  process.env.HOME=root;
  mod=await import(pathToFileURL(join(dist,'api-weiterleitung.js')));
  ({buildApi}=await import(pathToFileURL(join(dist,'api.js'))));
});
after(async()=>{
  for(const f of offen.reverse())await f().catch(()=>undefined);
  if(root)await fs.rm(root,{recursive:true,force:true});
});

/** Fake-API: /health, POST / (Echo), /sse (3 Events mit Pausen), /slow, Discovery, 401 mit WWW-Authenticate. */
function fakeApi(name){
  const seen=[];
  const handler=(req,res)=>{
    const teile=[];req.on('data',c=>teile.push(c));
    req.on('end',()=>{
      const body=Buffer.concat(teile).toString('utf8');
      seen.push({method:req.method,url:req.url,authorization:req.headers.authorization,host:req.headers.host});
      const herkunft=`http://${req.headers.host}`;
      if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json'});return res.end('{"status":"ok"}');}
      if(req.url==='/.well-known/oauth-protected-resource'){
        res.writeHead(200,{'content-type':'application/json'});
        return res.end(JSON.stringify({resource:`${herkunft}/`,authorization_servers:[herkunft]}));
      }
      if(req.url==='/geschuetzt'){
        res.writeHead(401,{'www-authenticate':`Bearer resource_metadata="${herkunft}/.well-known/oauth-protected-resource", scope="mcp:tools"`,'content-type':'application/json'});
        return res.end('{"success":false}');
      }
      if(req.url==='/sse'||req.url==='/slow'){
        res.writeHead(200,{'content-type':req.url==='/sse'?'text/event-stream':'application/json','cache-control':'no-cache'});
        let i=0;
        const tick=()=>{
          if(i<3){res.write(`data: ${name}-${i++}\n\n`);setTimeout(tick,250);}else res.end();
        };
        return tick();
      }
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({server:name,authorization:req.headers.authorization??null,host:req.headers.host,body}));
    });
  };
  const srv={name,seen,port:0,server:null,
    async start(port=0){
      const s=http.createServer(handler);
      await new Promise(r=>s.listen(port,'127.0.0.1',r));
      srv.server=s;srv.port=s.address().port;return srv;
    },
    async stop(){const s=srv.server;srv.server=null;if(!s)return;s.closeAllConnections();await new Promise(r=>s.close(r));},
    get url(){return `http://127.0.0.1:${srv.port}`;},
  };
  return srv;
}

function anfrage(port,{method='GET',path='/',headers={},body}={}){
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,method,path,headers,agent:false},(res)=>{
      const teile=[];res.on('data',c=>teile.push(c));
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(teile).toString('utf8')}));
    });
    req.on('error',reject);
    req.end(body);
  });
}

async function weiterleitung(basen){
  const w=new mod.ApiWeiterleitung({port:0,basen:()=>basen,pruefIntervallMs:0,verbindungsTimeoutMs:500,log:()=>{}});
  const port=await w.start();
  offen.push(()=>w.stop());
  return {w,port};
}

test('Adresskette: gleiche Reihenfolge wie apiBases() im Tray',()=>{
  assert.deepEqual(mod.apiBasenAusConfig({env:{},cfg:{synapse_api_url:'https://preferred.test/',synapse_api_fallback_url:'https://fallback.test/'}}),
    ['https://preferred.test','https://synapse.moosynapse.org','https://fallback.test']);
  assert.deepEqual(mod.apiBasenAusConfig({env:{},cfg:{synapse_api_url:'http://192.168.50.65:3456'}}),
    ['http://192.168.50.65:3456','https://synapse.moosynapse.org']);
  assert.deepEqual(mod.apiBasenAusConfig({env:{SYNAPSE_API_URL:'http://env.test',SYNAPSE_API_FALLBACK_URL:'http://fb-env.test'},cfg:{synapse_api_url:'http://cfg.test',synapse_api_fallback_url:'http://fb-cfg.test'}}),
    ['http://env.test','http://cfg.test','https://synapse.moosynapse.org','http://fb-env.test']);
  assert.equal(mod.artDerAdresse('http://192.168.50.65:3456'),'lan');
  assert.equal(mod.artDerAdresse('https://synapse.moosynapse.org'),'tunnel');
  assert.equal(mod.artDerAdresse('http://127.0.0.1:3456'),'lokal');
  assert.equal(mod.weiterleitungsPortAusConfig({SYNAPSE_API_WEITERLEITUNG_PORT:'0'}),0);
  assert.equal(mod.weiterleitungsPortAusConfig({}),7879);
});

test('LAN zuerst, Rueckfall bei Ausfall, Rueckkehr nach Pruefung; Authorization unveraendert',async()=>{
  const lan=await fakeApi('lan').start(),tunnel=await fakeApi('tunnel').start();
  offen.push(()=>lan.stop(),()=>tunnel.stop());
  const {w,port}=await weiterleitung([lan.url,tunnel.url]);
  const rpc=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'});
  const h={'content-type':'application/json',authorization:'Bearer client-token-p9t28'};

  let r=await anfrage(port,{method:'POST',path:'/',headers:h,body:rpc});
  let j=JSON.parse(r.text);
  assert.equal(r.status,200);assert.equal(j.server,'lan');
  assert.equal(j.authorization,'Bearer client-token-p9t28');
  assert.equal(j.body,rpc);
  assert.equal(j.host,`127.0.0.1:${lan.port}`);

  await lan.stop();
  r=await anfrage(port,{method:'POST',path:'/mcp/messages?sessionId=x',headers:h,body:rpc});
  j=JSON.parse(r.text);
  assert.equal(j.server,'tunnel');assert.equal(j.authorization,'Bearer client-token-p9t28');
  assert.equal(tunnel.seen.at(-1).url,'/mcp/messages?sessionId=x');
  let st=w.status();
  assert.equal(st.aktiv.url,tunnel.url);
  assert.match(st.wechsel.at(-1).grund,/Rueckfall/);
  // Folgeanfrage bleibt beim Tunnel, ohne den toten LAN-Weg erneut zu probieren.
  r=await anfrage(port,{method:'POST',path:'/',headers:h,body:rpc});
  assert.equal(JSON.parse(r.text).server,'tunnel');

  await lan.start(lan.port);
  assert.equal(await w.pruefe(),lan.url);
  r=await anfrage(port,{method:'POST',path:'/',headers:h,body:rpc});
  assert.equal(JSON.parse(r.text).server,'lan');
  st=w.status();
  assert.equal(st.aktiv.url,lan.url);assert.equal(st.aktiv.art,'lokal');

  await lan.stop();await tunnel.stop();
  r=await anfrage(port,{method:'POST',path:'/',headers:h,body:rpc});
  assert.equal(r.status,502);
  assert.equal(JSON.parse(r.text).error,'api_nicht_erreichbar');
});

test('SSE wird gestreamt, Umschalten bricht laufende Anfragen nicht ab',async()=>{
  const a=await fakeApi('a').start(),b=await fakeApi('b').start();
  offen.push(()=>a.stop(),()=>b.stop());
  const basen=[a.url,b.url];
  const {w,port}=await weiterleitung(basen);
  const t0=Date.now();let ersterChunk=0;
  const fertig=new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path:'/sse',agent:false},(res)=>{
      let text='';
      res.on('data',c=>{if(!ersterChunk)ersterChunk=Date.now()-t0;text+=c;});
      res.on('end',()=>resolve({status:res.statusCode,ct:res.headers['content-type'],text}));
    });
    req.on('error',reject);req.end();
  });
  await new Promise(r=>setTimeout(r,120));
  basen.reverse(); // b wird bevorzugt
  assert.equal(await w.pruefe(),b.url);
  const r=await fertig;
  assert.equal(r.status,200);assert.equal(r.ct,'text/event-stream');
  assert.equal(r.text,'data: a-0\n\ndata: a-1\n\ndata: a-2\n\n');
  assert.ok(ersterChunk<400,`erster Chunk nach ${ersterChunk} ms — gepuffert statt gestreamt?`);
  assert.ok(Date.now()-t0>=500);
  const neu=await anfrage(port,{method:'POST',path:'/',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(JSON.parse(neu.text).server,'b');
});

test('OAuth-Discovery und WWW-Authenticate zeigen auf die lokale Weiterleitung',async()=>{
  const api=await fakeApi('api').start();offen.push(()=>api.stop());
  const {port}=await weiterleitung([api.url]);
  const lokal=`http://127.0.0.1:${port}`;
  const d=await anfrage(port,{path:'/.well-known/oauth-protected-resource'});
  const j=JSON.parse(d.text);
  assert.equal(j.resource,`${lokal}/`);assert.deepEqual(j.authorization_servers,[lokal]);
  assert.equal(Number(d.headers['content-length']),Buffer.byteLength(d.text));
  const u=await anfrage(port,{method:'POST',path:'/geschuetzt',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(u.status,401);
  assert.equal(u.headers['www-authenticate'],`Bearer resource_metadata="${lokal}/.well-known/oauth-protected-resource", scope="mcp:tools"`);
  // localhost als Host bleibt localhost
  const d2=await anfrage(port,{path:'/.well-known/oauth-protected-resource',headers:{host:`localhost:${port}`}});
  assert.equal(JSON.parse(d2.text).resource,`http://localhost:${port}/`);
});

test('Schutz: fremder Origin abgelehnt, gleicher Origin erlaubt, Nicht-Loopback abgelehnt',async()=>{
  const api=await fakeApi('api').start();offen.push(()=>api.stop());
  const {port}=await weiterleitung([api.url]);
  const boese=await anfrage(port,{method:'POST',path:'/',headers:{origin:'https://evil.example','content-type':'application/json'},body:'{}'});
  assert.equal(boese.status,403);assert.equal(JSON.parse(boese.text).error,'browser_abgelehnt');
  const gleich=await anfrage(port,{method:'POST',path:'/authorize',headers:{origin:`http://127.0.0.1:${port}`,'content-type':'application/x-www-form-urlencoded'},body:'totp_code=1'});
  assert.equal(gleich.status,200);
  assert.ok(!api.seen.some(s=>s.url==='/'&&s.method==='POST'),'fremder Origin darf nicht ankommen');

  const ip=Object.values(os.networkInterfaces()).flat().find(i=>i&&i.family==='IPv4'&&!i.internal)?.address;
  if(!ip)return; // ohne Netzwerkkarte nicht pruefbar
  const w=new mod.ApiWeiterleitung({port:0,host:'0.0.0.0',basen:()=>[api.url],pruefIntervallMs:0,log:()=>{}});
  const p=await w.start();offen.push(()=>w.stop());
  const r=await new Promise((resolve,reject)=>{
    const req=http.request({host:ip,port:p,path:'/',method:'POST',localAddress:ip,agent:false},(res)=>{let t='';res.on('data',c=>t+=c);res.on('end',()=>resolve({status:res.statusCode,text:t}));});
    req.on('error',reject);req.end('{}');
  });
  assert.equal(r.status,403);assert.equal(JSON.parse(r.text).error,'nur_lokal');
});

test('Statusanzeige: eigener Pfad und Daemon-Route /api-weiterleitung/status',async()=>{
  const api=await fakeApi('api').start();offen.push(()=>api.stop());
  const {w,port}=await weiterleitung([api.url,'http://127.0.0.1:1']);
  const s=JSON.parse((await anfrage(port,{path:'/__synapse-weiterleitung/status'})).text);
  assert.equal(s.aktiv.url,api.url);assert.equal(s.adressen.length,2);
  assert.ok(!api.seen.some(x=>x.url.startsWith('/__synapse')),'Statuspfad darf nicht weitergeleitet werden');
  const app=buildApi({manager:{},weiterleitung:w});offen.push(()=>app.close());
  const r=await app.inject({method:'GET',url:'/api-weiterleitung/status',remoteAddress:'127.0.0.1'});
  assert.equal(r.statusCode,200);assert.equal(r.json().aktiv.url,api.url);
  const aus=buildApi({manager:{}});offen.push(()=>aus.close());
  const r2=await aus.inject({method:'GET',url:'/api-weiterleitung/status',remoteAddress:'127.0.0.1'});
  assert.equal(r2.json().lauscht,false);
});
