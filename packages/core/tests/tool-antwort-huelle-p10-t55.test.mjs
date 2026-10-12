/** P10-T55: zentrale Hülle, keine DB/Produktionsdienste. */
import assert from 'node:assert/strict';
import {baueToolErgebnis,kompaktiereTextErgebnis} from '../dist/services/tool-antwort.js';
const parse=r=>JSON.parse(r.content[0].text);
for(const [tool,action,inner]of[
  ['shell','get',{success:true,job:{id:'fixture',exit_code:null,output:'Inhalt bleibt',output_truncated:false}}],
  ['channel','feed',{success:true,count:0,messages:[]}],
]){
  const payload={content:[{type:'text',text:JSON.stringify(inner,null,2)}],agentOnboarding:{rules:[]},tool_guide:{action}};
  const before=JSON.stringify(payload);
  const result=baueToolErgebnis(payload,{tool,action,strukturiert:true});
  assert.deepEqual(parse(result),{...inner,agentOnboarding:{rules:[]},tool_guide:{action}});
  assert.deepEqual(result.structuredContent,parse(result));
  assert.equal(JSON.stringify(payload),before);
  const stdio=kompaktiereTextErgebnis({content:[{type:'text',text:JSON.stringify(payload)}]},tool,action);
  assert.deepEqual(parse(stdio),parse(result));
  assert.deepEqual(stdio.structuredContent,parse(result));
}
const error=baueToolErgebnis({content:[{type:'text',text:'{"success":false,"error":"unknown_job"}'}]},{tool:'shell',action:'get',isError:true,strukturiert:true});
assert.equal(error.isError,true);assert.equal(parse(error).success,false);
for(const text of ['Freier Text','[1,2]','null','kaputtes {JSON']){
  const payload={content:[{type:'text',text}]};
  assert.deepEqual(parse(baueToolErgebnis(payload,{tool:'shell',action:'get'})).content,payload.content);
}
const blocks={content:[{type:'text',text:'{"count":0}'},{type:'text',text:'zweiter Block'}]};
assert.deepEqual(parse(baueToolErgebnis(blocks,{tool:'channel',action:'feed'})).content,blocks.content);
const unrelated={content:[{type:'text',text:'{"content":"Dokument"}'}]};
assert.deepEqual(parse(baueToolErgebnis(unrelated,{tool:'files',action:'read'})).content,unrelated.content);
const history={content:[{type:'text',text:'{"jobs":[]}'}]};
assert.deepEqual(parse(baueToolErgebnis(history,{tool:'shell',action:'history'})).content,history.content);
process.env.SYNAPSE_TOOL_ANTWORT_KOMPAKT='0';
assert.deepEqual(parse(baueToolErgebnis(history,{tool:'shell',action:'get'})),history);
delete process.env.SYNAPSE_TOOL_ANTWORT_KOMPAKT;
console.log('P10-T55 grün: eine Hülle, strukturierter/Text-Inhalt, Anhänge, Leer-/Fehlerwerte, Schutz nicht passender Inhalte und Rückweg.');
