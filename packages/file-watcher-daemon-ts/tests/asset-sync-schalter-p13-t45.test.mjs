/** P13-T45: Tray-Schalter Asset-Sync je Projekt — Daemon-Endpunkt + Manager-Neustart der Bindung.
 * Ohne Datenbank (DATABASE_URL wird entfernt), eigene mkdtemp-Wurzel als HOME, keine echte config.json. */
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
const dist=process.env.T45_MODULE_ROOT??new URL('../dist/',import.meta.url).pathname;
let root,cfgPath,WatcherManager,buildApi,loadConfig;
const apps=[],manager=[];
before(async()=>{
 delete process.env.DATABASE_URL;delete process.env.SYNAPSE_DATABASE_URL;
 root=await fs.mkdtemp(join(tmpdir(),'p13-t45-'));
 process.env.HOME=root;
 ({WatcherManager}=await import(pathToFileURL(join(dist,'manager.js'))));
 ({buildApi}=await import(pathToFileURL(join(dist,'api.js'))));
 ({loadConfig}=await import(pathToFileURL(join(dist,'config.js'))));
 cfgPath=join(root,'.synapse','file-watcher','config.json');
});
after(async()=>{
 for(const a of apps)await a.close();
 for(const m of manager)await m.assetSync.stopAll?.();
 if(root)await fs.rm(root,{recursive:true,force:true});
});
const basis=()=>({port:7878,synapse_api_url:'http://127.0.0.1:9',synapse_api_token:'nur-test',fremd:{tief:[1,'x']},
 projekte:[{name:'t45a',pfad:root,enabled:false,file_count:3,asset_sync:{verwaltet:true,host:'h1',richtung:'both'}},{name:'t45b',pfad:root,enabled:false}]});
async function schreibe(cfg){await fs.mkdir(join(root,'.synapse','file-watcher'),{recursive:true});await fs.writeFile(cfgPath,JSON.stringify(cfg,null,2));}
const disk=async()=>JSON.parse(await fs.readFile(cfgPath,'utf8'));
function fakeSync(){
 const calls=[];
 return {calls,async stop(n){calls.push('stop:'+n);await new Promise(r=>setTimeout(r,20));calls.push('gestoppt:'+n);},
  starte(p){calls.push('starte:'+p.name+':'+p.asset_sync?.aktiv);},async status(){return {modus:'legacy'};},async stopAll(){}};
}
async function neu({fake=true}={}){
 const m=new WatcherManager(loadConfig());manager.push(m);
 let f;if(fake){f=fakeSync();m.assetSync=f;}
 const app=buildApi({manager:m});apps.push(app);return {m,app,f};
}

test('Endpunkt setzt aktiv, Fremdfelder bleiben, ohne laufenden Watcher kein Neustart',async()=>{
 await schreibe(basis());
 const {app,f}=await neu();
 const r=await app.inject({method:'POST',url:'/projects/t45a/asset-sync',payload:{aktiv:true}});
 assert.equal(r.statusCode,200,r.body);
 assert.deepEqual(r.json(),{ok:true,name:'t45a',aktiv:true,neu_gestartet:false});
 const d=await disk();
 assert.equal(d.synapse_api_token,'nur-test');assert.deepEqual(d.fremd,{tief:[1,'x']});
 assert.deepEqual(d.projekte[0].asset_sync,{aktiv:true,richtung:'both',verwaltet:true,host:'h1'});
 assert.equal(d.projekte[0].file_count,3);assert.equal(d.projekte[1].asset_sync,undefined);
 assert.deepEqual(f.calls,[]);
 const list=(await app.inject({method:'GET',url:'/projects'})).json().projekte;
 assert.equal(list.find(p=>p.name==='t45a').asset_sync_aktiv,true);
 // P22-T238 (thought d59f32e8): ohne asset_sync-Feld gilt Standard EIN.
 assert.equal(list.find(p=>p.name==='t45b').asset_sync_aktiv,true);
});

test('laufender Watcher: nur die Asset-Bindung dieses Projekts startet neu, schnelle Klicks nacheinander',async()=>{
 await schreibe(basis());
 const {m,app,f}=await neu();
 let watcherGestoppt=0;
 m.instances.set('t45a',{stop:async()=>{watcherGestoppt++;}});
 m.instances.set('t45b',{stop:async()=>{watcherGestoppt++;}});
 const [a,b]=await Promise.all([
  app.inject({method:'POST',url:'/projects/t45a/asset-sync',payload:{aktiv:true}}),
  app.inject({method:'POST',url:'/projects/t45a/asset-sync',payload:{aktiv:false}}),
 ]);
 assert.equal(a.json().neu_gestartet,true);assert.equal(b.json().neu_gestartet,true);
 assert.deepEqual(f.calls,['stop:t45a','gestoppt:t45a','starte:t45a:true','stop:t45a','gestoppt:t45a','starte:t45a:false']);
 assert.equal(watcherGestoppt,0,'Datei-Watcher darf nicht gestoppt werden');
 assert.equal((await disk()).projekte[0].asset_sync.aktiv,false);
 assert.equal(m.get('t45a').asset_sync.aktiv,false);
 m.instances.clear();
});

test('Fehlerfaelle aendern config.json nicht',async()=>{
 await schreibe(basis());
 const vorher=await fs.readFile(cfgPath,'utf8');
 const {app,f}=await neu();
 const faelle=[
  [{url:'/projects/t45a/asset-sync',payload:{}},400],
  [{url:'/projects/t45a/asset-sync',payload:{aktiv:'ja'}},400],
  [{url:'/projects/t45a/asset-sync',payload:[true]},400],
  [{url:'/projects/fehlt/asset-sync',payload:{aktiv:true}},404],
  [{url:'/projects/t45a/asset-sync',payload:{aktiv:true},headers:{origin:'http://evil.example'}},403],
  [{url:'/projects/t45a/asset-sync',payload:{aktiv:true},remoteAddress:'192.168.1.20'},403],
 ];
 for(const [req,code] of faelle){
  const r=await app.inject({method:'POST',...req});
  assert.equal(r.statusCode,code,JSON.stringify(req)+' -> '+r.body);assert.equal(r.json().ok,false);
 }
 assert.equal(await fs.readFile(cfgPath,'utf8'),vorher);assert.deepEqual(f.calls,[]);
});

test('echte DaemonAssetSync: Ausschalten startet die Bindung im Legacy-Modus ohne API-Aufruf neu',async()=>{
 const cfg=basis();cfg.projekte[0].enabled=true;cfg.projekte[0].asset_sync.aktiv=true;await schreibe(cfg);
 const {m,app}=await neu({fake:false});
 let apiAufrufe=0;m.assetSync.api.json=async()=>{apiAufrufe++;throw new Error('kein API-Aufruf erwartet');};
 m.instances.set('t45a',{stop:async()=>{}});
 const r=await app.inject({method:'POST',url:'/projects/t45a/asset-sync',payload:{aktiv:false}});
 assert.equal(r.statusCode,200,r.body);assert.equal(r.json().neu_gestartet,true);
 const st=await app.inject({method:'GET',url:'/projects/t45a/assets/status'});
 assert.equal(st.json().modus,'legacy');assert.equal(apiAufrufe,0);
 m.instances.clear();await m.assetSync.stopAll();
});
