/** P10-T61: echtes PostgreSQL, private Schemas in synapse_test; DB-Rennen und vollständiges ensureSchema. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const url=new URL(process.env.DATABASE_URL||'http://ungueltig');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
const schema='t61_db_'+randomUUID().replaceAll('-','');
url.searchParams.set('options','-c search_path='+schema+',public -c statement_timeout=60000 -c lock_timeout=5000');
process.env.DATABASE_URL=url.toString();process.env.SYNAPSE_DATABASE_URL=url.toString();
const {getPool,closePool}=await import('../dist/db/client.js'),pool=getPool();
const {TOPF_NAMEN_ANWEISUNGEN:statements}=await import('../dist/db/topf-namen-schema.js');
const {ensureSchema}=await import('../dist/db/schema.js');
const decision="INSERT INTO jev_entscheidungstopf(id,kennung,kategorie,antwort_wortlaut,frage_de,status,herkunft) VALUES($1,$2,'variante','Antwort','Frage','roh','tool')";
const explanation="INSERT INTO erklaerungen(id,kennung,familie,schluessel,lage_de,wieso_de,abhilfe_de,status) VALUES($1,$2,'test','test','Lage','Ursache','Abhilfe','vorgeschlagen')";
const duplicates=e=>e.code==='23505';
let a,b;
try {
 await pool.query('CREATE SCHEMA "'+schema+'"');
 for(const table of ['jev_entscheidungstopf','erklaerungen'])await pool.query('CREATE TABLE "'+schema+'".'+table+' (LIKE public.'+table+' INCLUDING ALL)');
 // Positivkontrolle: alte Einzel-UNIQUEs lassen denselben Namen über beide Töpfe zu.
 const oldA=randomUUID(),oldB=randomUUID();
 await pool.query(decision,[oldA,'alt-doppelt']);await pool.query(explanation,[oldB,'alt-doppelt']);
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await assert.rejects(async()=>{for(const sql of statements)await client.query(sql);},duplicates);
  await client.query('ROLLBACK');
  assert.equal((await client.query('SELECT to_regclass($1) AS r',[schema+'.topf_namen'])).rows[0].r,null,'fehlgeschlagene Migration komplett zurückgerollt');
 }finally{client.release();}
 await pool.query('UPDATE erklaerungen SET kennung=$1 WHERE id=$2',['alt-eindeutig',oldB]);
 await pool.query("INSERT INTO jev_entscheidungstopf(kennung,kategorie,antwort_wortlaut,frage_de,status,herkunft) SELECT 'fixture-'||n,'variante','Antwort','Frage','roh','tool' FROM generate_series(1,100)n");
 const timings=[];
 for(let pass=1;pass<=2;pass++){
  const c=await pool.connect();const ms=[];
  try{await c.query('BEGIN');for(const [i,sql]of statements.entries()){const start=performance.now();await c.query(sql);ms.push({anweisung:i+1,ms:+(performance.now()-start).toFixed(3)});}await c.query('COMMIT');}
  catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  timings.push({pass,ms});
 }
 assert.equal(Number((await pool.query('SELECT count(*) FROM topf_namen')).rows[0].count),102);
 // Direkte SQL-Wege, Umbenennung, NULL, Löschen und Eigentümerwechsel.
 await assert.rejects(()=>pool.query(explanation,[randomUUID(),'fixture-1']),duplicates);
 await assert.rejects(()=>pool.query('UPDATE erklaerungen SET kennung=$1 WHERE id=$2',['fixture-1',oldB]),duplicates);
 assert.equal((await pool.query('SELECT kennung FROM erklaerungen WHERE id=$1',[oldB])).rows[0].kennung,'alt-eindeutig');
 await pool.query('UPDATE erklaerungen SET kennung=NULL WHERE id=$1',[oldB]);
 const freed=randomUUID();await pool.query(decision,[freed,'alt-eindeutig']);
 await pool.query('DELETE FROM jev_entscheidungstopf WHERE id=$1',[freed]);
 await pool.query('UPDATE erklaerungen SET kennung=$1 WHERE id=$2',['alt-eindeutig',oldB]);
 const moved=randomUUID();await pool.query('UPDATE erklaerungen SET id=$1 WHERE id=$2',[moved,oldB]);
 assert.equal((await pool.query("SELECT eintrag_id FROM topf_namen WHERE name='alt-eindeutig'")).rows[0].eintrag_id,moved);
 // Zwei echte Verbindungen: zweiter Schreiber blockiert bis COMMIT/ROLLBACK, PK entscheidet.
 a=await pool.connect();b=await pool.connect();
 for(const commit of [true,false]){
  const name='parallel-'+commit;
  await a.query('BEGIN');await a.query(decision,[randomUUID(),name]);
  let settled=false;
  const second=b.query(explanation,[randomUUID(),name]).then(()=>({ok:true}),e=>({ok:false,code:e.code})).finally(()=>{settled=true;});
  await new Promise(r=>setTimeout(r,100));assert.equal(settled,false,'zweiter Schreiber wartet wirklich');
  await a.query(commit?'COMMIT':'ROLLBACK');
  const result=await second;assert.equal(result.ok,!commit);if(commit)assert.equal(result.code,'23505');
 }
 a.release();a=null;b.release();b=null;
 const {schreibeTopfEintrag,spiegeleThoughtInTopf}=await import('../dist/services/entscheidungstopf.js');
 await assert.rejects(()=>schreibeTopfEintrag({name:'alt-eindeutig',frage_de:'Frage',antwort_wortlaut:'Antwort',kategorie:'variante'},{herkunft:'tool',erfasst_von:'fixture'}),duplicates);
 assert.equal((await spiegeleThoughtInTopf('fixture',{id:randomUUID(),name:'alt-eindeutig',content:'Entscheidung',tags:['entscheidung','user']})).angelegt,false);
 console.log('STATEMENT_TIMINGS '+JSON.stringify(timings));
 // Vollständiger unveränderter Schema-Körper, zweimal; Sperren nur auf unserem Schema.
 for(let pass=1;pass<=2;pass++){
  const result=await ensureSchema({sperrSchema:schema,versuche:1,statementTimeoutMs:60000});
  assert.equal(result.probe,false);console.log('FULL_ENSURE_SCHEMA '+JSON.stringify({pass,...result}));
 }
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM topf_namen')).rows[0].n,104);
 // SQL-Spiegel separat auf leerem Schema aufbauen und dieselbe Garantie prüfen.
 const mirror=await pool.connect();
 try {
  await mirror.query('BEGIN');
  await mirror.query('CREATE SCHEMA "'+schema+'_mirror"');
  await mirror.query('SET LOCAL search_path TO "'+schema+'_mirror", public');
  await mirror.query(await (await import('node:fs/promises')).readFile(new URL('../src/db/schema-sql/48_topf_namen.sql',import.meta.url),'utf8'));
  await mirror.query(decision,[randomUUID(),'mirror-gleich']);
  await assert.rejects(()=>mirror.query(explanation,[randomUUID(),'mirror-gleich']),duplicates);
 }finally{await mirror.query('ROLLBACK');mirror.release();}
 console.log('PASS SQL-Spiegel: leerer Aufbau und globale Namensgarantie');
 console.log('PASS P10-T61 DB: Alt-Dublette/Abbruch, Register, direkte Schreiber, Rollback, Rennen, Creator, zweimal ensureSchema');
}finally{
 if(a){await a.query('ROLLBACK').catch(()=>{});a.release();}if(b){await b.query('ROLLBACK').catch(()=>{});b.release();}
 await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');await closePool();
}
