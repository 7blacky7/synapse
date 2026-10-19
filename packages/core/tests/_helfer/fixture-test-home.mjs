/** Test-only: eigene Streamablage, ohne HOME oder Benutzerkonfiguration zu ändern. */
import os from'node:os';import{syncBuiltinESMExports}from'node:module';import{resolve,relative,isAbsolute,sep,dirname}from'node:path';import{fileURLToPath}from'node:url';
const privateHome=process.env.SYNAPSE_TEST_STREAM_HOME;
if(privateHome){
 // P22-T31 R4: Repo-Root aus import.meta.url statt nur aus process.cwd() (stdio-Kindprozess hat cwd = Repo-Root, die Fixture kann unter packages/core liegen).
 const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..','..','..','..'),full=resolve(privateHome);
 const bases=[resolve(process.cwd(),'coedit-test'),resolve(repoRoot,'coedit-test'),resolve(repoRoot,'packages','core','coedit-test')];
 const ok=bases.some(base=>{const rel=relative(base,full);return !!rel&&rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel);});
 if(!ok)throw Error('Test stream home outside fixture scope');
 os.homedir=()=>full;syncBuiltinESMExports();
}
