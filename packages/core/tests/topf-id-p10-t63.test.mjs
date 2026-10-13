/** P10-T63: nur IDs, kein Jev-Netzaufruf; privater Bereich der Test-DB. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
const fixtureDir=await mkdtemp(new URL('./t63-fixture-',import.meta.url));
const url=new URL(process.env.DATABASE_URL||'http://ungueltig');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
const schema='t63_'+randomUUID().replaceAll('-','');
url.searchParams.set('options','-c search_path='+schema+',public');
Object.assign(process.env,{DATABASE_URL:url.toString(),SYNAPSE_DATABASE_URL:url.toString(),JEV_OPENROUTER_API_KEY:'',OLLAMA_URL:'http://127.0.0.1:9',QDRANT_URL:'http://127.0.0.1:9'});
const {getPool,closePool}=await import('../dist/db/client.js'),pool=getPool();
try {
 await pool.query('CREATE SCHEMA "'+schema+'"');
 for(const {tablename}of(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows){
  const q='"'+tablename.replaceAll('"','""')+'"';await pool.query('CREATE TABLE "'+schema+'".'+q+' (LIKE public.'+q+' INCLUDING ALL)');
 }
 const D=await import('../dist/services/entscheidungstopf.js');
 const created=await D.schreibeTopfEintrag({frage_de:'Namenslose Entscheidung',antwort_wortlaut:'Antwort',kategorie:'variante'},{herkunft:'tool',erfasst_von:'fixture'});
 assert.equal(created.success,true,'RED: Entscheidung ohne Namen speichern');assert.ok(created.id);assert.equal('name'in created,false);
 assert.equal((await pool.query('SELECT kennung FROM jev_entscheidungstopf WHERE id=$1',[created.id])).rows[0].kennung,null);
 const ids=['abcdef00-1111-4111-8111-111111111111','abcdef00-2222-4222-8222-222222222222'];
 await pool.query("INSERT INTO jev_entscheidungstopf(id,kennung,kategorie,antwort_wortlaut,frage_de,status,herkunft) SELECT id,name,'variante','Volltext','Kurze Frage','roh','tool' FROM unnest($1::uuid[],$2::text[])v(id,name)",[ids,['alt-eins','alt-zwei']]);
 const list=await D.listeEntscheidungstopf();assert.equal(list.anzahl,3);assert.ok(list.eintraege.every(e=>e.id&&e.vorschau));assert.equal(JSON.stringify(list).includes('alt-eins'),false);
 for(const id of [created.id,created.id.slice(0,8),created.id.toUpperCase()]){
  const detail=await D.listeEntscheidungstopf({eintrag_id:id});assert.equal(detail.eintraege[0].id,created.id);assert.equal('kennung'in detail.eintraege[0],false);
 }
 const ambiguous=await D.listeEntscheidungstopf({eintrag_id:'abcdef00'});assert.equal(ambiguous.error,'mehrdeutig');assert.equal(ambiguous.kandidaten.length,2);
 for(const id of ['abc','alt-eins','%%%%%%%%',randomUUID()])assert.equal((await D.listeEntscheidungstopf({eintrag_id:id})).success,false);
 assert.equal((await D.bereiteEntscheidungAuf({eintrag_id:'abcdef00',status:'stillgelegt'},'koordinator')).error,'mehrdeutig');
 const mirror=await D.spiegeleThoughtInTopf('fixture',{id:randomUUID(),content:'Eine Entscheidung',tags:['entscheidung','user']});assert.equal(mirror.angelegt,true);
 const J=await import('../dist/services/jev-entscheidung.js');
 assert.equal(J.JEV_TOPF_ACTIONS.includes('topf_namen_nachtragen'),false);
 for(const key of ['name','namen','automatisch','bestand_pruefen'])assert.equal(key in J.JEV_TOPF_PARAMETER,false);
 const correction=(await pool.query("INSERT INTO jev_entscheidungen(project,frage,typ,entschieden,kategorie) VALUES('fixture','Frage','choice',true,'variante') RETURNING id")).rows[0].id;
 assert.equal((await J.durchsichtEntscheidung('fixture',{agent_id:'koordinator',id:correction,urteil:'korrigieren',wahl:'a'})).success,true);
 const E=await import('../dist/services/erklaerungen.js');
 for(const key of ['name','kennung'])assert.equal(key in E.ERKLAERUNG_PARAMETER,false);
 assert.equal((await E.legeErklaerungAb({fall_id:'999999',agent:'fixture',texte:{}})).error,'nicht_gefunden');
 const fall=(await pool.query("INSERT INTO erklaerung_faelle(project,agent_id,datei,familie,schluessel,befund,bezug,schatten) VALUES('t63-fixture','fixture','nicht-vorhanden.ts','typescript','syntax|typescript|fixture','{}','{}','{}') RETURNING id")).rows[0].id;
 const texte={lage_de:'Eine schliessende runde Klammer fehlt in einem Ausdruck.',wieso_de:'Eine Aenderung hat eine oeffnende Klammer eingefuegt, ohne sie zu schliessen; der Parser erwartet das Gegenstueck.',abhilfe_de:'Die Klammerpaare der geaenderten Stelle zaehlen und die fehlende Klammer ergaenzen.',lage_en:'A closing parenthesis is missing in an expression.',wieso_en:'A change opened a parenthesis without closing it; the parser expects the matching one.',abhilfe_en:'Count the bracket pairs at the changed place and add the missing closing parenthesis.'};
 const explanation=await E.legeErklaerungAb({fall_id:String(fall),agent:'fixture',texte});
 assert.equal(explanation.success,true,JSON.stringify(explanation));assert.ok(explanation.erklaerung.id);assert.equal('kennung'in explanation.erklaerung,false);
 assert.equal((await pool.query('SELECT kennung FROM erklaerungen WHERE id=$1',[explanation.erklaerung.id])).rows[0].kennung,null);
 // Namenslose Seed-Dateien und Altbestand mit anderer UUID: Inhalt bleibt einmalig.
 for(const [seed,pfad,table] of [[D.ladeEntscheidungstopfSeed,D.seedDateiPfad(),'jev_entscheidungstopf'],[E.ladeErklaerungstopfSeed,E.erklaerungstopfSeedPfad(),'erklaerungen']]){
  const data=JSON.parse(await readFile(pfad,'utf8'));for(const e of data.eintraege){delete e.id;delete e.kennung;delete e.name;}
  const datei=fixtureDir+'/'+table+'.json';await writeFile(datei,JSON.stringify(data));
  const first=await seed({datei});assert.equal(first.success,true,JSON.stringify(first));assert.ok(first.neu>0);
  const column=table==='erklaerungen'?'erstellt_von':'erfasst_von';
  const legacy=randomUUID();await pool.query('UPDATE '+table+' SET id=$1 WHERE id=(SELECT id FROM '+table+" WHERE "+column+"='seed' LIMIT 1)",[legacy]);
  const next=await seed({datei});assert.equal(next.success,true);assert.equal(next.neu,0,'Altbestand auch ohne Inhalts-ID wiedererkannt');
 }
 // Beide unveränderten Seed-Dateien funktionieren weiter, vorhandener Inhalt wird nicht dupliziert.
 for(const seed of [D.ladeEntscheidungstopfSeed,E.ladeErklaerungstopfSeed]){
  const first=await seed();assert.equal(first.success,true,JSON.stringify(first));
  const next=await seed();assert.equal(next.success,true);assert.equal(next.neu,0);
 }
 assert.deepEqual((await pool.query('SELECT kennung FROM jev_entscheidungstopf WHERE id=ANY($1::uuid[]) ORDER BY kennung',[ids])).rows.map(r=>r.kennung),['alt-eins','alt-zwei']);
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM jev_entscheidungstopf WHERE kennung IS NOT NULL")).rows[0].n,2);
 console.log('PASS P10-T63 Creator, UUID/Präfix/Kollision, Korrektur, Erklärung, Seeds, Altwerte unverändert');
}finally{await rm(fixtureDir,{recursive:true,force:true});await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');await closePool();}
