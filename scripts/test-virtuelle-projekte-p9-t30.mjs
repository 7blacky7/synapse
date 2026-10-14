/** P9-T30 Testphase: virtuelle API-Projekte nie an einen PC binden + host_loesen.
 * Nur synapse_test (5433), eigenes Wegwerf-Schema, keine Dateisystem-Schreibzugriffe, kein Daemon, kein Docker.
 * Aufruf: node scripts/test-virtuelle-projekte-p9-t30.mjs (DATABASE_URL setzt der Synapse-Shell-Job). */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const pg=createRequire(new URL('../packages/core/package.json',import.meta.url))('pg');
const url=new URL(process.env.DATABASE_URL??'');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
process.env.SYNAPSE_API_FEATURES='asset_sync';
delete process.env.SYNAPSE_VIRTUELLE_PROJEKTE;
const db=new pg.Client({connectionString:url.toString()});
await db.connect();
try{assert.equal((await db.query('SELECT current_database() AS db')).rows[0].db,'synapse_test');}
catch(e){await db.end();throw e;}
const schema='p9_t30_'+randomUUID().replaceAll('-','');
const core=await import('../packages/core/dist/index.js');
const {ProjectRestoreService}=await import('../packages/core/dist/services/project-restore.js');
const {PROJECT_RESTORE_SCHEMA_SQL}=await import('../packages/core/dist/db/project-restore-schema.js');
const queue=await import('../packages/core/dist/services/project-init-queue.js');
const {mitLesePool}=await import('../packages/core/dist/db/client.js');
const adapter={query:db.query.bind(db),connect:async()=>({query:db.query.bind(db),release(){}})};
const service=new ProjectRestoreService(adapter);
const VIRT='reverse-bibliothek',P='p9-t30-test',HOST='p9-t30-host',HOST2='p9-t30-host2',hash='b'.repeat(64);
let count=0,app,realApp,authMod=null;const realTokens=[];
delete process.env.SYNAPSE_AUTH_DISABLED;
async function check(name,fn){await fn();console.log('PASS '+(++count)+' '+name);}
const code=(c)=>e=>{assert.equal(e.code,c,String(e?.message));return true;};
const n=async(sql,args=[])=>Number((await db.query(sql,args)).rows[0].n);
async function stand(){
 return JSON.stringify({
  projects:(await db.query('SELECT name,hostname,path,enabled FROM projects ORDER BY name,hostname')).rows,
  bindings:(await db.query('SELECT project,hostname,enabled FROM project_host_bindings ORDER BY project,hostname')).rows,
  jobs:(await db.query('SELECT id,name,hostname,mode,status,error FROM project_init_jobs ORDER BY created_at,id')).rows,
  manifests:(await db.query('SELECT project,hostname FROM project_code_manifests ORDER BY project,hostname')).rows,
 });
}
await mitLesePool(adapter,async()=>{
try{
 await db.query('CREATE SCHEMA '+schema);
 await db.query('SET search_path TO '+schema+',public');
 for(const t of ['projects','code_files'])await db.query('CREATE TABLE '+schema+'.'+t+' (LIKE public.'+t+' INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)');
 await db.query("CREATE TABLE project_init_jobs(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, hostname TEXT, template TEXT, requested_by TEXT, status TEXT NOT NULL DEFAULT 'pending', resolved_path TEXT,error TEXT,message TEXT,claimed_by TEXT,claimed_at TIMESTAMPTZ,completed_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())");
 await db.query(PROJECT_RESTORE_SCHEMA_SQL);
 await db.query(`INSERT INTO projects(name,hostname,path,enabled) VALUES
  ($1,'rest-api','/virtual/rest-api',true),
  ($2,'rest-api','/virtual/rest-api',true),($2,$3,'/fixture/p9-t30',true),($2,'other-host','/fixture/other',true),($2,$4,'/fixture/host2',true)`,[VIRT,P,HOST,HOST2]);

 // (a) virtuelle Projekte nie binden / anlegen / ausliefern
 await check('virtuelles Projekt: restore_existing mit bind -> 409 virtuelles_projekt, keine Bindung, kein Job',async()=>{
  await assert.rejects(service.enqueue(VIRT,HOST,'koordinator',true),e=>e.code==='virtuelles_projekt'&&e.httpStatus===409);
  assert.equal(await n('SELECT count(*) AS n FROM project_host_bindings WHERE project=$1',[VIRT]),0);
  assert.equal(await n('SELECT count(*) AS n FROM project_init_jobs WHERE name=$1',[VIRT]),0);
 });
 await check('virtuelles Projekt: project init (create + restore) wirft VirtuellesProjektFehler vor jedem DB-Zugriff',async()=>{
  await assert.rejects(queue.enqueueProjectInitJob({name:VIRT,hostname:HOST}),e=>e instanceof core.VirtuellesProjektFehler&&e.code==='virtuelles_projekt');
  await assert.rejects(queue.enqueueProjectInitJob({name:VIRT,hostname:HOST,mode:'restore_existing'}),code('virtuelles_projekt'));
  assert.equal(await n('SELECT count(*) AS n FROM project_init_jobs WHERE name=$1',[VIRT]),0);
  assert.equal(core.istVirtuellesProjekt(VIRT),true);assert.equal(core.istVirtuellesProjekt(P),false);
  assert.equal(core.istVirtuellerRegistryPfad('/virtual/rest-api'),true);assert.equal(core.istVirtuellerRegistryPfad('/virtualx'),false);
  assert.equal(core.istVirtuellerRegistryPfad('/home/x/dev/'+VIRT),false);
  assert.equal(core.istVirtuellesProjekt('p9-t30-extra',{SYNAPSE_VIRTUELLE_PROJEKTE:' p9-t30-extra , '}),true);
 });
 await check('Altbestand (Bindung + Restore-Job eines virtuellen Projekts): binding false, claim liefert nie, renew/complete verweigert, keine PC-Zeile',async()=>{
  await db.query('INSERT INTO project_host_bindings(project,hostname) VALUES($1,$2)',[VIRT,HOST]);
  const alt=(await db.query("INSERT INTO project_init_jobs(name,hostname,mode) VALUES($1,$2,'restore_existing') RETURNING id",[VIRT,HOST])).rows[0].id;
  assert.equal(await service.binding(VIRT,HOST),false);
  assert.equal(await service.claim(HOST),null);
  const lease=randomUUID();
  await db.query("UPDATE project_init_jobs SET status='running',restore_lease=$2,lease_until=clock_timestamp()+interval '5 minutes' WHERE id=$1",[alt,lease]);
  await assert.rejects(service.renew(alt,HOST,lease),code('restore_lease_veraltet'));
  await assert.rejects(service.complete(alt,HOST,lease,{status:'done',path:'/home/x/dev/'+VIRT}),code('virtuelles_projekt'));
  assert.equal(await n('SELECT count(*) AS n FROM projects WHERE name=$1 AND hostname=$2',[VIRT,HOST]),0);
  await service.complete(alt,HOST,lease,{status:'failed',error:'fixture'});
  assert.equal((await db.query('SELECT status FROM project_init_jobs WHERE id=$1',[alt])).rows[0].status,'failed');
  await db.query('DELETE FROM project_host_bindings WHERE project=$1',[VIRT]);
 });

 // (b) host_loesen
 await check('host_loesen: nur Koordinator/User, nie rest-api, ungueltige Eingaben 400',async()=>{
  await assert.rejects(core.projektHostLoesen({project:P,hostname:HOST,agent:'claude-tp-a'}),e=>e.code==='nur_koordinator'&&e.httpStatus===403);
  await assert.rejects(core.projektHostLoesen({project:P,hostname:HOST,agent:'user'}),code('nur_koordinator'));
  // Nachbesserung (Abnahme d996c097): berechtigung 'tray' ohne User-Kontext der Route umgeht die Rollenpruefung nicht.
  await assert.rejects(core.projektHostLoesen({project:P,hostname:HOST,agent:'tray:'+HOST,berechtigung:'tray',vorschau:false}),e=>e.code==='nur_koordinator'&&e.httpStatus===403);
  assert.equal((await core.mitUserHerkunft('tray',()=>core.projektHostLoesen({project:P,hostname:HOST,agent:'tray:'+HOST,berechtigung:'tray'}))).status,'vorschau');
  await assert.rejects(core.projektHostLoesen({project:P,hostname:'rest-api',agent:'koordinator',vorschau:false}),e=>e.code==='virtueller_host'&&e.httpStatus===400);
  await assert.rejects(core.projektHostLoesen({project:P,hostname:'a/b',agent:'koordinator'}),e=>e.code==='host_ungueltig'&&e.httpStatus===400);
  await assert.rejects(core.projektHostLoesen({project:'../x',hostname:HOST,agent:'koordinator'}),e=>e.code==='invalid_name'&&e.httpStatus===400);
  assert.equal(await n('SELECT count(*) AS n FROM projects WHERE name=$1',[P]),4);
 });
 await db.query('INSERT INTO project_host_bindings(project,hostname) VALUES($1,$2)',[P,HOST]);
 const restoreJob=(await service.enqueue(P,HOST,'fixture')).id;
 await db.query("INSERT INTO project_code_manifests(id,project,hostname,lease_until) VALUES($1,$2,$3,clock_timestamp()+interval '5 minutes')",[randomUUID(),P,HOST]);
 await check('host_loesen Vorschau (Standard) aendert nichts und nennt genau die eine Zeile',async()=>{
  const vorher=await stand();
  const r=await core.projektHostLoesen({project:P,hostname:HOST,agent:'koordinator'});
  assert.equal(r.status,'vorschau');assert.equal(r.virtuell,false);
  assert.deepEqual(r.entfernt.registry_zeile,{hostname:HOST,path:'/fixture/p9-t30',enabled:true});
  assert.equal(r.entfernt.tray_bindung_abschalten,true);assert.deepEqual(r.entfernt.restore_jobs_beenden,[restoreJob]);
  assert.deepEqual(r.bleibt.registry.map(z=>z.hostname).sort(),['other-host',HOST2,'rest-api'].sort());
  assert.equal(await stand(),vorher);
 });
 let auftrag;
 await check('host_loesen Ausfuehren: nur diese Registry-Zeile weg, rest-api/andere Hosts bleiben, Bindung false, Restore-Job failed, Manifest weg, ein Daemon-Auftrag',async()=>{
  const r=await core.projektHostLoesen({project:P,hostname:HOST,agent:'koordinator',vorschau:false});
  assert.equal(r.status,'geloest');assert.equal(r.ergebnis.registry_zeile_entfernt,true);assert.equal(r.ergebnis.tray_bindung_abgeschaltet,true);
  assert.deepEqual(r.ergebnis.restore_jobs_beendet,[restoreJob]);assert.equal(r.ergebnis.daemon_job_wiederverwendet,false);
  auftrag=r.ergebnis.daemon_job_id;
  assert.deepEqual((await db.query('SELECT hostname FROM projects WHERE name=$1 ORDER BY hostname',[P])).rows.map(x=>x.hostname),['other-host',HOST2,'rest-api'].sort());
  assert.equal(await n('SELECT count(*) AS n FROM projects WHERE name=$1',[VIRT]),1);
  assert.equal((await db.query('SELECT enabled FROM project_host_bindings WHERE project=$1 AND hostname=$2',[P,HOST])).rows[0].enabled,false);
  const rj=(await db.query('SELECT status,error FROM project_init_jobs WHERE id=$1',[restoreJob])).rows[0];
  assert.deepEqual(rj,{status:'failed',error:'host_geloest'});
  assert.equal(await n('SELECT count(*) AS n FROM project_code_manifests WHERE project=$1 AND hostname=$2',[P,HOST]),0);
  const jobs=(await db.query("SELECT id,status,requested_by FROM project_init_jobs WHERE name=$1 AND hostname=$2 AND mode='host_loesen'",[P,HOST])).rows;
  assert.deepEqual(jobs,[{id:auftrag,status:'pending',requested_by:'koordinator'}]);
  // Projekt bleibt projektweit aktiv (kein disable)
  assert.equal(await n('SELECT count(*) AS n FROM projects WHERE name=$1 AND NOT enabled',[P]),0);
 });
 await check('host_loesen erneut: Auftrag wird wiederverwendet, kein zweiter Job',async()=>{
  const r=await core.projektHostLoesen({project:P,hostname:HOST,agent:'koordinator',vorschau:false});
  assert.equal(r.ergebnis.registry_zeile_entfernt,false);assert.equal(r.ergebnis.daemon_job_id,auftrag);assert.equal(r.ergebnis.daemon_job_wiederverwendet,true);
  assert.equal(await n("SELECT count(*) AS n FROM project_init_jobs WHERE mode='host_loesen'"),1);
 });
 await check('host_loesen-Auftrag: Legacy-Claim, Expire und Restore-Claim fassen ihn nie an',async()=>{
  assert.equal(await queue.claimPendingProjectInitJob('legacy-worker',HOST),null);
  await db.query("UPDATE project_init_jobs SET created_at=clock_timestamp()-interval '2 minutes' WHERE id=$1",[auftrag]);
  await queue.expirePendingProjectInitJobs(30);
  assert.equal((await db.query('SELECT status FROM project_init_jobs WHERE id=$1',[auftrag])).rows[0].status,'pending');
  assert.equal(await service.claim(HOST),null);
 });
 await check('Daemon-Seite: claim nur eigener Host, complete nur eigener laufender Auftrag',async()=>{
  assert.deepEqual(await core.claimHostLoesungen('other-host',adapter),[]);
  assert.deepEqual(await core.claimHostLoesungen(HOST,adapter),[{id:auftrag,name:P}]);
  assert.deepEqual(await core.claimHostLoesungen(HOST,adapter),[]);
  await assert.rejects(core.schliesseHostLoesung(auftrag,'other-host',{status:'done'},adapter),e=>e.code==='host_loesen_job_unbekannt'&&e.httpStatus===404);
  await assert.rejects(core.schliesseHostLoesung(auftrag,HOST,{status:'weg'},adapter),code('status_ungueltig'));
  await assert.rejects(core.schliesseHostLoesung('kein-uuid',HOST,{status:'done'},adapter),code('id_ungueltig'));
  await core.schliesseHostLoesung(auftrag,HOST,{status:'done',message:'entfernt'},adapter);
  assert.deepEqual((await db.query('SELECT status,message,error FROM project_init_jobs WHERE id=$1',[auftrag])).rows[0],{status:'done',message:'entfernt',error:null});
  await assert.rejects(core.schliesseHostLoesung(auftrag,HOST,{status:'done'},adapter),code('host_loesen_job_unbekannt'));
 });
 await check('host_loesen: haengender Auftrag (>10 min running) wird neu vergeben',async()=>{
  const r=await core.projektHostLoesen({project:P,hostname:'other-host',agent:'koordinator',vorschau:false});
  const id=r.ergebnis.daemon_job_id;
  assert.equal((await core.claimHostLoesungen('other-host',adapter)).length,1);
  assert.equal((await core.claimHostLoesungen('other-host',adapter)).length,0);
  await db.query("UPDATE project_init_jobs SET claimed_at=clock_timestamp()-interval '11 minutes' WHERE id=$1",[id]);
  assert.deepEqual((await core.claimHostLoesungen('other-host',adapter)).map(j=>j.id),[id]);
  await core.schliesseHostLoesung(id,'other-host',{status:'failed',message:'fixture'},adapter);
  assert.equal((await db.query('SELECT error FROM project_init_jobs WHERE id=$1',[id])).rows[0].error,'daemon_fehler');
 });
 await check('host_loesen: /virtual/*-Zeile unter beliebigem Host wird nie entfernt',async()=>{
  await db.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,'seltsam','/virtual/x',true)",[P]);
  await assert.rejects(core.projektHostLoesen({project:P,hostname:'seltsam',agent:'koordinator',vorschau:false}),code('virtueller_host'));
  assert.equal(await n("SELECT count(*) AS n FROM projects WHERE name=$1 AND hostname='seltsam'",[P]),1);
  await db.query("DELETE FROM projects WHERE name=$1 AND hostname='seltsam'",[P]);
 });

 // HTTP (Fastify inject, Fake-Token)
 const require=createRequire(new URL('../packages/rest-api/package.json',import.meta.url));
 const fastify=require('fastify');
 const {registerProjectRestoreRoutes}=await import('../packages/rest-api/dist/routes/project-restore.js');
 const daemonP={token_hash:hash,kind:'service',scope:'daemon:p9-t30'};
 const userP={token_hash:'c'.repeat(64),kind:'access',scope:'user'};
 const webP={token_hash:'d'.repeat(64),kind:'session',scope:null};
 const trayUiP={token_hash:'e'.repeat(64),kind:'session',scope:'ui:tray'};
 app=fastify();
 await registerProjectRestoreRoutes(app,{service,validateToken:async t=>t==='daemon'?daemonP:t==='user'?userP:t==='web'?webP:t==='trayui'?trayUiP:null});
 await app.ready();
 const call=(method,path,payload,credential='daemon')=>app.inject({method,url:path,headers:{authorization:'Bearer '+credential,[core.API_CONTRACT_HEADER]:'1'},...(payload===undefined?{}:{payload})});
 await service.bindDaemonHost(hash,HOST2);
 await check('HTTP restore-existing fuer virtuelles Projekt -> 409 virtuelles_projekt, keine Bindung',async()=>{
  const r=await call('POST','/api/projects/'+VIRT+'/restore-existing',{hostname:HOST2});
  assert.equal(r.statusCode,409);assert.equal(r.json().error.code,'virtuelles_projekt');
  assert.equal(await n('SELECT count(*) AS n FROM project_host_bindings WHERE project=$1',[VIRT]),0);
  const b=await call('GET','/api/projects/'+VIRT+'/host-binding');assert.equal(b.statusCode,200);assert.equal(b.json().bound,false);
 });
 await check('HTTP host-loesen (Tray): Daemon nur eigener Host, Vorschau Standard, vorschau-Typ geprueft, dann Ausfuehren',async()=>{
  const fremd=await call('POST','/api/projects/'+P+'/host-loesen',{hostname:'other-host'});
  assert.equal(fremd.statusCode,403);assert.equal(fremd.json().error.code,'host_verboten');
  assert.equal((await call('POST','/api/projects/'+P+'/host-loesen',{vorschau:'nein'})).statusCode,400);
  assert.equal((await call('POST','/api/projects/'+P+'/host-loesen',{},'kaputt')).statusCode,401);
  const vorher=await stand();
  const v=await call('POST','/api/projects/'+P+'/host-loesen',{});
  assert.equal(v.statusCode,200);assert.equal(v.json().status,'vorschau');assert.equal(v.json().entfernt.registry_zeile.hostname,HOST2);
  assert.equal(await stand(),vorher);
  const x=await call('POST','/api/projects/'+P+'/host-loesen',{vorschau:false});
  assert.equal(x.statusCode,200);assert.equal(x.json().status,'geloest');
  assert.equal(await n('SELECT count(*) AS n FROM projects WHERE name=$1 AND hostname=$2',[P,HOST2]),0);
  assert.equal(await n("SELECT count(*) AS n FROM projects WHERE name=$1 AND hostname='rest-api'",[P]),1);
  assert.equal((await db.query("SELECT requested_by FROM project_init_jobs WHERE mode='host_loesen' AND hostname=$1",[HOST2])).rows[0].requested_by,'tray:'+HOST2);
 });
 await check('HTTP Daemon-Vertrag: claim liefert eigenen Auftrag, complete einmalig, danach 404',async()=>{
  const c=await call('POST','/api/project-init/host-loesen/claim',{});
  assert.equal(c.statusCode,200);const jobs=c.json().jobs;assert.equal(jobs.length,1);assert.equal(jobs[0].name,P);
  assert.deepEqual((await call('POST','/api/project-init/host-loesen/claim',{})).json().jobs,[]);
  assert.equal((await call('POST','/api/project-init/host-loesen/'+jobs[0].id+'/complete',{status:'done',message:'ok'})).statusCode,200);
  const again=await call('POST','/api/project-init/host-loesen/'+jobs[0].id+'/complete',{status:'done'});
  assert.equal(again.statusCode,404);assert.equal(again.json().error.code,'host_loesen_job_unbekannt');
  assert.equal((await call('POST','/api/project-init/host-loesen/claim',{},'user')).statusCode,403);
 });
 await check('HTTP host-loesen mit User-Zugang (Web-UI-Sitzung): hostname Pflicht, rest-api abgelehnt',async()=>{
  assert.equal((await call('POST','/api/projects/'+P+'/host-loesen',{},'web')).statusCode,403);
  const r=await call('POST','/api/projects/'+P+'/host-loesen',{hostname:'rest-api',vorschau:false},'web');
  assert.equal(r.statusCode,400);assert.equal(r.json().error.code,'virtueller_host');
  const v=await call('POST','/api/projects/'+P+'/host-loesen',{hostname:'other-host'},'web');
  assert.equal(v.statusCode,200);assert.equal(v.json().status,'vorschau');
 });
 await check('HTTP host-loesen: Access-/OAuth-Token und andere Sitzungen duerfen keinen Host loesen (403, nichts geaendert)',async()=>{
  const vorher=await stand();
  for(const cred of ['user','trayui']){
   for(const body of [{hostname:'other-host',vorschau:false},{hostname:'other-host'},{vorschau:false}]){
    const r=await call('POST','/api/projects/'+P+'/host-loesen',body,cred);
    assert.equal(r.statusCode,403,cred+' '+JSON.stringify(body));assert.equal(r.json().error.code,'nur_koordinator_oder_user');
   }
  }
  assert.equal(await stand(),vorher);
 });
 // Nachbesserung P9-T30 (claude-f5): restore-existing + host-binding GET/DELETE mit ECHTEM Auth-Hook und echten Tokens
 // (auth_tokens in synapse_test, am Ende widerrufen) + echter Daemon-Hostbindung im Testschema. Keine Fake-validateToken.
 const {registerAuthHook}=await import('../packages/rest-api/dist/middleware/auth-hook.js');
 authMod=await import('../packages/rest-api/dist/services/auth.js');
 const neu=async t=>{realTokens.push(t.token);return t.token;};
 const hashOf=t=>createHash('sha256').update(t).digest('hex');
 const HR='p9-t30-real',HF='p9-t30-fremd',HW='p9-t30-web';
 const DAEMON=await neu(await authMod.issueServiceToken('daemon:p9-t30-real','p9-t30-real'));
 const FREMD=await neu(await authMod.issueServiceToken('daemon:p9-t30-fremd','p9-t30-fremd'));
 const ACCESS=await neu(await authMod.issueAccessToken(null,'mcp:tools',60_000,null));
 const WEB=await neu(await authMod.issueSessionToken(null,60_000));
 const TRAYUI=await neu(await authMod.issueSessionToken('ui:tray',60_000));
 await service.bindDaemonHost(hashOf(DAEMON),HR);await service.bindDaemonHost(hashOf(FREMD),HF);
 realApp=fastify({logger:false});registerAuthHook(realApp);await registerProjectRestoreRoutes(realApp,{service});await realApp.ready();
 const real=(method,p,payload,tok)=>realApp.inject({method,url:p,headers:{...(tok?{authorization:'Bearer '+tok}:{}),[core.API_CONTRACT_HEADER]:'1'},...(payload===undefined?{}:{payload})});
 const bindung=(h)=>n('SELECT count(*) AS n FROM project_host_bindings WHERE project=$1 AND hostname=$2 AND enabled',[P,h]);
 await check('ECHTER Auth-Hook: restore-existing/host-binding – fremder Token, fremder Host, Access, ui:tray -> 403; ohne Token 401; nichts geaendert',async()=>{
  const vorher=await stand();
  const pfade=(h)=>[['POST','/api/projects/'+P+'/restore-existing',{hostname:h}],['GET','/api/projects/'+P+'/host-binding?hostname='+h],['DELETE','/api/projects/'+P+'/host-binding?hostname='+h]];
  for(const [m,p,b] of pfade(HR))assert.equal((await real(m,p,b)).statusCode,401,'ohne Token '+m+' '+p);
  // fremder Daemon-Token fuer den Host eines anderen Daemons
  for(const [m,p,b] of pfade(HR)){const r=await real(m,p,b,FREMD);assert.equal(r.statusCode,403,'fremd '+m+' '+p);assert.equal(r.json().error.code,'host_verboten');}
  // eigener Daemon-Token mit fremdem Host
  for(const [m,p,b] of pfade(HF)){const r=await real(m,p,b,DAEMON);assert.equal(r.statusCode,403,'fremder Host '+m+' '+p);assert.equal(r.json().error.code,'host_verboten');}
  // Access-/OAuth-Token und andere Sitzungen duerfen keinen frei waehlbaren Host nutzen
  for(const tok of [ACCESS,TRAYUI])for(const [m,p,b] of [...pfade(HR),...pfade(HW)]){
   const r=await real(m,p,b,tok);assert.equal(r.statusCode,403,m+' '+p);assert.equal(r.json().error.code,'nur_koordinator_oder_user');
  }
  assert.equal(await stand(),vorher);
  assert.equal(await bindung(HR)+await bindung(HF)+await bindung(HW),0);
 });
 await check('ECHTER Auth-Hook: Daemon-/Tray-Token nur eigener bestaetigter Host (ohne und mit eigenem hostname)',async()=>{
  const r=await real('POST','/api/projects/'+P+'/restore-existing',{},DAEMON);
  assert.equal(r.statusCode,200);assert.equal(r.json().hostname,HR);assert.equal(await bindung(HR),1);
  assert.equal((await real('POST','/api/projects/'+P+'/restore-existing',{hostname:HR},DAEMON)).statusCode,200);
  const g=await real('GET','/api/projects/'+P+'/host-binding?hostname='+HR,undefined,DAEMON);
  assert.equal(g.statusCode,200);assert.deepEqual([g.json().hostname,g.json().bound],[HR,true]);
  assert.equal((await real('GET','/api/projects/'+P+'/host-binding',undefined,DAEMON)).json().bound,true);
  const d=await real('DELETE','/api/projects/'+P+'/host-binding?hostname='+HR,undefined,DAEMON);
  assert.equal(d.statusCode,200);assert.equal(d.json().bound,false);assert.equal(await bindung(HR),0);
  // Fremder Daemon sieht/aendert den Host HR weiterhin nicht
  assert.equal((await real('GET','/api/projects/'+P+'/host-binding?hostname='+HR,undefined,FREMD)).statusCode,403);
  const v=await real('POST','/api/projects/'+VIRT+'/restore-existing',{},DAEMON);
  assert.equal(v.statusCode,409);assert.equal(v.json().error.code,'virtuelles_projekt');
 });
 await check('ECHTER Auth-Hook: Web-UI-Sitzung des Users darf hostname frei waehlen; ohne hostname 403; virtuell 409',async()=>{
  assert.equal((await real('POST','/api/projects/'+P+'/restore-existing',{},WEB)).statusCode,403);
  assert.equal((await real('GET','/api/projects/'+P+'/host-binding',undefined,WEB)).statusCode,403);
  const r=await real('POST','/api/projects/'+P+'/restore-existing',{hostname:HW},WEB);
  assert.equal(r.statusCode,200);assert.equal(r.json().hostname,HW);assert.equal(await bindung(HW),1);
  assert.equal((await real('GET','/api/projects/'+P+'/host-binding?hostname='+HW,undefined,WEB)).json().bound,true);
  assert.equal((await real('DELETE','/api/projects/'+P+'/host-binding?hostname='+HW,undefined,WEB)).statusCode,200);
  assert.equal(await bindung(HW),0);
  const v=await real('POST','/api/projects/'+VIRT+'/restore-existing',{hostname:HW},WEB);
  assert.equal(v.statusCode,409);assert.equal(v.json().error.code,'virtuelles_projekt');
  assert.equal(await n('SELECT count(*) AS n FROM project_host_bindings WHERE project=$1',[VIRT]),0);
 });
 // MCP-Strecken: stdio-Handler + Schema-Gleichstand REST/stdio
 const {projectTool}=await import('../packages/mcp-server/dist/tools/consolidated/project.js');
 await check('stdio project: host_loesen nur Koordinator (Vorschau), init virtuell abgelehnt',async()=>{
  const nein=await projectTool.handler({action:'host_loesen',project:P,hostname:'other-host',agent_id:'claude-tp-a'});
  assert.equal(nein.success,false);assert.match(String(nein.message),/Koordinator/);
  const vorher=await stand();
  const ja=await projectTool.handler({action:'host_loesen',project:P,hostname:'other-host',agent_id:'koordinator'});
  assert.equal(ja.status,'vorschau');assert.equal(await stand(),vorher);
  const typ=await projectTool.handler({action:'host_loesen',project:P,hostname:'other-host',agent_id:'koordinator',vorschau:'nein'});
  assert.equal(typ.success,false);
  const init=await projectTool.handler({action:'init',name:VIRT,agent_id:'koordinator'});
  assert.deepEqual([init.success,init.error],[false,'virtuelles_projekt']);
  const restore=await projectTool.handler({action:'init',name:VIRT,mode:'restore_existing',hostname:HOST,agent_id:'koordinator'});
  assert.equal(restore.error,'virtuelles_projekt');
  assert.equal(await n('SELECT count(*) AS n FROM project_init_jobs WHERE name=$1 AND status=$2',[VIRT,'pending']),0);
 });
 await check('Schema: project.action-Enum enthaelt host_loesen und ist auf REST und stdio gleich; hostname/vorschau angeboten',async()=>{
  const {mcpRoutes}=await import('../packages/rest-api/dist/routes/mcp.js');
  const rest=fastify({logger:false});await rest.register(mcpRoutes);await rest.ready();
  try{
   const r=await rest.inject({method:'POST',url:'/',payload:{jsonrpc:'2.0',id:1,method:'tools/list'}});
   const restTool=r.json().result.tools.find(t=>t.name==='project');
   const stdioProps=projectTool.definition.inputSchema.properties,restProps=restTool.inputSchema.properties;
   assert.ok(stdioProps.action.enum.includes('host_loesen'));
   assert.deepEqual(restProps.action.enum,stdioProps.action.enum);
   for(const k of ['hostname','vorschau'])assert.ok(restProps[k]&&stdioProps[k],k+' fehlt');
  }finally{await rest.close();}
 });
 console.log('RESULT P9_T30_DB '+count+'/'+count+' PASS; schema='+schema);
}finally{
 if(app)await app.close();
 if(realApp)await realApp.close();
 if(authMod)for(const t of realTokens)await authMod.revokeToken(t).catch(()=>{});
 await db.query('SET search_path TO public');
 await db.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');
 await db.end();
}
});
// mcp-server/rest-api-Module halten eigene Pools/Timer offen -> nach Erfolg explizit beenden (Fehler beenden vorher mit Exit 1).
process.exit(0);
