/**
 * P22-T12 W1a. Nur synapse_test:5433, keine echten Agenten/Modelle.
 * node --experimental-vm-modules scripts/test-agent-start-p22-t12.mjs
 * --basis-positive: t106 muss am fehlenden Start-Ausweis ROT sein.
 * Produktionsfunktionen aus echtem TS-AST, Prozess/FS/Transport/Zeit als Attrappen.
 */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import vm from 'node:vm';
import ts from '../packages/core/node_modules/typescript/lib/typescript.js';
import Fastify from '../packages/rest-api/node_modules/fastify/fastify.js';
const root=resolve('.'),baseline=process.env.P22_BASIS_ROOT||'/tmp/synapse-basis-d0c6ef30';
const basisPositive=process.argv.includes('--basis-positive');
const db=new URL(process.env.DATABASE_URL||'http://invalid');
assert.ok(db.port==='5433'&&db.pathname==='/synapse_test','Nur synapse_test:5433 erlaubt');
process.env.SYNAPSE_INTERN_TOOL='0';process.env.SYNAPSE_TOKEN_IDENTITAET='1';process.env.SYNAPSE_DB_IDLE_MS='100';
const core=await import('../packages/core/dist/index.js');
const {getPool,closePool}=await import('../packages/core/dist/db/client.js');
const pool=getPool(),project='p22-sol33-'+randomUUID(),agent='p22-sol33-'+randomUUID();
let checks=0,failed=0;
const noOp=()=>{};
function safe(s){return String(s).replace(/sai_[a-f0-9]{64}/g,'[MASKIERT]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB-MASKIERT]');}
async function check(name,fn){try{await fn();checks++;console.log('OK '+name);}catch(e){failed++;console.log('FEHLER '+name+': '+safe(e.message).slice(0,800));}}
function synth(values,context){return new vm.SyntheticModule(Object.keys(values),function(){for(const[k,v]of Object.entries(values))this.setExport(k,v);},{context});}
async function loadModule(file,stubs={},globals={}){
 const context=vm.createContext({console,Buffer,URL,AbortController,AbortSignal,process,setTimeout,clearTimeout,...globals}),cache=new Map();
 async function get(path){
  if(cache.has(path))return cache.get(path);
  const source=await readFile(path,'utf8');
  const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  const module=new vm.SourceTextModule(js,{context,identifier:path});cache.set(path,module);
  await module.link(async(spec,ref)=>{
   if(Object.hasOwn(stubs,spec))return synth(stubs[spec],context);
   if(spec.startsWith('node:'))return synth(await import(spec),context);
   return get(resolve(dirname(ref.identifier),spec.replace(/\.js$/,'.ts')));
  });return module;
 }
 const module=await get(file);await module.evaluate();return module.namespace;
}
async function functionFrom(file,name,globals={},dynamic={}){
 const source=await readFile(file,'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
 const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);
 assert.ok(fn,'Produktionsfunktion '+name+' fehlt');
 const code=ts.transpileModule(fn.getText(ast).replace(/^export\s+/,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 const context=vm.createContext({console,Buffer,Promise,process,setTimeout,clearTimeout,...globals});
 return new vm.Script(code+'\n'+name,{importModuleDynamically:async spec=>{
  assert.ok(Object.hasOwn(dynamic,spec),'Nicht erlaubter Import '+spec);
  const m=synth(dynamic[spec],context);await m.link(()=>{});await m.evaluate();return m;
 }}).runInContext(context);
}
const promptPath='packages/agents/src/prompts.ts',hints={baueWerkzeugHinweis:()=>'<werkzeug-hinweis>'};
const currentPrompts=await loadModule(join(root,promptPath),{'./werkzeuge-laden.js':hints});
const oldPrompts=await loadModule(join(baseline,promptPath),{'./werkzeuge-laden.js':hints});
const config={name:agent,model:'synthetisch',expertise:'Test',task:'P22-T12',project};
const model={binary:'claude',provider:'claude',fullId:'synthetisch',envRequired:[],contextWindow:100000};
let startEnv={},app;
async function spawnProbe(tree,env={},tokenEnv={}){
 const r={spawns:[],files:[],statuses:[],logs:[],prompts:[]};
 const data={generalChannel:async()=>{},channelBeitreten:async()=>true,sitzungNeu:async()=>{},wrapperStatus:async z=>r.statuses.push(z),heartbeatBeimSpawn:async()=>{},wrapperUmgebung:()=>({SYNAPSE_WRAPPER_TRANSPORT:'api'})};
 const prompts=tree===baseline?oldPrompts:currentPrompts;
 class BridgeError extends Error{}
 const fn=await functionFrom(join(tree,'packages/mcp-server/src/tools/specialists.ts'),'spawnSpecialistTool',{
  Date:class extends Date{constructor(...args){super(...(args.length?args:['2026-10-16T22:00:00.000Z']));}static now(){return 1792188000000;}},
  console:{error:(...a)=>r.logs.push(a.join(' '))},process:{env},join,effortFuerCli:()=>undefined,detectClaudeCli:()=>({available:true}),canSpawn:async()=>({ok:true}),ensureAgentDir:async()=>{},
  erzeugeWissen:()=>({art:'api',legeAn:async()=>({grund:'fixture'}),liesAlles:async()=>({text:'Testwissen'}),legeSystemPromptAb:async(n,p)=>r.prompts.push(p)}),
  buildSpecialistPrompt:prompts.buildSpecialistPrompt,holeAgentStartUmgebung:async()=>tokenEnv,
  bereiteMcpBrueckeVor:async()=>({aktiv:false,grund:'stdio'}),McpBrueckeFehler:BridgeError,selbsttestHinweis:()=>'',spezialistenDatenweg:()=>data,
  mkdir:async()=>{},resolveWrapperPath:()=>'/tmp/synthetischer-wrapper.js',
  spawn:(bin,args,opts)=>{r.spawns.push({bin,args,opts});return{pid:12345,unref:noOp};},
  setTimeout:fn=>{fn();return 0;},heartbeatController:{connectToWrapper:async()=>{}},updateSpecialist:async(p,n,s)=>r.statuses.push(s),jsonResult:data=>data,
 },{'@synapse/agents':{loadFromDb:async()=>{},resolveModel:()=>model,listAliases:()=>['synthetisch']},'node:fs':{openSync:()=>7}});
 r.result=await fn(agent,'synthetisch','Test','P22-T12',project,'/tmp/p22-sol33-fixture');return r;
}
try{
 if(basisPositive){
  const fake='sai_'+'a'.repeat(64);
  await check('Positivkontrolle Frischstart-Ausweis nur Env (t106 muss rot sein)',async()=>{
   const r=await spawnProbe(baseline,{}, {SYNAPSE_AGENT_TOKEN:fake,SYNAPSE_AGENT_TOKEN_START:'1'});
   assert.ok(r.spawns[0].opts.env.SYNAPSE_AGENT_TOKEN===fake,'Ergebnis: Basis-Spawn übergibt keinen Start-Ausweis');
  });
 }else{
  const sql=await readFile(join(root,'packages/core/src/db/schema-sql/111_agent_identitaet.sql'),'utf8');
  await pool.query(sql);await pool.query(sql);
  await check('Schema 111 zweimal idempotent, Ziel synapse_test:5433',async()=>{assert.ok((await pool.query("SELECT to_regclass('agent_identitaet_tokens') AS t")).rows[0].t);});
  await check('AUS Prompt bytegleich gegen t106',async()=>{assert.equal(currentPrompts.buildSpecialistPrompt(config,'Testwissen'),oldPrompts.buildSpecialistPrompt(config,'Testwissen'));});
  await check('AUS Spawn-Env/Args/Status/Prompt/Ergebnis bytegleich gegen t106',async()=>{assert.equal(JSON.stringify(await spawnProbe(root)),JSON.stringify(await spawnProbe(baseline)));});
  await check('AUS/Zurückschalten entfernt alle geerbten Agenten-Ausweisvarianten auch bei leerem Startobjekt',async()=>{
   const parent={SYNAPSE_AGENT_TOKEN:'Elternausweis',SYNAPSE_AGENT_TOKEN_START:'1',SYNAPSE_AGENT_TOKEN_ALT:'Altwert'};
   const r=await spawnProbe(root,parent,{});
   assert.equal(r.spawns[0].opts.env.SYNAPSE_AGENT_TOKEN,undefined);
   assert.equal(r.spawns[0].opts.env.SYNAPSE_AGENT_TOKEN_START,undefined);
   assert.equal(r.spawns[0].opts.env.SYNAPSE_AGENT_TOKEN_ALT,undefined);
   assert.equal(JSON.stringify(r),JSON.stringify(await spawnProbe(baseline)));
  });
  let now=Date.now(),apiCalls=0,apiAnswer={},apiFault=false;const env={};
  class TestDate extends Date{static now(){return now;}}
  const client=await loadModule(join(root,'packages/file-watcher-daemon-ts/src/agent-start-api.ts'),{
   './daemon-jobs-api.js':{spezialistenDatenApi:async(aktion,daten)=>{
    apiCalls++;if(apiFault)throw new Error('synthetischer Ausfall');
    if(app){
     const response=await app.inject({method:'POST',url:'/api/daemon/specialist/daten',headers:{authorization:'Bearer synthetischer-daemon'},payload:{...daten,aktion,host:'test-host',daemon_id:'daemon-test-host-123'}});
     if(response.statusCode!==200)throw new Error('HTTP '+response.statusCode);return response.json();
    }return apiAnswer;
   }},
  },{Date:TestDate,process:{env}});
  function bridge(freigegeben,{quelle='intern',bis=null,debug=true}={}){client.uebernehmeAgentStartFreigabe({debug,server_zeit:new Date(now).toISOString(),token_identitaet:{freigegeben,quelle,bis}});}
  await check('AUS Daemon ohne zusätzlichen API-Aufruf',async()=>{assert.equal(Object.keys(await client.holeAgentStartApi(agent,project)).length,0);assert.equal(apiCalls,0);});
  await check('Brücke EIN ohne Identität: exakt alter Start, kein Registerhinweis oder Elternausweis',async()=>{
   bridge(true);apiAnswer={freigegeben:true,legacy_start:true};const r=await client.holeAgentStartApi(agent,project);
   assert.equal(r.SYNAPSE_AGENT_TOKEN,'');assert.equal(r.SYNAPSE_AGENT_TOKEN_START,undefined);
   const p=await spawnProbe(root,{SYNAPSE_AGENT_TOKEN:'Elternausweis',SYNAPSE_AGENT_TOKEN_START:'1'},r);
   assert.equal(p.spawns[0].opts.env.SYNAPSE_AGENT_TOKEN,undefined);
   assert.equal(p.spawns[0].opts.env.SYNAPSE_AGENT_TOKEN_START,undefined);
   assert.equal(JSON.stringify(p),JSON.stringify(await spawnProbe(baseline)));
   assert.ok(!p.prompts[0].includes('chat(action: "register"'));
  });
  await check('Ablauf/Brückenverlust/alte API/Frischegrenze fallen auf AUS zurück',async()=>{
   bridge(true,{bis:new Date(now+10).toISOString()});now+=11;assert.equal(client.agentStartFreigegeben(),false);
   bridge(true);client.verwerfeAgentStartFreigabe();assert.equal(client.agentStartFreigegeben(),false);
   bridge(true);client.uebernehmeAgentStartFreigabe('nicht_gefunden');assert.equal(client.agentStartFreigegeben(),false);
   bridge(true);now+=90_001;assert.equal(client.agentStartFreigegeben(),false);
  });
  await check('Produktionsstandard EIN ohne intern, gültiger AUS-Override und Rückfall',async()=>{
   env.SYNAPSE_TOKEN_IDENTITAET='1';client.verwerfeAgentStartFreigabe();assert.equal(client.agentStartFreigegeben(),true);
   bridge(false);assert.equal(client.agentStartFreigegeben(),false);client.verwerfeAgentStartFreigabe();assert.equal(client.agentStartFreigegeben(),true);
   bridge(true,{quelle:'standard',debug:false});assert.equal(client.agentStartFreigegeben(),true);delete env.SYNAPSE_TOKEN_IDENTITAET;
  });
  await check('Aktive Freigabe: API-Ausfall/kaputte Antwort verhindert stillen Legacy-Start',async()=>{
   bridge(true);apiFault=true;await assert.rejects(client.holeAgentStartApi(agent,project));apiFault=false;
   apiAnswer={freigegeben:true,token:'kaputt'};await assert.rejects(client.holeAgentStartApi(agent,project));
   apiAnswer={freigegeben:true};await assert.rejects(client.holeAgentStartApi(agent,project));
   apiAnswer={freigegeben:false};assert.equal(Object.keys(await client.holeAgentStartApi(agent,project)).length,0);
  });
  const access={validateToken:async raw=>raw==='synthetischer-daemon'?{kind:'service',scope:'daemon:synthetisch',token_hash:'test-host-binding'}:raw==='synthetischer-user'?{kind:'access',scope:null,token_hash:'user-binding'}:null,daemonHost:async hash=>hash==='test-host-binding'?'test-host':null};
  const routes=await loadModule(join(root,'packages/rest-api/src/routes/daemon-jobs.ts'),{
   '@synapse/core':{...core,projekteDesHosts:async(ps,host)=>host==='test-host'?ps.filter(p=>p===project):[]},
   '../services/auth.js':{validateToken:access.validateToken},'./daemon-sync.js':{daemonSyncRoutes:async()=>{}},
  });
  app=Fastify({logger:false});await routes.daemonJobsRoutes(app,access);await app.ready();
  async function request(patch={},auth='synthetischer-daemon'){return app.inject({method:'POST',url:'/api/daemon/specialist/daten',headers:{authorization:'Bearer '+auth},payload:{aktion:'agent_start',host:'test-host',daemon_id:'daemon-test-host-123',project,agent,...patch}});}
  await check('Daemon-Route ungültiger Ausweis/Rolle/Host/Projekt/daemon_id abgewiesen',async()=>{
   assert.equal((await request({},'ungueltig')).statusCode,401);assert.equal((await request({},'synthetischer-user')).statusCode,403);
   assert.equal((await request({host:'fremder-host'})).statusCode,403);assert.equal((await request({project:project+'-fremd'})).statusCode,409);assert.equal((await request({daemon_id:'falsch'})).statusCode,400);
  });
  await check('Daemon-Route AUS keine Identitätsanlage',async()=>{
   process.env.SYNAPSE_TOKEN_IDENTITAET='0';const r=await request();assert.equal(r.statusCode,200);assert.equal(r.json().freigegeben,false);
   assert.equal((await pool.query('SELECT id FROM agent_identitaeten WHERE project=$1',[project])).rowCount,0);process.env.SYNAPSE_TOKEN_IDENTITAET='1';
  });
  await check('Daemon-Route unbekannte Identität: Legacy-Start, keine implizite Anlage, no-store',async()=>{
   const r=await request();assert.equal(r.statusCode,200);assert.equal(r.json().legacy_start,true);assert.equal(r.headers['cache-control'],'no-store');
   assert.equal((await pool.query('SELECT id FROM agent_identitaeten WHERE project=$1',[project])).rowCount,0);
  });
  const master=await core.stelleAgentTokenAus({project,name:agent,modell_selbstauskunft:'synthetisch'});await core.meldeAgentMitTokenAn(master.token,project);
  let first,second;
  await check('API→Client→Spawner dieselbe Identität, Ausweis ausschließlich Env',async()=>{
   bridge(true);startEnv=await client.holeAgentStartApi(agent,project);first=startEnv.SYNAPSE_AGENT_TOKEN;
   assert.equal((await core.pruefeAgentToken(first,project)).identitaet.id,master.identitaet.id);
   const r=await spawnProbe(root,{SYNAPSE_AGENT_TOKEN:'Elternausweis',SYNAPSE_AGENT_TOKEN_START:'1',SYNAPSE_AGENT_TOKEN_ALT:'Altwert'},startEnv);assert.ok(r.spawns[0].opts.env.SYNAPSE_AGENT_TOKEN===first);
   assert.equal(r.spawns[0].opts.env.SYNAPSE_AGENT_TOKEN_START,undefined);assert.equal(r.spawns[0].opts.env.SYNAPSE_AGENT_TOKEN_ALT,undefined);
   for(const visible of[r.spawns[0].args,r.prompts,r.statuses,r.logs,r.result])assert.ok(!JSON.stringify(visible).includes(first),'Kein Ausweis in beobachtbarer Ausgabe');
   assert.match(r.prompts[0],/chat\(action: "anmelden"\)/);assert.ok(!r.prompts[0].includes('admin(action: "index_stats"'));
  });
  await check('Nur Hash in PG, Audit ohne Klartext, Haupt-Token unverändert',async()=>{
   const rows=(await pool.query('SELECT token_hash,start_art FROM agent_identitaet_tokens WHERE identity_id=$1',[master.identitaet.id])).rows;
   assert.ok(rows.some(r=>r.token_hash===core.hashAgentToken(first)&&r.start_art==='specialist'));assert.ok(!JSON.stringify(rows).includes(first));
   assert.ok(!JSON.stringify((await pool.query('SELECT alt,neu,grund FROM agent_identitaet_audit WHERE identity_id=$1',[master.identitaet.id])).rows).includes(first));
   assert.equal((await core.pruefeAgentToken(master.token,project)).identitaet.id,master.identitaet.id);
  });
  await check('Wiederholter Start: 60s Übergang, alte Anmeldung widerruft neueren Ausweis nicht',async()=>{
   second=(await client.holeAgentStartApi(agent,project)).SYNAPSE_AGENT_TOKEN;assert.ok(second!==first);
   await core.meldeAgentMitTokenAn(first,project);await core.pruefeAgentToken(second,project);
   const row=(await pool.query('SELECT gueltig_bis FROM agent_identitaet_tokens WHERE identity_id=$1 AND token_hash=$2',[master.identitaet.id,core.hashAgentToken(first)])).rows[0];
   assert.ok(row.gueltig_bis&&row.gueltig_bis.getTime()<=Date.now()+60_000);
   await core.meldeAgentMitTokenAn(second,project);await assert.rejects(core.pruefeAgentToken(first,project),e=>e.code==='agent_token_ungueltig');await core.pruefeAgentToken(master.token,project);
  });
  await check('Startsturm/Ablauf: höchstens zwei gültige Start-Ausweise, einer nach Anmeldung',async()=>{
   const issued=await Promise.all(Array.from({length:4},()=>client.holeAgentStartApi(agent,project)));
   const rows=(await pool.query("SELECT id,token_hash,gueltig_bis,start_uebergang FROM agent_identitaet_tokens WHERE identity_id=$1 AND start_art='specialist' AND widerrufen_am IS NULL AND (gueltig_bis IS NULL OR gueltig_bis>NOW())",[master.identitaet.id])).rows;
   assert.ok(rows.length<=2);const latest=rows.find(r=>!r.start_uebergang),previous=rows.find(r=>r.start_uebergang);
   const latestToken=issued.map(r=>r.SYNAPSE_AGENT_TOKEN).find(t=>core.hashAgentToken(t)===latest.token_hash);
   if(previous){
    await pool.query("UPDATE agent_identitaet_tokens SET gueltig_bis=NOW()-INTERVAL '1 second' WHERE id=$1 AND identity_id=$2",[previous.id,master.identitaet.id]);
    const old=issued.map(r=>r.SYNAPSE_AGENT_TOKEN).find(t=>core.hashAgentToken(t)===previous.token_hash);
    if(old)await assert.rejects(core.pruefeAgentToken(old,project),e=>e.code==='agent_token_ungueltig');
   }
   await core.meldeAgentMitTokenAn(latestToken,project);
   assert.equal((await pool.query("SELECT id FROM agent_identitaet_tokens WHERE identity_id=$1 AND start_art='specialist' AND widerrufen_am IS NULL",[master.identitaet.id])).rowCount,1);
   await core.pruefeAgentToken(master.token,project);
  });
  await check('Deaktivierte Identität wird nicht als Neuanmeldung umgangen',async()=>{
   await pool.query("UPDATE agent_identitaeten SET status='deaktiviert' WHERE id=$1",[master.identitaet.id]);assert.equal((await request()).statusCode,403);
   await pool.query("UPDATE agent_identitaeten SET status='aktiv' WHERE id=$1",[master.identitaet.id]);
  });
  const cfgFn=await functionFrom(join(root,'packages/mcp-server/src/tools/mcp-bruecke.ts'),'baueBrueckenConfig',{SERVER_NAME:'synapse'});
  const oldCfgFn=await functionFrom(join(baseline,'packages/mcp-server/src/tools/mcp-bruecke.ts'),'baueBrueckenConfig',{SERVER_NAME:'synapse'});
  await check('HTTP-MCP AUS bytegleich, EIN nur Env-Referenz des Identitätsausweises',async()=>{
   assert.equal(JSON.stringify(cfgFn('http://synthetisch/','synthetischer-service',agent)),JSON.stringify(oldCfgFn('http://synthetisch/','synthetischer-service',agent)));
   const cfg=cfgFn('http://synthetisch/','synthetischer-service',agent,true);
   assert.equal(cfg.mcpServers.synapse.headers['x-synapse-agent-token'],'${SYNAPSE_AGENT_TOKEN}');
   assert.ok(!JSON.stringify(cfg).includes(first));
   // Echte CLI-Envexpansion ist kein Nachweis dieses Attrappentests.
  });
  await check('Innerer ProcessManager nur Env, kein Ausweis in Argument oder Status',async()=>{
   const spawns=[],cp={spawn:(bin,args,opts)=>{
    spawns.push({bin,args,opts});const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.stdin=new PassThrough();c.pid=6789;
    c.kill=()=>{queueMicrotask(()=>c.emit('exit',0,null));return true;};return c;
   }};
   const mod=await loadModule(join(root,'packages/agents/src/process.ts'),{'node:child_process':cp,'./models.js':{resolveModel:()=>model,cliModelArg:()=>'synthetisch',effortFuerCli:()=>undefined},'./runtime-pfad.js':{loeseRuntimePfad:()=>'/tmp/fake-runtime'}},{process:{env:startEnv,cwd:()=>'/tmp'}});
   const manager=new mod.ProcessManager();await manager.start(agent,'synthetisch',currentPrompts.buildSpecialistPrompt(config,'Testwissen',true));
   assert.ok(spawns[0].opts.env.SYNAPSE_AGENT_TOKEN===first);assert.ok(!JSON.stringify(spawns[0].args).includes(first));assert.ok(!JSON.stringify([...manager.getStatus()]).includes(first));await manager.stop(agent);
  });
 }
}finally{
 if(app)await app.close();
 if(!basisPositive){
  const ids=(await pool.query('SELECT id FROM agent_identitaeten WHERE project=$1',[project])).rows.map(r=>r.id);
  await pool.query('DELETE FROM agent_sessions WHERE project=$1',[project]);
  if(ids.length){
   await pool.query('DELETE FROM agent_identitaet_laeufe WHERE identity_id=ANY($1::text[])',[ids]);
   await pool.query('DELETE FROM agent_identitaet_audit WHERE identity_id=ANY($1::text[])',[ids]);
   await pool.query('DELETE FROM agent_identitaet_tokens WHERE identity_id=ANY($1::text[])',[ids]);
   await pool.query('DELETE FROM agent_identitaeten WHERE id=ANY($1::text[])',[ids]);
  }
  assert.equal((await pool.query('SELECT id FROM agent_identitaeten WHERE project=$1',[project])).rowCount,0);console.log('OK synthetischer Scope entfernt');
 }
 await closePool();
}
console.log('ERGEBNIS '+checks+' grün, '+failed+' rot');process.exitCode=failed?1:0;
