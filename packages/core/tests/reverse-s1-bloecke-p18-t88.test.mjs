/** P18-T88: S1 in bestätigten Blöcken. Nur privates synapse_test-Schema (5433), synthetische Bytes. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',QDRANT_URL:'http://127.0.0.1:1'});
const {Pool}=createRequire(new URL('../package.json',import.meta.url))('pg');
const raw=new Pool({connectionString:url.href,max:6}),schema='p18_t88_'+process.pid+'_'+randomUUID().slice(0,8);
const pool={async connect(){const c=await raw.connect();await c.query('SET search_path TO '+schema+',public');return c;},async query(...a){const c=await this.connect();try{return await c.query(...a);}finally{c.release();}}};
const temp=await mkdtemp(join(tmpdir(),'p18-t88-')),root=join(temp,'reverse');
await mkdir(join(root,'_arbeit'),{recursive:true});
Object.assign(process.env,{SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:root});
const scoped=new URL(url);scoped.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=scoped.href;
const core=await import('../dist/index.js');
const {materialisiereS1InBloecken,veroeffentlicheS1Generation,reverseS1Staging}=await import('../dist/services/reverse-s1-bloecke.js');
const {uebernehmeNormalisiert,normalisiereS1}=await import('../dist/services/reverse-normalisierer/s1.js');
const {reverseEinstellSnapshot}=await import('../dist/services/reverse-einstellwerte.js');
const {uebernehmeEErgebnis}=await import('../dist/services/reverse-e-uebernahme.js');
const R='rev-t88',sha=v=>createHash('sha256').update(v).digest('hex');
const cfg=core.ladeAssetKonfiguration({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:root});
const tx=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
let checks=0;
const eq=(a,b,m)=>{assert.deepEqual(a,b,m);checks++;};
const ok=(x,m)=>{assert.ok(x,m);checks++;};
const reject=async(fn,code)=>{await assert.rejects(fn,e=>String(e?.message).includes(code));checks++;};
const einst=werte=>reverseEinstellSnapshot(Object.entries(werte).map(([name,wert])=>({ebene:'global',name,wert:String(wert)})));
// Synthetische Quelle: >20000 Strings (alter Gesamtschnitt maxObjects 10000 / 4 MiB), lange Folge ueber RUN-Grenze, Folgen ueber Leseblockkanten.
const teile=[];
for(let i=0;i<30000;i++)teile.push(Buffer.from('eintrag_'+String(i).padStart(5,'0')+(i%7===0?'.dat':'_wert')));
teile.push(Buffer.from('A'.repeat(10000)));teile.push(Buffer.from('kurz'));teile.push(Buffer.from('xy'));
const bytes=Buffer.concat(teile.flatMap((t,i)=>[t,Buffer.from([i%3===0?0:10,255])]).concat([Buffer.from('ende_ohne_terminator')]));
/** Referenz: bisheriger Algorithmus ohne Kappungen. */
function erwartet(buf,min=4){const out=[];let run='';for(const b of buf){if(b>=32&&b<=126){run+=String.fromCharCode(b);if(run.length>=4096){out.push(run);run='';}}else{if(run.length>=min)out.push(run);run='';}}if(run.length>=min)out.push(run);return out;}
const soll=erwartet(bytes);
const quelle=(abbrechenNach=Infinity)=>{let n=0;return {q:{size:bytes.length,readRange:async(o,l)=>bytes.subarray(o,o+l)},abbrechen:()=>++n>abbrechenNach};};
const werteListe=async(did,fp)=>(await pool.query("SELECT value FROM reverse_code_symbole WHERE datei_id=$1 AND fingerabdruck=$2 AND symbol_type='string' ORDER BY COALESCE(substring(file_path from '/strings-([0-9]+)[.]txt$')::int,1),line_start",[did,fp])).rows.map(r=>r.value);
async function auftrag(did,fp,token=randomUUID()){
 await pool.query("INSERT INTO reverse_schichten(datei_id,schicht,fingerabdruck,status,aktuell) VALUES($1,'S1',$2,'wartet',false)",[did,fp]);
 return (await pool.query("INSERT INTO reverse_auftraege(eintrag_id,datei_id,schicht,ausfuehrung,status,fingerabdruck,lease_token,lease_bis,versuch) VALUES($1,$2,'S1','api','laeuft',$3,$4,clock_timestamp()+interval '1 hour',1) RETURNING id::text",[R,did,fp,token])).rows[0].id;
}
try{
 await raw.query('CREATE SCHEMA '+schema);
 for(const t of ['projects','agent_sessions','agent_profil_schalter','intern_schalter','tool_aktivitaet','asset_upload_sitzungen','code_symbols'])await pool.query('CREATE TABLE '+t+' (LIKE public.'+t+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 for(const file of ['work-jobs-schema','reverse-schema','reverse-pipeline-schema','reverse-eingang-schema','reverse-verknuepfungen-schema','reverse-code-stuecke-schema','reverse-erkenntnisse-schema','reverse-einstellwerte-schema']){
  const mod=await import('../dist/db/'+file+'.js'),sql=Object.values(mod).find(x=>typeof x==='string');
  await pool.query(sql);
 }
 for(const [t,c]of [['reverse_eintraege','creator_identity_id'],['reverse_eintraege','confirmer_identity_id'],['reverse_auftraege','trigger_identity_id']])await pool.query('ALTER TABLE '+t+' ADD COLUMN IF NOT EXISTS '+c+' TEXT');
 await pool.query("INSERT INTO reverse_eintraege(id,titel,status,analyse_policy) VALUES($1,'T88 fixture','bestaetigt','{\"automatisch\":false}')",[R]);
 const mid=(await pool.query("INSERT INTO reverse_medien(eintrag_id,position,art,status) VALUES($1,0,'ordner','vollstaendig') RETURNING id::text",[R])).rows[0].id;
 const jobId=randomUUID(),arbeitsWurzel=join(root,'_arbeit',jobId);await mkdir(arbeitsWurzel);await writeFile(join(arbeitsWurzel,'gross.bin'),bytes);
 await uebernehmeEErgebnis(pool,{jobId,reverseId:R,mediumId:mid,arbeitsWurzel,manifest:[{pfad:'gross.bin',groesse:bytes.length,sha256:sha(bytes),art:'binaer'}]},{konfiguration:cfg});
 const d=(await pool.query('SELECT id::text,pfad FROM reverse_dateien WHERE eintrag_id=$1',[R])).rows[0];
 ok(soll.length>20000,'Fixture liegt ueber dem alten Gesamtschnitt');
 // Alte, veroeffentlichte Generation (alter Weg) mit aktueller, fertiger S1-Schicht.
 await pool.query("INSERT INTO reverse_schichten(datei_id,schicht,fingerabdruck,status,aktuell) VALUES($1,'S1','fp-alt','fertig',true)",[d.id]);
 const aktuelleSchicht=async()=>(await pool.query("SELECT fingerabdruck FROM reverse_schichten WHERE datei_id=$1 AND schicht='S1' AND aktuell",[d.id])).rows.map(r=>r.fingerabdruck);
 await tx(db=>uebernehmeNormalisiert(db,{reverseId:R,dateiId:d.id,pfad:d.pfad,fingerabdruck:'fp-alt'},normalisiereS1({strings:[{text:'alter_wert.cfg'}],importe:[]},{maxBytes:1e6,maxEintraege:100})));
 const klein=einst({s1_materialisierung_block_zeilen:997,lese_block_bytes:4096,materialisierung_tx_bytes:65536,s1_strings_schritt_bytes:20000,s1_textstueck_bytes:8192});
 const basis={reverseId:R,dateiId:d.id,pfad:d.pfad,leaseMs:3600000,importe:['KERNEL32.dll','user32.dll']};

 // 1) Abbruch mitten im Lauf: bestaetigte Bloecke bleiben, alte Generation unberuehrt, nichts sichtbar.
 const tokenA=randomUUID(),A=await auftrag(d.id,'fp-neu',tokenA),erst=quelle(40);
 await reject(()=>materialisiereS1InBloecken(pool,erst.q,{...basis,auftragId:A,leaseToken:tokenA,fingerabdruck:'fp-neu',einstellungen:klein,abbrechen:erst.abbrechen}),'Reverse-Dienst beendet');
 const cp=(await pool.query("SELECT uebernahme->'s1' AS s1 FROM reverse_auftraege WHERE id=$1",[A])).rows[0].s1;
 ok(cp.bloecke>0&&!cp.eof&&Number(cp.offset)>0&&Number(cp.offset)<bytes.length,'Checkpoint nach Abbruch: '+JSON.stringify(cp));
 const st=reverseS1Staging(A);
 ok((await pool.query('SELECT count(*)::int n FROM reverse_code_symbole WHERE fingerabdruck=$1',[st.fingerabdruck])).rows[0].n>0,'Staging-Zeilen vorhanden');
 eq((await werteListe(d.id,'fp-alt')),['alter_wert.cfg'],'alte Generation bleibt bis zur Veroeffentlichung');
 await reject(()=>tx(db=>veroeffentlicheS1Generation(db,{auftragId:A,reverseId:R,dateiId:d.id,fingerabdruck:'fp-neu',ordnungAb:0})),'reverse_s1_generation_unvollstaendig');
 eq(await aktuelleSchicht(),['fp-alt'],'Leser bleiben waehrend des Laufs an der alten Schicht');

 // 2) Fremder Lease-Token schreibt nichts.
 await reject(()=>materialisiereS1InBloecken(pool,quelle().q,{...basis,auftragId:A,leaseToken:randomUUID(),fingerabdruck:'fp-neu',einstellungen:klein}),'reverse_s1_lease_verloren');

 // 3) Fortsetzung bis EOF, danach Veroeffentlichung.
 const fertig=await materialisiereS1InBloecken(pool,quelle().q,{...basis,auftragId:A,leaseToken:tokenA,fingerabdruck:'fp-neu',einstellungen:klein});
 ok(fertig.eof&&fertig.importe&&fertig.bloecke>cp.bloecke,'Fortsetzung bis EOF');
 const maxZeilen=(await pool.query("SELECT max(n)::int m FROM (SELECT count(*) n FROM reverse_code_symbole WHERE fingerabdruck=$1 GROUP BY file_path) x",[st.fingerabdruck])).rows[0].m;
 ok(maxZeilen<=997,'keine Teildatei ueber dem Blockbudget: '+maxZeilen);
 eq((await pool.query("SELECT versuch FROM reverse_auftraege WHERE id=$1",[A])).rows[0].versuch,1,'Fortschritt setzt Fehlerbudget zurueck');
 const ver=await tx(db=>veroeffentlicheS1Generation(db,{auftragId:A,reverseId:R,dateiId:d.id,fingerabdruck:'fp-neu',ordnungAb:2}));
 eq(Number(ver.symbole),soll.length+2,'Zaehler = Strings + Importe');
 eq(await werteListe(d.id,'fp-neu'),soll,'vollstaendige Strings in Reihenfolge, kein Gesamtschnitt');
 eq(await aktuelleSchicht(),['fp-neu'],'Umschalten der aktuellen Schicht mit der Veroeffentlichung');
 eq((await werteListe(d.id,'fp-alt')),[],'alte Strings nach Veroeffentlichung ersetzt');
 eq((await pool.query('SELECT count(*)::int n FROM reverse_code_dateien WHERE file_path LIKE $1',['.s1-generation/%'])).rows[0].n,0,'keine Staging-Pfade sichtbar');
 eq((await pool.query("SELECT uebernahme ? 's1' AS s FROM reverse_auftraege WHERE id=$1",[A])).rows[0].s,false,'Checkpoint aufgeraeumt');
 const importe=(await pool.query("SELECT name FROM reverse_code_symbole WHERE datei_id=$1 AND fingerabdruck='fp-neu' AND symbol_type='import' ORDER BY line_start",[d.id])).rows.map(r=>r.name);
 eq(importe,['KERNEL32.dll','user32.dll'],'Importe');
 const kand=(await pool.query("SELECT target,ordnung FROM reverse_verweise WHERE datei_id=$1 AND kind='string_datei' ORDER BY ordnung",[d.id])).rows;
 const sollKand=[...new Set(soll.filter(s=>/(?:^|[\/\\])?[\w.-]+\.[a-z0-9]{1,8}$/i.test(s)))];
 eq(kand.map(k=>k.target),sollKand,'Dateikandidaten wie bisher, erste Fundstelle zuerst');
 eq(kand[0].ordnung,3,'Ordnung nach den Inspektor-Verweisen');

 // 4) Andere Blockgroessen ergeben dieselbe Menge (eigener Auftrag, eigener Fingerabdruck).
 await pool.query("UPDATE reverse_auftraege SET status='fertig',lease_token=NULL,lease_bis=NULL WHERE id=$1",[A]);
 const tokenB=randomUUID(),B=await auftrag(d.id,'fp-gross',tokenB);
 await materialisiereS1InBloecken(pool,quelle().q,{...basis,auftragId:B,leaseToken:tokenB,fingerabdruck:'fp-gross',einstellungen:einst({})});
 await tx(db=>veroeffentlicheS1Generation(db,{auftragId:B,reverseId:R,dateiId:d.id,fingerabdruck:'fp-gross',ordnungAb:2}));
 eq(await werteListe(d.id,'fp-gross'),soll,'Standardbloecke: gleiche Strings');
 console.log('P18-T88 S1-Bloecke: '+checks+' Pruefungen gruen');
}finally{
 await raw.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>undefined);
 await raw.end();await rm(temp,{recursive:true,force:true});
 const {closePool}=await import('../dist/db/client.js');await closePool().catch(()=>undefined);
}
