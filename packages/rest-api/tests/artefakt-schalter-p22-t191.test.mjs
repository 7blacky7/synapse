/**
 * P22-T191 artefakt-katalog.ts artefaktDateiSchalter: intern-Override, Ablauf, Dauerfreigabe und PG-Ausfall.
 * Nur synapse_test:5433 in eigenem Schema, Startmodus intern EIN vor Import; Produktion AUS prueft Hauptvertrag separat.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const db=process.env.DATABASE_URL??process.env.SYNAPSE_DATABASE_URL,u=new URL(db);assert.equal(u.port,'5433');assert.equal(u.pathname,'/synapse_test');
process.env.DATABASE_URL=db;process.env.SYNAPSE_INTERN_TOOL='1';process.env.SYNAPSE_SKIP_EMBEDDINGS='1';
const C=await import('../../core/dist/index.js'),{mitLesePool}=await import('../../core/dist/db/client.js');
const basis=C.getPool(),schema='p22_t191_sw_'+randomUUID().replaceAll('-','');
const pool={async connect(){const c=await basis.connect();try{await c.query('SET search_path TO '+schema+',public');return c;}catch(e){c.release();throw e;}},async query(...a){const c=await this.connect();try{return await c.query(...a);}finally{c.release();}}};
const stand=()=>mitLesePool(pool,()=>C.artefaktDateiSchalter('artefakt_dateien','fixture'));
let n=0;const ok=(v,label,actual)=>{assert.ok(v,'P22-T191 Schalter '+label+' erwartet=erfuellt tatsaechlich='+JSON.stringify(actual));n++;console.log('OK P22-T191 Schalter '+label);};
try{
 await basis.query('CREATE SCHEMA '+schema);
 for(const t of ['agent_profil_schalter','intern_schalter'])await pool.query('CREATE TABLE '+schema+'.'+t+' (LIKE public.'+t+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 let s=await stand();ok(!s.aktiv,'Standard AUS',s);
 await pool.query("INSERT INTO intern_schalter(name,aktiv,modus,bis,grund,gesetzt_von) VALUES('artefakt_dateien',true,'freigegeben',NOW()+interval '1 hour','T191 Test','test')");
 s=await stand();ok(s.aktiv&&s.quelle==='intern'&&s.bis,'befristeter Override EIN',s);
 await pool.query("UPDATE intern_schalter SET bis=NOW()-interval '1 second'");
 s=await stand();ok(!s.aktiv&&s.quelle==='standard','Ablauf faellt auf Produktstandard zurueck',s);
 await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,'artefakt_dateien',true,'T191 Produkt','user')");
 s=await stand();ok(s.aktiv&&s.quelle==='produkt-schalter','Produktstandard EIN bleibt unabhaengig von abgelaufenem intern',s);
 await pool.query("UPDATE intern_schalter SET bis=NULL,aktiv=false");
 s=await stand();ok(!s.aktiv&&s.quelle==='intern'&&s.bis===null,'ausdruecklicher dauerhafter Override AUS',s);
 s=await mitLesePool({...pool,query:async(...args)=>{const sql=typeof args[0]==='string'?args[0]:args[0].text;if(sql.includes('intern_schalter'))throw Error('intern aus');return pool.query(...args);}},()=>C.artefaktDateiSchalter('artefakt_dateien','fixture'));ok(s.aktiv&&s.quelle==='produkt-schalter'&&s.intern_fehler,'Intern-Ausfall nutzt Produktstand und meldet Fehler',s);
 s=await mitLesePool({query:async()=>{throw Error('PG aus');}},()=>C.artefaktDateiSchalter('artefakt_dateien','fixture'));
 ok(!s.aktiv&&s.letzter_fehler,'vollstaendiger PG-Ausfall bleibt AUS mit Debug',s);
 console.log('P22-T191 Schalter '+n+' Pruefungen GRUEN.');
}catch(e){console.error('DEBUG P22-T191 Schalter erwartet=Vertraege gruen tatsaechlich='+e.stack+' schema='+schema);process.exitCode=1;}
finally{await basis.query('DROP SCHEMA '+schema+' CASCADE');await basis.end();}
process.exit(process.exitCode??0);
