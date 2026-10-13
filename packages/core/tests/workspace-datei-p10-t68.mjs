/** T68 Liveprobe: nur eigene Testwurzel und eigene versionierte Quellschutzfixture. */
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,chmod,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=await mkdtemp(join(tmpdir(),'synapse-t68-'));
try{
 await writeFile(join(root,'value'),'ok');assert.equal(await readFile(join(root,'value'),'utf8'),'ok');
 const marker=new URL('../../../workspace-source-p10-t68.txt',import.meta.url);
 for(const change of [()=>writeFile(marker,'changed'),()=>chmod(marker,0o600),()=>rename(marker,new URL('./workspace-source-p10-t68-moved.txt',marker)),()=>rm(marker)])
  await assert.rejects(change,e=>e.code==='EACCES'||e.code==='EPERM'||e.code==='EROFS');
 assert.equal(await readFile(marker,'utf8'),'T68 readonly source control\n');
 console.log('T68_CONTAINER_FS_UND_QUELLSCHUTZ_OK');
}finally{await rm(root,{recursive:true,force:true});}
