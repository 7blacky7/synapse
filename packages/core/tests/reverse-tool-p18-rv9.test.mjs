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
let sequence=0;
const service=createReverseToolService({pool});
const call=(action,extra={},who=agent)=>service.ausfuehren({action,agent_id:who,project,reverse_id:rid,...extra});
const check=r=>{for(const key of required)assert(Object.hasOwn(r,key),'Pflichtfeld '+key);for(const key of required)assert(Object.hasOwn(r.felder,key),'Hinweisfeld '+key);return r;};
try {
 await pool.query('CREATE SCHEMA '+schema);
 for(const table of ['agent_sessions','projects','tool_aktivitaet'])await pool.query('CREATE TABLE '+schema+'.'+table+' (LIKE public.'+table+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 await pool.query(REVERSE_SCHEMA_SQL);
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
 assert.equal((await call('bestaetigen',{},'koordinator')).success,true,'Bestätigung idempotent');
 await pool.query("INSERT INTO reverse_dateien(id,eintrag_id,medium_id,pfad,format,arch,bits,art,status,metadaten) VALUES(1,$1,1,'cd1/game.exe','pe','x86',32,'binaer','offen','{\"merkmale\":[\"debug_symbole\"]}')",[rid]);
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
 const queue=check(await call('analysieren',{datei:'cd1/game.exe',bis_schicht:'S3',prioritaet:'interaktiv'}));
 assert.equal(queue.status,'wartet');assert.equal(queue.fehlercode,'container_ruht');assert(queue.auftrag_id);
 assert.equal((await call('analysieren',{datei:'cd1/game.exe',bis_schicht:'S3',prioritaet:'hintergrund'})).auftrag_id,queue.auftrag_id,'Dedup');
 assert.equal((await pool.query('SELECT prioritaet FROM reverse_auftraege WHERE id=$1',[queue.auftrag_id])).rows[0].prioritaet,'interaktiv');
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
 assert(children.every(c=>c.fingerabdruck?.length===64&&c.bestaetigt_von==='koordinator'&&c.analyse_policy.bis_schicht==='S3'));
 const merged=await call('bestaetigen',{reverse_id:mergeRid,zusammenfuehren_mit:split.aufgeteilt[0]},'koordinator');
 assert.equal(merged.success,true,JSON.stringify(merged));assert.equal(merged.eintrag.medien.length,2);
 assert.equal((await call('eintrag',{reverse_id:mergeRid})).eintrag.status,'archiviert');
 await pool.query("INSERT INTO reverse_schichten(medium_id,schicht,fingerabdruck,status) VALUES(7,'E','fixture-e','fertig')");
 assert.equal((await call('bestaetigen',{reverse_id:lockedRid,zusammenfuehren_mit:split.aufgeteilt[1]},'koordinator')).fehlercode,'ziel_belegt','E-Historie schützt Gruppierung');
 // Vier konkurrierende Analysen desselben Mediums deduplizieren; globale Queuegrenze gilt über Einträge.
 for(const child of split.aufgeteilt)assert.equal((await call('binden',{reverse_id:child})).success,true);
 process.env.SYNAPSE_REVERSE_QUEUE_MAX='1';
 const raced=await Promise.all(split.aufgeteilt.map(child=>call('analysieren',{reverse_id:child,bis_schicht:'S3'})));
 assert.equal(raced.filter(r=>r.success).length,1);assert.equal(raced.filter(r=>r.fehlercode==='warteschlange_voll').length,1);
 delete process.env.SYNAPSE_REVERSE_QUEUE_MAX;
 const winner=raced.find(r=>r.success),winnerRid=winner.reverse_id;
 const dedups=await Promise.all(Array.from({length:4},()=>call('analysieren',{reverse_id:winnerRid,bis_schicht:'S3'})));
 assert(dedups.every(r=>r.auftrag_id===winner.auftrag_id));
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
 assert.deepEqual([...REVERSE_FEHLERCODES],['nicht_gefunden','nicht_gebunden','nicht_unterstuetzt','gepackt','verschluesselt','beschaedigt','zu_gross','bombe_verdacht','pfad_gefahr','zeitlimit','speicherlimit','werkzeug_fehler','container_ruht','container_gesperrt','warteschlange_voll','schicht_nicht_fertig','ziel_belegt','keine_berechtigung','ansicht_nicht_darstellbar','semantik_nicht_verfuegbar','kein_ausfuehrer','format_nicht_unterstuetzt']);
 assert.equal(REVERSE_FEHLERCODES.length,22);
 console.log('RV9 PASS: Schema-Golden, Bibliothek/Paging, Bestätigung/Reorder, Rechte/Bindung/Race, Statusfelder, Queue/Dedup/Abbruch, Longpoll, Aktivität, unbekannte/ungenutzte Parameter, Archiv');
} catch(error){console.error(error);process.exitCode=1;}
finally {await pool.query('DELETE FROM public.tool_aktivitaet WHERE projekt=$1 AND agent_id IN ($2,$3)',[project,agent,other]);await pool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await pool.end();await core.closePool();}
process.exit(process.exitCode||0);
