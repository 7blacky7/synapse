/** P18-T88: echte Pipeline (Worker + PG) mit Produkt-Schalter reverse_blockuebernahme. Privates Schema in synapse_test:5433, synthetische Bytes. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const dsn=new URL(process.env.DATABASE_URL||'http://invalid');assert.equal(dsn.port,'5433');assert.equal(dsn.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
process.env.SYNAPSE_SKIP_EMBEDDINGS='1';process.env.QDRANT_URL='http://127.0.0.1:1';
const core=await import('../dist/index.js');
const {mitLesePool}=await import('../dist/db/client.js');
const {Pool}=createRequire(new URL('../package.json',import.meta.url))('pg');
const raw=new Pool({connectionString:process.env.DATABASE_URL}),schema='p18_t88p_'+process.pid+'_'+randomUUID().slice(0,6);
const pool={async connect(){const db=await raw.connect();try{await db.query('SET search_path TO '+schema+',public');return db;}catch(e){db.release();throw e;}},
 async query(...args){const db=await this.connect();try{return await db.query(...args);}finally{db.release();}}};
const root=await mkdtemp(join(tmpdir(),'synapse-p18-t88p-'));
const cfg=core.ladeAssetKonfiguration({SYNAPSE_ASSET_ENABLED:'0',SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:root});
cfg.sync.retryIntervallMs=1;cfg.inspektion.timeoutMs=10000;cfg.inspektion.maxReadBytes=1048576;cfg.inspektion.maxHashBytes=1048576;
cfg.inspektion.maxObjects=1000;
const sha=b=>createHash('sha256').update(b).digest('hex');
let checks=0;
const eq=(a,b,m)=>{assert.deepEqual(a,b,m);checks++;};
const ok=(x,m)=>{assert.ok(x,m);checks++;};
// 3000 Strings: der alte Weg kappt bei maxObjects=1000, der Blockweg nimmt alle.
const teile=[];for(let i=0;i<3000;i++)teile.push(Buffer.from('wert_'+String(i).padStart(5,'0')+(i%9===0?'.dat':'_x')),Buffer.from([0]));
const bytes=Buffer.concat(teile);
const soll=[];{let run='';for(const b of bytes){if(b>=32&&b<=126){run+=String.fromCharCode(b);if(run.length>=4096){soll.push(run);run='';}}else{if(run.length>=4)soll.push(run);run='';}}if(run.length>=4)soll.push(run);}
const RID='rev-t88p-000001';
const sichtbar=did=>pool.query(`SELECT s.value FROM reverse_code_symbole s JOIN reverse_code_dateien d ON d.eintrag_id=s.eintrag_id AND d.file_path=s.file_path
 WHERE s.datei_id=$1 AND s.symbol_type='string' AND EXISTS(SELECT 1 FROM reverse_schichten rs WHERE rs.datei_id=d.datei_id AND rs.schicht=d.schicht AND rs.fingerabdruck=d.fingerabdruck AND rs.aktuell AND rs.status IN ('fertig','teilweise'))
 ORDER BY COALESCE(substring(s.file_path from '/strings-([0-9]+)[.]txt$')::int,1),s.line_start`,[did]).then(r=>r.rows.map(x=>x.value));
const s1Schicht=did=>pool.query("SELECT fingerabdruck,status,profil_version FROM reverse_schichten WHERE datei_id=$1 AND schicht='S1' AND aktuell",[did]).then(r=>r.rows);
let beobachter=null;
const original=core.AssetInspektionsWorker.prototype.inspiziereQuelle;
core.AssetInspektionsWorker.prototype.inspiziereQuelle=async function(...args){if(beobachter)await beobachter();return original.apply(this,args);};
const services=[];
try{
 await pool.query('CREATE SCHEMA '+schema);
 for(const t of ['agent_profil_schalter','intern_schalter'])await pool.query('CREATE TABLE '+t+' (LIKE public.'+t+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 for(const file of ['work-jobs-schema','reverse-schema','hex-formate-schema','reverse-erkenntnisse-schema','reverse-pipeline-schema','reverse-verknuepfungen-schema','reverse-einstellwerte-schema'])
  await pool.query(Object.values(await import('../dist/db/'+file+'.js')).find(x=>typeof x==='string'));
 for(const [t,c]of [['reverse_eintraege','creator_identity_id'],['reverse_eintraege','confirmer_identity_id'],['reverse_bindungen','binder_identity_id'],['reverse_auftraege','trigger_identity_id']])await pool.query('ALTER TABLE '+t+' ADD COLUMN IF NOT EXISTS '+c+' TEXT');
 await pool.query("INSERT INTO reverse_einstellungen(ebene,name,wert,grund,gesetzt_von) VALUES('global','s1_materialisierung_block_zeilen',300,'T88 fixture','fixture'),('global','lese_block_bytes',4096,'T88 fixture','fixture')");
 await pool.query("INSERT INTO reverse_eintraege(id,titel,status,analyse_policy) VALUES($1,'T88 Pipeline','bestaetigt','{\"automatisch\":true,\"bis_schicht\":\"S1\"}'::jsonb)",[RID]);
 await pool.query("INSERT INTO reverse_medien(id,eintrag_id,position,art,status,satz_sha256) VALUES(1,$1,0,'ordner','vollstaendig',$2)",[RID,sha(Buffer.from(RID))]);
 await mkdir(join(root,RID,'binaries'),{recursive:true});await writeFile(join(root,RID,'binaries','daten.bin'),bytes);
 await pool.query("INSERT INTO reverse_dateien(id,eintrag_id,medium_id,pfad,sha256,groesse,art,storage_key) VALUES(1,$1,1,'daten.bin',$2,$3,'binaer',$4)",[RID,sha(bytes),bytes.length,RID+'/binaries/daten.bin']);
 const service=new core.ReversePipelineDienst({pool,konfiguration:cfg,ausfuehrbareKinds:[]});services.push(service);
 const durchlauf=()=>mitLesePool(pool,()=>service.durchlauf());

 // A) Schalter AUS: Altweg, gekappt bei maxObjects.
 for(let i=0;i<8;i++)await durchlauf();
 const alt=await s1Schicht(1);
 ok(alt.length===1&&['fertig','teilweise'].includes(alt[0].status),'S1 im Altweg fertig: '+JSON.stringify(alt));
 const altStrings=await sichtbar(1);
 eq(altStrings.length,1000,'Altweg kappt bei maxObjects');

 // B) Schalter AN: neue Generation; waehrend des Laufs lesen die Leser weiter die alte Schicht.
 await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,'reverse_blockuebernahme',true,'T88 fixture','fixture')");
 let waehrend=null;
 beobachter=async()=>{waehrend={schicht:await s1Schicht(1),strings:(await sichtbar(1)).length,neu:(await pool.query("SELECT count(*)::int n FROM reverse_schichten WHERE datei_id=1 AND schicht='S1' AND NOT aktuell AND status IN ('wartet','laeuft')")).rows[0].n};beobachter=null;};
 for(let i=0;i<8;i++)await durchlauf();
 ok(waehrend,'S1-Neulauf hat begonnen');
 eq(waehrend.schicht.map(s=>s.fingerabdruck),[alt[0].fingerabdruck],'waehrend des Laufs bleibt die alte Schicht aktuell');
 eq(waehrend.strings,1000,'waehrend des Laufs bleibt die alte Analyse lesbar');
 eq(waehrend.neu,1,'neue Schicht wartet unsichtbar');
 const neu=await s1Schicht(1);
 ok(neu.length===1&&neu[0].fingerabdruck!==alt[0].fingerabdruck&&neu[0].status===alt[0].status,'nach Veroeffentlichung neue Schicht aktuell: '+JSON.stringify(neu));
 eq(await sichtbar(1),soll,'Blockweg: alle Strings sichtbar, kein Gesamtschnitt');
 eq((await pool.query("SELECT count(*)::int n FROM reverse_code_dateien WHERE file_path LIKE '.s1-generation/%' OR fingerabdruck LIKE 's1-generation:%'")).rows[0].n,0,'keine Staging-Reste');
 eq((await pool.query("SELECT count(*)::int n FROM reverse_code_dateien WHERE datei_id=1 AND schicht='S1' AND fingerabdruck=$1",[alt[0].fingerabdruck])).rows[0].n,0,'alte S1-Texte ersetzt');
 ok((await pool.query("SELECT count(*)::int n FROM reverse_verweise WHERE datei_id=1 AND kind='string_datei'")).rows[0].n>=Math.floor(3000/9),'Dateikandidaten aus allen Strings');
 eq((await pool.query("SELECT uebernahme ? 's1' AS s FROM reverse_auftraege WHERE datei_id=1 AND schicht='S1' AND fingerabdruck=$1",[neu[0].fingerabdruck])).rows[0].s,false,'Checkpoint aufgeraeumt');

 // C) Schalter wieder AUS: eigener Altweg-Fingerabdruck, kein Cache-Mischen mit dem Blockergebnis.
 await pool.query("UPDATE agent_profil_schalter SET aktiv=false WHERE funktion='reverse_blockuebernahme'");
 for(let i=0;i<8;i++)await durchlauf();
 const zurueck=await s1Schicht(1);
 eq(zurueck.map(s=>s.fingerabdruck),[alt[0].fingerabdruck],'Altprofil wieder aktuell');
 eq((await sichtbar(1)).length,1000,'Altweg liefert wieder sein eigenes (gekapptes) Ergebnis');
 console.log('P18-T88 Pipeline-Blockweg: '+checks+' Pruefungen gruen');
}finally{
 core.AssetInspektionsWorker.prototype.inspiziereQuelle=original;
 for(const s of services)await s.beende().catch(()=>undefined);
 await raw.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>undefined);
 await raw.end();await rm(root,{recursive:true,force:true});
 const {closePool}=await import('../dist/db/client.js');await closePool().catch(()=>undefined);
}
