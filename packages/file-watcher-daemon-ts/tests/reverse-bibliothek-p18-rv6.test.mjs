/** P18-T16/RV6: Reverse-Bibliotheks-Watcher gegen eine Fake-API auf Loopback; nur synthetische Dateien in eigenem Temp-Ordner, HOME umgelenkt. */
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
const base=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'p18-rv6-')));
process.env.HOME=join(base,'home');await fs.mkdir(process.env.HOME);
const dist=new URL('../dist/',import.meta.url).pathname;
const {DaemonReverseBibliothek:Bib}=await import(pathToFileURL(join(dist,'reverse-bibliothek.js')));
const {AssetApiTransport:Transport}=await import(pathToFileURL(join(dist,'asset-api-transport.js')));
const C=await import(pathToFileURL(join(dist,'config.js')));
const sha=b=>createHash('sha256').update(b).digest('hex');
async function until(fn,label,ms=10000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,15));}throw Error('Timeout '+label);}
const bibs=new Set(),servers=new Set();
after(async()=>{
 for(const b of bibs)await b.stop().catch(()=>{});
 for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}
 await fs.rm(base,{recursive:true,force:true});
});
async function fake({feature=true,policy={},onChunk,policyStatus}={}){
 const st={known:new Map(),sessions:new Map(),announced:[],abgemeldet:[],chunks:[],finals:0,policyCalls:0,batches:[]};
 const json=(r,v,s=200)=>{r.writeHead(s,{'content-type':'application/json'});r.end(JSON.stringify(v));};
 const body=async req=>{let raw='';for await(const c of req)raw+=c;return raw?JSON.parse(raw):{};};
 const server=createServer(async(req,res)=>{try{
  const u=new URL(req.url,'http://fixture');
  if(u.pathname==='/api/projects'){json(res,{projects:[],activeWatchers:[],capabilities:{contractVersion:1,features:feature?['reverse_bibliothek']:[]}});return;}
  if(u.pathname==='/api/reverse/sync-optionen'){st.policyCalls++;if(policyStatus){json(res,{success:false,error:{code:'deaktiviert',message:'Reverse ist deaktiviert.'}},policyStatus);return;}json(res,{success:true,host:'rv6-host',chunkBytes:1024,timeoutMs:5000,retryMs:20,scanMs:60000,maxDateiBytes:1<<24,parallelTransfers:2,maxBatch:10,stabilMs:60,loesch_verhalten:'behalten',erlaubt_alle_dateien:true,...policy});return;}
  if(u.pathname==='/api/reverse/fundstellen'&&req.method==='POST'){
   const b=await body(req);st.batches.push(b.dateien.length);const out=[];
   for(const d of b.dateien){
    st.announced.push(d);
    if(st.known.has(d.sha256)){out.push({rel_pfad:d.rel_pfad,status:'bekannt',reverse_id:'rv-bekannt'});continue;}
    let s=[...st.sessions.values()].find(x=>x.sha256===d.sha256&&x.status!=='finalisiert');
    if(!s){s={id:randomUUID(),rid:'rv-'+d.sha256.slice(0,8),sha256:d.sha256,groesse:d.groesse,offset:0,status:'laeuft',lease_bis:new Date(Date.now()+60000).toISOString(),parts:[]};st.sessions.set(s.id,s);}
    out.push({rel_pfad:d.rel_pfad,status:'upload_noetig',upload_id:s.id,ziel_ref:s.rid,offset:s.offset,reverse_id:s.rid});
   }
   json(res,{success:true,dateien:out,reverse_ids:[]});return;
  }
  if(u.pathname==='/api/reverse/fundstellen/abmelden'){const b=await body(req);st.abgemeldet.push(...b.dateien);json(res,{success:true,dateien:b.dateien.map(d=>({...d,ergebnis:'gesetzt'}))});return;}
  const m=u.pathname.match(/^\/api\/reverse\/([^/]+)\/uploads\/([^/]+)(\/chunk|\/finalisieren)?$/),s=m&&st.sessions.get(m[2]);
  if(m&&(!s||s.rid!==m[1])){json(res,{error:{code:'nicht_gefunden',message:'Sitzung'}},404);return;}
  if(m&&m[3]==='/chunk'){
   const parts=[];for await(const c of req)parts.push(c);const b=Buffer.concat(parts),off=Number(u.searchParams.get('offset'));
   if(onChunk&&await onChunk(s,off,st)){json(res,{error:{code:'offline',message:'offline'}},503);return;}
   if(off!==s.offset){json(res,{error:{code:'offset_konflikt',message:'offset'}},409);return;}
   s.parts.push(b);s.offset+=b.length;st.chunks.push({id:s.id,off,len:b.length});
   json(res,{success:true,upload:{id:s.id,offset:s.offset,status:s.status,lease_bis:s.lease_bis}});return;
  }
  if(m&&m[3]==='/finalisieren'){
   const all=Buffer.concat(s.parts);
   if(sha(all)!==s.sha256||all.length!==s.groesse){json(res,{error:{code:'hash_falsch',message:'hash'}},409);return;}
   s.status='finalisiert';st.known.set(s.sha256,all);st.finals++;
   json(res,{success:true,upload:{id:s.id,offset:s.offset,status:'finalisiert',lease_bis:s.lease_bis,asset_id:s.sha256,revision:'1'}});return;
  }
  if(m){json(res,{success:true,upload:{id:s.id,offset:s.offset,status:s.status,lease_bis:s.lease_bis}});return;}
  json(res,{error:{code:'not_found',message:u.pathname}},404);
 }catch(e){json(res,{error:{code:'fixture',message:e.message}},500);}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));servers.add(server);
 const url='http://127.0.0.1:'+server.address().port;
 return {st,api:new Transport(fetch,()=>({token:'fixture-only',basen:[url]}))};
}
async function lib(){const p=join(base,'lib-'+randomUUID());await fs.mkdir(p);return p;}
function bib(pfad,api,extra={},zustand){
 const config={port:0,synapse_api_url:'x',projekte:extra.projekte??[],reverse_bibliothek:{aktiv:true,...(pfad?{pfad}:{}),...extra.rb}};
 const b=new Bib(()=>config,api,()=>{},{zustandsDir:zustand??join(base,'state-'+randomUUID()),tickMs:20});bibs.add(b);return b;
}
const daten=(n,seed)=>{const b=Buffer.alloc(n);for(let i=0;i<n;i++)b[i]=(i*31+seed*7)&255;return b;};
const warte=ms=>new Promise(r=>setTimeout(r,ms));

test('Modul vorhanden (Positivkontrolle gegen Altstand ohne reverse-bibliothek.js)',()=>{assert.equal(typeof Bib,'function');assert.equal(typeof C.normalizeReverseBibliothek,'function');});

test('Erstscan mit Unterordnern, grosses Image stueckweise, Ordner-Medium mit vielen kleinen Dateien',async()=>{
 const p=await lib(),f=await fake();
 await fs.mkdir(join(p,'Spiel','Daten'),{recursive:true});
 const gross=daten(5000,1);await fs.writeFile(join(p,'Spiel','cd1.iso'),gross);
 for(let i=0;i<25;i++)await fs.writeFile(join(p,'Spiel','Daten','d'+i+'.dat'),daten(10+i,i+3));
 await fs.writeFile(join(p,'oben.bin'),daten(300,99));
 const b=bib(p,f.api);await b.starte();
 await until(()=>f.st.finals===27,'alle hochgeladen');
 await until(async()=>(await b.status()).auftraege.length===0,'Queue leer');
 const s=await b.status();
 assert.equal(s.modus,'api');assert.equal(s.aktiv,true);assert.equal(s.pfad,p);assert.equal(s.erkannt,27);assert.equal(s.wartend_stabil,0);
 assert.equal(s.policy.host,'rv6-host');
 const gs=[...f.st.sessions.values()].find(x=>x.sha256===sha(gross));
 assert.ok(f.st.chunks.filter(c=>c.id===gs.id).length>3,'mehr als 3 Chunks');
 assert.deepEqual(Buffer.concat(gs.parts),gross);
 assert.ok(f.st.batches.every(n=>n<=10),'Batches <= maxBatch');
 assert.ok(f.st.announced.some(d=>d.rel_pfad==='Spiel/Daten/d3.dat'));
 assert.ok(!(await fs.readdir(p)).includes('.synapse'),'kein Zustand im Benutzerordner');
});

test('Neustart mitten im Upload setzt dieselbe Sitzung am Serveroffset fort',async()=>{
 const p=await lib(),gross=daten(6000,3);await fs.writeFile(join(p,'disc.iso'),gross);
 let blockieren=true;const f=await fake({onChunk:async(s,off)=>blockieren&&off>=2048});
 const zustand=join(base,'state-'+randomUUID());
 let b=bib(p,f.api,{},zustand);await b.starte();
 await until(()=>f.st.chunks.length===2,'zwei Chunks');
 await until(async()=>(await b.status()).auftraege.some(j=>j.fehler&&j.bytes_erledigt===2048),'Fehler sichtbar');
 await b.stop();bibs.delete(b);assert.equal(f.st.finals,0);
 blockieren=false;
 b=bib(p,f.api,{},zustand);await b.starte();
 await until(()=>f.st.finals===1,'fortgesetzt');
 assert.equal(f.st.sessions.size,1);
 assert.deepEqual(f.st.chunks.map(c=>c.off),[0,1024,2048,3072,4096,5120]);
 assert.equal((await fs.stat(zustand)).mode&0o777,0o700);
});

test('Umbenennen ohne Neu-Upload meldet fehlt; lokales Loeschen meldet geloescht_lokal',async()=>{
 const p=await lib(),f=await fake();await fs.mkdir(join(p,'A'));
 const x=daten(700,5),y=daten(800,6);await fs.writeFile(join(p,'A','x.bin'),x);await fs.writeFile(join(p,'A','y.bin'),y);
 const b=bib(p,f.api);await b.starte();await until(()=>f.st.finals===2,'Upload');
 await fs.rename(join(p,'A','x.bin'),join(p,'A','x-neu.bin'));
 await fs.unlink(join(p,'A','y.bin'));
 await until(()=>f.st.abgemeldet.length===2,'abgemeldet');
 const ab=[...f.st.abgemeldet].sort((a,c)=>a.rel_pfad.localeCompare(c.rel_pfad));
 assert.deepEqual(ab,[{rel_pfad:'A/x.bin',status:'fehlt'},{rel_pfad:'A/y.bin',status:'geloescht_lokal'}]);
 assert.ok(f.st.announced.some(d=>d.rel_pfad==='A/x-neu.bin'&&d.sha256===sha(x)));
 assert.equal(f.st.sessions.size,2);assert.equal(f.st.finals,2);
 const s=await b.status();assert.equal(s.erkannt,1);
});

test('Wachsende Datei (halbe Kopie) wird erst nach Stabilitaet gehasht und gemeldet',async()=>{
 const p=await lib(),f=await fake();const b=bib(p,f.api);await b.starte();
 const h=await fs.open(join(p,'wachsend.iso'),'w');const teile=[];
 for(let i=0;i<12;i++){const t=daten(512,i);teile.push(t);await h.write(t);await warte(25);}
 await h.close();
 const voll=Buffer.concat(teile);
 await until(()=>f.st.finals===1,'stabil hochgeladen');
 const gemeldet=f.st.announced.filter(d=>d.rel_pfad==='wachsend.iso');
 assert.ok(gemeldet.length>=1);
 assert.ok(gemeldet.every(d=>d.sha256===sha(voll)&&d.groesse===voll.length),'nie ein Teilstand gemeldet');
});

test('.synapse-tmp-* (Tray-Zurueckholen) wird komplett ignoriert: kein Hash, keine Fundstelle, kein Upload',async()=>{
 const p=await lib(),f=await fake();
 await fs.writeFile(join(p,'.synapse-tmp-erstscan'),daten(100,1));await fs.mkdir(join(p,'Unter'));
 const zurueck=daten(200,2);f.st.known.set(sha(zurueck),zurueck);
 const b=bib(p,f.api);await b.starte();
 await fs.writeFile(join(p,'Unter','.synapse-tmp-xyz'),zurueck);
 await fs.writeFile(join(p,'echt.bin'),daten(300,3));
 await until(()=>f.st.finals===1,'echte Datei');
 await warte(300);
 assert.ok(f.st.announced.every(d=>!d.rel_pfad.includes('.synapse-tmp-')));
 let s=await b.status();assert.equal(s.erkannt,1);assert.equal(s.wartend_stabil,0);
 await fs.rename(join(p,'Unter','.synapse-tmp-xyz'),join(p,'Unter','zurueck.bin'));
 await until(()=>f.st.announced.some(d=>d.rel_pfad==='Unter/zurueck.bin'),'nach atomarem Verschieben gemeldet');
 await warte(150);
 assert.equal(f.st.sessions.size,1,'zurueckgeholte Datei ist bekannt, kein Upload');
 s=await b.status();assert.equal(s.erkannt,2);
});

test('Feature reverse_bibliothek fehlt: modus offen, keine Policy, keine Meldung',async()=>{
 const p=await lib(),f=await fake({feature:false});await fs.writeFile(join(p,'a.bin'),daten(10,1));
 const b=bib(p,f.api);await b.starte();
 await until(async()=>{const s=await b.status();return s.modus==='offen'&&!!s.fehler;},'offen');
 await warte(250);
 assert.equal(f.st.policyCalls,0);assert.equal(f.st.announced.length,0);
});

test('Wurzelpruefung: $HOME, Projektueberschneidung, Symlink, inaktiv, Standardpfad aus os.homedir()',async()=>{
 const f=await fake();
 let b=bib(process.env.HOME,f.api);await b.starte();assert.equal((await b.status()).modus,'fehler');
 const p=await lib();await fs.mkdir(join(p,'sub'));
 b=bib(join(p,'sub'),f.api,{projekte:[{name:'proj_x',pfad:p,enabled:true}]});await b.starte();
 let s=await b.status();assert.equal(s.modus,'fehler');assert.match(s.fehler,/proj_x/);
 const link=join(base,'link-'+randomUUID());await fs.symlink(p,link);
 b=bib(link,f.api);await b.starte();assert.match((await b.status()).fehler,/pfad_ungueltig/);
 b=bib(join(base,'gibtsnicht-'+randomUUID()),f.api);await b.starte();assert.match((await b.status()).fehler,/pfad_fehlt/);
 const aus=new Bib(()=>({port:0,synapse_api_url:'x',projekte:[],reverse_bibliothek:{aktiv:false,pfad:p}}),f.api,()=>{},{zustandsDir:join(base,'s-'+randomUUID())});
 await aus.starte();s=await aus.status();assert.equal(s.modus,'aus');assert.equal(s.aktiv,false);
 assert.equal(f.st.policyCalls,0);
 const std=bib(undefined,f.api);await std.starte();
 s=await std.status();assert.equal(s.pfad,join(process.env.HOME,'synapse-reverse'));
 await until(async()=>(await std.status()).modus==='api','Standardpfad aktiv');
 assert.ok((await fs.stat(join(process.env.HOME,'synapse-reverse'))).isDirectory());
 await std.stop();assert.equal((await std.status()).modus,'aus');
});

test('config.json: reverse_bibliothek validiert, geloeschte_ausblenden und Fremdfelder bleiben',async()=>{
 const cfgPfad=C.configFilePath();
 assert.ok(cfgPfad.startsWith(process.env.HOME));
 const rb={aktiv:true,pfad:'/x/y',geloeschte_ausblenden:true,tray_feld:1};
 await fs.writeFile(cfgPfad,JSON.stringify({port:7878,synapse_api_token:'tray-token',projekte:[],reverse_bibliothek:rb}));
 const c=C.loadConfig();assert.equal(c.synapse_api_token,'tray-token');assert.deepEqual(c.reverse_bibliothek,rb);
 C.saveConfig(c);assert.deepEqual(JSON.parse(await fs.readFile(cfgPfad,'utf8')).reverse_bibliothek,rb);
 for(const bad of [{aktiv:'ja'},{geloeschte_ausblenden:'x'},{pfad:'relativ'},{pfad:''},[],'x'])assert.throws(()=>C.normalizeReverseBibliothek(bad),TypeError);
 // K4: $HOME und Punktordner direkt unter $HOME sind gesperrt, tiefer liegende Punktordner nicht.
 for(const gesperrt of [process.env.HOME,join(process.env.HOME,'.ssh'),join(process.env.HOME,'.config','x'),join(process.env.HOME,'.synapse')])
  assert.throws(()=>C.normalizeReverseBibliothek({pfad:gesperrt}),/gesperrt/);
 assert.equal(C.normalizeReverseBibliothek({pfad:join(process.env.HOME,'Spiele','.versteckt')}).pfad,join(process.env.HOME,'Spiele','.versteckt'));
 assert.equal(C.reversePfadGesperrt('/opt/bibliothek'),undefined);
 assert.equal(C.normalizeReverseBibliothek(undefined),undefined);
 await fs.writeFile(cfgPfad,JSON.stringify({projekte:[],reverse_bibliothek:{aktiv:'kaputt'}}));
 assert.deepEqual(C.loadConfig().reverse_bibliothek,{aktiv:'kaputt'},'ungueltig bleibt erhalten statt still verworfen');
 assert.equal(C.reverseBibliothekPfad({projekte:[]}),join(process.env.HOME,'synapse-reverse'));
 assert.equal(C.reverseBibliothekPfad({projekte:[],reverse_bibliothek:{pfad:'/a/b/'}}),'/a/b');
});

test('Lokale Daemon-Routen GET /reverse/status und POST /reverse/konfig (Vertrag Tray RV7)',async()=>{
 const {buildApi}=await import(pathToFileURL(join(dist,'api.js')));
 const {WatcherManager}=await import(pathToFileURL(join(dist,'manager.js')));
 const cfgPfad=C.configFilePath();
 await fs.writeFile(cfgPfad,JSON.stringify({port:0,projekte:[],fremd:'bleibt',reverse_bibliothek:{geloeschte_ausblenden:false}}));
 const m=new WatcherManager(C.loadConfig());const app=buildApi({manager:m});
 try{
  let r=await app.inject({method:'GET',url:'/reverse/status'});assert.equal(r.statusCode,200,r.body);let j=r.json();
  for(const k of ['aktiv','pfad','modus','auftraege','erkannt','wartend_stabil'])assert.ok(k in j,k);
  assert.equal(j.modus,'aus');assert.equal(j.aktiv,false);assert.deepEqual(j.auftraege,[]);
  assert.equal((await app.inject({method:'GET',url:'/reverse/status',headers:{origin:'http://fremd.example'}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/reverse/konfig',headers:{origin:'http://fremd.example'},payload:{aktiv:false}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/reverse/konfig',payload:{aktiv:'ja'}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/reverse/konfig',payload:{pfad:'relativ'}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/reverse/konfig',payload:{}})).statusCode,400);
  for(const pfad of [join(process.env.HOME,'.ssh'),join(process.env.HOME,'.gnupg'),process.env.HOME])
   assert.equal((await app.inject({method:'POST',url:'/reverse/konfig',payload:{pfad}})).statusCode,400,pfad);
  const p=await lib();
  r=await app.inject({method:'POST',url:'/reverse/konfig',payload:{pfad:p,geloeschte_ausblenden:true}});assert.equal(r.statusCode,200,r.body);j=r.json();
  assert.equal(j.ok,true);assert.equal(j.pfad,p);assert.equal(j.geloeschte_ausblenden,true);assert.equal(j.aktiv,false);assert.equal(j.neu_gestartet,true);assert.equal(j.status.modus,'aus');
  let disk=JSON.parse(await fs.readFile(cfgPfad,'utf8'));
  assert.equal(disk.fremd,'bleibt');assert.equal(disk.reverse_bibliothek.pfad,p);assert.equal(disk.reverse_bibliothek.geloeschte_ausblenden,true);
  disk.reverse_bibliothek.geloeschte_ausblenden=false;disk.reverse_bibliothek.tray_x=1;await fs.writeFile(cfgPfad,JSON.stringify(disk));
  r=await app.inject({method:'POST',url:'/reverse/konfig',payload:{aktiv:false}});assert.equal(r.statusCode,200,r.body);
  disk=JSON.parse(await fs.readFile(cfgPfad,'utf8'));
  assert.equal(disk.reverse_bibliothek.geloeschte_ausblenden,false,'Tray-Schreibstand uebernommen');assert.equal(disk.reverse_bibliothek.tray_x,1);assert.equal(disk.reverse_bibliothek.aktiv,false);
  r=await app.inject({method:'POST',url:'/reverse/konfig',payload:{geloeschte_ausblenden:true}});assert.equal(r.json().neu_gestartet,false);
 }finally{await m.stopAll();await app.close();}
});

test('K1: echte Loeschung bei laenger vorhandenem Duplikat bleibt geloescht_lokal',async()=>{
 const p=await lib(),f=await fake();const inhalt=daten(900,11);
 await fs.writeFile(join(p,'dup1.bin'),inhalt);await fs.writeFile(join(p,'dup2.bin'),inhalt);
 const b=bib(p,f.api);await b.starte();
 await until(async()=>{const s=await b.status();return s.erkannt===2&&s.auftraege.length===0&&f.st.finals>=1;},'beide erkannt');
 await warte(300);
 await fs.unlink(join(p,'dup1.bin'));
 await until(()=>f.st.abgemeldet.length===1,'abgemeldet');
 assert.deepEqual(f.st.abgemeldet,[{rel_pfad:'dup1.bin',status:'geloescht_lokal'}]);
});

test('K2: Upload liest die Datei nur zweimal (Watcher-Hash + Upload-FD) plus Kontrollhash, kein zweiter Hash davor',async()=>{
 const {createRequire,syncBuiltinESMExports}=await import('node:module');
 const fsp=createRequire(import.meta.url)('node:fs/promises');const orig=fsp.open;let opens=0;
 fsp.open=function(p,...a){if(String(p).endsWith('k2.iso'))opens++;return orig.call(this,p,...a);};syncBuiltinESMExports();
 try{
  const p=await lib(),f=await fake();await fs.writeFile(join(p,'k2.iso'),daten(3000,9));
  const b=bib(p,f.api);await b.starte();
  await until(()=>f.st.finals===1,'Upload');
  await until(async()=>(await b.status()).auftraege.length===0,'Queue leer');
  assert.equal(opens,3,'Watcher-Hash, Upload-FD, Kontrollhash nach dem Upload');
 }finally{fsp.open=orig;syncBuiltinESMExports();}
});

test('K3: 503 deaktiviert -> naechster Versuch erst nach 30 s',async()=>{
 const p=await lib(),f=await fake({policyStatus:503});const b=bib(p,f.api);await b.starte();
 await until(async()=>!!(await b.status()).fehler,'Fehler sichtbar');
 await warte(300);
 assert.equal(f.st.policyCalls,1);assert.equal((await b.status()).modus,'offen');
 assert.ok(b.naechsteVerhandlung-Date.now()>25_000,'Backoff ~30 s');
});

test('K4: Bibliothek in Punktordner unter $HOME startet nicht',async()=>{
 const f=await fake();const p=join(process.env.HOME,'.gnupg');await fs.mkdir(p,{recursive:true});
 const b=bib(p,f.api);await b.starte();const s=await b.status();
 assert.equal(s.modus,'fehler');assert.match(s.fehler,/gesperrt/);assert.equal(f.st.policyCalls,0);
});

test('M1: kein Speicherweg schreibt einen alten reverse_bibliothek-Stand zurueck',async()=>{
 const {buildApi}=await import(pathToFileURL(join(dist,'api.js')));
 const {WatcherManager}=await import(pathToFileURL(join(dist,'manager.js')));
 const cfgPfad=C.configFilePath();
 await fs.writeFile(cfgPfad,JSON.stringify({port:0,projekte:[],reverse_bibliothek:{geloeschte_ausblenden:false}}));
 const m=new WatcherManager(C.loadConfig());const app=buildApi({manager:m});
 try{
  const disk=JSON.parse(await fs.readFile(cfgPfad,'utf8'));disk.reverse_bibliothek={geloeschte_ausblenden:true,tray_x:2};
  await fs.writeFile(cfgPfad,JSON.stringify(disk));
  const pdir=await lib();m.discoverFromRegistry([{name:'rv6_m1',pfad:pdir,enabled:false}]);
  let d=JSON.parse(await fs.readFile(cfgPfad,'utf8'));
  assert.ok(d.projekte.some(x=>x.name==='rv6_m1'),'eigene Aenderung geschrieben');
  assert.deepEqual(d.reverse_bibliothek,{geloeschte_ausblenden:true,tray_x:2},'Tray-Stand nicht ueberschrieben');
  assert.equal(m.getConfig().reverse_bibliothek.geloeschte_ausblenden,true,'Speicherstand nachgezogen');
  const r=await app.inject({method:'POST',url:'/reverse/konfig',payload:{geloeschte_ausblenden:false}});assert.equal(r.statusCode,200,r.body);
  d=JSON.parse(await fs.readFile(cfgPfad,'utf8'));assert.equal(d.reverse_bibliothek.geloeschte_ausblenden,false);assert.equal(d.reverse_bibliothek.tray_x,2);
  m.discoverFromRegistry([{name:'rv6_m1b',pfad:await lib(),enabled:false}]);
  d=JSON.parse(await fs.readFile(cfgPfad,'utf8'));assert.equal(d.reverse_bibliothek.geloeschte_ausblenden,false,'Routenstand bleibt');
 }finally{await m.stopAll();await app.close();}
});
