/** P18-T113: laufender Belegungszaehler reverse_eintrag_belegung (Trigger, Backfill, Abbruch + Wiederaufnahme, Schalter belegung_zaehler).
 * Nur privates Schema in synapse_test:5433. Abbruch = echter Sitzungsabbruch per pg_terminate_backend mitten in der TX
 * (wie Kill von synapse-api/Reverse-Container): Zeilen UND Zaehler rollen gemeinsam zurueck, Wiederaufnahme ohne Doppelzeilen.
 * Erwartet: "P18-T113 OK 36 Pruefungen" (29 Grundfaelle + 7 aus Abnahme 37680e49 R1: Abgleich blockiert Schreiber nicht).
 * Lauf (nur Testphase): pnpm --filter @synapse/core build && SYNAPSE_TEST_PHASE=P18-T113 DATABASE_URL=<synapse_test:5433> node packages/core/tests/reverse-belegung-p18-t113.test.mjs */
import assert from 'node:assert/strict';
if(process.env.SYNAPSE_TEST_PHASE!=='P18-T113'){console.log('P18-T113 uebersprungen: nur mit SYNAPSE_TEST_PHASE=P18-T113');process.exit(0);}
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;delete process.env.SYNAPSE_INTERN_TOOL;
process.env.SYNAPSE_SKIP_EMBEDDINGS='1';process.env.QDRANT_URL='http://127.0.0.1:1';
const require=createRequire(new URL('../package.json',import.meta.url)),{Pool}=require('pg');
const raw=new Pool({connectionString:url.href,max:2});
const schema='p18_t113_'+process.pid,rid='rev-p18-t113',rid2='rev-p18-t113-b';
await raw.query('CREATE SCHEMA '+schema);
url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.href;
const core=await import('../dist/index.js');
const pool=new Pool({connectionString:url.href,max:6});
let passed=0;const ok=(c,m)=>{assert(c,m);passed++;};const eq=(a,b,m)=>{assert.deepEqual(a,b,m);passed++;};
const sha=s=>createHash('sha256').update(String(s)).digest('hex');
// Snapshot ohne reverse_einstellungen-Tabelle: Katalogwerte + belegung_zaehler.
const snap=async(modus,extra={})=>core.leseReverseEinstellwerte({},{query:async()=>({rows:[...(modus?[['belegung_zaehler',modus]]:[]),...Object.entries(extra)]
 .map(([name,wert])=>({ebene:'global',project:null,eintrag_id:null,name,wert:String(wert)}))})});
const zaehler=async id=>(await pool.query('SELECT dateien_bytes::text AS b FROM reverse_eintrag_belegung WHERE eintrag_id=$1',[id])).rows[0]?.b??null;
const echt=async id=>(await pool.query('SELECT COALESCE(sum(groesse),0)::text AS b,count(*)::int AS n,count(DISTINCT pfad)::int AS p FROM reverse_dateien WHERE eintrag_id=$1',[id])).rows[0];
let mid;
const datei=(c,id,pfad,groesse)=>c.query("INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,sha256,groesse,art) VALUES($1,$2,$3,$4,$5,'binaer') ON CONFLICT(eintrag_id,pfad) DO NOTHING",[id,mid,pfad,sha(pfad),groesse]);
/** Ein Block in eigener Sitzung; abbrechen=true beendet die Sitzung hart nach dem Insert, vor COMMIT. */
async function block(id,von,bis,abbrechen=false){
 const c=await pool.connect();let tot=false;c.on('error',()=>{tot=true;});
 try{
  await c.query('BEGIN');
  for(let i=von;i<bis;i++)await datei(c,id,'b/'+i,100+i);
  if(abbrechen){
   const pid=(await c.query('SELECT pg_backend_pid() AS p')).rows[0].p;
   await raw.query('SELECT pg_terminate_backend($1)',[pid]);
   await c.query('COMMIT').then(()=>{throw new Error('commit nach Abbruch');},()=>{});
   return false;
  }
  await c.query('COMMIT');return true;
 }finally{c.release(tot||abbrechen);}
}
try{
 for(const t of ['projects','agent_sessions','tool_aktivitaet','code_files','agent_profil_schalter'])
  await pool.query('CREATE TABLE '+schema+'.'+t+' (LIKE public.'+t+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 await pool.query((await import('../dist/db/reverse-schema.js')).REVERSE_SCHEMA_SQL);
 await pool.query(core.REVERSE_FEHLERLOG_SCHEMA_SQL);
 await pool.query("INSERT INTO reverse_eintraege(id,titel,status) VALUES($1,'T113','bestaetigt'),($2,'T113b','bestaetigt')",[rid,rid2]);
 mid=String((await pool.query("INSERT INTO reverse_medien(eintrag_id,position,art,status,satz_sha256) VALUES($1,0,'ordner','vollstaendig',$2) RETURNING id",[rid,sha('m')])).rows[0].id);
 // 1) Bestand VOR dem Zaehler -> Backfill bei Neuanlage, zweite Ausfuehrung zaehlt nicht doppelt.
 for(let i=0;i<5;i++)await datei(pool,rid,'alt/'+i,1000);
 await pool.query(core.REVERSE_BELEGUNG_SCHEMA_SQL);
 // Laeuft auch, wenn public.reverse_eintrag_belegung schon existiert (Testdb nachgezogen): Anlage im privaten Schema.
 eq((await pool.query("SELECT to_regclass(format('%I.reverse_eintrag_belegung',current_schema())) IS NOT NULL AS da")).rows[0].da?await zaehler(rid):null,'5000','Backfill = Bestand (im privaten Schema)');
 await pool.query(core.REVERSE_BELEGUNG_SCHEMA_SQL);
 eq(await zaehler(rid),'5000','Schema idempotent, kein zweiter Backfill');
 eq((await pool.query("SELECT count(*)::int n FROM pg_trigger WHERE tgrelid='reverse_dateien'::regclass AND tgname LIKE 'trg_reverse_belegung_%'")).rows[0].n,4,'vier Trigger');
 // 2) Trigger: Mehrzeilen-Insert, ON CONFLICT DO NOTHING, Update, Delete.
 await pool.query("INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,sha256,groesse,art) SELECT $1,$2,'m/'||g,md5(g::text)||md5(g::text),10,'binaer' FROM generate_series(1,50) g",[rid,mid]);
 eq(await zaehler(rid),'5500','Mehrzeilen-Insert in einem Statement');
 await datei(pool,rid,'alt/0',999999);
 eq(await zaehler(rid),'5500','ON CONFLICT DO NOTHING zaehlt nicht');
 await pool.query("UPDATE reverse_dateien SET groesse=groesse+5 WHERE eintrag_id=$1 AND pfad LIKE 'm/%'",[rid]);
 eq(await zaehler(rid),'5750','Update Delta');
 await pool.query("UPDATE reverse_dateien SET metadaten='{}'::jsonb WHERE eintrag_id=$1",[rid]);
 eq(await zaehler(rid),'5750','Update ohne Groessenaenderung neutral');
 await pool.query("DELETE FROM reverse_dateien WHERE eintrag_id=$1 AND pfad LIKE 'm/%'",[rid]);
 eq(await zaehler(rid),'5000','Delete');
 eq(await zaehler(rid),(await echt(rid)).b,'Zaehler = echte Summe');
 // 3) Abbruch mitten im Import (zwischen Bloecken und mitten im Block) + Wiederaufnahme.
 ok(await block(rid,0,20),'Block 1 committed');
 const nachBlock1=await zaehler(rid);
 eq(await block(rid,20,40,true),false,'Block 2 hart abgebrochen');
 eq(await zaehler(rid),nachBlock1,'Abbruch: Zaehler unveraendert');
 eq((await echt(rid)).n,25,'Abbruch: keine Zeilen aus Block 2');
 ok(await block(rid,15,40),'Wiederaufnahme ab Checkpoint (Ueberlappung 15..19 idempotent)');
 const e1=await echt(rid);
 eq(e1.n,45,'keine Doppelzeilen');eq(e1.n,e1.p,'Pfade eindeutig');
 eq(await zaehler(rid),e1.b,'Zaehler korrekt nach Wiederaufnahme');
 // 4) Abbruch mitten in Publikation (Groessenupdate in TX) -> unveraendert.
 {const c=await pool.connect();c.on('error',()=>{});
  await c.query('BEGIN');await c.query("UPDATE reverse_dateien SET groesse=groesse*2 WHERE eintrag_id=$1 AND pfad LIKE 'b/%'",[rid]);
  await raw.query('SELECT pg_terminate_backend($1)',[(await c.query('SELECT pg_backend_pid() AS p')).rows[0].p]);
  await c.query('COMMIT').catch(()=>{});c.release(true);}
 eq(await zaehler(rid),e1.b,'Publikationsabbruch: Zaehler unveraendert');
 // 5) Parallele Schreiber desselben Eintrags.
 await Promise.all([block(rid,100,130),block(rid,200,230),block(rid,300,330)]);
 eq(await zaehler(rid),(await echt(rid)).b,'parallel: Zaehler = echte Summe');
 // 6) Modi.
 const sAus=await snap(null),sAn=await snap('an'),sDbg=await snap('debug');
 eq(core.reverseBelegungModus(sAus),'aus','Standard aus');
 eq(await core.leseReverseDateienBelegt(pool,rid,sAus,'test'),(await echt(rid)).b,'aus = echte Summe');
 await pool.query("UPDATE reverse_eintrag_belegung SET dateien_bytes=dateien_bytes+7 WHERE eintrag_id=$1",[rid]); // Drift erzwingen
 const richtig=(await echt(rid)).b;
 eq(await core.leseReverseDateienBelegt(pool,rid,sAn,'test'),String(BigInt(richtig)+7n),'an = Zaehler');
 const vorher=core.reverseBelegungVerlauf().length;
 eq(await core.leseReverseDateienBelegt(pool,rid,sDbg,'test'),richtig,'debug rechnet mit echter Summe');
 ok(core.reverseBelegungVerlauf().length===vorher+1&&core.reverseBelegungVerlauf().at(-1).abweichung==='-7','debug meldet Abweichung');
 eq(await core.gleicheReverseBelegungAb(pool,rid,sAus,'test'),null,'Abgleich bei aus: nichts');
 const ab=await core.gleicheReverseBelegungAb(pool,rid,sAn,'test');
 ok(ab.korrigiert&&ab.abweichung==='-7','Abgleich korrigiert');
 eq(await zaehler(rid),richtig,'nach Abgleich korrekt');
 eq(await core.leseReverseDateienBelegt(pool,rid2,sAn,'test'),'0','Eintrag ohne Dateien = 0');
 // 6b) R1: Abgleich ist befristet und blockiert keinen Schreiber.
 {const sKurz=await snap('an',{belegung_abgleich_lock_ms:200});
  await pool.query('UPDATE reverse_eintrag_belegung SET dateien_bytes=dateien_bytes+3 WHERE eintrag_id=$1',[rid]); // Drift
  const h=await pool.connect();
  try{
   await h.query('BEGIN');await datei(h,rid,'halter/1',11); // Trigger haelt die Zaehlerzeile bis COMMIT
   const t0=Date.now(),ab2=await core.gleicheReverseBelegungAb(pool,rid,sKurz,'test_halter');
   eq(ab2.uebersprungen,'lock_timeout','Halter: Abgleich uebersprungen statt warten');
   ok(Date.now()-t0<3000,'Halter: Abgleich kehrt innerhalb der Frist zurueck');
   await h.query('COMMIT');
  }finally{h.release();}
  eq(await zaehler(rid),String(BigInt((await echt(rid)).b)+3n),'Halter: Schreiber committed, Drift unveraendert gemeldet');
  const ab3=await core.gleicheReverseBelegungAb(pool,rid,sKurz,'test_nachher');
  ok(ab3.korrigiert&&ab3.abweichung==='-3','naechster Abgleich korrigiert per Delta');
  eq(await zaehler(rid),(await echt(rid)).b,'nach Delta-Korrektur korrekt');
  // Abgleiche parallel zu Schreibern: Schreiber laufen durch, Delta-Buchung bleibt exakt.
  const schreiber=[block(rid,400,440),block(rid,500,540),block(rid,600,640)];
  const abgleiche=Array.from({length:12},()=>core.gleicheReverseBelegungAb(pool,rid,sKurz,'test_parallel'));
  const fertig=await Promise.all(schreiber);await Promise.all(abgleiche);
  ok(fertig.every(Boolean),'parallel: alle Schreiber committed');
  eq(await zaehler(rid),(await echt(rid)).b,'parallel mit Abgleichen: Zaehler = echte Summe');
 }
 // 7) TRUNCATE leert den Zaehler.
 await pool.query('TRUNCATE reverse_dateien CASCADE');
 eq((await pool.query('SELECT count(*)::int n FROM reverse_eintrag_belegung')).rows[0].n,0,'TRUNCATE leert Zaehler');
 console.log(`P18-T113 OK ${passed} Pruefungen`);
}finally{
 await pool.end().catch(()=>{});
 await raw.query('DROP SCHEMA '+schema+' CASCADE').catch(()=>{});
 await raw.end();
 const {getPool}=await import('../dist/db/client.js');await getPool().end().catch(()=>{});
}
