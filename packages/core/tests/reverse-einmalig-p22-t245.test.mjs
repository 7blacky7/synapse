/**
 * P22-T245: Reverse einmalig + gedrosselt (User 31.10.2026, memory regel-reverse-assets-einmalig-gedrosselt-nie-blockierend;
 * Bestand/Entwurf thought c3f75f0f, Freigabe #t128-team 34623).
 * Prueft packages/core/src/services/reverse-pipeline.ts:
 *   A reine Funktionen: reverseDrosselWarteMs (Pause/MB-Budget), reverseNeuerInspektor/reverseFormatNeuAbgedeckt (nur bisher unerkannte
 *     Formate, generic-binary zaehlt nicht), Katalog pipeline_einmalig Standard aus (reverse-einstellkatalog.ts).
 *   B ReversePipelineDienst.naechste (privat) im privaten synapse_test-Schema:
 *     - Schalter aus: alte Werkzeug-Schicht -> S0 erneut (Verhalten vor T245, Golden der Altlogik)
 *     - Schalter an, automatisch: fertig ist fertig (S0/S1 alt -> nichts), Medium mit fertiger E -> nichts
 *     - Schalter an, bisher unerkanntes, jetzt abgedecktes Format -> S0 (Format-Nachzug)
 *     - Schalter an, S0 aktuell + S1 alt -> S1; manuell (automatisch=false) -> wie bisher S0
 *   C reverseEinmaligVorschau: bei_aus_erneut_obergrenze zaehlt die Altschichten, bei_an.altschichten_erneut_ohne_grund 0,
 *     format_nachzug_s0 = genau die abgedeckte Datei.
 * Nur synapse_test:5433, privates Schema (Tabellen LIKE public), braucht core/dist. Kein Container, kein Unraid-Zugriff.
 *   DATABASE_URL=postgres://...:5433/synapse_test node packages/core/tests/reverse-einmalig-p22-t245.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433','P22-T245 Testziel Port 5433');assert.equal(url.pathname,'/synapse_test','P22-T245 Testziel synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',SYNAPSE_INTERN_TOOL:'0',QDRANT_URL:'http://127.0.0.1:1',SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:'/tmp/p22-t245-reverse'});
const schema='p22_t245_'+randomUUID().replaceAll('-','');
const scoped=new URL(url);scoped.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=scoped.href;
const {Pool}=createRequire(new URL('../package.json',import.meta.url))('pg');
const raw=new Pool({connectionString:url.href,max:4,options:'-c search_path='+schema+',public'});
await raw.query('CREATE SCHEMA '+schema);
const names=(await raw.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND (tablename LIKE 'reverse_%' OR tablename IN ('work_jobs','work_job_audit','agent_profil_schalter','intern_schalter'))")).rows;
for(const {tablename:t}of names){assert.match(t,/^[a-z_0-9]+$/);await raw.query('CREATE TABLE '+schema+'.'+t+' (LIKE public.'+t+' INCLUDING ALL)');}
const P=await import('../dist/services/reverse-pipeline.js');
const {REVERSE_EINSTELLKATALOG}=await import('../dist/services/reverse-einstellkatalog.js');
const sha=n=>String(n).padStart(64,'0');
const rid='rev-t245-'+randomUUID().slice(0,8);
await raw.query("INSERT INTO reverse_eintraege(id,titel,status,analyse_policy) VALUES($1,'Synthetic T245','bestaetigt','{\"automatisch\":true}')",[rid]);
const mid=String((await raw.query("INSERT INTO reverse_medien(eintrag_id,position,art,status,satz_sha256) VALUES($1,0,'iso','vollstaendig',$2) RETURNING id",[rid,sha(9)])).rows[0].id);
await raw.query("INSERT INTO reverse_schichten(medium_id,schicht,fingerabdruck,status,werkzeug,werkzeug_version,profil_version,aktuell) VALUES($1,'E',$2,'fertig','reverse-E','alt-image','alt-e',true)",[mid,sha(8)]);
const setting=async(name,wert)=>{
 await raw.query("DELETE FROM reverse_einstellungen WHERE ebene='global' AND name=$1",[name]);
 await raw.query("INSERT INTO reverse_einstellungen(ebene,project,eintrag_id,name,wert_text,grund,gesetzt_von) VALUES('global',NULL,NULL,$1,$2,'P22-T245 Test','fixture')",[name,String(wert)]);
};
let nr=0;
/** Datei mit S0/S1-Schicht; version/profil = 'aktuell' setzt den Stand der Pipeline ein. */
async function datei(dienst,pfad,{format=null,magic=null,s0='alt',s1='alt'}={}){
 nr++;
 const id=String((await raw.query("INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,sha256,groesse,art,format,storage_key,metadaten) VALUES($1,$2,$3,$4,10,'asset',$5,$6,$7::jsonb) RETURNING id",
  [rid,mid,pfad,sha(1000+nr),format,rid+'/entpackt/m'+mid+'/'+pfad,JSON.stringify(magic?{magic_hex:magic}:{})])).rows[0].id);
 const v=dienst['version'],p0=dienst['profilFuer']('S0'),p1=dienst['profilFuer']('S1');
 for(const [schicht,stand,profil] of [['S0',s0,p0],['S1',s1,p1]]){
  if(!stand)continue;
  await raw.query("INSERT INTO reverse_schichten(datei_id,schicht,fingerabdruck,status,werkzeug,werkzeug_version,profil_version,aktuell) VALUES($1,$2,$3,'fertig','asset-inspektoren',$4,$5,true)",
   [id,schicht,sha(5000+nr*2+(schicht==='S1'?1:0)),stand==='aktuell'?v:'alt-werkzeug',profil]);
 }
 return id;
}
const naechste=(dienst,file,medium,automatisch)=>{const c=raw;return dienst['naechste']({query:(s,p)=>c.query(s,p)},rid,file,medium,'S1',automatisch);};
const neuerDienst=async()=>{const d=new P.ReversePipelineDienst({pool:raw,ausfuehrbareKinds:[]});await d['einstellungen']();return d;};

test.after(async()=>{await raw.query('DROP SCHEMA '+schema+' CASCADE');await raw.end();const {getPool}=await import('../dist/db/client.js');await getPool().end().catch(()=>{});});

test('A P22-T245 reverse-pipeline.ts reverseDrosselWarteMs: Pause und MB/s-Budget',()=>{
 assert.equal(P.reverseDrosselWarteMs(2000,20,0,50),2000,'kleine Datei: feste Pause');
 assert.equal(P.reverseDrosselWarteMs(0,20,100_000_000,1000),4000,'100 MB bei 20 MB/s = 5000 ms abzueglich 1000 ms Laufzeit');
 assert.equal(P.reverseDrosselWarteMs(2000,20,100_000_000,10_000),2000,'langsamer Auftrag: Pause bleibt Untergrenze');
 assert.equal(P.reverseDrosselWarteMs(0,1,0,0),0);
});
test('A P22-T245 reverseNeuerInspektor: nur bisher unerkannte Formate, generic-binary zaehlt nicht',()=>{
 assert.equal(P.reverseFormatNeuAbgedeckt({pfad:'a.png',format:'png',magic:'89504e470d0a1a0a'}),false,'erkannt bleibt erkannt (einmalig)');
 assert.equal(P.reverseFormatNeuAbgedeckt({pfad:'a.png',format:null,magic:'89504e470d0a1a0a'}),true,'PNG war unerkannt, jetzt PNG-Inspektor -> Nachzug');
 assert.equal(P.reverseFormatNeuAbgedeckt({pfad:'a.png',format:'unbekannt',magic:'89504e470d0a1a0a'}),true,'unbekannt zaehlt wie NULL');
 assert.equal(P.reverseFormatNeuAbgedeckt({pfad:'a.pdf',format:null,magic:'255044462d'}),false,'generic-binary ist keine neue Abdeckung');
 assert.equal(P.reverseFormatNeuAbgedeckt({pfad:'a.unbekanntxyz',format:null,magic:'00'}),false,'kein Inspektor -> kein Nachzug');
 assert.equal(P.reverseFormatNeuAbgedeckt({pfad:'a.png',format:null,magic:'zz'}),true,'ungueltige Magic faellt auf die Endung zurueck');
 assert.equal(P.reverseFormatNeuAbgedeckt(undefined),false);
});
test('A P22-T245 reverse-einstellkatalog.ts: pipeline_einmalig Standard aus, Drossel-Standards',()=>{
 const K=REVERSE_EINSTELLKATALOG;
 assert.deepEqual([K.pipeline_einmalig.standard,K.pipeline_einmalig.werte],['aus',['aus','an']]);
 assert.deepEqual([K.pipeline_pause_ms.standard,K.pipeline_lese_mb_s.standard,K.pipeline_last_max_milli.standard,K.pipeline_latenz_max_ms.standard,K.pipeline_db_verbindungen.standard],['2000','20','1000','250','2']);
});
test('B P22-T245 naechste: Schalter aus = Altverhalten (alte Werkzeugschicht -> S0 erneut)',async()=>{
 await setting('pipeline_einmalig','aus');
 const d=await neuerDienst();
 const f=await datei(d,'aus/a.png',{format:'png'});
 assert.equal(await naechste(d,f,mid,true),'S0','Golden Altlogik: werkzeug_version alt -> S0');
 assert.equal(await naechste(d,null,mid,true),'E','Golden Altlogik: Medium -> E');
 await d.beende();
});
test('B P22-T245 naechste: Schalter an - einmalig, Format-Nachzug, S1 hinter aktuellem S0, manuell unveraendert',async()=>{
 await setting('pipeline_einmalig','an');
 const d=await neuerDienst();
 assert.equal(d['einmalig'],true,'Schalter wirksam');
 const erkannt=await datei(d,'an/b.png',{format:'png'});
 assert.equal(await naechste(d,erkannt,mid,true),null,'fertig ist fertig: alte S0/S1 einer erkannten Datei laufen nicht neu');
 assert.equal(await naechste(d,erkannt,mid,false),'S0','manuell (reverse analysieren): Verhalten wie bisher');
 assert.equal(await naechste(d,null,mid,true),null,'Medium mit fertiger E (altes Image) wird nicht erneut entpackt');
 const neuAbgedeckt=await datei(d,'an/c.png',{format:null,magic:'89504e470d0a1a0a'});
 assert.equal(await naechste(d,neuAbgedeckt,mid,true),'S0','bisher unerkannt, jetzt abgedeckt -> Format-Nachzug S0');
 const unbekannt=await datei(d,'an/d.zzz',{format:null,magic:'00'});
 assert.equal(await naechste(d,unbekannt,mid,true),null,'unerkannt und weiterhin ohne Inspektor -> nichts');
 const s1Hinter=await datei(d,'an/e.png',{format:'png',s0:'aktuell',s1:'alt'});
 assert.equal(await naechste(d,s1Hinter,mid,true),'S1','S0 aktuell, S1 alt -> nur S1');
 const neu=await datei(d,'an/f.png',{format:null,s0:null,s1:null});
 assert.equal(await naechste(d,neu,mid,true),'S0','neue Datei ohne Schicht laeuft normal');
 await d.beende();
});
test('D P22-T245 fail-closed (34623 (3)): Einstellungen nicht lesbar -> kein Durchlauf; Last nicht lesbar -> belastet',async()=>{
 await setting('pipeline_einmalig','aus');
 // Einstellungs-Lesung scheitert, alle anderen Abfragen laufen normal; Zaehler zeigt, ob danach noch gearbeitet wurde.
 let nachEinstellungen=0,einstellungenGelesen=false;
 const kaputt={query:(s,p)=>{const t=typeof s==='object'?s.text:s;
   if(/FROM reverse_einstellungen/.test(t)){einstellungenGelesen=true;return Promise.reject(new Error('P22-T245 Testfehler'));}
   if(einstellungenGelesen)nachEinstellungen++;return raw.query(s,p);},connect:()=>raw.connect()};
 const d=new P.ReversePipelineDienst({pool:kaputt,ausfuehrbareKinds:[]});
 await d.durchlauf();
 assert.equal(d['einstellFehler'],'reverse_einstellungen_nicht_lesbar','P22-T245 reverse-pipeline.ts einstellungen: Fehler gemerkt');
 assert.match(String(P.reverseDrosselStand.letzter_grund),/^einstellungen_nicht_lesbar/,'Debugstand nennt den Grund, tatsaechlich '+P.reverseDrosselStand.letzter_grund);
 assert.equal(nachEinstellungen,0,'P22-T245 durchlauf: nach nicht lesbaren Einstellungen keine weitere DB-Arbeit (kein entdecke/claim)');
 await d.beende();
 // Last/Latenz nicht lesbar -> belastet (nie Vollgas).
 await setting('pipeline_einmalig','an');
 const e=await neuerDienst();
 e['latenz']={count:1,percentile:()=>NaN,reset(){},enable(){},disable(){}};
 assert.equal(e['betriebBelastet'](),true,'P22-T245 betriebBelastet: Messwert NaN = belastet');
 assert.equal(P.reverseDrosselStand.letzter_grund,'last_nicht_lesbar');
 e['latenz']={count:0,percentile:()=>NaN,reset(){},enable(){},disable(){}};
 e['drossel']={...e['drossel'],lastMilli:0,latenzMs:0};
 assert.equal(e['betriebBelastet'](),false,'ohne Messpunkte und ohne Grenzwerte: nicht belastet');
 e['drossel']={...e['drossel'],lastMilli:1};
 e['latenz']={count:1,percentile:()=>1e6,reset(){},enable(){},disable(){}};
 const os=await import('node:os');
 if(os.loadavg()[0]>0.01*os.cpus().length)assert.equal(e['betriebBelastet'](),true,'Load ueber Grenzwert 1 (=0,001 je CPU) -> belastet');
 await e.beende();
});
test('E P22-T245 eigener DB-Pool (34623 (2)): bei an ohne Injektion eigener Pool max pipeline_db_verbindungen, bei aus Haupt-Pool',async()=>{
 await setting('pipeline_einmalig','an');await setting('pipeline_db_verbindungen',2);
 const {getPool}=await import('../dist/db/client.js');
 const d=new P.ReversePipelineDienst({ausfuehrbareKinds:[]});
 assert.equal(d['pool'],getPool(),'vor dem ersten Lesen (Standard aus): Haupt-Pool');
 await d['einstellungen']();
 assert.notEqual(d['pool'],getPool(),'bei an: nicht der Haupt-Pool');
 assert.equal(d['pool'].options.max,2,'eigener Pool max 2, tatsaechlich '+d['pool'].options.max);
 assert.equal(P.reverseDrosselStand.werte.eigenerPool,true);
 const eigener=d['pool'];
 await setting('pipeline_einmalig','aus');await d['einstellungen']();
 assert.equal(d['pool'],getPool(),'zurueck auf aus: wieder Haupt-Pool (Altverhalten)');
 const injiziert=new P.ReversePipelineDienst({pool:raw,ausfuehrbareKinds:[]});await setting('pipeline_einmalig','an');await injiziert['einstellungen']();
 assert.equal(injiziert['pool'],raw,'injizierter Pool (Tests) bleibt');
 await d.beende();await injiziert.beende();await eigener.end();
});
test('C P22-T245 reverseEinmaligVorschau: Altschichten gezaehlt, bei an 0 ohne Grund, Nachzug exakt',async()=>{
 await raw.query('DELETE FROM reverse_schichten WHERE datei_id IS NOT NULL');await raw.query('DELETE FROM reverse_dateien');
 await setting('pipeline_einmalig','aus');
 const d=await neuerDienst();
 await datei(d,'v/a.png',{format:'png'});await datei(d,'v/b.png',{format:null,magic:'89504e470d0a1a0a'});await datei(d,'v/c.zzz',{format:null,magic:'00'});
 const v=await P.reverseEinmaligVorschau({query:(s,p)=>raw.query(s,p)});
 const zeile=n=>v.schichten.find(z=>z.schicht===n);
 assert.equal(zeile('S0')?.alter_stand,3,'3 alte S0-Schichten, tatsaechlich '+JSON.stringify(v.schichten));
 assert.ok(v.bei_aus_erneut_obergrenze>=6,'ohne Schalter: S0+S1 aller 3 Dateien (+E), tatsaechlich '+v.bei_aus_erneut_obergrenze);
 assert.equal(v.bei_an.altschichten_erneut_ohne_grund,0);
 assert.equal(v.bei_an.format_nachzug_s0,1,'nur v/b.png ist neu abgedeckt, tatsaechlich '+JSON.stringify(v.bei_an));
 assert.equal(v.format_nachzug_geprueft,2,'geprueft werden nur unerkannte Formate mit alter S0');
 assert.equal(v.schalter,'aus');
 await d.beende();
});
