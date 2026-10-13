/** T60-Prozentvertrag bleibt bei ID-Ausgabe (T63) erhalten; Jev nur Testdouble. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const url=new URL(process.env.DATABASE_URL||'http://ungueltig');assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
const schema='topf_pct_'+randomUUID().replaceAll('-','');url.searchParams.set('options','-c search_path='+schema+',public');
process.env.DATABASE_URL=url.toString();process.env.SYNAPSE_DATABASE_URL=url.toString();
const {getPool,closePool}=await import('../dist/db/client.js'),pool=getPool();
const {leseTopf}=await import('../dist/services/topf-ansicht.js');
try{
 await pool.query('CREATE SCHEMA "'+schema+'"');
 for(const table of ['jev_entscheidungstopf','erklaerungen'])await pool.query('CREATE TABLE "'+schema+'".'+table+' (LIKE public.'+table+' INCLUDING ALL)');
 const ids=Array.from({length:25},()=>randomUUID()).sort(),best=ids[24];
 await pool.query("INSERT INTO jev_entscheidungstopf(id,kategorie,antwort_wortlaut,frage_de,status,herkunft) SELECT id,'variante','Antwort','Frage','roh','tool' FROM unnest($1::uuid[])id",[ids]);
 let calls=0;
 const jev=async a=>{calls++;return{ok:true,daten:{answers:Object.fromEntries(Object.entries(a.state.eintraege).map(([key,z])=>[key,{noul:z.id===best?0.98:0.8}]))},kosten:{usd:0}};};
 await leseTopf({},'fixture','fixture',{jev});assert.equal(calls,0);
 const r=await leseTopf({frage:'Frage',vollstaendig:true},'fixture','fixture',{jev});
 assert.equal(calls,2);assert.equal(r.id,best);assert.equal(r.prozent,98);assert.equal(r.passend,true);assert.equal(r.eintrag.id,best);assert.equal('name'in r,false);
 assert.equal((await leseTopf({frage:'Frage',schwelle:99},'fixture','fixture',{jev})).passend,false);
 assert.equal((await leseTopf({frage:'Frage',schwelle:101},'fixture','fixture',{jev})).error,'schwelle');
 const invalid=await leseTopf({frage:'Frage'},'fixture','fixture',{jev:async()=>({ok:true,daten:{answers:{}},kosten:{usd:0}})});
 assert.equal(invalid.error,'jev_antwort_ungueltig');
 const blocked=await leseTopf({frage:'Frage'},'fixture','fixture',{jev:async()=>({ok:false,grund:'budget',message:'Grenze'})});assert.equal(blocked.error,'budget');
 const eid=randomUUID();await pool.query("INSERT INTO erklaerungen(id,familie,lage_de,wieso_de,abhilfe_de) VALUES($1,'test','Lage','Ursache','Abhilfe')",[eid]);
 const e=await leseTopf({topf:'erklaerung',frage:'Lage'},'fixture','fixture',{jev});assert.equal(e.id,eid);assert.equal(e.prozent,80);
 const detail=await leseTopf({topf:'erklaerung',eintrag_id:eid.slice(0,8)});assert.equal(detail.eintraege[0].id,eid);assert.equal('kennung'in detail.eintraege[0],false);
 console.log('PASS T60/T63: kein AutoJev, batchübergreifendes Maximum, IDs, Schwelle, Budget, ungültige Bewertungen, beideTöpfe');
}finally{await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');await closePool();}
