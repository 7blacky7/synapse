/** P16-T15: derselbe Core-Checker im Projekt-Workspace, nur Abhängigkeiten lokal lesen. */
import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registriereTypWorkspacePruefer, type TypAuftrag, type TypPruefung } from '@synapse/core';
import { getWorkspaceOrchestrator } from './workspace-orchestrator.js';

const bootstrap=String.raw`
const {Worker}=require('node:worker_threads');
const {createRequire}=require('node:module');
const {pathToFileURL}=require('node:url');
const leer=(status,hinweis,fehlende_module=[])=>({status,dauer_ms:0,befunde:[],altlasten:0,dateien:[],vollstaendig:false,fehlende_module,betroffene_aufrufer:[],hinweis});
let input='';
process.stdin.on('data',b=>{
 input+=b.toString('utf8');
 if(!input.includes('\n'))return;
 process.stdin.removeAllListeners('data');
 const payload=JSON.parse(input);
 let compiler;
 try{compiler=createRequire('/workspace/package.json').resolve('typescript');}
 catch{
  try{compiler=require.resolve('/usr/local/lib/node_modules/typescript/lib/typescript.js');}
  catch{process.stdout.write(JSON.stringify(leer('nicht_verfuegbar','TypeScript im Workspace nicht installiert.',['typescript'])));process.exit(0);}
 }
 const source=payload.engine.replace("'typescript'",JSON.stringify(pathToFileURL(compiler).href))
  .replace("'./file-diff.js'",JSON.stringify('data:text/javascript;base64,'+Buffer.from(payload.diff).toString('base64')));
 const workerSource="import {parentPort,workerData} from 'node:worker_threads'; const m=await import(workerData.engine); parentPort.postMessage(m.pruefeTypAuftrag(workerData.auftrag));";
 const auftrag={...payload.auftrag,root:'/workspace'};
 const w=new Worker(new URL('data:text/javascript;base64,'+Buffer.from(workerSource).toString('base64')),{
  workerData:{engine:'data:text/javascript;base64,'+Buffer.from(source).toString('base64'),auftrag},resourceLimits:{maxOldGenerationSizeMb:512}});
 let fertig=false;
 const finish=r=>{if(fertig)return;fertig=true;clearTimeout(timer);process.stdout.write(JSON.stringify(r),()=>process.exit(0));void w.terminate();};
 const timer=setTimeout(()=>finish(leer('zeitlimit','FEHLERPRUEFUNG_TYPEN_MS im Workspace überschritten.')),auftrag.budget_ms);
 w.once('message',finish);w.once('error',e=>finish(leer('nicht_verfuegbar',e.message)));
 w.once('exit',()=>{if(!fertig)finish(leer('nicht_verfuegbar','Typprüf-Worker im Workspace beendet.'));});
});
`;

const leer=(status:TypPruefung['status'],hinweis:string):TypPruefung=>({
  status,dauer_ms:0,befunde:[],altlasten:0,dateien:[],vollstaendig:false,fehlende_module:[],betroffene_aufrufer:[],hinweis,
});
let code:Promise<{engine:string;diff:string}>|null=null;
function ladeEngine(){
  code??=(async()=>{
    const core=path.dirname(fileURLToPath(import.meta.resolve('@synapse/core')));
    const [engine,diff]=await Promise.all([
      readFile(path.join(core,'services/typen-pruefung-worker.js'),'utf8'),
      readFile(path.join(core,'services/file-diff.js'),'utf8'),
    ]);
    return {engine,diff};
  })();
  return code;
}
async function workspacePruefung(auftrag:TypAuftrag):Promise<TypPruefung>{
  const start=Date.now();
  const orchestrator=getWorkspaceOrchestrator();
  if(!orchestrator)return leer('nicht_verfuegbar','Kein Projekt-Workspace für Abhängigkeitstypen verfügbar.');
  const docker=new Docker({socketPath:process.env.WORKSPACE_DOCKER_SOCKET??'/var/run/docker.sock'});
  let stream:NodeJS.ReadWriteStream|undefined;
  let timer:NodeJS.Timeout|undefined;
  const lauf=(async()=>{
    const [containerId,engine]=await Promise.all([orchestrator.ensureProjectRunning(auftrag.project),ladeEngine()]);
    const budget=auftrag.budget_ms-(Date.now()-start);
    if(budget<=0)return leer('zeitlimit','Workspace nicht innerhalb des Typbudgets bereit.');
    const exec=await docker.getContainer(containerId).exec({
      Cmd:['node','-e',bootstrap],WorkingDir:'/workspace',User:'synapse',AttachStdin:true,AttachStdout:true,AttachStderr:true,
      // Prüfer erhält weder DB-Zugang noch Projektprogramm-Environment.
      Env:['DATABASE_URL=','SYNAPSE_DATABASE_URL='],
    });
    stream=await exec.start({hijack:true,stdin:true});
    const stdout=new PassThrough(),stderr=new PassThrough(),out:Buffer[]=[],err:Buffer[]=[];
    stdout.on('data',(b:Buffer)=>out.push(b));stderr.on('data',(b:Buffer)=>err.push(b));
    docker.modem.demuxStream(stream,stdout,stderr);
    return await new Promise<TypPruefung>((resolve,reject)=>{
      stream!.once('error',reject);
      stream!.once('end',()=>{
        try{resolve(JSON.parse(Buffer.concat(out).toString('utf8')) as TypPruefung);}
        catch{reject(new Error('Workspace-Typprüfung liefert keine gültige Antwort: '+Buffer.concat(err).toString('utf8').slice(0,300)));}
      });
      stream!.write(JSON.stringify({...engine,auftrag:{...auftrag,budget_ms:budget}})+'\n');
    });
  })();
  try{
    return await Promise.race([lauf,new Promise<TypPruefung>(resolve=>{
      timer=setTimeout(()=>resolve(leer('zeitlimit','Workspace-Typbudget überschritten.')),auftrag.budget_ms);
    })]);
  }catch(err){return leer('nicht_verfuegbar',(err as Error).message);}
  finally{if(timer)clearTimeout(timer);if(stream&&'destroy' in stream)(stream as import('node:stream').Duplex).destroy();}
}
/** Nur Ausführungsadapter; TS-Program/PG-Overlay stammt unverändert aus Core. */
export function installTypWorkspacePruefer():void {
  registriereTypWorkspacePruefer(workspacePruefung);
}
