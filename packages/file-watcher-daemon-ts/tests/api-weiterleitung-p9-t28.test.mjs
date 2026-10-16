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
let mod,buildApi,root,freigabeMod;
const offen=[];

before(async()=>{
  delete process.env.DATABASE_URL;delete process.env.SYNAPSE_DATABASE_URL;
  delete process.env.SYNAPSE_TRAY_TOKEN_WEITERLEITUNG;
  root=await fs.mkdtemp(join(os.tmpdir(),'p9-t28-'));
  process.env.HOME=root;
  mod=await import(pathToFileURL(join(dist,'api-weiterleitung.js')));
  freigabeMod=await import(pathToFileURL(join(dist,'tray-token-weiterleitung.js')));
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
      seen.push({method:req.method,url:req.url,authorization:req.headers.authorization,body,host:req.headers.host,hop:req.headers['x-hop'],session:req.headers['mcp-session-id']});
      const herkunft=`http://${req.headers.host}`;
      if(req.url==='/reset'){req.socket.destroy();return;}
      if(req.url==='/fehler'){res.writeHead(503);res.end('api-fehler');return;}
      if(req.url==='/hop'){res.writeHead(200,{'content-type':'application/json',connection:'x-hop','x-hop':'nur-verbindung','mcp-session-id':'session-antwort'});res.end(JSON.stringify({hop:req.headers['x-hop']??null,session:req.headers['mcp-session-id']}));return;}
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

async function weiterleitung(basen,optionen={}){
  const w=new mod.ApiWeiterleitung({port:0,basen:()=>basen,pruefIntervallMs:0,verbindungsTimeoutMs:500,trayFreigabe:()=>({an:true,bis:null,quelle:'standard'}),trayToken:()=> 'synthetischer-tray-zugang',log:()=>{},...optionen});
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
  const d=await anfrage(port,{path:'/.well-known/oauth-protected-resource',headers:{authorization:'Bearer eigener-oauth-zugang'}});
  const j=JSON.parse(d.text);
  assert.equal(j.resource,`${lokal}/`);assert.deepEqual(j.authorization_servers,[lokal]);
  assert.equal(Number(d.headers['content-length']),Buffer.byteLength(d.text));
  const u=await anfrage(port,{method:'POST',path:'/geschuetzt',headers:{'content-type':'application/json',authorization:'Bearer eigener-oauth-zugang'},body:'{}'});
  assert.equal(u.status,401);
  assert.equal(u.headers['www-authenticate'],`Bearer resource_metadata="${lokal}/.well-known/oauth-protected-resource", scope="mcp:tools"`);
  // localhost als Host bleibt localhost
  const d2=await anfrage(port,{path:'/.well-known/oauth-protected-resource',headers:{host:`localhost:${port}`,authorization:'Bearer eigener-oauth-zugang'}});
  assert.equal(JSON.parse(d2.text).resource,`http://localhost:${port}/`);
});

test('Schutz: jeder Origin abgelehnt und Bindung ausschliesslich Loopback',async()=>{
  const api=await fakeApi('api').start();offen.push(()=>api.stop());
  const {port}=await weiterleitung([api.url]);
  for(const origin of ['https://evil.example',`http://127.0.0.1:${port}`,'null']){
    const r=await anfrage(port,{method:'POST',path:'/mcp',headers:{origin,'content-type':'application/json'},body:'{}'});
    assert.equal(r.status,403);assert.equal(JSON.parse(r.text).error,'browser_abgelehnt');
  }
  assert.ok(!api.seen.some(s=>s.url==='/mcp'),'Browser darf nie Upstream erreichen');
  for(const host of ['0.0.0.0','::','192.168.1.2']){
    const w=new mod.ApiWeiterleitung({port:0,host,basen:()=>[api.url],pruefIntervallMs:0,log:()=>{}});
    await assert.rejects(w.start(),/nur an 127\.0\.0\.1/);
  }
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

test('Verarbeiteter POST auf Keep-Alive wird nach Reset weder wiederholt noch umgeleitet',async()=>{
  const a=await fakeApi('a').start(),b=await fakeApi('b').start();
  offen.push(()=>a.stop(),()=>b.stop());
  const {port}=await weiterleitung([a.url,b.url]);
  await anfrage(port,{method:'POST',path:'/warm',body:'warm'});
  const r=await anfrage(port,{method:'POST',path:'/reset',body:'wirkung'});
  assert.equal(r.status,502);
  assert.equal(JSON.parse(r.text).error,'api_verbindung_abgebrochen');
  assert.equal(a.seen.filter(s=>s.url==='/reset').length,1);
  assert.equal(b.seen.filter(s=>s.url==='/reset').length,0);
});

test('HTTP-Fehler bleiben unveraendert und Connection-Header gelten in beide Richtungen',async()=>{
  const a=await fakeApi('a').start(),b=await fakeApi('b').start();
  offen.push(()=>a.stop(),()=>b.stop());
  const {port}=await weiterleitung([a.url,b.url]);
  const err=await anfrage(port,{method:'POST',path:'/fehler',body:'wirkung'});
  assert.equal(err.status,503);assert.equal(err.text,'api-fehler');
  assert.equal(b.seen.filter(s=>s.url==='/fehler').length,0);
  const r=await anfrage(port,{path:'/hop',headers:{connection:'x-hop','x-hop':'nur-verbindung','mcp-session-id':'session-anfrage'}});
  assert.equal(JSON.parse(r.text).hop,null);
  assert.equal(JSON.parse(r.text).session,'session-anfrage');
  assert.equal(r.headers['x-hop'],undefined);
  assert.equal(r.headers['mcp-session-id'],'session-antwort');
});

test('Zeitgeber kehrt automatisch zur bevorzugten API zurueck; Tray-Zugang und keine Body-Logs',async()=>{
  const a=await fakeApi('lan').start(),b=await fakeApi('tunnel').start();
  offen.push(()=>a.stop(),()=>b.stop());
  const lanUrl=a.url,lanPort=a.port,logs=[];
  await a.stop();
  const w=new mod.ApiWeiterleitung({port:0,basen:()=>[lanUrl,b.url],pruefIntervallMs:40,verbindungsTimeoutMs:100,trayFreigabe:()=>({an:true,bis:null,quelle:'standard'}),trayToken:()=> 'synthetischer-tray-zugang',log:m=>logs.push(m)});
  const port=await w.start();offen.push(()=>w.stop());
  assert.equal(w.status().aktiv.url,b.url);
  const body='p9-t28-body-darf-nie-im-log-stehen';
  const r=await anfrage(port,{method:'POST',path:'/mcp',body});
  assert.equal(JSON.parse(r.text).authorization,'Bearer synthetischer-tray-zugang');
  assert.equal(JSON.parse(r.text).body,body);
  await a.start(lanPort);
  const deadline=Date.now()+2000;
  while(w.status().aktiv.url!==lanUrl&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(w.status().aktiv.url,lanUrl);
  const neu=await anfrage(port,{method:'POST',path:'/mcp',body:'nach-rueckkehr'});
  assert.equal(JSON.parse(neu.text).server,'lan');
  assert.ok(!logs.some(m=>m.includes(body)));
});


// 1a: Reset nur auf einem bereits fuer einen Request verwendeten Socket.
// Frische Verbindungen liefern Erfolg, /immer-reset scheitert auch frisch.
async function resetApi(){
  const seen=[],closed=[],sockets=new Set();
  const uses=new WeakMap();
  const server=http.createServer((req,res)=>{
    req.resume();
    req.on('end',()=>{
      const prior=uses.get(req.socket)??0;uses.set(req.socket,prior+1);
      seen.push({method:req.method,url:req.url,socket:req.socket,prior});
      if(req.url==='/health'){res.end('ok');return;}
      if(req.url==='/immer-reset'||(req.url==='/reset-wiederverwendet'&&prior>0)){
        req.socket.destroy();return;
      }
      res.writeHead(200,{'x-frisch':String(prior===0)});
      res.end('angekommen');
    });
  });
  server.keepAliveTimeout=5000;
  server.on('connection',socket=>{
    sockets.add(socket);socket.on('close',()=>{sockets.delete(socket);closed.push(socket);});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  offen.push(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return {seen,closed,url:`http://127.0.0.1:${server.address().port}`};
}

async function idleProxy(api,idleSocketTimeoutMs=1000){
  const w=new mod.ApiWeiterleitung({port:0,basen:()=>[api.url],pruefIntervallMs:0,idleSocketTimeoutMs,trayFreigabe:()=>({an:true,bis:null,quelle:'standard'}),trayToken:()=> 'synthetischer-tray-zugang',log:()=>{}});
  const port=await w.start();offen.push(()=>w.stop());return {w,port};
}

test('1a GET/HEAD/OPTIONS nach reusedSocket-Reset genau einmal frisch, auch Retry begrenzt',async()=>{
  for(const method of ['GET','HEAD','OPTIONS']){
    const api=await resetApi(),{port}=await idleProxy(api);
    await anfrage(port,{method:'POST',path:'/warm',body:'warm'});
    const r=await anfrage(port,{method,path:'/reset-wiederverwendet'});
    assert.equal(r.status,200);assert.equal(r.headers['x-frisch'],'true');
    const calls=api.seen.filter(s=>s.url==='/reset-wiederverwendet');
    assert.equal(calls.length,2);assert.ok(calls[0].prior>0);assert.equal(calls[1].prior,0);
    // Der frische Retry benutzt agent:false; fuer den naechsten Fall erst warm verbinden.
    await anfrage(port,{method:'POST',path:'/warm',body:'warm'});
    const failed=await anfrage(port,{method,path:'/immer-reset'});
    assert.equal(failed.status,502);
    assert.equal(api.seen.filter(s=>s.url==='/immer-reset').length,2,'kein zweiter Retry');
  }
});

test('1a POST/PUT/PATCH/DELETE nach reusedSocket-Reset nie wiederholen',async()=>{
  for(const method of ['POST','PUT','PATCH','DELETE']){
    const api=await resetApi(),{port}=await idleProxy(api);
    await anfrage(port,{method:'POST',path:'/warm',body:'warm'});
    // Node aktiviert fuer DELETE keine implizite Chunked-Kodierung. Body explizit rahmen,
    // damit der HTTP-Parser keinen zweiten (ungueltigen) Request aus den Bytes liest.
    const body='wirkung';
    const r=await anfrage(port,{method,path:'/reset-wiederverwendet',headers:{'content-length':String(Buffer.byteLength(body))},body});
    assert.equal(r.status,502,`${method}: ${r.text}`);
    assert.equal(JSON.parse(r.text).error,'api_verbindung_abgebrochen');
    const calls=api.seen.filter(s=>s.url==='/reset-wiederverwendet');
    assert.equal(calls.length,1);assert.ok(calls[0].prior>0);
  }
});

test('1a Idle-Socket vor Serverfrist geschlossen; naechster POST kommt frisch ohne Reset an',async()=>{
  const api=await resetApi(),{port}=await idleProxy(api,40);
  await anfrage(port,{method:'POST',path:'/warm',body:'warm'});
  const warm=api.seen.find(s=>s.url==='/warm').socket;
  const deadline=Date.now()+2000;
  while(!api.closed.includes(warm)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(api.closed.includes(warm),'Client muss freien Socket vor 5000ms Serverfrist schliessen');
  const r=await anfrage(port,{method:'POST',path:'/reset-wiederverwendet',body:'wirkung'});
  assert.equal(r.status,200);assert.equal(r.headers['x-frisch'],'true');
  assert.equal(api.seen.filter(s=>s.url==='/reset-wiederverwendet').length,1);
});

test('1a kurze Idle-Frist beendet keinen laufenden SSE-Stream',async()=>{
  const api=await fakeApi('idle-stream').start();offen.push(()=>api.stop());
  const {port}=await idleProxy(api,30);
  const r=await anfrage(port,{path:'/sse'});
  assert.equal(r.status,200);
  assert.equal(r.text,'data: idle-stream-0\n\ndata: idle-stream-1\n\ndata: idle-stream-2\n\n');
});

test('1a Idle-Konfiguration: Env vor Config, positive Millisekunden, konservativer Standard',()=>{
  const cfg={api_weiterleitung_idle_ms:250};
  assert.equal(mod.weiterleitungsIdleMsAusConfig({env:{SYNAPSE_API_WEITERLEITUNG_IDLE_MS:'120'},cfg}),120);
  assert.equal(mod.weiterleitungsIdleMsAusConfig({env:{},cfg}),250);
  assert.equal(mod.weiterleitungsIdleMsAusConfig({env:{SYNAPSE_API_WEITERLEITUNG_IDLE_MS:'-1'},cfg}),250);
  for(const value of [0,-1,'ungueltig',2.5,2147483648]){
    assert.equal(mod.weiterleitungsIdleMsAusConfig({env:{},cfg:{api_weiterleitung_idle_ms:value}}),1000);
  }
  assert.equal(mod.weiterleitungsIdleMsAusConfig({env:{},cfg:{}}),1000);
});

test('1b Tray-Zugang: ohne Header einsetzen, Rotation lesen, agent_id und Body unveraendert; keine Secrets im Log',async()=>{
  const api=await fakeApi('tray').start();offen.push(()=>api.stop());
  const logs=[];let token='synthetischer-tray-zugang-1',gelesen=0;
  const {w,port}=await weiterleitung([api.url],{trayToken:()=>{gelesen++;return token;},log:m=>logs.push(m)});
  const body=JSON.stringify({jsonrpc:'2.0',method:'tools/call',params:{name:'plan',arguments:{agent_id:'sol-25-test'}}});
  // /hop antwortet ohne Authorization-Echo, der Zugang bleibt nur serverseitig sichtbar.
  let r=await anfrage(port,{method:'POST',path:'/hop',body,headers:{'content-type':'application/json'}});
  assert.equal(r.status,200);
  assert.equal(api.seen.at(-1).authorization,'Bearer synthetischer-tray-zugang-1');
  assert.equal(api.seen.at(-1).body,body);
  assert.equal(gelesen,1);
  token='synthetischer-tray-zugang-2';
  r=await anfrage(port,{path:'/hop'});
  assert.equal(api.seen.at(-1).authorization,'Bearer synthetischer-tray-zugang-2');
  assert.equal(gelesen,2);
  assert.ok(!r.text.includes(token));
  const sichtbares=JSON.stringify({logs,status:w.status(),antwort:r});
  for(const geheim of ['synthetischer-tray-zugang-1',token,body])assert.ok(!sichtbares.includes(geheim));
});

test('1b Eigener Authorization-Header bleibt exakt erhalten, auch leer und ohne gekoppelten Tray',async()=>{
  const api=await fakeApi('eigener-zugang').start();offen.push(()=>api.stop());
  const {port}=await weiterleitung([api.url],{trayToken:()=>{throw Error('darf nicht gelesen werden');}});
  for(const authorization of ['Bearer eigener-agent-zugang','Basic YWdlbnQ6dGVzdA==','']){
    const r=await anfrage(port,{path:'/hop',headers:{authorization,connection:'authorization'}});
    assert.equal(r.status,200);
    assert.equal(api.seen.at(-1).authorization,authorization);
  }
});

test('1b Fehlender Tray-Zugang liefert Kopplungshinweis ohne Upstream-Aufruf; Schutz vor Token-Lesen',async()=>{
  const api=await fakeApi('ungekoppelt').start();offen.push(()=>api.stop());
  const {port}=await weiterleitung([api.url],{trayToken:()=>null});
  for(const path of ['/mcp','/.well-known/oauth-protected-resource']){
    const r=await anfrage(port,{method:'POST',path,body:'privater-body'});
    assert.equal(r.status,503);
    assert.equal(JSON.parse(r.text).error,'tray_nicht_gekoppelt');
    assert.match(JSON.parse(r.text).message,/Tray mit PIN koppeln/);
    assert.equal(r.headers['www-authenticate'],undefined);
  }
  assert.ok(api.seen.every(s=>s.url==='/health'));
  assert.equal((await anfrage(port,{path:'/__synapse-weiterleitung/status'})).status,200);
  let gelesen=0;
  const geschützt=await weiterleitung([api.url],{trayToken:()=>{gelesen++;return 'synthetisch';}});
  for(const origin of ['https://evil.example',`http://127.0.0.1:${geschützt.port}`,'null']){
    assert.equal((await anfrage(geschützt.port,{headers:{origin}})).status,403);
  }
  assert.equal(gelesen,0);
  // Nicht-Loopback lässt sich auf einem nur an 127.0.0.1 gebundenen Server nicht
  // als echte Remote-IP erzeugen; Handler mit Socket-Attrappe ohne echten Daemon pruefen.
  let status,payload;
  await geschützt.w.behandle({socket:{remoteAddress:'192.0.2.25'}},{
    headersSent:false,writeHead(code){status=code;},end(text){payload=JSON.parse(text);}
  });
  assert.equal(status,403);assert.equal(payload.error,'nur_lokal');assert.equal(gelesen,0);
});

test('1b Abgelehnter Tray-Zugang erzeugt keine OAuth-Schleife; eigene Anmeldung und direkte API bleiben erhalten',async()=>{
  const api=await fakeApi('oauth').start();offen.push(()=>api.stop());
  const logs=[];
  const {port}=await weiterleitung([api.url],{trayToken:()=> 'synthetischer-abgelehnter-zugang',log:m=>logs.push(m)});
  const r=await anfrage(port,{path:'/geschuetzt'});
  assert.equal(r.status,502);
  assert.equal(JSON.parse(r.text).error,'tray_anmeldung_abgelehnt');
  assert.match(JSON.parse(r.text).message,/Tray mit PIN koppeln/);
  assert.equal(r.headers['www-authenticate'],undefined);
  assert.ok(!JSON.stringify({r,logs}).includes('synthetischer-abgelehnter-zugang'));
  assert.equal(api.seen.filter(s=>s.url==='/geschuetzt').length,1,'kein Auth-Retry');
  const own=await anfrage(port,{path:'/geschuetzt',headers:{authorization:'Bearer eigener-zugang'}});
  assert.equal(own.status,401);
  assert.match(own.headers['www-authenticate'],new RegExp(`127\\.0\\.0\\.1:${port}`));
  const direkt=await anfrage(api.port,{path:'/geschuetzt'});
  assert.equal(direkt.status,401);
  assert.ok(direkt.headers['www-authenticate'].includes(api.url));
  const discovery=await anfrage(port,{path:'/.well-known/oauth-protected-resource'});
  assert.equal(discovery.status,200);
  assert.deepEqual(JSON.parse(discovery.text).authorization_servers,[`http://127.0.0.1:${port}`]);
});

test('1b Standard liest denselben Tray-Zugang wie skills-proxy aus eigener temporaerer Config',async()=>{
  const api=await fakeApi('config').start();offen.push(()=>api.stop());
  const cfg=join(root,'.synapse','file-watcher','config.json');
  await fs.mkdir(join(root,'.synapse','file-watcher'),{recursive:true});
  const {port}=await weiterleitung([api.url],{trayToken:undefined});
  try{
    for(const token of ['synthetische-config-1','synthetische-config-2']){
      await fs.writeFile(cfg,JSON.stringify({synapse_api_token:token,projekte:[]}));
      const r=await anfrage(port,{path:'/hop'});
      assert.equal(r.status,200);
      assert.equal(api.seen.at(-1).authorization,`Bearer ${token}`);
      assert.ok(!r.text.includes(token));
    }
    await fs.writeFile(cfg,'{}');
    const r=await anfrage(port,{path:'/hop'});
    assert.equal(r.status,503);
    assert.match(JSON.parse(r.text).message,/Tray mit PIN koppeln/);
  }finally{await fs.writeFile(cfg,'{}');}
});
function schalterAntwort(aktiv=true,bis=new Date(Date.now()+60_000).toISOString()){
  return {success:true,debug:true,tray_token_weiterleitung:{name:'tray_token_weiterleitung',aktiv,modus:'freigegeben',bis,dauerhaft:bis===null}};
}

test('1b Schalter: Standard AUS ist t104, kein Token-Lesen und keine Sonderantwort',async()=>{
  freigabeMod.verwerfeTrayTokenFreigabe();
  const api=await fakeApi('standard-aus').start();offen.push(()=>api.stop());
  const {w,port}=await weiterleitung([api.url],{trayFreigabe:undefined,trayToken:()=>{throw Error('darf nicht gelesen werden');}});
  const r=await anfrage(port,{path:'/hop'});
  assert.equal(r.status,200);assert.equal(api.seen.at(-1).authorization,undefined);
  const unauthorized=await anfrage(port,{path:'/geschuetzt'});
  assert.equal(unauthorized.status,401);assert.ok(unauthorized.headers['www-authenticate']);
  assert.deepEqual(w.status().tray_token,{an:false,bis:null,quelle:'standard'});
  const own=await anfrage(port,{path:'/hop',headers:{authorization:'Bearer client-eigen'}});
  assert.equal(own.status,200);assert.equal(api.seen.at(-1).authorization,'Bearer client-eigen');
});

test('1b Schalter: Produktionsstandard EIN ohne intern; AUS-Override und Ablauf fallen darauf zurueck',async()=>{
  const cfg=join(root,'.synapse','file-watcher','config.json');
  await fs.mkdir(join(root,'.synapse','file-watcher'),{recursive:true});
  freigabeMod.verwerfeTrayTokenFreigabe();
  const api=await fakeApi('produktion').start();offen.push(()=>api.stop());
  try{
    await fs.writeFile(cfg,JSON.stringify({tray_token_weiterleitung:true,synapse_api_token:'synthetisch-prod'}));
    const {w,port}=await weiterleitung([api.url],{trayFreigabe:undefined,trayToken:undefined});
    assert.deepEqual(w.status().tray_token,{an:true,bis:null,quelle:'standard'});
    assert.equal((await anfrage(port,{path:'/hop'})).status,200);
    assert.equal(api.seen.at(-1).authorization,'Bearer synthetisch-prod');
    const jetzt=Date.now(),bis=new Date(jetzt+10_000).toISOString();
    freigabeMod.uebernehmeTrayTokenFreigabe(schalterAntwort(false,bis),jetzt);
    assert.deepEqual(w.status().tray_token,{an:false,bis,quelle:'intern'});
    await anfrage(port,{path:'/hop'});
    assert.equal(api.seen.at(-1).authorization,undefined);
    assert.deepEqual(freigabeMod.trayTokenFreigabe(jetzt+10_000),{an:true,bis:null,quelle:'standard'});
    freigabeMod.uebernehmeTrayTokenFreigabe({success:true,debug:false});
    assert.equal(w.status().tray_token.quelle,'standard');assert.equal(w.status().tray_token.an,true);
  }finally{freigabeMod.verwerfeTrayTokenFreigabe();await fs.writeFile(cfg,'{}');}
});

test('1b Schalter: EIN nur frisch; Ablauf, unbekannt, Debug-AUS und Bruecke weg -> Standard',async()=>{
  const jetzt=Date.now(),bis=new Date(jetzt+1000).toISOString();
  freigabeMod.uebernehmeTrayTokenFreigabe(schalterAntwort(true,bis),jetzt);
  assert.deepEqual(freigabeMod.trayTokenFreigabe(jetzt,false),{an:true,bis,quelle:'intern'});
  assert.deepEqual(freigabeMod.trayTokenFreigabe(jetzt+1000,false),{an:false,bis:null,quelle:'standard'});
  freigabeMod.uebernehmeTrayTokenFreigabe(schalterAntwort(true,null),jetzt);
  assert.equal(freigabeMod.trayTokenFreigabe(jetzt+34_999,false).an,true);
  assert.equal(freigabeMod.trayTokenFreigabe(jetzt+35_000,false).an,false);
  for(const antwort of [{success:true,debug:false},{success:true,debug:true},'nicht_gefunden',
    {success:true,debug:true,tray_token_weiterleitung:{name:'unbekannt',aktiv:true,modus:'freigegeben',bis}}]){
    freigabeMod.uebernehmeTrayTokenFreigabe(schalterAntwort(true,null),jetzt);
    freigabeMod.uebernehmeTrayTokenFreigabe(antwort,jetzt);
    assert.equal(freigabeMod.trayTokenFreigabe(jetzt,false).an,false);
    assert.equal(freigabeMod.trayTokenFreigabe(jetzt,true).an,true);
    assert.equal(freigabeMod.trayTokenFreigabe(jetzt,true).quelle,'standard');
  }
  freigabeMod.uebernehmeTrayTokenFreigabe(schalterAntwort(true,null),jetzt);
  freigabeMod.verwerfeTrayTokenFreigabe();
  assert.equal(freigabeMod.trayTokenFreigabe(jetzt,false).an,false);
  assert.equal(freigabeMod.standardTrayTokenWeiterleitung({},{}),false);
  assert.equal(freigabeMod.standardTrayTokenWeiterleitung({},{tray_token_weiterleitung:true}),true);
  assert.equal(freigabeMod.standardTrayTokenWeiterleitung({SYNAPSE_TRAY_TOKEN_WEITERLEITUNG:'0'},{tray_token_weiterleitung:true}),false);
  assert.equal(freigabeMod.standardTrayTokenWeiterleitung({SYNAPSE_TRAY_TOKEN_WEITERLEITUNG:'1'},{}),true);
});

test('1b Intern-Bruecke uebernimmt Long-Poll-Stand und verwirft ihn bei Offline/Debug-AUS/Stop',async()=>{
  const {startInternBruecke}=await import(pathToFileURL(join(dist,'intern-bruecke.js')));
  const cfg=join(root,'.synapse','file-watcher','config.json');
  await fs.mkdir(join(root,'.synapse','file-watcher'),{recursive:true});
  await fs.writeFile(cfg,JSON.stringify({synapse_api_url:'http://p9-t28-fake.invalid',synapse_api_token:'synthetisch-bruecke'}));
  const originalFetch=globalThis.fetch;
  const bisErfuellt=async(fn)=>{const ende=Date.now()+2000;while(!fn()&&Date.now()<ende)await new Promise(r=>setTimeout(r,5));assert.ok(fn());};
  try{
    for(const ausfall of ['offline','debug-aus','stop']){
      let polls=0,wartend;
      globalThis.fetch=async(url,init)=>{
        assert.ok(String(url).startsWith('http://p9-t28-fake.invalid/api/intern/daemon/'));
        if(init.method==='POST')return new Response(JSON.stringify({success:true,debug:true}));
        if(++polls===1)return new Response(JSON.stringify({...schalterAntwort(),befehle:[]}));
        return new Promise((resolve,reject)=>{
          wartend={resolve,reject};
          init.signal.addEventListener('abort',()=>reject(new Error('abgebrochen')),{once:true});
        });
      };
      const bruecke=startInternBruecke();
      try{
        await bisErfuellt(()=>freigabeMod.trayTokenFreigabe().an&&wartend);
        if(ausfall==='offline')wartend.reject(new Error('synthetisch-offline'));
        else if(ausfall==='debug-aus')wartend.resolve(new Response(JSON.stringify({success:true,debug:false})));
        else bruecke.stop();
        await bisErfuellt(()=>freigabeMod.trayTokenFreigabe().an===false);
        assert.equal(freigabeMod.trayTokenFreigabe().quelle,'standard');
      }finally{bruecke.stop();}
    }
  }finally{globalThis.fetch=originalFetch;freigabeMod.verwerfeTrayTokenFreigabe();await fs.writeFile(cfg,'{}');}
});


