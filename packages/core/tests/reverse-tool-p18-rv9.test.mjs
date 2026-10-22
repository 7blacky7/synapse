/** RV9: Kernel/Rechte/Status und Alt-Schemas, nur synthetisches p18_rv9 in synapse_test:5433. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
const schema='p18_rv9_'+process.pid;
// DSN bleibt unverändert; der explizite PG-Pool erhält nur einen eigenen Suchpfad.
process.env.SYNAPSE_SKIP_EMBEDDINGS='1';process.env.QDRANT_URL='http://127.0.0.1:1';
// P18-T61/E4: Standard-Obergrenze ist S1; die Bestätigungs-Policy wird hier mit S3 geprüft.
process.env.SYNAPSE_REVERSE_BIS_SCHICHT='S3';
const core=await import('../dist/index.js');
assert.equal(typeof core.fuehreReverseAus,'function','RV9 Dispatcher fehlt (rote Kontrolle)');
const {REVERSE_DEFINITION,createReverseToolService,REVERSE_FEHLERCODES}=core;
const {REVERSE_SCHEMA_SQL}=await import('../dist/db/reverse-schema.js');
const {mitLesePool}=await import('../dist/db/client.js');
const require=createRequire(new URL('../package.json',import.meta.url));
const {Pool}=require('pg');
const pgPool=new Pool({connectionString:process.env.DATABASE_URL}),project='p18_rv9',agent='p18_rv9-agent',other='p18_rv9-other',rid='rev-fixture-000001',second='rev-fixture-000002';
const pool={
 async connect(){const client=await pgPool.connect();try{await client.query('SET search_path TO '+schema+',public');return client;}catch(e){client.release();throw e;}},
 async query(...args){const client=await this.connect();try{return await client.query(...args);}finally{client.release();}},
 end:()=>pgPool.end(),
};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const required=['reverse_id','datei','format','arch','bits','schicht','schicht_angefragt','status','fehlercode','werkzeug','merkmale','fortschritt','container'];
const pipeline=new core.ReversePipelineDienst({pool,konfiguration:core.ladeAssetKonfiguration({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:'/unused-rv9'}),ausfuehrbareKinds:[]});
// T104: echte PG-Pipeline, nur Planung; kein starte()/durchlauf(), kein Runner oder Share-Zugriff.
let service=createReverseToolService({pool});
const call=(action,extra={},who=agent)=>mitLesePool(pool,()=>service.ausfuehren({action,agent_id:who,project,reverse_id:rid,...extra}));
const tx=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
const automatisch=(entry,file,medium)=>mitLesePool(pool,()=>tx(c=>pipeline.queue(c,{reverseId:entry,dateiId:file,mediumId:medium,project,agentId:'reverse-pipeline',bisSchicht:'S3',prioritaet:'hintergrund'})));
const check=r=>{for(const key of required)assert(Object.hasOwn(r,key),'Pflichtfeld '+key);for(const key of required)assert(Object.hasOwn(r.felder,key),'Hinweisfeld '+key);return r;};
try {
 await pool.query('CREATE SCHEMA '+schema);
 for(const table of ['agent_sessions','projects','tool_aktivitaet','work_jobs','work_job_audit','agent_profil_schalter','intern_schalter'])await pool.query('CREATE TABLE '+schema+'.'+table+' (LIKE public.'+table+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 await pool.query(REVERSE_SCHEMA_SQL);
 await pool.query((await import('../dist/db/reverse-pipeline-schema.js')).REVERSE_PIPELINE_SCHEMA_SQL);
 // T104: privates Schema braucht dieselbe additive Migration144; zweimal belegt Idempotenz.
 const policyDdl=(await import('../dist/db/reverse-analyse-policy-schema.js')).REVERSE_ANALYSE_POLICY_SCHEMA_SQL;
 await pool.query(policyDdl);await pool.query(policyDdl);
 assert.equal((await pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='reverse_auftraege' AND column_name='policy_pin'",[schema])).rows[0].is_nullable,'YES');
 await pool.query((await import('../dist/db/hex-formate-schema.js')).HEX_FORMATE_SCHEMA_SQL);
 // P18-T86: analyse_bis_schicht kommt aus reverse_einstellungen (Env nur Migrationsvorschlag); diese Fixture arbeitet bis S3.
 for(const f of ['reverse-verknuepfungen-schema','reverse-einstellwerte-schema'])await pool.query(Object.values(await import('../dist/db/'+f+'.js')).find(x=>typeof x==='string'));
 await pool.query("INSERT INTO reverse_einstellungen(ebene,name,wert_text,grund,gesetzt_von) VALUES('global','analyse_bis_schicht','S3','RV9 fixture','fixture')");
 await pool.query((await import('../dist/db/reverse-erkenntnisse-schema.js')).REVERSE_ERKENNTNISSE_SCHEMA_SQL);
 // P22-T15 (Schema 112): Akteur-ID-Spalten der Reverse-Tabellen (ohne FK, agent_identitaeten liegt nicht im Testschema).
 for(const [t,c] of [['reverse_eintraege','creator_identity_id'],['reverse_eintraege','confirmer_identity_id'],['reverse_bindungen','binder_identity_id'],
  ['reverse_uebernahmen','actor_identity_id'],['reverse_auftraege','trigger_identity_id']])await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${c} TEXT`).catch(()=>{});
 await pool.query("INSERT INTO agent_sessions(id,project,status,sitzung_seit) VALUES($1,$3,'active',NOW()),($2,$3,'active',NOW()),('koordinator',$3,'active',NOW())",[agent,other,project]);
 await pool.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,'fixture','/synthetic/p18_rv9',true)",[project]);
 await pool.query("INSERT INTO reverse_eintraege(id,titel,tags) VALUES($1,'Fixture A',ARRAY['demo']),($2,'Fixture B',ARRAY['andere'])",[rid,second]);
 await pool.query("INSERT INTO reverse_medien(id,eintrag_id,position,bezeichnung,art,satz_sha256) VALUES(1,$1,0,'CD1','iso',$2),(2,$1,1,'CD2','iso',$3),(3,$4,0,'DVD','iso',$5)",[rid,'a'.repeat(64),'b'.repeat(64),second,'c'.repeat(64)]);
 const list=check(await call('liste',{reverse_id:undefined,limit:1}));
 assert.equal(list.total,2);assert.equal(list.gekappt,true);assert.equal(list.naechster_offset,1);
 assert.equal(list.eintraege.length,1);assert(!JSON.stringify(list).includes('storage_key'));
 assert.equal((await call('liste',{tag:'demo'})).total,1);assert.equal((await call('liste',{query:"' OR 1=1 --"})).total,0,'Suche gebunden');
 assert.equal((await call('vorschlaege')).total,2);
 const entry=check(await call('eintrag'));assert.equal(entry.eintrag.medien.length,2);
 assert.equal((await call('archivieren')).fehlercode,'keine_berechtigung');
 assert.equal((await call('bestaetigen')).fehlercode,'keine_berechtigung');
 const confirm=await call('bestaetigen',{titel:'Titel neu',medien:[{id:'2',bezeichnung:'DiscB'},{id:'1',bezeichnung:'DiscA'}]},'koordinator');
 assert.equal(confirm.success,true);assert.equal(confirm.eintrag.status,'bestaetigt');assert.equal(confirm.eintrag.medien[0].id,'2');
 assert.equal(Object.hasOwn((await pool.query('SELECT analyse_policy FROM reverse_eintraege WHERE id=$1',[rid])).rows[0].analyse_policy,'bis_schicht'),false,'Normale Bestätigung entfernt T104-JSON-Schatten');
 assert.equal((await call('bestaetigen',{},'koordinator')).success,true,'Bestätigung idempotent');
 await pool.query("INSERT INTO reverse_dateien(id,eintrag_id,medium_id,pfad,format,arch,bits,art,status,metadaten) VALUES(1,$1,1,'cd1/game.exe','pe','x86',32,'binaer','offen','{\"merkmale\":[\"debug_symbole\"]}')",[rid]);
 await pool.query("UPDATE reverse_dateien SET sha256=$2 WHERE id=1 AND eintrag_id=$1",[rid,'e'.repeat(64)]);
 assert.equal(check(await call('status',{datei:'cd1/game.exe'})).fehlercode,'nicht_gebunden');
 assert.equal((await call('analysieren',{datei:'cd1/game.exe',bis_schicht:'S3'})).fehlercode,'nicht_gebunden');
 assert.equal((await call('binden',{project:'fremd'})).fehlercode,'keine_berechtigung','Agent darf fremdes Projekt nicht behaupten');
 const bindings=await Promise.all(Array.from({length:4},()=>call('binden')));
 assert(bindings.every(r=>r.success));assert.equal((await pool.query('SELECT count(*)::int AS n FROM reverse_bindungen WHERE project=$1 AND geloest_at IS NULL',[project])).rows[0].n,1);
 assert.equal((await call('bindungen',{reverse_id:undefined})).total,1);
 assert.equal((await call('status',{datei:'../etc/passwd'})).fehlercode,'pfad_gefahr');
 let status=check(await call('status',{datei:'cd1/game.exe'}));assert.equal(status.format,'pe');assert.equal(status.bits,32);assert.equal(status.schicht,null);
 assert.deepEqual(status.merkmale,['debug_symbole']);assert.equal(status.container.zustand,'ruht');
 const serialized=core.baueToolErgebnis(status,{tool:'reverse',strukturiert:true});
 for(const key of required)assert(Object.hasOwn(serialized.structuredContent,key),'Hülle erhält '+key);
 // T104 entfernt absichtlich den ungepinnten Fallback: ohne Runtime muss die Queue leer bleiben.
 const ohneRuntime=check(await call('analysieren',{datei:'cd1/game.exe',bis_schicht:'S3',prioritaet:'interaktiv'}));
 assert.equal(ohneRuntime.fehlercode,'kein_ausfuehrer');
 assert.equal((await pool.query('SELECT count(*)::int n FROM reverse_auftraege')).rows[0].n,0);
 service=createReverseToolService({pool,runtime:{analysieren:(a,c)=>pipeline.analysieren(a,c),abbrechen:(j,a,c)=>pipeline.abbrechen(j,a,c),containerStatus:r=>pipeline.containerStatus(r)}});
 let queue=check(await call('analysieren',{datei:'cd1/game.exe',bis_schicht:'S3',prioritaet:'interaktiv'}));
 // Erste reale Schicht ist API-S0: wartet ohne Containerfehler, mit unveränderlichem Quell-/Policy-Pin.
 assert.equal(queue.status,'wartet');assert.equal(queue.fehlercode,null);assert(queue.auftrag_id);
 const firstQueue=(await pool.query('SELECT * FROM reverse_auftraege WHERE id=$1',[queue.auftrag_id])).rows[0];
 assert.equal(firstQueue.prioritaet,'interaktiv');assert.equal(firstQueue.schicht,'S0');
 assert.equal(firstQueue.policy_pin.wirksam_bis,'S3');assert.equal(firstQueue.policy_pin.quelle.sha256,'e'.repeat(64));
 assert.equal((await automatisch(rid,'1','1')).auftrag_id,queue.auftrag_id,'Automatische Planung dedupliziert echten gepinnten Auftrag');
 assert.equal((await pool.query('SELECT prioritaet FROM reverse_auftraege WHERE id=$1',[queue.auftrag_id])).rows[0].prioritaet,'interaktiv','Automatischer Hintergrundnachzug senkt Priorität nicht');
 // Ausdrücklicher Folgeauftrag ersetzt seit T104 den manuellen Root, statt den alten Pin umzuschreiben.
 queue=check(await call('analysieren',{datei:'cd1/game.exe',bis_schicht:'S3',prioritaet:'hintergrund'}));
 assert.notEqual(queue.auftrag_id,firstQueue.id);assert.equal(queue.status,'wartet');
 const replaced=(await pool.query('SELECT status,fehlercode,policy_pin FROM reverse_auftraege WHERE id=$1',[firstQueue.id])).rows[0];
 assert.equal(replaced.status,'fehler');assert.equal(replaced.fehlercode,'policy_geaendert');assert.deepEqual(replaced.policy_pin,firstQueue.policy_pin);
 assert.equal((await pool.query("SELECT count(*)::int n FROM reverse_auftraege WHERE datei_id=1 AND status IN ('offen','wartet','laeuft')")).rows[0].n,1);
 assert.equal((await call('abbrechen',{auftrag_id:queue.auftrag_id},other)).fehlercode,'keine_berechtigung');
 assert.equal((await call('abbrechen',{auftrag_id:queue.auftrag_id})).success,true);
 await pool.query("INSERT INTO reverse_schichten(datei_id,medium_id,schicht,fingerabdruck,status,werkzeug,funktionen_gesamt,funktionen_fertig) VALUES(1,1,'S1','fixture','laeuft','fixture-tool',10,2)");
 status=check(await call('status',{datei:'cd1/game.exe'}));
 assert.equal(status.schicht,null);assert.equal(status.schicht_angefragt,'S1');assert.equal(status.fortschritt.fertig,2);
 const pending=call('status',{datei:'cd1/game.exe',warten_sekunden:1});
 await new Promise(r=>setTimeout(r,100));
 await pool.query("UPDATE reverse_schichten SET status='fertig',funktionen_fertig=10,beendet_at=NOW() WHERE datei_id=1");
 assert.equal(check(await pending).schicht,'S1','Long-Poll sieht Änderung');
 const before=(await pool.query("SELECT count(*)::int AS n FROM tool_aktivitaet WHERE projekt=$1 AND zaehlt_als_aktivitaet",[project])).rows[0].n;
 await call('status',{datei:'cd1/game.exe'});
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM tool_aktivitaet WHERE projekt=$1 AND zaehlt_als_aktivitaet",[project])).rows[0].n,before,'Statuspoll keine Aktivität');
 assert(before>0,'Gebundene akzeptierte Aufrufe zählen');
 const unknown=check(await call('eintrag',{typo:1}));assert.equal(unknown.fehler,'unbekannte_parameter');assert.deepEqual(unknown.unbekannt,['typo']);
 assert((await call('eintrag',{limit:1})).nicht_verwendet.includes('limit'));
 assert.equal((await service.ausfuehren({action:'liste'})).fehlercode,'keine_berechtigung');
 assert.equal((await call('eintrag',{reverse_id:'rev-absent-ffffff'})).fehlercode,'nicht_gefunden');
 assert.equal((await call('status',{warten_sekunden:51})).fehler,'parameter_ungueltig');
 assert.equal((await call('loesen')).success,true);assert.equal((await call('status',{datei:'cd1/game.exe'})).fehlercode,'nicht_gebunden');
 assert.equal((await call('binden')).success,true,'Neubindung nach Lösung');
 assert.equal((await call('archivieren',{},'koordinator')).success,true);
 assert.equal((await call('eintrag')).eintrag.status,'archiviert');
 assert.equal((await call('analysieren',{datei:'cd1/game.exe',bis_schicht:'S3'})).fehlercode,'keine_berechtigung','Archiv startet keine Analyse');

 // Gruppenmutation bleibt atomar; Originale/Analysehistorie werden nicht umgeschrieben.
 const splitRid='rev-split-fixture',mergeRid='rev-merge-fixture',lockedRid='rev-locked-fixture';
 await pool.query("INSERT INTO reverse_eintraege(id,titel) VALUES($1,'Split'),($2,'Merge'),($3,'E fertig')",[splitRid,mergeRid,lockedRid]);
 await pool.query("INSERT INTO reverse_medien(id,eintrag_id,position,art,satz_sha256) VALUES(4,$1,0,'iso',$4),(5,$1,1,'iso',$5),(6,$2,0,'iso',$6),(7,$3,0,'iso',$7)",[splitRid,mergeRid,lockedRid,'d'.repeat(64),'e'.repeat(64),'f'.repeat(64),'0'.repeat(64)]);
 const invalid=await call('bestaetigen',{reverse_id:splitRid,aufteilen:[{titel:'A',medien:['4']},{titel:'B',medien:['4']}]},'koordinator');
 assert.equal(invalid.success,false);
 assert.equal((await call('eintrag',{reverse_id:splitRid})).eintrag.medien.length,2,'Ungültige Partition rollt zurück');
 const split=await call('bestaetigen',{reverse_id:splitRid,aufteilen:[{titel:'A',medien:['4']},{titel:'B',medien:['5']}]},'koordinator');
 assert.equal(split.success,true,JSON.stringify(split));assert.equal(split.aufgeteilt.length,2);
 assert.equal((await call('eintrag',{reverse_id:splitRid})).eintrag.status,'archiviert');
 const children=(await pool.query('SELECT id,fingerabdruck,bestaetigt_von,analyse_policy FROM reverse_eintraege WHERE id=ANY($1::text[])',[split.aufgeteilt])).rows;
 // T104 ändert die wirksame Tiefenquelle, nicht die unveränderte Gruppierungsimplementierung.
 // Deren historische JSON-S3-Kopie darf PG nicht überstimmen; Fingerprint und Bestätiger bleiben streng geprüft.
 assert(children.every(c=>c.fingerabdruck?.length===64&&c.bestaetigt_von==='koordinator'),JSON.stringify(children));
 for(const child of children){
  assert.equal((await core.leseReverseEinstellwerte({project,eintrag_id:child.id},pool)).werte.analyse_bis_schicht.wert,'S3');
  await pool.query("INSERT INTO reverse_einstellungen(ebene,eintrag_id,name,wert_text,grund,gesetzt_von) VALUES('eintrag',$1,'analyse_bis_schicht','E','RV9 fixture','fixture')",[child.id]);
  assert.equal((await core.leseReverseEinstellwerte({project,eintrag_id:child.id},pool)).werte.analyse_bis_schicht.wert,'E','Eintrags-PG gewinnt gegen historische JSON-Kopie');
  await pool.query("DELETE FROM reverse_einstellungen WHERE ebene='eintrag' AND eintrag_id=$1 AND name='analyse_bis_schicht'",[child.id]);
 }
 const merged=await call('bestaetigen',{reverse_id:mergeRid,zusammenfuehren_mit:split.aufgeteilt[0]},'koordinator');
 assert.equal(merged.success,true,JSON.stringify(merged));assert.equal(merged.eintrag.medien.length,2);
 assert.equal((await call('eintrag',{reverse_id:mergeRid})).eintrag.status,'archiviert');
 await pool.query("INSERT INTO reverse_schichten(medium_id,schicht,fingerabdruck,status) VALUES(7,'E','fixture-e','fertig')");
 assert.equal((await call('bestaetigen',{reverse_id:lockedRid,zusammenfuehren_mit:split.aufgeteilt[1]},'koordinator')).fehlercode,'ziel_belegt','E-Historie schützt Gruppierung');
 // Gleiche globale Queue-Race-Assertion am echten Pipelineweg, mit synthetischen hashgebundenen S0-Quellen.
 const childSources=new Map();
 for(const [i,child] of split.aufgeteilt.entries()){
  assert.equal((await call('binden',{reverse_id:child})).success,true);
  const medium=(await pool.query('SELECT id::text FROM reverse_medien WHERE eintrag_id=$1 ORDER BY id LIMIT 1',[child])).rows[0].id;
  const file=String(10+i);childSources.set(child,{file,medium});
  await pool.query("INSERT INTO reverse_dateien(id,eintrag_id,medium_id,pfad,sha256,art) VALUES($1,$2,$3,'queue.bin',$4,'binaer')",[file,child,medium,String(i+1).repeat(64)]);
 }
 // P18-T86: Queuegrenze aus reverse_einstellungen (queue_offene_max), nicht mehr aus der Env.
 await pool.query("INSERT INTO reverse_einstellungen(ebene,name,wert,grund,gesetzt_von) VALUES('global','queue_offene_max',1,'RV9 fixture','fixture')");
 const raced=await Promise.all(split.aufgeteilt.map(child=>call('analysieren',{reverse_id:child,datei:'queue.bin',bis_schicht:'S3'})));
 assert.equal(raced.filter(r=>r.success).length,1);assert.equal(raced.filter(r=>r.fehlercode==='warteschlange_voll').length,1);
 let winner=raced.find(r=>r.success);const winnerRid=winner.reverse_id;
 // T104: Dedupe gilt für automatische Wiederplanung; manuelle Ersetzung ist oben separat streng geprüft.
 const source=childSources.get(winnerRid);
 const dedups=await Promise.all(Array.from({length:4},()=>automatisch(winnerRid,source.file,source.medium)));
 assert(dedups.every(r=>r.auftrag_id===winner.auftrag_id));
 assert.equal((await pool.query("SELECT count(*)::int n FROM reverse_auftraege WHERE eintrag_id=$1 AND status IN ('offen','wartet','laeuft')",[winnerRid])).rows[0].n,1);
 // Ein Env-Wert darf den laufend gelesenen globalen PG-Wert nicht ersetzen.
 const oldQueueEnv=process.env.SYNAPSE_REVERSE_QUEUE_MAX;process.env.SYNAPSE_REVERSE_QUEUE_MAX='999999';
 const pendingCount=async()=>Number((await pool.query("SELECT count(*) n FROM reverse_auftraege WHERE status IN ('offen','wartet','laeuft')")).rows[0].n);
 const row=async id=>(await pool.query('SELECT * FROM reverse_auftraege WHERE id=$1',[id])).rows[0];
 try{
  assert.equal(await pendingCount(),1);
  const loserRid=split.aufgeteilt.find(id=>id!==winnerRid),loserSource=childSources.get(loserRid);
  assert.equal((await pool.query('SELECT count(*)::int n FROM reverse_auftraege WHERE eintrag_id=$1',[loserRid])).rows[0].n,0,'Abgewiesene Annahme schreibt weder Root noch Auftrag');
  const autoFull=await automatisch(loserRid,loserSource.file,loserSource.medium);
  assert.equal(autoFull.fehlercode,'warteschlange_voll');assert.equal(autoFull.auftrag_id,null);assert.equal(await pendingCount(),1);
  const oldWinner=await row(winner.auftrag_id);
  const replacement=await call('analysieren',{reverse_id:winnerRid,datei:'queue.bin',bis_schicht:'S3'});
  assert.equal(replacement.success,true);assert.notEqual(replacement.auftrag_id,winner.auftrag_id);
  assert.deepEqual((await row(winner.auftrag_id)).policy_pin,oldWinner.policy_pin,'Ersetzung verändert alten Pin nie');
  assert.equal((await row(winner.auftrag_id)).fehlercode,'policy_geaendert');assert.equal(await pendingCount(),1,'Ersetzung an voller Grenze bleibt platzneutral');
  winner=replacement;
  // Zwei freie Kandidaten konkurrieren um genau einen Restplatz bei PG-Limit 2.
  await pool.query("INSERT INTO reverse_dateien(id,eintrag_id,medium_id,pfad,sha256,art) VALUES(12,$1,$2,'extra.bin',$3,'binaer')",[winnerRid,source.medium,'9'.repeat(64)]);
  await pool.query("UPDATE reverse_einstellungen SET wert=2 WHERE ebene='global' AND name='queue_offene_max'");
  const two=await Promise.all([call('analysieren',{reverse_id:loserRid,datei:'queue.bin',bis_schicht:'S3'}),call('analysieren',{reverse_id:winnerRid,datei:'extra.bin',bis_schicht:'S3'})]);
  assert.equal(two.filter(r=>r.success).length,1);assert.equal(two.filter(r=>r.fehlercode==='warteschlange_voll').length,1);assert.equal(await pendingCount(),2);
  // Nach Absenkung unter den Bestand wird nichts verdrängt, auch keine manuelle Policy.
  await pool.query("UPDATE reverse_einstellungen SET wert=1 WHERE ebene='global' AND name='queue_offene_max'");
  const beforeRejected=await row(winner.auftrag_id),allBefore=(await pool.query('SELECT count(*)::int n FROM reverse_auftraege')).rows[0].n;
  const rejected=await call('analysieren',{reverse_id:winnerRid,datei:'queue.bin',bis_schicht:'S0'});
  assert.equal(rejected.success,false);assert.equal(rejected.fehlercode,'warteschlange_voll');
  assert.deepEqual(await row(winner.auftrag_id),beforeRejected,'Abweisung verändert weder Status/Pin noch Zeitstempel');
  assert.equal((await pool.query('SELECT count(*)::int n FROM reverse_auftraege')).rows[0].n,allBefore);
  assert.equal((await automatisch(winnerRid,source.file,source.medium)).auftrag_id,winner.auftrag_id,'Dedupe verbraucht auch oberhalb abgesenkter Grenze keinen Platz');
  await pool.query("UPDATE reverse_auftraege SET status='fertig' WHERE id=$1",[two.find(r=>r.success).auftrag_id]);
  assert.equal(await pendingCount(),1);
  console.log('T104 Queue-Repro PASS: PG 1/2, konkurrierende Annahmen, Env ignoriert, Dedupe voll, Ersetzung neutral, Absenkung ohne Verdrängung');
 }finally{
  if(oldQueueEnv===undefined)delete process.env.SYNAPSE_REVERSE_QUEUE_MAX;else process.env.SYNAPSE_REVERSE_QUEUE_MAX=oldQueueEnv;
  await pool.query("DELETE FROM reverse_einstellungen WHERE ebene='global' AND name='queue_offene_max'");
 }
 await pool.query("UPDATE reverse_auftraege SET status='fertig' WHERE id=$1",[winner.auftrag_id]);
 assert.equal((await call('abbrechen',{auftrag_id:winner.auftrag_id})).status,'fertig','Terminalzustand bleibt fertig');
 // Ein akzeptierter Fachschreibvorgang darf ohne durable Aktivität nicht committen.
 await pool.query('ALTER TABLE tool_aktivitaet ADD CONSTRAINT fixture_audit_fehler CHECK(false) NOT VALID');
 try {
   const lost=await call('binden',{reverse_id:lockedRid});assert.equal(lost.success,false);
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM reverse_bindungen WHERE eintrag_id=$1 AND geloest_at IS NULL',[lockedRid])).rows[0].n,0,'Binding+Audit gemeinsam zurückgerollt');
 } finally {await pool.query('ALTER TABLE tool_aktivitaet DROP CONSTRAINT fixture_audit_fehler');}
 const connected=createReverseToolService({pool,runtime:{analysieren:async(request,db)=>{
   assert.equal(request.project,project);assert.equal((await db.query('SELECT current_schema() AS n')).rows[0].n,schema);
   return {auftrag_id:randomUUID(),status:'laeuft',container:{zustand:'laeuft',kaltstart_s:0},schicht_angefragt:request.bisSchicht};
 },containerStatus:async()=>({zustand:'laeuft',kaltstart_s:0})}});
 const rt=await connected.ausfuehren({action:'analysieren',agent_id:agent,project,reverse_id:split.aufgeteilt[1],bis_schicht:'S2'});
 assert.equal(rt.status,'laeuft');assert.equal(rt.fehlercode,null);assert.equal(rt.container.zustand,'laeuft','RV8-Zustand wird übernommen');
 assert.equal((await connected.ausfuehren({action:'status',agent_id:other,project,reverse_id:split.aufgeteilt[1]})).container.zustand,'laeuft','Projektbindung bleibt agentübergreifend');
 console.log('RV9 PG boundaries PASS: Split/Rollback/Merge/Fingerprint/E-History/QueueRace/Dedup/Terminal/AuditRollback/Runtime');

 const {MCP_TOOLS,handleToolCall}=await import('../../rest-api/dist/routes/mcp.js');
 const restUnknown=check(await handleToolCall('reverse',{action:'eintrag',project,reverse_id:rid,typo:1},agent));
 assert.deepEqual(restUnknown,unknown,'REST führt denselben Fehlervertrag aus und übernimmt effektive Agent-ID');
 const restMissing=check(await handleToolCall('reverse',{action:'liste'}));
 assert.equal(restMissing.fehlercode,'keine_berechtigung');
 const stdio=await import('../../mcp-server/dist/tools/consolidated/index.js');

 // P10-T78 (User-Entscheidung 444127bc Punkt 1): statt zwei Gesamt-Hashes (c1f8362b/1cada027 gegen 7cd5ddb, mit
 // Sonderregel fuer code_intel.typen) ist je Strecke und Tool eingefroren (Stand 354135ca). Absichtliche Aenderungen
 // brauchen einen Eintrag mit grund + task in fixtures/tool-definitionen-p18-rv9.json (Helfer _helfer/tool-definitionen-golden.mjs).
 const G=await import('./_helfer/tool-definitionen-golden.mjs');
 const stdioDefs=Object.entries(stdio).filter(([name,v])=>name.endsWith('Tool')&&v?.definition).map(([,v])=>v.definition);
 const istDefs={rest:G.hashJeTool(MCP_TOOLS),stdio:G.hashJeTool(stdioDefs)};
 // Selbsttest (Positivkontrolle, nur gegen den eingefrorenen Stand): unbegruendete Aenderung rot, Eintrag ohne
 // grund rot, begruendeter Eintrag gruen.
 const g0=G.ladeToolDefinitionen(),leer={...g0,aenderungen:[]},null64='0'.repeat(64);
 const manipuliert={rest:{...g0.eingefroren.rest,code_intel:null64},stdio:{...g0.eingefroren.stdio}};
 const eintrag={strecke:'rest',tool:'code_intel',alt:g0.eingefroren.rest.code_intel,neu:null64,task:'P10-T78',datum:'2026-10-14'};
 assert(G.pruefeToolDefinitionen(manipuliert,leer).fehler.some(f=>f.startsWith('rest/code_intel: GEAENDERT')),'Selbsttest: unbegruendete Aenderung wird erkannt');
 assert(G.pruefeToolDefinitionen(manipuliert,{...leer,aenderungen:[eintrag]}).fehler.some(f=>/grund fehlt/.test(f)),'Selbsttest: Eintrag ohne grund wird abgelehnt');
 assert.deepEqual(G.pruefeToolDefinitionen(manipuliert,{...leer,aenderungen:[{...eintrag,grund:'Selbsttest: absichtliche Aenderung'}]}).fehler,[],'Selbsttest: begruendete Aenderung wird akzeptiert');
 assert(G.pruefeToolDefinitionen(manipuliert,{...leer,aenderungen:[{...eintrag,alt:null64,grund:'Selbsttest: falsche Kette'}]}).fehler.some(f=>/Kette unterbrochen/.test(f)),'Selbsttest: falscher alt-Hash wird erkannt');
 const golden=G.pruefeToolDefinitionen(istDefs);
 assert.deepEqual(golden.fehler,[],G.toolDefinitionenMeldung(golden));
 assert.deepEqual(MCP_TOOLS.find(t=>t.name==='reverse'),REVERSE_DEFINITION);
 assert.deepEqual(stdio.reverseTool.definition,REVERSE_DEFINITION);
 // P18-T64 (527fed6c, auf main 5b9a3774, bereits in Basis 354135ca) hat 'kein_ausfuehrer' und 'format_nicht_unterstuetzt'
 // ergaenzt (20 -> 22); P18-T26 hat keine Codes hinzugefuegt. Exakte Liste statt nur Laenge, damit auch Tausch/Umbenennung auffaellt.
 assert.deepEqual([...REVERSE_FEHLERCODES],['nicht_gefunden','nicht_gebunden','nicht_unterstuetzt','gepackt','verschluesselt','beschaedigt','zu_gross','bombe_verdacht','pfad_gefahr','zeitlimit','speicherlimit','werkzeug_fehler','container_ruht','container_gesperrt','warteschlange_voll','schicht_nicht_fertig','ziel_belegt','keine_berechtigung','ansicht_nicht_darstellbar','semantik_nicht_verfuegbar','kein_ausfuehrer','format_nicht_unterstuetzt','policy_pin_fehlt','policy_geaendert','policy_grenze','policy_nicht_lesbar']);
 // T104 ergänzt genau vier Policy-Codes; alle 22 bisherigen bleiben in gleicher Reihenfolge.
 assert.equal(REVERSE_FEHLERCODES.length,26);
 console.log('RV9 PASS: Schema-Golden, Bibliothek/Paging, Bestätigung/Reorder, Rechte/Bindung/Race, Statusfelder, Queue/Dedup/Abbruch, Longpoll, Aktivität, unbekannte/ungenutzte Parameter, Archiv');
} catch(error){console.error(error);process.exitCode=1;}
finally {await pipeline.beende();await pool.query('DELETE FROM public.tool_aktivitaet WHERE projekt=$1 AND agent_id IN ($2,$3)',[project,agent,other]);await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await pool.end();await core.closePool();}
process.exit(process.exitCode||0);
