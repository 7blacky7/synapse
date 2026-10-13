/** P10-T65: Laufzeitguard auf derselben Verbindung vor jeder Nutzabfrage. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {oeffneGeschuetzteTestDb} from '../dist/services/test-db-laufzeit-schutz.js';
const url='postgresql://worker:synthetic@own.invalid:6544/synapse_test';
const ziel={host:'own.invalid',port:'6544',datenbank:'synapse_test',user:'worker'};
const proof={project:'p10_shell_projektdb',test_system_id:'123456789',ziele:[{...ziel,art:'test'}],live:{host:'live.invalid',port:'5432',datenbank:'synapse',user:'worker'}};
function mock(rows){
 const calls=[];let closed=false;
 const client={connect:async()=>{},end:async()=>{closed=true;},query:async(sql,values)=>{
  calls.push(sql);if(sql.startsWith('SELECT current_database()'))return {rows:[rows.shift()]};
  return {rows:[{ok:true}],rowCount:1};
 }};
 return {client,calls,get closed(){return closed;}};
}
const ok=()=>({datenbank:ziel.datenbank,port:6544,user:'worker',system_id:'123456789'});
test('Ziel außerhalb der Registry verbindet sich überhaupt nicht',async()=>{
 let connected=false;
 await assert.rejects(()=>oeffneGeschuetzteTestDb(url.replace('6544','5432'),proof,()=>{connected=true;throw Error('unused');}),/test_db_ziel_nicht_freigegeben/);
 assert.equal(connected,false);
});
test('Vor jeder Abfrage SQL-Kontrolle auf derselben Verbindung',async()=>{
 const m=mock([ok(),ok()]);
 const db=await oeffneGeschuetzteTestDb(url,proof,()=>m.client);
 await db.query('DELETE FROM owned');await db.query('DROP SCHEMA owned CASCADE');await db.end();
 assert.equal(m.calls.length,4);assert.match(m.calls[0],/current_database\(\).*pg_control_system\(\)/);
 assert.equal(m.calls[1],'DELETE FROM owned');assert.match(m.calls[2],/current_database/);assert.equal(m.calls[3],'DROP SCHEMA owned CASCADE');
 assert.equal(m.closed,true);assert.equal('client' in db,false);
});
for(const [name,row]of [
 ['DB',{...ok(),datenbank:'synapse'}],['Cluster',{...ok(),system_id:'987654321'}],['User',{...ok(),user:'other'}],['fehlender Nachweis',undefined],
])test('Abweichender Server-'+name+' verhindert Nutzabfrage',async()=>{
 const m=mock([row]);const db=await oeffneGeschuetzteTestDb(url,proof,()=>m.client);
 await assert.rejects(()=>db.query('DROP SCHEMA owned CASCADE'),/test_db_laufzeit_ziel_abweichend/);
 assert.equal(m.calls.length,1);await db.end();
});
test('Nachweis wird nicht für spätere Abfragen gecacht',async()=>{
 const m=mock([ok(),{...ok(),datenbank:'foreign'}]);const db=await oeffneGeschuetzteTestDb(url,proof,()=>m.client);
 await db.query('DELETE FROM owned');
 await assert.rejects(()=>db.query('DROP SCHEMA owned CASCADE'),/test_db_laufzeit_ziel_abweichend/);
 assert.equal(m.calls.filter(x=>x.startsWith('DROP')).length,0);await db.end();
});
test('Gleichzeitige Abfragen halten Prüfung und Abfrage zusammen',async()=>{
 const m=mock([ok(),ok()]);const db=await oeffneGeschuetzteTestDb(url,proof,()=>m.client);
 await Promise.all([db.query('DELETE FROM first'),db.query('DELETE FROM second')]);await db.end();
 assert.equal(m.calls[1],'DELETE FROM first');assert.equal(m.calls[3],'DELETE FROM second');
});
test('Serveradministration/DB-Wechsel erhält keine Ausnahme',async()=>{
 const m=mock([ok()]);const db=await oeffneGeschuetzteTestDb(url,proof,()=>m.client);
 await assert.rejects(()=>db.query('DROP DATABASE foreign'),/test_db_sql_ausserhalb/);
 assert.equal(m.calls.length,0);await db.end();
});
test('Docker-Portmapping derselben Test-Clusterkennung bleibt erlaubt',async()=>{
 const m=mock([{...ok(),port:5432}]);const db=await oeffneGeschuetzteTestDb(url,proof,()=>m.client);
 await db.query('DELETE FROM owned');assert.equal(m.calls.length,2);await db.end();
});
test('Fehlender trusted Cluster-Sollwert verbindet überhaupt nicht',async()=>{
 let connected=false;
 await assert.rejects(()=>oeffneGeschuetzteTestDb(url,{...proof,test_system_id:undefined},()=>{connected=true;throw Error('unused');}),/test_db_kennung_fehlt/);
 assert.equal(connected,false);
});
test('Abweichende PG-Umgebung verhindert Verbindung',async()=>{
 const previous=process.env.PGHOST;let connected=false;
 try{process.env.PGHOST='live.invalid';await assert.rejects(()=>oeffneGeschuetzteTestDb(url,proof,()=>{connected=true;throw Error('unused');}),/test_db_umgebung_abweichend/);assert.equal(connected,false);}
 finally{previous===undefined?delete process.env.PGHOST:process.env.PGHOST=previous;}
});
