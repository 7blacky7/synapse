/** P18-T98/T111: Nachzug-Policy (Altauftraege, auto_grenze), S1-Neu-Parsen- und S3-Auto-Takt, reverse(neu_parsen). Nur privates synapse_test-Schema. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',SYNAPSE_INTERN_TOOL:'0',QDRANT_URL:'http://127.0.0.1:1',SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:'/tmp/p18-t98-reverse'});
const schema='p18_t98_'+randomUUID().replaceAll('-','');
const scoped=new URL(url);scoped.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=scoped.href;
const {Pool}=createRequire(new URL('../package.json',import.meta.url))('pg');
const raw=new Pool({connectionString:url.href,max:6,options:'-c search_path='+schema+',public'});
await raw.query('CREATE SCHEMA '+schema);
const names=(await raw.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND (tablename LIKE 'reverse_%' OR tablename IN ('work_jobs','work_job_audit','agent_profil_schalter','intern_schalter'))")).rows;
for(const {tablename:t}of names){assert.match(t,/^[a-z_0-9]+$/);await raw.query('CREATE TABLE '+schema+'.'+t+' (LIKE public.'+t+' INCLUDING ALL)');}
const policy=await import('../dist/services/reverse-analyse-policy.js');
const auto=await import('../dist/services/reverse-nachzug-auto.js');
const {fuehreNeuParsenAus}=await import('../dist/services/reverse-neu-parsen.js');
const {leseReverseEinstellwerte}=await import('../dist/services/reverse-einstellwerte.js');
const pool={async connect(){return raw.connect();},query:(s,p)=>raw.query(s,p)};
// Projekt-Backlog der gemeinsamen Testdatenbank ist nicht steuerbar: Takt-Tests pruefen nur den Reverse-Vorrang, der Rest eigene Faelle.
const nurReverse=async db=>(await auto.reverseNachzugVorrangOffen(db))?'vorrang_offen':null;
const tx=async fn=>{const c=await raw.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
const sha=n=>String(n).padStart(64,'0').replace(/[^0-9a-f]/g,'a');
const rid='rev-t98-'+randomUUID().slice(0,8);
await raw.query("INSERT INTO reverse_eintraege(id,titel,status,analyse_policy) VALUES($1,'Synthetic T98','bestaetigt','{\"automatisch\":true}')",[rid]);
const mid=String((await raw.query("INSERT INTO reverse_medien(eintrag_id,position,art,status,satz_sha256) VALUES($1,0,'ordner','vollstaendig',$2) RETURNING id",[rid,sha('m')])).rows[0].id);
// R5 (61f66a9e): nur aktive Eintraege = bestaetigt + aktuelle fertige E-Schicht.
const eSchicht=()=>raw.query("INSERT INTO reverse_schichten(medium_id,schicht,fingerabdruck,status,werkzeug,werkzeug_version,profil_version,aktuell) VALUES($1,'E',$2,'fertig','reverse-E','v','p',true) ON CONFLICT DO NOTHING",[mid,sha('e')]);
await eSchicht();
let nr=0;
async function datei(pfad,{format=null,groesse=10,s1Profil='alt-profil',s3Version=null}={}){
 nr++;
 const id=String((await raw.query("INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,sha256,groesse,art,format,storage_key) VALUES($1,$2,$3,$4,$5,'binaer',$6,$7) RETURNING id",
  [rid,mid,pfad,sha(1000+nr),groesse,format,rid+'/entpackt/m'+mid+'/'+pfad])).rows[0].id);
 if(s1Profil)await raw.query("INSERT INTO reverse_schichten(datei_id,schicht,fingerabdruck,status,werkzeug,werkzeug_version,profil_version,aktuell) VALUES($1,'S1',$2,'fertig','asset-inspektoren','v',$3,true)",[id,sha(5000+nr),s1Profil]);
 if(s3Version)await raw.query("INSERT INTO reverse_schichten(datei_id,schicht,fingerabdruck,status,werkzeug,werkzeug_version,profil_version,aktuell) VALUES($1,'S3',$2,'fertig','reverse-S3',$3,'p',true)",[id,sha(7000+nr),s3Version]);
 return id;
}
async function setting(name,wert,ebene='global'){
 await raw.query('DELETE FROM reverse_einstellungen WHERE ebene=$1 AND name=$2 AND eintrag_id IS NOT DISTINCT FROM $3',[ebene,name,ebene==='eintrag'?rid:null]);
 await raw.query("INSERT INTO reverse_einstellungen(ebene,project,eintrag_id,name,wert_text,grund,gesetzt_von) VALUES($1,NULL,$2,$3,$4,'T98','fixture')",[ebene,ebene==='eintrag'?rid:null,name,String(wert)]);
}
const ein=()=>leseReverseEinstellwerte({},pool);
const aufrufe=[];
const einreihen=antwort=>async a=>{aufrufe.push(a);return typeof antwort==='function'?antwort(a):antwort;};
const marke=async id=>(await raw.query("SELECT metadaten->'nachzug_auto' AS m FROM reverse_dateien WHERE id=$1",[id])).rows[0].m;
const legacyE=async status=>(await raw.query("INSERT INTO reverse_auftraege(id,eintrag_id,medium_id,schicht,status,ausloeser,projekt) VALUES($1,$2,$3,'E',$4,'agent:alt','synapse') RETURNING id",[randomUUID(),rid,mid,status])).rows[0].id;
const pin=(dateiId,o={})=>tx(c=>policy.bereiteReversePolicyPin(c,{id:randomUUID(),reverseId:rid,dateiId,mediumId:mid,angefragt:o.angefragt??'S1',manuell:!!o.manuell,project:'reverse-bibliothek',...o}));
const auftragMitPin=async(dateiId,p,schicht='S1',status='wartet',prio='nachzug')=>(await raw.query("INSERT INTO reverse_auftraege(id,eintrag_id,datei_id,schicht,status,ausloeser,policy_pin,ziel_schicht,projekt,prioritaet) VALUES($1,$2,$3,$4,$5,'agent:reverse-nachzug-auto',$6,$7,'reverse-bibliothek',$8) RETURNING id::text",[randomUUID(),rid,dateiId,schicht,status,JSON.stringify(p),p.wirksam_bis,prio])).rows[0].id;
// 61f66a9e: auch Dateien/Schichten frueherer Faelle entfernen, sonst bleiben sie Kandidaten (742 statt 745, wartet 7 statt 1).
const leeren=async()=>{
 await raw.query("DELETE FROM reverse_auftraege WHERE eintrag_id=$1",[rid]);
 await raw.query("DELETE FROM reverse_schichten WHERE datei_id IN (SELECT id FROM reverse_dateien WHERE eintrag_id=$1)",[rid]);
 await raw.query("DELETE FROM reverse_dateien WHERE eintrag_id=$1",[rid]);
};

test.after(async()=>{await raw.query('DROP SCHEMA '+schema+' CASCADE');await raw.end();});

test('T98 Ursache: abgeschlossener Alt-E-Auftrag ohne Pin blockiert nur ohne Flag',async()=>{
 await leeren();const d=await datei('x/a.bin');await legacyE('teilweise');
 await assert.rejects(pin(d),e=>e.code==='policy_pin_fehlt','Altbestand: ohne Flag weiter gehalten (Verhalten unveraendert)');
 const p=await pin(d,{ohneLegacyAbgeschlossen:true});
 assert.equal(p.ohne_legacy_abgeschlossen,true);assert.equal(p.wirksam_bis,'S1');assert.deepEqual(p.vorgaben,[]);
 const id=await auftragMitPin(d,p);
 const g=await tx(c=>policy.pruefeReversePolicyAuftrag(c,id,rid,'S1'));assert.equal(g.ohne_legacy_abgeschlossen,true);
});
test('T98: offener Alt-Auftrag ohne Pin haelt auch mit Flag',async()=>{
 await leeren();const d=await datei('x/b.bin');await legacyE('wartet');
 await assert.rejects(pin(d,{ohneLegacyAbgeschlossen:true}),e=>e.code==='policy_pin_fehlt');
});
test('T111: auto_grenze S3 nur automatisch, nur mit s3_auto an, Vorgaben begrenzen weiter',async()=>{
 await leeren();await setting('analyse_bis_schicht','S1');await setting('s3_auto','an');
 const d=await datei('x/c.dll',{format:'pe'});
 const ohne=await pin(d,{ohneLegacyAbgeschlossen:true});assert.equal(ohne.wirksam_bis,'S1','ohne autoGrenze bleibt analyse_bis_schicht');
 const p=await pin(d,{ohneLegacyAbgeschlossen:true,autoGrenze:'S3'});assert.equal(p.wirksam_bis,'S3');assert.equal(p.auto_grenze,'S3');
 const id=await auftragMitPin(d,p,'S3');
 await tx(c=>policy.pruefeReversePolicyAuftrag(c,id,rid,'S3'));
 await setting('s3_auto','aus');
 await assert.rejects(tx(c=>policy.pruefeReversePolicyAuftrag(c,id,rid,'S3')),e=>e.code==='policy_geaendert','Schalter aus deckt den Pin nicht mehr');
 await setting('s3_auto','an');
 const m=await pin(d,{manuell:true,angefragt:'S1',autoGrenze:'S3'});assert.equal(m.wirksam_bis,'S1');assert.equal(m.auto_grenze,undefined,'manuell: keine Auto-Grenze');
 await auftragMitPin(d,m,'S1','fertig');
 const begrenzt=await pin(d,{ohneLegacyAbgeschlossen:true,autoGrenze:'S3'});assert.equal(begrenzt.wirksam_bis,'S1','manueller Root S1 begrenzt die Automatik');
});
test('T98 Takt: Schalter aus, Parser aus, Deckel, Prioritaet, Marke, Vorrang',async()=>{
 await leeren();aufrufe.length=0;
 const a=await datei('s1/a.txt'),b=await datei('s1/b.txt'),c=await datei('s1/c.txt',{s1Profil:'parser-s1:neu'});
 await setting('s1_neu_parsen_auto','aus');
 assert.equal((await auto.reverseS1NeuParsenTakt({vorrang:nurReverse,pool,ein:await ein(),parserProfil:'parser-s1:neu',s3Kennung:'w',einreihen:einreihen({status:'wartet'})})).grund,'s1_neu_parsen_auto_aus');
 await setting('s1_neu_parsen_auto','an');await setting('s1_neu_parsen_schritt',1);
 assert.equal((await auto.reverseS1NeuParsenTakt({vorrang:nurReverse,pool,ein:await ein(),parserProfil:null,s3Kennung:'w',einreihen:einreihen({status:'wartet'})})).grund,'reverse_parser_adapter_aus');
 assert.equal(aufrufe.length,0);
 const t=await auto.reverseS1NeuParsenTakt({vorrang:nurReverse,pool,ein:await ein(),parserProfil:'parser-s1:neu',s3Kennung:'w',einreihen:einreihen({status:'wartet'})});
 assert.equal(t.kandidaten,1,'Deckel s1_neu_parsen_schritt=1');
 assert.deepEqual([aufrufe[0].bisSchicht,aufrufe[0].prioritaet,aufrufe[0].ohneLegacyAbgeschlossen,aufrufe[0].dateiId],['S1','nachzug',true,a]);
 assert.equal((await marke(a)).s1_kennung,'parser-s1:neu');
 assert.ok(!aufrufe.some(x=>x.dateiId===c),'aktuelles Parser-Profil wird nicht neu geparst');
 await setting('s1_neu_parsen_schritt',50);
 await auto.reverseS1NeuParsenTakt({vorrang:nurReverse,pool,ein:await ein(),parserProfil:'parser-s1:neu',s3Kennung:'w',einreihen:einreihen({status:'wartet'})});
 assert.deepEqual(aufrufe.map(x=>x.dateiId),[a,b],'markierte Datei kommt je Profil nur einmal');
 await raw.query("INSERT INTO reverse_auftraege(id,eintrag_id,datei_id,schicht,status,ausloeser,prioritaet) VALUES($1,$2,$3,'S0','wartet','agent:x','interaktiv')",[randomUUID(),rid,c]);
 assert.equal((await auto.reverseS1NeuParsenTakt({vorrang:nurReverse,pool,ein:await ein(),parserProfil:'parser-s1:neuer',s3Kennung:'w',einreihen:einreihen({status:'wartet'})})).ausgesetzt,'vorrang_offen');
});
test('T98 Takt: voruebergehend ohne Marke, Fehler mit Marke und Takt laeuft weiter',async()=>{
 await leeren();aufrufe.length=0;await setting('s1_neu_parsen_auto','an');await setting('s1_neu_parsen_schritt',50);
 const d1=await datei('f/1.txt',{s1Profil:'p-alt2'}),d2=await datei('f/2.txt',{s1Profil:'p-alt2'});
 const voll=await auto.reverseS1NeuParsenTakt({vorrang:nurReverse,pool,ein:await ein(),parserProfil:'parser-s1:f',s3Kennung:'w',einreihen:einreihen({status:'fehler',fehlercode:'warteschlange_voll'})});
 assert.equal(voll.ergebnisse['fehler:warteschlange_voll'],1,'Abbruch nach warteschlange_voll');
 assert.equal((await marke(d1)).s1_kennung,undefined,'voruebergehend: keine Dauer-Marke');assert.ok((await marke(d1)).s1_versuch_at);
 const r=await auto.reverseS1NeuParsenTakt({vorrang:nurReverse,pool,ein:await ein(),parserProfil:'parser-s1:f',s3Kennung:'w',einreihen:einreihen(a=>a.dateiId===d1?{status:'fehler',fehlercode:'policy_grenze'}:{status:'wartet'})});
 assert.equal(r.ergebnisse['fehler:policy_grenze'],1);assert.equal(r.ergebnisse.wartet,1);
 assert.equal((await marke(d1)).s1_fehler,true);assert.equal((await marke(d2)).s1_fehler,false);
 assert.equal((await marke(d1)).s1_kennung,undefined,'policy_grenze ist nicht deterministisch: Datei bleibt Kandidat');
 aufrufe.length=0;
 await auto.reverseS1NeuParsenTakt({vorrang:nurReverse,pool,ein:await ein(),parserProfil:'parser-s1:f',s3Kennung:'w',einreihen:einreihen({status:'wartet'})});
 assert.deepEqual(aufrufe.map(x=>x.dateiId),[d1],'nach voruebergehendem Fehler wieder Kandidat');
 const wurf=await auto.reverseNachzugAutoTakt({vorrang:nurReverse,pool,ein:await ein(),parserProfil:'parser-s1:g',s3Kennung:'w',einreihen:async()=>{throw Object.assign(Error('x'),{code:'werkzeug_fehler'});}});
 assert.ok(wurf.s1,'Gesamttakt wirft nie');
});
test('T111 Takt: nur PE, kleinste zuerst, Deckel, auto_grenze, Werkzeugstand',async()=>{
 await leeren();aufrufe.length=0;await setting('s1_neu_parsen_auto','aus');await setting('s3_auto','an');await setting('s3_auto_offen_max',1);await setting('s3_auto_schritt',1);
 const gross=await datei('p/gross.exe',{format:'pe',groesse:900,s1Profil:'parser-s1:p'});
 const klein=await datei('p/klein.DLL',{format:'pe',groesse:5,s1Profil:'parser-s1:p'});
 await datei('p/bild.jpg',{format:'jpeg',groesse:1,s1Profil:'parser-s1:p'});
 await datei('p/alt.exe',{format:'pe',groesse:2,s1Profil:'alt'});
 await datei('p/fertig.dll',{format:'pe',groesse:3,s1Profil:'parser-s1:p',s3Version:'ghidra-1'});
 const k={vorrang:nurReverse,pool,ein:await ein(),parserProfil:'parser-s1:p',s3Kennung:'ghidra-1',einreihen:einreihen({status:'wartet'})};
 const t=await auto.reverseS3AutoTakt(k);
 assert.equal(t.kandidaten,1);
 assert.deepEqual([aufrufe[0].dateiId,aufrufe[0].bisSchicht,aufrufe[0].autoGrenze,aufrufe[0].prioritaet],[klein,'S3','S3','nachzug']);
 assert.equal((await marke(klein)).s3_kennung,'ghidra-1');
 await raw.query("INSERT INTO reverse_auftraege(id,eintrag_id,datei_id,schicht,status,ausloeser,prioritaet,ziel_schicht) VALUES($1,$2,$3,'S3','wartet','agent:reverse-nachzug-auto','nachzug','S3')",[randomUUID(),rid,klein]);
 assert.equal((await auto.reverseS3AutoTakt(k)).ausgesetzt,'deckel_erreicht');
 await raw.query("DELETE FROM reverse_auftraege WHERE eintrag_id=$1",[rid]);
 await auto.reverseS3AutoTakt(k);assert.equal(aufrufe.at(-1).dateiId,gross);
 const neu={...k,s3Kennung:'ghidra-2'};aufrufe.length=0;await setting('s3_auto_schritt',5);await setting('s3_auto_offen_max',5);
 await auto.reverseS3AutoTakt({...neu,ein:await ein()});
 assert.equal(aufrufe.length,3,'neuer Werkzeugstand: klein, fertig und gross je einmal (alt.exe ohne aktuelles S1-Profil nicht)');
 await setting('s3_auto','aus');
 assert.equal((await auto.reverseS3AutoTakt({...k,ein:await ein()})).grund,'s3_auto_aus');
});
test('T98: Policy-Abweisung in queue() landet im Fehlerlog (ein Eintrag je Vorgabe, zaehlt hoch)',async()=>{
 await leeren();await raw.query('DELETE FROM reverse_fehlerlog');
 await raw.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,'reverse_fehlerlog',true,'T98','fixture')");
 const {ReversePipelineDienst}=await import('../dist/services/reverse-pipeline.js');
 const dienst=new ReversePipelineDienst({pool:raw,ausfuehrbareKinds:[]});
 const legacy=await legacyE('fertig');
 await raw.query("UPDATE reverse_auftraege SET status='wartet' WHERE id=$1",[legacy]);
 const d1=await datei('q/1.bin'),d2=await datei('q/2.bin');
 for(const d of [d1,d2]){
  const r=await dienst.nachziehen({reverseId:rid,project:'reverse-bibliothek',agentId:'t98',dateiId:d,mediumId:mid,bisSchicht:'S1',prioritaet:'nachzug'});
  assert.equal(r.fehlercode,'policy_pin_fehlt');
 }
 let zeilen=[];
 for(let i=0;i<20&&!(zeilen[0]?.anzahl>=2);i++){await new Promise(r=>setTimeout(r,100));zeilen=(await raw.query("SELECT komponente,name,grund,datei,anzahl FROM reverse_fehlerlog WHERE eintrag_id=$1",[rid])).rows;}
 assert.equal(zeilen.length,1,'ein Eintrag je blockierendem Auftrag');
 assert.deepEqual([zeilen[0].komponente,zeilen[0].name,zeilen[0].grund,zeilen[0].datei],['policy','queue_policy','policy_pin_fehlt','vorgabe:'+legacy]);
 assert.equal(Number(zeilen[0].anzahl),2,'Wiederholung zaehlt hoch');
 await raw.query("DELETE FROM agent_profil_schalter WHERE funktion='reverse_fehlerlog'");
 await dienst.beende();
});
test('Review 6b9112b6 (4): reverse_s3 aus -> keine Dauer-Marke, nach Einschalten wieder Kandidat; Versuchte ruecken nach hinten',async()=>{
 await leeren();aufrufe.length=0;await setting('s3_auto','an');await setting('s3_auto_offen_max',5);await setting('s3_auto_schritt',1);
 const x=await datei('r/x.dll',{format:'pe',groesse:1,s1Profil:'parser-s1:r'}),y=await datei('r/y.dll',{format:'pe',groesse:2,s1Profil:'parser-s1:r'});
 const k={vorrang:nurReverse,pool,ein:await ein(),parserProfil:'parser-s1:r',s3Kennung:'g-r'};
 await auto.reverseS3AutoTakt({...k,einreihen:einreihen({status:'fehler',fehlercode:'kein_ausfuehrer',fehler_detail:'reverse_s3_aus'})});
 assert.equal((await marke(x)).s3_kennung,undefined);
 await auto.reverseS3AutoTakt({...k,einreihen:einreihen({status:'wartet'})});
 assert.deepEqual(aufrufe.map(a=>a.dateiId),[x,y],'versuchte Datei x rueckt hinter y');
 await auto.reverseS3AutoTakt({...k,einreihen:einreihen({status:'wartet'})});
 assert.equal(aufrufe.at(-1).dateiId,x,'x wieder Kandidat und wird nun eingereiht');assert.equal((await marke(x)).s3_kennung,'g-r');
});
test('Review 6b9112b6 (2): Vorrang Leser-Nachzug und Projekt-Backlog setzen aus',async()=>{
 await leeren();aufrufe.length=0;await setting('s3_auto','an');await setting('s1_neu_parsen_auto','an');
 await datei('v/a.dll',{format:'pe',s1Profil:'parser-s1:v'});
 await raw.query("INSERT INTO reverse_leser_nachzug(eintrag_id,leser_id,scan_id,einstellungen_revision,policy_revision,status) VALUES($1,'l-t98',gen_random_uuid(),repeat('a',64),repeat('a',64),'offen')",[rid]);
 assert.equal(await auto.reverseNachzugVorrang(pool),'leser_nachzug_laeuft');
 assert.equal((await auto.reverseS3AutoTakt({pool,ein:await ein(),parserProfil:'parser-s1:v',s3Kennung:'g',einreihen:einreihen({status:'wartet'})})).ausgesetzt,'leser_nachzug_laeuft','Standard-Vorrang greift');
 await raw.query("DELETE FROM reverse_leser_nachzug WHERE leser_id='l-t98'");
 for(const grund of ['projekt_parse_backlog','projekt_chunks_offen']){
  assert.equal((await auto.reverseS1NeuParsenTakt({vorrang:async()=>grund,pool,ein:await ein(),parserProfil:'parser-s1:neu2',s3Kennung:'g',einreihen:einreihen({status:'wartet'})})).ausgesetzt,grund);
  assert.equal((await auto.reverseS3AutoTakt({vorrang:async()=>grund,pool,ein:await ein(),parserProfil:'parser-s1:v',s3Kennung:'g',einreihen:einreihen({status:'wartet'})})).ausgesetzt,grund);
 }
 assert.equal(aufrufe.length,0,'bei Vorrang wird nichts eingereiht');
});
test('Review 6b9112b6 (1): entdecke() reiht veraltete Parser-S1 nicht mehr selbst ein (nur ueber Drossel)',async()=>{
 await leeren();
 await raw.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,'reverse_parser_adapter',true,'T98','fixture')");
 const {ReversePipelineDienst}=await import('../dist/services/reverse-pipeline.js');
 const dienst=new ReversePipelineDienst({pool:raw,ausfuehrbareKinds:[]});
 await dienst['einstellungen']();
 const alt=await datei('e/alt.txt',{s1Profil:'kein-parser-profil'});
 await dienst['entdecke']();
 assert.equal((await raw.query('SELECT count(*)::int n FROM reverse_auftraege WHERE datei_id=$1',[alt])).rows[0].n,0,'Massen-Neueinreihung ueber entdecke umgangen? Nein');
 await raw.query("DELETE FROM agent_profil_schalter WHERE funktion='reverse_parser_adapter'");
 await dienst.beende();
});
test('Review 6b9112b6 (3): neu_parsen ausfuehren nutzt die Leser-Verwalter-Pruefung (Koordinator/User/Main-Agent)',async()=>{
 const {readFile}=await import('node:fs/promises');
 const src=await readFile(new URL('../src/services/reverse-tool.ts',import.meta.url),'utf8');
 const block=src.slice(src.indexOf('(NEU_PARSEN_ACTIONS as readonly string[]).includes(action)'),src.indexOf("if(action==='uebernehmen')"));
 assert.match(block,/if\(!vorschau\)await pruefeReverseLeserVerwalter\(pool,project\)/,'Ausfuehren: pruefeReverseLeserVerwalter (Main-Agent eingeschlossen, siehe reverse-leser-tool Tests)');
 assert.doesNotMatch(block,/!vorschau\|\|/,'kein reines darfKoordinatorOderUser fuer Ausfuehren');
});
test('R5 (61f66a9e): Eintrag ohne aktuelle fertige E-Schicht liefert keine Kandidaten',async()=>{
 await leeren();aufrufe.length=0;await setting('s1_neu_parsen_auto','an');await setting('s1_neu_parsen_schritt',50);await setting('s3_auto','an');await setting('s3_auto_offen_max',5);await setting('s3_auto_schritt',5);
 await datei('i/a.txt',{s1Profil:'alt-i'});await datei('i/b.dll',{format:'pe',s1Profil:'parser-s1:i'});
 await raw.query("UPDATE reverse_schichten SET aktuell=false WHERE medium_id=$1 AND schicht='E'",[mid]);
 try{
  const k={vorrang:nurReverse,pool,ein:await ein(),parserProfil:'parser-s1:i',s3Kennung:'g-i',einreihen:einreihen({status:'wartet'})};
  assert.equal((await auto.reverseS1NeuParsenTakt(k)).kandidaten,0);assert.equal((await auto.reverseS3AutoTakt(k)).kandidaten,0);
  assert.equal(aufrufe.length,0,'inaktiver Eintrag wird nicht angefasst');
 }finally{await raw.query("UPDATE reverse_schichten SET aktuell=true WHERE medium_id=$1 AND schicht='E'",[mid]);}
 const k={vorrang:nurReverse,pool,ein:await ein(),parserProfil:'parser-s1:i',s3Kennung:'g-i',einreihen:einreihen({status:'wartet'})};
 assert.equal((await auto.reverseS1NeuParsenTakt(k)).kandidaten,1,'aktiv: S1-Kandidat');
});
test('R4 (887c23b1): gehalten, kein_ausfuehrer und policy_* setzen nie eine Dauer-Marke',async()=>{
 await leeren();await setting('s1_neu_parsen_auto','an');await setting('s1_neu_parsen_schritt',50);
 for(const [i,antwort] of [{status:'gehalten',fehlercode:null},{status:'fehler',fehlercode:'kein_ausfuehrer'},{status:'fehler',fehlercode:'policy_pin_fehlt'},{status:'fehler',fehlercode:'policy_geaendert'}].entries()){
  const d=await datei('g/'+i+'.txt',{s1Profil:'alt-g'});
  await auto.reverseS1NeuParsenTakt({vorrang:nurReverse,pool,ein:await ein(),parserProfil:'parser-s1:g'+i,s3Kennung:'w',einreihen:einreihen(a=>a.dateiId===d?antwort:{status:'fehler',fehlercode:'warteschlange_voll'})});
  assert.equal((await marke(d)).s1_kennung,undefined,JSON.stringify(antwort)+' darf nicht dauerhaft markieren');
  assert.ok((await marke(d)).s1_versuch_at);
 }
});
test('Vorrang-Schwellen: 0 = nicht pruefen, Grund mit Zahl im Debug',async()=>{
 await leeren();await setting('nachzug_vorrang_chunks_max',0);await setting('nachzug_vorrang_parse_max',0);
 assert.equal(await auto.reverseNachzugVorrang(pool,await ein()),null,'ohne offene Reverse-/Leser-Arbeit und Schwellen 0: kein Aussetzen trotz Dauer-Rueckstand');
 await raw.query("INSERT INTO reverse_auftraege(id,eintrag_id,medium_id,schicht,status,ausloeser,prioritaet) VALUES($1,$2,$3,'E','wartet','agent:x','hintergrund')",[randomUUID(),rid,mid]);
 assert.equal(await auto.reverseNachzugVorrang(pool,await ein()),'vorrang_offen');
 await leeren();await setting('nachzug_vorrang_chunks_max',1000);await setting('nachzug_vorrang_parse_max',100);
});
test('P18-T112 B: regulaere Discovery uebergeht abgeschlossenen Legacy-E ohne Pin, offener haelt weiter',async()=>{
 await leeren();
 const {ReversePipelineDienst}=await import('../dist/services/reverse-pipeline.js');
 const dienst=new ReversePipelineDienst({pool:raw,ausfuehrbareKinds:[]});
 await dienst['einstellungen']();
 const legacy=await legacyE('teilweise');
 const neu=await datei('t112/neu.bin',{s1Profil:null});
 await dienst['entdecke']();
 assert.ok((await raw.query('SELECT count(*)::int n FROM reverse_auftraege WHERE datei_id=$1',[neu])).rows[0].n>0,'neue Datei ohne S1 wird trotz Legacy-E eingereiht');
 await leeren();await raw.query("DELETE FROM reverse_auftraege WHERE id=$1",[legacy]);
 await legacyE('wartet');
 const gehalten=await datei('t112/gehalten.bin',{s1Profil:null});
 await dienst['entdecke']();
 assert.equal((await raw.query('SELECT count(*)::int n FROM reverse_auftraege WHERE datei_id=$1',[gehalten])).rows[0].n,0,'offener Legacy-Auftrag haelt weiter');
 await leeren();await raw.query("DELETE FROM reverse_auftraege WHERE eintrag_id=$1",[rid]);
 await dienst.beende();
});
// P18-T112 A (a4b2449f): echte PG-Proben ohne Leser-Runtime; Laufzeilen direkt im Testschema.
const nz=await import('../dist/services/reverse-leser-nachzug.js');
const L='d'.repeat(64),R0='0'.repeat(64),R1='1'.repeat(64),R2='2'.repeat(64),P='e'.repeat(64);
const lauf=async({id=randomUUID(),datei:did,status,rev,beendet='clock_timestamp()'})=>{
 const q=(await raw.query('SELECT sha256 FROM reverse_dateien WHERE id=$1',[did])).rows[0].sha256;
 await raw.query(`INSERT INTO reverse_leser_laeufe(id,leser_id,eintrag_id,datei_id,quell_sha256,generation,status,einstellungen_revision,diagnose,manifest_key,manifest_sha256,beendet_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,${beendet})`,[id,L,rid,did,q,randomUUID(),status,rev,JSON.stringify({nachzug:true,policy_revision:P}),
  status==='fertig'?'m/'+id:null,status==='fertig'?'f'.repeat(64):null]);
 return {id,sha:q};
};
test('P18-T112 A1: Ersatzscan haengt an veralteter Checkpoint-Revision + gescheiterter Quelle ohne Erfolg, nicht am Zeitstempel',async()=>{
 await leeren();await raw.query('DELETE FROM reverse_leser_laeufe');await raw.query('DELETE FROM reverse_leser_nachzug');await raw.query('DELETE FROM reverse_leser_zustaende');
 await raw.query("INSERT INTO reverse_leser_zustaende(leser_id,name,status,storage_key,paket_bytes,freigegeben_von,freigegeben_at) VALUES($1,'t112','aktiv','leser/t112',1,'fixture',clock_timestamp())",[L]);
 const d1=await datei('l/a.png',{s1Profil:null});
 const akt=await nz.reverseLeserNachzugRevisionen(raw,rid);
 const checkpoint=async(status,rev,pol,fehler=null)=>{await raw.query('DELETE FROM reverse_leser_nachzug');await raw.query(`INSERT INTO reverse_leser_nachzug(eintrag_id,leser_id,scan_id,scan_bis,quellstand,einstellungen_revision,policy_revision,status,fehlercode,updated_at)
  VALUES($1,$2,gen_random_uuid(),$3,clock_timestamp()+interval '1 minute',$4,$5,$6,$7,clock_timestamp()+interval '1 hour')`,[rid,L,d1,rev,pol,status,fehler]);};
 // 1) fertiger Scan unter alter Revision, ohne gescheiterte Quelle: nichts.
 await checkpoint('fertig',R0,P);
 assert.equal(await nz.waehleReverseLeserNachzugPaar(raw),undefined,'kein Fehlschlag: kein Ersatzscan');
 // 2) gescheiterter Lauf VOR dem (spaeteren) Checkpoint-Zeitstempel: trotzdem Ersatzscan (Zeitstempel egal).
 await lauf({datei:d1,status:'fehler',rev:R0,beendet:"clock_timestamp()-interval '1 day'"});
 assert.equal((await nz.waehleReverseLeserNachzugPaar(raw))?.status,'fertig','fertiger Scan alter Revision + gescheiterte Quelle -> Ersatzscan');
 // 3) Restpfad 04d5f2b9: offener alter Scan nach Pinfehler 'teilweise', updated_at nach den Fehlschlaegen -> Ersatzscan.
 await checkpoint('teilweise',R0,P,'leser_einstellungen_geaendert');
 const p3=await nz.waehleReverseLeserNachzugPaar(raw);
 assert.deepEqual([p3?.status,p3?.eintrag_id,p3?.leser_id],['teilweise',rid,L],'teilweise nach Pinfehler verdeckt die Fehlschlaege nicht');
 // 4) Checkpoint bereits unter aktueller Revision (nach dem Neustart): kein Dauer-Neuscan, auch wenn der Ersatz erneut scheitert.
 await checkpoint('fertig',akt.revision,akt.policy);
 assert.equal(await nz.waehleReverseLeserNachzugPaar(raw),undefined,'aktuelle Revision: kein erneuter Neustart');
 // 5) spaeterer Erfolg derselben Quelle: kein Ersatzscan, auch bei alter Revision.
 await checkpoint('teilweise',R0,P,'leser_einstellungen_geaendert');
 await lauf({datei:d1,status:'fertig',rev:R1});
 assert.equal(await nz.waehleReverseLeserNachzugPaar(raw),undefined,'Erfolg vorhanden: kein Ersatzscan');
 // Wiederaufnahme: planeReverseLeserNachzug ruft fuer dieses Paar punkt(neu=true) (Checkpoint neu unter aktueller Revision) und auftrag();
 // der volle plane()-Lauf braucht Leser-Runtime/Magicprobe und ist durch A2 (Laufwahl) + diese Paarwahl abgedeckt.
 await raw.query('DELETE FROM reverse_leser_laeufe');await raw.query('DELETE FROM reverse_leser_nachzug');
});
test('P18-T112 A2: Laufwahl – Erfolg irgendeiner Revision erledigt, nur Gescheitertes wird je Revision neu geplant',async()=>{
 await leeren();await raw.query('DELETE FROM reverse_leser_laeufe');
 const d1=await datei('l/b.png',{s1Profil:null});
 const sha=(await raw.query('SELECT sha256 FROM reverse_dateien WHERE id=$1',[d1])).rows[0].sha256;
 const quelle={eintrag_id:rid,id:d1,sha256:sha},I='3'.repeat(64);
 assert.deepEqual(await nz.reverseLeserLaufWahl(raw,quelle,L,{},I,R0,P),{art:'plan',identity:I,alt:undefined},'ohne Lauf: Basisidentitaet planen');
 await lauf({id:nz.reverseLeserLaufUuid(I),datei:d1,status:'fehler',rev:R0});
 const w1=await nz.reverseLeserLaufWahl(raw,quelle,L,{},I,R1,P);
 assert.equal(w1.art,'plan');assert.notEqual(w1.identity,I,'gescheitert + neue Revision: Ersatzidentitaet');assert.equal(w1.alt,undefined);
 assert.equal((await nz.reverseLeserLaufWahl(raw,quelle,L,{},I,R1,P)).identity,w1.identity,'Dedupe: gleiche Revision -> gleiche Ersatzidentitaet');
 await lauf({id:nz.reverseLeserLaufUuid(w1.identity),datei:d1,status:'fertig',rev:R1});
 const w2=await nz.reverseLeserLaufWahl(raw,quelle,L,{},I,R2,P);
 assert.deepEqual([w2.art,w2.id],['erledigt',nz.reverseLeserLaufUuid(w1.identity)],'erfolgreicher Ersatz einer frueheren Revision zaehlt als erledigt (kein Doppellauf)');
 await raw.query('DELETE FROM reverse_leser_laeufe');
 await lauf({id:nz.reverseLeserLaufUuid(I),datei:d1,status:'fertig',rev:R0});
 assert.equal((await nz.reverseLeserLaufWahl(raw,quelle,L,{},I,R2,P)).art,'erledigt','fertiger Basislauf alter Revision erledigt');
 await raw.query('DELETE FROM reverse_leser_laeufe');await leeren();
});
test('P18-T112 B2 (bbb29904): Folgeschritt S0 -> S1 einer neuen Datei unter abgeschlossenem Legacy-E erbt die Ausnahme',async()=>{
 await leeren();await raw.query('DELETE FROM reverse_auftraege WHERE eintrag_id=$1',[rid]);
 const legacy=await legacyE('teilweise');
 const d=await datei('t112/folge.bin',{s1Profil:null});
 // Root wie entdecke(): S0 mit Ausnahme, abgeschlossen.
 const root=await pin(d,{ohneLegacyAbgeschlossen:true});
 assert.equal(root.ohne_legacy_abgeschlossen,true);
 const rootId=await auftragMitPin(d,root,'S0','fertig','hintergrund');
 // Folgepin ohne eigenes Flag (wie reverse-pipeline.ts Folgequeue mit policyElternId): kein policy_pin_fehlt, Flag geerbt.
 const folge=await pin(d,{elternId:rootId});
 assert.equal(folge.ursprung,'folge');assert.equal(folge.ohne_legacy_abgeschlossen,true,'Ausnahme vom Eltern-Pin geerbt');
 const folgeId=await auftragMitPin(d,folge,'S1','wartet','hintergrund');
 await tx(c=>policy.pruefeReversePolicyAuftrag(c,folgeId,rid,'S1'));
 // Echter Folgeweg ueber die Pipeline-queue mit policyElternId (wie nach S0 -> S1).
 const {ReversePipelineDienst}=await import('../dist/services/reverse-pipeline.js');
 const dienst=new ReversePipelineDienst({pool:raw,ausfuehrbareKinds:[]});await dienst['einstellungen']();
 await raw.query('DELETE FROM reverse_auftraege WHERE id=$1',[folgeId]);
 // 14fabd17: S0 ist fertig (aktuelles Profil/Werkzeug der Pipeline), damit queue wirklich den S1-Folgeschritt waehlt.
 await raw.query("INSERT INTO reverse_schichten(datei_id,schicht,fingerabdruck,status,werkzeug,werkzeug_version,profil_version,auftrag_id,aktuell) VALUES($1,'S0',$2,'fertig','asset-inspektoren',$3,$4,$5,true)",
  [d,'9'.repeat(64),dienst['version'],dienst['profile'],rootId]);
 const r=await tx(c=>dienst['queue'](c,{reverseId:rid,project:'reverse-bibliothek',agentId:'reverse-pipeline',dateiId:d,mediumId:mid,bisSchicht:'S1',prioritaet:'hintergrund',policyElternId:rootId}));
 assert.notEqual(r.fehlercode,'policy_pin_fehlt','Folgequeue nicht mehr durch '+legacy+' blockiert: '+JSON.stringify(r));
 const neu=(await raw.query("SELECT schicht,status,policy_pin FROM reverse_auftraege WHERE datei_id=$1 AND id<>$2 ORDER BY created_at DESC LIMIT 1",[d,rootId])).rows[0];
 assert.equal(neu?.schicht,'S1','echter S1-Folgeauftrag: '+JSON.stringify(r));
 assert.equal(neu?.policy_pin?.ursprung,'folge');
 assert.equal(neu?.policy_pin?.ohne_legacy_abgeschlossen,true,'eingereihter Folgeauftrag traegt die Ausnahme');
 // Manueller Auftrag erbt nichts: weiter gehalten.
 await assert.rejects(pin(d,{manuell:true,elternId:rootId}),e=>e.code==='policy_pin_fehlt');
 // Koordinator-Entscheidung (14fabd17): abgeschlossene NULL-Pin-Altauftraege jeder Schicht geben nichts vor; ein OFFENER Legacy-S1
 // ohne Pin auf derselben Datei haelt weiter, auch mit Flag bzw. geerbtem Flag.
 await raw.query("INSERT INTO reverse_auftraege(id,eintrag_id,datei_id,schicht,status,ausloeser,projekt) VALUES($1,$2,$3,'S1','fertig','agent:alt','synapse')",[randomUUID(),rid,d]);
 assert.equal((await pin(d,{ohneLegacyAbgeschlossen:true})).ohne_legacy_abgeschlossen,true,'abgeschlossener Legacy-S1 ohne Pin: keine Vorgabe');
 await raw.query("INSERT INTO reverse_auftraege(id,eintrag_id,datei_id,schicht,status,ausloeser,projekt,created_at) VALUES($1,$2,$3,'S1','wartet','agent:alt','synapse',clock_timestamp()+interval '1 second')",[randomUUID(),rid,d]);
 await assert.rejects(pin(d,{ohneLegacyAbgeschlossen:true}),e=>e.code==='policy_pin_fehlt','offener Legacy-S1 ohne Pin haelt weiter');
 await assert.rejects(pin(d,{elternId:rootId}),e=>e.code==='policy_pin_fehlt','auch mit geerbtem Flag');
 await dienst.beende();await raw.query('DELETE FROM reverse_auftraege WHERE eintrag_id=$1',[rid]);await leeren();
});
test('P18-T112 A4 (51d793a5): 50 Paare unter aktueller Revision verdecken ein veraltetes 51. Paar nicht',async()=>{
 await leeren();for(const t of ['reverse_leser_laeufe','reverse_leser_nachzug','reverse_leser_zustaende'])await raw.query('DELETE FROM '+t);
 const d1=await datei('p/x.png',{s1Profil:null});
 const akt=await nz.reverseLeserNachzugRevisionen(raw,rid);
 const leser=n=>n.toString(16).padStart(64,'0');
 for(let i=1;i<=51;i++){
  const id=leser(i),veraltet=i===51;
  await raw.query("INSERT INTO reverse_leser_zustaende(leser_id,name,status,storage_key,paket_bytes,freigegeben_von,freigegeben_at) VALUES($1,$2,'aktiv',$3,1,'fixture',clock_timestamp())",[id,'t112-'+i,'leser/t112-'+i]);
  await raw.query(`INSERT INTO reverse_leser_nachzug(eintrag_id,leser_id,scan_id,scan_bis,quellstand,einstellungen_revision,policy_revision,status,updated_at)
   VALUES($1,$2,gen_random_uuid(),$3,clock_timestamp()+interval '1 minute',$4,$5,'fertig',clock_timestamp()+($6||' seconds')::interval)`,
   [rid,id,d1,veraltet?R0:akt.revision,akt.policy,String(i)]);
  const q=(await raw.query('SELECT sha256 FROM reverse_dateien WHERE id=$1',[d1])).rows[0].sha256;
  await raw.query(`INSERT INTO reverse_leser_laeufe(id,leser_id,eintrag_id,datei_id,quell_sha256,generation,status,einstellungen_revision,diagnose,beendet_at)
   VALUES(gen_random_uuid(),$1,$2,$3,$4,gen_random_uuid(),'fehler',$5,'{"nachzug":true}',clock_timestamp())`,[id,rid,d1,q,veraltet?R0:akt.revision]);
 }
 const p=await nz.waehleReverseLeserNachzugPaar(raw);
 assert.equal(p?.leser_id,leser(51),'veraltetes Paar hinter 50 aktuellen wird gefunden');
 for(const t of ['reverse_leser_laeufe','reverse_leser_nachzug','reverse_leser_zustaende'])await raw.query('DELETE FROM '+t);await leeren();
});
test('P18-T112 A3: planeReverseLeserNachzug – offener Scan, Pinfehler -> teilweise, Ersatz je Quelle genau einmal, kein Dauer-Neuscan',async()=>{
 // Kein Produktcode-Bypass: Leser-Runtime ueber die vorhandenen Registry-Tabellen, Magicprobe ueber echte Dateien im uebergebenen root.
 const {mkdtemp,mkdir,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join,dirname}=await import('node:path');
 await leeren();
 for(const t of ['reverse_leser_laeufe','reverse_leser_nachzug','reverse_leser_zustaende','reverse_leser','reverse_leser_runtime_ereignisse','reverse_leser_runtime_images','reverse_leser_runtimes','work_jobs'])await raw.query('DELETE FROM '+t);
 const PIN='a'.repeat(64),image={image:'synapse-reverse:t112',digest:'sha256:'+'b'.repeat(64)};
 await raw.query("INSERT INTO reverse_leser_runtimes(pin,vertrag,inhaltsindex,storage_key,quelle,bytes,erstellt_von) VALUES($1,'leser-python3-v1','{\"dateien\":[]}',$2,'{}',1,'fixture')",[PIN,'.intern/leser-runtime/'+PIN]);
 await raw.query("INSERT INTO reverse_leser_runtime_images(pin,image_digest,image,erstellt_von) VALUES($1,$2,$3,'fixture')",[PIN,image.digest,image.image]);
 await raw.query("INSERT INTO reverse_leser_runtime_ereignisse(id,request_key,payload_hash,phase,image_digest,pin,akteur,grund) VALUES(gen_random_uuid(),repeat('c',64),repeat('c',64),'aktiviert',$1,$2,'fixture','T112')",[image.digest,PIN]);
 const manifest={name:'t112-png',version:'1',runtime:'python3',erkennung:{min_bytes:8,max_bytes:null,endungen:['.png'],magic:[{offset:0,hex:'89504e470d0a1a0a'}]}};
 await raw.query(`INSERT INTO reverse_leser(id,name,version,schnittstelle_version,runtime,manifest,manifest_sha256,code_sha256,paket_sha256,quelle,quell_bytes,registriert_von)
  VALUES($1,'t112-png','1',1,'python3',$2::jsonb,repeat('1',64),repeat('2',64),repeat('3',64),'{}',1,'fixture')`,[L,JSON.stringify(manifest)]);
 await raw.query("INSERT INTO reverse_leser_zustaende(leser_id,name,status,storage_key,paket_bytes,freigegeben_von,freigegeben_at) VALUES($1,'t112-png','aktiv','leser/t112',1,'fixture',clock_timestamp())",[L]);
 for(const f of ['reverse_leser','reverse_leser_nachzug'])await raw.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,$1,true,'T112','fixture') ON CONFLICT DO NOTHING",[f]);
 const root=await mkdtemp(join(tmpdir(),'p18-t112-'));
 try{
  const png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(24,7)]);
  const quellen=[];
  for(const name of ['a.png','b.png']){
   const id=await datei('lz/'+name,{s1Profil:null,groesse:png.length});
   const key=(await raw.query('SELECT storage_key FROM reverse_dateien WHERE id=$1',[id])).rows[0].storage_key;
   await mkdir(dirname(join(root,key)),{recursive:true});await writeFile(join(root,key),png);quellen.push(id);
  }
  const plane=()=>nz.planeReverseLeserNachzug(raw,root,image);
  const laeufe=async()=>(await raw.query("SELECT datei_id::text,status,einstellungen_revision FROM reverse_leser_laeufe WHERE eintrag_id=$1 ORDER BY created_at,id",[rid])).rows;
  // 1) erster Scan plant je Quelle einen Lauf.
  const r1=await plane();
  assert.equal((await laeufe()).length,2,'je Quelle ein Lauf: '+JSON.stringify(r1));
  const rev0=(await laeufe())[0].einstellungen_revision;
  // 2) Scan gilt als noch offen; Einstellung aendert sich; Executor schliesst die pending Laeufe vor Claim (wie reverse-leser-executor.ts).
  await raw.query("UPDATE reverse_leser_nachzug SET status='offen' WHERE eintrag_id=$1",[rid]);
  await setting('s1_neu_parsen_schritt',51);
  await raw.query("UPDATE reverse_leser_laeufe SET status='fehler',fehlercode='leser_einstellungen_geaendert',beendet_at=clock_timestamp() WHERE eintrag_id=$1",[rid]);
  await raw.query("UPDATE work_jobs SET state='failed',error_code='leser_einstellungen_geaendert',updated_at=clock_timestamp() WHERE kind='reverse-leser'");
  // 3) offener Scan scheitert am Pin -> catch setzt 'teilweise' (updated_at liegt danach hinter den Fehlschlaegen).
  const r3=await plane();
  assert.equal(r3.status,'teilweise','Pinfehler im offenen Scan: '+JSON.stringify(r3));
  assert.equal((await laeufe()).length,2,'noch kein Ersatz');
  // 4) Wiederaufnahme: Ersatzscan unter neuer Revision, genau ein Ersatzlauf je Quelle.
  const r4=await plane();
  const nach4=await laeufe();
  assert.equal(nach4.length,4,'genau ein Ersatz je Quelle: '+JSON.stringify(r4));
  const neu=nach4.filter(l=>l.einstellungen_revision!==rev0);
  assert.deepEqual(neu.map(l=>l.datei_id).sort(),[...quellen].sort(),'Ersatz fuer beide Quellen');
  assert.ok(neu.every(l=>l.status==='offen'),'Ersatz offen');
  // 5) weitere Takte: kein Doppel, kein Dauer-Neuscan (Checkpoint traegt aktuelle Revision).
  for(let i=0;i<3;i++)await plane();
  assert.equal((await laeufe()).length,4,'keine weiteren Laeufe');
  // 6) Ersatz scheitert erneut in derselben Revision: kein neuer Lauf, kein Neuscan.
  await raw.query("UPDATE reverse_leser_laeufe SET status='fehler',fehlercode='leser_ende_ohne_ergebnis',beendet_at=clock_timestamp() WHERE eintrag_id=$1 AND einstellungen_revision<>$2",[rid,rev0]);
  for(let i=0;i<2;i++)await plane();
  assert.equal((await laeufe()).length,4,'gleiche Revision: keine Endlosschleife');
 }finally{
  await rm(root,{recursive:true,force:true});
  await raw.query("DELETE FROM agent_profil_schalter WHERE funktion IN('reverse_leser','reverse_leser_nachzug')");
  for(const t of ['reverse_leser_laeufe','reverse_leser_nachzug','work_jobs'])await raw.query('DELETE FROM '+t);
  await raw.query("DELETE FROM reverse_einstellungen WHERE name='s1_neu_parsen_schritt'");
  await leeren();
 }
});
test('neu_parsen: Vorschau aendert nichts, Ausfuehren nur gefilterte Dateien mit limit',async()=>{
 await leeren();aufrufe.length=0;
 const a=await datei('ordner/a.txt',{s1Profil:'np-alt'}),b=await datei('ordner/b.txt',{s1Profil:'np-alt'});await datei('ordner_x/c.txt',{s1Profil:'np-alt'});
 const v=await fuehreNeuParsenAus(pool,{reverseId:rid,datei:null,pfadPraefix:'ordner/',profil:'np-alt',vorschau:true,limit:50});
 assert.equal(v.status,'vorschau');assert.equal(v.gesamt,2,'Praefix ordner/ trifft ordner_x nicht (LIKE escaped)');assert.equal(aufrufe.length,0);
 assert.ok('s3_auto' in v);
 const r=await fuehreNeuParsenAus(pool,{reverseId:rid,datei:null,pfadPraefix:'ordner/',profil:'np-alt',vorschau:false,limit:1,einreihen:(id,m)=>{aufrufe.push({id,m});return {status:'wartet'};}});
 assert.equal(r.angestossen,1);assert.equal(r.rest,1);assert.deepEqual(aufrufe.map(x=>x.id),[a]);
 const e=await fuehreNeuParsenAus(pool,{reverseId:rid,datei:'ordner/b.txt',pfadPraefix:null,profil:null,vorschau:false,limit:5,einreihen:()=>({status:'fehler',fehlercode:'warteschlange_voll'})});
 assert.equal(e.abbruch,'warteschlange_voll');assert.equal(e.angestossen,1);
 assert.ok(b);
});
