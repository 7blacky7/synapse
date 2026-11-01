/**
 * P22-T245 Nacharbeit B2a/B2b + Abnahme claude-birke f91640e2 (B-3, B-5): VERHALTEN der Drossel-Tore im E- und Leser-Executor, nicht nur die
 * Quelltextposition (Test J in packages/core/tests/reverse-einmalig-nacharbeit-p22-t245.test.mjs). Uebernommen aus dem Wegwerftest
 * abnahme-t245-executor-tore.test.mjs von claude-birke (Shell 5669f173) und erweitert:
 *   B2a  rest-api reverse-executor.ts ReverseExecutor.durchlauf: aus = Altverhalten, an + Last = kein Claim/Wecken, an + Pause = zweiter
 *        Takt ruht, Einstellungen nicht lesbar = kein Claim.
 *   B2b  reverse-leser-executor.ts ReverseLeserExecutor.durchlauf: dasselbe; B-5: beim Ruhen keine Nachzug-Planung (nachzug.status ruht).
 *   B-3 (1) reverse-container-io.ts reverseAuftragBytes: E bucht Medium + entpackte Dateien, das MB/s-Budget laesst den naechsten Takt ruhen.
 *   B-3 (2) reverse-container-io.ts reverseIoGeraet/reverseIoGrenzen/reverseIoStartFehler und reverse-container-transport.ts: Geraete aus
 *        sysfs (Partition -> ganzes Geraet), Limit nur bei pipeline_einmalig an, Aussetzen nach Geraetefehler, HostConfig beim Start.
 * Echte Einstellungen, echtes Tor und echte Buchung (core/dist, rest-api/dist); Lifecycle, Jobs und Ausfuehrung gestubbt, Docker synthetisch.
 * Nur synapse_test:5433, privates Schema (Tabellen LIKE public). Braucht core/dist und rest-api/dist. Kein Container, kein Unraid.
 *   DATABASE_URL=postgres://...:5433/synapse_test node --test packages/rest-api/tests/reverse-executor-tore-p22-t245.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,rm,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
assert.equal(url.port,'5433','P22-T245 Testziel Port 5433');assert.equal(url.pathname,'/synapse_test','P22-T245 Testziel synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;process.env.SYNAPSE_SKIP_EMBEDDINGS='1';
const {Pool}=createRequire(new URL('../../core/package.json',import.meta.url))('pg');
const schema='p22_t245_tore_'+randomUUID().replaceAll('-','');
const pool=new Pool({connectionString:url.href,max:4,options:'-c search_path='+schema+',public'});
await pool.query('CREATE SCHEMA '+schema);
const names=(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND (tablename LIKE 'reverse_%' OR tablename LIKE 'work_%' OR tablename LIKE 'tool_%' OR tablename IN ('agent_profil_schalter','intern_schalter','embedding_knoten','projects'))")).rows;
for(const {tablename:t} of names){assert.match(t,/^[a-z_0-9]+$/);await pool.query('CREATE TABLE '+schema+'.'+t+' (LIKE public.'+t+' INCLUDING ALL)');}
const E=await import('../../core/dist/services/reverse-einmalig.js');
const {reverseEinstellSnapshot}=await import('../../core/dist/services/reverse-einstellwerte.js');
const {validateToolDescriptor}=await import('../../core/dist/services/tool-descriptor.js');
const ex=await import('../dist/services/reverse-executor.js');
const {ReverseLeserExecutor}=await import('../dist/services/reverse-leser-executor.js');
const IO=await import('../dist/services/reverse-container-io.js');
const {ReverseContainerTransport}=await import('../dist/services/reverse-container-transport.js');
const setze=async werte=>{for(const [n,w] of Object.entries(werte)){
 await pool.query("DELETE FROM reverse_einstellungen WHERE ebene='global' AND name=$1",[n]);
 if(w!==null)await pool.query("INSERT INTO reverse_einstellungen(ebene,project,eintrag_id,name,wert_text,grund,gesetzt_von) VALUES('global',NULL,NULL,$1,$2,'P22-T245 Test','fixture')",[n,String(w)]);}};
const snap=werte=>reverseEinstellSnapshot(Object.entries(werte).map(([name,wert])=>({ebene:'global',name,wert:String(wert)})));
const sha=n=>String(n).padStart(64,'0');
const wer={nodeId:'srv-p22-t245',bootGeneration:randomUUID(),authHash:'h'};
const root=await mkdtemp(join(tmpdir(),'p22-t245-tore-'));
test.after(async()=>{await pool.query('DROP SCHEMA '+schema+' CASCADE');await pool.end();await rm(root,{recursive:true,force:true});});

function eExecutor(job={kind:'reverse-E'}){
 const konfig=ex.ladeReverseExecutorKonfig({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_IMAGE:'synapse-reverse@sha256:'+'a'.repeat(64),
  SYNAPSE_REVERSE_RESOURCE_NEED:'{"cpu":1,"ram":512,"vram":0,"gpu":false}'},root);
 const z={claims:0,wakes:0,laeufe:0};
 const x=new ex.ReverseExecutor({pool,konfig,lifecycle:()=>({wake:async()=>{z.wakes++;}}),identitaet:async()=>wer,registriereProjekt:async()=>{}});
 x.eingerichtet=true;x.raeumeArbeitAuf=async()=>0;
 x.jobs={claim:async()=>{z.claims++;return [{id:randomUUID(),...job}];},get:async()=>null};
 x.fuehreAus=async()=>{z.laeufe++;};
 return {x,z};
}
function leser(){
 const z={claims:0,laeufe:0};
 const r=new ReverseLeserExecutor({pool,reverseRoot:root,image:'synapse-reverse-leser',digest:'sha256:'+'b'.repeat(64),
  hostRoot:async()=>root,lifecycle:()=>({wake:async()=>{}}),identitaet:async()=>wer});
 r.aktiv=async()=>true;
 r.jobs={claim:async()=>{z.claims++;return [{id:randomUUID(),kind:'reverse-leser'}];},get:async()=>null};
 r.ausfuehren=async()=>{z.laeufe++;};
 return {r,z};
}
/** Wartet, bis alle gestarteten Laeufe samt Buchung (async finally) fertig sind. */
const fertig=async e=>{await Promise.all([...e.laufend.values()]);};

// Abnahme f91640e2 (a): die Tore wirken im Verhalten, nicht nur an der Quelltextposition (Test J).
test('B2a P22-T245 reverse-executor.ts durchlauf: aus = Altverhalten, an + Last = kein Claim/Wecken, an + Pause = zweiter Takt ruht, kaputt = ruht',async()=>{
 E.vergissReverseDrossel();
 await setze({pipeline_einmalig:'aus',pipeline_last_max_milli:1,pipeline_latenz_max_ms:0,pipeline_pause_ms:0});
 let {x,z}=eExecutor();let d=await x.durchlauf();await fertig(x);
 assert.equal(z.claims,1,'P22-T245 B2a aus: claimt trotz Lastgrenze, tatsaechlich '+JSON.stringify(d));
 await setze({pipeline_einmalig:'an'});
 ({x,z}=eExecutor());d=await x.durchlauf();await fertig(x);
 assert.match(String(d.hinweis),/^reverse_drossel:(last|latenz)$/,'P22-T245 B2a an + Last: '+JSON.stringify(d));assert.equal(z.claims,0);assert.equal(z.wakes,0);
 await setze({pipeline_last_max_milli:0,pipeline_pause_ms:60000});
 ({x,z}=eExecutor());d=await x.durchlauf();await fertig(x);
 assert.equal(z.claims,1,'P22-T245 B2a an, ruhig: erster Takt claimt, tatsaechlich '+JSON.stringify(d));assert.equal(z.laeufe,1);
 assert.equal(E.reverseDrosselStand.kanaele.e.auftraege,1,'P22-T245 B2a: Buchung nach dem Auftrag');
 d=await x.durchlauf();
 assert.equal(d.hinweis,'reverse_drossel:drossel','P22-T245 B2a: zweiter Takt ruht, tatsaechlich '+JSON.stringify(d));assert.equal(z.claims,1);
 assert.equal(E.reverseDrosselTor('leser',snap({pipeline_einmalig:'an'}),{messung:{last:0,latenz_ms:0}}).frei,true,'P22-T245 B2a: Kanal leser unberuehrt');
 // Einstellungen nicht lesbar (Tabelle verdeckt) bei Schalter aus: fail-closed, kein Claim.
 await setze({pipeline_pause_ms:null,pipeline_einmalig:'aus',pipeline_last_max_milli:null});E.vergissReverseDrossel();
 await pool.query('ALTER TABLE '+schema+'.reverse_einstellungen RENAME TO reverse_einstellungen_weg');
 await pool.query('CREATE TABLE '+schema+'.reverse_einstellungen(kaputt int)');
 try{({x,z}=eExecutor());d=await x.durchlauf();}finally{await pool.query('DROP TABLE '+schema+'.reverse_einstellungen');await pool.query('ALTER TABLE '+schema+'.reverse_einstellungen_weg RENAME TO reverse_einstellungen');}
 assert.equal(z.claims,0,'P22-T245 B2a Einstellungen nicht lesbar: kein Claim, tatsaechlich '+JSON.stringify(d));
});

test('B2b P22-T245 reverse-leser-executor.ts durchlauf: aus = Altverhalten, an + Last = kein Claim und keine Planung (B-5), an + Pause = zweiter Takt ruht',async()=>{
 E.vergissReverseDrossel();
 await setze({pipeline_einmalig:'aus',pipeline_last_max_milli:1,pipeline_latenz_max_ms:0,pipeline_pause_ms:0});
 let {r,z}=leser();let d=await r.durchlauf();await fertig(r);
 assert.equal(z.claims,1,'P22-T245 B2b aus: claimt, tatsaechlich '+JSON.stringify(d));
 await setze({pipeline_einmalig:'an'});
 ({r,z}=leser());d=await r.durchlauf();await fertig(r);
 assert.equal(z.claims,0,'P22-T245 B2b an + Last: kein Claim, tatsaechlich '+JSON.stringify(d));
 assert.equal(d.nachzug?.status,'ruht','P22-T245 B-5: beim Ruhen keine Nachzug-Planung, tatsaechlich '+JSON.stringify(d));
 assert.match(String(E.reverseDrosselStand.kanaele.leser.letzter_grund),/^(last|latenz)$/);
 await setze({pipeline_last_max_milli:0,pipeline_pause_ms:60000});
 ({r,z}=leser());d=await r.durchlauf();await fertig(r);
 assert.equal(z.claims,1,'P22-T245 B2b an, ruhig: claimt, tatsaechlich '+JSON.stringify(d));assert.equal(E.reverseDrosselStand.kanaele.leser.auftraege,1);
 d=await r.durchlauf();assert.equal(z.claims,1,'P22-T245 B2b: zweiter Takt ruht, tatsaechlich '+JSON.stringify(d));
 assert.equal(E.reverseDrosselStand.kanaele.leser.letzter_grund,'drossel');
 await setze({pipeline_pause_ms:null,pipeline_einmalig:'aus',pipeline_last_max_milli:null});
});

// Abnahme f91640e2 B-3 (1): gebucht wurden 0 Bytes, damit war auch der Mittelwert nicht auf MB/s begrenzt.
test('B-3 (1) P22-T245 reverse-container-io.ts reverseAuftragBytes: E bucht Medium + entpackte Dateien, MB/s-Budget laesst den Takt ruhen',async()=>{
 E.vergissReverseDrossel();
 const rid='rev-p22-t245-'+randomUUID().slice(0,8);
 await pool.query("INSERT INTO reverse_eintraege(id,titel,status) VALUES($1,'P22-T245 Bytes','bestaetigt')",[rid]);
 const mid=String((await pool.query("INSERT INTO reverse_medien(eintrag_id,position,art,status,satz_sha256,groesse) VALUES($1,0,'iso','vollstaendig',$2,5) RETURNING id",[rid,sha(9)])).rows[0].id);
 await pool.query("INSERT INTO reverse_medien_dateien(medium_id,rolle,original_name,sha256,groesse,storage_key) VALUES($1,'haupt','cd.iso',$2,30000000,$3)",[mid,sha(1),rid+'/original/cd.iso']);
 await pool.query("INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,sha256,groesse,art) VALUES($1,$2,'x.bin',$3,10000000,'asset')",[rid,mid,sha(2)]);
 const job={id:randomUUID(),kind:'reverse-E',inputRef:{scope:'reverse',id:rid,revision:mid}};
 assert.equal(await IO.reverseAuftragBytes(pool,'e',job),40_000_000,'P22-T245 B-3 (1): Quelle 30 MB (medien_dateien statt medien.groesse) + 10 MB entpackt');
 assert.equal(await IO.reverseAuftragBytes(pool,'e',{...job,kind:'reverse-S3',inputRef:{revision:'999999'}}),0,'P22-T245 B-3 (1): unbekannte Datei = 0');
 assert.equal(await IO.reverseAuftragBytes(pool,'leser',{id:randomUUID()}),0,'P22-T245 B-3 (1): Leser-SQL gueltig, ohne Lauf 0');
 assert.equal(await IO.reverseAuftragBytes({query:async()=>{throw Error('weg');}},'e',job),0,'P22-T245 B-3 (1): Fehler = 0, nie werfen');
 await setze({pipeline_einmalig:'an',pipeline_last_max_milli:0,pipeline_latenz_max_ms:0,pipeline_pause_ms:0,pipeline_lese_mb_s:20});
 const {x}=eExecutor({kind:'reverse-E',inputRef:job.inputRef});
 let d=await x.durchlauf();await fertig(x);
 assert.equal(E.reverseDrosselStand.kanaele.e.bytes,40_000_000,'P22-T245 B-3 (1) reverse-executor.ts: Buchung mit Bytes, tatsaechlich '+JSON.stringify(E.reverseDrosselStand.kanaele.e));
 d=await x.durchlauf();
 assert.equal(d.hinweis,'reverse_drossel:drossel','P22-T245 B-3 (1): 40 MB bei 20 MB/s = ~2 s Budget trotz Pause 0, tatsaechlich '+JSON.stringify(d));
 await setze({pipeline_einmalig:'aus',pipeline_last_max_milli:null,pipeline_latenz_max_ms:null,pipeline_pause_ms:null,pipeline_lese_mb_s:null});E.vergissReverseDrossel();
});

// Abnahme f91640e2 B-3 (2), Koordinator-Entscheidung: IO-Limit fuer Lesen und Schreiben des Reverse-Containers, Werte als PG-Einstellungen.
test('B-3 (2) P22-T245 reverse-container-io.ts + reverse-container-transport.ts: IO-Limit nur bei einmalig an, Geraete aus sysfs, Aussetzen, HostConfig',async()=>{
 assert.deepEqual(IO.reverseDevNummer((8n<<8n)|17n),{major:8,minor:17});
 assert.deepEqual(IO.reverseDevNummer((259n<<8n)|3n),{major:259,minor:3});
 const sys=await mkdtemp(join(tmpdir(),'p22-t245-sys-'));
 try{
  await mkdir(join(sys,'devices/sdz/sdz1'),{recursive:true});await writeFile(join(sys,'devices/sdz/uevent'),'MAJOR=8\nMINOR=0\nDEVNAME=sdz\nDEVTYPE=disk\n');
  await writeFile(join(sys,'devices/sdz/sdz1/partition'),'1\n');await writeFile(join(sys,'devices/sdz/sdz1/uevent'),'DEVNAME=sdz1\nDEVTYPE=partition\n');
  await mkdir(join(sys,'devices/nvme9n1'),{recursive:true});await writeFile(join(sys,'devices/nvme9n1/uevent'),'DEVNAME=nvme9n1\n');
  await mkdir(join(sys,'block'));await symlink(join(sys,'devices/sdz/sdz1'),join(sys,'block/8:1'));await symlink(join(sys,'devices/nvme9n1'),join(sys,'block/259:9'));
  const dev={'/q/part':(8n<<8n)|1n,'/q/nvme':(259n<<8n)|9n,'/q/fuse':42n,'/q/fehlt':(7n<<8n)|5n};
  const o={sys:join(sys,'block'),dev:async p=>dev[p]};
  assert.deepEqual(await IO.reverseIoGeraet('/q/part',o),{geraet:'/dev/sdz',nummer:'8:1'},'P22-T245 B-3 (2) reverseIoGeraet: Partition -> ganzes Geraet (io.max nimmt nur ganze Geraete)');
  assert.deepEqual(await IO.reverseIoGeraet('/q/nvme',o),{geraet:'/dev/nvme9n1',nummer:'259:9'});
  assert.equal((await IO.reverseIoGeraet('/q/fuse',o)).grund,'kein_blockgeraet','P22-T245 B-3 (2): major 0 (FUSE/btrfs/tmpfs) -> kein Blockgeraet');
  assert.equal((await IO.reverseIoGeraet('/q/fehlt',o)).grund,'kein_blockgeraet','P22-T245 B-3 (2): kein sysfs-Eintrag');
  const mounts=[{role:'bib',source:'/q/part'},{role:'arbeit',source:'/q/nvme'},{role:'x',source:'/q/fuse'}];
  IO.vergissReverseIoAussetzung();
  assert.equal(await IO.reverseIoGrenzen(mounts,{...o,einstellungen:snap({pipeline_einmalig:'aus'})}),null,'P22-T245 B-3 (2): aus = kein Limit (Verhalten vor T245)');
  assert.equal(E.reverseDrosselStand.container_io.grund,'pipeline_einmalig_aus');
  const an=snap({pipeline_einmalig:'an',container_io_lese_mb_s:20,container_io_schreib_mb_s:5});
  assert.deepEqual(await IO.reverseIoGrenzen(mounts,{...o,einstellungen:an}),{
   BlkioDeviceReadBps:[{Path:'/dev/sdz',Rate:20_000_000},{Path:'/dev/nvme9n1',Rate:20_000_000}],
   BlkioDeviceWriteBps:[{Path:'/dev/sdz',Rate:5_000_000},{Path:'/dev/nvme9n1',Rate:5_000_000}]},'P22-T245 B-3 (2) reverseIoGrenzen: Lesen und Schreiben je Geraet');
  assert.deepEqual([E.reverseDrosselStand.container_io.wirksam,E.reverseDrosselStand.container_io.ausgelassen.length],[true,1],'P22-T245 B-3 (2): Stand nennt ausgelassene Quelle');
  const standard=await IO.reverseIoGrenzen(mounts.slice(0,1),{...o,einstellungen:snap({pipeline_einmalig:'an'})});
  assert.deepEqual(standard,{BlkioDeviceReadBps:[{Path:'/dev/sdz',Rate:20_000_000}],BlkioDeviceWriteBps:[{Path:'/dev/sdz',Rate:20_000_000}]},'P22-T245 B-3 (2): Code-Standard 20/20 MB/s aus dem Katalog');
  assert.equal(await IO.reverseIoGrenzen(mounts,{...o,einstellungen:snap({pipeline_einmalig:'an',container_io_lese_mb_s:0,container_io_schreib_mb_s:0})}),null,'P22-T245 B-3 (2): 0/0 = kein Limit');
  assert.equal(await IO.reverseIoGrenzen(mounts.slice(2),{...o,einstellungen:an}),null);assert.equal(E.reverseDrosselStand.container_io.grund,'kein_blockgeraet');
  // Aussetzen nur bei Geraete-/Drosselfehler, bis zur naechsten Einstellungsrevision.
  assert.ok(await IO.reverseIoGrenzen(mounts,{...o,einstellungen:an}));
  IO.reverseIoStartFehler(Error('tool_start_deadline'));
  assert.ok(await IO.reverseIoGrenzen(mounts,{...o,einstellungen:an}),'P22-T245 B-3 (2): fremder Startfehler setzt nicht aus');
  IO.reverseIoStartFehler(Object.assign(Error('(HTTP code 500)'),{json:{message:'failed to write "8:0 rbps=20000000": write /sys/fs/cgroup/io.max: no such device'}}));
  assert.equal(await IO.reverseIoGrenzen(mounts,{...o,einstellungen:an}),null,'P22-T245 B-3 (2): nach Geraetefehler ausgesetzt (nie blockierend)');
  assert.equal(E.reverseDrosselStand.container_io.grund,'ausgesetzt_nach_startfehler');
  IO.vergissReverseIoAussetzung();
 }finally{await rm(sys,{recursive:true,force:true});}
 // Transport: Reverse-Container bekommen die Limits in HostConfig; ein Startfehler wird gemeldet, die uebrige HostConfig bleibt.
 const desc=validateToolDescriptor({tool_id:'reverse-e',tool:'reverse',capability:'fixture.reverse',image:'fixture:1',digest:'sha256:'+'a'.repeat(64),mounts:[],
  resources:{cpu:1,ram:64,vram:0,gpu:false,pids:32,tmpfs:8,concurrency:1},limits:{time_ms:1000,output_bytes:4096,input_bytes:4096},
  lifecycle:{idle_ms:1,activity_lookback_seconds:1,cpu_idle_percent:1,gpu_idle_percent:1,measurement_max_age_ms:1000,start_timeout_ms:1000,max_starts:3,start_window_ms:60000,pause_ms:60000}});
 const ctx={instance_id:'i-p22-t245',project:'reverse-bibliothek',job_id:null,generation:'g-p22-t245',name:'p22-t245-io',isCurrent:async()=>true};
 let gesehen=null,gemeldet=null;
 const docker={modem:{demuxStream(){}},async createContainer(opt){gesehen=opt.HostConfig;throw Object.assign(Error('blkio fixture'),{statusCode:500});},getContainer(){throw Error('unerwartet');}};
 const t=new ReverseContainerTransport({docker,binding:async()=>null,stopSeconds:async()=>1,ioGrenzen:async()=>({BlkioDeviceReadBps:[{Path:'/dev/sdz',Rate:1}]}),ioStartFehler:e=>{gemeldet=e.message;}});
 await assert.rejects(()=>t.start(desc,ctx),/blkio fixture/);
 assert.deepEqual(gesehen.BlkioDeviceReadBps,[{Path:'/dev/sdz',Rate:1}],'P22-T245 B-3 (2) reverse-container-transport.ts: HostConfig traegt das IO-Limit');
 assert.equal(gesehen.ReadonlyRootfs,true,'P22-T245 B-3 (2): uebrige HostConfig bleibt');assert.equal(gemeldet,'blkio fixture','P22-T245 B-3 (2): Startfehler gemeldet');
 const ohne=new ReverseContainerTransport({docker,binding:async()=>null,stopSeconds:async()=>1});
 await assert.rejects(()=>ohne.start(desc,ctx));assert.equal(gesehen.BlkioDeviceReadBps,undefined,'P22-T245 B-3 (2): ohne ioGrenzen kein Limit');
});
