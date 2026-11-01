/** P22-T275 (User 01.11.2026, memory regel-reverse-assets-einmalig-gedrosselt-nie-blockierend): Reverse-Warteschlange.
 * - grosse Medien-E (e_auto_gross_ab_mb) laufen nicht als Hintergrund vor dem Nachzug: anforderung = nie automatisch, nachrang = Prioritaet
 *   nachzug nur ohne Vorrang und ohne offenen Nachzug; offene automatische Hintergrund-E werden herabgestuft.
 * - H-1 (Nachabnahme 49201b76): Leser-Bestand zaehlt fuer den Nachzug-Vorrang nur bei reverse_leser an.
 * - pipeline_gesehen_at wird gebuendelt geschrieben (pipeline_schreib_block_zeilen); Vorschau nennt Vorrang-Grund und grosse Medien.
 * Nur privates synapse_test-Schema. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',SYNAPSE_INTERN_TOOL:'0',QDRANT_URL:'http://127.0.0.1:1',SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:'/tmp/p22-t275-reverse'});
const schema='p22_t275_'+randomUUID().replaceAll('-','');
const scoped=new URL(url);scoped.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=scoped.href;
const {Pool}=createRequire(new URL('../package.json',import.meta.url))('pg');
const raw=new Pool({connectionString:url.href,max:6,options:'-c search_path='+schema+',public'});
await raw.query('CREATE SCHEMA '+schema);
const names=(await raw.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND (tablename LIKE 'reverse_%' OR tablename IN ('work_jobs','work_job_audit','agent_profil_schalter','intern_schalter'))")).rows;
for(const {tablename:t}of names){assert.match(t,/^[a-z_0-9]+$/);await raw.query('CREATE TABLE '+schema+'.'+t+' (LIKE public.'+t+' INCLUDING ALL)');}
const auto=await import('../dist/services/reverse-nachzug-auto.js');
const pipe=await import('../dist/services/reverse-pipeline.js');
const {leseReverseEinstellwerte}=await import('../dist/services/reverse-einstellwerte.js');
const pool={async connect(){return raw.connect();},query:(s,p)=>raw.query(s,p)};
const sha=n=>String(n).padStart(64,'0').replace(/[^0-9a-f]/g,'a');
const rid='rev-t275-'+randomUUID().slice(0,8);
await raw.query("INSERT INTO reverse_eintraege(id,titel,status,analyse_policy) VALUES($1,'Synthetic T275','bestaetigt','{\"automatisch\":true}')",[rid]);
const medium=async(position,art,groesse)=>String((await raw.query("INSERT INTO reverse_medien(eintrag_id,position,art,status,satz_sha256,groesse) VALUES($1,$2,$3,'vollstaendig',$4,$5) RETURNING id",[rid,position,art,sha('m'+position),groesse])).rows[0].id);
const gross=await medium(0,'image',700_000_000),klein=await medium(1,'archiv',10_000_000);
// Ordner-Medien laesst die E-Schleife von entdecke() aus: Auftraege darauf bleiben als Vorrang-Blocker unberuehrt.
const ordner=await medium(2,'ordner',null);
const blocker=async prio=>{const id=randomUUID();await raw.query("INSERT INTO reverse_auftraege(id,eintrag_id,medium_id,schicht,status,ausloeser,prioritaet,projekt) VALUES($1,$2,$3,'E','wartet','agent:x',$4,'reverse-bibliothek')",[id,rid,ordner,prio]);return id;};
async function setting(name,wert){
 await raw.query("DELETE FROM reverse_einstellungen WHERE ebene='global' AND name=$1",[name]);
 await raw.query("INSERT INTO reverse_einstellungen(ebene,project,eintrag_id,name,wert_text,grund,gesetzt_von) VALUES('global',NULL,NULL,$1,$2,'T275','fixture')",[name,String(wert)]);
}
const ein=()=>leseReverseEinstellwerte({},pool);
const eAuftraege=async mid=>(await raw.query("SELECT prioritaet,status FROM reverse_auftraege WHERE medium_id=$1 AND datei_id IS NULL AND schicht='E' ORDER BY created_at",[mid])).rows;
const dienst=new pipe.ReversePipelineDienst({pool:raw,ausfuehrbareKinds:[]});
// Projekt-Rueckstand der gemeinsamen Testdatenbank ist nicht steuerbar: Schwellen 0 = nicht pruefen.
await setting('nachzug_vorrang_chunks_max',0);await setting('nachzug_vorrang_parse_max',0);
test.after(async()=>{await dienst.beende();await raw.query('DROP SCHEMA '+schema+' CASCADE');await raw.end();});

test('H-1: offener Leser-Nachzug setzt den Nachzug nur bei reverse_leser an aus',async()=>{
 await raw.query("INSERT INTO reverse_leser_nachzug(eintrag_id,leser_id,scan_id,einstellungen_revision,policy_revision,status) VALUES($1,'l-t275',gen_random_uuid(),repeat('a',64),repeat('a',64),'offen')",[rid]);
 assert.equal(await auto.reverseLeserZaehlt(pool),false);
 assert.equal(await auto.reverseNachzugVorrang(pool,await ein()),null,'reverse_leser aus: kein Aussetzen');
 await raw.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,'reverse_leser',true,'T275','fixture')");
 assert.equal(await auto.reverseNachzugVorrang(pool,await ein()),'leser_nachzug_laeuft','reverse_leser an: Leser geht vor');
 await raw.query("DELETE FROM agent_profil_schalter WHERE funktion='reverse_leser'");
 await raw.query("DELETE FROM reverse_leser_nachzug WHERE leser_id='l-t275'");
});

test('anforderung: grosses Medium bekommt kein automatisches E, offenes Auto-E wird herabgestuft, kleines laeuft als Hintergrund',async()=>{
 await setting('e_auto_gross_ab_mb',256);await setting('e_auto_gross_modus','anforderung');
 const offen=randomUUID();
 await raw.query("INSERT INTO reverse_auftraege(id,eintrag_id,medium_id,schicht,status,ausloeser,prioritaet,projekt) VALUES($1,$2,$3,'E','wartet','agent:reverse-pipeline','hintergrund','reverse-bibliothek')",[offen,rid,gross]);
 assert.equal(await auto.reverseNachzugVorrangOffen(pool),true,'vorher: grosses Hintergrund-E blockiert den Nachzug');
 const vorher={...pipe.reverseDrosselStand.e_gross};
 await dienst['einstellungen']();await dienst['entdecke']();
 assert.equal((await raw.query('SELECT prioritaet FROM reverse_auftraege WHERE id=$1',[offen])).rows[0].prioritaet,'nachzug','herabgestuft');
 assert.equal(pipe.reverseDrosselStand.e_gross.herabgestuft,vorher.herabgestuft+1);
 assert.equal(pipe.reverseDrosselStand.e_gross.modus,'anforderung');
 assert.ok(pipe.reverseDrosselStand.e_gross.zurueckgehalten>vorher.zurueckgehalten,'grosses Medium zurueckgehalten');
 assert.deepEqual((await eAuftraege(gross)).map(a=>a.prioritaet),['nachzug'],'kein neues E fuer das grosse Medium');
 assert.ok((await eAuftraege(klein)).some(a=>a.prioritaet==='hintergrund'),'kleines Medium: E als Hintergrund');
 await raw.query('DELETE FROM reverse_auftraege WHERE eintrag_id=$1',[rid]);
 await raw.query('DELETE FROM reverse_schichten WHERE medium_id IN ($1,$2)',[gross,klein]);
});

test('nachrang: grosses E erst ohne Vorrang und ohne offenen Nachzug, dann mit Prioritaet nachzug',async()=>{
 await setting('e_auto_gross_modus','nachrang');
 // Vorrang offen (interaktiver Auftrag eines anderen Mediums): grosses E wartet.
 const b=await blocker('interaktiv');
 await dienst['einstellungen']();await dienst['entdecke']();
 assert.equal((await eAuftraege(gross)).length,0,'Vorrang offen: kein grosses E');
 assert.equal(pipe.reverseDrosselStand.e_gross.letzter_grund,'vorrang_offen');
 // Offener Nachzug (nicht E): grosses E wartet weiter.
 await raw.query('DELETE FROM reverse_auftraege WHERE id=$1',[b]);
 const nz=randomUUID();
 // Das kleine Medium hat aus dem ersten Schritt ein gescheitertes E (kein_ausfuehrer, ausfuehrbareKinds leer): nicht offen.
 await raw.query("INSERT INTO reverse_auftraege(id,eintrag_id,medium_id,schicht,status,ausloeser,prioritaet,projekt) VALUES($1,$2,$3,'S3','wartet','agent:reverse-nachzug-auto','nachzug','reverse-bibliothek')",[nz,rid,ordner]);
 await dienst['entdecke']();
 assert.equal((await eAuftraege(gross)).length,0,'offener Nachzug: kein grosses E');
 assert.equal(pipe.reverseDrosselStand.e_gross.letzter_grund,'nachzug_offen:1');
 // Frei: genau ein grosses E mit Prioritaet nachzug.
 await raw.query('DELETE FROM reverse_auftraege WHERE id=$1',[nz]);
 await dienst['entdecke']();
 assert.deepEqual((await eAuftraege(gross)).map(a=>a.prioritaet),['nachzug'],'nachrangig eingereiht');
 assert.match(String(pipe.reverseDrosselStand.e_gross.letzter_grund),/^nachrang_eingereiht:/);
 assert.equal(await auto.reverseNachzugVorrangOffen(pool),false,'grosses E blockiert den Nachzug nicht');
 await setting('e_auto_gross_ab_mb',0);
 await raw.query('DELETE FROM reverse_auftraege WHERE eintrag_id=$1',[rid]);
});

test('Marken gebuendelt: pipeline_gesehen_at je Block, Vorschau nennt Vorrang-Grund und grosse Medien',async()=>{
 await setting('pipeline_schreib_block_zeilen',1);await setting('e_auto_gross_ab_mb',256);await setting('e_auto_gross_modus','anforderung');
 const ids=[];
 for(const p of ['b/a.bin','b/b.bin'])ids.push(String((await raw.query("INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,sha256,groesse,art,storage_key) VALUES($1,$2,$3,$4,1,'binaer',$5) RETURNING id",[rid,klein,p,sha(p.length+ids.length+90),rid+'/entpackt/m'+klein+'/'+p])).rows[0].id));
 const vorher={...pipe.reverseDrosselStand.schreib_bloecke};
 await dienst['einstellungen']();await dienst['entdecke']();
 const gesehen=(await raw.query('SELECT count(*)::int AS n FROM reverse_dateien WHERE id=ANY($1::bigint[]) AND pipeline_gesehen_at IS NOT NULL',[ids])).rows[0].n;
 assert.equal(gesehen,2,'beide Dateien markiert');
 assert.ok(pipe.reverseDrosselStand.schreib_bloecke.stapel>=vorher.stapel+2,'Blockgroesse 1: ein Stapel je Datei');
 assert.ok(pipe.reverseDrosselStand.schreib_bloecke.zeilen>=vorher.zeilen+2);
 pipe.vergissReverseEinmaligVorschau();
 await raw.query("DELETE FROM reverse_auftraege WHERE eintrag_id=$1 AND status IN ('offen','wartet','laeuft')",[rid]);
 const hb=await blocker('hintergrund');
 const v=await pipe.reverseEinmaligVorschau(pool);
 assert.equal(v.nachzug_vorrang.grund,'vorrang_offen','Vorschau nennt den aktuellen Vorrang-Grund');
 await raw.query('DELETE FROM reverse_auftraege WHERE id=$1',[hb]);
 assert.equal(v.e_gross.grenze_mb,256);assert.equal(v.e_gross.modus,'anforderung');
 assert.equal(v.bei_an.neue_medien_ohne_e_gross,1,'nur das grosse Medium ist ohne E und gross');
 const z=await pipe.reverseEinmaligVorschau(pool);
 assert.equal(z.aus_zwischenspeicher,true);assert.equal(z.nachzug_vorrang.grund,null,'Vorrang-Grund auch aus dem Zwischenspeicher frisch gemessen');
 await setting('e_auto_gross_ab_mb',0);
});
