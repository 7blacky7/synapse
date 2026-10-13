/** W3: deterministic unchanged reverse error contracts; optional feature control. */
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const base=process.env.SOL3_W3_BASE;
const moduleUrl=p=>base?pathToFileURL(base+'/packages/core/dist/'+p).href:new URL('../dist/'+p,import.meta.url).href;
if(process.env.SOL3_FEATURE_CONTROL==='1'){
 const core=await import(moduleUrl('index.js'));
 assert.equal(typeof core.ReverseEingang,'function','RV5 ReverseEingang must exist');
 console.log('RV5 feature present');
}else{
 const {createReverseToolService,baueReverseAntwort,pruefeReversePfad}=await import(moduleUrl('services/reverse-tool.js'));
 const service=createReverseToolService({pool:{connect:async()=>{throw new Error('unexpected DB access');}}});
 const cases=[{}, {action:'not-supported',agent_id:'fixture'}, {action:'liste',agent_id:'fixture',unknown:1}];
 const outputs=[];for(const c of cases)outputs.push(await service.ausfuehren(c));
 for(const pfad of ['../escape','/absolute','a//b','C:/windows']){try{pruefeReversePfad(pfad);assert.fail('unsafe path');}catch(e){assert.equal(e.code,'pfad_gefahr');outputs.push(baueReverseAntwort({action:'status',datei:pfad},{},e.code));}}
 console.log(JSON.stringify(outputs));
}
