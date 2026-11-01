/**
 * P22-T245 Nacharbeit (Entwurf thought ac8a8b97, Entscheidungen #t128-team 34651; Abnahme eiche d7659c9b B1/B2, ahorn fc7cf78a E1/E3).
 * Prueft packages/core/src/services/reverse-einmalig.ts, reverse-pipeline.ts, reverse-nachzug-auto.ts, reverse-entstoerer.ts,
 * reverse-tool.ts und die Tore in packages/rest-api/src/services/reverse-executor.ts / reverse-leser-executor.ts:
 *   F reverseEinmaligSchicht (rein): reiner Profil-/Parser-Wechsel loest bei einmalig KEIN S1 aus (B1 ii), S1 nach neu inspiziertem S0 ja;
 *     reverseS1NeuParsenTakt bei pipeline_einmalig an nur Format-Nachzug mit Pruefmarke (Abnahme f91640e2 B-1), bei aus wie bisher;
 *     S3-Auto-SQL bei einmalig ohne Werkzeugbedingung.
 *   G reverseEinmaligVorschau misst: ohne_grund 0, s1_nach_neuem_s0 und format_nachzug gezaehlt, Profilwechsel nicht, unterdrueckt-Feld.
 *   H Vorschau nur auf Anfrage: entstoereReverse ruft diagnoseReverse ohne einmalig, reverse(diagnose) mit einmalig:true.
 *   I reverseDrosselTor/-Buche: aus = frei, an = Pause je Kanal, Last nicht lesbar / Einstellungen nicht lesbar = ruhen.
 *   J E- und Leser-Executor: Tor vor Planung/Claim, Buchung mit Bytes, IO-Limit verdrahtet (Quelltext; das VERHALTEN prueft
 *     packages/rest-api/tests/reverse-executor-tore-p22-t245.test.mjs, Abnahme f91640e2 B-3/B-5).
 *   K entdecke() bei einmalig: Datei ohne Arbeit bekommt die Marke einmalig_geprueft und wird beim naechsten Durchlauf nicht mehr gezogen.
 *   L Abnahme f91640e2 B-1: S1 im Alt-Profil + neu abgedecktes Format: Vorschau zaehlt es (format_nachzug_ueber_s1_nachzug), entdecke()
 *     laesst es aus ($4), der S1-Nachzug reiht es wirklich ein (S0, Prioritaet nachzug). Vorschau = Wirklichkeit.
 *   M Abnahme B-2: entdecke() ueberspringt den Datei-Scan bei gleichem Datenstand nach leerem Scan, scannt bei neuem Stand, nach der Frist
 *     pipeline_entdecke_vollscan_ms, bei Frist 0 und bei aus immer; der echte Stand (pg_stat_user_tables) aendert sich nach einem Einfuegen.
 *   N Abnahme B-4: reverseBelastungMessen je Kanal (die Messung des einen Kanals setzt das Fenster des anderen nicht zurueck).
 * Nur synapse_test:5433, privates Schema (Tabellen LIKE public), braucht core/dist. Kein Container, kein Unraid-Zugriff.
 *   DATABASE_URL=postgres://...:5433/synapse_test node --test packages/core/tests/reverse-einmalig-nacharbeit-p22-t245.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433','P22-T245 Testziel Port 5433');assert.equal(url.pathname,'/synapse_test','P22-T245 Testziel synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',SYNAPSE_INTERN_TOOL:'0',QDRANT_URL:'http://127.0.0.1:1',SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:'/tmp/p22-t245-nacharbeit'});
const schema='p22_t245n_'+randomUUID().replaceAll('-','');
const scoped=new URL(url);scoped.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=scoped.href;
const {Pool}=createRequire(new URL('../package.json',import.meta.url))('pg');
const raw=new Pool({connectionString:url.href,max:4,options:'-c search_path='+schema+',public'});
await raw.query('CREATE SCHEMA '+schema);
const names=(await raw.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND (tablename LIKE 'reverse_%' OR tablename IN ('work_jobs','work_job_audit','agent_profil_schalter','intern_schalter'))")).rows;
for(const {tablename:t}of names){assert.match(t,/^[a-z_0-9]+$/);await raw.query('CREATE TABLE '+schema+'.'+t+' (LIKE public.'+t+' INCLUDING ALL)');}
const P=await import('../dist/services/reverse-pipeline.js');
const E=await import('../dist/services/reverse-einmalig.js');
const N=await import('../dist/services/reverse-nachzug-auto.js');
const {reverseEinstellSnapshot}=await import('../dist/services/reverse-einstellwerte.js');
const snap=werte=>reverseEinstellSnapshot(Object.entries(werte).map(([name,wert])=>({ebene:'global',name,wert:String(wert)})));
const sha=n=>String(n).padStart(64,'0');
const rid='rev-t245n-'+randomUUID().slice(0,8);
await raw.query("INSERT INTO reverse_eintraege(id,titel,status,analyse_policy) VALUES($1,'Synthetic T245 Nacharbeit','bestaetigt','{\"automatisch\":true}')",[rid]);
const mid=String((await raw.query("INSERT INTO reverse_medien(eintrag_id,position,art,status,satz_sha256) VALUES($1,0,'iso','vollstaendig',$2) RETURNING id",[rid,sha(9)])).rows[0].id);
await raw.query("INSERT INTO reverse_schichten(medium_id,schicht,fingerabdruck,status,werkzeug,werkzeug_version,profil_version,aktuell) VALUES($1,'E',$2,'fertig','reverse-E','alt-image','alt-e',true)",[mid,sha(8)]);
const setting=async(name,wert)=>{
 await raw.query("DELETE FROM reverse_einstellungen WHERE ebene='global' AND name=$1",[name]);
 await raw.query("INSERT INTO reverse_einstellungen(ebene,project,eintrag_id,name,wert_text,grund,gesetzt_von) VALUES('global',NULL,NULL,$1,$2,'P22-T245 Test','fixture')",[name,String(wert)]);
};
let nr=0;
/** Datei mit S0/S1; Stand 'aktuell' = Werkzeug/Profil der Pipeline, 'alt' = altes Werkzeug, 'profil' = aktuelles Werkzeug, anderes Profil. */
async function datei(dienst,pfad,{format=null,magic=null,s0='alt',s1='alt'}={}){
 nr++;
 const id=String((await raw.query("INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,sha256,groesse,art,format,storage_key,metadaten) VALUES($1,$2,$3,$4,10,'asset',$5,$6,$7::jsonb) RETURNING id",
  [rid,mid,pfad,sha(1000+nr),format,rid+'/entpackt/m'+mid+'/'+pfad,JSON.stringify(magic?{magic_hex:magic}:{})])).rows[0].id);
 const v=dienst['version'],p0=dienst['profilFuer']('S0'),p1=dienst['profilFuer']('S1');
 const zeilen=[['S0',s0,p0],['S1',s1,p1]].filter(([,stand])=>stand).map(([schicht,stand,profil],i)=>[id,schicht,sha(5000+nr*2+i),stand==='alt'?'alt-werkzeug':v,stand==='profil'?'anderes-profil':profil]);
 if(zeilen.length)await raw.query("INSERT INTO reverse_schichten(datei_id,schicht,fingerabdruck,status,werkzeug,werkzeug_version,profil_version,aktuell) SELECT d,s,f,'fertig','asset-inspektoren',w,p,true FROM unnest($1::bigint[],$2::text[],$3::text[],$4::text[],$5::text[]) AS z(d,s,f,w,p)",
  [zeilen.map(z=>z[0]),zeilen.map(z=>z[1]),zeilen.map(z=>z[2]),zeilen.map(z=>z[3]),zeilen.map(z=>z[4])]);
 return id;
}
const neuerDienst=async()=>{const d=new P.ReversePipelineDienst({pool:raw,ausfuehrbareKinds:[]});await d['einstellungen']();return d;};
const lies=p=>readFile(new URL('../../../'+p,import.meta.url),'utf8');

test.after(async()=>{await raw.query('DROP SCHEMA '+schema+' CASCADE');await raw.end();});

test('F P22-T245 reverse-einmalig.ts reverseEinmaligSchicht: Profilwechsel allein loest bei einmalig kein S1 aus (B1 ii)',async()=>{
 const W='werkzeug-neu';
 const akt=(stufe,z)=>!!z&&['fertig','teilweise'].includes(z.status)&&z.werkzeug_version===W&&z.profil_version==='p-neu';
 const entscheide=(schichten,einmalig,formatNeu=false)=>{const grund={};return E.reverseEinmaligSchicht({schichten,ziel:'S1',einmalig,werkzeug:W,aktuell:akt,formatNeu:()=>formatNeu,grund}).then(s=>[s,grund.wert]);};
 const s0={schicht:'S0',status:'fertig',werkzeug_version:W,profil_version:'p-neu'};
 assert.deepEqual(await entscheide([s0,{schicht:'S1',status:'fertig',werkzeug_version:W,profil_version:'p-alt'}],true),[null,undefined],'nur Profil/Parser anders: einmalig -> nichts');
 assert.deepEqual(await entscheide([s0,{schicht:'S1',status:'fertig',werkzeug_version:W,profil_version:'p-alt'}],false),['S1','alt'],'aus: wie vor T245 -> S1');
 assert.deepEqual(await entscheide([s0,{schicht:'S1',status:'fertig',werkzeug_version:'werkzeug-alt',profil_version:'p-alt'}],true),['S1','s1_nach_s0'],'S0 neu inspiziert (Werkzeug neu), S1 alt -> S1');
 assert.deepEqual(await entscheide([{...s0,werkzeug_version:'werkzeug-alt'}],true,true),['S0','format_nachzug'],'neu abgedecktes Format -> S0');
 assert.deepEqual(await entscheide([{...s0,status:'fehler'}],true),['S0','wiederholung'],'nicht fertige Schicht -> Wiederholung');
 assert.deepEqual(await entscheide([],true),['S0','neu'],'keine Schicht -> neu');
});
// Abnahme claude-birke f91640e2 B-1: bei einmalig ruhte der S1-Nachzug ganz; Dateien mit S1 im Alt-Profil (entdecke-Ausschluss $4) bekamen so
// nie ihren Format-Nachzug. Jetzt wie Entwurf ac8a8b97 B1: nur bisher unerkannte, jetzt abgedeckte Formate; der Rest bekommt nur die Pruefmarke.
test('F P22-T245 reverse-nachzug-auto.ts reverseS1FormatNachzugTakt: bei einmalig nur Format-Nachzug (B-1), bei aus wie bisher; S3-Auto ohne Werkzeugbedingung',async()=>{
 const d=await neuerDienst();
 const bekannt=await datei(d,'f/a.png',{format:'png',s0:'aktuell',s1:'aktuell'});  // erkannt: bei einmalig kein Kandidat
 const neu=await datei(d,'f/b.png',{format:null,magic:'89504e470d0a1a0a'});         // unerkannt, jetzt PNG: Format-Nachzug
 const ohne=await datei(d,'f/c.bin',{format:null,magic:'00010203'});                // unerkannt, weiter unerkannt: nur Pruefmarke
 const eingereiht=[];
 const k=ein=>({pool:raw,ein,parserProfil:'parser-s1:test-neu',s3Kennung:'image:neu',inspektorStand:'insp-test',vorrang:async()=>null,einreihen:async a=>{eingereiht.push(String(a.dateiId));return {status:'wartet'};}});
 const einmalig=snap({pipeline_einmalig:'an',s1_neu_parsen_auto:'an'});
 const an=await N.reverseS1NeuParsenTakt(k(einmalig));
 assert.deepEqual([an.modus,an.eingereiht,an.ohne_neues_format,eingereiht],['einmalig_format_nachzug',1,1,[neu]],'P22-T245 B-1 reverse-nachzug-auto.ts: nur der Format-Nachzug, tatsaechlich '+JSON.stringify(an));
 const m=Object.fromEntries((await raw.query("SELECT id::text AS id,metadaten->'nachzug_auto' AS m FROM reverse_dateien WHERE id=ANY($1::bigint[])",[[neu,ohne]])).rows.map(r=>[r.id,r.m??{}]));
 assert.equal(m[ohne].s1_format_geprueft,'insp-test:parser-s1:test-neu','P22-T245 B-1: Pruefmarke fuer die nicht abgedeckte Datei, tatsaechlich '+JSON.stringify(m[ohne]));
 assert.equal(m[ohne].s1_kennung,undefined,'P22-T245 B-1: keine s1_kennung (Entwurf ac8a8b97 B1), sonst fehlte die Datei einem spaeteren AUS');
 assert.equal(m[neu].s1_kennung,'parser-s1:test-neu','P22-T245 B-1: eingereihte Datei traegt die Marke je Parser-Profil, tatsaechlich '+JSON.stringify(m[neu]));
 const zweiter=await N.reverseS1NeuParsenTakt(k(einmalig));
 assert.equal(zweiter.kandidaten,0,'P22-T245 B-1: zweiter Takt zieht dieselben Kandidaten nicht erneut, tatsaechlich '+JSON.stringify(zweiter));
 eingereiht.length=0;
 const aus=await N.reverseS1NeuParsenTakt(k(snap({pipeline_einmalig:'aus',s1_neu_parsen_auto:'an'})));
 assert.equal(aus.aktiv,true,JSON.stringify(aus));
 assert.deepEqual([...eingereiht].sort(),[bekannt,ohne].sort(),'P22-T245 B-1: aus = Altverhalten, die Pruefmarke wirkt nicht, tatsaechlich '+JSON.stringify(eingereiht));
 assert.ok(N.REVERSE_S3_AUTO_SQL.includes('AND s.werkzeug_version=$2)'),'S3-Auto-SQL enthaelt die Werkzeugbedingung, die bei einmalig ersetzt wird');
 const quelle=await lies('packages/core/src/services/reverse-nachzug-auto.ts');
 assert.match(quelle,/pipeline_einmalig'\)==='an'\?REVERSE_S3_AUTO_SQL\.replace\("AND s\.werkzeug_version=\$2\)","AND true\)"\)/,'S3-Auto bei einmalig: nur Dateien ganz ohne fertige S3');
 await d.beende();
});
test('G P22-T245 reverseEinmaligVorschau misst je Datei (E1): ohne_grund 0, s1 nach neuem S0, Profilwechsel unterdrueckt',async()=>{
 await raw.query('DELETE FROM reverse_schichten WHERE datei_id IS NOT NULL');await raw.query('DELETE FROM reverse_dateien');
 await setting('pipeline_einmalig','aus');
 const d=await neuerDienst();
 await datei(d,'g/a.png',{format:'png'});                                      // alt, erkannt -> nichts
 await datei(d,'g/b.png',{format:null,magic:'89504e470d0a1a0a'});             // Format-Nachzug S0
 await datei(d,'g/c.png',{format:'png',s0:'aktuell',s1:'alt'});              // S1 nach neu inspiziertem S0
 await datei(d,'g/d.png',{format:'png',s0:'aktuell',s1:'profil'});           // nur Profil anders -> nichts (B1 ii)
 await datei(d,'g/e.png',{format:null,s0:null,s1:null});                     // neu
 P.vergissReverseEinmaligVorschau();
 const v=await P.reverseEinmaligVorschau({query:(s,p)=>raw.query(s,p)});
 assert.equal(v.bei_an.altschichten_erneut_ohne_grund,0,'Messwert ohne Grund, tatsaechlich '+JSON.stringify(v.bei_an));
 assert.equal(v.bei_an.format_nachzug_s0,1,'g/b');assert.equal(v.bei_an.s1_nach_neuem_s0,1,'g/c');assert.equal(v.bei_an.neue_dateien_ohne_schicht,1,'g/e');
 assert.equal(v.bei_an.erneut_gesamt,3,'b+c+e (Medium hat E), tatsaechlich '+v.bei_an.erneut_gesamt);
 assert.equal(v.dateien_geprueft,5);
 assert.ok(v.unterdrueckt_durch_einmalig&&'s1_neu_parsen_auto' in v.unterdrueckt_durch_einmalig&&'s3_auto' in v.unterdrueckt_durch_einmalig,'Feld unterdrueckt_durch_einmalig');
 assert.ok(v.unterdrueckt_durch_einmalig.altschichten>=5,'Altschichten bei aus, tatsaechlich '+v.unterdrueckt_durch_einmalig.altschichten);
 await d.beende();
});
test('H P22-T245 Vorschau nur auf Anfrage (E3): Entstoerer ohne einmalig, reverse(diagnose) mit einmalig:true',async()=>{
 const ent=await lies('packages/core/src/services/reverse-entstoerer.ts');
 assert.match(ent,/\.\.\.\(o\.einmalig \? \{ einmalig: await einmaligVorschau\(\) \} : \{\}\)/,'diagnoseReverse rechnet die Vorschau nur mit einmalig');
 assert.match(ent,/const d = await diagnoseReverse\(\{ reverseId: o\.reverseId, pool: db, limit: Number\.MAX_SAFE_INTEGER \}\)/,'entstoereReverse ohne einmalig');
 assert.match(ent,/reverseEinmaligVorschau\(\); \}/,'Vorschau ohne Pool-Uebergabe (eigener Pool statt Haupt-Pool)');
 const tool=await lies('packages/core/src/services/reverse-tool.ts');
 assert.match(tool,/diagnoseReverse\(\{reverseId:rid,limit,pool,einmalig:true\}\)/,'reverse(diagnose) fordert die Vorschau an');
 const pipe=await lies('packages/core/src/services/reverse-pipeline.ts');
 assert.match(pipe,/const pool:Pick<Pool,'query'>=db\?\?reverseEigenerPool\(2\);/,'Standard-Pool der Vorschau ist der eigene Pool');
});
test('I P22-T245 reverse-einmalig.ts reverseDrosselTor/-Buche: Pause je Kanal, fail-closed',()=>{
 E.vergissReverseDrossel();
 const an=snap({pipeline_einmalig:'an',pipeline_pause_ms:2000,pipeline_lese_mb_s:20,pipeline_last_max_milli:0,pipeline_latenz_max_ms:0});
 const ruhig={last:0,latenz_ms:0};
 assert.deepEqual(E.reverseDrosselTor('e',snap({pipeline_einmalig:'aus'}),{messung:{last:NaN,latenz_ms:NaN}}),{frei:true},'aus: Altverhalten');
 assert.equal(E.reverseDrosselTor('e',an,{jetzt:1000,messung:ruhig}).frei,true);
 assert.equal(E.reverseDrosselBuche('e',an,0,10,1000),2000,'Pause 2000 ms');
 assert.deepEqual(E.reverseDrosselTor('e',an,{jetzt:2000,messung:ruhig}),{frei:false,grund:'drossel',warte_ms:1000});
 assert.equal(E.reverseDrosselTor('leser',an,{jetzt:2000,messung:ruhig}).frei,true,'Kanaele getrennt');
 assert.equal(E.reverseDrosselTor('e',an,{jetzt:3000,messung:ruhig}).frei,true,'nach der Pause frei');
 assert.equal(E.reverseDrosselBuche('leser',an,100_000_000,1000,0),4000,'100 MB bei 20 MB/s: 5000-1000 ms');
 assert.equal(E.reverseDrosselTor('pipeline',an,{messung:{last:NaN,latenz_ms:0}}).grund,'last_nicht_lesbar','Last nicht lesbar = ruhen');
 const kaputt={...an,letzter_fehler:'reverse_einstellungen_nicht_lesbar'};
 assert.equal(E.reverseDrosselTor('e',kaputt).grund,'einstellungen_nicht_lesbar','Einstellungen nicht lesbar = ruhen (auch bei aus)');
 assert.equal(E.reverseDrosselTor('e',null).frei,false);
 const grenze=snap({pipeline_einmalig:'an',pipeline_last_max_milli:500,pipeline_latenz_max_ms:100});
 assert.equal(E.reverseDrosselTor('pipeline',grenze,{messung:{last:600,latenz_ms:0}}).grund,'last');
 assert.equal(E.reverseDrosselTor('pipeline',grenze,{messung:{last:0,latenz_ms:150}}).grund,'latenz');
 assert.ok(E.reverseDrosselStand.kanaele.e.ruhen>=2,'Debugstand je Kanal');
 E.vergissReverseDrossel();
});
test('J P22-T245 E- und Leser-Executor: Tor vor Planung/Claim, Buchung mit Bytes, IO-Limit (B2a/B2b, Abnahme B-3, B-5)',async()=>{
 const ex=await lies('packages/rest-api/src/services/reverse-executor.ts');
 const tor=ex.indexOf("const tor=reverseDrosselTor('e',admissionWerte);if(!tor.frei)return leer('reverse_drossel:'+tor.grund);");
 assert.ok(tor>0,'E-Executor: Tor vorhanden');
 assert.ok(tor<ex.indexOf('const claims=await this.jobs.claim(this.wer,{limit:frei,leaseSeconds:this.k.leaseSeconds});'),'Tor vor Wecken/Claim');
 assert.match(ex,/reverseDrosselBuche\('e',admissionWerte,reverseDrosselAktiv\(admissionWerte\)\?await reverseAuftragBytes\(this\.pool,'e',job\):0,dauer\)/,'P22-T245 B-3 (1) reverse-executor.ts: E bucht die Bytes des Auftrags');
 assert.match(ex,/ioGrenzen:mounts=>reverseIoGrenzen\(mounts\),ioStartFehler:reverseIoStartFehler/,'P22-T245 B-3 (2) reverse-executor.ts: IO-Limit am Transport verdrahtet');
 const le=await lies('packages/rest-api/src/services/reverse-leser-executor.ts');
 const ltor=le.indexOf("const tor=reverseDrosselTor('leser',this.s);if(!tor.frei)return");
 assert.ok(ltor>0&&ltor<le.indexOf('await planeReverseLeserNachzug(')&&ltor<le.indexOf("const claims=await this.jobs.claim(this.wer,{limit:frei,leaseSeconds:reverseZahl(this.s,'executor_lease_s')});"),'P22-T245 B-5 reverse-leser-executor.ts: Tor vor Nachzug-Planung und Claim');
 assert.match(le,/reverseDrosselBuche\('leser',drosselWerte,reverseDrosselAktiv\(drosselWerte\)\?await reverseAuftragBytes\(this\.pool,'leser',job\):0,dauer\)/,'P22-T245 B-3 (1) reverse-leser-executor.ts: Leser bucht die Dateigroesse');
});
test('K P22-T245 entdecke() bei einmalig: Marke einmalig_geprueft, kein endloses Kreisen',async()=>{
 await raw.query('DELETE FROM reverse_auftraege');await raw.query('DELETE FROM reverse_schichten WHERE datei_id IS NOT NULL');await raw.query('DELETE FROM reverse_dateien');
 await setting('pipeline_einmalig','an');
 const d=await neuerDienst();
 assert.equal(d['einmalig'],true);
 const fertig=await datei(d,'k/a.png',{format:'png'});
 await d['entdecke']();
 const m=(await raw.query("SELECT metadaten->>'einmalig_geprueft' AS marke,pipeline_gesehen_at::text AS am FROM reverse_dateien WHERE id=$1",[fertig])).rows[0];
 assert.ok(m.marke&&m.marke.startsWith(d['version']+':S1:'),'Marke = Werkzeugstand:Grenze:Policy, tatsaechlich '+m.marke);
 await d['entdecke']();
 const n=(await raw.query("SELECT pipeline_gesehen_at::text AS am FROM reverse_dateien WHERE id=$1",[fertig])).rows[0];
 assert.equal(String(n.am),String(m.am),'zweiter Durchlauf zieht die markierte Datei nicht mehr');
 await setting('pipeline_einmalig','aus');await d['einstellungen']();
 await d['entdecke']();
 const o=(await raw.query("SELECT pipeline_gesehen_at::text AS am FROM reverse_dateien WHERE id=$1",[fertig])).rows[0];
 assert.notEqual(String(o.am),String(m.am),'bei aus wirkt die Marke nicht (Altverhalten)');
 await d.beende();
});
// reverse_leser_nachzug: entdecke() meldet Dateien an den Leser-Nachzug; offene Zeilen sind Vorrang und liessen den S1-Nachzug aussetzen.
const leeren=async()=>{await raw.query('DELETE FROM reverse_auftraege');await raw.query('DELETE FROM reverse_schichten WHERE datei_id IS NOT NULL');await raw.query('DELETE FROM reverse_leser_nachzug');await raw.query('DELETE FROM reverse_dateien');
 // K reiht bei aus ein neues E fuer das Medium ein und loest dabei die fertige E-Schicht ab; der Nachzug verlangt aber eine aktuelle
 // fertige E-Schicht (AUTOMATISCH in reverse-nachzug-auto.ts). Darum den Fixture-Stand wiederherstellen.
 await raw.query('DELETE FROM reverse_schichten WHERE medium_id=$1 AND fingerabdruck<>$2',[mid,sha(8)]);await raw.query('UPDATE reverse_schichten SET aktuell=true WHERE medium_id=$1',[mid]);};
const auftraege=async id=>(await raw.query('SELECT schicht,prioritaet,status FROM reverse_auftraege WHERE datei_id=$1 ORDER BY created_at',[id])).rows;
// Abnahme claude-birke f91640e2 B-1 (Wegwerftest abnahme-t245-b1-altprofil): Vorschau zaehlte format_nachzug_s0=1, entdecke() zog die Datei
// nie (Ausschluss $4) und der S1-Nachzug ruhte. Jetzt laeuft sie ueber den S1-Nachzug, und die Vorschau zaehlt genau diesen Weg.
test('L P22-T245 Abnahme B-1 Alt-Profil-S1 + neu abgedecktes Format: Vorschau = Wirklichkeit (reverse-pipeline.ts, reverse-nachzug-auto.ts)',async()=>{
 await leeren();
 for(const [n,w] of [['pipeline_einmalig','an'],['s1_neu_parsen_auto','an'],['nachzug_vorrang_chunks_max',0],['nachzug_vorrang_parse_max',0]])await setting(n,w);
 const d=await neuerDienst();
 // Dateien VOR dem Parser-Schalter anlegen: ihre S1 traegt damit das Alt-Profil (Inspektor-Profil statt Parser-Profil), wie live.
 const neu=await datei(d,'l/bild.png',{format:null,magic:'89504e470d0a1a0a'});
 const ohne=await datei(d,'l/rest.bin',{format:null,magic:'00010203'});
 d['parserAdapter']=true;const parserProfil=d['s1ParserProfil']();
 P.reverseDrosselStand.stand={werkzeug:d['version'],profil_s0:d['profilFuer']('S0'),profil_s1:parserProfil};
 P.vergissReverseEinmaligVorschau();
 const v=await P.reverseEinmaligVorschau({query:(s,p)=>raw.query(s,p)});
 assert.deepEqual([v.bei_an.format_nachzug_s0,v.bei_an.format_nachzug_ueber_s1_nachzug,v.bei_an.altschichten_erneut_ohne_grund],[1,1,0],
  'P22-T245 B-1 reverseEinmaligVorschau: zaehlt nur l/bild.png ueber den S1-Nachzug, tatsaechlich '+JSON.stringify(v.bei_an));
 await d['entdecke']();
 assert.deepEqual(await auftraege(neu),[],'P22-T245 B-1 entdecke(): laesst S1 im Alt-Profil weiter aus ($4)');
 await raw.query('DELETE FROM reverse_leser_nachzug');
 assert.equal(await N.reverseNachzugVorrang(raw,d['ein']),null,'P22-T245 B-1 Voraussetzung: kein Vorrang (sonst setzt der S1-Nachzug aus)');
 await d['nachzugAuto']();
 const a=await auftraege(neu);
 const nzMarke=(await raw.query("SELECT metadaten->'nachzug_auto' AS m FROM reverse_dateien WHERE id=$1",[neu])).rows[0]?.m;
 assert.ok(a.length===1&&a[0].schicht==='S0'&&a[0].prioritaet==='nachzug','P22-T245 B-1 reverseS1FormatNachzugTakt: S0-Auftrag (nachzug) fuer l/bild.png, tatsaechlich '+JSON.stringify(a)+' nachzug_auto='+JSON.stringify(nzMarke));
 assert.deepEqual(await auftraege(ohne),[],'P22-T245 B-1: kein Auftrag fuer das weiter unerkannte Format');
 const marke=(await raw.query("SELECT metadaten#>>'{nachzug_auto,s1_format_geprueft}' AS m FROM reverse_dateien WHERE id=$1",[ohne])).rows[0].m;
 assert.equal(marke,d['version']+':'+parserProfil,'P22-T245 B-1: Pruefmarke = Inspektorstand der Pipeline:Parser-Profil');
 P.vergissReverseEinmaligVorschau();
 const v2=await P.reverseEinmaligVorschau({query:(s,p)=>raw.query(s,p)});
 assert.equal(v2.bei_an.format_nachzug_ueber_s1_nachzug,0,'P22-T245 B-1: nach dem Einreihen zaehlt die Vorschau die Datei nicht mehr, tatsaechlich '+JSON.stringify(v2.bei_an));
 P.reverseDrosselStand.stand=null;P.vergissReverseEinmaligVorschau();
 for(const n of ['s1_neu_parsen_auto','nachzug_vorrang_chunks_max','nachzug_vorrang_parse_max'])await raw.query("DELETE FROM reverse_einstellungen WHERE ebene='global' AND name=$1",[n]);
 await d.beende();
});
// Abnahme f91640e2 B-2: sind alle Dateien markiert, pruefte entdecke() je Durchlauf trotzdem alle Dateien (Prod 4,4 s, ~7 % eines DB-Kerns).
test('M P22-T245 Abnahme B-2 reverse-pipeline.ts entdecke(): kein Leerlauf-Vollscan; neuer Stand, Frist, Frist 0 und aus scannen',async()=>{
 await leeren();
 await setting('pipeline_einmalig','an');await setting('pipeline_entdecke_vollscan_ms',3600000);
 const d=await neuerDienst();
 const gesehen=async id=>(await raw.query('SELECT pipeline_gesehen_at::text AS am FROM reverse_dateien WHERE id=$1',[id])).rows[0]?.am??null;
 // 1) Echter Stand: Aenderungszaehler aus pg_stat_user_tables; sie laufen bis etwa 10 s nach, darum warten mit Obergrenze.
 const echt=d['entdeckeStand'].bind(d),vorher=await echt([]);
 assert.equal(typeof vorher,'string','P22-T245 B-2 entdeckeStand: Stand bestimmbar, tatsaechlich '+vorher);
 const c=await raw.connect();
 try{await c.query("INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,sha256,groesse,art,format,storage_key) VALUES($1,$2,'m/zaehler.png',$3,10,'asset','png',$4)",[rid,mid,sha(7001),rid+'/entpackt/m'+mid+'/m/zaehler.png']);
  await c.query('SELECT pg_stat_force_next_flush()').catch(()=>undefined);}finally{c.release();}
 let nachher=vorher;for(let i=0;i<40&&nachher===vorher;i++){await new Promise(r=>setTimeout(r,500));nachher=await echt([]);}
 assert.notEqual(nachher,vorher,'P22-T245 B-2 entdeckeStand: eine neue Datei aendert den Stand (nach hoechstens 20 s)');
 // 2) Logik mit festem Stand (deterministisch).
 await leeren();
 let stand='stand-1';d['entdeckeStand']=async()=>stand;
 await datei(d,'m/a.png',{format:'png'});
 const z0={...P.reverseDrosselStand.entdecke};
 await d['entdecke']();await d['entdecke']();            // 1. Scan markiert a, 2. Scan leer -> Stand gemerkt
 const z1={...P.reverseDrosselStand.entdecke};
 assert.equal(z1.vollscans-z0.vollscans,2,'P22-T245 B-2: zwei echte Scans, tatsaechlich '+JSON.stringify(z1));
 await d['entdecke']();
 const z2={...P.reverseDrosselStand.entdecke};
 assert.deepEqual([z2.uebersprungen-z1.uebersprungen,z2.vollscans-z1.vollscans],[1,0],'P22-T245 B-2: gleicher Stand nach leerem Scan -> kein Scan, tatsaechlich '+JSON.stringify(z2));
 const b=await datei(d,'m/b.png',{format:null,s0:null,s1:null});
 await d['entdecke']();
 assert.equal(await gesehen(b),null,'P22-T245 B-2: Stand unveraendert (Test-Stub) -> Scan entfaellt weiter');
 stand='stand-2';await d['entdecke']();
 assert.notEqual(await gesehen(b),null,'P22-T245 B-2: neuer Stand -> der Scan findet die neue Datei');
 await raw.query('DELETE FROM reverse_auftraege');await raw.query('DELETE FROM reverse_schichten WHERE datei_id=$1',[b]);await raw.query('DELETE FROM reverse_dateien WHERE id=$1',[b]);
 stand='stand-3';await d['entdecke']();                  // leer -> Stand gemerkt
 const z3={...P.reverseDrosselStand.entdecke};await d['entdecke']();
 assert.equal(P.reverseDrosselStand.entdecke.uebersprungen-z3.uebersprungen,1,'P22-T245 B-2: wieder uebersprungen');
 d['leerStand'].am-=3600001;const z4={...P.reverseDrosselStand.entdecke};await d['entdecke']();
 assert.equal(P.reverseDrosselStand.entdecke.vollscans-z4.vollscans,1,'P22-T245 B-2: nach pipeline_entdecke_vollscan_ms wird trotzdem gescannt');
 await setting('pipeline_entdecke_vollscan_ms',0);await d['einstellungen']();
 const z5={...P.reverseDrosselStand.entdecke};await d['entdecke']();await d['entdecke']();
 assert.deepEqual([P.reverseDrosselStand.entdecke.vollscans-z5.vollscans,P.reverseDrosselStand.entdecke.uebersprungen-z5.uebersprungen],[2,0],'P22-T245 B-2: Frist 0 = Abkuerzung aus');
 await setting('pipeline_entdecke_vollscan_ms',3600000);await setting('pipeline_einmalig','aus');await d['einstellungen']();
 const z6={...P.reverseDrosselStand.entdecke};await d['entdecke']();await d['entdecke']();
 assert.deepEqual([P.reverseDrosselStand.entdecke.vollscans-z6.vollscans,P.reverseDrosselStand.entdecke.uebersprungen-z6.uebersprungen],[0,0],'P22-T245 B-2: bei aus Altverhalten ohne Abkuerzung');
 await raw.query("DELETE FROM reverse_einstellungen WHERE ebene='global' AND name='pipeline_entdecke_vollscan_ms'");
 await d.beende();
});
// Abnahme f91640e2 B-4: ein gemeinsames Histogramm fuer E und Leser, jede Messung setzte es zurueck; der zweite Kanal sah dann 0.
test('N P22-T245 Abnahme B-4 reverse-einmalig.ts reverseBelastungMessen: Histogramm je Kanal',async()=>{
 E.reverseBelastungMessen('e');E.reverseBelastungMessen('leser');
 // Das Histogramm misst den Abstand zwischen zwei Takten (Aufloesung 20 ms): erst einen Takt abwarten, dann blockieren.
 await new Promise(r=>setTimeout(r,80));
 const bis=Date.now()+300;while(Date.now()<bis){/* blockiert den Event-Loop ~300 ms */}
 await new Promise(r=>setTimeout(r,50));
 const leser=E.reverseBelastungMessen('leser'),e=E.reverseBelastungMessen('e');
 assert.ok(leser.latenz_ms>=150,'P22-T245 B-4: Leser sieht die Blockade, tatsaechlich '+JSON.stringify(leser));
 assert.ok(e.latenz_ms>=150,'P22-T245 B-4: E sieht sie auch nach der Leser-Messung (eigenes Fenster), tatsaechlich '+JSON.stringify(e));
});
