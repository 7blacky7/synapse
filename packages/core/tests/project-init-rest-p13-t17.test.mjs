/** P13-T17: echter REST-Dispatcher/PG/Manager, Golden 7cd5ddb; nur synapse_test:5433.
 * Grenzen: DB-Provisionierung, OS-Watcher und Config-Speicher ersetzt; Manager/Queue/PG/status.json sind echt.
 * --capture: nur vorhandene Statusantworten; --golden: Basisvergleich; ohne: voller Test.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {hostname} from 'node:os';
import {registerHooks} from 'node:module';
import {createTestFixtureCleanup} from './_helfer/test-fixture-cleanup.mjs';
assert.ok(/^postgres(?:ql)?:\/\/[^/]+:5433\/synapse_test(?:\?|$)/.test(process.env.DATABASE_URL||''),'Nur synapse_test:5433');
const here=dirname(fileURLToPath(import.meta.url));
const repo=process.env.P13_T17_REPO||join(here,'..','..','..');
const moduleUrl=(pkg,file)=>pathToFileURL(join(repo,'packages',pkg,'dist',file)).href;
const cleanup=createTestFixtureCleanup();
const root=await cleanup.createRoot('sol9-p13-t17-');
globalThis.__sol9InitFixture={serializedConfig:null,save:cfg=>{globalThis.__sol9InitFixture.serializedConfig=JSON.stringify(cfg);},provisioned:[]};
// Reale Daemon-Methoden speichern ausschließlich in die isolierte Testkonfiguration.
// Der provisionierende DB-Rand darf weder weitere Datenbanken noch Nutzerdaten berühren.
const hooks=registerHooks({load(url,ctx,next){
 if(url===moduleUrl('file-watcher-daemon-ts','config.js')){
  return {format:'module',shortCircuit:true,source:
   'export * from '+JSON.stringify(url+'?original')+';\n'+
   'export function saveConfig(cfg){globalThis.__sol9InitFixture.save(cfg);}'};
 }
 if(url===moduleUrl('rest-api','routes/projekt-db.js')){
  return {format:'module',shortCircuit:true,source:
   'export async function stelleProjektDbSicher(name){globalThis.__sol9InitFixture.provisioned.push(name); return {status:"test_isoliert",hinweis:"Provisionierung im Test ersetzt"};}'};
 }
 if(url===moduleUrl('core','qdrant/collections.js')){
  return {format:'module',shortCircuit:true,source:'export * from '+JSON.stringify(url+'?original')+'; export async function getCollectionStats(){return null;}'};
 }
 return next(url,ctx);
}});
console.log('INIT_TEST importing core');
const core=await import(moduleUrl('core','index.js'));
const db=core.getPool();
assert.equal((await db.query('SELECT current_database() AS db')).rows[0].db,'synapse_test');
console.log('INIT_TEST importing REST');
const {handleToolCall}=await import(moduleUrl('rest-api','routes/mcp.js'));
const {WatcherManager}=await import(moduleUrl('file-watcher-daemon-ts','manager.js'));
const {processProjectInitJob}=await import(moduleUrl('file-watcher-daemon-ts','project-init-worker.js'));
const sync=await import(moduleUrl('file-watcher-daemon-ts','enabled-sync.js'));
console.log('INIT_TEST importing stdio');
const local=await import(moduleUrl('mcp-server','tools/init.js'));
console.log('INIT_TEST imports ready');
const prefix='p13_t17_'+randomUUID().replaceAll('-','').slice(0,16);
const names=['existing','virtual','unknown','success','failure','discover'].map(x=>prefix+'_'+x);
const [existing,virtual,unknown,success,failure,discover]=names;
const actor=prefix+'_agent';
const oldRoot=process.env.SYNAPSE_WORKSPACE_ROOT,oldBridge=process.env.SYNAPSE_WORKSPACE_BRIDGE_DISABLED;
process.env.SYNAPSE_WORKSPACE_ROOT=root;
process.env.SYNAPSE_WORKSPACE_BRIDGE_DISABLED='1';
const starts=[];
const manager=new WatcherManager({projekte:[]});
// Nur den OS-Watcher-Rand ersetzen, keine Manager-/Registry-Logik.
manager.spawnWatcher=cfg=>{
 starts.push(cfg.name);
 manager.instances.set(cfg.name,{stop:async()=>{},watcher:{close:async()=>{}}});
};
const call=args=>handleToolCall('project',{...args,agent_id:actor},actor);
const normal=v=>JSON.parse(JSON.stringify(v,(key,x)=>{
 if(['created_at','last_access','last_seen','updated_at','initialized','lastAccess'].includes(key))return '<zeit>';
 if(typeof x!=='string')return x;
 let out=x.replaceAll(root,'<root>');
 for(let i=0;i<names.length;i++)out=out.replaceAll(names[i],'<'+['existing','virtual','unknown','success','failure','discover'][i]+'>');
 return out;
}));
let checks=0;
const check=(condition,label)=>{assert.ok(condition,label);checks++;};
const status=async name=>call({action:'status',project:name});
const saved=async()=>JSON.parse(globalThis.__sol9InitFixture.serializedConfig);
const cache=async name=>JSON.parse(await readFile(join(root,name,'.synapse','status.json'),'utf8'));
async function snapshot(name){
 return (await db.query('SELECT p.name,p.path,p.enabled,s.setup_phase FROM projects p LEFT JOIN project_setup_status s ON s.project=p.name WHERE p.name=$1 AND p.hostname=$2',[name,hostname()])).rows;
}
async function runQueuedInit(name,targetManager=manager){
 const promise=call({action:'init',name,hostname:hostname(),index_docs:false});
 let job;
 const deadline=Date.now()+3000;
 do{
  job=(await db.query("SELECT * FROM project_init_jobs WHERE name=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1",[name])).rows[0];
  if(job)break;
  await new Promise(resolve=>setTimeout(resolve,10));
 }while(Date.now()<deadline);
 assert.ok(job,'REST muss Job in PG einreihen');
 await processProjectInitJob(job,targetManager);
 return {response:await promise,job};
}
try{
 for(const name of names)await mkdir(join(root,name));
 await core.registerProject(existing,join(root,existing));
 await core.registerVirtualProject(existing);
 await core.registerVirtualProject(virtual);
 await core.setSetupPhase(existing,'complete',{updatedBy:actor});
 await core.upsertDaemonHeartbeat(existing,hostname(),process.pid);
 const oldCases={existing:normal(await status(existing)),virtual:normal(await status(virtual)),unknown:normal(await status(unknown)),
  missingPhase:normal(await call({action:'complete_setup',project:existing}))};
 // Exakte Allowlist: INIT-2 dokumentiert nur daemon_registered als additives Statusfeld.
 // Alle vorher vorhandenen Felder werden vollständig und unverändert verglichen.
 const extensions={};
 for(const key of ['existing','virtual','unknown']){
  const value=oldCases[key];
  if(Object.hasOwn(value,'daemon_registered')){
   extensions[key]=value.daemon_registered;
   assert.equal(value.daemon_registered,key==='existing');
   delete value.daemon_registered;
  }
 }
 if(process.argv.includes('--capture'))console.log('GOLDEN_JSON='+JSON.stringify(oldCases));
 else{
  assert.deepEqual(oldCases,JSON.parse(await readFile(join(here,'fixtures','project-status-p13-t17.golden.json'),'utf8')));
  console.log('P13-T17 Statusgolden unverändert; additive Allowlist: daemon_registered.');
 }
 if(!process.argv.includes('--capture')&&!process.argv.includes('--golden')){
  check(Object.keys(extensions).length===3,'aktueller REST-Status zeigt die dokumentierte Daemonregistrierung');
  const init=await runQueuedInit(success);
  check(init.response.success===true,'REST init meldet Erfolg erst nach fertigem Job');
  check(init.response.path===join(root,success),'REST meldet echten Daemonpfad');
  check(init.response.job_id===init.job.id,'REST referenziert richtigen Queuejob');
  const rows=await core.getProjectRegistryRows(success);
  check(rows.length===2&&rows.some(r=>r.hostname===hostname())&&rows.some(r=>r.hostname==='rest-api'),'beide PG-Hostnamen vorhanden');
  check((await saved()).projekte.some(p=>p.name===success&&p.pfad===join(root,success)),'reale Managerregistrierung persistiert isolierten Configcache');
  check(starts.filter(n=>n===success).length===1&&manager.isRunning(success),'Manager startet Watcher ohne Handeintrag');
  check((await cache(success)).setupPhase==='initial-pending','initialer lokaler Setupcache');
  check(await core.getSetupPhase(success)==='initial-pending','initialer PG-Setupzustand');
  const initial=await status(success);
  check(initial.daemon_registered===true&&initial.watcher_active===false&&initial.setup_phase==='initial-pending','REST unterscheidet Registrierung von echtem Heartbeat');
  const initialDone=await call({action:'complete_setup',project:success,phase:'initial'});
  check(initialDone.success===true&&initialDone.nextPhase==='initial-done','REST complete_setup initial funktioniert');
  check(await core.getSetupPhase(success)==='initial-done','complete_setup schreibt wirklich PG fort');
  sync.synchronisiereProjektCache(manager,await snapshot(success));
  check((await cache(success)).setupPhase==='initial-done','Daemon zieht PG-Phase in Cache');
  const complete=await call({action:'complete_setup',project:success,phase:'post-indexing'});
  check(complete.success===true&&complete.nextPhase==='complete','REST complete_setup Postindexing funktioniert');
  sync.synchronisiereProjektCache(manager,await snapshot(success));
  check((await cache(success)).setupPhase==='complete','PG ist Setupquelle nach vollständigem Abschluss');
  // Cache absichtlich veralten: beide Leser müssen dennoch PG verwenden.
  core.setProjectStatus(join(root,success),{setupPhase:'initial-pending'});
  check((await cache(success)).setupPhase==='initial-pending','Gegenprobe hat wirklich einen veralteten Cache');
  const rest=await status(success),stdio=await local.getProjectStatusWithStats(join(root,success));
  check(rest.setup_phase==='complete'&&stdio.status.setupPhase==='complete','REST und lokaler MCP lesen denselben PG-Fortschritt');
  sync.synchronisiereProjektCache(manager,await snapshot(success));
  check((await cache(success)).setupPhase==='complete','Cache wird aus PG repariert');
  const repeated=await runQueuedInit(success);
  check(repeated.response.success===true,'REST init ist wiederholbar');
  check((await core.getProjectRegistryRows(success)).length===2,'Idempotenz ohne Registryduplikate');
  check(await core.getSetupPhase(success)==='complete'&&(await cache(success)).setupPhase==='complete','Wiederholung setzt Setup nicht zurück');
  check(starts.filter(n=>n===success).length===1,'Wiederholung startet keinen zweiten Watcher');
  const failed=await runQueuedInit(failure,{register:async()=>{throw Error('fixture config write failed');}});
  check(failed.response.success===false&&failed.response.status==='failed','REST meldet ehrlichen Teilerfolg');
  check(/fixture config write failed/.test(failed.response.message),'REST benennt fehlgeschlagenen Configschritt');
  check((await status(failure)).watcher_active===false,'Teilregistrierung behauptet keinen aktiven Watcher');
  const failedPoll=await call({action:'init_status',job_id:failed.job.id});
  check(failedPoll.success===false&&failedPoll.status==='failed','init_status verschweigt Fehler nicht');
  const successfulPoll=await call({action:'init_status',job_id:init.job.id});
  check(successfulPoll.success===true&&successfulPoll.status==='done','init_status zeigt fertige Einrichtung');
  await core.registerProject(discover,join(root,discover));
  await core.setSetupPhase(discover,'initial-done',{updatedBy:actor});
  check(!manager.get(discover),'Discoveryfixture fehlt wirklich im Configcache');
  sync.synchronisiereProjektCache(manager,await snapshot(discover));
  check(manager.get(discover)?.pfad===join(root,discover)&&manager.isRunning(discover),'PG-Discovery übernimmt Projekt und startet Watcher ohne manuellen Configeintrag');
  check((await saved()).projekte.some(p=>p.name===discover),'PG-Discovery persistiert Configcache');
  check((await cache(discover)).setupPhase==='initial-done','PG-Discovery erstellt Setupcache');
  const invalid=await call({action:'init',name:'../unsafe',index_docs:false});
  check(invalid.success===false&&invalid.error==='invalid_name','REST lehnt ungültigen Namen vor Sideeffects ab');
  check(!(await db.query('SELECT id FROM project_init_jobs WHERE requested_by=$1 AND name=$2',[actor,'../unsafe'])).rows.length,'ungültiger Name erzeugt keinen Queuejob');
  console.log('P13-T17 REST/Queue/PG/Manager/Cache/Teilfehler: '+checks+' Checks GRÜN.');
 }
}finally{
 await db.query('DELETE FROM daemon_heartbeats WHERE project=ANY($1::text[])',[names]);
 await db.query('DELETE FROM project_init_jobs WHERE name=ANY($1::text[])',[names]);
 await db.query('DELETE FROM project_setup_status WHERE project=ANY($1::text[])',[names]);
 await db.query('DELETE FROM projects WHERE name=ANY($1::text[])',[names]);
 if(oldRoot===undefined)delete process.env.SYNAPSE_WORKSPACE_ROOT;else process.env.SYNAPSE_WORKSPACE_ROOT=oldRoot;
 if(oldBridge===undefined)delete process.env.SYNAPSE_WORKSPACE_BRIDGE_DISABLED;else process.env.SYNAPSE_WORKSPACE_BRIDGE_DISABLED=oldBridge;
 await core.closePool();hooks.deregister();delete globalThis.__sol9InitFixture;
 await cleanup.cleanup();cleanup.dispose();
}
// Der stdio-Tool-Barrel registriert einen unabhängigen Ideen-Cleanup-Timer.
// Nach vollständigen Assertions und unserem Cleanup beendet dieser eigenständige Test ihn.
process.exit(0);

