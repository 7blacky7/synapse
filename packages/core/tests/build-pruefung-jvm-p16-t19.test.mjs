/**
 * P16-T19: gemeinsame Testphase, nicht während der Umsetzung ausführen.
 * node packages/core/tests/build-pruefung-jvm-p16-t19.test.mjs
 * P16_CORE_DIST=<Basis-dist> für inhaltliche Rotkontrolle: Signaturänderung muss Befund
 * im unveränderten Aufrufer ergeben; Basis t101 liefert dafür null/keinen Befund.
 * Fake-Transport, nur synapse_test, eigenes temporäres Testprojekt, kein echter Daemon.
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const target = new URL(process.env.DATABASE_URL ?? 'http://invalid');
assert.equal(target.port, '5433'); assert.equal(target.pathname, '/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
Object.assign(process.env, {QDRANT_URL:'http://127.0.0.1:9', SYNAPSE_SKIP_EMBEDDINGS:'1',
  BUILD_PRUEFUNG_CACHE_MS:'0', BUILD_PRUEFUNG:'1', BUILD_PRUEFUNG_SPRACHEN:'kotlin,java'});
const dist = process.env.P16_CORE_DIST ?? resolve('packages/core/dist');
const load = p => import(pathToFileURL(join(dist,p)).href);
const db = await load('db/client.js'), bp = await load('services/build-pruefung.js');
const schema = await load('db/build-pruefung-schema.js');
const pool = db.getPool(), project = 'test-p16-t19-' + randomUUID().slice(0,8);
const root = mkdtempSync(join(tmpdir(), 'p16-t19-'));
const sha = t => createHash('sha256').update(t).digest('hex');
const javaOld = 'class B { static int f(int x) { return x; } }\n';
const javaNew = 'class B { static int f(int x, int y) { return x+y; } }\n';
const ktOld = 'fun f(x: Int) = x\n', ktNew = 'fun f(x: Int, y: Int) = x+y\n';
const fixtures = {
 'j/pom.xml':'<project><modelVersion>4.0.0</modelVersion></project>',
 'j/A.java':'class A { int a() { return B.f(1); } }\n', 'j/B.java':javaOld,
 'k/build.gradle.kts':'plugins { kotlin("jvm") }\n',
 'k/A.kt':'fun caller() = f(1)\n', 'k/B.kt':ktOld,
};
const calls = [];
const fake = {
 async pruefe(a) {
  calls.push(a);
  const text = new Map(a.dateien.map(d=>[d.pfad,d.inhalt]));
  const diagnosen = [], projekte = [];
  for(const p of a.projekte) {
   const processor = [...text.values()].some(t=>t.includes('annotationProcessor'));
   projekte.push({projekt:p,schritt:a.art,status:processor?'abhaengigkeiten':'fertig',rc:0,ms:1,
    ...(processor?{hinweis:'Annotation-Processing ausgeschaltet; generierte Typen fehlen'}:{})});
   const changed = text.get(p+'/B.'+(a.art==='javac'?'java':'kt'))?.includes(', int y') ||
                   text.get(p+'/B.kt')?.includes(', y: Int');
   if(changed) diagnosen.push({datei:p+'/A.'+(a.art==='javac'?'java':'kt'),zeile:1,spalte:10,
    code:a.art==='javac'?'compiler.err.cant.apply.symbol':'NO_VALUE_FOR_PARAMETER',
    meldung:'signature needs second argument',projekt:p,schwere:'error'});
  }
  return {status:projekte.every(p=>p.status==='fertig')?'fertig':'teilweise',
    dauer_ms:1,projekte,diagnosen,werkzeug:a.art+' fixture'};
 },
 budget(){return {speicher_mb:1536,tmpfs_mb:384};}, setzeBudget(){return false;},
};
const pd = (path, old, content) => ({file_path:path,basis:old,ergebnis:content,
 ops:[{op_index:0,agent_id:'p16-t19-test',spannen:[[0,3]]}]});
async function seed(path, content) {
 await pool.query('INSERT INTO code_files(id,project,file_path,file_name,file_type,file_size,content,content_hash,ignored) VALUES($1,$2,$3,$4,$5,$6,$7,$8,false) ON CONFLICT(project,file_path) DO UPDATE SET content=$7,content_hash=$8,file_size=$6',
 [randomUUID(),project,path,path.split('/').at(-1),path.split('.').at(-1),Buffer.byteLength(content),content,sha(content)]);
}
async function settings(sprachen) {
 const r=await bp.fuehreBuildActionAus('build_einstellungen',{project,modus:'setzen',aktiv:true,sprachen,grund:'P16-T19 eigenes Testprojekt'},'koordinator');
 assert.equal(r.success,true,JSON.stringify(r));
}
try {
 await pool.query(schema.BUILD_PRUEFUNG_SCHEMA_SQL);
 await pool.query('INSERT INTO projects(name,hostname,path,enabled) VALUES($1,$2,$3,false)',[project,'fixture-p16-t19',root]);
 for(const [p,c] of Object.entries(fixtures))await seed(p,c);
 bp.registriereBuildPruefer(fake);
 // Erst inhaltlicher Befund, keine bloße Prüfung auf vorhandene Exports.
 for(const [lang,path,old,changed,caller] of [
  ['java','j/B.java',javaOld,javaNew,'j/A.java'],
  ['kotlin','k/B.kt',ktOld,ktNew,'k/A.kt'],
 ]) {
  const r=await bp.pruefeBuildFuerPlan(project,[pd(path,old,changed)],{warten:true});
  assert(r?.befunde?.some(b=>b.datei===caller),'Signaturänderung muss unveränderten Aufrufer treffen: '+lang);
  const d=r.befunde.find(b=>b.datei===caller);
  assert.equal(d.quelle,'build'); assert.equal(d.op_index,null); assert.deepEqual(d.beteiligt,[0]);
  assert.equal(r.stand.neue_fehler,1,JSON.stringify(r));
  await seed(path,changed);
  const unchanged=await bp.pruefeBuildFuerPlan(project,[pd(path,changed,changed+'\n')],{warten:true});
  assert.equal(unchanged.befunde.length,0,'Altdiagnose mit Zeilenverschiebung bleibt alt');
  await seed(path,old);
 }
 await settings(['kotlin','java']);
 await seed('build.gradle','subprojects { dependencies { annotationProcessor("fixture:processor:1") } }');
 const partial=await bp.pruefeBuildFuerPlan(project,[pd('j/B.java',javaOld,javaNew)],{warten:true});
 assert.equal(partial.stand.status,'teilweise'); assert.equal(partial.befunde.length,0);
 await seed('build.gradle','');
 await settings(['java']);
 const n=calls.length;
 assert.equal(await bp.pruefeBuildFuerPlan(project,[pd('k/B.kt',ktOld,ktNew)],{warten:true}),null);
 assert.equal(calls.length,n,'Sprachabwahl verhindert Compilerauftrag');
 // Positivkontrolle: eine Kotlin-Änderung im gemischten Java-Modul bleibt bei nur Java relevant.
 const helperOld='fun helper(x: Int) = x\n', helperNew='fun helper(x: Int, y: Int) = x+y\n';
 await seed('j/Helper.kt',helperOld);
 const mixedStart=calls.length;
 const mixed=await bp.pruefeBuildFuerPlan(project,[pd('j/Helper.kt',helperOld,helperNew)],{warten:true});
 assert.equal(mixed?.stand.status,'fertig',JSON.stringify(mixed));
 assert.equal(mixed.stand.sprache,'java');
 assert(calls.slice(mixedStart).some(a=>a.art==='javac' && a.projekte.includes('j') &&
   a.dateien.some(d=>d.pfad==='j/Helper.kt' && d.inhalt===helperNew)),
   'Nur Java muss Änderungen der Kotlin-Seite eines gemischten Moduls mitprüfen');
 await pool.query('DELETE FROM code_files WHERE project=$1 AND file_path=$2',[project,'j/Helper.kt']);
 // Symmetrie: nur Kotlin prüft eine Änderung im reinen Java-Modul ebenfalls nicht.
 await settings(['kotlin']);
 const kotlinOnlyStart=calls.length;
 assert.equal(await bp.pruefeBuildFuerPlan(project,[pd('j/B.java',javaOld,javaNew)],{warten:true}),null);
 assert.equal(calls.length,kotlinOnlyStart,'Keine Kotlin-Wurzel im reinen Java-Modul');
 await settings([]);
 assert.equal(await bp.pruefeBuildFuerPlan(project,[pd('j/B.java',javaOld,javaNew)],{warten:true}),null);
 await settings(['kotlin','java']);
 const status=await bp.fuehreBuildActionAus('build_status',{project,pruefen:true,warten_sekunden:5},'p16-t19-test');
 assert(status.projekte[0].basis_sprachen.java); assert(status.projekte[0].basis_sprachen.kotlin);
 const row=await pool.query("SELECT file_path FROM code_files WHERE project=$1 AND file_path LIKE '%.class'",[project]);
 assert.equal(row.rows.length,0,'Kein Classartefakt im Projektindex');
 console.log('TEST_GRUEN P16-T19 Java/Kotlin: neue Befunde, Altfehler, teilweise, Abwahl, Status, keine Klassen');
} finally {
 bp.registriereBuildPruefer(null);
 for(const t of ['agent_events','code_files'])await pool.query('DELETE FROM '+t+' WHERE project=$1',[project]).catch(()=>{});
 await pool.query('DELETE FROM build_pruefung_einstellungen WHERE bereich=$1',['projekt:'+project]).catch(()=>{});
 await pool.query('DELETE FROM projects WHERE name=$1',[project]).catch(()=>{});
 rmSync(root,{recursive:true,force:true});
 await db.closePool();
}
