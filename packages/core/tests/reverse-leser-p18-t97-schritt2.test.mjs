/** P18-T97: echte Registry/Paket/Validator-Pfade, nur synapse_test + eigene Fixtures. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,lstat,readdir,chmod,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const hash=x=>createHash('sha256').update(x).digest('hex');
const url=new URL(process.env.DATABASE_URL??'');
assert.equal(url.pathname,'/synapse_test','nur synapse_test');
assert.equal(url.port,'5433','nur Testport5433');
const {registriereReverseLeserEntwurf}=await import('../dist/services/reverse-leser-registry.js');
const {stelleReverseLeserPaketBereit,materialisiereReverseLeser,reverseLeserTxBudget}=await import('../dist/services/reverse-leser-materialisierung.js');
const {reverseEinstellSnapshot}=await import('../dist/services/reverse-einstellwerte.js');
const {REVERSE_LESER_SCHEMA_SQL}=await import('../dist/db/reverse-leser-schema.js');
const {pruefeLeserAusgabe}=await import('../../rest-api/dist/services/reverse-leser-executor.js');
const pool=new pg.Pool({connectionString:url.toString(),max:3});
const schema='t97_step2_'+randomUUID().replaceAll('-','');
const s=reverseEinstellSnapshot([]);
assert.equal(s.letzter_fehler,null);
async function writable(dir){
 for(const e of await readdir(dir,{withFileTypes:true})){
  const p=path.join(dir,e.name);if(e.isDirectory()){await chmod(p,0o700);await writable(p);}
 }
}
test('Nachher-Zweidateipaket, Entwurf, Hostvalidierung, Grenzen und Projektsentinels',async()=>{
 const c=await pool.connect(),heldConnect=c.connect;
 const folder=await mkdtemp(path.join(tmpdir(),'p18-t97-eigene-fixtures-'));
 let checks=0;
 const ok=(a,b)=>{assert.deepEqual(a,b);checks++;};
 try{
  await c.query('CREATE SCHEMA "'+schema+'"');
  await c.query('SET search_path TO "'+schema+'"');
  await c.query("CREATE TABLE reverse_einstellungen(ebene text,project text,eintrag_id text,name text,wert bigint,wert_text text);"+
   "CREATE TABLE reverse_dateien(id bigint,eintrag_id text,medium_id bigint DEFAULT 1,PRIMARY KEY(id,eintrag_id));"+
   "CREATE TABLE work_jobs(id uuid PRIMARY KEY);"+
   "CREATE TABLE file_versions(id bigserial PRIMARY KEY,project text,file_path text,content text,content_hash text,batch_id bigint,edit_action text);"+
   "CREATE TABLE code_files(id text,project text,file_path text,content text,content_hash text,updated_at timestamptz DEFAULT now(),deleted_at timestamptz);"+
   "CREATE TABLE asset_files(id text,payload text); CREATE TABLE code_symbols(id text,payload text);"+
   "INSERT INTO asset_files VALUES('sentinel','asset-unveraendert'); INSERT INTO code_symbols VALUES('sentinel','code-unveraendert');");
  await c.query(REVERSE_LESER_SCHEMA_SQL);
  const manifest=JSON.parse(await readFile(path.join(root,'reverse-leser/siedler3/manifest.json'),'utf8'));
  ok(manifest.version,'1.1.0');ok([...manifest.dateien].sort(),['dekodierung.py','leser.py']);
  assert.ok(manifest.ausgabetypen.includes('bild'));checks++;
  // Nur eigene Code-Fixtures in der Test-DB, keine Projektquellkopie in /tmp.
  const sourceProject='eigene_fixture_'+randomUUID(),base='fixture/leser/';
  const texts={'manifest.json':JSON.stringify(manifest),'leser.py':'# Eigene Registry-Fixture\nprint("fixture")\n',
   'dekodierung.py':'# Eigene Decoder-Fixture\nfixture = True\n'},refs={};
  for(const [p,content]of Object.entries(texts)){
   const q=await c.query("INSERT INTO file_versions(project,file_path,content,content_hash,batch_id,edit_action) VALUES($1,$2,'',$3,1,'create') RETURNING id::text",
    [sourceProject,base+p,hash('')]);
   await c.query('INSERT INTO code_files(id,project,file_path,content,content_hash) VALUES($1,$2,$3,$4,$5)',[p,sourceProject,base+p,content,hash(content)]);
   refs[p]={version_id:q.rows[0].id,sha256:hash(content),bytes:String(Buffer.byteLength(content))};
  }
  const request={project:sourceProject,stand:'nachher',manifest_pfad:base+'manifest.json',
   manifest_version_id:refs['manifest.json'].version_id,manifest_sha256:refs['manifest.json'].sha256,manifest_bytes:refs['manifest.json'].bytes,
   dateien:manifest.dateien.map(p=>({pfad:p,...refs[p]}))};
  async function fingerprint(){
   const result={};for(const table of ['file_versions','code_files','asset_files','code_symbols'])
    result[table]=(await c.query('SELECT row_to_json(t) AS v FROM "'+table+'" t ORDER BY id')).rows.map(x=>x.v);
   return result;
  }
  const before=await fingerprint();
  c.connect=()=>{throw Error('gehaltener_client_reconnect');};
  const revision=await registriereReverseLeserEntwurf(c,{quelle:request,registriert_von:'test-rea1'});
  ok(revision.status,'entwurf');ok(revision.quelle.stand,'nachher');ok(revision.quelle.dateien.length,2);
  ok((await registriereReverseLeserEntwurf(c,{quelle:request,registriert_von:'test-rea1'})).id,revision.id);
  await assert.rejects(registriereReverseLeserEntwurf(c,{quelle:{...request,dateien:request.dateien.slice(0,1)},registriert_von:'test-rea1'}),/leser_quelle_unvollstaendig/);checks++;
  const changed=structuredClone(request);changed.dateien[0].sha256='0'.repeat(64);
  await assert.rejects(registriereReverseLeserEntwurf(c,{quelle:changed,registriert_von:'test-rea1'}),/nachher_geaendert/);checks++;
  const small={...s,werte:{...s.werte,e_uebernahme_block_zeilen:{...s.werte.e_uebernahme_block_zeilen,wert:'1'}}};
  assert.throws(()=>reverseLeserTxBudget(small,2,['a']),/tx_zu_gross/);checks++;
  const share=path.join(folder,'reverse-fixture');await mkdir(share);
  const previous=process.umask(0o077);let packageRef;
  try{packageRef=await stelleReverseLeserPaketBereit(c,revision,s,share);}finally{process.umask(previous);}
  const pkg=path.join(share,packageRef.storage_key);
  ok((await lstat(pkg)).mode&0o7777,0o555);
  for(const p of manifest.dateien){ok((await lstat(path.join(pkg,p))).mode&0o7777,0o444);ok(hash(await readFile(path.join(pkg,p))),refs[p].sha256);}
  ok(await stelleReverseLeserPaketBereit(c,revision,s,share),packageRef);
  await chmod(pkg,0o755);
  await assert.rejects(stelleReverseLeserPaketBereit(c,revision,s,share),/leser_paket_/);checks++;
  await chmod(pkg,0o555);
  const rid='rev-eigene-fixture',lauf=randomUUID();
  await c.query('INSERT INTO reverse_dateien(id,eintrag_id) VALUES(1,$1)',[rid]);
  await c.query("INSERT INTO reverse_leser_laeufe(id,leser_id,eintrag_id,datei_id,quell_sha256,generation,einstellungen_revision,diagnose) VALUES($1,$2,$3,1,$4,$5,$6,$7)",
   [lauf,revision.id,rid,'1'.repeat(64),randomUUID(),s.revision,{testmodus:true,host_validiert:true}]);
  await assert.rejects(materialisiereReverseLeser(c,{lauf_id:lauf,root:share,fence:async()=>{throw Error('test_darf_nicht_schreiben');}}),/nicht_freigegeben/);checks++;
  ok((await c.query('SELECT status FROM reverse_leser_zustaende')).rows,[{status:'entwurf'}]);
  ok((await c.query('SELECT count(*)::int AS n FROM work_jobs')).rows[0].n,0);
  // Echte externe Pakete auf eigenen Bytes, dann echter unabhängiger Hostvalidator.
  for(const reader of ['siedler3','pak']){
   const py=[
    'import sys,json,base64',
    'sys.path.insert(0,sys.argv[1])',
    'from test_regression import Regression,graphics,pak',
    "data=graphics() if sys.argv[2]=='siedler3' else pak([('a/b',b'abc'),('leer',b'')])",
    'end,rows,cursor,files=Regression().invoke(sys.argv[2],data)',
    "print(json.dumps({'end':end,'rows':rows,'cursor':cursor,'size':str(len(data)),'files':{k:base64.b64encode(v).decode() for k,v in files.items()}}))"
   ].join('\n');
   const fixture=JSON.parse(execFileSync('python3',['-I','-B','-c',py,path.join(root,'reverse-leser/tests'),reader],{encoding:'utf8',maxBuffer:4194304}));
   const out=path.join(folder,'out-'+reader);await mkdir(out);
   for(const [p,data]of Object.entries(fixture.files))await writeFile(path.join(out,p),Buffer.from(data,'base64'));
   const segment=Buffer.from(fixture.files['segment-0001.jsonl'],'base64');
   const protocol=Buffer.from(JSON.stringify({art:'schritt',cursor:fixture.cursor,segment:{pfad:'segment-0001.jsonl',sha256:hash(segment),bytes:String(segment.length),zeilen:String(fixture.rows.length)}})+'\n'+JSON.stringify(fixture.end)+'\n');
   await writeFile(path.join(out,'.leser-protokoll.jsonl'),protocol);
   const answer={status:'fertig',leser_exit:0,leser_protokoll:{pfad:'.leser-protokoll.jsonl',sha256:hash(protocol),bytes:String(protocol.length),zeilen:'2'}};
   const m=reader==='siedler3'?manifest:JSON.parse(await readFile(path.join(root,'reverse-leser/pak/manifest.json'),'utf8'));
   const valid=await pruefeLeserAusgabe(out,s,m,fixture.size,answer);
   ok(valid.status,'fertig');ok(valid.objekte,String(fixture.rows.length));
   const artifact=fixture.rows.find(r=>r.datei)?.datei;
   const original=await readFile(path.join(out,artifact.pfad));
   await writeFile(path.join(out,artifact.pfad),Buffer.from('manipuliert'));
   await assert.rejects(pruefeLeserAusgabe(out,s,m,fixture.size,answer),/leser_artefakt_/);checks++;
   await writeFile(path.join(out,artifact.pfad),original);
   const one={...s,werte:{...s.werte,e_schritt_dateien:{...s.werte.e_schritt_dateien,wert:'1'}}};
   await assert.rejects(pruefeLeserAusgabe(out,one,m,fixture.size,answer),/leser_/);checks++;
   await assert.rejects(pruefeLeserAusgabe(out,s,m,fixture.size,{...answer,leser_exit:1}),/nicht_erfolgreich/);checks++;
  }
  ok(await fingerprint(),before);
  console.log('P18-T97 Schritt2 PASS '+checks+' Integrationspruefungen, Quellen/Projektsentinels unveraendert');
 }finally{
  c.connect=heldConnect;
  await c.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
  c.release();await pool.end();
  await chmod(folder,0o700);await writable(folder);await rm(folder,{recursive:true,force:true});
 }
});
