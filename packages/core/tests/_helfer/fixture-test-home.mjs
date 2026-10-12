/** Test-only: eigene Streamablage, ohne HOME oder Benutzerkonfiguration zu ändern. */
import os from'node:os';import{syncBuiltinESMExports}from'node:module';import{resolve,relative,isAbsolute,sep}from'node:path';
const privateHome=process.env.SYNAPSE_TEST_STREAM_HOME;
if(privateHome){
 const base=resolve(process.cwd(),'coedit-test'),full=resolve(privateHome),rel=relative(base,full);
 if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw Error('Test stream home outside fixture scope');
 os.homedir=()=>full;syncBuiltinESMExports();
}
