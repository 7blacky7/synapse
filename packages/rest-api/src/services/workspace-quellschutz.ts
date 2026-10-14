/** P10-T70: t86-Rechte erhalten; Quellen nach nativen Workspace-Tests aus PG reparieren. */
import type Docker from 'dockerode';
import {PassThrough} from 'node:stream';
import {createHash} from 'node:crypto';
import * as tar from 'tar-stream';
export interface WorkspaceQuelle {file_path:string;content:string;}
export async function workspaceText(container:Pick<Docker.Container,'exec'>,cmd:string[],user='1000:1000'):Promise<string>{
 const ex=await container.exec({Cmd:cmd,User:user,AttachStdout:true,AttachStderr:true,Tty:false});
 const stream=await ex.start({hijack:true,stdin:false});
 const out=new PassThrough(),err=new PassThrough();const chunks:Buffer[]=[];let bytes=0;
 return new Promise((resolve,reject)=>{
  let done=false;const finish=async(error?:Error)=>{
   if(done)return;done=true;clearTimeout(timer);
   if(error){stream.destroy?.();reject(error);return;}
   try{if((await ex.inspect()).ExitCode!==0)throw Error('workspace_quellen_helfer_fehlgeschlagen');resolve(Buffer.concat(chunks).toString('utf8'));}
   catch(e){reject(e);}
  };
  const timer=setTimeout(()=>void finish(Error('workspace_quellen_helfer_timeout')),10000);
  out.on('data',(b:Buffer)=>{bytes+=b.length;if(bytes>262144){void finish(Error('workspace_quellen_helfer_grenze'));return;}chunks.push(Buffer.from(b));});err.resume();
  stream.once('end',()=>void finish());stream.once('error',()=>void finish(Error('workspace_quellen_helfer_stream')));
  stream.once('close',()=>{if(!done)void finish(Error('workspace_quellen_helfer_stream'));});
  // dockerode stellt keinen statischen Demux bereit; Docker-Multiplexrahmen selbst dekodieren.
  let pending=Buffer.alloc(0);
  stream.on('data',(b:Buffer)=>{
   pending=Buffer.concat([pending,b]);
   while(pending.length>=8){const size=pending.readUInt32BE(4);if(size>262144){void finish(Error('workspace_quellen_helfer_grenze'));return;}
    if(pending.length<8+size)break;(pending[0]===2?err:out).write(pending.subarray(8,8+size));pending=pending.subarray(8+size);}
  });
 });
}
/** Name bleibt kompatibel; stellt nur die installierbare t86-Wurzel wieder her. */
export async function schuetzeWorkspaceWurzel(container:Pick<Docker.Container,'exec'>):Promise<void>{
 await workspaceText(container,['/bin/sh','-ec','/bin/chown 1000:1000 /workspace && /bin/chmod 0755 /workspace && [ "$(/bin/stat -c %u:%g:%a /workspace)" = "1000:1000:755" ]'],'0');
}
const PRUEFE_QUELLEN=`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const bad=[];
for(const [rel,hash] of JSON.parse(process.argv[1])){
 const p=path.join('/workspace',rel);
 try{const s=fs.lstatSync(p);if(!s.isFile()||s.uid!==0||(s.mode&511)!==292||fs.realpathSync(p)!==p||crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')!==hash)bad.push(rel);}
 catch(e){if(['ENOENT','ENOTDIR','EACCES','ELOOP'].includes(e.code))bad.push(rel);else throw e;}
}
process.stdout.write(JSON.stringify(bad));
`;
export async function pruefeWorkspaceQuellen(container:Pick<Docker.Container,'exec'>,quellen:WorkspaceQuelle[]):Promise<string[]>{
 const bad:string[]=[];
 for(let i=0;i<quellen.length;i+=64){
  const batch=quellen.slice(i,i+64).map(q=>[q.file_path,createHash('sha256').update(q.content,'utf8').digest('hex')]);
  const result=JSON.parse(await workspaceText(container,['node','-e',PRUEFE_QUELLEN,JSON.stringify(batch)])) as unknown;
  if(!Array.isArray(result)||result.some(p=>typeof p!=='string'||!batch.some(([name])=>name===p)))throw Error('workspace_quellen_antwort_ungueltig');
  bad.push(...result);
 }
 return bad;
}
export async function schreibeWorkspaceQuellen(container:Pick<Docker.Container,'putArchive'>,quellen:WorkspaceQuelle[]):Promise<void>{
 if(!quellen.length)return;
 const pack=tar.pack();const put=container.putArchive(pack as unknown as NodeJS.ReadableStream,{path:'/workspace'});
 try{
  for(const q of quellen){const content=Buffer.from(q.content,'utf8');
   await new Promise<void>((resolve,reject)=>pack.entry({name:q.file_path,size:content.length,mode:0o444,uid:0,gid:0},content,e=>e?reject(e):resolve()));}
  pack.finalize();await put;
 }catch(e){pack.destroy();await put.catch(()=>{});throw e;}
}
/** Fester Runner: beendet bei Fristablauf nur seine eigene Prozessgruppe, vor der Quellenprüfung. */
export function workspaceExecProgramm():string{return `
const {spawn}=require('node:child_process');
const o=JSON.parse(process.argv[1]);let timedOut=false;
const child=spawn(o.programm,o.argv,{detached:true,stdio:'inherit'});
const timer=setTimeout(()=>{timedOut=true;process.stderr.write(o.marker+'\\n');try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')console.error('workspace_timeout_kill_failed',error.code);}},o.timeoutMs);
child.on('error',()=>{clearTimeout(timer);process.exit(126);});
child.on('close',(code)=>{clearTimeout(timer);try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH'){console.error('workspace_group_cleanup_failed',error.code);process.exit(125);}}process.exit(timedOut?124:code??1);});
`;}
