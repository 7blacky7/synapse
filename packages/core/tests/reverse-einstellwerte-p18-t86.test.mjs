/** P18-T86: Einstellkatalog, zentraler Resolver, DB-Prüfung und Admin. Nur privates synapse_test-Schema (5433). */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',QDRANT_URL:'http://127.0.0.1:1'});
const {Pool}=createRequire(new URL('../package.json',import.meta.url))('pg');
const raw=new Pool({connectionString:url.href,max:4}),schema='p18_t86_'+process.pid+'_'+randomUUID().slice(0,8);
const pool={async connect(){const c=await raw.connect();await c.query('SET search_path TO '+schema+',public');return c;},async query(...a){const c=await this.connect();try{return await c.query(...a);}finally{c.release();}}};
const scoped=new URL(url);scoped.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=scoped.href;
const {REVERSE_EINSTELLKATALOG}=await import('../dist/services/reverse-einstellkatalog.js');
const W=await import('../dist/services/reverse-einstellwerte.js');
const {fuehreReverseAdminAus}=await import('../dist/services/reverse-einstellungen.js');
const {mitLesePool}=await import('../dist/db/client.js');
let checks=0;
const eq=(a,b,m)=>{assert.deepEqual(a,b,m);checks++;};
const ok=(x,m)=>{assert.ok(x,m);checks++;};
const reject=async(fn,m)=>{await assert.rejects(fn,undefined,m);checks++;};
const z=(ebene,name,wert,extra={})=>({ebene,name,wert,project:null,eintrag_id:null,...extra});
const P='p18-t86',R='rev-t86',R2='rev-t86-fremd';
try{
 // 1) Resolver ohne Datenbank: Standard, Ketten je Scope, Migrationsbefund, exakte Bytes.
 const leer=W.reverseEinstellSnapshot([]);
 for(const [name,d] of Object.entries(REVERSE_EINSTELLKATALOG))if(leer.werte[name].wert!==d.standard)assert.fail('Standard '+name);
 checks++;
 ok(Object.values(leer.werte).every(w=>w.quelle==='standard'),'ohne Zeilen: alles Katalogstandard');
 const s=W.reverseEinstellSnapshot([z('global','e_lauf_bytes','5000000000'),z('eintrag','e_lauf_bytes','9007199254740993',{eintrag_id:R}),
  z('projekt','e_lauf_bytes','7',{project:P}),z('projekt','antwort_bytes','4096',{project:P}),z('global','antwort_bytes','8192'),z('global','retry_max','0'),z('global','gibt_es_nicht','1')],{project:P,eintrag_id:R});
 eq([s.werte.e_lauf_bytes.wert,s.werte.e_lauf_bytes.ebene],['9007199254740993','eintrag'],'GE: Eintrag vor global, >2^53 exakt');
 eq(W.reverseBigInt(s,'e_lauf_bytes'),9007199254740993n,'BigInt ohne Rundung');
 assert.throws(()=>W.reverseZahl(s,'e_lauf_bytes'));checks++;
 eq([s.werte.antwort_bytes.wert,s.werte.antwort_bytes.ebene],['4096','projekt'],'GP: Projekt vor global');
 ok(s.migrationsbedarf.some(m=>m.name==='e_lauf_bytes'&&m.grund==='scope_nicht_mehr_zulaessig'),'Projektwert fuer GE-Schluessel: Migrationsbefund');
 ok(s.migrationsbedarf.some(m=>m.name==='gibt_es_nicht'&&m.grund==='name_nicht_mehr_im_katalog'),'entfernter Name: Migrationsbefund');
 ok(s.migrationsbedarf.some(m=>m.name==='retry_max'),'Wert ausserhalb des Katalogs: Migrationsbefund');
 eq(s.werte.retry_max.wert,REVERSE_EINSTELLKATALOG.retry_max.standard,'ungueltiger Wert faellt auf Standard');
 ok(W.reverseEinstellSnapshot([],{project:P}).revision!==W.reverseEinstellSnapshot([z('global','antwort_bytes','8192')],{project:P}).revision,'Revision folgt den Werten');
 process.env.SYNAPSE_REVERSE_MAX_BYTES='123';
 eq(W.reverseEinstellSnapshot([]).werte.e_lauf_bytes.wert,REVERSE_EINSTELLKATALOG.e_lauf_bytes.standard,'Env wirkt nicht');
 ok(JSON.stringify(W.reverseEinstellAnzeige(W.reverseEinstellSnapshot([]),process.env)).includes('123'),'Env erscheint nur als sichtbarer Vorschlag');
 delete process.env.SYNAPSE_REVERSE_MAX_BYTES;

 // 2) DB prueft denselben Vertrag.
 await raw.query('CREATE SCHEMA '+schema);
 for(const t of ['projects','agent_sessions','agent_profil_schalter','intern_schalter','tool_aktivitaet','agent_identitaeten'])await pool.query('CREATE TABLE '+t+' (LIKE public.'+t+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 for(const file of ['work-jobs-schema','reverse-schema','reverse-pipeline-schema','reverse-verknuepfungen-schema','reverse-einstellwerte-schema']){
  const sql=Object.values(await import('../dist/db/'+file+'.js')).find(x=>typeof x==='string');await pool.query(sql);await pool.query(sql);
 }
 checks++;// Schema zweimal ausfuehrbar
 for(const r of [R,R2])await pool.query("INSERT INTO reverse_eintraege(id,titel,status) VALUES($1,'T86','bestaetigt')",[r]);
 await pool.query("INSERT INTO reverse_bindungen(project,eintrag_id,gebunden_von) VALUES($1,$2,'fixture')",[P,R]);
 const ins=(ebene,name,wert,wertText=null,project=null,eintrag=null)=>pool.query("INSERT INTO reverse_einstellungen(ebene,project,eintrag_id,name,wert,wert_text,grund,gesetzt_von) VALUES($1,$2,$3,$4,$5,$6,'T86 fixture','fixture')",[ebene,project,eintrag,name,wert,wertText]);
 await ins('global','e_lauf_bytes','9007199254740993');checks++;
 await reject(()=>ins('global','retry_max','0'),'DB: unter Minimum');
 await reject(()=>ins('global','gibt_es_nicht','1'),'DB: unbekannter Name');
 await reject(()=>ins('projekt','e_lauf_bytes','5',null,P),'DB: unzulaessige Ebene');
 await reject(()=>ins('global','analyse_bis_schicht',null,'S9'),'DB: unbekannter Auswahlwert');
 await reject(()=>ins('global','analyse_bis_schicht',null,null),'DB: NULL ist kein Wert');
 await ins('global','analyse_bis_schicht',null,'S3');checks++;
 const db=await W.leseReverseEinstellwerte({project:P,eintrag_id:R},pool);
 eq([db.werte.e_lauf_bytes.wert,db.werte.analyse_bis_schicht.wert,db.letzter_fehler],['9007199254740993','S3',null],'Resolver liest PG exakt');

 // 3) Admin: Rechte, Bindung, Ebenen, Entfernen.
 const admin=(args,wer)=>mitLesePool(pool,()=>fuehreReverseAdminAus({project:P,...args},wer));
 const user={art:'user'};
 eq((await admin({modus:'setzen',ebene:'global',reverse_werte:{antwort_bytes:9000},grund:'T86 Admin global'},null)).error,'recht_fehlt','ohne Akteur kein Schreiben');
 ok((await admin({modus:'setzen',ebene:'global',reverse_werte:{antwort_bytes:9000},grund:'T86 Admin global'},user)).success,'User setzt global');
 eq((await admin({modus:'setzen',ebene:'eintrag',reverse_werte:{e_lauf_bytes:'4294967296'},grund:'T86 ohne reverse_id'},user)).error,'reverse_id_fehlt','Eintragsebene braucht reverse_id');
 eq((await admin({modus:'setzen',ebene:'eintrag',reverse_id:R2,reverse_werte:{e_lauf_bytes:'4294967296'},grund:'T86 fremder Eintrag'},user)).error,'nicht_gebunden','nur gebundener Eintrag');
 eq((await admin({modus:'setzen',ebene:'eintrag',reverse_id:R,reverse_werte:{s3_nachzug_lease_ms:60000},grund:'T86 G-Wert am Eintrag'},user)).error,'reverse_ebene_ungueltig','G-Wert nicht am Eintrag');
 ok((await admin({modus:'setzen',ebene:'eintrag',reverse_id:R,reverse_werte:{e_lauf_bytes:'4294967296'},grund:'T86 Eintragswert'},user)).success,'Eintragswert gesetzt');
 const mitEintrag=await W.leseReverseEinstellwerte({project:P,eintrag_id:R},pool);
 eq([mitEintrag.werte.e_lauf_bytes.wert,mitEintrag.werte.e_lauf_bytes.ebene,mitEintrag.werte.antwort_bytes.wert],['4294967296','eintrag','9000'],'Admin-Werte wirksam');
 ok(!(await admin({modus:'setzen',ebene:'global',reverse_werte:{retry_max:0},grund:'T86 ungueltig'},user)).success,'ungueltiger Wert abgewiesen');
 ok((await admin({modus:'entfernen',ebene:'eintrag',reverse_id:R,reverse_namen:['e_lauf_bytes'],grund:'T86 entfernen'},user)).success,'Entfernen');
 eq((await W.leseReverseEinstellwerte({project:P,eintrag_id:R},pool)).werte.e_lauf_bytes.ebene,'global','Entfernen = Vererben');
 console.log('P18-T86 Einstellwerte: '+checks+' Pruefungen gruen');
}finally{
 await raw.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>undefined);
 await raw.end();
 const {closePool}=await import('../dist/db/client.js');await closePool().catch(()=>undefined);
}
