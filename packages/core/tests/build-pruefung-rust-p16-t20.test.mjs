/** P16-T20: Rust-Basis/Plan-Befunde, Sprachabwahl und Status mit Fake-Compiler.
 * Nur eigener Schema-Bereich in synapse_test:5433, niemals Live-Projekte/Daemon.
 * Aufruf node --test packages/core/tests/build-pruefung-rust-p16-t20.test.mjs
 * Basis-Rotkontrolle: P16_CORE_DIST=/tmp/synapse-basis-f6b5a3a0/packages/core/dist derselbe Aufruf.
 * Rot am inhaltlichen Ergebnis: Signaturmutation liefert am Basisstand keinen Rust-Befund.
 */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
const target=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(target.port,'5433');assert.equal(target.pathname,'/synapse_test');
const require=createRequire(new URL('../package.json',import.meta.url)),{Pool}=require('pg');
const schema='p16_t20_'+process.pid,setup=new Pool({connectionString:target.href});
await setup.query('CREATE SCHEMA '+schema);
target.searchParams.set('options','-c search_path='+schema+',public');
process.env.DATABASE_URL=target.href;delete process.env.SYNAPSE_DATABASE_URL;
Object.assign(process.env,{BUILD_PRUEFUNG_CACHE_MS:'0',QDRANT_URL:'http://127.0.0.1:9',SYNTAX_WORKER_THREADS:'0',FEHLERPRUEFUNG_TYPEN:'0'});
delete process.env.BUILD_PRUEFUNG_SPRACHEN;
const dist=process.env.P16_CORE_DIST||resolve('packages/core/dist');
const load=p=>import(pathToFileURL(join(dist,p)).href);
const db=await load('db/client.js'),b=await load('services/build-pruefung.js');
const pool=db.getPool(),project='p16-t20-'+randomUUID(),agent='sol18-fixture';
const hash=s=>createHash('sha256').update(s).digest('hex');
const good='pub fn f(x: u32) -> u32 { x }\n',bad='pub fn f(x: &str) -> &str { x }\n';
const fixture={'Cargo.toml':'[package]\nname="pure"\nversion="0.1.0"\nedition="2021"\n',
 'Cargo.lock':'version=3\n[[package]]\nname="pure"\nversion="0.1.0"\n',
 'src/lib.rs':good,'src/caller.rs':'pub fn caller() { crate::f(1); }\n','.cargo/config.toml':''};
const calls=[];
const fake={budget:()=>({speicher_mb:1536,tmpfs_mb:512}),setzeBudget:()=>false,
 async pruefe(a){
  assert.equal(a.art,'rustcheck');calls.push(a);
  const files=new Map(a.dateien.map(d=>[d.pfad,d.inhalt]));
  assert(files.has('Cargo.lock'));assert(files.has('.cargo/config.toml'));
  const partial=files.has('build.rs');
  return {status:partial?'teilweise':'fertig',dauer_ms:1,werkzeug:'rustc/cargo fake',
   projekte:a.projekte.map(projekt=>({projekt,status:partial?'build_skript_oder_proc_macro':'fertig',ms:1,rc:partial?null:1,
    ...(partial?{grund:'build_skript_oder_proc_macro',betroffene_crates:['pure@0.1.0'],hinweis:'Cargo nicht gestartet'}:{})})),
   diagnosen:partial?[]:a.projekte.flatMap(projekt=>[
    {projekt,datei:'src/old.rs',zeile:1,spalte:1,code:'E0425',meldung:'cannot find value old',schwere:'error'},
    ...(files.get('src/lib.rs')===bad?[{projekt,datei:'src/caller.rs',zeile:1,spalte:26,code:'E0308',meldung:'mismatched types',schwere:'error'}]:[])])};
 }};
const pd=(file,basis,ergebnis)=>({file_path:file,basis,ergebnis,ops:[{op_index:0,agent_id:agent,spannen:[[1,1]]}]});
try {
 for(const table of ['code_files','build_pruefung_einstellungen'])await pool.query('CREATE TABLE '+schema+'.'+table+' (LIKE public.'+table+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 await pool.query("INSERT INTO build_pruefung_einstellungen(bereich,werte) VALUES($1,$2)",['projekt:'+project,JSON.stringify({aktiv:true,sprachen:['rust']})]);
 for(const [file,content] of Object.entries(fixture))await pool.query(
  'INSERT INTO code_files(id,project,file_path,file_name,file_type,file_size,content,content_hash,ignored) VALUES($1,$2,$3,$4,$5,$6,$7,$8,false)',
  [randomUUID(),project,file,file.split('/').at(-1),file.split('.').at(-1),Buffer.byteLength(content),content,hash(content)]);
 b.registriereBuildPruefer(fake);
 const result=await b.pruefeBuildFuerPlan(project,[pd('src/lib.rs',good,bad)],{warten:true});
 assert.equal(result?.stand.neue_fehler,1,'Signaturmutation muss neuen Befund im unveränderten Aufrufer liefern (Basis rot)');
 assert.equal(result.stand.sprache,'rust');assert.equal(result.stand.status,'fertig');
 assert.equal(result.befunde[0].datei,'src/caller.rs');assert.equal(result.befunde[0].quelle,'build');
 assert.equal(result.befunde[0].op_index,null);assert(!result.befunde.some(d=>d.datei==='src/old.rs'),'Altfehler wird abgezogen');
 const partial=await b.pruefeBuildFuerPlan(project,[pd('build.rs','','fn main(){}')],{warten:true});
 assert.equal(partial.stand.status,'teilweise');assert.equal(partial.stand.neue_fehler,0);
 assert.equal(partial.befunde.length,0);assert.match(partial.stand.hinweis,/build_skript_oder_proc_macro/);
 const before=calls.length;
 await pool.query("UPDATE build_pruefung_einstellungen SET werte=$2 WHERE bereich=$1",['projekt:'+project,JSON.stringify({aktiv:true,sprachen:[]})]);
 assert.equal(await b.pruefeBuildFuerPlan(project,[pd('src/lib.rs',good,bad)],{warten:true}),null);
 assert.equal(calls.length,before,'Abgewählte Sprache ruft keinen Compiler auf');
 await pool.query("UPDATE build_pruefung_einstellungen SET werte=$2 WHERE bereich=$1",['projekt:'+project,JSON.stringify({aktiv:true,sprachen:['rust']})]);
 await b.pruefeBuildBasis(project,1000);
 const status=await b.fuehreBuildActionAus('build_status',{project},agent);
 assert(status.success);assert(status.projekte.find(p=>p.project===project).basis_sprachen.rust,'Rust-Basis im build_status');
 assert(b.BUILD_PARAMETER.sprachen.items.enum.includes('rust'),'Rust in gemeinsamer REST/stdio-Definition');
 console.log('P16-T20 PASS: neuer Aufruferbefund, Altfehlerabzug, teilweise, Abwahl, build_status');
} finally {
 b.registriereBuildPruefer(null);await db.closePool();
 await setup.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await setup.end();
}
