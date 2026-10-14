#!/usr/bin/env node
/** P9-T27 Testphase (Welle 1, Schritte 1+2): Daemon-Job-Vertrag ueber die API.
 * Nur synapse_test (5433), eigenes Wegwerf-Schema (Kopien der Job-/Projekt-Tabellen, PGOPTIONS search_path),
 * eigene mkdtemp-Wurzel als HOME (config.json mit Test-Token), API nur auf 127.0.0.1 im eigenen Prozess.
 * Kein echter Daemon, kein Docker, keine Live-Registry.
 * Aufruf: node scripts/test-daemon-jobs-p9-t27.mjs (DATABASE_URL setzt der Synapse-Shell-Job). */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
const url=new URL(process.env.DATABASE_URL??'');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
const require=createRequire(new URL('../packages/core/package.json',import.meta.url)),{Client}=require('pg');
const admin=new Client({connectionString:url.href});await admin.connect();
assert.equal((await admin.query('SELECT current_database() AS db')).rows[0].db,'synapse_test');
const schema='p9_t27_'+randomUUID().replaceAll('-','');
const HOST=os.hostname(),P='t27-daemonjobs-'+process.pid,FREMD='t27-fremd-'+process.pid;
const root=await mkdtemp(path.join(os.tmpdir(),'p9-t27-'));
const projektOrdner=path.join(root,'projekt');
await mkdir(projektOrdner,{recursive:true});
// Alles in diesem Prozess (Core-Pool, LISTEN-Wecker) sieht zuerst das Testschema.
process.env.PGOPTIONS='-c search_path='+schema+',public';
process.env.HOME=root;os.homedir=()=>root;syncBuiltinESMExports();
delete process.env.SYNAPSE_DAEMON_JOBS_WEG;
let made=false,app,worker,count=0,auth=null;const tokens=[];
delete process.env.SYNAPSE_AUTH_DISABLED;
const check=async(name,fn)=>{await fn();console.log('PASS '+(++count)+' '+name);};
const q=(sql,args=[])=>admin.query(sql,args);
const row=async id=>(await q('SELECT * FROM '+schema+'.shell_jobs WHERE id=$1',[id])).rows[0];
async function neuerJob(command,extra={}){
 const r=await q('INSERT INTO '+schema+".shell_jobs(project,command,stream_id,timeout_ms,tail_lines,agent_id) VALUES($1,$2,$3,$4,$5,'claude-tp-a') RETURNING id",
  [extra.project??P,command,randomUUID().replaceAll('-','').slice(0,16),60_000,5]);
 return r.rows[0].id;
}
async function bis(fn,ms=30_000,schritt=200){const ende=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>ende)throw new Error('Zeitueberschreitung');await new Promise(r=>setTimeout(r,schritt));}}
try{
 await q('CREATE SCHEMA '+schema);made=true;
 for(const t of ['shell_jobs','specialist_jobs','projects','code_files','projekt_datenbanken','shell_sicherungsregeln','shell_antworttopf','shell_risiko_verben','wrapper_status','daemon_restore_host_bindings'])
  await q('CREATE TABLE '+schema+'.'+t+' (LIKE public.'+t+' INCLUDING ALL)');
 await q('INSERT INTO '+schema+'.projects(name,hostname,path,enabled) VALUES($1,$2,$3,true),($4,$5,$6,true)',[P,HOST,projektOrdner,FREMD,'t27-anderer-host','/fixture/fremd']);

 const core=await import('../packages/core/dist/index.js');
 const fastify=createRequire(new URL('../packages/rest-api/package.json',import.meta.url))('fastify');
 const {daemonJobsRoutes}=await import('../packages/rest-api/dist/routes/daemon-jobs.js');
 // Nachbesserung (Abnahme d996c097): ECHTER Auth-Hook + echte Token-Pruefung (auth_tokens in synapse_test)
 // + echte Hostbindung (daemon_restore_host_bindings im Testschema). Keine Fake-validateToken.
 const {registerAuthHook}=await import('../packages/rest-api/dist/middleware/auth-hook.js');
 auth=await import('../packages/rest-api/dist/services/auth.js');
 const neu=async t=>{tokens.push(t.token);return t.token;};
 const TOK=await neu(await auth.issueServiceToken('daemon:t27-test','t27')),FREMD_TOK=await neu(await auth.issueServiceToken('daemon:t27-fremd','t27-fremd'));
 const UNGEBUNDEN=await neu(await auth.issueServiceToken('daemon','t27-ungebunden')),ACCESS=await neu(await auth.issueAccessToken(null,'mcp:tools',60_000,null));
 const SESSION=await neu(await auth.issueSessionToken(null,60_000)),GPU=await neu(await auth.issueServiceToken('compute-node:t27','t27-gpu'));
 const hashOf=t=>createHash('sha256').update(t).digest('hex');
 await q('INSERT INTO '+schema+'.daemon_restore_host_bindings(token_hash,hostname) VALUES($1,$2),($3,$4)',[hashOf(TOK),HOST,hashOf(FREMD_TOK),'t27-anderer-host']);
 app=fastify({logger:false});registerAuthHook(app);await app.register(daemonJobsRoutes);
 const adresse=await app.listen({host:'127.0.0.1',port:0});
 await mkdir(path.join(root,'.synapse','file-watcher'),{recursive:true});
 await writeFile(path.join(root,'.synapse','file-watcher','config.json'),JSON.stringify({port:0,synapse_api_url:adresse,synapse_api_token:TOK,projekte:[]}));
 const D='daemon-'+HOST+'-'+process.pid,D2='daemon-'+HOST+'-999999',DF='daemon-t27-anderer-host-4711';
 const hdr=t=>({authorization:'Bearer '+t});
 const get=(qs,t=TOK)=>app.inject({method:'GET',url:'/api/daemon/shell/jobs?'+new URLSearchParams(qs),headers:hdr(t)});
 const post=(p,body,t=TOK)=>app.inject({method:'POST',url:p,payload:body,headers:hdr(t)});

 await check('Auth (echter Hook): ohne Token 401; Access/Session/GPU 403; ungebundener Daemon 403; fremder Host 403',async()=>{
  const id=await neuerJob('echo auth');
  assert.equal((await app.inject({method:'GET',url:'/api/daemon/shell/jobs?'+new URLSearchParams({host:HOST,daemon_id:D,projekte:P,warte:0})})).statusCode,401);
  for(const [name,t] of [['access',ACCESS],['session',SESSION],['gpu',GPU]]){
   const r=await get({host:HOST,daemon_id:D,projekte:P,warte:0},t);
   assert.equal(r.statusCode,403,name);assert.equal(r.json().error,'daemon_token_erforderlich',name);
   assert.equal((await post('/api/daemon/shell/wartung',{host:HOST,daemon_id:D,aktion:'reap'},t)).statusCode,403,name+' reap');
   assert.equal((await post('/api/daemon/shell/abschluss',{host:HOST,daemon_id:D,id,abschluss:{status:'done'}},t)).statusCode,403,name+' abschluss');
   assert.equal((await app.inject({method:'GET',url:'/api/daemon/specialist/jobs?'+new URLSearchParams({host:HOST,daemon_id:D,projekte:P,warte:0}),headers:hdr(t)})).statusCode,403,name+' specialist');
   assert.equal((await post('/api/daemon/specialist/wartung',{host:HOST,daemon_id:D,aktion:'expire'},t)).statusCode,403,name+' specialist-wartung');
  }
  const u=await get({host:HOST,daemon_id:D,projekte:P,warte:0},UNGEBUNDEN);
  assert.equal(u.statusCode,403);assert.equal(u.json().error,'daemon_host_nicht_gebunden');
  // fremder Daemon gibt sich als HOST aus -> host_verboten (claim, reap, abschluss)
  const f=await get({host:HOST,daemon_id:D,projekte:P,frei:4,warte:0},FREMD_TOK);
  assert.equal(f.statusCode,403);assert.equal(f.json().error,'host_verboten');
  assert.equal((await post('/api/daemon/shell/wartung',{host:HOST,daemon_id:D,aktion:'reap'},FREMD_TOK)).json().error,'host_verboten');
  assert.equal((await post('/api/daemon/specialist/jobs',{},FREMD_TOK)).statusCode,404,'nur GET');
  // ohne host-Angabe gilt der Token-Host: daemon_id des fremden Hosts passt nicht zu D
  assert.equal((await get({daemon_id:D,projekte:P,frei:4,warte:0},FREMD_TOK)).json().error,'daemon_id_ungueltig');
  assert.equal((await row(id)).status,'pending','nichts geclaimt');
  await q('DELETE FROM '+schema+'.shell_jobs WHERE id=$1',[id]);
 });
 await check('Fremder Daemon mit eigenem Host: nennt fremdes Projekt -> nichts; eigenes Projekt ja; reap/abschluss trifft HOST nicht',async()=>{
  const id=await neuerJob('echo nur-host'),fremdJob=await neuerJob('echo fremdprojekt',{project:FREMD});
  const r=(await get({daemon_id:DF,projekte:P+','+FREMD,frei:4,warte:0},FREMD_TOK)).json();
  assert.deepEqual(r.jobs.map(j=>j.id),[fremdJob],'nur das Projekt seines Hosts');
  assert.equal((await row(id)).status,'pending');
  // eigener Daemon claimt seinen Job, der fremde kann ihn weder abschliessen noch reapen
  const e=(await get({host:HOST,daemon_id:D,projekte:P+','+FREMD,frei:4,warte:0})).json();
  assert.deepEqual(e.jobs.map(j=>j.id),[id],'eigener Daemon: nur eigenes Projekt, FREMD bleibt aussen vor');
  const ab=await post('/api/daemon/shell/abschluss',{daemon_id:DF,id,abschluss:{status:'done'}},FREMD_TOK);
  assert.equal(ab.statusCode,409);assert.equal(ab.json().error,'nicht_eigener_job');
  const reap=(await post('/api/daemon/shell/wartung',{daemon_id:DF,aktion:'reap'},FREMD_TOK)).json();
  assert.equal(reap.success,true);assert.equal((await row(id)).status,'running','fremder reap trifft HOST nicht');
  assert.equal(reap.anzahl,1,'reap von DF trifft nur seinen eigenen Claim');
  assert.equal((await row(fremdJob)).status,'failed','reap von DF: Job FREMD hatte DF geclaimt -> failed');
  await q('DELETE FROM '+schema+'.shell_jobs WHERE id = ANY($1)',[[id,fremdJob]]);
 });

 await check('Vorpruefung: host/daemon_id/aktion/abschluss ungueltig -> 400',async()=>{
  assert.equal((await get({host:'a b',daemon_id:D,projekte:P,warte:0})).json().error,'host_ungueltig');
  assert.equal((await get({host:HOST,daemon_id:'daemon-anders-1',projekte:P,warte:0})).json().error,'daemon_id_ungueltig');
  assert.equal((await get({host:HOST,daemon_id:'daemon-'+HOST+'-x',projekte:P,warte:0})).statusCode,400);
  assert.equal((await post('/api/daemon/shell/wartung',{host:HOST,daemon_id:D,aktion:'loeschen'})).json().error,'aktion_unbekannt');
  assert.equal((await post('/api/daemon/shell/abschluss',{host:HOST,daemon_id:D,abschluss:{status:'done'}})).json().error,'id_fehlt');
  assert.equal((await post('/api/daemon/shell/abschluss',{host:HOST,daemon_id:D,id:randomUUID(),abschluss:{status:'gut'}})).json().error,'abschluss_ungueltig');
  assert.equal((await post('/api/daemon/specialist/wartung',{host:HOST,daemon_id:D,aktion:'x'})).statusCode,400);
 });
 await check('Long-Poll ohne Jobs kehrt leer zurueck; frei=0 claimt nichts',async()=>{
  const r=await get({host:HOST,daemon_id:D,projekte:P,warte:0});
  assert.equal(r.statusCode,200);assert.deepEqual([r.json().jobs,r.json().abbrueche],[[],[]]);
  const id=await neuerJob('echo frei0');
  const f=await get({host:HOST,daemon_id:D,projekte:P,frei:0,warte:0});
  assert.deepEqual(f.json().jobs,[]);assert.equal((await row(id)).status,'pending');
  await q('DELETE FROM '+schema+'.shell_jobs WHERE id=$1',[id]);
 });
 await check('Long-Poll claimt fuer den Daemon (nur eigene Projekte), Abbruchwunsch kommt als abbrueche',async()=>{
  const id=await neuerJob('echo claim'),fremd=await neuerJob('echo fremd',{project:FREMD});
  const r=(await get({host:HOST,daemon_id:D,projekte:P+',../boese',frei:4,warte:1})).json();
  assert.deepEqual(r.jobs.map(j=>j.id),[id]);
  const z=await row(id);assert.equal(z.status,'running');assert.equal(z.claimed_by,D);
  assert.equal((await row(fremd)).status,'pending');
  await q('UPDATE '+schema+".shell_jobs SET cancelled_at=NOW(),cancelled_by='t27' WHERE id=$1",[id]);
  const a=(await get({host:HOST,daemon_id:D,projekte:P,frei:0,warte:0})).json();
  assert.deepEqual(a.abbrueche,[id]);
  assert.deepEqual((await get({host:HOST,daemon_id:D2,projekte:P,frei:0,warte:0})).json().abbrueche,[],'fremder Daemon sieht den Abbruch nicht');
  await q('DELETE FROM '+schema+'.shell_jobs WHERE id = ANY($1)',[[id,fremd]]);
 });
 await check('Long-Poll wartet und liefert einen spaeter eingereihten Job (Nachfrage-Takt)',async()=>{
  const t0=Date.now();
  const lauf=get({host:HOST,daemon_id:D,projekte:P,frei:1,warte:10});
  await new Promise(r=>setTimeout(r,400));
  const id=await neuerJob('echo spaeter');
  const r=(await lauf).json();
  assert.deepEqual(r.jobs.map(j=>j.id),[id]);assert.ok(Date.now()-t0<6000,'kam erst nach '+(Date.now()-t0)+' ms');
  await q('DELETE FROM '+schema+'.shell_jobs WHERE id=$1',[id]);
 });
 await check('Verbindung weg waehrend des Long-Polls: geclaimter Job geht zurueck auf pending',async()=>{
  const id=await neuerJob('echo zurueck');let n=0;
  const r=await core.holeShellJobsFuerDaemon({daemonId:D,host:HOST,projekte:[P],frei:1,warteMs:0,istGeschlossen:()=>++n>=3});
  assert.deepEqual(r,{jobs:[],abbrueche:[]});
  const z=await row(id);assert.equal(z.status,'pending');assert.equal(z.claimed_by,null);
  // echtes HTTP-Abbrechen: danach eingereihter Job wird nicht mehr geclaimt
  await q('DELETE FROM '+schema+'.shell_jobs WHERE id=$1',[id]);
  const ac=new AbortController();
  const lauf=fetch(adresse+'/api/daemon/shell/jobs?'+new URLSearchParams({host:HOST,daemon_id:D,projekte:P,frei:1,warte:6}),{signal:ac.signal}).catch(e=>e);
  await new Promise(r=>setTimeout(r,300));ac.abort();await lauf;
  const spaet=await neuerJob('echo nach-abbruch');
  await new Promise(r=>setTimeout(r,3500));
  assert.equal((await row(spaet)).status,'pending');
  await q('DELETE FROM '+schema+'.shell_jobs WHERE id=$1',[spaet]);
 });
 await check('Abschluss: unbekannt 404, fremder Daemon 409, eigener 200 ueber completeShellJob (Abbruch-Vorrang)',async()=>{
  const id=await neuerJob('echo abschluss');
  await get({host:HOST,daemon_id:D,projekte:P,frei:1,warte:0});
  const unbekannt=await post('/api/daemon/shell/abschluss',{host:HOST,daemon_id:D,id:randomUUID(),abschluss:{status:'done'}});
  assert.equal(unbekannt.statusCode,404);assert.equal(unbekannt.json().error,'job_unbekannt');
  const fremd=await post('/api/daemon/shell/abschluss',{host:HOST,daemon_id:D2,id,abschluss:{status:'done'}});
  assert.equal(fremd.statusCode,409);assert.equal(fremd.json().error,'nicht_eigener_job');
  const ok=await post('/api/daemon/shell/abschluss',{host:HOST,daemon_id:D,id,abschluss:{status:'done',exit_code:0,output:'abschluss\n',tail:['abschluss']}});
  assert.equal(ok.statusCode,200);assert.equal(ok.json().status,'done');
  const z=await row(id);assert.deepEqual([z.status,z.exit_code,z.output],['done',0,'abschluss\n']);
  const ab=await neuerJob('echo ab');
  await get({host:HOST,daemon_id:D,projekte:P,frei:1,warte:0});
  await q('UPDATE '+schema+".shell_jobs SET cancelled_at=NOW(),cancelled_by='t27' WHERE id=$1",[ab]);
  const r=await post('/api/daemon/shell/abschluss',{host:HOST,daemon_id:D,id:ab,abschluss:{status:'done',exit_code:0}});
  assert.equal(r.json().status,'failed');assert.equal((await row(ab)).error,'cancelled');
 });
 await check('Wartung: reap (nur dieser Host), expire, eigene_laufende',async()=>{
  const alt=await neuerJob('echo verwaist'),fremderHost=await neuerJob('echo fremderhost'),eigen=await neuerJob('echo eigen');
  await q('UPDATE '+schema+".shell_jobs SET status='running',claimed_by=$2,claimed_at=NOW() WHERE id=$1",[alt,D2]);
  await q('UPDATE '+schema+".shell_jobs SET status='running',claimed_by='daemon-anderer-1',claimed_at=NOW() WHERE id=$1",[fremderHost]);
  await q('UPDATE '+schema+".shell_jobs SET status='running',claimed_by=$2,claimed_at=NOW() WHERE id=$1",[eigen,D]);
  const laufende=(await post('/api/daemon/shell/wartung',{host:HOST,daemon_id:D,aktion:'eigene_laufende'})).json().jobs.map(j=>j.id);
  assert.deepEqual(laufende,[eigen]);
  const reap=(await post('/api/daemon/shell/wartung',{host:HOST,daemon_id:D,aktion:'reap'})).json();
  assert.equal(reap.anzahl,2,'reap trifft alle running-Claims dieses Hosts (alter + eigener Lauf), nicht den fremden Host');
  assert.equal((await row(alt)).error,'daemon_restart');assert.equal((await row(fremderHost)).status,'running');
  const exp=await neuerJob('echo alt');
  await q('UPDATE '+schema+".shell_jobs SET created_at=NOW()-interval '5 hours' WHERE id=$1",[exp]);
  const e=(await post('/api/daemon/shell/wartung',{host:HOST,daemon_id:D,aktion:'expire'})).json();
  assert.ok(e.anzahl>=1);assert.notEqual((await row(exp)).status,'pending');
  await q('DELETE FROM '+schema+'.shell_jobs');
 });

 // ── Spezialisten ──
 const sp=(qs)=>app.inject({method:'GET',url:'/api/daemon/specialist/jobs?'+new URLSearchParams(qs),headers:hdr(TOK)});
 const spJob=async(project,args)=>(await q('INSERT INTO '+schema+".specialist_jobs(project,action,args) VALUES($1,'status',$2::jsonb) RETURNING id",[project,JSON.stringify(args)])).rows[0].id;
 await check('Spezialisten: Claim nur fuer diesen Host (target_hostname), lokaler_projektpfad gesetzt, Abschluss nur eigener',async()=>{
  const eigen=await spJob(P,{target_hostname:HOST}),anderer=await spJob(P,{target_hostname:'t27-anderer-host'}),fremdProj=await spJob(FREMD,{});
  const r=(await sp({host:HOST,daemon_id:D,projekte:P+','+FREMD,warte:0})).json();
  const ids=r.jobs.map(j=>j.id).sort();
  // Nachbesserung: Projekt FREMD liegt nur auf einem anderen Host -> wird nicht mehr geclaimt.
  assert.deepEqual(ids,[eigen]);
  assert.equal(r.jobs.find(j=>j.id===eigen).lokaler_projektpfad,projektOrdner);
  assert.equal((await q('SELECT status FROM '+schema+'.specialist_jobs WHERE id=$1',[fremdProj])).rows[0].status,'pending','Projekt liegt auf anderem Host');
  const fr=(await app.inject({method:'GET',url:'/api/daemon/specialist/jobs?'+new URLSearchParams({daemon_id:DF,projekte:P+','+FREMD,warte:0}),headers:hdr(FREMD_TOK)})).json();
  assert.deepEqual(fr.jobs.map(j=>j.id),[fremdProj],'fremder Daemon: nur Projekt seines Hosts, nicht P');
  assert.equal((await q('SELECT status FROM '+schema+'.specialist_jobs WHERE id=$1',[anderer])).rows[0].status,'pending');
  assert.equal((await post('/api/daemon/specialist/abschluss',{host:HOST,daemon_id:D2,id:eigen,abschluss:{status:'done'}})).statusCode,409);
  assert.equal((await post('/api/daemon/specialist/abschluss',{host:HOST,daemon_id:D,id:randomUUID(),abschluss:{status:'done'}})).statusCode,404);
  assert.equal((await post('/api/daemon/specialist/abschluss',{host:HOST,daemon_id:D,id:eigen,abschluss:{status:'nix'}})).statusCode,400);
  const ok=await post('/api/daemon/specialist/abschluss',{host:HOST,daemon_id:D,id:eigen,abschluss:{status:'done',result:{ok:1},message:'fertig'}});
  assert.equal(ok.statusCode,200);
  assert.deepEqual((await q('SELECT status,result,message FROM '+schema+'.specialist_jobs WHERE id=$1',[eigen])).rows[0],{status:'done',result:{ok:1},message:'fertig'});
  // Verbindung weg -> Spezialisten-Job zurueck
  const z=await spJob(P,{});let n=0;
  assert.deepEqual(await core.holeSpecialistJobsFuerDaemon({daemonId:D,host:HOST,projekte:[P],warteMs:0,istGeschlossen:()=>++n>=2}),[]);
  assert.equal((await q('SELECT status FROM '+schema+'.specialist_jobs WHERE id=$1',[z])).rows[0].status,'pending');
  const exp=(await post('/api/daemon/specialist/wartung',{host:HOST,daemon_id:D,aktion:'expire',max_alter_s:30})).json();
  assert.equal(exp.success,true);
  // P10-T78 Folgepunkt b: expire wirkt hostuebergreifend -> Untergrenze 30 s; ein 10 s alter Job eines anderen Hosts bleibt.
  const jung=await spJob(FREMD,{});
  await q('UPDATE '+schema+".specialist_jobs SET created_at=NOW()-interval '10 seconds' WHERE id=$1",[jung]);
  const kurz=(await post('/api/daemon/specialist/wartung',{host:HOST,daemon_id:D,aktion:'expire',max_alter_s:1})).json();
  assert.equal(kurz.max_alter_s,30);
  assert.equal((await q('SELECT status FROM '+schema+'.specialist_jobs WHERE id=$1',[jung])).rows[0].status,'pending','Untergrenze 30 s');
  assert.equal((await post('/api/daemon/specialist/wartung',{host:HOST,daemon_id:D,aktion:'expire',max_alter_s:'abc'})).json().max_alter_s,30);
  assert.equal((await post('/api/daemon/specialist/wartung',{host:HOST,daemon_id:D,aktion:'expire',max_alter_s:3600})).json().max_alter_s,3600);
  await q('UPDATE '+schema+".specialist_jobs SET created_at=NOW()-interval '5 minutes' WHERE id=$1",[jung]);
  assert.ok((await post('/api/daemon/specialist/wartung',{host:HOST,daemon_id:D,aktion:'expire',max_alter_s:1})).json().anzahl>=1);
  assert.equal((await q('SELECT status FROM '+schema+'.specialist_jobs WHERE id=$1',[jung])).rows[0].status,'rejected','aelter als 30 s');
 });
 await check('Spezialisten-Wartung: wrapper_kandidaten nur Host-Projekte, wrapper_abgestuerzt fremd 409 / eigen CAS',async()=>{
  const spalten=(await q("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='wrapper_status' AND is_nullable='NO' AND column_default IS NULL",[schema])).rows.map(r=>r.column_name);
  const basis={project:P,agent_name:'t27-agent',wrapper_pid:424242,status:'running'};
  const zeile=(o)=>{const w={...basis,...o};for(const s of spalten)if(!(s in w))w[s]=s==='model'?'fixture':'x';return w;};
  for(const w of [zeile({}),zeile({project:FREMD,agent_name:'t27-fremd'})]){
   const k=Object.keys(w);
   await q('INSERT INTO '+schema+'.wrapper_status('+k.join(',')+',last_activity) VALUES('+k.map((_,i)=>'$'+(i+1)).join(',')+",NOW()-interval '10 minutes')",Object.values(w));
  }
  const kand=(await post('/api/daemon/specialist/wartung',{host:HOST,daemon_id:D,aktion:'wrapper_kandidaten',projekte:[P,FREMD],alter_ms:60_000})).json().kandidaten;
  assert.deepEqual(kand.map(k=>[k.project,k.agent_name,k.path]),[[P,'t27-agent',projektOrdner]]);
  const fremd=await post('/api/daemon/specialist/wartung',{host:HOST,daemon_id:D,aktion:'wrapper_abgestuerzt',kandidat:{project:FREMD,agent_name:'t27-fremd',wrapper_pid:424242,last_activity:kand[0].last_activity}});
  assert.equal(fremd.statusCode,409);assert.equal(fremd.json().error,'projekt_nicht_auf_diesem_host');
  assert.equal((await post('/api/daemon/specialist/wartung',{host:HOST,daemon_id:D,aktion:'wrapper_abgestuerzt',kandidat:{project:P}})).statusCode,400);
  const ok=(await post('/api/daemon/specialist/wartung',{host:HOST,daemon_id:D,aktion:'wrapper_abgestuerzt',kandidat:kand[0]})).json();
  assert.equal(ok.anzahl,1);
  assert.equal((await q('SELECT status FROM '+schema+".wrapper_status WHERE agent_name='t27-agent'")).rows[0].status,'crashed');
  assert.equal((await post('/api/daemon/specialist/wartung',{host:HOST,daemon_id:D,aktion:'wrapper_abgestuerzt',kandidat:kand[0]})).json().anzahl,0,'CAS: zweites Mal nichts');
 });

 // ── Daemon-Seite ──
 const api=await import('../packages/file-watcher-daemon-ts/dist/daemon-jobs-api.js');
 await check('Schalter daemon_jobs_weg: Vorgabe pg, env vor config, unbekannt -> pg; API-Weg ohne Token wirft',async()=>{
  assert.equal(api.daemonJobsWeg(),'pg');
  process.env.SYNAPSE_DAEMON_JOBS_WEG=' API ';assert.equal(api.daemonJobsWeg(),'api');
  process.env.SYNAPSE_DAEMON_JOBS_WEG='quatsch';assert.equal(api.daemonJobsWeg(),'pg');
  delete process.env.SYNAPSE_DAEMON_JOBS_WEG;
  const cfgPfad=path.join(root,'.synapse','file-watcher','config.json');
  await writeFile(cfgPfad,JSON.stringify({port:0,synapse_api_url:adresse,projekte:[],daemon_jobs_weg:'api'}));
  assert.equal(api.daemonJobsWeg(),'api');
  assert.throws(()=>api.pruefeApiWeg(),/synapse_api_token/);
  process.env.SYNAPSE_DAEMON_JOBS_WEG='pg';assert.equal(api.daemonJobsWeg(),'pg','env hat Vorrang');
  delete process.env.SYNAPSE_DAEMON_JOBS_WEG;
  await writeFile(cfgPfad,JSON.stringify({port:0,synapse_api_url:adresse,synapse_api_token:TOK,projekte:[],daemon_jobs_weg:'api'}));
  api.pruefeApiWeg();
 });
 await check('Daemon-Client gegen die Test-API: holen/melden/Wartung ueber HTTP',async()=>{
  const id=await neuerJob('echo client');
  const a=await api.holeShellJobsApi({daemonId:D,projekte:[P],frei:1,warteS:0});
  assert.deepEqual(a.jobs.map(j=>j.id),[id]);
  await api.meldeShellAbschlussApi(id,D,{status:'done',exit_code:0,output:'x'.repeat(1_000_100),tail:['x']});
  const z=await row(id);assert.equal(z.status,'done');assert.equal(z.output_truncated,true,'Kuerzung macht weiter completeShellJob');
  await api.meldeShellAbschlussApi(id,D2,{status:'done'}); // nicht_eigener_job: verworfen, kein Wurf
  assert.deepEqual(await api.shellWartungApi('eigene_laufende',D),[]);
  await assert.rejects(api.holeShellJobsApi({daemonId:'daemon-falsch-1',projekte:[P],frei:1,warteS:0}),e=>e.status===400&&e.code==='daemon_id_ungueltig');
  await q('DELETE FROM '+schema+'.shell_jobs');
 });

 // Echter Worker im API-Weg + Vergleich mit dem PG-Weg
 const homeAlt=os.homedir;
 const echtFetch=globalThis.fetch;
 globalThis.fetch=async(ziel,init)=>String(ziel).startsWith(adresse)?echtFetch(ziel,init):Response.json({enabled:true});
 process.env.SYNAPSE_DAEMON_JOBS_WEG='api';
 const sw=await import('../packages/file-watcher-daemon-ts/dist/shell-job-worker.js');
 const befehl="printf 't27-ok\\nzeile2\\n'; exit 3";
 let apiRow;
 await check('Shell-Worker (Weg API): Job laeuft, Ergebnis landet ueber die API in shell_jobs',async()=>{
  worker=await sw.startShellJobWorker(()=>[P]);
  const id=await neuerJob(befehl);
  apiRow=await bis(async()=>{const z=await row(id);return ['done','failed','rejected','timeout'].includes(z.status)?z:null;});
  assert.equal(apiRow.claimed_by,D);
  assert.equal(apiRow.status,'failed',JSON.stringify({error:apiRow.error,message:apiRow.message}));
  assert.equal(apiRow.exit_code,3);assert.match(apiRow.output??'',/t27-ok\nzeile2/);
 });
 await check('Shell-Worker (Weg API): Abbruch kommt per Long-Poll an und beendet den Prozess',async()=>{
  const id=await neuerJob('sleep 60');
  await bis(async()=>(await row(id)).status==='running');
  await new Promise(r=>setTimeout(r,800));
  await q('UPDATE '+schema+".shell_jobs SET cancelled_at=NOW(),cancelled_by='t27' WHERE id=$1",[id]);
  const z=await bis(async()=>{const x=await row(id);return x.status!=='running'?x:null;},20_000);
  assert.equal(z.status,'failed');assert.equal(z.error,'cancelled');
 });
 await worker.stop();worker=null;
 await check('Golden: derselbe Befehl ueber den PG-Weg (eigener Prozess) liefert dieselbe Ergebniszeile',async()=>{
  const id=await neuerJob(befehl);
  const kind=`
   import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';
   os.homedir=()=>${JSON.stringify(root)};syncBuiltinESMExports();
   const echt=globalThis.fetch;globalThis.fetch=async()=>Response.json({enabled:true});
   const core=await import(${JSON.stringify(new URL('../packages/core/dist/index.js',import.meta.url).href)});
   const sw=await import(${JSON.stringify(new URL('../packages/file-watcher-daemon-ts/dist/shell-job-worker.js',import.meta.url).href)});
   const job=await core.claimPendingShellJob(${JSON.stringify(P)},'daemon-'+os.hostname()+'-'+process.pid);
   if(!job)throw new Error('kein Job');
   await sw.runClaimedJob(job.project,job);
   process.exit(0);`;
  const env={...process.env};delete env.SYNAPSE_DAEMON_JOBS_WEG;
  const code=await new Promise((res,rej)=>{const c=spawn(process.execPath,['--input-type=module','-e',kind],{env,stdio:['ignore','ignore','inherit']});c.on('error',rej);c.on('exit',res);});
  assert.equal(code,0);
  const pgRow=await row(id);
  const norm=z=>({status:z.status,exit_code:z.exit_code,tail:z.tail,output:z.output,error:z.error,message:z.message,output_truncated:z.output_truncated});
  assert.deepEqual(norm(apiRow),norm(pgRow));
 });
 globalThis.fetch=echtFetch;os.homedir=homeAlt;
 console.log('RESULT P9_T27 '+count+'/'+count+' PASS; schema='+schema);
}finally{
 if(worker)await worker.stop().catch(()=>{});
 if(app)await app.close().catch(()=>{});
 if(auth)for(const t of tokens)await auth.revokeToken(t).catch(()=>{});
 if(made)await admin.query('DROP SCHEMA '+schema+' CASCADE');
 await admin.end();
 await rm(root,{recursive:true,force:true});
}
process.exit(0);
