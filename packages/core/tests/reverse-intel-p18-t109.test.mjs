/** P18-T109: globale Sichtbarkeit + Stand, code_intel/asset_intel mit project="rev-…", zentrales Fehlerlog.
 * Nur privates Schema in synapse_test:5433 (search_path auch fuer getPool), Schalter nur im privaten agent_profil_schalter.
 * Erwartet: "P18-T109 OK 46 Pruefungen" (34 Grundfaelle + 9 aus Abnahme 95d4d016: R1 3, R2 3, R3 3 + 3 aus Re-Abnahme 1ef9bb27: R2 teilweise/Publikation).
 * Lauf (nur Testphase): SYNAPSE_TEST_PHASE=P18-T109 DATABASE_URL=<synapse_test:5433> node packages/core/tests/reverse-intel-p18-t109.test.mjs */
import assert from 'node:assert/strict';
if(process.env.SYNAPSE_TEST_PHASE!=='P18-T109'){console.log('P18-T109 uebersprungen: nur mit SYNAPSE_TEST_PHASE=P18-T109');process.exit(0);}
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;delete process.env.SYNAPSE_INTERN_TOOL;
process.env.SYNAPSE_SKIP_EMBEDDINGS='1';process.env.QDRANT_URL='http://127.0.0.1:1';
const require=createRequire(new URL('../package.json',import.meta.url)),{Pool}=require('pg');
const raw=new Pool({connectionString:url.href,max:2});
const schema='p18_t109_'+process.pid,project='p18_t109',agent='p18_t109-agent',rid='rev-p18-t109';
await raw.query('CREATE SCHEMA '+schema);
url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.href;
const core=await import('../dist/index.js');
const {getPool}=await import('../dist/db/client.js');
const pool=getPool();
let passed=0;const ok=(c,m)=>{assert(c,m);passed++;};
const sha=s=>createHash('sha256').update(s).digest('hex');
const schalter=async(funktion,aktiv)=>{
 await pool.query("DELETE FROM agent_profil_schalter WHERE ebene='global' AND funktion=$1",[funktion]);
 if(aktiv!==null)await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,$1,$2,'p18-t109 test','test')",[funktion,aktiv]);
};
const service=core.createReverseToolService({pool,runtime:{containerStatus:async()=>({zustand:'laeuft',kaltstart_s:0})}});
const call=(action,args={})=>service.ausfuehren({action,project,agent_id:agent,reverse_id:rid,...args});
const intel=(tool,args)=>core.leiteReverseIntelUm(tool,{agent_id:agent,...args},agent);
try{
 assert.equal((await pool.query('SELECT current_database() AS d,current_schema() AS s')).rows[0].s,schema,'getPool im privaten Schema');
 for(const t of ['projects','agent_sessions','tool_aktivitaet','code_files','agent_profil_schalter'])
  await pool.query('CREATE TABLE '+schema+'.'+t+' (LIKE public.'+t+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 await pool.query((await import('../dist/db/reverse-schema.js')).REVERSE_SCHEMA_SQL);
 await pool.query((await import('../dist/db/hex-formate-schema.js')).HEX_FORMATE_SCHEMA_SQL);
 await pool.query((await import('../dist/db/reverse-erkenntnisse-schema.js')).REVERSE_ERKENNTNISSE_SCHEMA_SQL);
 for(const f of ['reverse-verknuepfungen-schema','reverse-einstellwerte-schema','reverse-parser-schema','reverse-leser-schema']){
  try{const m=await import('../dist/db/'+f+'.js');for(const sql of Object.values(m))if(typeof sql==='string')await pool.query(sql);}catch(e){console.log('optional schema',f,e.code??e.message);}
 }
 await pool.query(core.REVERSE_FEHLERLOG_SCHEMA_SQL);
 for(const [t,c] of [['reverse_eintraege','creator_identity_id'],['reverse_eintraege','confirmer_identity_id'],['reverse_bindungen','binder_identity_id'],
  ['reverse_uebernahmen','actor_identity_id'],['reverse_auftraege','trigger_identity_id']])await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${c} TEXT`).catch(()=>{});
 await pool.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,'fixture','/synthetic/p18_t109',true)",[project]);
 await pool.query("INSERT INTO agent_sessions(id,project,status) VALUES($1,$2,'active')",[agent,project]);
 await pool.query("INSERT INTO reverse_eintraege(id,titel,status) VALUES($1,'Synthetic T109','bestaetigt')",[rid]);
 await pool.query("INSERT INTO reverse_medien(id,eintrag_id,position,art) VALUES(910901,$1,0,'ordner')",[rid]);
 await pool.query("INSERT INTO reverse_dateien(id,eintrag_id,medium_id,pfad,sha256,format,arch,bits,art) VALUES(910901,$1,910901,'game.exe',$2,'pe','x86',32,'binaer'),(910902,$1,910901,'other.exe',$3,'pe','x86',32,'binaer')",[rid,'a'.repeat(64),'b'.repeat(64)]);
 await pool.query("INSERT INTO reverse_schichten(datei_id,schicht,fingerabdruck,status,werkzeug,funktionen_gesamt,funktionen_fertig) VALUES(910901,'S3','fp-S3','fertig','fixture',1,1)");
 const pfad='game.exe@S3/00001000_Main.c',inhalt='int Main() {\n return T109Needle();\n}';
 await pool.query("INSERT INTO reverse_code_dateien(id,eintrag_id,file_path,file_name,file_type,content,content_hash,datei_id,schicht,fingerabdruck,tsv,tsv_zerlegt) VALUES('t109-f1',$1,$2,'00001000_Main.c','c',$3,$4,910901,'S3','fp-S3',to_tsvector('english',$3),to_tsvector('simple',$3))",[rid,pfad,inhalt,sha(inhalt)]);
 await pool.query("INSERT INTO reverse_code_symbole(id,eintrag_id,file_path,symbol_type,name,line_start,line_end,params,is_exported,datei_id,schicht,fingerabdruck) VALUES('t109-fn',$1,$2,'function','Main',1,3,ARRAY['void'],true,910901,'S3','fp-S3')",[rid,pfad]);

 // --- A: alle Schalter AUS = Bestand ---
 for(const f of ['reverse_global_sichtbar','reverse_intel_abruf','reverse_fehlerlog'])await schalter(f,null);
 ok((await call('functions')).fehlercode==='nicht_gebunden','AUS: ohne Bindung nicht_gebunden');
 const eintragAus=await call('eintrag');ok(eintragAus.success===true&&!('stand' in eintragAus.eintrag),'AUS: eintrag ohne stand');
 ok(await intel('code_intel',{action:'functions',project:rid})===null,'AUS: code_intel-Weiche gibt Bestand');
 ok(!('fehlerlog' in await call('diagnose')),'AUS: diagnose ohne fehlerlog');
 await core.loggeReverseFehler({eintrag_id:rid,komponente:'tool',grund:'aus_test',quelle:'test'});
 ok(Number((await pool.query('SELECT count(*)::int AS n FROM reverse_fehlerlog')).rows[0].n)===0,'AUS: Fehlerlog schreibt nichts');

 // --- B: Teil 2 globale Sichtbarkeit + Stand ---
 await schalter('reverse_global_sichtbar',true);
 const fn=await call('functions');ok(fn.success===true&&fn.functions.some(f=>f.name==='Main'),'EIN: functions ohne Bindung: '+JSON.stringify(fn).slice(0,300));
 let e=(await call('eintrag')).eintrag;ok(e.stand==='vollstaendig'&&e.sichtbar==='global'&&e.dateien===2,'Stand vollstaendig: '+JSON.stringify(e));
 await pool.query("INSERT INTO reverse_schichten(datei_id,schicht,fingerabdruck,status,fehlercode) VALUES(910902,'S1','fp-x','fehler','zeitlimit')");
 e=(await call('eintrag')).eintrag;ok(e.stand==='mit_fehlern'&&e.schichten_fehler===1,'Stand mit_fehlern');
 await pool.query("INSERT INTO reverse_auftraege(eintrag_id,datei_id,schicht,status) VALUES($1,910902,'S1','laeuft')",[rid]);
 e=(await call('eintrag')).eintrag;ok(e.stand==='laeuft','Stand laeuft');
 ok((await call('functions',{reverse_id:'rev-gibt-es-nicht'})).fehlercode==='nicht_gefunden','EIN: unbekannter Eintrag bleibt nicht_gefunden');
 ok(await core.reverseEintragSichtbar(pool,'irgendein-projekt',rid)===true,'EIN: Sichtbarkeit projektunabhaengig');
 ok((await call('liste')).eintraege.some(x=>x.reverse_id===rid&&x.stand==='laeuft'),'liste traegt Stand');

 // --- C: Teil 1 code_intel/asset_intel mit rev-ID ---
 await schalter('reverse_intel_abruf',true);
 const f1=await intel('code_intel',{action:'functions',project:rid});
 ok(f1?.success===true&&f1.herkunft?.bereich==='reverse'&&f1.functions.some(x=>x.name==='Main'),'code_intel functions: '+JSON.stringify(f1).slice(0,300));
 const f2=await intel('code_intel',{action:'file',project:rid,file_path:pfad});
 ok(f2?.success===true&&f2.content.includes('T109Needle')&&f2.herkunft.reverse_action==='file','code_intel file');
 const f3=await intel('code_intel',{action:'search',project:rid,query:'T109Needle'});
 ok(f3?.success===true&&f3.results.length>=1,'code_intel search');
 const f4=await intel('code_intel',{action:'statements',project:rid});
 ok(f4?.success===false&&f4.error==='reverse_nicht_unterstuetzt'&&f4.erlaubt.includes('tree'),'statements -> reverse_nicht_unterstuetzt');
 ok((await intel('code_intel',{action:'flow',project:rid}))?.error==='reverse_nicht_unterstuetzt','flow -> reverse_nicht_unterstuetzt');
 ok(await intel('code_intel',{action:'functions',project:project})===null,'normales Projekt -> Bestand');
 ok(await intel('code_intel',{action:'functions',project:'rev-unbekannt'})===null,'unbekannte rev-ID -> Bestand');
 const a1=await core.fuehreAssetIntelAus({action:'graph',project:rid},{agentId:agent});
 ok(a1.error==='reverse_nicht_unterstuetzt'&&a1.herkunft?.tool==='asset_intel','asset_intel graph -> reverse_nicht_unterstuetzt');
 const a2=await core.fuehreAssetIntelAus({action:'tree',project:rid},{agentId:agent});
 ok(a2.herkunft?.reverse_action==='assets_tree','asset_intel tree -> assets_tree: '+JSON.stringify(a2).slice(0,300));
 await pool.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,'fixture','/synthetic/kollision',true)",[rid]);
 ok(await intel('code_intel',{action:'functions',project:rid})===null,'gleichnamiges Projekt gewinnt');
 // Abnahme R1: als Reverse bezeugter Aufruf faellt nie in den Projektpfad (Kollision bzw. Schalter AUS nach der Pruefung).
 const bezeugt=()=>core.bezeugeReverseIntelZiel({action:'functions',project:rid,agent_id:agent},rid);
 const r1=await core.leiteReverseIntelUm('code_intel',bezeugt(),agent);
 ok(r1?.error==='reverse_ziel_ungueltig'&&r1.grund==='projekt_gleichnamig','R1: Kollision nach Reverse-Autorisierung -> fail-closed');
 ok(await core.leiteReverseIntelUm('code_intel',JSON.parse(JSON.stringify(bezeugt())),agent)===null,'R1: Zeuge nicht aus JSON faelschbar');
 await pool.query('DELETE FROM projects WHERE name=$1',[rid]);
 await schalter('reverse_intel_abruf',false);
 ok((await core.leiteReverseIntelUm('code_intel',bezeugt(),agent))?.grund==='schalter_aus','R1: Schalter AUS nach Autorisierung -> fail-closed');
 await schalter('reverse_intel_abruf',true);
 await schalter('reverse_global_sichtbar',false);
 const f5=await intel('code_intel',{action:'functions',project:rid});
 ok(f5?.fehlercode==='nicht_gebunden','Sichtbarkeit AUS greift auch ueber code_intel');
 await schalter('reverse_global_sichtbar',true);
 ok(core.reverseIntelVerlauf().length>0,'Debug-Verlauf der Weiche');

 // --- D: Teil 3 Fehlerlog ---
 await schalter('reverse_fehlerlog',true);
 await pool.query("INSERT INTO reverse_auftraege(eintrag_id,datei_id,schicht,status,fehlercode) VALUES($1,910901,'S2','fehler','zeitlimit')",[rid]);
 await pool.query("UPDATE reverse_medien SET fehlercode='format_nicht_unterstuetzt:cue' WHERE id=910901");
 await core.loggeReverseFehler({eintrag_id:rid,komponente:'tool',name:'functions',grund:'test_fehler',quelle:'test'});
 await core.loggeReverseFehler({eintrag_id:rid,komponente:'tool',name:'functions',grund:'test_fehler',quelle:'test'});
 const log=await core.leseReverseFehlerlog({reverseId:rid,pool});
 ok(log.aktiv===true,'Fehlerlog aktiv');
 ok(log.eintraege.some(x=>x.komponente==='zeitlimit'&&x.quelle==='reverse_auftraege'),'Auftrag zeitlimit: '+JSON.stringify(log).slice(0,600));
 ok(log.eintraege.some(x=>x.quelle==='reverse_schichten'&&x.grund==='zeitlimit'),'Schicht fehler');
 ok(log.eintraege.some(x=>x.quelle==='reverse_medien'&&x.komponente==='leser'),'Medium format_nicht_unterstuetzt -> leser');
 ok(log.eintraege.some(x=>x.quelle==='reverse_fehlerlog'&&x.anzahl===2),'Upsert zaehlt hoch');
 ok(log.je_komponente.tool===1,'je_komponente');
 const nurTool=await core.leseReverseFehlerlog({reverseId:rid,komponente:'tool',pool});ok(nurTool.total===1,'Filter komponente');
 const seite=await core.leseReverseFehlerlog({reverseId:rid,limit:1,pool});ok(seite.eintraege.length===1&&seite.naechster_offset===1,'Paging');
 const diag=await call('diagnose');ok(diag.success===true&&diag.fehlerlog?.aktiv===true,'diagnose traegt fehlerlog');
 // Abnahme R3b: Entstoerer-Massnahme mit Eintrag/Schicht aus dem Ziel-Auftrag.
 const fehlerAuftrag=(await pool.query("SELECT id::text FROM reverse_auftraege WHERE eintrag_id=$1 AND status='fehler' LIMIT 1",[rid])).rows[0].id;
 await core.loggeReverseMassnahme({quelle:'test',ursache:'lease_abgelaufen',massnahme:'freigeben',ziel:fehlerAuftrag,ergebnis:'freigegeben'});
 const mitEnt=await core.leseReverseFehlerlog({reverseId:rid,komponente:'entstoerer',pool});
 ok(mitEnt.eintraege.some(x=>x.eintrag_id===rid&&x.schicht==='S2'&&x.grund==='lease_abgelaufen'),'R3b: Entstoerer im Eintragslog: '+JSON.stringify(mitEnt).slice(0,400));
 // Abnahme R3a: RV27-Gruppe ohne Leser ueber dieselbe Klassifikation wie der Leserhinweis (Registry leer -> kein_leser).
 await pool.query("INSERT INTO reverse_dateien(id,eintrag_id,medium_id,pfad,sha256,format,art,metadaten) VALUES(910903,$1,910901,'GFX/a.dat',$2,'unbekannt','sonstig',$3::jsonb)",
  [rid,'f'.repeat(64),JSON.stringify({rv27:{extension:'.dat',magic:'47465831',size_pattern:'x',header_hex:'4746583100'}})]);
 const rv27=await core.leseReverseFehlerlog({reverseId:rid,komponente:'leser',pool});
 ok(rv27.eintraege.some(x=>x.quelle==='rv27_leser'&&x.grund==='kein_leser'),'R3a: kein_leser aus Leserklassifikation: '+JSON.stringify(rv27).slice(0,400));
 // Abnahme R3d: ehrliche Vollstaendigkeitsangabe.
 ok(typeof rv27.vollstaendig==='boolean'&&Array.isArray(rv27.quellen_gekappt)&&Number.isInteger(rv27.deckel_je_quelle),'R3d: vollstaendig/quellen_gekappt/deckel aus Einstellwerten');
 await pool.query('ALTER TABLE reverse_fehlerlog RENAME TO reverse_fehlerlog_weg');
 await core.loggeReverseFehler({eintrag_id:rid,komponente:'tool',grund:'ohne_tabelle',quelle:'test'});
 const ohne=await core.leseReverseFehlerlog({reverseId:rid,pool});
 ok(ohne.aktiv===true&&ohne.quellen_fehler.some(q=>q.quelle==='reverse_fehlerlog')&&ohne.letzter_schreibfehler,'fehlende Tabelle blockiert nicht');
 await pool.query('ALTER TABLE reverse_fehlerlog_weg RENAME TO reverse_fehlerlog');
 // Abnahme R2: Leserlauf (juengster je Datei/Quell-sha256) bestimmt den Stand mit.
 const rid2='rev-p18-t109-leser',lid='c'.repeat(64);
 ok(!!(await pool.query("SELECT to_regclass('reverse_leser_laeufe') AS t")).rows[0].t,'R2: Leserschema im Testschema vorhanden');
 await pool.query("INSERT INTO reverse_eintraege(id,titel,status) VALUES($1,'Leser T109','bestaetigt')",[rid2]);
 await pool.query("INSERT INTO reverse_medien(id,eintrag_id,position,art) VALUES(910911,$1,0,'ordner')",[rid2]);
 await pool.query("INSERT INTO reverse_dateien(id,eintrag_id,medium_id,pfad,sha256,art) VALUES(910911,$1,910911,'x.dat',$2,'sonstig')",[rid2,'9'.repeat(64)]);
 const manifest={name:'t109leser',version:'1',runtime:'python3'};
 await pool.query("INSERT INTO reverse_leser(id,name,version,schnittstelle_version,runtime,manifest,manifest_sha256,code_sha256,paket_sha256,quelle,quell_bytes,registriert_von) VALUES($1,'t109leser','1',1,'python3',$2::jsonb,$3,$3,$3,'{}'::jsonb,1,'test')",[lid,JSON.stringify(manifest),'d'.repeat(64)]);
 await pool.query("INSERT INTO reverse_leser_laeufe(id,leser_id,eintrag_id,datei_id,quell_sha256,generation,status,einstellungen_revision) VALUES(gen_random_uuid(),$1,$2,910911,$3,gen_random_uuid(),'laeuft',$4)",[lid,rid2,'9'.repeat(64),'e'.repeat(64)]);
 ok((await call('eintrag',{reverse_id:rid2})).eintrag?.stand==='laeuft','R2: laufender Leserlauf -> laeuft');
 await pool.query("UPDATE reverse_leser_laeufe SET status='fehler',fehlercode='leser_fehler' WHERE eintrag_id=$1",[rid2]);
 const e2=(await call('eintrag',{reverse_id:rid2})).eintrag;
 ok(e2?.stand==='mit_fehlern'&&e2.leser_fehler===1,'R2: fehlerhafter Leserlauf -> mit_fehlern: '+JSON.stringify(e2));
 // Re-Abnahme 1ef9bb27: teilweise = unvollstaendig; fertig ohne Host-Validierung = Publikation laeuft noch.
 await pool.query("UPDATE reverse_leser_laeufe SET status='teilweise',fehlercode=NULL WHERE eintrag_id=$1",[rid2]);
 const e3=(await call('eintrag',{reverse_id:rid2})).eintrag;
 ok(e3?.stand==='mit_fehlern'&&e3.leser_teilweise===1,'R2: teilweise -> mit_fehlern/leser_teilweise: '+JSON.stringify(e3));
 await pool.query("UPDATE reverse_leser_laeufe SET status='fertig',manifest_key='m',manifest_sha256=$2,beendet_at=clock_timestamp(),diagnose=jsonb_build_object('host_validiert',false) WHERE eintrag_id=$1",[rid2,'a'.repeat(64)]);
 ok((await call('eintrag',{reverse_id:rid2})).eintrag?.stand==='laeuft','R2: fertig ohne host_validiert -> laeuft (Publikation)');
 await pool.query("UPDATE reverse_leser_laeufe SET diagnose=jsonb_build_object('host_validiert',true) WHERE eintrag_id=$1",[rid2]);
 ok((await call('eintrag',{reverse_id:rid2})).eintrag?.stand==='vollstaendig','R2: hostvalidiert fertig -> vollstaendig');
 console.log('P18-T109 OK',passed,'Pruefungen');
}finally{
 await raw.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(e=>console.error('cleanup',e.message));
 await pool.end().catch(()=>{});await raw.end();
}
