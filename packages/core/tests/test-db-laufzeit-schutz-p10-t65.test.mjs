/**
 * P10-T65, angepasst P10-T71 Teil 2 (14.10.2026, memory regel-datenbanken-nur-prod-gesperrt):
 * Der Laufzeitguard (Systemkennung, SQL-Kontrolle vor jeder Abfrage, PG*-Umgebung, Freigabe-Metadaten)
 * ist zurueckgebaut. Einziger Schutz: das Ziel ist nicht die Synapse-Produktions-DB.
 * Die frueheren Guard-Faelle pruefen jetzt 'oeffnet direkt' bzw. 'Prod abgewiesen, ohne zu verbinden'.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {oeffneGeschuetzteTestDb,oeffneGeschuetzteShellTestDb,istSynapseProdDb} from '../dist/services/test-db-laufzeit-schutz.js';
const url='postgresql://worker:synthetic@own.invalid:6544/synapse_test';
const live={host:'live.invalid',port:'5432',datenbank:'synapse',user:'worker'};
const proof={project:'p10_shell_projektdb',test_system_id:'123456789',ziele:[{host:'own.invalid',port:'6544',datenbank:'synapse_test',user:'worker',art:'test'}],live};
function mock(){
 const calls=[];let connected=false,closed=false;
 const client={connect:async()=>{connected=true;},end:async()=>{closed=true;},query:async sql=>{calls.push(sql);return {rows:[{ok:true}],rowCount:1};}};
 return {client,calls,get connected(){return connected;},get closed(){return closed;}};
}
async function ohneVerbindung(u,freigabe,muster){
 let created=false;
 await assert.rejects(()=>oeffneGeschuetzteTestDb(u,freigabe,()=>{created=true;throw Error('unused');}),muster);
 assert.equal(created,false,'Prod-Ziel darf keinen Client erzeugen');
}
test('Prod-DB per Name, bekannter Adresse oder Live-Angabe wird abgewiesen, ohne zu verbinden',async()=>{
 await ohneVerbindung('postgresql://worker:x@irgendwo.invalid:6544/synapse',undefined,/test_db_ist_produktion/);
 await ohneVerbindung('postgresql://worker:x@192.168.50.65:5432/andere_db',undefined,/test_db_ist_produktion/);
 await ohneVerbindung('postgresql://worker:x@live.invalid:5432/synapse_live',{...proof,live:{...live,datenbank:'synapse_live'}},/test_db_ist_produktion/);
});
test('Gleiches Ziel wie SYNAPSE_DATABASE_URL gilt als Prod',async()=>{
 const alt=process.env.SYNAPSE_DATABASE_URL;
 try{
  process.env.SYNAPSE_DATABASE_URL='postgresql://sys:x@sys.invalid:7000/systemdb';
  await ohneVerbindung('postgresql://worker:y@sys.invalid:7000/systemdb',undefined,/test_db_ist_produktion/);
  assert.equal(istSynapseProdDb('postgresql://worker:y@sys.invalid:7001/systemdb'),false,'anderer Port ist nicht Prod');
 }finally{alt===undefined?delete process.env.SYNAPSE_DATABASE_URL:process.env.SYNAPSE_DATABASE_URL=alt;}
});
test('P10-T71 Nachbesserung: URL ohne DB-Namen und host/port/dbname-Overrides werden als Prod erkannt',async()=>{
 // libpq nimmt ohne DB-Namen den User-Namen als DB -> leere DB gilt als Prod.
 await ohneVerbindung('postgresql://worker:x@own.invalid:6544',undefined,/test_db_ist_produktion/);
 await ohneVerbindung('postgresql://worker:x@own.invalid:6544/',undefined,/test_db_ist_produktion/);
 // ?host=/?port= ueberschreiben die Adresse aus dem Authority-Teil.
 await ohneVerbindung('postgresql://worker:x@own.invalid:6544/andere_db?host=192.168.50.65&port=5432',undefined,/test_db_ist_produktion/);
 // ?dbname= ueberschreibt den Pfad wie bei libpq.
 await ohneVerbindung('postgresql://worker:x@own.invalid:6544/synapse_test?dbname=synapse',undefined,/test_db_ist_produktion/);
 // Live-Angabe: Port+DB treffen auch ueber einen anderen Host-Namen bzw. per ?port=.
 await ohneVerbindung('postgresql://worker:x@alias.invalid/synapse_live',{...proof,live:{...live,datenbank:'synapse_live'}},/test_db_ist_produktion/);
 await ohneVerbindung('postgresql://worker:x@live.invalid:6544/synapse_live?port=5432',{...proof,live:{...live,datenbank:'synapse_live'}},/test_db_ist_produktion/);
 // Gegenfaelle bleiben frei: echte Test-/Workspace-DBs, auch mit harmlosen Optionen.
 for(const u of ['postgresql://synapse_test:x@192.168.50.65:5433/synapse_test?sslmode=disable','postgresql://worker:x@own.invalid:6544/synapse_test?host=own2.invalid&port=6545','postgres://user:x@localhost/kommunikation_test'])
  assert.equal(istSynapseProdDb(u,{}),false,u);
});
test('Leere oder unlesbare URL verbindet nicht',async()=>{
 await ohneVerbindung('',undefined,/test_db_url_fehlt/);
 await ohneVerbindung('http://own.invalid/synapse_test',undefined,/test_db_ist_produktion/);
 await ohneVerbindung('kein url',undefined,/test_db_ist_produktion/);
});
for(const [name,u] of [
 ['synapse_test (Projekt-DB-Instanz 5433)','postgresql://synapse_test:x@192.168.50.65:5433/synapse_test'],
 ['fremde Registry-unbekannte Test-DB','postgresql://worker:x@own.invalid:6544/synapse_test'],
 ['Workspace-eigener DB-Container','postgresql://postgres:x@synapse-ws-demo-db:5432/app_test'],
 ['zusaetzliche Workspace-Test-DB','postgres://user:x@localhost:5432/kommunikation_test'],
])test('Nicht-Prod oeffnet direkt ohne Freigabe-Metadaten: '+name,async()=>{
 const m=mock();
 const db=await oeffneGeschuetzteTestDb(u,undefined,()=>m.client);
 assert.equal(m.connected,true);
 await db.query('DROP SCHEMA owned CASCADE');await db.query('DELETE FROM owned');
 assert.deepEqual(m.calls,['DROP SCHEMA owned CASCADE','DELETE FROM owned'],'keine vorgeschaltete Kennungs-/SQL-Pruefung');
 await db.end();assert.equal(m.closed,true);
});
test('Frueherer Freigabe-Nachweis (Systemkennung, SQL-Kontrolle) wird nicht mehr verlangt',async()=>{
 for(const freigabe of [proof,{...proof,test_system_id:undefined},undefined]){
  const m=mock();const db=await oeffneGeschuetzteTestDb(url,freigabe,()=>m.client);
  await db.query('DROP DATABASE foreign');await db.end();
  assert.deepEqual(m.calls,['DROP DATABASE foreign']);
 }
});
test('Abweichende PG-Umgebung blockiert nicht mehr',async()=>{
 const previous=process.env.PGHOST;
 try{process.env.PGHOST='live.invalid';const m=mock();const db=await oeffneGeschuetzteTestDb(url,proof,()=>m.client);assert.equal(m.connected,true);await db.end();}
 finally{previous===undefined?delete process.env.PGHOST:process.env.PGHOST=previous;}
});
test('Verbindungsfehler wird gemeldet und der Client geschlossen',async()=>{
 let closed=false;
 const client={connect:async()=>{throw Error('ECONNREFUSED');},end:async()=>{closed=true;},query:async()=>({rows:[]})};
 await assert.rejects(()=>oeffneGeschuetzteTestDb(url,undefined,()=>client),/test_db_verbindung_fehlgeschlagen: ECONNREFUSED/);
 assert.equal(closed,true);
});
test('Shell-Variante nimmt DATABASE_URL und weist Prod ab',async()=>{
 const alt=process.env.DATABASE_URL;
 try{
  process.env.DATABASE_URL='postgresql://worker:x@192.168.50.65:5432/synapse';
  await assert.rejects(()=>oeffneGeschuetzteShellTestDb(),/test_db_ist_produktion/);
  delete process.env.DATABASE_URL;
  await assert.rejects(()=>oeffneGeschuetzteShellTestDb(),/test_db_url_fehlt/);
 }finally{alt===undefined?delete process.env.DATABASE_URL:process.env.DATABASE_URL=alt;}
});
test('Echte Verbindung zur Shell-Job-DB (synapse_test) ohne SYNAPSE_SHELL_DB_FREIGABE',{skip:!/:5433\/synapse_test(?:\?|$)/.test(process.env.DATABASE_URL??'')&&'DATABASE_URL ist nicht synapse_test'},async()=>{
 const alt=process.env.SYNAPSE_SHELL_DB_FREIGABE;delete process.env.SYNAPSE_SHELL_DB_FREIGABE;
 const db=await oeffneGeschuetzteShellTestDb();
 try{
  const schema='p10_t71_'+process.pid;
  await db.query('CREATE SCHEMA '+schema);
  try{
   await db.query('CREATE TABLE '+schema+'.probe(x int)');await db.query('INSERT INTO '+schema+'.probe VALUES (71)');
   assert.equal((await db.query('SELECT x FROM '+schema+'.probe')).rows[0].x,71);
   assert.equal((await db.query('SELECT current_database() AS db')).rows[0].db,'synapse_test');
  }finally{await db.query('DROP SCHEMA '+schema+' CASCADE');}
 }finally{await db.end();if(alt!==undefined)process.env.SYNAPSE_SHELL_DB_FREIGABE=alt;}
});
