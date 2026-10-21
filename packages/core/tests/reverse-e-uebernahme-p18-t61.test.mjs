/** P18-T61 (R1-C): E-Übernahme, bis_schicht-Obergrenze, Tool-Aktion dateien.
 * Nur synthetische Daten im eigenen Schema p18_t61_<pid> in synapse_test:5433, Root per mkdtemp. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm,access,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const dsn=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(dsn.port,'5433');assert.equal(dsn.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;delete process.env.SYNAPSE_REVERSE_BIS_SCHICHT;
process.env.SYNAPSE_SKIP_EMBEDDINGS='1';process.env.QDRANT_URL='http://127.0.0.1:1';
const core=await import('../dist/index.js');
assert.equal(typeof core.uebernehmeEErgebnis,'function','uebernehmeEErgebnis fehlt (rote Kontrolle)');
assert(core.REVERSE_ACTIONS.includes('dateien'),'Aktion dateien fehlt (rote Kontrolle)');
const {REVERSE_SCHEMA_SQL}=await import('../dist/db/reverse-schema.js');
const {WORK_JOBS_SCHEMA_SQL}=await import('../dist/db/work-jobs-schema.js');
const require=createRequire(new URL('../package.json',import.meta.url)),{Pool}=require('pg');
const raw=new Pool({connectionString:process.env.DATABASE_URL}),schema='p18_t61_'+process.pid,project='p18_t61';
const pool={async connect(){const db=await raw.connect();try{await db.query('SET search_path TO '+schema+',public');return db;}catch(e){db.release();throw e;}},
 async query(...args){const db=await this.connect();try{return await db.query(...args);}finally{db.release();}}};
const root=await mkdtemp(join(tmpdir(),'synapse-p18-t61-'));
const cfg=core.ladeAssetKonfiguration({SYNAPSE_ASSET_ENABLED:'0',SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:root});
const sha=b=>createHash('sha256').update(b).digest('hex');
const rid='rev-t61-fixture-a1b2c3',agent='koordinator';
const exists=async p=>{try{await access(p);return true;}catch{return false;}};
async function arbeit(job,files){
 const dir=join(root,'_arbeit',job);await mkdir(dir,{recursive:true});
 const manifest=[];
 for(const [pfad,inhalt] of files){const b=Buffer.from(inhalt);await mkdir(join(dir,pfad,'..'),{recursive:true});await writeFile(join(dir,pfad),b);manifest.push({pfad,sha256:sha(b),groesse:b.length});}
 return {dir,manifest};
}
let listener;const notes=[];
try{
 await pool.query('CREATE SCHEMA '+schema);
 assert.equal((await pool.query('SELECT current_database() AS d')).rows[0].d,'synapse_test');
 for(const table of ['agent_sessions','projects','tool_aktivitaet'])await pool.query('CREATE TABLE '+schema+'.'+table+' (LIKE public.'+table+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 await pool.query(WORK_JOBS_SCHEMA_SQL);await pool.query(REVERSE_SCHEMA_SQL);await pool.query(core.REVERSE_PIPELINE_SCHEMA_SQL);
 for(const f of ['reverse-verknuepfungen-schema','reverse-einstellwerte-schema'])await pool.query(Object.values(await import('../dist/db/'+f+'.js')).find(x=>typeof x==='string'));
 // Akteur-Spalten wie in den übrigen Reverse-Fixtures (in Produktion aus dem Identitätsschema).
 for(const [t,c]of [['reverse_eintraege','creator_identity_id'],['reverse_eintraege','confirmer_identity_id'],['reverse_bindungen','binder_identity_id'],['reverse_auftraege','trigger_identity_id']])await pool.query('ALTER TABLE '+t+' ADD COLUMN IF NOT EXISTS '+c+' TEXT');
 await pool.query("INSERT INTO agent_sessions(id,project,status,sitzung_seit) VALUES('koordinator',$1,'active',NOW())",[project]);
 await pool.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,'fixture','/synthetic/p18_t61',true)",[project]);
 await pool.query("INSERT INTO reverse_eintraege(id,titel,status) VALUES($1,'T61 Fixture','bestaetigt')",[rid]);
 await pool.query("INSERT INTO reverse_medien(id,eintrag_id,position,bezeichnung,art,status,satz_sha256) VALUES(1,$1,0,'CD1','image','vollstaendig',$2),(2,$1,1,NULL,'image','vollstaendig',$3)",[rid,'a'.repeat(64),'b'.repeat(64)]);
 listener=await raw.connect();listener.on('notification',n=>{if(n.channel==='synapse_reverse_changed')notes.push(n.payload);});await listener.query('LISTEN synapse_reverse_changed');

 // 1) Übernahme mit Manipulationen: falscher Hash, Ausbruch, Symlink, Dublette.
 const job=randomUUID();
 await pool.query("INSERT INTO reverse_auftraege(id,eintrag_id,medium_id,schicht,status,fingerabdruck,ausfuehrung) VALUES($1,$2,1,'E','laeuft','fp-e-1','container')",[job,rid]);
 await pool.query("INSERT INTO reverse_schichten(medium_id,schicht,fingerabdruck,status,werkzeug,auftrag_id) VALUES(1,'E','fp-e-1','laeuft','reverse-E',$1)",[job]);
 const gut=[['SETUP.EXE','MZ-setup'],['DATEN/a.dat','alpha'],['DATEN/b.dat','beta'],['DATEN/tief/c.txt','gamma'],['leer.bin','']];
 const {dir,manifest}=await arbeit(job,[...gut,['falsch.bin','echt']]);
 manifest.find(m=>m.pfad==='falsch.bin').sha256=sha('manipuliert');
 await writeFile(join(root,'_arbeit','aussen.txt'),'draussen');
 manifest.push({pfad:'../aussen.txt',sha256:sha('draussen'),groesse:8});
 await symlink('/etc/hostname',join(dir,'link.txt'));
 manifest.push({pfad:'link.txt',sha256:sha(await readFile('/etc/hostname')),groesse:(await readFile('/etc/hostname')).length});
 manifest.push({...manifest[0]});
 const e={jobId:job,reverseId:rid,mediumId:'1',arbeitsWurzel:dir,manifest};
 const [r1,r1b]=await Promise.all([core.uebernehmeEErgebnis(pool,e,{konfiguration:cfg}),core.uebernehmeEErgebnis(pool,e,{konfiguration:cfg})]);
 assert.deepEqual(r1,{dateien:5,verworfen:4});assert.deepEqual(r1b,r1,'paralleler Aufruf teilt das Ergebnis');
 for(const [pfad,inhalt] of gut)assert.equal(await readFile(join(root,rid,'entpackt','m1',pfad),'utf8'),inhalt,'übernommen: '+pfad);
 assert.equal(await exists(join(root,rid,'entpackt','m1','falsch.bin')),false,'falscher Hash nicht übernommen');
 assert.equal(await readFile(join(root,'_arbeit','aussen.txt'),'utf8'),'draussen','Ausbruch nicht angefasst');
 assert.equal(await exists(join(root,rid,'entpackt','m1','link.txt')),false,'Symlink nicht übernommen');
 assert.equal(await exists(join(root,rid,'entpackt','.e-'+job)),false,'Zwischenstand aufgeräumt');
 const rows=(await pool.query("SELECT pfad,sha256,groesse::int,storage_key,entpackt_mit,metadaten FROM reverse_dateien WHERE eintrag_id=$1 ORDER BY pfad COLLATE \"C\"",[rid])).rows;
 assert.deepEqual(rows.map(r=>r.pfad),['CD1/DATEN/a.dat','CD1/DATEN/b.dat','CD1/DATEN/tief/c.txt','CD1/SETUP.EXE','CD1/leer.bin']);
 assert(rows.every(r=>r.storage_key.startsWith(rid+'/entpackt/m1/')&&r.entpackt_mit==='reverse-E'&&r.metadaten.e_auftrag===job));
 assert.equal(rows.find(r=>r.pfad==='CD1/DATEN/a.dat').sha256,sha('alpha'));
 const layer=(await pool.query("SELECT status,funktionen_gesamt,funktionen_fertig,ausgabe_key FROM reverse_schichten WHERE medium_id=1 AND schicht='E' AND aktuell")).rows;
 assert.equal(layer.length,1);assert.equal(layer[0].status,'teilweise');assert.equal(layer[0].funktionen_gesamt,9);assert.equal(layer[0].funktionen_fertig,5);
 assert.equal((await pool.query('SELECT status FROM reverse_auftraege WHERE id=$1',[job])).rows[0].status,'teilweise');
 // 2) Idempotent je jobId: zweiter Aufruf ändert nichts, auch ohne Arbeitsordner.
 await rm(dir,{recursive:true,force:true});
 assert.deepEqual(await core.uebernehmeEErgebnis(pool,e,{konfiguration:cfg}),r1);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM reverse_dateien WHERE eintrag_id=$1',[rid])).rows[0].n,5);
 // 3) Sauberer Lauf ohne vorhandenen Fachauftrag (P20-Job-ID), Medium ohne Bezeichnung.
 const job2=randomUUID(),w2=await arbeit(job2,[['README.TXT','hallo'],['BIN/x.dll','x']]);
 assert.deepEqual(await core.uebernehmeEErgebnis(pool,{jobId:job2,reverseId:rid,mediumId:'2',arbeitsWurzel:w2.dir,manifest:w2.manifest},{konfiguration:cfg}),{dateien:2,verworfen:0});
 const l2=(await pool.query("SELECT status,funktionen_fertig FROM reverse_schichten WHERE medium_id=2 AND schicht='E' AND aktuell")).rows[0];
 assert.equal(l2.status,'fertig');assert.equal(l2.funktionen_fertig,2);
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM reverse_dateien WHERE pfad LIKE 'medium-2/%'")).rows[0].n,2);
 // 4) Arbeitsordner außerhalb <root>/_arbeit und ungültige Parameter werden abgewiesen.
 const fremd=await mkdtemp(join(tmpdir(),'synapse-p18-t61-fremd-'));
 await assert.rejects(core.uebernehmeEErgebnis(pool,{jobId:randomUUID(),reverseId:rid,mediumId:'1',arbeitsWurzel:fremd,manifest:[]},{konfiguration:cfg}),e=>e.code==='pfad_gefahr');
 await rm(fremd,{recursive:true,force:true});
 await assert.rejects(core.uebernehmeEErgebnis(pool,{jobId:'kein-uuid',reverseId:rid,mediumId:'1',arbeitsWurzel:dir,manifest:[]},{konfiguration:cfg}),e=>e.code==='parameter_ungueltig');
 await assert.rejects(core.uebernehmeEErgebnis(pool,{jobId:randomUUID(),reverseId:rid,mediumId:'99',arbeitsWurzel:dir,manifest:[]},{konfiguration:cfg}),e=>e.code==='nicht_gefunden');
 await new Promise(r=>setTimeout(r,200));
 assert(notes.includes(rid),'pg_notify synapse_reverse_changed gesendet');
 // 5) bis_schicht-Obergrenze (P18-T86): Standard S1 aus dem Katalog, Wert aus reverse_einstellungen (Snapshot), Env wirkt nicht mehr.
 assert.equal(core.reverseBisSchichtGrenze(),'S1');assert.equal(core.begrenzeReverseSchicht('S3'),'S1');assert.equal(core.begrenzeReverseSchicht('S0'),'S0');assert.equal(core.begrenzeReverseSchicht(undefined),'S1');
 const {reverseEinstellSnapshot}=await import('../dist/services/reverse-einstellwerte.js');
 const bis=w=>reverseEinstellSnapshot([{ebene:'global',name:'analyse_bis_schicht',wert:w}]);
 process.env.SYNAPSE_REVERSE_BIS_SCHICHT='S3';assert.equal(core.begrenzeReverseSchicht('S2'),'S1','Env ist nur noch Migrationsvorschlag');delete process.env.SYNAPSE_REVERSE_BIS_SCHICHT;
 assert.equal(core.begrenzeReverseSchicht('S2',bis('S3')),'S2');
 const falsch=bis('S9');assert.equal(core.reverseBisSchichtGrenze(falsch),'S1','ungültiger PG-Wert: Katalogstandard');
 assert.ok(falsch.migrationsbedarf.some(m=>m.name==='analyse_bis_schicht'),'ungültiger PG-Wert sichtbar als Migrationsbedarf');

 const service=core.createReverseToolService({pool});
 const call=(action,extra={})=>service.ausfuehren({action,agent_id:agent,project,reverse_id:rid,...extra});
 {const b=await call('bestaetigen',{},agent);assert.equal(b.success,true,JSON.stringify(b).slice(0,600));}
 assert.equal((await pool.query('SELECT analyse_policy FROM reverse_eintraege WHERE id=$1',[rid])).rows[0].analyse_policy.bis_schicht,'S1','confirm schreibt die Obergrenze');
 // 6) Tool dateien: Bindung Pflicht, Seiten, Präfix, Maskierung, keine storage_key.
 assert.equal((await call('dateien')).fehlercode,'nicht_gebunden');
 assert.equal((await call('binden')).success,true);
 await pool.query("INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,art) VALUES($1,1,'CD1/password = \"SyntheticSecret987654321\".txt','sonstig')",[rid]);
 const s1=await call('dateien',{limit:3});
 assert.equal(s1.success,true);assert.equal(s1.total,8);assert.equal(s1.dateien.length,3);assert.equal(s1.gekappt,true);assert.equal(s1.naechster_offset,3);
 const alle=[...s1.dateien];let off=s1.naechster_offset;
 while(off!==null){const s=await call('dateien',{limit:3,offset:off});alle.push(...s.dateien);off=s.naechster_offset;}
 assert.equal(alle.length,8);assert.equal(new Set(alle.map(d=>d.id)).size,8,'Seiten ohne Dubletten');
 assert.equal(alle.filter(d=>d.herkunft==='entpackt').length,7);
 assert(!JSON.stringify(alle).includes('SyntheticSecret987654321'),'Pfade maskiert');assert(!JSON.stringify(alle).includes('storage_key'));
 const pre=await call('dateien',{path:'CD1/DATEN'});assert.equal(pre.total,3);assert(pre.dateien.every(d=>d.pfad.startsWith('CD1/DATEN/')));
 assert.equal((await call('dateien',{path:'../x'})).fehlercode,'pfad_gefahr');
 const unbekannt=await call('dateien',{unbekannt:1});assert.equal(unbekannt.success,false);assert.equal(unbekannt.fehler,'unbekannte_parameter');
 console.log('P18-T61 PASS: Uebernahme 5/9 mit sha/Ausbruch/Symlink/Dublette abgewiesen, parallel+idempotent, ohne Fachauftrag, Pfadgrenzen, pg_notify, bis_schicht S1, Tool dateien paginiert/maskiert');
}catch(error){console.error(error);process.exitCode=1;}
finally{if(listener){await listener.query('UNLISTEN *').catch(()=>{});listener.release();}await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await raw.end();await core.closePool();await rm(root,{recursive:true,force:true});}
process.exit(process.exitCode||0);
