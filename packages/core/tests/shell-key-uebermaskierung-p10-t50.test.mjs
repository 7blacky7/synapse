/** P10-T50: generischer JSON-Schluessel ist kein Geheimnis; explizite Secrets bleiben geschuetzt. */
import assert from 'node:assert/strict';
import {maskiereShellDaten,maskiereShellText} from '../dist/services/shell-maske.js';
import {maskiereMcpJson,shellGeheimWerte} from '../dist/services/env-maske.js';
import {sammleShellMaskenTreffer} from '../dist/services/shell-masken-katalog.js';
const harmless=[
 "{ key: 'project', match: { value: project } }",
 "+ { key: 'category', match: { value: category } },",
 '{"key":"project","match":{"value":"synapse"}}',
 '{"keys":["project","category"]}',
 '  "key": "category",',
];
const secret='fixture-secret-value-7731';
for(const text of ['KEY='+secret,'key='+secret,'API_KEY='+secret,
 '{"api_key":"'+secret+'"}',"{ private_key: '"+secret+"' }",'{"password":"'+secret+'"}',
 'Authorization: Bearer '+secret,'{"token":{"key":"'+secret+'"}}']){
 assert.ok(!maskiereShellText(text,[]).text.includes(secret),'explizites Geheimnis bleibt geschuetzt');
}
assert.ok(shellGeheimWerte('KEY='+secret).includes(secret),'Env-Literalquelle bleibt');
assert.ok(!maskiereMcpJson('{"key":"'+secret+'"}').includes(secret),'MCP-Konfigmaske unveraendert');
console.log('PASS Geheimnis-Gegenkontrollen');
for(const text of harmless){
 assert.equal(maskiereShellText(text,[]).text,text,'harmloser Quelltext muss bytegleich bleiben');
 assert.deepEqual(maskiereShellDaten({output:text,tail:[text]},[],true).daten,{output:text,tail:[text]});
 assert.equal(sammleShellMaskenTreffer(text,[]).length,0,'Katalog darf keinen erfundenen Treffer melden');
}
const literal='{"key":"'+secret+'"}';
assert.ok(!maskiereShellText(literal,[secret]).text.includes(secret),'bekanntes Literal auch unter generischem key geschuetzt');
assert.ok(sammleShellMaskenTreffer(literal,[secret]).some(h=>h.regel==='env_literal'));
console.log('PASS P10-T50 key/keys in Quelltext+JSON bytegleich, Literal-/Env-/Auth-/MCP-Schutz erhalten');
