#!/usr/bin/env node
/** P9-T27 Testphase Welle 2 (Umfang 9b7caa33, Berichte 4d5846e1, db7f418d, 8aedb9e1): Daemon OHNE DATABASE_URL.
 * Teil A: neue Daemon-Routen (shell/kontext, shell/sicherung, projekte, heartbeat, specialist/daten, sync, projekt-schalter,
 *         project-init, tray) mit ECHTEM Auth-Hook, echten Tokens und Hostbindung; Golden pgWatcherDatenweg vs. API-Datenweg.
 * Teil B: ECHTER Daemon-Prozess (packages/file-watcher-daemon-ts/dist/main.js) ohne DATABASE_URL/PG*-Umgebung in einer
 *         Wegwerf-HOME (mkdtemp) gegen die Test-API dieses Prozesses: Weg API automatisch, DB-Sperre ohne abgewiesene Zugriffe,
 *         Erstscan/add/change/unlink, PG->Platte, watcher_events, Tray-Endpunkte, Heartbeat, Shell-Jobs (Maskierung, Rueckfrage,
 *         Prod-Sperre), Spezialisten-stop, project-init, enabled-sync, Tray-Schalter.
 * Teil C: Golden der Shell-Ergebnisse gegen den PG-Weg + Rueckfall-Schalter (Daemon mit daemon_jobs_weg=pg und DATABASE_URL).
 * Nur synapse_test (5433), eigenes Wegwerf-Schema (LIKE-Kopien, PGOPTIONS search_path), API nur 127.0.0.1 in diesem Prozess,
 * Daemon-Ports frei gewaehlt, Weiterleitung aus. Kein echter Daemon, kein Docker, keine Live-Registry, nichts unter ~/dev.
 * Aufruf: node scripts/test-daemon-ohne-db-p9-t27-w2.mjs (DATABASE_URL setzt der Synapse-Shell-Job). */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import fs from 'node:fs';
import {mkdtemp,mkdir,writeFile,rm,unlink} from 'node:fs/promises';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const url=new URL(process.env.DATABASE_URL??'');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
const schema='p9_t27w2_'+randomUUID().replaceAll('-','').slice(0,20);
const T=n=>schema+'.'+n;
// Core-Pool dieses Prozesses (= Test-API) sieht zuerst das Testschema; keine Embeddings, kein echtes Qdrant.
process.env.PGOPTIONS='-c search_path='+schema+',public';
process.env.SYNAPSE_SKIP_EMBEDDINGS='1';
process.env.QDRANT_URL='http://127.0.0.1:9';
delete process.env.SYNAPSE_DAEMON_JOBS_WEG;delete process.env.SYNAPSE_AUTH_DISABLED;
const require=createRequire(new URL('../packages/core/package.json',import.meta.url)),{Client}=require('pg');
const admin=new Client({connectionString:url.href,options:''});await admin.connect();
assert.equal((await admin.query('SELECT current_database() AS db')).rows[0].db,'synapse_test');
const HOST=os.hostname(),P='t27w2-p-'+process.pid,P2='t27w2-aus-'+process.pid,FREMD='t27w2-fremd-'+process.pid,VIRT='t27w2-virt-'+process.pid;
const ANDERER='t27w2-anderer-host';
const root=await mkdtemp(path.join(os.tmpdir(),'p9-t27w2-'));
const projektOrdner=path.join(root,'projekt'),projekt2=path.join(root,'projekt2'),ws=path.join(root,'ws');
await mkdir(projektOrdner,{recursive:true});await mkdir(projekt2,{recursive:true});await mkdir(ws,{recursive:true});
process.env.HOME=root;os.homedir=()=>root;syncBuiltinESMExports();
const GEHEIM='t27w2-geheim-'+randomUUID().replaceAll('-','');
const MAIN=fileURLToPath(new URL('../packages/file-watcher-daemon-ts/dist/main.js',import.meta.url));
let made=false,app,auth=null,count=0;const tokens=[],kinder=[];
const check=async(name,fn)=>{await fn();console.log('PASS '+(++count)+' '+name);};
const q=(sql,args=[])=>admin.query(sql,args);
const schlaf=ms=>new Promise(r=>setTimeout(r,ms));
async function bis(fn,ms=30_000,schritt=250,was='Bedingung'){const ende=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>ende)throw new Error('Zeitueberschreitung: '+was);await schlaf(schritt);}}
const freierPort=()=>new Promise((res,rej)=>{const s=net.createServer();s.once('error',rej);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>res(p));});});
const sha=s=>createHash('sha256').update(s).digest('hex');
const norm=v=>JSON.parse(JSON.stringify(v));
const nachPfad=l=>[...l].sort((a,b)=>String(a.file_path).localeCompare(String(b.file_path)));
const pwFrei=s=>!/postgres(?:ql)?:\/\/[^\s/@:]+:[^\s/@]+@/.test(s);

/** Daemon als echter Kindprozess; Log wird gesammelt. */
function starteDaemon(name,env){
 const log=[];const kind=spawn(process.execPath,[MAIN],{cwd:root,env,stdio:['ignore','pipe','pipe']});
 const sammle=d=>{for(const z of String(d).split('\n'))if(z)log.push(z);};
 kind.stdout.on('data',sammle);kind.stderr.on('data',sammle);
 const ende=new Promise(r=>kind.on('exit',(code,sig)=>r({code,sig})));
 const h={name,kind,log,ende,text:()=>log.join('\n'),
  async stop(){if(kind.exitCode!==null||kind.signalCode)return ende;kind.kill('SIGTERM');const t=setTimeout(()=>kind.kill('SIGKILL'),12_000);const r=await ende;clearTimeout(t);return r;}};
 kinder.push(h);return h;
}
function daemonUmgebung(extra){
 const env={...process.env};
 for(const k of Object.keys(env))if(/^PG/.test(k)||k==='DATABASE_URL'||k==='SYNAPSE_DATABASE_URL'||k==='SYNAPSE_DAEMON_JOBS_WEG'||k==='QDRANT_URL')delete env[k];
 return {...env,HOME:root,SYNAPSE_LOGPFLEGE:'0',DAEMON_INTERN_BRUECKE_DISABLED:'1',SYNAPSE_WORKSPACE_BRIDGE_DISABLED:'1',
  ENABLED_SYNC_INTERVAL_MS:'2000',SYNAPSE_WORKSPACE_ROOT:ws,SYNAPSE_API_WEITERLEITUNG_PORT:'0',SYNAPSE_SKIP_EMBEDDINGS:'1',...extra};
}
const TABELLEN=['shell_jobs','specialist_jobs','projects','code_files','file_versions','projekt_datenbanken','shell_sicherungsregeln',
 'shell_antworttopf','shell_risiko_verben','wrapper_status','daemon_restore_host_bindings','project_init_jobs','project_setup_status',
 'watcher_events','project_ignore_rules','daemon_heartbeats','specialist_inbox'];

try{
 await q('CREATE SCHEMA '+schema);made=true;
 for(const t of TABELLEN)await q('CREATE TABLE '+T(t)+' (LIKE public.'+t+' INCLUDING ALL)');
 // Katalog-/Regeltabellen: Inhalt mitkopieren, damit Rueckfrage/Sperre wie auf der Test-DB entscheiden.
 for(const t of ['shell_sicherungsregeln','shell_antworttopf','shell_risiko_verben'])await q('INSERT INTO '+T(t)+' SELECT * FROM public.'+t);
 await q('INSERT INTO '+T('projects')+'(name,hostname,path,enabled) VALUES($1,$2,$3,true),($4,$2,$5,false),($6,$7,$8,true),($9,$2,$10,true)',
  [P,HOST,projektOrdner,P2,projekt2,FREMD,ANDERER,'/fixture/fremd',VIRT,'/virtual/'+VIRT]);

 const core=await import('../packages/core/dist/index.js');
 const fastify=createRequire(new URL('../packages/rest-api/package.json',import.meta.url))('fastify');
 const {daemonJobsRoutes}=await import('../packages/rest-api/dist/routes/daemon-jobs.js');
 const {registerAuthHook}=await import('../packages/rest-api/dist/middleware/auth-hook.js');
 auth=await import('../packages/rest-api/dist/services/auth.js');
 const neu=async t=>{tokens.push(t.token);return t.token;};
 const TOK=await neu(await auth.issueServiceToken('daemon:t27w2','t27w2')),FREMD_TOK=await neu(await auth.issueServiceToken('daemon:t27w2-fremd','t27w2-fremd'));
 const ACCESS=await neu(await auth.issueAccessToken(null,'mcp:tools',60_000,null));
 await q('INSERT INTO '+T('daemon_restore_host_bindings')+'(token_hash,hostname) VALUES($1,$2),($3,$4)',[sha(TOK),HOST,sha(FREMD_TOK),ANDERER]);
 app=fastify({logger:false,bodyLimit:64*1024*1024});registerAuthHook(app);await app.register(daemonJobsRoutes);
 const adresse=await app.listen({host:'127.0.0.1',port:0});
 const daemonPort=await freierPort();
 const cfgDir=path.join(root,'.synapse','file-watcher');await mkdir(cfgDir,{recursive:true});
 await writeFile(path.join(cfgDir,'config.json'),JSON.stringify({port:daemonPort,synapse_api_url:adresse,synapse_api_token:TOK,
  api_weiterleitung_port:0,workspace_root:ws,projekte:[{name:P,pfad:projektOrdner,enabled:true}]},null,2));
 const D='daemon-'+HOST+'-'+process.pid,D2='daemon-'+HOST+'-999999';
 const hdr=t=>(t?{authorization:'Bearer '+t}:{});
 const post=(p,body,t=TOK)=>app.inject({method:'POST',url:p,payload:{host:HOST,daemon_id:D,...body},headers:hdr(t)});
 const get=(p,qs,t=TOK)=>app.inject({method:'GET',url:p+'?'+new URLSearchParams({host:HOST,daemon_id:D,...qs}),headers:hdr(t)});
 async function shellJob(command,o={}){
  const r=await q('INSERT INTO '+T('shell_jobs')+"(project,command,stream_id,timeout_ms,tail_lines,agent_id,status,claimed_by,claimed_at) VALUES($1,$2,$3,60000,5,'claude-tpa2',$4,$5,CASE WHEN $5::text IS NULL THEN NULL ELSE NOW() END) RETURNING id",
   [o.project??P,command,randomUUID().replaceAll('-','').slice(0,16),o.status??'running',o.claimed===undefined?D:o.claimed]);
  return r.rows[0].id;
 }
 const jobZeile=async id=>(await q('SELECT * FROM '+T('shell_jobs')+' WHERE id=$1',[id])).rows[0];

 // ══════════════════ Teil A: Routen ══════════════════
 await check('A0 Auth: neue Routen ohne Token 401, Access-Token 403, fremder Daemon mit Host-Anmassung 403',async()=>{
  const ziele=[['GET','/api/daemon/shell/kontext?id=x'],['POST','/api/daemon/shell/sicherung'],['GET','/api/daemon/projekte'],['POST','/api/daemon/heartbeat'],
   ['POST','/api/daemon/specialist/daten'],['POST','/api/daemon/sync'],['POST','/api/daemon/projekt-schalter'],['POST','/api/daemon/project-init'],['POST','/api/daemon/tray']];
  for(const [method,u] of ziele){
   const body=method==='POST'?{host:HOST,daemon_id:D,aktion:'x',project:P}:undefined;
   assert.equal((await app.inject({method,url:u,payload:body})).statusCode,401,u+' ohne Token');
   assert.equal((await app.inject({method,url:u,payload:body,headers:hdr(ACCESS)})).statusCode,403,u+' Access');
   const f=await app.inject({method,url:method==='GET'?u+(u.includes('?')?'&':'?')+'host='+HOST+'&daemon_id='+D:u,payload:body,headers:hdr(FREMD_TOK)});
   assert.equal(f.statusCode,403,u+' fremder Host');assert.equal(f.json().error,'host_verboten',u);
  }
 });

 let kontextDaten;
 await check('A1 /shell/kontext: 400/404/409-Faelle, Projektpfad des Token-Hosts, Projekt-DB auf System-DB verworfen, keine Passwoerter',async()=>{
  assert.equal((await get('/api/daemon/shell/kontext',{})).json().error,'id_fehlt');
  const unb=await get('/api/daemon/shell/kontext',{id:randomUUID()});assert.equal(unb.statusCode,404);assert.equal(unb.json().error,'job_unbekannt');
  const fremd=await shellJob('echo a',{claimed:D2});
  assert.equal((await get('/api/daemon/shell/kontext',{id:fremd})).json().error,'nicht_eigener_job');
  const pend=await shellJob('echo b',{status:'pending'});
  const p=await get('/api/daemon/shell/kontext',{id:pend});assert.equal(p.statusCode,409);assert.equal(p.json().error,'job_nicht_laufend');
  const fp=await shellJob('echo c',{project:FREMD});
  assert.equal((await get('/api/daemon/shell/kontext',{id:fp})).json().error,'projekt_nicht_auf_diesem_host');
  const id=await shellJob('echo d');
  const ok=await get('/api/daemon/shell/kontext',{id});assert.equal(ok.statusCode,200,ok.body);
  const k=ok.json().kontext;kontextDaten=k;
  assert.equal(k.project,P);assert.equal(k.project_root,projektOrdner);assert.equal(k.projekt_db,null);
  assert.ok(k.katalog&&typeof k.katalog==='object');assert.ok(k.datenbank_freigabe&&Array.isArray(k.datenbank_freigabe.ziele));
  assert.ok(pwFrei(ok.body),'kein Passwort in URL-Form im Body');
  if(url.password)assert.ok(!ok.body.includes(decodeURIComponent(url.password)),'System-DB-Passwort nicht im Body');
  // Projekt-DB zeigt auf die System-DB (dieselbe Instanz wie die Test-API) -> verworfen, kein Zugang an den PC
  const PW='t27w2-pw-'+process.pid;
  await q('INSERT INTO '+T('projekt_datenbanken')+'(project,host,port,db,db_user,passwort) VALUES($1,$2,$3,$4,$5,$6)',[P,url.hostname,Number(url.port),url.pathname.slice(1),decodeURIComponent(url.username),PW]);
  const v=await get('/api/daemon/shell/kontext',{id});const vk=v.json().kontext;
  assert.equal(vk.projekt_db,null);assert.equal(vk.projekt_db_verworfen,true);assert.ok(!v.body.includes(PW),'verworfenes Passwort nicht im Body');
  // erlaubt nur: anderer Port UND andere DB als die System-DB (istErlaubteProjektDb, P10-T72 M2)
  await q('UPDATE '+T('projekt_datenbanken')+" SET db='t27w2_spielwiese', port=15433 WHERE project=$1",[P]);
  const e=(await get('/api/daemon/shell/kontext',{id})).json().kontext;
  assert.equal(e.projekt_db?.database,'t27w2_spielwiese');assert.equal(e.projekt_db_verworfen,undefined);
  await q('DELETE FROM '+T('projekt_datenbanken'));
  await q('DELETE FROM '+T('shell_jobs'));
 });

 await check('A2 /shell/sicherung: speicher_ungueltig 400, fremder Job 409, unbekannt 404',async()=>{
  const id=await shellJob('echo s');
  assert.equal((await post('/api/daemon/shell/sicherung',{id})).json().error,'speicher_ungueltig');
  assert.equal((await post('/api/daemon/shell/sicherung',{})).json().error,'id_fehlt');
  const f=await post('/api/daemon/shell/sicherung',{id,daemon_id:D2,speicher:{entscheidung:{},lage:{}}});
  assert.equal(f.statusCode,409);assert.equal(f.json().error,'nicht_eigener_job');
  assert.equal((await post('/api/daemon/shell/sicherung',{id:randomUUID(),speicher:{entscheidung:{},lage:{}}})).statusCode,404);
  await q('DELETE FROM '+T('shell_jobs'));
 });

 await check('A3 /projekte: nur Projekte des Token-Hosts ohne virtuelle; Golden gegen die bisherige enabled-sync-Abfrage',async()=>{
  const r=(await get('/api/daemon/projekte',{})).json();
  assert.equal(r.host,HOST);
  const alt=(await q(`SELECT p.name, p.path, p.enabled, s.setup_phase FROM ${T('projects')} p LEFT JOIN ${T('project_setup_status')} s ON s.project=p.name WHERE p.hostname=$1`,[HOST])).rows
   .filter(z=>!z.path.startsWith('/virtual/'));
  const s=l=>[...l].sort((a,b)=>a.name.localeCompare(b.name));
  assert.deepEqual(s(r.projekte),s(norm(alt)));
  assert.deepEqual(s(r.projekte).map(z=>z.name),[P,P2].sort());
 });

 await check('A4 /heartbeat: melden/loeschen nur fuer Host-Projekte, aktion unbekannt 400',async()=>{
  const m=(await post('/api/daemon/heartbeat',{aktion:'melden',projekte:[P,FREMD,P2],pid:4711})).json();
  assert.deepEqual([...m.projekte].sort(),[P,P2].sort());
  const z=(await q('SELECT project,hostname,daemon_pid FROM '+T('daemon_heartbeats')+' ORDER BY project')).rows;
  assert.deepEqual(z.map(x=>[x.project,x.hostname,Number(x.daemon_pid)]),[[P,HOST,4711],[P2,HOST,4711]].sort((a,b)=>a[0].localeCompare(b[0])));
  await post('/api/daemon/heartbeat',{aktion:'loeschen',projekte:[P,P2]});
  assert.equal((await q('SELECT count(*)::int n FROM '+T('daemon_heartbeats'))).rows[0].n,0);
  assert.equal((await post('/api/daemon/heartbeat',{aktion:'x',projekte:[P]})).statusCode,400);
 });

 const A='t27w2-agent-'+process.pid;
 const wrapperZeile=async(agent,pid,project=P)=>{
  const spalten=(await q("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='wrapper_status' AND is_nullable='NO' AND column_default IS NULL",[schema])).rows.map(r=>r.column_name);
  const w={project,agent_name:agent,wrapper_pid:pid,status:'running'};for(const s of spalten)if(!(s in w))w[s]=s==='model'?'fixture':'x';
  const k=Object.keys(w);
  await q('INSERT INTO '+T('wrapper_status')+'('+k.join(',')+',last_activity) VALUES('+k.map((_,i)=>'$'+(i+1)).join(',')+',NOW())',Object.values(w));
 };
 await check('A5 /specialist/daten: Host-Pruefung, Agentname, PID-CAS wrapper_gestoppt, inbox_post/-entfernen, modelle',async()=>{
  const d=(b,t)=>post('/api/daemon/specialist/daten',b,t);
  assert.equal((await d({aktion:'quatsch'})).json().error,'aktion_unbekannt');
  assert.ok(Array.isArray((await d({aktion:'modelle'})).json().modelle));
  assert.equal((await d({aktion:'projektpfad',project:P})).json().pfad,projektOrdner);
  assert.equal((await d({aktion:'projektpfad',project:FREMD})).json().pfad,null);
  assert.equal((await d({aktion:'sitzung_neu',agent:A})).json().error,'project_fehlt');
  const f=await d({aktion:'general_channel',project:FREMD,agent:A});assert.equal(f.statusCode,409);assert.equal(f.json().error,'projekt_nicht_auf_diesem_host');
  // istAgentName prueft nur Laenge/Steuerzeichen (Agentname geht nur parametrisiert in SQL, nie ins Dateisystem der API).
  for(const a of ['','a\u0001b','x'.repeat(129)])assert.equal((await d({aktion:'wrapper_pid',project:P,agent:a})).json().error,'agent_ungueltig',JSON.stringify(a));
  await wrapperZeile(A,424242);
  assert.equal((await d({aktion:'wrapper_pid',project:P,agent:A})).json().pid,424242);
  assert.equal((await d({aktion:'wrapper_gestoppt',project:P,agent:A,pid:1})).statusCode,400);
  assert.equal((await d({aktion:'wrapper_gestoppt',project:P,agent:A,pid:4243})).json().anzahl,0,'falsche PID: nichts');
  assert.equal((await d({aktion:'wrapper_gestoppt',project:P,agent:A,pid:424242})).json().anzahl,1);
  assert.equal((await q('SELECT status FROM '+T('wrapper_status')+' WHERE agent_name=$1',[A])).rows[0].status,'stopped');
  assert.equal((await d({aktion:'wrapper_gestoppt',project:FREMD,agent:A,pid:424242})).statusCode,409);
  const ib=(await d({aktion:'inbox_post',project:P,from:'koordinator',to:A,content:'t27w2 hallo'})).json();
  assert.equal(ib.success,true);assert.ok(Number(ib.id)>0);
  assert.equal((await d({aktion:'inbox_post',project:P,from:'',to:A,content:'y'})).json().error,'nachricht_ungueltig');
  assert.ok((await d({aktion:'inbox_entfernen',project:P,agent:A})).json().anzahl>=1);
  await q('DELETE FROM '+T('wrapper_status'));
 });

 const api=await import('../packages/file-watcher-daemon-ts/dist/daemon-jobs-api.js');
 const dsa=await import('../packages/file-watcher-daemon-ts/dist/daemon-sync-api.js');
 const sync=(b,t)=>post('/api/daemon/sync',b,t);
 await check('A6 /sync Pruefungen: fremdes Projekt 409, Pfade 400, aktion 400, deaktiviertes Projekt verworfen',async()=>{
  const f=await sync({aktion:'datei',project:FREMD,file_path:'a.txt',content:'x'});assert.equal(f.statusCode,409);assert.equal(f.json().error,'projekt_nicht_auf_diesem_host');
  assert.equal((await sync({aktion:'quatsch',project:P})).json().error,'aktion_unbekannt');
  for(const p of ['/etc/passwd','a/../../x','..','C:\\x','a\0b'])assert.equal((await sync({aktion:'inhalt',project:P,file_path:p})).json().error,'file_path_ungueltig',JSON.stringify(p));
  assert.equal((await sync({aktion:'datei',project:P,file_path:'a.txt'})).json().error,'content_fehlt');
  const v=(await sync({aktion:'datei',project:P2,file_path:'a.txt',content:'x'})).json();assert.equal(v.verworfen,'projekt_deaktiviert');
  assert.equal((await q('SELECT count(*)::int n FROM '+T('code_files')+' WHERE project=$1',[P2])).rows[0].n,0);
  assert.equal((await sync({aktion:'geaenderte',project:P,untergrenze:'kein-datum'})).json().error,'untergrenze_ungueltig');
  assert.equal((await sync({aktion:'hash_bekannt',project:P,file_path:'a.txt',hash:'abc'})).json().error,'hash_ungueltig');
 });

 await check('A7 /sync Platte->PG: datei (Hash-Schutz, fs_add nur nach Scan, fs_change), entfernen (fs_delete), code_zeile/inhalt/hash_bekannt',async()=>{
  const v1='hallo t27w2\n',v2='hallo t27w2 geaendert\n';
  assert.equal((await sync({aktion:'datei',project:P,file_path:'sync/a.txt',content:v1,datei_groesse:Buffer.byteLength(v1),scan_abgeschlossen:false})).json().geaendert,1);
  assert.equal((await sync({aktion:'datei',project:P,file_path:'sync/a.txt',content:v1,scan_abgeschlossen:true})).json().geaendert,0,'gleicher Inhalt');
  const versionen=async(p)=>(await q('SELECT edit_action FROM '+T('file_versions')+' WHERE project=$1 AND file_path=$2 ORDER BY id',[P,p])).rows.map(r=>r.edit_action);
  assert.deepEqual(await versionen('sync/a.txt'),[],'Erstscan ohne Version');
  assert.equal((await sync({aktion:'datei',project:P,file_path:'sync/b.txt',content:'b\n',scan_abgeschlossen:true})).json().geaendert,1);
  assert.deepEqual(await versionen('sync/b.txt'),['fs_add']);
  assert.equal((await sync({aktion:'datei',project:P,file_path:'sync/a.txt',content:v2,scan_abgeschlossen:true})).json().geaendert,1);
  assert.ok((await versionen('sync/a.txt')).includes('fs_change'));
  assert.equal((await sync({aktion:'inhalt',project:P,file_path:'sync/a.txt'})).json().content,v2);
  assert.equal((await sync({aktion:'code_zeile',project:P,file_path:'sync/a.txt'})).json().vorhanden,true);
  assert.equal((await sync({aktion:'code_zeile',project:P,file_path:'sync/nix.txt'})).json().vorhanden,false);
  for(const h of [sha(v1),sha(v2),sha('nie')])
   assert.equal((await sync({aktion:'hash_bekannt',project:P,file_path:'sync/a.txt',hash:h})).json().bekannt,await core.pgWatcherDatenweg.hashBekannt(P,'sync/a.txt',h));
  assert.equal((await sync({aktion:'hash_bekannt',project:P,file_path:'sync/a.txt',hash:sha('nie')})).json().bekannt,false);
  assert.ok((await sync({aktion:'datei_zeile',project:P,file_path:'sync/a.txt'})).json().zeile,'datei_zeile');
  assert.equal((await sync({aktion:'datei_zeile',project:P,file_path:'sync/nix.txt'})).json().zeile,null);
  for(const h of [sha(v1),sha(v2)])
   assert.deepEqual((await sync({aktion:'bekannte_version',project:P,file_path:'sync/a.txt',hash:h})).json().version,norm((await core.pgSyncDateiZugriff.bekannteVersion(P,'sync/a.txt',h))??null));
  await sync({aktion:'entfernen',project:P,file_path:'sync/b.txt'});
  // removeFile loescht weich (deleted_at); hart loescht erst geloescht_abschliessen nach dem Plattenabgleich.
  assert.equal((await q('SELECT count(*)::int n FROM '+T('code_files')+' WHERE project=$1 AND file_path=$2 AND deleted_at IS NULL',[P,'sync/b.txt'])).rows[0].n,0);
  assert.ok((await versionen('sync/b.txt')).includes('fs_delete'));
 });

 await check('A8 Golden: Daemon-Client apiWatcherDatenweg == pgWatcherDatenweg (geaenderte/geloeschte/hash/inhalt/code_zeile), ignore_regeln == ladeIgnoreRegelZeilen',async()=>{
  await core.createFileInPg(P,'sync/c.txt','c\n','claude-tpa2','t27w2 Golden');
  await core.softDeleteFile(P,'sync/c.txt');
  const pg=core.pgWatcherDatenweg,ap=dsa.apiWatcherDatenweg;assert.equal(ap.art,'api');
  const u='1970-01-01T00:00:00.000Z';
  for(const voll of [null,'','sync/a.txt']){
   const a=await ap.geaenderte(P,{untergrenze:u,vollNach:voll,limit:500}),b=await pg.geaenderte(P,{untergrenze:u,vollNach:voll,limit:500});
   assert.deepEqual({delta:nachPfad(norm(a.delta)),voll:norm(a.voll)},{delta:nachPfad(norm(b.delta)),voll:norm(b.voll)},'geaenderte '+voll);
   const c=await ap.geloeschte(P,{untergrenze:u,geloeschtNach:voll,limit:500}),d=await pg.geloeschte(P,{untergrenze:u,geloeschtNach:voll,limit:500});
   assert.deepEqual(norm(c),norm(d),'geloeschte '+voll);
  }
  assert.ok((await pg.geloeschte(P,{untergrenze:u,geloeschtNach:null,limit:500})).delta.some(z=>z.file_path==='sync/c.txt'),'Testfall hat eine geloeschte Zeile');
  for(const [p,h] of [['sync/a.txt',sha('hallo t27w2\n')],['sync/a.txt',sha('x')],['sync/zz',sha('x')]])assert.equal(await ap.hashBekannt(P,p,h),await pg.hashBekannt(P,p,h));
  for(const p of ['sync/a.txt','sync/c.txt','sync/zz']){assert.equal(await ap.inhalt(P,p),(await pg.inhalt(P,p))??null,p);assert.equal(await ap.codeZeileVorhanden(P,p),await pg.codeZeileVorhanden(P,p),p);}
  await q('INSERT INTO '+T('project_ignore_rules')+'(project,pattern) VALUES($1,$2)',[P,'t27w2-ignoriert/**']);
  const r=(await sync({aktion:'ignore_regeln',project:P})).json().regeln;
  assert.deepEqual(norm(r),norm(await core.ladeIgnoreRegelZeilen(P)));assert.ok(r.some(z=>z.pattern==='t27w2-ignoriert/**'));
 });

 await check('A9 /sync geloescht_abschliessen: nur passende soft-geloeschte Zeile (fremde id/Pfad 409, Zeile bleibt), Client schluckt zeile_passt_nicht',async()=>{
  const z=(await q('SELECT id FROM '+T('code_files')+' WHERE project=$1 AND file_path=$2',[P,'sync/c.txt'])).rows[0];assert.ok(z);
  const lebend=(await q('SELECT id FROM '+T('code_files')+' WHERE project=$1 AND file_path=$2',[P,'sync/a.txt'])).rows[0];
  assert.equal((await sync({aktion:'geloescht_abschliessen',project:P,id:String(z.id),file_path:'sync/a.txt'})).json().error,'zeile_passt_nicht');
  assert.equal((await sync({aktion:'geloescht_abschliessen',project:P,id:String(lebend.id),file_path:'sync/a.txt'})).statusCode,409,'nicht geloeschte Zeile');
  assert.equal((await sync({aktion:'geloescht_abschliessen',project:FREMD,id:String(z.id),file_path:'sync/c.txt'})).statusCode,409);
  assert.equal((await q('SELECT count(*)::int n FROM '+T('code_files')+' WHERE id=$1',[z.id])).rows[0].n,1,'Zeile bleibt');
  await dsa.apiWatcherDatenweg.geloeschtAbschliessen(P,String(lebend.id),'sync/a.txt');// wirft nicht
  assert.equal((await q('SELECT count(*)::int n FROM '+T('code_files')+' WHERE id=$1',[lebend.id])).rows[0].n,1,'lebende Zeile unberuehrt');
  assert.equal((await sync({aktion:'geloescht_abschliessen',project:P,id:String(z.id),file_path:'sync/c.txt'})).json().success,true);
  assert.equal((await q('SELECT count(*)::int n FROM '+T('code_files')+' WHERE id=$1',[z.id])).rows[0].n,0);
 });

 await check('A10 /sync ereignisse: fremde/kaputte Eintraege verworfen; ereignisse_aufraeumen loescht >7 Tage; Client-Puffer kommt an',async()=>{
  const r=(await sync({aktion:'ereignisse',eintraege:[{project:P,kind:'add',file_path:'e1.txt',details:{a:1}},{project:FREMD,kind:'add',file_path:'e2.txt'},{project:P},null]})).json();
  assert.deepEqual([r.geschrieben,r.verworfen],[1,3]);
  assert.equal((await sync({aktion:'ereignisse'})).json().error,'eintraege_fehlen');
  await q('INSERT INTO '+T('watcher_events')+"(project,event_type,file_path,created_at) VALUES($1,'add','alt.txt',NOW()-interval '8 days')",[P]);
  await sync({aktion:'ereignisse_aufraeumen',project:P});
  assert.deepEqual((await q('SELECT file_path FROM '+T('watcher_events')+' WHERE project=$1 ORDER BY id',[P])).rows.map(x=>x.file_path),['e1.txt']);
  dsa.apiWatcherDatenweg.ereignisProtokollieren(P,'change','e3.txt',{t:1});dsa.apiWatcherDatenweg.ereignisProtokollieren(FREMD,'change','e4.txt');
  await dsa.leereEreignisPuffer();
  assert.deepEqual((await q('SELECT file_path FROM '+T('watcher_events')+' WHERE project=$1 ORDER BY id',[P])).rows.map(x=>x.file_path),['e1.txt','e3.txt']);
  assert.equal((await q('SELECT count(*)::int n FROM '+T('watcher_events')+' WHERE project=$1',[FREMD])).rows[0].n,0);
 });

 await check('A11 /project-init: claim nur Host/NULL, abschluss/registrieren nur eigener Job, Pfadregeln, Registrierung fuer Token-Host, expire',async()=>{
  const ini=async(name,host,alt='0 seconds')=>(await q('INSERT INTO '+T('project_init_jobs')+"(name,hostname,status,created_at) VALUES($1,$2,'pending',NOW()-$3::interval) RETURNING id",[name,host,alt])).rows[0].id;
  const N1='t27w2a'+process.pid,N2='t27w2b'+process.pid,N3='t27w2c'+process.pid;
  const j1=await ini(N1,null,'20 seconds'),j2=await ini(N2,ANDERER,'15 seconds'),j3=await ini(N3,HOST,'10 seconds');
  const pi=(b,t)=>post('/api/daemon/project-init',b,t);
  const c1=(await pi({aktion:'claim'})).json().job,c2=(await pi({aktion:'claim'})).json().job,c3=(await pi({aktion:'claim'})).json().job;
  assert.deepEqual([c1?.id,c2?.id,c3],[j1,j3,null]);
  assert.equal((await q('SELECT status FROM '+T('project_init_jobs')+' WHERE id=$1',[j2])).rows[0].status,'pending','Job eines anderen Hosts bleibt');
  assert.equal((await pi({aktion:'abschluss',id:j1,daemon_id:D2,abschluss:{status:'done'}})).json().error,'nicht_eigener_job');
  assert.equal((await pi({aktion:'abschluss',id:j1,abschluss:{status:'gut'}})).json().error,'abschluss_ungueltig');
  assert.equal((await pi({aktion:'registrieren',id:j1,daemon_id:D2,path:path.join(ws,N1)})).statusCode,409);
  // Server kennt WORKSPACE_ROOT des PCs nicht: Regel = absolut, ohne '..', letzter Teil = Job-Name.
  for(const p of [path.join(ws,'falsch'),N1,'/a/../'+N1,'relativ/'+N1,'/'+N1+'/x'])
   assert.equal((await pi({aktion:'registrieren',id:j1,path:p})).json().error,'path_ungueltig',p);
  const r=(await pi({aktion:'registrieren',id:j1,path:path.join(ws,N1),lokale_phase:null})).json();
  assert.equal(r.success,true);assert.equal(r.setup_phase_vorher,'none');
  const reg=(await q('SELECT hostname,path FROM '+T('projects')+' WHERE name=$1 ORDER BY hostname',[N1])).rows;
  assert.ok(reg.some(z=>z.hostname===HOST&&z.path===path.join(ws,N1)),JSON.stringify(reg));
  assert.equal((await q('SELECT setup_phase FROM '+T('project_setup_status')+' WHERE project=$1',[N1])).rows[0]?.setup_phase,'initial-pending');
  assert.equal((await pi({aktion:'abschluss',id:j1,abschluss:{status:'done',resolved_path:path.join(ws,N1)}})).json().success,true);
  assert.equal((await q('SELECT status FROM '+T('project_init_jobs')+' WHERE id=$1',[j1])).rows[0].status,'done');
  assert.equal((await pi({aktion:'registrieren',id:j1,path:path.join(ws,N1)})).statusCode,409,'abgeschlossener Job');
  await q('UPDATE '+T('project_init_jobs')+" SET created_at=NOW()-interval '5 minutes' WHERE id=$1",[j2]);
  assert.ok((await pi({aktion:'expire',max_alter_s:1})).json().anzahl>=1);
  assert.notEqual((await q('SELECT status FROM '+T('project_init_jobs')+' WHERE id=$1',[j2])).rows[0].status,'pending');
  assert.equal((await pi({aktion:'x'})).statusCode,400);
  await q('DELETE FROM '+T('project_init_jobs'));
  await q('DELETE FROM '+T('projects')+' WHERE name=$1',[N1]);await q('DELETE FROM '+T('project_setup_status')+' WHERE project=$1',[N1]);
 });

 await check('A12 /tray + /projekt-schalter: nur Host-Projekte, Pflichtfelder, Daten wie die Core-Funktionen',async()=>{
  const tr=(b,t)=>post('/api/daemon/tray',b,t);
  assert.equal((await tr({aktion:'history',project:FREMD})).statusCode,409);
  assert.equal((await tr({aktion:'quatsch',project:P})).statusCode,400);
  assert.deepEqual(norm((await tr({aktion:'history',project:P,limit:10})).json().events),norm(await core.trayWatcherEreignisse(P,10)));
  const fv=(await tr({aktion:'file_versions',project:P})).json().versions;assert.ok(fv.some(v=>v.edit_action==='fs_add'));
  assert.ok(Array.isArray((await tr({aktion:'specialists',project:P})).json().zeilen));
  assert.equal((await tr({aktion:'specialist',project:P})).json().error,'agent_fehlt');
  assert.ok(Array.isArray((await tr({aktion:'channels',project:P})).json().channels));
  assert.equal((await tr({aktion:'feed',project:P})).json().error,'channel_fehlt');
  assert.equal((await tr({aktion:'post',project:P,channel:'c'})).json().error,'nachricht_ungueltig');
  assert.ok(Array.isArray((await tr({aktion:'agents',project:P})).json().agents));
  const ps=(b,t)=>post('/api/daemon/projekt-schalter',b,t);
  assert.equal((await ps({project:FREMD,enabled:true})).statusCode,409);
  assert.equal((await ps({project:P2})).json().error,'enabled_fehlt');
  assert.equal((await ps({project:P2,enabled:true})).json().enabled,true);
  assert.equal((await q('SELECT enabled FROM '+T('projects')+' WHERE name=$1',[P2])).rows[0].enabled,true);
  await ps({project:P2,enabled:false});
  assert.equal((await q('SELECT enabled FROM '+T('projects')+' WHERE name=$1',[P2])).rows[0].enabled,false);
  assert.equal((await q('SELECT enabled FROM '+T('projects')+' WHERE name=$1',[FREMD])).rows[0].enabled,true,'fremdes Projekt unberuehrt');
 });

 await check('A13 Schalter: ohne Schalter + ohne DATABASE_URL -> api; mit DATABASE_URL -> pg; explizit pg bleibt pg',async()=>{
  const sicher={DATABASE_URL:process.env.DATABASE_URL,SYNAPSE_DATABASE_URL:process.env.SYNAPSE_DATABASE_URL};
  try{
   assert.equal(api.daemonJobsWeg(),'pg','mit DATABASE_URL');
   delete process.env.DATABASE_URL;delete process.env.SYNAPSE_DATABASE_URL;
   assert.equal(api.hatDatenbankUrl(),false);assert.equal(api.daemonJobsWeg(),'api','ohne DB-URL');
   process.env.SYNAPSE_DAEMON_JOBS_WEG='pg';assert.equal(api.daemonJobsWeg(),'pg','explizit pg');
   process.env.SYNAPSE_DAEMON_JOBS_WEG='api';process.env.DATABASE_URL=sicher.DATABASE_URL;assert.equal(api.daemonJobsWeg(),'api','explizit api mit URL');
  }finally{
   delete process.env.SYNAPSE_DAEMON_JOBS_WEG;
   for(const [k,v] of Object.entries(sicher)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  }
 });

 // ══════════════════ Teil B: echter Daemon ohne DATABASE_URL ══════════════════
 await q('DELETE FROM '+T('code_files'));await q('DELETE FROM '+T('file_versions'));await q('DELETE FROM '+T('watcher_events'));
 await writeFile(path.join(projektOrdner,'start.txt'),'vor dem Start\n');
 // Name mit TOKEN: istShellGeheimnisName entscheidet nach dem Namen, ob ein .env-Wert maskiert wird.
 await writeFile(path.join(projektOrdner,'.env'),'T27W2_API_TOKEN='+GEHEIM+'\n');
 const cf=async p=>(await q('SELECT content FROM '+T('code_files')+' WHERE project=$1 AND file_path=$2 AND deleted_at IS NULL',[P,p])).rows[0];
 const fvs=async p=>(await q('SELECT edit_action FROM '+T('file_versions')+' WHERE project=$1 AND file_path=$2 ORDER BY id',[P,p])).rows.map(r=>r.edit_action);
 const dmn=starteDaemon('api',daemonUmgebung({}));
 const lokal=(p,init)=>fetch('http://127.0.0.1:'+daemonPort+p,init).then(async r=>({status:r.status,body:await r.json().catch(()=>null)}));
 const apiRows={};let startVersionenApi=null,rennenApi=null,BEFEHLE={},fertig,shellNeu;
 /** Info (kein Assert): Datei schreiben, aendern, SOFORT loeschen -> lebt sie nach dem PG->Platte-Poll wieder auf? */
 async function rennen(datei){
  const abs=path.join(projektOrdner,datei);
  await writeFile(abs,'r1\n');await bis(async()=>(await cf(datei))?.content==='r1\n',30_000,300,'rennen add');
  await writeFile(abs,'r2\n');await bis(async()=>(await cf(datei))?.content==='r2\n',30_000,300,'rennen change');
  await unlink(abs);await schlaf(12_000);
  const r={datei_wieder_da:fs.existsSync(abs),pg_zeile:!!(await cf(datei))};
  await rm(abs,{force:true});return r;
 }
 try{
  await check('B1 Start ohne DATABASE_URL: Weg API automatisch, DB-Sperre aktiv, lokale API antwortet',async()=>{
   await bis(()=>/listening http:\/\/127\.0\.0\.1:/.test(dmn.text()),30_000,250,'Daemon-Start');
   const t=dmn.text();
   assert.match(t,/\[daemon-jobs\] kein DATABASE_URL in der Daemon-Umgebung — Weg: API/);
   assert.match(t,/\[daemon\] Weg: API — keine eigene DB-Verbindung\./);
   assert.doesNotMatch(t,/DATABASE_URL gesetzt, wird nicht benutzt/);
   assert.match(t,/\[enabled-sync\] aktiv \(.*Weg: API\)/);
   assert.equal((await lokal('/health')).status,200);
   assert.equal((await lokal('/projects/'+P+'/status')).body?.enabled,true);
  });
  await check('B2 Erstscan ueber die API: start.txt in code_files (Versionen vergleicht C2 mit dem PG-Weg)',async()=>{
   const z=await bis(()=>cf('start.txt'),60_000,500,'Erstscan start.txt');
   assert.equal(z.content,'vor dem Start\n');await schlaf(1000);startVersionenApi=await fvs('start.txt');
   await bis(()=>/Watcher gestartet: /.test(dmn.text()),5_000,250,'Watcher-Log');
   await schlaf(2500);// onReady -> scanFertig
  });
  await check('B3 Live add/change/unlink ueber die API: code_files + fs_add/fs_change/fs_delete',async()=>{
   await writeFile(path.join(projektOrdner,'live.txt'),'eins\n');
   await bis(async()=>(await cf('live.txt'))?.content==='eins\n',30_000,300,'add');
   await bis(async()=>(await fvs('live.txt')).includes('fs_add'),10_000,300,'fs_add');
   await writeFile(path.join(projektOrdner,'live.txt'),'zwei\n');
   await bis(async()=>(await cf('live.txt'))?.content==='zwei\n',30_000,300,'change');
   assert.ok((await fvs('live.txt')).includes('fs_change'));
   // PG->Platte-Poll nach der Aenderung abwarten (sonst Rennen Loeschen vs. Rueckschreiben, siehe Info B3b/C2).
   await bis(()=>/PG→FS Sync: live\.txt/.test(dmn.text()),15_000,300,'PG->FS nach Aenderung').catch(()=>{});
   await schlaf(3000);
   await unlink(path.join(projektOrdner,'live.txt'));
   await bis(async()=>!(await cf('live.txt')),30_000,300,'unlink');
   assert.ok((await fvs('live.txt')).includes('fs_delete'));
  });
  rennenApi=await rennen('rennen-api.txt');
  console.log('INFO B3b Loeschen direkt nach Aenderung (API-Weg): '+JSON.stringify(rennenApi));
  await check('B4 PG -> Platte ueber die API: neue Datei erscheint, soft-geloeschte verschwindet und Zeile wird abgeschlossen',async()=>{
   await core.createFileInPg(P,'vonpg.txt','von pg t27w2\n','claude-tpa2','t27w2 PG->FS');
   const ziel=path.join(projektOrdner,'vonpg.txt');
   await bis(()=>fs.existsSync(ziel)&&fs.readFileSync(ziel,'utf8')==='von pg t27w2\n',60_000,500,'PG->FS schreiben');
   await core.softDeleteFile(P,'vonpg.txt');
   await bis(()=>!fs.existsSync(ziel),60_000,500,'PG->FS loeschen');
   await bis(async()=>(await q('SELECT count(*)::int n FROM '+T('code_files')+' WHERE project=$1 AND file_path=$2',[P,'vonpg.txt'])).rows[0].n===0,30_000,500,'Zeile abgeschlossen');
  });
  await check('B5 watcher_events gepuffert ueber die API; Tray-Endpunkte history/file_versions/channels/agents im API-Weg',async()=>{
   await bis(async()=>(await q('SELECT count(*)::int n FROM '+T('watcher_events')+' WHERE project=$1',[P])).rows[0].n>0,15_000,500,'watcher_events');
   const h=await lokal('/projects/'+P+'/history?limit=20');assert.equal(h.status,200);assert.ok(h.body.events.length>0);
   const v=await lokal('/projects/'+P+'/file_versions');assert.equal(v.status,200);assert.ok(v.body.versions.some(x=>x.edit_action==='fs_add'));
   assert.equal((await lokal('/projects/'+P+'/channels')).status,200);
   assert.equal((await lokal('/projects/'+P+'/agents')).status,200);
   assert.equal((await lokal('/projects/'+P+'/specialists')).status,200);
  });
  await check('B6 Heartbeat ueber die API: daemon_heartbeats fuer das Projekt mit Daemon-PID',async()=>{
   const z=await bis(async()=>(await q('SELECT hostname,daemon_pid FROM '+T('daemon_heartbeats')+' WHERE project=$1',[P])).rows[0],45_000,1000,'Heartbeat');
   assert.equal(z.hostname,HOST);assert.equal(Number(z.daemon_pid),dmn.kind.pid);
  });
  fertig=async id=>bis(async()=>{const z=await jobZeile(id);return ['done','failed','rejected','timeout'].includes(z.status)?z:null;},60_000,300,'Shell-Job '+id);
  shellNeu=async c=>shellJob(c,{status:'pending',claimed:null});
  const live=kontextDaten?.datenbank_freigabe?.live;
  BEFEHLE={
   exit3:"printf 't27w2-ok\\nzeile2\\n'; exit 3",
   rueckfrage:'rm -rf ./t27w2-weg',
   maske:'cat .env; echo ende',
   ...(live?{sperre:`psql "postgresql://t27w2@${live.host}:${live.port}/${live.datenbank}" -c "DELETE FROM t27w2_gibt_es_nicht"`}:{}),
  };
  await check('B7 Shell-Jobs end-to-end ueber die API: Ergebnis, Sicherungs-Audit, Rueckfrage-Stufe, Prod-Sperre',async()=>{
   for(const [k,c] of Object.entries(BEFEHLE))apiRows[k]=await fertig(await shellNeu(c));
   const e=apiRows.exit3;
   assert.equal(e.claimed_by.startsWith('daemon-'+HOST+'-'),true);assert.equal(Number(e.claimed_by.split('-').pop()),dmn.kind.pid);
   assert.equal(e.status,'failed');assert.equal(e.exit_code,3);assert.match(e.output??'',/t27w2-ok\nzeile2/);
   for(const k of Object.keys(BEFEHLE))assert.ok(apiRows[k].sicherung,'Sicherungs-Audit gespeichert: '+k);
   if(apiRows.sperre)assert.equal(apiRows.sperre.status,'rejected','Schreib-SQL gegen die System-DB bleibt gesperrt');
   else console.log('HINWEIS B7: datenbank_freigabe.live fehlt in der Test-API — Prod-Sperre nicht pruefbar');
   assert.ok(/DB-Sperre|PG-Zugriff gesperrt/.test(dmn.text())===false,'keine abgewiesenen PG-Zugriffe');
  });
  await check('B8 Maskierung im API-Weg: .env-Wert des Projekts erscheint nicht im Job-Output',async()=>{
   const z=apiRows.maske;
   assert.equal(z.status,'done',JSON.stringify({e:z.error,m:z.message}));
   assert.ok(!JSON.stringify(z).includes(GEHEIM),'Geheimnis maskiert: '+String(z.output).slice(0,120));
   assert.match(z.output??'',/T27W2_API_TOKEN=/);assert.match(z.output??'',/ende/);
  });
  await check('B9 Spezialisten-Job stop ueber die API: tote Wrapper-PID -> wrapper_status stopped (PID-CAS), Job done',async()=>{
   const tot=spawn('true');const pid=tot.pid;await new Promise(r=>tot.on('exit',r));
   await wrapperZeile(A,pid);
   const id=(await q('INSERT INTO '+T('specialist_jobs')+"(project,action,args) VALUES($1,'stop',$2::jsonb) RETURNING id",[P,JSON.stringify({name:A,target_hostname:HOST})])).rows[0].id;
   const j=await bis(async()=>{const z=(await q('SELECT * FROM '+T('specialist_jobs')+' WHERE id=$1',[id])).rows[0];return ['done','failed','rejected','timeout'].includes(z.status)?z:null;},60_000,500,'specialist stop');
   assert.equal(j.status,'done',JSON.stringify({m:j.message,r:j.result}));
   assert.equal((await q('SELECT status FROM '+T('wrapper_status')+' WHERE agent_name=$1',[A])).rows[0].status,'stopped');
   await q('DELETE FROM '+T('wrapper_status'));
  });
  await check('B10 project-init end-to-end ueber die API: Ordner unter WORKSPACE_ROOT, Registrierung fuer diesen Host, Watcher indexiert README',async()=>{
   const N='t27w2init'+process.pid;
   const id=(await q('INSERT INTO '+T('project_init_jobs')+"(name,hostname,status) VALUES($1,$2,'pending') RETURNING id",[N,HOST])).rows[0].id;
   const j=await bis(async()=>{const z=(await q('SELECT * FROM '+T('project_init_jobs')+' WHERE id=$1',[id])).rows[0];return ['done','failed','rejected','timeout'].includes(z.status)?z:null;},60_000,500,'project-init');
   assert.equal(j.status,'done',JSON.stringify({e:j.error,m:j.message}));assert.equal(j.resolved_path,path.join(ws,N));
   assert.ok(fs.existsSync(path.join(ws,N,'README.md')));
   assert.ok((await q('SELECT 1 FROM '+T('projects')+' WHERE name=$1 AND hostname=$2 AND path=$3',[N,HOST,path.join(ws,N)])).rows[0]);
   await bis(async()=>(await q('SELECT 1 FROM '+T('code_files')+' WHERE project=$1 AND file_path=$2',[N,'README.md'])).rows[0],60_000,500,'README indexiert');
  });
  await check('B11 enabled-sync ueber die API (PG = SoT) und Tray-Schalter ueber /api/daemon/projekt-schalter',async()=>{
   await q('UPDATE '+T('projects')+' SET enabled=false WHERE name=$1 AND hostname=$2',[P,HOST]);
   await bis(()=>new RegExp('\\[enabled-sync\\] '+P+' -> disabled').test(dmn.text()),20_000,500,'enabled-sync disabled');
   await q('UPDATE '+T('projects')+' SET enabled=true WHERE name=$1 AND hostname=$2',[P,HOST]);
   await bis(()=>new RegExp('\\[enabled-sync\\] '+P+' -> enabled').test(dmn.text()),20_000,500,'enabled-sync enabled');
   assert.equal((await lokal('/projects/'+P+'/disable',{method:'POST'})).status,200);
   await bis(async()=>(await q('SELECT enabled FROM '+T('projects')+' WHERE name=$1 AND hostname=$2',[P,HOST])).rows[0].enabled===false,10_000,300,'Tray disable');
   assert.equal((await lokal('/projects/'+P+'/enable',{method:'POST'})).status,200);
   await bis(async()=>(await q('SELECT enabled FROM '+T('projects')+' WHERE name=$1 AND hostname=$2',[P,HOST])).rows[0].enabled===true,10_000,300,'Tray enable');
  });
 }finally{
  const r=await dmn.stop();
  console.log('Daemon (API) beendet: '+JSON.stringify(r));
  // Diagnose: Daemon-Log ausserhalb der Wegwerf-HOME ablegen (nur wenn T27W2_DAEMON_LOG gesetzt).
  if(process.env.T27W2_DAEMON_LOG)fs.writeFileSync(process.env.T27W2_DAEMON_LOG,dmn.text());
 }
 await check('B12 Shutdown sauber; im ganzen Lauf kein abgewiesener PG-Zugriff, keine Uncaught Exception',async()=>{
  const t=dmn.text();
  const sperr=dmn.log.filter(z=>/DB-Sperre|PG-Zugriff gesperrt/.test(z));
  assert.deepEqual(sperr,[],'DB-Sperre-Zeilen');
  assert.doesNotMatch(t,/Uncaught Exception|Fataler Fehler/);
  assert.match(t,/Shutdown abgeschlossen/);
  assert.equal(fs.existsSync(path.join(cfgDir,'daemon.pid')),false);
 });

 // ══════════════════ Teil C: Golden gegen den PG-Weg + Rueckfall ══════════════════
 await check('C1 Golden: dieselben Shell-Befehle ueber den PG-Weg (eigener Prozess mit DATABASE_URL) -> gleiche Ergebniszeile',async()=>{
  const kind=`
   import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';
   os.homedir=()=>${JSON.stringify(root)};syncBuiltinESMExports();
   globalThis.fetch=async()=>Response.json({enabled:true});
   const core=await import(${JSON.stringify(new URL('../packages/core/dist/index.js',import.meta.url).href)});
   const sw=await import(${JSON.stringify(new URL('../packages/file-watcher-daemon-ts/dist/shell-job-worker.js',import.meta.url).href)});
   for(;;){const job=await core.claimPendingShellJob(${JSON.stringify(P)},'daemon-'+os.hostname()+'-'+process.pid);if(!job)break;await sw.runClaimedJob(job.project,job);}
   process.exit(0);`;
  const ids={};for(const [k,c] of Object.entries(BEFEHLE))ids[k]=await shellNeu(c);
  const env={...process.env,HOME:root};delete env.SYNAPSE_DAEMON_JOBS_WEG;
  const code=await new Promise((res,rej)=>{const c=spawn(process.execPath,['--input-type=module','-e',kind],{env,cwd:root,stdio:['ignore','ignore','inherit']});c.on('error',rej);c.on('exit',res);});
  assert.equal(code,0);
  const ohneIds=s=>s==null?s:String(s).replace(/[0-9a-f]{6,64}/g,'#').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g,'@');
  const n=z=>({status:z.status,exit_code:z.exit_code,error:z.error,output_truncated:z.output_truncated,tail:ohneIds(JSON.stringify(z.tail)),output:ohneIds(z.output),message:ohneIds(z.message)});
  for(const k of Object.keys(BEFEHLE)){
   const pg=await jobZeile(ids[k]);
   assert.deepEqual(n(apiRows[k]),n(pg),'Golden '+k);
   const st=z=>z.sicherung?.entscheidung?.stufe??z.sicherung?.stufe??null;
   assert.equal(st(apiRows[k]),st(pg),'gleiche Sicherungs-Stufe '+k);
  }
 });
 await check('C2 Rueckfall-Schalter: daemon_jobs_weg=pg mit DATABASE_URL -> PG-Weg (kein API-Log, enabled-sync PG, Indexierung ueber PG)',async()=>{
  const env=daemonUmgebung({DATABASE_URL:process.env.DATABASE_URL,PGOPTIONS:process.env.PGOPTIONS,SYNAPSE_DAEMON_JOBS_WEG:'pg',QDRANT_URL:'http://127.0.0.1:9'});
  await writeFile(path.join(projektOrdner,'start-pg.txt'),'vor dem PG-Start\n');
  const d=starteDaemon('pg',env);
  try{
   await bis(()=>/listening http:\/\/127\.0\.0\.1:/.test(d.text()),30_000,250,'PG-Daemon-Start');
   await bis(()=>/\[enabled-sync\] aktiv \(.*Weg: PG\)/.test(d.text()),10_000,250,'enabled-sync PG');
   assert.doesNotMatch(d.text(),/Weg: API/);
   const startPg=await bis(()=>cf('start-pg.txt'),60_000,500,'Erstscan im PG-Weg');
   assert.equal(startPg.content,'vor dem PG-Start\n');await schlaf(1000);
   assert.deepEqual(await fvs('start-pg.txt'),startVersionenApi,'Erstscan-Versionen API-Weg == PG-Weg');
   await writeFile(path.join(projektOrdner,'pgweg.txt'),'pg-weg\n');
   await bis(async()=>(await cf('pgweg.txt'))?.content==='pg-weg\n',60_000,500,'Indexierung im PG-Weg');
   const rennenPg=await rennen('rennen-pg.txt');
   console.log('INFO C2 Loeschen direkt nach Aenderung (PG-Weg): '+JSON.stringify(rennenPg)+' | API-Weg: '+JSON.stringify(rennenApi));
  }finally{console.log('Daemon (PG) beendet: '+JSON.stringify(await d.stop()));}
  assert.doesNotMatch(d.text(),/DB-Sperre/);
 });
 console.log('RESULT P9_T27_W2 '+count+'/'+count+' PASS; schema='+schema);
}finally{
 for(const k of kinder)await k.stop().catch(()=>{});
 if(app)await app.close().catch(()=>{});
 if(auth)for(const t of tokens)await auth.revokeToken(t).catch(()=>{});
 if(made)await admin.query('DROP SCHEMA '+schema+' CASCADE').catch(e=>console.error('DROP SCHEMA',e.message));
 await admin.end();
 await rm(root,{recursive:true,force:true});
}
process.exit(0);
