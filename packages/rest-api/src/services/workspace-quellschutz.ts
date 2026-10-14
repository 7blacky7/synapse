/** P10-T70: feste Root-Operation schützt das Elternverzeichnis auch vor Unlink/Ersetzen. */
import type Docker from 'dockerode';
export async function schuetzeWorkspaceWurzel(container:Pick<Docker.Container,'exec'>):Promise<void>{
 // Docker putArchive('.') lässt die Ownership des Extraktionsverzeichnisses unverändert.
 // Keine Nutzereingaben/Env-Auflösung: nur dieser feste Mountpunkt wird als root gehärtet.
 const guard=await container.exec({
  Cmd:['/bin/sh','-ec','/bin/chown 0:0 /workspace && /bin/chmod 0755 /workspace && [ "$(/bin/stat -c %u:%g:%a /workspace)" = "0:0:755" ]'],
  User:'0',AttachStdout:true,AttachStderr:true,Tty:false,
 });
 const stream=await guard.start({hijack:true,stdin:false});
 await new Promise<void>((resolve,reject)=>{
  let done=false;
  const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve();};
  const timer=setTimeout(()=>{finish(Error('workspace_quellschutz_timeout'));stream.destroy?.();},5000);
  stream.on('data',()=>{}); // Rohstream vollständig leeren; keine Nutzerausgabe erwartet.
  stream.once('end',()=>finish());
  stream.once('error',()=>finish(Error('workspace_quellschutz_stream')));
  stream.once('close',()=>{if(!done)finish(Error('workspace_quellschutz_stream'));});
 });
 if((await guard.inspect()).ExitCode!==0)throw Error('workspace_quellschutz_fehlgeschlagen');
}
