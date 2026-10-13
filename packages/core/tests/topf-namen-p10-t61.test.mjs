/** P10-T61 Teil A: explizite Namen, private Test-DB, keine Jev-Aufrufe. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const url = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(url.port, '5433'); assert.equal(url.pathname, '/synapse_test');
const schema = 't61_' + randomUUID().replaceAll('-', '');
url.searchParams.set('options', '-c search_path=' + schema + ',public');
process.env.DATABASE_URL = url.toString(); process.env.SYNAPSE_DATABASE_URL = url.toString();
const { getPool, closePool } = await import('../dist/db/client.js');
const { trageTopfNamenNach: run } = await import('../dist/services/topf-namen.js');
const pool = getPool();
try {
 await pool.query('CREATE SCHEMA "' + schema + '"');
 for (const table of ['jev_entscheidungstopf', 'erklaerungen']) await pool.query('CREATE TABLE "' + schema + '".' + table + ' (LIKE public.' + table + ' INCLUDING ALL)');
 for (const topf of ['entscheidung', 'erklaerung']) {
  const table = topf === 'entscheidung' ? 'jev_entscheidungstopf' : 'erklaerungen';
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  if (topf === 'entscheidung') await pool.query("INSERT INTO jev_entscheidungstopf(id,kennung,kategorie,antwort_wortlaut,frage_de,status,herkunft) SELECT id,name,'variante','Antwort','Frage','roh','tool' FROM unnest($1::uuid[],$2::text[])v(id,name)", [ids,[null,null,topf+'-belegt']]);
  else await pool.query("INSERT INTO erklaerungen(id,kennung,familie,schluessel,lage_de,wieso_de,abhilfe_de,status) SELECT id,name,'test','test','Lage','Ursache','Abhilfe','vorgeschlagen' FROM unnest($1::uuid[],$2::text[])v(id,name)",[ids,[null,null,topf+'-belegt']]);
  const names = async () => (await pool.query('SELECT id,kennung FROM ' + table + ' ORDER BY id')).rows;
  const before = await names();
  assert.equal((await run({topf},'sol-3')).success,false,'ohne Liste keine automatische Ableitung');
  const namen = [{id:ids[0],name:topf+'-familie-eins'},{id:ids[1],name:topf+'-familie-zwei'}];
  const preview = await run({topf,namen},'sol-3');
  assert.equal(preview.success,true);assert.equal(preview.vorschau,true);assert.equal(preview.anzahl,2);assert.deepEqual(await names(),before);
  for (const list of [
   [{id:ids[0],name:topf+'-belegt'}],
   [{id:ids[0],name:'gleich'},{id:ids[1],name:'gleich'}],
   [{id:ids[0],name:'a'},{id:ids[0],name:'b'}],
   [{id:randomUUID(),name:'unbekannt'}],
   [{id:ids[0],name:' '}],
   [{kennung:topf+'-belegt',name:'umbennen'}],
   [{id:ids[0],kennung:topf+'-belegt',name:'widerspruch'}],
   [{id:ids[0],name:'ok'},{id:ids[1],name:topf+'-belegt'}],
  ]) {
   const p=await run({topf,namen:list},'sol-3');assert.equal(p.success,false);assert.ok(p.konflikte.length);
   const w=await run({topf,namen:list,ausfuehren:true},'koordinator');assert.equal(w.success,false);assert.deepEqual(await names(),before,'Konflikt schreibt keinen Teil');
  }
  assert.equal((await run({topf,namen,ausfuehren:true},'sol-3')).error,'nur_koordinator');
  assert.equal((await run({topf,namen,ausfuehren:true},'koordinator')).geschrieben,2);
  assert.equal((await run({topf,namen,ausfuehren:true},'koordinator')).geschrieben,0,'Wiederholung idempotent');
  assert.equal((await run({topf,namen:[{kennung:topf+'-familie-eins',name:topf+'-familie-eins'}],ausfuehren:true},'koordinator')).geschrieben,0);
  assert.equal((await run({topf,namen,automatisch:true},'sol-3')).success,false,'keine gemischten Modi');
  assert.equal((await run({topf,automatisch:true},'sol-3')).anzahl,0);
 }
 const inventory=await run({bestand_pruefen:true},'sol-3');
 assert.equal(inventory.eindeutig,true);assert.equal(inventory.anzahl,6);assert.deepEqual(inventory.ohne_name,[]);
 assert.equal((await run({bestand_pruefen:true,ausfuehren:true},'koordinator')).error,'modus_konflikt');
 const e=(await pool.query("SELECT id FROM erklaerungen WHERE kennung='erklaerung-familie-eins'")).rows[0].id;
 await pool.query('UPDATE erklaerungen SET kennung=NULL WHERE id=$1',[e]);
 const cross=await run({topf:'erklaerung',namen:[{id:e,name:'entscheidung-familie-eins'}],ausfuehren:true},'koordinator');
 assert.equal(cross.success,false);assert.ok(cross.konflikte.some(k=>k.grund==='name_im_anderen_topf_belegt'));
 // Vor der Schema-Migration findet das Werkzeug auch vorhandene Dubletten.
 await pool.query("UPDATE erklaerungen SET kennung='entscheidung-familie-eins' WHERE id=$1",[e]);
 const duplicate=await run({bestand_pruefen:true},'sol-3');assert.equal(duplicate.eindeutig,false);assert.equal(duplicate.dubletten.length,1);assert.equal(duplicate.dubletten[0].eintraege.length,2);
 console.log('PASS P10-T61 beide Toepfe: explizit, Vorschau, Konflikte, Atomaritaet, Rechte, Idempotenz, Automatik nur opt-in');
} finally { await pool.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE'); await closePool(); }
