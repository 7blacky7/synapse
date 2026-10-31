/**
 * P22-T194 / f18b99fb / a389b0ae: managed Startpolicy, echter Unix-Socket, Imagepaket
 * und dieselben Mod-Handler wie im Produkt. Keine LLM-/Docker-/Browser-/DB-Aufrufe.
 * Herkunft: core/runtime-mod-policy.ts, agents/{process,runtime-mod-policy,cache-waechter-mod-bruecke}.ts,
 * daemon/runtime-mods.ts und mods/synapse-inbox/hooks. Fehler nennen erwartet/ist.
 */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm,stat,chmod} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import {spawnSync} from 'node:child_process';
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1'});
const root=resolve(fileURLToPath(new URL('../../..',import.meta.url)));
const load=p=>import(pathToFileURL(join(root,p)).href);
const C=await load('packages/core/dist/services/runtime-mod-policy.js');
const T=await load('packages/core/dist/services/runtime-tool-ausgabe-regeln.js');
const H=await load('packages/agents/dist/runtime-mod-policy.js');
const B=await load('packages/agents/dist/cache-waechter-mod-bruecke.js');
const {paketiereMods}=await load('docker/synapse-agent-runtime/paketiere-mods.mjs');
const {provisioniereRuntimeMods}=await load('packages/file-watcher-daemon-ts/dist/runtime-mods.js');
const require=createRequire(new URL('../package.json',import.meta.url)),ts=require('typescript');
const dir=await mkdtemp(join(tmpdir(),'p22-t194-mods-'));
let bruecke,checks=0;
const ok=(v,label,ist=v)=>{assert.ok(v,'P22-T194 '+label+' | erwartet=true | ist='+JSON.stringify(ist));checks++;};
const stand=aktiv=>({aktiv,quelle:'produkt-schalter',bis:null,letzter_fehler:null,produkt:{aktiv,quelle:'produkt-schalter',letzter_fehler:null}});
const env=(m,r)=>({SYNAPSE_RUNTIME_MOD_POLICY:'1',SYNAPSE_RUNTIME_SYNAPSE_MODS_STAND:JSON.stringify(stand(m)),
 SYNAPSE_TOOL_AUSGABE_AKTIV:r?'1':'0',SYNAPSE_CLAUDE_MCP_OUTPUT_TOKENS:'100000',SYNAPSE_TOOL_AUSGABE_GUARD_SEKUNDEN:'8'});
const http=(socket,method,path,body)=>new Promise((resolve,reject)=>{
 const req=request({socketPath:socket,method,path,headers:{'content-type':'application/json'}},r=>{
  let text='';r.setEncoding('utf8');r.on('data',s=>text+=s);r.on('end',()=>resolve({status:r.statusCode,body:JSON.parse(text)}));
 });req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
});
try{
 for(const m of [false,true])for(const r of [false,true]){
  const e=env(m,r),p=C.baueRuntimeModPolicy(e,'/opt/synapse/r1/mods').managedSettings,f=T.claudeToolAusgabe(e,true);
  ok(p.allowManagedHooksOnly&&p.disableAllHooks===(!m&&!r),'core/runtime-mod-policy Startmatrix '+m+'/'+r,p);
  ok(p.enabledPlugins[C.RUNTIME_MOD_PLUGIN]===m&&p.prependPlugins.includes('sec-default@builtin'),'nur freigegebener Mod, Builtin-Guard bleibt '+m+'/'+r,p);
  ok(!f.flags.includes('--settings'),'T190 kein konkurrierendes CLI-settings im managed Profil '+m+'/'+r,f.flags);
  ok(f.flags[f.flags.indexOf('--tools')+1]===(r?'Read':''),'Built-ins exakt nach T190 '+m+'/'+r,f.flags);
  if(r){
   const klassisch=JSON.parse(T.claudeToolAusgabe({...e,SYNAPSE_RUNTIME_MOD_POLICY:'0'},true).flags.at(-1));
   assert.deepEqual(p.hooks,klassisch.hooks,'P22-T194 T190 gleicher Guard/Timeout/onFailure in managed');checks++;
  }else ok(!p.hooks,'kein Read-Guard ohne Read-Freigabe '+m);
 }
 const expired={...stand(false),quelle:'intern',bis:'2000-01-01T00:00:00Z',produkt:stand(true).produkt};
 ok(C.runtimeModStartStand({SYNAPSE_RUNTIME_SYNAPSE_MODS_STAND:JSON.stringify(expired)}).aktiv,'intern AUS abgelaufen -> PG EIN');
 ok(!C.runtimeModStartStand({SYNAPSE_RUNTIME_SYNAPSE_MODS_STAND:'kaputt'}).aktiv,'ungueltiger Startstand -> AUS');
 const paket=join(dir,'paket');paketiereMods(join(root,'mods'),paket,'t194-test');
 ok(H.pruefeRuntimeModPaket(paket).version==='0.3.0','Imagepaket Version+alle Hashes');
 const home=join(dir,'home');await mkdir(home);
 const ps=provisioniereRuntimeMods({HOME:home,SYNAPSE_RUNTIME_MOD_POLICY:'1',SYNAPSE_RUNTIME_MOD_MARKETPLACE:paket});
 ok(ps.bereit&&ps.sha256&&ps.home_pfad.startsWith(home+'/.claude/synapse-mods/'),'HOME-Mount nachtraeglich provisioniert',ps);
 assert.deepEqual(provisioniereRuntimeMods({HOME:home,SYNAPSE_RUNTIME_MOD_POLICY:'1',SYNAPSE_RUNTIME_MOD_MARKETPLACE:paket}),ps);checks++;
 const launcher=join(dir,'policy-helper');await symlink(join(root,'packages/agents/dist/runtime-mod-policy.js'),launcher);
 const run=spawnSync(process.execPath,[launcher],{env:{...process.env,...env(true,true),SYNAPSE_RUNTIME_MOD_MARKETPLACE:paket},encoding:'utf8'});
 ok(run.status===0,'policyHelper laeuft auch ueber Image-Symlink',{exit:run.status,err:run.stderr});
 ok(JSON.parse(run.stdout).managedSettings.enabledPlugins[C.RUNTIME_MOD_PLUGIN],'policyHelper managedSettings-Huelle');
 const kaputt=join(paket,'synapse-inbox/hooks/hooks.json');await writeFile(kaputt,'{}');
 assert.throws(()=>H.pruefeRuntimeModPaket(paket),/runtime_mod_paket_hash/);checks++;
 await rm(kaputt);paketiereMods(join(root,'mods'),paket,'t194-test');

 // Echter ProcessManager -> eigener Fake-CLI-Prozess: kein Modell/Netz, finale argv/env pruefen.
 const {ProcessManager}=await load('packages/agents/dist/process.js');
 const cliDir=join(dir,'bin');await mkdir(cliDir);
 const fake=join(cliDir,'claude');
 await writeFile(fake,'#!'+process.execPath+'\n'+
  "if(process.argv.includes('--version')){console.log('2.1.310 (Claude Code)');}else{require('node:fs').writeFileSync(process.env.T194_ARGV,JSON.stringify({args:process.argv.slice(2),limit:process.env.MAX_MCP_OUTPUT_TOKENS,keineHooks:process.env.SYNAPSE_KEINE_HOOKS}));}\n");
 await chmod(fake,0o700);
 const keys=['PATH','SYNAPSE_CLI_RECHTE','SYNAPSE_RUNTIME_MOD_POLICY','SYNAPSE_RUNTIME_MOD_MARKETPLACE',
  'SYNAPSE_RUNTIME_SYNAPSE_MODS_STAND','SYNAPSE_TOOL_AUSGABE_AKTIV','SYNAPSE_CLAUDE_MCP_OUTPUT_TOKENS',
  'SYNAPSE_TOOL_AUSGABE_GUARD_SEKUNDEN','SYNAPSE_KEINE_HOOKS','SYNAPSE_MCP_CONFIG_FILE','SYNAPSE_MCP_STRICT','T194_ARGV'];
 const vorher=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 try{
  for(const m of [false,true])for(const r of [false,true]){
   const out=join(dir,'argv-'+m+'-'+r+'.json');
   Object.assign(process.env,env(m,r),{PATH:cliDir+':'+vorher.PATH,SYNAPSE_CLI_RECHTE:'container',
    SYNAPSE_RUNTIME_MOD_MARKETPLACE:paket,SYNAPSE_KEINE_HOOKS:'1',
    SYNAPSE_MCP_CONFIG_FILE:join(dir,'eigener-mcp.json'),SYNAPSE_MCP_STRICT:'1',T194_ARGV:out});
   const pm=new ProcessManager(),name='t194-'+m+'-'+r;
   let session=false;pm.on('sitzung-start',()=>{session=true;});
   const ende=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('P22-T194 Fake-CLI Ende fehlt')),5000);timer.unref();
    pm.once('exit',(_name,code)=>{clearTimeout(timer);code===0?resolve():reject(Error('Fake-CLI Exit '+code));});
    pm.once('error',e=>{clearTimeout(timer);reject(e);});
   });
   await pm.start(name,'haiku','T194 Fixture',{cwd:dir,projectPath:dir,projectName:'p22-t194'});
   await ende;
   const cli=JSON.parse(await readFile(out,'utf8')),a=cli.args;
   ok(session&&!a.includes('--settings'),'ProcessManager meldet Sitzung und setzt kein konkurrierendes settings '+m+'/'+r,a);
   ok(a[a.indexOf('--tools')+1]===(r?'Read':'')&&a[a.indexOf('--permission-mode')+1]==='dontAsk',
    'ProcessManager Built-ins/Permission exakt '+m+'/'+r,a);
   ok(a.includes('--strict-mcp-config')&&a[a.indexOf('--mcp-config')+1]===join(dir,'eigener-mcp.json')
    &&a.includes('mcp__synapse__*'),'ProcessManager nur eigene strikte MCP-Config '+m+'/'+r,a);
   ok(cli.keineHooks==='1'&&(!r||cli.limit==='100000'),'ProcessManager T6-Markierung bleibt, T190 Env durchgereicht '+m+'/'+r,cli);
  }
  Object.assign(process.env,env(true,false),{SYNAPSE_CLI_RECHTE:'container',SYNAPSE_RUNTIME_MOD_POLICY:'0'});
  await assert.rejects(()=>new ProcessManager().start('t194-alt','haiku','Fixture',{cwd:dir}),/verwaltetes Runtime-Image erforderlich/);checks++;
 }finally{for(const[k,v]of Object.entries(vorher)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}

 const sid='12345678-1234-4234-8234-123456789001',lauf='12345678-1234-4234-8234-123456789002';
 let bindung={sitzung:sid,lauf_id:null,ab_ms:100},frei=true;
 const meldungen=[],socket=join(dir,'cache.sock');
 bruecke=await B.starteCacheModBruecke(socket,{bindung:()=>bindung,freigabe:async()=>({aktiv:frei,quelle:'test'}),
  melden:async m=>{meldungen.push(m);return {success:true,angenommen:true};},log:()=>{}});
 ok(((await stat(socket)).mode&0o777)===0o600,'eigener Socket Rechte0600');
 ok((await http(socket,'GET','/cache-waechter?sitzung=fremd')).status===409,'fremde Session abgewiesen');
 let antwort=await http(socket,'GET','/cache-waechter?sitzung='+sid);
 ok(!antwort.body.aktiv&&antwort.body.generation===null,'vor Anmeldung kein aktiver Mod');
 bindung={sitzung:sid,lauf_id:lauf,ab_ms:100};
 antwort=await http(socket,'GET','/cache-waechter?sitzung='+sid);
 ok(antwort.body.aktiv&&antwort.body.generation===lauf,'bestaetigte Generation geliefert');
 const messung={messung_ms:200,request_beginn_ms:110,nutzungsmessung_ms:190,modell:'haiku',request_id:'msg-1',input:2,output:3,gelesen:10,geschrieben:0,ttl_klassen:[],ttl_quelle:'unbekannt',mod_version:'0.3.0'};
 const body={sitzung:sid,generation:lauf,messung};
 ok((await http(socket,'POST','/cache-waechter',body)).body.angenommen&&meldungen.length===1,'echter POST mit servergebundenem Lauf');
 ok(meldungen[0].lauf_id===lauf&&meldungen[0].messung.erfassung==='mod','Body waehlt weder Ausweis noch Herkunft',meldungen[0]);
 ok((await http(socket,'POST','/cache-waechter',{...body,generation:'alt'})).status===409&&meldungen.length===1,'alte Generation ohne zweiten Write');
 ok((await http(socket,'POST','/cache-waechter',{...body,messung:{...messung,request_beginn_ms:90}})).status===409,'Messung vor Anmeldung abgewiesen');
 frei=false;ok(!(await http(socket,'POST','/cache-waechter',body)).body.angenommen&&meldungen.length===1,'Produkt AUS stoppt vorhandene Mod');
 await bruecke.stop();bruecke=null;
 await assert.rejects(()=>stat(socket),{code:'ENOENT'});checks++;

 // Dieselben TS-Module und nativen Handler aus dem Produkt, nur Engine-API ersetzt.
 const cache={exports:{}};
 new Function('require','module','exports',ts.transpileModule(readFileSync(join(root,'mods/synapse-inbox/hooks/cache-waechter.ts'),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(()=>{throw Error('unerwarteter Import');},cache,cache.exports);
 const reg={exports:{}},handlers=new Map();
 new Function('require','module','exports',ts.transpileModule(readFileSync(join(root,'mods/synapse-inbox/hooks/register.ts'),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(n=>{assert.equal(n,'./cache-waechter');return cache.exports;},reg,reg.exports);
 reg.exports.register((name,fn)=>handlers.set(name,fn));
 let freigegeben=false,zeit=1000,submits=0,timer=0,reads=0;const calls=[];
 const usage={input_tokens:2,output_tokens:3,cache_read_input_tokens:10,cache_creation_input_tokens:0,model:'haiku'};
 const $={env:{get:async k=>({SYNAPSE_CLI_RECHTE:'container',SYNAPSE_RUNTIME_MOD_POLICY:'1',SYNAPSE_CACHE_MOD_SOCKET:'/tmp/eigen.sock'})[k]},
  session:{id:async()=>sid,version:async()=>({version:'2.1.310'})},clock:{now:async()=>zeit,after:()=>{timer++;}},
  fs:{read:async()=>{reads++;return JSON.stringify({type:'user',timestamp:new Date(1000).toISOString()})+'\n'+JSON.stringify({type:'assistant',timestamp:new Date(1010).toISOString(),message:{id:'msg-provider',model:'haiku',usage}});}},
  http:{fetch:async(url,init={})=>{calls.push({url,init});return {status:200,ok:true,text:JSON.stringify(init.method==='POST'?{success:true,angenommen:true}:{aktiv:freigegeben,generation:lauf})};}},
  prompt:{submit:async()=>{submits++;}},ui:{status:()=>{}},process:{run:async()=>{throw Error('kein Prozess erlaubt');}}};
 const next=async e=>e;
 await handlers.get('classic.SessionStart')($,{transcript_path:'eigene.jsonl'},next);
 await handlers.get('session.start')($,{cwd:'/',isInteractive:false},next);
 ok(timer===0&&submits===0&&calls.every(c=>!c.url.includes('/warte')),'Runtime-session.start erzeugt keine Inbox/Timer/Prompts',calls);
 const schritt=async()=>{
  const g=handlers.get('turn.step')($,{turnId:'turn-1',index:0,model:'haiku'},async function*(){zeit=1010;return {usage};});
  const r=await g.next();ok(r.done&&r.value.usage===usage,'native turn.step reicht Ergebnis unveraendert durch');
  for(let i=0;i<15;i++)await new Promise(setImmediate);
 };
 await schritt();ok(reads===0&&!calls.some(c=>c.init.method==='POST'),'Cache AUS liest kein Transcript und sendet keine Messung');
 freigegeben=true;zeit=1000;await schritt();
 await handlers.get('classic.Stop')($,{transcript_path:'eigene.jsonl'},next);for(let i=0;i<15;i++)await new Promise(setImmediate);
 const posts=calls.filter(c=>c.init.method==='POST').map(c=>JSON.parse(c.init.body));
 ok(posts.length>0&&posts.every(p=>p.generation===lauf&&p.sitzung===sid),'native Messung ueber Socket, Session+Generation',posts);
 ok(posts.some(p=>p.messung.request_id==='msg-provider'),'Transcript liefert kanonische Provider-ID fuer Quellenabgleich',posts);
 ok(calls.every(c=>c.init.socketPath==='/tmp/eigen.sock')&&submits===0&&timer===0,'alle Runtime-Aufrufe nur eigene Bruecke, kein Wecken',calls);
 console.log('BESTANDEN '+checks+' P22-T194 Runtime-Mod-Vertraege (ohne LLM/Container/Browser)');
}finally{if(bruecke)await bruecke.stop();await rm(dir,{recursive:true,force:true});}
