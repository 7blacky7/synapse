/** P10-T51 K1: Inhalte und Audits bleiben erhalten, Doppelungen werden nur angezeigt gekürzt. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { shellJobAnzeige } from '../dist/services/shell-job-anzeige.js';
const script="console.log('GOLDEN')";
const lage={kommandos:[{argv:[{raw:'node',text:'node',dynamisch:false},{raw:JSON.stringify(script),text:script,dynamisch:false},{raw:'x'.repeat(170),text:'x'.repeat(170),dynamisch:false}],inline_skript:{sprache:'javascript',text:script}}],ziele:[],sicher_aufloesbar:false};
const input={id:'fixture',project:'t51-fixture',command:'node -e '+JSON.stringify(script),status:'done',exit_code:0,output:'Grüße\n',tail:['Grüße'],output_size:0,output_truncated:false,exec_key:'[WERT]',sicherung:{lage,audit:{entscheidung:'anleitung'},antwort:{lage,ausgefuehrt:false,stufe:'anleitung'}}};
const before=JSON.stringify(input);
const compact=shellJobAnzeige(input);
assert.equal(Object.hasOwn(compact,'exec_key'),false);
assert.equal(Object.hasOwn(compact,'tail'),false);
assert.equal(compact.output,input.output);
assert.equal(compact.output_size,Buffer.byteLength(input.output));
assert.equal(compact.exit_code,0); assert.equal(compact.output_truncated,false);
assert.equal(Object.hasOwn(compact.sicherung.antwort,'lage'),false);
assert.equal(compact.sicherung.antwort.lage_verweis,'sicherung.lage');
const command=compact.sicherung.lage.kommandos[0];
assert.equal(command.argv[0].text,'node'); assert.equal(command.argv[0].dynamisch,false);
assert.equal(Object.hasOwn(command.argv[0],'raw'),false);
for(const value of [command.argv[1],command.inline_skript]){
  assert.equal(Object.hasOwn(value,'text'),false);
  assert.equal(value.text_info.laenge,script.length);
  assert.equal(value.text_info.sha256,createHash('sha256').update(script).digest('hex'));
  assert.equal(value.text_info.verweis,'job.command');
}
assert.equal(command.argv[2].text_info.laenge,170);
assert.deepEqual(compact.sicherung.lage.ziele,[]);
assert.equal(JSON.stringify(input),before,'Anzeige verändert keine Speicherung/verschachtelten Objekte');
const full=shellJobAnzeige(input,'full');
assert.deepEqual(full.sicherung,input.sicherung);
assert.deepEqual(full.tail,input.tail);
assert.equal(Object.hasOwn(full,'exec_key'),false);
assert.equal(full.output_size,Buffer.byteLength(input.output));
const unique=shellJobAnzeige({...input,sicherung:{lage,antwort:{lage:{kommandos:[],os:'anderer'}}}});
assert.deepEqual(unique.sicherung.antwort.lage,{kommandos:[],os:'anderer'},'Abweichende Analyse nicht als Dublette löschen');
const only=shellJobAnzeige({...input,sicherung:{antwort:{lage}}});
assert(only.sicherung.lage,'Einzige Lage nach oben übernehmen');
assert.equal(only.sicherung.antwort.lage_verweis,'sicherung.lage');
const running=shellJobAnzeige({...input,status:'running',output:null,tail:['noch nicht fertig'],exit_code:null});
assert.deepEqual(running.tail,['noch nicht fertig']);assert.equal(running.exit_code,null);
const empty=shellJobAnzeige({...input,output:'',tail:[]});assert.equal(empty.output,'');assert.equal(empty.output_size,0);
const flag=process.env.SYNAPSE_TOOL_ANTWORT_KOMPAKT;
try{process.env.SYNAPSE_TOOL_ANTWORT_KOMPAKT='0';assert.equal(JSON.stringify(shellJobAnzeige(input)),before,'Rückweg unverändert');}
finally{if(flag===undefined)delete process.env.SYNAPSE_TOOL_ANTWORT_KOMPAKT;else process.env.SYNAPSE_TOOL_ANTWORT_KOMPAKT=flag;}
console.log('P10-T51 K1: Metadaten, Hashes, volle/kompakte Anzeige, Null/0/false, Audit-Unverändertheit und Rückweg grün.');
