/** P9-T30 Testphase (Daemon): virtuelle Projekte nie uebernehmen, geloeschte Ordner nie neu anlegen,
 * host_loesen-Worker gegen Fake-API. Ohne Datenbank (DATABASE_URL entfernt, getPool per mitLesePool auf einen
 * Fake-Pool), eigene mkdtemp-Wurzel als HOME und Workspace, kein echter Daemon, keine echte config.json.
 * Positivkontrolle gegen die Basis: T30_MODULE_ROOT=<basis>/packages/file-watcher-daemon-ts/dist/ */
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join} from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const dist=process.env.T30_MODULE_ROOT??new URL('../dist/',import.meta.url).pathname;
const VIRT='reverse-bibliothek';
let root,dev,cfgPath,core,WatcherManager,loadConfig,startEnabledSync;
const managers=[];
before(async()=>{
 delete process.env.DATABASE_URL;delete process.env.SYNAPSE_DATABASE_URL;delete process.env.SYNAPSE_VIRTUELLE_PROJEKTE;
 // P9-T27 Welle 2: ohne DATABASE_URL waehlt der Daemon jetzt automatisch den API-Weg. Dieser Test prueft den
 // PG-Weg der enabled-sync-Abfrage (Fake-Pool) -> Rueckfall-Schalter ausdruecklich auf pg setzen.
 process.env.SYNAPSE_DAEMON_JOBS_WEG='pg';
 root=fs.mkdtempSync(join(os.tmpdir(),'p9-t30-'));
 dev=join(root,'dev');fs.mkdirSync(dev);
 process.env.HOME=root;process.env.SYNAPSE_WORKSPACE_ROOT=join(root,'ws');
 process.env.ENABLED_SYNC_INTERVAL_MS='3600000';
 core=await import(pathToFileURL(join(dist,'..','node_modules','@synapse','core','dist','index.js')));
 core={...core,...await import(pathToFileURL(join(dist,'..','node_modules','@synapse','core','dist','db','client.js')))};
 ({WatcherManager}=await import(pathToFileURL(join(dist,'manager.js'))));
 ({loadConfig}=await import(pathToFileURL(join(dist,'config.js'))));
 ({startEnabledSync}=await import(pathToFileURL(join(dist,'enabled-sync.js'))));
 cfgPath=join(root,'.synapse','file-watcher','config.json');
});
after(async()=>{
 for(const m of managers){await m.stopAll().catch(()=>{});await m.assetSync.stopAll?.();}
 delete process.env.SYNAPSE_WORKSPACE_ROOT;
 if(root)fs.rmSync(root,{recursive:true,force:true});
});
const da=(p)=>fs.existsSync(p);
function schreibeConfig(projekte){
 fs.mkdirSync(join(root,'.synapse','file-watcher'),{recursive:true});
 fs.writeFileSync(cfgPath,JSON.stringify({port:0,synapse_api_url:'http://127.0.0.1:9',projekte,asset_sync:{aktiv:false}},null,2));
}
const disk=()=>JSON.parse(fs.readFileSync(cfgPath,'utf8'));
function neuerManager(){const m=new WatcherManager(loadConfig());managers.push(m);return m;}
function ordner(name){const p=join(dev,name);fs.mkdirSync(p,{recursive:true});return p;}

test('enabled-sync: virtuelle Projekte (Name oder /virtual/*) nie in config.json, keine status.json; geloeschter Ordner bleibt weg; deaktiviert ohne Status bleibt ohne Status',async()=>{
 const virtOrdner=ordner(VIRT);
 const aktiv=ordner('p9t30-aktiv'),neu=ordner('p9t30-neu');
 const weg=join(dev,'p9t30-weg'),ausWeg=join(dev,'p9t30-aus-weg');
 schreibeConfig([{name:'p9t30-aktiv',pfad:aktiv,enabled:true},{name:'p9t30-weg',pfad:weg,enabled:true}]);
 const m=neuerManager();
 const rows=[
  {name:VIRT,path:virtOrdner,enabled:true,setup_phase:null},
  {name:VIRT,path:'/virtual/rest-api',enabled:true,setup_phase:null},
  {name:'p9t30-virtpfad',path:'/virtual/rest-api',enabled:true,setup_phase:null},
  {name:'p9t30-aktiv',path:aktiv,enabled:true,setup_phase:'initial-done'},
  {name:'p9t30-neu',path:neu,enabled:false,setup_phase:null},
  {name:'p9t30-weg',path:weg,enabled:true,setup_phase:null},
  {name:'p9t30-aus-weg',path:ausWeg,enabled:false,setup_phase:null},
 ];
 let abfragen=0;
 const fakePool={query:async(sql)=>{abfragen++;assert.match(String(sql),/FROM projects/);return {rows:rows.map(r=>({...r}))};},connect:async()=>{throw new Error('kein connect erwartet');}};
 let handle;
 await core.mitLesePool(fakePool,async()=>{handle=startEnabledSync(m);});
 for(let i=0;i<100&&abfragen===0;i++)await new Promise(r=>setTimeout(r,10));
 await new Promise(r=>setTimeout(r,50));
 handle.stop();
 assert.equal(abfragen,1);
 const namen=disk().projekte.map(p=>p.name).sort();
 assert.deepEqual(namen,['p9t30-aktiv','p9t30-neu','p9t30-weg']);
 assert.equal(m.get(VIRT),undefined);assert.equal(m.get('p9t30-virtpfad'),undefined);
 assert.equal(da(join(virtOrdner,'.synapse')),false,'virtuelles Projekt bekommt keine status.json');
 assert.equal(da('/virtual'),false);
 assert.equal(da(weg),false,'geloeschter Projektordner wird nicht neu angelegt');
 assert.equal(da(ausWeg),false);
 assert.equal(da(join(neu,'.synapse')),false,'deaktiviertes Projekt ohne Status bekommt keine neue status.json');
 const st=JSON.parse(fs.readFileSync(join(aktiv,'.synapse','status.json'),'utf8'));
 assert.equal(st.project,'p9t30-aktiv');assert.equal(st.status,'active');assert.equal(st.setupPhase,'initial-done');
 assert.equal(m.isRunning('p9t30-neu'),false);
});

test('setProjectStatus: fehlender Ordner wird nie angelegt, vorhandener bekommt status.json',()=>{
 const weg=join(dev,'p9t30-status-weg');
 core.setProjectStatus(weg,{project:'p9t30-status-weg',status:'stopped'});
 assert.equal(da(weg),false);
 const da1=ordner('p9t30-status-da');
 core.setProjectStatus(da1,{project:'p9t30-status-da',status:'stopped'});
 assert.equal(core.getProjectStatus(da1).status,'stopped');
});

test('manager: virtuelles Projekt nie registrieren/wiederherstellen/starten; fehlender Ordner startet keinen Watcher',async()=>{
 schreibeConfig([]);
 const m=neuerManager(),virtOrdner=ordner(VIRT);
 await assert.rejects(m.register(VIRT,virtOrdner),/virtuelles API-Projekt/);
 await assert.rejects(m.registerRestored(VIRT,virtOrdner),/restore_virtuelles_projekt/);
 assert.throws(()=>m.spawnWatcher({name:VIRT,pfad:virtOrdner,enabled:true}),/virtuelles API-Projekt/);
 m.discoverFromRegistry([{name:VIRT,pfad:virtOrdner,enabled:false},{name:'p9t30-vp',pfad:'/virtual/rest-api',enabled:false}]);
 assert.deepEqual(m.list(),[]);assert.deepEqual(disk().projekte,[]);
 const weg=join(dev,'p9t30-spawn-weg');
 assert.throws(()=>m.spawnWatcher({name:'p9t30-spawn-weg',pfad:weg,enabled:true}),/fehlt/);
 assert.equal(da(weg),false);assert.equal(m.isRunning('p9t30-spawn-weg'),false);
 await m.startAllEnabled();
 assert.equal(da(join(virtOrdner,'.synapse')),false);
});

test('Restore-/Init-Worker: virtuelles Projekt wird abgelehnt, bevor irgendein Ordner entsteht',async()=>{
 const {restoreExistingProject}=await import(pathToFileURL(join(dist,'project-restore-worker.js')));
 const {initializeProject}=await import(pathToFileURL(join(dist,'project-init-worker.js')));
 const ws=process.env.SYNAPSE_WORKSPACE_ROOT;
 const api={json:async()=>{throw new Error('kein API-Aufruf erwartet');},request:async()=>{throw new Error('kein Download erwartet');}};
 const manager={isRunning:()=>false,registerRestored:async()=>{throw new Error('kein registerRestored erwartet');}};
 await assert.rejects(restoreExistingProject({id:randomUUID(),name:VIRT,hostname:os.hostname(),mode:'restore_existing',restore_lease:randomUUID()},manager,api),/restore_virtuelles_projekt/);
 await assert.rejects(initializeProject({id:randomUUID(),name:VIRT,hostname:os.hostname(),mode:'create',template:null},manager),e=>e.rejectReason==='virtuelles_projekt');
 assert.equal(da(ws),false,'Workspace-Wurzel blieb unangetastet');
});

test('host-loesen-Worker (Fake-API): entfernt nur config.json-Eintrag, Ordner bleibt, meldet done/failed',async()=>{
 const {verarbeiteHostLoesungen,startHostLoesenWorker}=await import(pathToFileURL(join(dist,'host-loesen-worker.js')));
 const {AssetApiFehler}=await import(pathToFileURL(join(dist,'asset-api-transport.js')));
 const a=ordner('p9t30-loesen-a'),b=ordner('p9t30-loesen-b');
 schreibeConfig([{name:'p9t30-loesen-a',pfad:a,enabled:false},{name:'p9t30-loesen-b',pfad:b,enabled:false}]);
 const m=neuerManager();
 const id1=randomUUID(),id2=randomUUID(),aufrufe=[];
 const api={json:async(url,body)=>{
  aufrufe.push({url,body});
  if(url==='/api/project-init/host-loesen/claim')return {success:true,jobs:aufrufe.length===1?[{id:id1,name:'p9t30-loesen-a'},{id:id2,name:'p9t30-unbekannt'}]:[]};
  if(url.endsWith('/complete'))return {success:true};
  throw new Error('unerwartete Route '+url);
 }};
 assert.equal(await verarbeiteHostLoesungen(m,api),2);
 assert.deepEqual(disk().projekte.map(p=>p.name),['p9t30-loesen-b']);
 assert.equal(da(a),true,'Projektordner bleibt auf der Platte');
 const fertig=aufrufe.filter(x=>x.url.endsWith('/complete'));
 assert.deepEqual(fertig.map(x=>[x.url,x.body.status]),[
  ['/api/project-init/host-loesen/'+id1+'/complete','done'],
  ['/api/project-init/host-loesen/'+id2+'/complete','done'],
 ]);
 assert.match(fertig[0].body.message,/config\.json-Eintrag entfernt/);assert.match(fertig[1].body.message,/Kein config\.json-Eintrag/);
 // Fehler beim Entfernen -> failed + error daemon_fehler, config bleibt
 const id3=randomUUID(),meldung=[];
 const kaputt={get:()=>({name:'p9t30-loesen-b',pfad:b}),unregister:async()=>{throw new Error('fixture-fehler');}};
 await verarbeiteHostLoesungen(kaputt,{json:async(url,body)=>{meldung.push({url,body});return url.endsWith('/claim')?{jobs:[{id:id3,name:'p9t30-loesen-b'}]}:{success:true};}});
 assert.deepEqual(meldung[1].body,{status:'failed',message:'fixture-fehler',error:'daemon_fehler'});
 assert.deepEqual(disk().projekte.map(p=>p.name),['p9t30-loesen-b']);
 // Alte API ohne Route (404) -> Worker bleibt still und laeuft weiter
 let claims=0;
 const w=startHostLoesenWorker(m,{json:async()=>{claims++;throw new AssetApiFehler(404,'nicht_gefunden','fixture');}},3600000);
 await w.stop();assert.equal(claims,1);
});
