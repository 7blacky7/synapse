/** P10-T33: öffentliche Workflow-Kennungen, echter API_TOKEN bleibt geheim. */
import assert from 'node:assert/strict';
const db=new URL(process.env.DATABASE_URL||'http://ungueltig');assert.equal(db.port,'5433');assert.equal(db.pathname,'/synapse_test');
const {maskiereShellText,shellGeheimWerte}=await import('../dist/services/env-maske.js');
const {maskiereShellDaten}=await import('../dist/services/shell-maske.js');
const uuid='11111111-1111-4111-8111-111111111111',api='22222222-2222-4222-8222-222222222222';
for(const key of ['wait_token','batch_token','stream_id']){
 const text=key+'='+uuid;
 assert.deepEqual(maskiereShellText(text),{text,maskiert:0},'RED: Workflow-Kennung darf kein Geheimnis sein');
 const json=JSON.stringify({[key]:uuid});
 assert.deepEqual(maskiereShellText(json),{text:json,maskiert:0});
 assert.deepEqual(maskiereShellText('log '+json),{text:'log '+json,maskiert:0});
 assert.equal(maskiereShellDaten({[key]:uuid},[]).daten[key],uuid);
 assert(!shellGeheimWerte(key.toUpperCase()+'='+uuid).includes(uuid),'öffentliche Kennung nicht als Literal sammeln');
}
for(const key of ['API_TOKEN','ACCESS_TOKEN','REFRESH_TOKEN','SESSION_TOKEN','TOKEN']){
 assert(!maskiereShellText(key+'='+api).text.includes(api),'UUID-Form allein entklassifiziert kein Zugangstoken');
 const j=JSON.stringify({[key]:api});
 assert(!maskiereShellText(j).text.includes(api));
 assert(shellGeheimWerte(key+'='+api).includes(api));
}
console.log('OK wait_token/batch_token/stream_id unverändert, 0 Maskierungen; echte API-/Access-/Refresh-/Session-Tokens weiter geschützt, auch als UUID');
