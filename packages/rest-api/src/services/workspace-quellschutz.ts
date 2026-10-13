/** P10-T68: Root-Elternverzeichnis schützt auch vor Unlink/Ersetzen von 0444-Quellen. */
import tar from 'tar-stream';
import type Docker from 'dockerode';
export async function schuetzeWorkspaceWurzel(container:Pick<Docker.Container,'putArchive'>):Promise<void>{
 const pack=tar.pack();
 const writing=new Promise<void>((resolve,reject)=>{
  pack.once('error',reject);
  pack.entry({name:'.',type:'directory',mode:0o755,uid:0,gid:0},err=>err?reject(err):resolve());
  pack.finalize();
 });
 // Beide Fehlerkanäle sofort beobachten, auch wenn Docker vor dem Tar-Callback ablehnt.
 try{await Promise.all([writing,Promise.resolve().then(()=>container.putArchive(pack as unknown as NodeJS.ReadableStream,{path:'/workspace'}))]);}
 catch(error){pack.destroy();throw error;}
}
