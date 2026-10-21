/** P18-T88: E-Übernahme in bestätigten Blöcken ohne Dateianzahl-Gesamtgrenze. Nur privates synapse_test-Schema (5433), synthetische Dateien. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',QDRANT_URL:'http://127.0.0.1:1'});
const {Pool}=createRequire(new URL('../package.json',import.meta.url))('pg');
const raw=new Pool({connectionString:url.href,max:6}),schema='p18_t88e_'+process.pid+'_'+randomUUID().slice(0,8);
const pool={async connect(){const c=await raw.connect();await c.query('SET search_path TO '+schema+',public');return c;},async query(...a){const c=await this.connect();try{return await c.query(...a);}finally{c.release();}}};
const temp=await mkdtemp(join(tmpdir(),'p18-t88e-')),root=join(temp,'reverse');
await mkdir(join(root,'_arbeit'),{recursive:true});
Object.assign(process.env,{SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:root});
const scoped=new URL(url);scoped.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=scoped.href;
const {uebernehmeEInBloecken}=await import('../dist/services/reverse-e-bloecke.js');
const {reverseEinstellSnapshot}=await import('../dist/services/reverse-einstellwerte.js');
const R='rev-t88e',N=25000,sha=v=>createHash('sha256').update(v).digest('hex');
let checks=0;
const eq=(a,b,m)=>{assert.deepEqual(a,b,m);checks++;};
const ok=(x,m)=>{assert.ok(x,m);checks++;};
const reject=async(fn,code)=>{await assert.rejects(fn,e=>String(e?.message).includes(code));checks++;};
const einst=reverseEinstellSnapshot([{ebene:'global',name:'e_uebernahme_block_zeilen',wert:'4000'}]);
try{
 await raw.query('CREATE SCHEMA '+schema);
 for(const t of ['projects','agent_sessions','agent_profil_schalter','intern_schalter','tool_aktivitaet'])await pool.query('CREATE TABLE '+t+' (LIKE public.'+t+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 for(const file of ['work-jobs-schema','reverse-schema','reverse-pipeline-schema','reverse-eingang-schema','reverse-verknuepfungen-schema','reverse-einstellwerte-schema'])
  await pool.query(Object.values(await import('../dist/db/'+file+'.js')).find(x=>typeof x==='string'));
 // Gegenstand ist der Importer; der P20-Work-Job selbst wird hier nicht angelegt.
 await pool.query('ALTER TABLE reverse_auftraege DROP CONSTRAINT IF EXISTS reverse_auftraege_p20_fkey');
 for(const [t,c]of [['reverse_eintraege','creator_identity_id'],['reverse_eintraege','confirmer_identity_id'],['reverse_auftraege','trigger_identity_id']])await pool.query('ALTER TABLE '+t+' ADD COLUMN IF NOT EXISTS '+c+' TEXT');
 await pool.query("INSERT INTO reverse_eintraege(id,titel,status) VALUES($1,'T88 E fixture','bestaetigt')",[R]);
 const mid=(await pool.query("INSERT INTO reverse_medien(eintrag_id,position,art,status) VALUES($1,0,'iso','vollstaendig') RETURNING id::text",[R])).rows[0].id;
 const jobId=randomUUID(),arbeit=join(root,'_arbeit',jobId);
 const manifest=[];
 for(let i=0;i<N;i++){
  const pfad='d'+(i%50)+'/f'+i+'.bin',inhalt=Buffer.from('datei '+i);
  if(i<50)await mkdir(join(arbeit,'d'+i),{recursive:true});
  await writeFile(join(arbeit,pfad),inhalt);
  manifest.push({pfad,sha256:sha(inhalt),groesse:String(inhalt.length),art:'binaer'});
 }
 manifest.push({pfad:'d0/kaputt.bin',sha256:'0'.repeat(64),groesse:'3',art:'binaer'});
 const manifestSha=sha(JSON.stringify(manifest));
 await pool.query("INSERT INTO reverse_auftraege(eintrag_id,medium_id,schicht,status,fingerabdruck,ausfuehrung,p20_auftrag_id) VALUES($1,$2,'E','laeuft','fp-e-bloecke','container',$3)",[R,mid,jobId]);
 async function* strom(){for(const m of manifest)yield m;}
 const auftrag=(pruefeLease,sha=manifestSha)=>({jobId,reverseId:R,mediumId:mid,arbeitsWurzel:arbeit,reverseRoot:root,manifestSha:sha,manifest:strom(),einstellungen:einst,pruefeLease});

 // 1) Lease geht nach drei Blöcken verloren: bestätigte Blöcke bleiben, Cursor steht dazwischen.
 let n=0;
 await reject(()=>uebernehmeEInBloecken(pool,auftrag(async()=>++n<=4)),'reverse_e_lease_verloren');
 const cp=(await pool.query("SELECT uebernahme FROM reverse_auftraege WHERE p20_auftrag_id=$1",[jobId])).rows[0].uebernahme;
 ok(Number(cp.position)>0&&Number(cp.position)<N&&!cp.fertig,'Checkpoint nach Abbruch: '+JSON.stringify(cp));
 eq((await pool.query('SELECT count(*)::int n FROM reverse_dateien WHERE eintrag_id=$1',[R])).rows[0].n,Number(cp.dateien),'PG-Zeilen = bestätigter Zähler');

 // 2) Anderes Manifest am selben Auftrag wird abgewiesen.
 await reject(()=>uebernehmeEInBloecken(pool,auftrag(async()=>true,'f'.repeat(64))),'reverse_e_manifest_geaendert');

 // 3) Fortsetzung bis zum Ende: alle Dateien, kein Gesamtschnitt; die defekte Zeile ist verworfen.
 const r=await uebernehmeEInBloecken(pool,auftrag(async()=>true));
 eq(r,{dateien:N,verworfen:1},'alle Dateien übernommen');
 eq((await pool.query('SELECT count(*)::int n FROM reverse_dateien WHERE eintrag_id=$1',[R])).rows[0].n,N,'> 20000 Zeilen in PG, keine Bytes');
 eq((await pool.query("SELECT count(*)::int n FROM reverse_dateien WHERE eintrag_id=$1 AND storage_key IS NULL",[R])).rows[0].n,0,'jede Zeile mit storage_key');
 const probe=(await pool.query("SELECT storage_key,groesse::int g FROM reverse_dateien WHERE eintrag_id=$1 AND pfad LIKE '%/f24999.bin'",[R])).rows[0];
 eq((await stat(join(root,probe.storage_key))).size,probe.g,'Bytes liegen auf dem Speicher (Unraid-Pfad)');
 const fertig=(await pool.query("SELECT uebernahme,status FROM reverse_auftraege WHERE p20_auftrag_id=$1",[jobId])).rows[0];
 ok(fertig.uebernahme.fertig&&fertig.uebernahme.position===String(N+1),'Checkpoint fertig am Manifestende');
 eq(fertig.status,'teilweise','eine verworfene Zeile: teilweise, nicht fertig');

 // 4) Wiederholung nach Abschluss ist idempotent.
 eq(await uebernehmeEInBloecken(pool,auftrag(async()=>true)),{dateien:N,verworfen:1},'Wiederholung liefert den bestätigten Stand');
 eq((await pool.query('SELECT count(*)::int n FROM reverse_dateien WHERE eintrag_id=$1',[R])).rows[0].n,N,'keine Dubletten');
 console.log('P18-T88 E-Bloecke: '+checks+' Pruefungen gruen');
}finally{
 await raw.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>undefined);
 await raw.end();await rm(temp,{recursive:true,force:true});
 const {closePool}=await import('../dist/db/client.js');await closePool().catch(()=>undefined);
}
