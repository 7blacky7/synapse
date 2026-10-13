/** P16-T15: DB-freie echte TS-Programme; Quellen ausschließlich synthetische Speicher-Snapshots. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const dist=process.env.P16_CORE_DIST??resolve(root,'packages/core/dist');
const {pruefeTypAuftrag}=await import(pathToFileURL(resolve(dist,'services/typen-pruefung-worker.js')).href);
const fixture='packages/core/src/p16-engine/';
const configPath='packages/core/tsconfig.json';
const config={compilerOptions:{strict:true,target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',skipLibCheck:true,types:['node'],noEmit:true},include:['src/p16-engine/**/*']};
const base=[{file_path:configPath,content:JSON.stringify(config)},{file_path:'package.json',content:'{"name":"p16-engine","type":"module"}'},{file_path:'packages/core/package.json',content:'{"name":"p16-engine-core","type":"module"}'}];
const project='test-sol10-p16-engine-'+randomUUID();
let checks=0;
function verify(name,fn){fn();checks++;console.log('OK '+name);}
function run(file,basis,ergebnis,{quellen=[],ziele=[file],ops=[{op_index:0,agent_id:'sol-10-test',spannen:[[0,ergebnis.split('\n').length]]}],basisvergleich=true,budget_ms=20000}={}){
 return pruefeTypAuftrag({project,root,quellen:[...base,{file_path:file,content:basis},...quellen],
  dateien:[{file_path:file,basis,ergebnis,ops}],ziele,basisvergleich,budget_ms});
}
const goodEnabled='export const enabled:boolean=true;\n',badEnabled="export const enabled:boolean='yes';\n";
const goodPool="import {Pool} from 'pg';\nexport const db:Pool=new Pool();\n",badPool="import {Pool,type PoolClient} from 'pg';\nexport const db:PoolClient=new Pool();\n";
const goodStream="declare const s:NodeJS.ReadWriteStream;\ns.end();\nexport {};\n",badStream=goodStream.replace('s.end()','s.destroy()');
const goodReverse="declare const row:Record<string,unknown>;\n"+Array.from({length:17},(_,i)=>'export const ref'+i+':string=String(row.ref'+i+');').join('\n')+'\n';
const badReverse=goodReverse.replace(/String\((row\.ref\d+)\)/g,'$1');
for(const [name,good,bad,code]of [['enabled-sync',goodEnabled,badEnabled,'TS2322'],['compute-policy',goodPool,badPool,'TS2740'],['stream.destroy',goodStream,badStream,'TS2339'],['reverse-17',goodReverse,badReverse,'TS2322']]){
 const file=fixture+name+'.ts',r=run(file,good,bad);
 verify(name+' echter Typfehler',()=>{assert.equal(r.status,'fertig',JSON.stringify(r));assert(r.befunde.some(b=>b.code===code&&b.severity==='error'&&b.op_index===0),JSON.stringify(r));});
 if(name==='compute-policy')verify('Pool/PoolClient echte pg-Typen vollständig',()=>assert.equal(r.vollstaendig,true,JSON.stringify(r.fehlende_module)));
 if(name==='reverse-17')verify('alle17Fehler erkannt',()=>assert.equal(r.befunde.filter(b=>b.severity==='error').length,17));
 verify(name+' grün nach Korrektur',()=>assert.equal(run(file,good,good).befunde.filter(b=>b.severity==='error').length,0));
 verify(name+' aktuelle Datei ohne Basisvergleich',()=>assert(run(file,bad,bad,{basisvergleich:false,ops:[]}).befunde.some(b=>b.code===code)));
 verify(name+' Altlast nur verschoben',()=>assert.equal(run(file,bad,'//verschoben\n'+bad).befunde.filter(b=>b.severity==='error').length,0));
}
const lib=fixture+'lib.ts',caller=fixture+'caller.ts',goodLib='export function build(x:number):number{return x;}\n',badLib='export function build(x:number):string{return String(x);}\n';
const callerText="import {build} from './lib.js';\nexport const n:number=build(1);\n";
const foreign=run(lib,goodLib,badLib,{quellen:[{file_path:caller,content:callerText}],ziele:[lib,caller]});
verify('Fremddatei-Folgefehler richtigerVerursacher',()=>{assert(foreign.befunde.some(b=>b.datei===caller&&b.code==='TS2322'&&b.op_index===0),JSON.stringify(foreign));assert(foreign.befunde.some(b=>b.code==='FOLGEFEHLER_TS2322'&&b.severity==='warning'));});
const causeFile=fixture+'cause.ts',causeGood='export const a:number=1;\nexport const b:number=2;\n',causeBad="export const a:number='bad';\nexport const b:number=3;\n";
const cause=run(causeFile,causeGood,causeBad,{ops:[{op_index:0,agent_id:'sol-10-test',spannen:[[0,1]]},{op_index:1,agent_id:'other-test',spannen:[[1,2]]}]});
verify('früheFehlerop statt letzteSaubere',()=>assert(cause.befunde.some(b=>b.code==='TS2322'&&b.op_index===0),JSON.stringify(cause)));
const missing=run(fixture+'missing.ts','export const a=1;\n',"import type {Mystery} from 'p16-not-installed';\nexport const a:Mystery={};\n");
verify('fehlendeExterna unvollständig ohneSperre',()=>{assert.equal(missing.vollstaendig,false,JSON.stringify(missing));assert(missing.fehlende_module.includes('p16-not-installed'));assert.equal(missing.befunde.filter(b=>b.severity==='error').length,0);});
const internal=run(fixture+'internal.ts','export const a=1;\n',"import {a} from './removed.js';\nexport const value=a;\n");
verify('fehlendesInternesModul sperrt',()=>assert(internal.befunde.some(b=>b.code==='TS2307'&&b.severity==='error'),JSON.stringify(internal)));
const limit=run(fixture+'limit.ts',goodEnabled,badEnabled,{budget_ms:0});
verify('Zeitlimit verwirft blockierendeBefunde',()=>{assert.equal(limit.status,'zeitlimit');assert.equal(limit.befunde.length,0);});
const noConfig=pruefeTypAuftrag({project,root,quellen:[{file_path:'legacy.ts',content:goodEnabled}],dateien:[{file_path:'legacy.ts',basis:goodEnabled,ergebnis:badEnabled,ops:[{op_index:0,agent_id:'sol-10-test',spannen:[[0,1]]}]}],ziele:['legacy.ts'],basisvergleich:true,budget_ms:20000});
verify('Engine benennt fehlendenPaketkontext',()=>{assert.equal(noConfig.status,'nicht_verfuegbar');assert.equal(noConfig.befunde.length,0);});
console.log('PURE_TEST_GRUEN P16-T15 checks='+checks);
