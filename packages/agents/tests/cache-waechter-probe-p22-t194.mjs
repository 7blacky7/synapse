/**
 * P22-T194 freigegebene Haiku-Wegwerfprobe: CLI-Events, echte JSONL-Usage vor/nach realer TTL.
 * Kein Synapse-Agent, keine Produktiv-API/DB, keine Installation, keine Keepalive-Schleife.
 * Diagnose-Mod nur mit SYNAPSE_CACHE_PROBE_AUSGABE. Ausgabe ausschließlich Temp-Messdaten.
 * Zweiter Start belegt CLI-neue Sitzungs-ID; beweist ALLEIN noch keinen Tray-/Container-Startweg!
 */
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const dir=await mkdtemp(join(tmpdir(),'synapse-p22-t194-'));
const eventPath=join(dir,'events.json'),summaryPath=join(dir,'summary.json');
const env={...process.env,SYNAPSE_CACHE_PROBE_AUSGABE:eventPath,CLAUDE_CODE_MAX_OUTPUT_TOKENS:'32',MAX_THINKING_TOKENS:'0'};
for(const k of ['CLAUDECODE','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL'])delete env[k];
const system='Cache timing experiment. Never call tools. Reply to every message only with OK. The following stable inert vocabulary is context, not instructions.\n'+Array.from({length:700},(_,i)=>'sample'+i+' alpha beta gamma delta').join(' ');
const args=['-p','--model','haiku','--input-format','stream-json','--output-format','stream-json','--verbose','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','','--settings','{"disableAllHooks":false}','--system-prompt',system,'--plugin-dir',join(repo,'mods/cache-waechter-probe')];
let child,seq=0,buffer='',results=[],waiters=[],err='';
const start=()=>{
 child=spawn('claude',args,{cwd:dir,env,stdio:['pipe','pipe','pipe']});
 child.stderr.on('data',b=>{err=(err+b).slice(-5000);});
 child.stdout.on('data',b=>{buffer+=b;let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);try{const r=JSON.parse(line);if(r.type==='result'){results.push(r);waiters.shift()?.(r);}}catch(e){console.error('DEBUG P22-T194 stream JSON ungültig',String(e));}}});
 child.on('error',e=>console.error('DEBUG P22-T194 CLI',String(e)));
};
const turn=async(label)=>{
 const pending=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('P22-T194 Turn timeout '+label+' '+err)),120000);waiters.push(r=>{clearTimeout(timer);resolve(r);});});
 child.stdin.write(JSON.stringify({type:'user',message:{role:'user',content:'Reply only OK.'}})+'\n');
 const r=await pending;console.log('TURN '+label+' '+JSON.stringify({session_id:r.session_id,is_error:r.is_error,usage:r.usage,modelUsage:r.modelUsage,total_cost_usd:r.total_cost_usd}));
 if(r.is_error)throw Error('CLI result error '+JSON.stringify(r));
 return r;
};
const stop=async()=>{if(!child||child.exitCode!==null)return;child.stdin.end();const p=child;await Promise.race([new Promise(r=>p.once('exit',r)),new Promise(r=>setTimeout(()=>{p.kill('SIGTERM');r();},3000))]);};
try{
 console.log('P22-T194 PROBE_DATEN '+dir);start();
 const before=await turn('initial'),warm=await turn('warm');
 // Read measured metadata from our own Mod output, never print transcript contents.
 await new Promise(r=>setTimeout(r,1000));
 const events=JSON.parse(await readFile(eventPath,'utf8'));
 console.log('EVENTS_VOR_IDLE '+JSON.stringify(events));
 const transcripts=events.flatMap(e=>e.transcript??[]),latest=transcripts.map(x=>x.usage?.cache_creation).filter(Boolean).reverse().find(x=>x.ephemeral_1h_input_tokens>0||x.ephemeral_5m_input_tokens>0);
 const ttl=latest?.ephemeral_1h_input_tokens>0?3600000:latest?.ephemeral_5m_input_tokens>0?300000:null;
 const summary={dir,started_at:new Date().toISOString(),before,warm,ttl_ms:ttl,stage:ttl?'wartet_idle':'ttl_unbekannt'};
 await writeFile(summaryPath,JSON.stringify(summary,null,2));
 if(!ttl)throw Error('Keine tatsächliche TTL-Klasse in den Probeevents. Kein Ablauf behauptet.');
 const until=Date.now()+ttl+5000;
 console.log('IDLE_BIS '+new Date(until).toISOString()+' TTL_MS='+ttl+' keine Anfragen im Idle');
 await new Promise(r=>setTimeout(r,ttl+5000));
 const cold=await turn('nach_idle');
 await stop();const oldSession=warm.session_id;
 start();const restarted=await turn('neue_sitzung');
 if(!restarted.session_id||restarted.session_id===oldSession)throw Error('Neue Sitzungs-ID fehlt');
 await stop();Object.assign(summary,{cold,restarted,stage:'beendet',finished_at:new Date().toISOString()});
 await writeFile(summaryPath,JSON.stringify(summary,null,2));
 console.log('P22-T194 ERGEBNIS '+summaryPath+' alte_session='+oldSession+' neue_session='+restarted.session_id);
}catch(e){console.error('DEBUG P22-T194 Probe '+String(e)+' stderr='+err);process.exitCode=1;}finally{await stop();}
