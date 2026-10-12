/** P10-T33 B: MCP-Vormaskierung darf die weitere Maskierung nicht überspringen. */
import assert from 'node:assert/strict';
const db=new URL(process.env.DATABASE_URL||'http://ungueltig');assert.equal(db.port,'5433');assert.equal(db.pathname,'/synapse_test');
const {maskiereShellDaten}=await import('../dist/services/shell-maske.js');
const fake='fake-mixed-secret-abcdefgh',url='fake-url-password';
const mixed='API_TOKEN='+fake+'\n'+fake+'\nhttps://tester:'+url+'@host/path';
const uuid='11111111-1111-4111-8111-111111111111';
const normal='rows=123 port=5433 hash='+ 'a'.repeat(64)+' UUID='+uuid+' wait_token='+uuid;
assert.deepEqual(maskiereShellDaten({output:normal},[fake]),{daten:{output:normal},maskiert:0});
for(const daten of [
 {output:mixed},
 {output:[mixed,fake]},
 {output:{text:mixed,plain:fake}},
 {output:JSON.stringify({text:mixed,plain:fake})},
 {output:[{url:'https://tester:'+url+'@host/path',plain:fake},mixed]},
]){
 const r=maskiereShellDaten(daten,[fake]);
 const text=JSON.stringify(r.daten);
 assert(!text.includes(fake),'RED: alle künstlichen Werte müssen maskiert sein');
 assert(!text.includes(url),'URL-Zugang muss maskiert sein');
 assert(r.maskiert>=3);
 const wieder=maskiereShellDaten(r.daten,[fake]);
 assert.deepEqual(wieder,{daten:r.daten,maskiert:0},'bereits maskierte Ausgabe bleibt stabil');
}
console.log('OK gemischte Strings/Arrays/Objekte/JSON vollständig maskiert; Normalausgabe unverändert mit 0 Maskierungen');
