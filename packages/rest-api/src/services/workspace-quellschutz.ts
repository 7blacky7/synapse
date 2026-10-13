/** P10-T68: Root-Elternverzeichnis schützt auch vor Unlink/Ersetzen von 0444-Quellen. */
import tar from 'tar-stream';
import type Docker from 'dockerode';
export async function schuetzeWorkspaceWurzel(container:Pick<Docker.Container,'putArchive'>):Promise<void>{
 const pack=tar.pack(),put=container.putArchive(pack as unknown as NodeJS.ReadableStream,{path:'/workspace'});
 await new Promise<void>((resolve,reject)=>pack.entry({name:'.',type:'directory',mode:0o755,uid:0,gid:0},err=>err?reject(err):resolve()));
 pack.finalize();await put;
}
