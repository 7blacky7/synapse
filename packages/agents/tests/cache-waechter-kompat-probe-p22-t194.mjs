/**
 * P22-T194 freigegebener Schritt1: lokale Wegwerfprobe reiner nativer Mod-Events unter disableAllHooks:true.
 * Genau ein Haiku-Turn; nur bei null Events ein identischer Kontrollturn mit false. Keine Container/Runtime-Aktion.
 * Keine MCP-/Modelltools, keine API/DB, kein Installieren. Nur eigene Temp-Messdaten und feste OK-Nachricht.
 * Vorher CLI plugin validate; Ergebnis unterscheidet registriertes Plugin von tatsächlich gefeuerten Events.
 */
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const dir=await mkdtemp(join(tmpdir(),'synapse-t194-kompat-'));
const plugin=join(repo,'mods/cache-waechter-kompat-probe');
const version=spawnSync('claude',['--version'],{encoding:'utf8'}).stdout?.trim()??'unbekannt';
const env={...process.env,CLAUDE_CODE_MAX_OUTPUT_TOKENS:'32',MAX_THINKING_TOKENS:'0'};
for(const k of ['CLAUDECODE','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL'])delete env[k];
const probe=async(disableAllHooks)=>{
 const eventsPath=join(dir,disableAllHooks?'true-events.json':'false-events.json');
 const debugPath=join(dir,disableAllHooks?'true-debug.log':'false-debug.log');
 const args=['-p','--model','haiku','--input-format','stream-json','--output-format','stream-json','--verbose',
  '--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','',
  '--settings',JSON.stringify({disableAllHooks}),'--system-prompt','Reply only OK. Never call tools.',
  '--plugin-dir',plugin,'--debug-file',debugPath];
 const child=spawn('claude',args,{cwd:dir,env:{...env,SYNAPSE_CACHE_KOMPAT_AUSGABE:eventsPath},stdio:['pipe','pipe','pipe']});
 let buf='',stderr='',result=null,init=null;
 child.stdout.on('data',b=>{buf+=b;let n;while((n=buf.indexOf('\n'))>=0){const line=buf.slice(0,n);buf=buf.slice(n+1);try{const e=JSON.parse(line);if(e.type==='result')result=e;if(e.type==='system'&&e.subtype==='init')init={session_id:e.session_id,plugins:e.plugins,tool_count:e.tools?.length};}catch{}}});
 child.stderr.on('data',b=>{stderr=(stderr+b).slice(-2500);});
 const closed=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Lokale Probe timeout'));},180000);child.once('error',e=>{clearTimeout(timeout);reject(e);});child.once('close',(code,signal)=>{clearTimeout(timeout);resolve({code,signal});});});
 child.stdin.end(JSON.stringify({type:'user',message:{role:'user',content:'Reply only OK.'}})+'\n');
 const exit=await closed;
 let events=[];try{events=JSON.parse(await readFile(eventsPath,'utf8'));}catch{}
 let debug=[];try{debug=(await readFile(debugPath,'utf8')).split('\n').filter(l=>l.includes('cache-waechter-kompat-probe')).map(l=>l.slice(0,500)).slice(-25);}catch{}
 const u=result?.usage;
 const summary={disableAllHooks,version,exit,init,session_id:result?.session_id??null,is_error:result?.is_error??null,
  counts:u?[u.input_tokens,u.output_tokens,u.cache_read_input_tokens,u.cache_creation_input_tokens]:null,
  events,debug,stderr};
 console.log('P22-T194 KOMPAT '+JSON.stringify(summary));
 await writeFile(join(dir,disableAllHooks?'true-summary.json':'false-summary.json'),JSON.stringify(summary,null,2));
 if(exit.code!==0||!result||result.is_error)throw Error('CLI-Probe fehlgeschlagen; kein Kompatibilitaetsurteil');
 if(/failed to compile|HooksError|mod.*error/i.test(stderr))throw Error('Mod-Ladefehler; keine weitere Modellanfrage');
 return summary;
};
try{
 console.log('P22-T194 KOMPAT_DATEN '+dir);
 const mit=await probe(true);
 const aus=mit.events.length===0?await probe(false):null;
 const verdict={version,dir,default_true_event_count:mit.events.length,control_false_event_count:aus?.events.length??null,
  benoetigte_events:['session.start','session.measure','turn.step.begin','turn.step.end','turn.complete'],
  tatsaechliche_events:[...new Set(mit.events.map(e=>e.event))],
  befund:mit.events.length?'native_events_trotz_disableAllHooks_belegt':aus?.events.length?'native_events_durch_disableAllHooks_blockiert':'nicht_entscheidbar'};
 await writeFile(join(dir,'ergebnis.json'),JSON.stringify(verdict,null,2));
 console.log('P22-T194 KOMPAT_ERGEBNIS '+JSON.stringify(verdict));
}catch(error){console.error('DEBUG P22-T194 erwarteterBeleg=Mod-Kompatibilitaet tatsaechlich='+String(error));process.exitCode=1;}
