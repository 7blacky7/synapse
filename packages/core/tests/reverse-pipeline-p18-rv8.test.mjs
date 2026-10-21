/** RV8/W3: synthetic binaries, real worker + PG, own mkdtemp root and p18_rv8 schema. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const dsn=new URL(process.env.DATABASE_URL||'http://invalid');assert.equal(dsn.port,'5433');assert.equal(dsn.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
process.env.SYNAPSE_SKIP_EMBEDDINGS='1';process.env.QDRANT_URL='http://127.0.0.1:1';
process.env.SYNAPSE_REVERSE_PARALLEL='1';process.env.SYNAPSE_REVERSE_RETRY_MAX='2';
// P18-T61/E4: Standard-Obergrenze ist S1; dieser Test prüft die S2/S3-Folge und hebt sie ausdrücklich an.
process.env.SYNAPSE_REVERSE_BIS_SCHICHT='S3';
process.env.SYNAPSE_REVERSE_CONTAINER_PROFIL='fixture-reverse';process.env.SYNAPSE_REVERSE_WERKZEUG_VERSION='fixture-1';
process.env.SYNAPSE_REVERSE_RESOURCE_NEED='{"cpu":1,"ram":64,"vram":0,"gpu":false}';
const core=await import('../dist/index.js');
const {REVERSE_SCHEMA_SQL}=await import('../dist/db/reverse-schema.js');
const {WORK_JOBS_SCHEMA_SQL}=await import('../dist/db/work-jobs-schema.js');
const {mitLesePool}=await import('../dist/db/client.js');
const require=createRequire(new URL('../package.json',import.meta.url)),{Pool}=require('pg');
const raw=new Pool({connectionString:process.env.DATABASE_URL}),schema='p18_rv8_'+process.pid,project='p18_rv8';
const pool={async connect(){const db=await raw.connect();try{await db.query('SET search_path TO '+schema+',public');return db;}catch(e){db.release();throw e;}},
 async query(...args){const db=await this.connect();try{return await db.query(...args);}finally{db.release();}}};
const root=await mkdtemp(join(tmpdir(),'synapse-p18-rv8-'));
const cfg=core.ladeAssetKonfiguration({SYNAPSE_ASSET_ENABLED:'0',SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:root});
cfg.sync.retryIntervallMs=1;cfg.inspektion.timeoutMs=10000;cfg.inspektion.maxReadBytes=1048576;cfg.inspektion.maxHashBytes=1048576;
cfg.inspektion.maxObjects=1000;
const sha=b=>createHash('sha256').update(b).digest('hex'),secret='SyntheticSecret987654321';
let fileId=0,mediumId=0,workers=0;
const services=[];
const original=core.AssetInspektionsWorker.prototype.inspiziereQuelle;
core.AssetInspektionsWorker.prototype.inspiziereQuelle=async function(...args){workers++;return original.apply(this,args);};
function pe(net=false){
 const b=Buffer.alloc(2048);b.write('MZ');b.writeUInt32LE(128,60);b.write('PE\0\0',128);
 b.writeUInt16LE(0x14c,132);b.writeUInt16LE(1,134);b.writeUInt16LE(224,148);b.writeUInt16LE(0x102,150);
 const o=152;b.writeUInt16LE(0x10b,o);b.writeUInt32LE(512,o+4);b.writeUInt32LE(0x1000,o+16);b.writeUInt32LE(0x1000,o+20);
 b.writeUInt32LE(0x400000,o+28);b.writeUInt32LE(4096,o+32);b.writeUInt32LE(512,o+36);b.writeUInt32LE(8192,o+56);b.writeUInt32LE(512,o+60);
 b.writeUInt16LE(3,o+68);b.writeUInt32LE(16,o+92);
 const s=376;b.write('.text',s);b.writeUInt32LE(1536,s+8);b.writeUInt32LE(4096,s+12);b.writeUInt32LE(1536,s+16);b.writeUInt32LE(512,s+20);b.writeUInt32LE(0x60000020,s+36);
 b[512]=0xc3;b.write('password = "'+secret+'";',1100);
 if(net){b.writeUInt32LE(0x1020,o+96+14*8);b.writeUInt32LE(72,o+100+14*8);b.writeUInt32LE(72,544);b.writeUInt16LE(2,548);b.writeUInt16LE(5,550);b.writeUInt32LE(0x1080,552);b.writeUInt32LE(64,556);b.writeUInt32LE(1,560);b.write('BSJB',640);b.writeUInt32LE(12,652);b.write('v4.0.30319\0',656);}
 return b;
}
function crc(bytes){let n=0xffffffff;for(const b of bytes){n^=b;for(let k=0;k<8;k++)n=(n>>>1)^((n&1)?0xedb88320:0);}return (n^0xffffffff)>>>0;}
function jar(){
 const entries=[['META-INF/MANIFEST.MF',Buffer.from('Manifest-Version: 1.0\n')],['Hello.class',Buffer.from([0xca,0xfe,0xba,0xbe,0,0,0,61])]];
 const local=[],central=[];let off=0;
 for(const [name,data] of entries){const n=Buffer.from(name),h=Buffer.alloc(30),c=Buffer.alloc(46),checksum=crc(data);
  h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt32LE(checksum,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(n.length,26);
  c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt32LE(checksum,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(off,42);
  local.push(h,n,data);central.push(c,n);off+=h.length+n.length+data.length;
 }
 const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(2,8);end.writeUInt16LE(2,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(off,16);
 return Buffer.concat([...local,cd,end]);
}
async function add(rid,path,bytes,{write=true,policy=true}={}){
 if(!(await pool.query('SELECT 1 FROM reverse_eintraege WHERE id=$1',[rid])).rowCount){
  await pool.query("INSERT INTO reverse_eintraege(id,titel,status,analyse_policy) VALUES($1,'Synthetic fixture','bestaetigt',$2::jsonb)",[rid,JSON.stringify({automatisch:policy,bis_schicht:'S3'})]);
  mediumId++;await pool.query("INSERT INTO reverse_medien(id,eintrag_id,position,art,status,satz_sha256) VALUES($1,$2,0,'ordner','vollstaendig',$3)",[mediumId,rid,sha(Buffer.from(rid))]);
 }
 const mid=(await pool.query('SELECT id FROM reverse_medien WHERE eintrag_id=$1',[rid])).rows[0].id;
 const id=++fileId,key=rid+'/binaries/'+path;
 if(write){await mkdir(join(root,rid,'binaries'),{recursive:true});await writeFile(join(root,rid,'binaries',path),bytes);}
 await pool.query("INSERT INTO reverse_dateien(id,eintrag_id,medium_id,pfad,sha256,groesse,art,storage_key) VALUES($1,$2,$3,$4,$5,$6,'binaer',$7)",[id,rid,mid,path,sha(bytes),bytes.length,key]);
 return id;
}
async function requested(service,rid,id,priority='interaktiv',target='S3'){
 const db=await pool.connect();try{await db.query('BEGIN');const r=await service.analysieren({reverseId:rid,project,agentId:'p18_rv8-agent',dateiId:String(id),mediumId:null,bisSchicht:target,prioritaet:priority},db);await db.query('COMMIT');return r;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
try{
 await pool.query('CREATE SCHEMA '+schema);assert.equal((await pool.query('SELECT current_database() AS d')).rows[0].d,'synapse_test');
 await pool.query(WORK_JOBS_SCHEMA_SQL);await pool.query(REVERSE_SCHEMA_SQL);
 // P18-T84: current schema for origin filters; no production migration from this fixture.
 await pool.query((await import('../dist/db/hex-formate-schema.js')).HEX_FORMATE_SCHEMA_SQL);
 await pool.query((await import('../dist/db/reverse-erkenntnisse-schema.js')).REVERSE_ERKENNTNISSE_SCHEMA_SQL);
 await pool.query('BEGIN');await pool.query(core.REVERSE_PIPELINE_SCHEMA_SQL);await pool.query('ROLLBACK');
 assert.equal((await pool.query("SELECT to_regclass($1) AS x",[schema+'.reverse_analyse_cache'])).rows[0].x,null,'schema probe rollback');
 await pool.query(core.REVERSE_PIPELINE_SCHEMA_SQL);await pool.query(core.REVERSE_PIPELINE_SCHEMA_SQL);
 // Current runtime inserts identity attribution (migration 112), also in private test fixtures.
 // Only the Reverse columns from migration 112; never migrate unrelated public test tables.
 for(const [t,c]of [['reverse_eintraege','creator_identity_id'],['reverse_eintraege','confirmer_identity_id'],['reverse_bindungen','binder_identity_id'],['reverse_auftraege','trigger_identity_id']])await pool.query('ALTER TABLE '+t+' ADD COLUMN IF NOT EXISTS '+c+' TEXT');
 await pool.query('CREATE TABLE agent_profil_schalter (LIKE public.agent_profil_schalter INCLUDING DEFAULTS INCLUDING INDEXES)');
 const elfPath=join(root,'elf-fixture');
 execFileSync('gcc',['-x','c','-o',elfPath,'-'],{input:'const char *fixture = "password = \\"'+secret+'\\""; int main(void){return fixture[0] == 0;}',stdio:['pipe','pipe','pipe']});
 const elf=await readFile(elfPath);
 const rid='rev-fixture-000001',rid2='rev-fixture-000002';
 const ids={elf:await add(rid,'hello',elf),duplicate:await add(rid2,'hello',elf),pe:await add(rid,'native.exe',pe()),dotnet:await add(rid,'managed.dll',pe(true)),
  jar:await add(rid,'hello.jar',jar()),wasm:await add(rid,'hello.wasm',Buffer.from([0,97,115,109,1,0,0,0])),unknown:await add(rid,'unknown.bin',Buffer.from('unknown\0password = "'+secret+'";'))};
 // P18-T64: ohne angemeldeten Ausführer würden Container-Kinds als kein_ausfuehrer enden; RV8 prüft Dedup/Reihenfolge mit simuliertem Ausführer.
 const service=new core.ReversePipelineDienst({pool,konfiguration:cfg,ausfuehrbareKinds:['reverse-E','reverse-S1','reverse-S2','reverse-S3']});services.push(service);
 const durchlauf=()=>mitLesePool(pool,()=>service.durchlauf());
 for(let i=0;i<30;i++)await durchlauf();
 const rows=(await pool.query('SELECT id::int,format,arch,bits,metadaten FROM reverse_dateien ORDER BY id')).rows;
 const row=id=>rows.find(r=>r.id===id);
 assert.equal(row(ids.elf).format,'elf');assert.match(row(ids.elf).arch,/x86|AMD64|x64/i);assert.equal(row(ids.elf).bits,64);
 assert.equal(row(ids.pe).format,'pe');assert.equal(row(ids.pe).bits,32);assert(row(ids.dotnet).metadaten.merkmale.includes('dotnet'));
 assert.equal(row(ids.jar).format,'jar');assert.equal(row(ids.wasm).format,'wasm');
 assert(row(ids.unknown).metadaten.magic_hex);assert(Number.isFinite(row(ids.unknown).metadaten.entropie));
 assert.equal(row(ids.duplicate).format,'elf');
 const cache=(await pool.query("SELECT count(*)::int AS n FROM reverse_analyse_cache WHERE schicht IN ('S0','S1') AND werkzeug='asset-inspektoren' AND status IN ('fertig','teilweise')")).rows[0].n;
 assert.equal(workers,cache,'each fingerprint runs the real inspector once, duplicate entry reuses it');
 assert.equal(cache,12,'six unique blobs times S0+S1');
 const texts=(await pool.query("SELECT ergebnis::text AS s FROM reverse_analyse_cache WHERE ergebnis IS NOT NULL UNION ALL SELECT metadaten::text FROM reverse_dateien UNION ALL SELECT content FROM reverse_code_dateien UNION ALL SELECT data::text FROM reverse_objekte UNION ALL SELECT target FROM reverse_verweise UNION ALL SELECT value FROM reverse_code_symbole")).rows;
 assert(texts.length>0);assert(texts.every(r=>!String(r.s).includes(secret)),'no synthetic secret in ANY stored analysis field');
 assert((await pool.query("SELECT count(*)::int AS n FROM reverse_dateien WHERE (metadaten->>'maskiert_anzahl')::int>0")).rows[0].n>0);
 assert((await pool.query("SELECT count(*)::int AS n FROM reverse_code_dateien WHERE file_path LIKE '%@S1/strings.txt'")).rows[0].n>=7);
 assert.equal((await pool.query("SELECT count(*)::int n FROM reverse_auftraege WHERE schicht IN ('S2','S3')")).rows[0].n,0,'reverse_s3 default OFF queues no Ghidra work');
 await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,'reverse_s3',true,'RV8 fixture','fixture')");
 for(let i=0;i<8;i++)await durchlauf();
 const dupeJobs=(await pool.query("SELECT j.p20_auftrag_id FROM reverse_auftraege j WHERE j.datei_id=ANY($1::bigint[]) AND j.schicht='S3'",[[ids.elf,ids.duplicate]])).rows;
 assert.equal(dupeJobs.length,2);assert(dupeJobs[0].p20_auftrag_id);assert.equal(dupeJobs[0].p20_auftrag_id,dupeJobs[1].p20_auftrag_id,'one container job across entries');
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM reverse_auftraege WHERE schicht='S2'")).rows[0].n,0,'S2 list and S3 decompilation use one Ghidra job (T69)');
 assert((await pool.query("SELECT count(*)::int AS n FROM reverse_auftraege WHERE schicht='S1' AND ausfuehrung='container'")).rows[0].n>=7,'S1 tools remain durable waiting work');
 assert.equal((await core.createWorkJobService({pool}).claim({nodeId:'fixture',bootGeneration:randomUUID(),authHash:'fixture'})).length,0,'no executable leases without authority hooks');
 // Interactive work overtakes an older background request; no implicit S2 execution.
 const priorityRid='rev-priority-000003';
 const bg=await add(priorityRid,'background.bin',Buffer.from('bg-data'),{policy:false});
 const fg=await add(priorityRid,'foreground.bin',Buffer.from('fg-data'),{policy:false});
 await requested(service,priorityRid,bg,'hintergrund');const fast=await requested(service,priorityRid,fg,'interaktiv');
 const claimed=await service.claim();assert.equal(claimed.id,fast.auftrag_id);assert.equal(claimed.prioritaet,'interaktiv');
 await pool.query("UPDATE reverse_auftraege SET status='abgebrochen',lease_token=NULL,lease_bis=NULL WHERE id=$1",[claimed.id]);
 const missingRid='rev-missing-000004',missing=await add(missingRid,'missing.bin',Buffer.from('not-present'),{write:false,policy:false});
 await requested(service,missingRid,missing);
 for(let i=0;i<8;i++){await durchlauf();await pool.query("UPDATE reverse_auftraege SET updated_at=clock_timestamp()-interval '1 hour' WHERE datei_id=$1",[missing]);}
 const exhausted=(await pool.query("SELECT status,versuch FROM reverse_auftraege WHERE datei_id=$1 AND ausfuehrung='api'",[missing])).rows;
 assert.equal(exhausted.length,1);assert.equal(exhausted[0].status,'fehler');assert.equal(exhausted[0].versuch,2,'bounded retries');
 const retry=await requested(service,missingRid,missing);assert(retry.auftrag_id);assert.equal((await pool.query('SELECT versuch FROM reverse_auftraege WHERE id=$1',[retry.auftrag_id])).rows[0].versuch,0);
 const masked=core.maskiereReverseAnalyse({content:'password = "'+secret+'"',nested:{value:'Bearer abcdefghijklmnopqrstuvwxyz123456'}});assert(masked.treffer>0);assert(!JSON.stringify(masked.wert).includes(secret));
 assert.throws(()=>core.maskiereReverseAnalyse(Buffer.from('bytes')),/Bytes/);
 console.log('RV8 PASS: schema rollback/idempotency, ELF/PE/.NET/JAR/WASM/unknown, real workers, mask all PG text, cross-entry inspector+P20 dedup, product OFF and single Ghidra S3, interactive priority, retry limit/manual reset');
}catch(error){console.error(error);process.exitCode=1;}
finally{core.AssetInspektionsWorker.prototype.inspiziereQuelle=original;await Promise.all(services.map(s=>s.beende()));await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await raw.end();await core.closePool();await rm(root,{recursive:true,force:true});}
process.exit(process.exitCode||0);
