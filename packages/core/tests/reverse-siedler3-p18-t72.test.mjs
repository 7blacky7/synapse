/** P18-T72: synthetic E containers -> real importer -> dateien/inspect/ansicht source.
 * Only isolated synapse_test:5433 schema and disposable fixture directory.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';

const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',SYNAPSE_SHELL_JOB:'1',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_INTERN_TOOL:'1'});
const require=createRequire(new URL('../package.json',import.meta.url)),{Pool}=require('pg');
const raw=new Pool({connectionString:url.toString()}),schema='p18_t72_'+process.pid;
await raw.query('CREATE SCHEMA '+schema);
url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.toString();
const root=await mkdtemp(join(tmpdir(),'synapse-t72-'));
Object.assign(process.env,{SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:root});
const core=await import('../dist/index.js');
const {WORK_JOBS_SCHEMA_SQL}=await import('../dist/db/work-jobs-schema.js');
const {REVERSE_SCHEMA_SQL}=await import('../dist/db/reverse-schema.js');
const {getPool,closePool}=await import('../dist/db/client.js');
const {leseReverseSiedler3Schalter:schalter}=await import('../dist/services/reverse-siedler3-schalter.js');
const {leseProfilProduktSchalter,setzeProfilProduktSchalter}=await import('../dist/services/agent-profil-schalter.js');
const {setzeSchalter}=await import('../dist/services/intern-schalter.js');
const db=getPool(),rid='rev-t72-fixture',project='p18_t72_fixture',agent='p18_t72-agent';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
let checks=0;
const eq=(a,b,msg)=>{assert.deepEqual(a,b,msg);checks++;};
try{
 for(const table of ['agent_sessions','projects','tool_aktivitaet'])await db.query('CREATE TABLE '+table+' (LIKE public.'+table+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 await db.query(WORK_JOBS_SCHEMA_SQL);await db.query(REVERSE_SCHEMA_SQL);await db.query(core.REVERSE_PIPELINE_SCHEMA_SQL);await db.query((await import('../dist/db/reverse-analyse-policy-schema.js')).REVERSE_ANALYSE_POLICY_SCHEMA_SQL);await db.query('ALTER TABLE reverse_auftraege ADD COLUMN IF NOT EXISTS uebernahme JSONB');
 // T84: inspect uses the analysis-only reference view, which requires migration 138.
 await db.query((await import('../dist/db/hex-formate-schema.js')).HEX_FORMATE_SCHEMA_SQL);
 await db.query((await import('../dist/db/reverse-erkenntnisse-schema.js')).REVERSE_ERKENNTNISSE_SCHEMA_SQL);
 for(const [t,c] of [['reverse_eintraege','creator_identity_id'],['reverse_eintraege','confirmer_identity_id'],['reverse_bindungen','binder_identity_id'],['reverse_auftraege','trigger_identity_id']])await db.query('ALTER TABLE '+t+' ADD COLUMN IF NOT EXISTS '+c+' TEXT');
 await db.query('CREATE TABLE agent_profil_schalter(ebene text,project text,funktion text,aktiv boolean,grund text,gesetzt_von text,setter_identity_id uuid,gesetzt_am timestamptz DEFAULT now())');
 await db.query("CREATE UNIQUE INDEX ON agent_profil_schalter(ebene,(COALESCE(project,'')),funktion)");
 await db.query('CREATE TABLE intern_schalter(name text PRIMARY KEY,modus text,aktiv boolean,bis timestamptz,grund text,gesetzt_von text,gesetzt_am timestamptz DEFAULT now(),setter_identity_id uuid)');
 await db.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,'fixture','/synthetic/p18_t72',true)",[project]);
 await db.query("INSERT INTO agent_sessions(id,project,status) VALUES($1,$2,'active')",[agent,project]);
 await db.query("INSERT INTO reverse_eintraege(id,titel,status) VALUES($1,'Siedler synthetic fixture','bestaetigt')",[rid]);
 await db.query("INSERT INTO reverse_medien(id,eintrag_id,position,bezeichnung,art) VALUES(1,$1,0,'CD1','ordner')",[rid]);
 // P18-T97 Plan A: Zulassungs-Cut, Neustart-/Clientreuse und atomare Herkunft.
 const halt=await import('../dist/services/reverse-pipeline-halt.js');
 eq((await halt.leseReversePipelineHalt(db)).aktiv,false,'kein PG-Wert = Standard AUS');
 await assert.rejects(()=>setzeProfilProduktSchalter({ebene:'global',funktion:'reverse_pipeline_halt',aktiv:true,grund:'fremder Agent'},{}),/recht_fehlt/);
 await assert.rejects(()=>setzeProfilProduktSchalter({ebene:'projekt',project,funktion:'reverse_pipeline_halt',aktiv:true,grund:'nur global'}, {system:'user'}),/nur_global/);
 const txH=async f=>{const c=await db.connect();try{await c.query('BEGIN');const r=await f(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
 const admission=await db.connect();await admission.query('BEGIN');await halt.fordereReverseAdmission(admission);
 let cutDone=false;
 const cut=setzeProfilProduktSchalter({ebene:'global',funktion:'reverse_pipeline_halt',aktiv:true,grund:'T97 Admission-Cut'}, {system:'user'}).then(x=>{cutDone=true;return x;});
 // Die exklusive Setter-TX wartet deterministisch auf die geteilte Zulassung, nicht auf einen Wandzeitvergleich.
 const deadline=Date.now()+5000;
 while(!(await db.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objid=hashtext('reverse-pipeline-halt')::oid")).rows.length){
  assert(Date.now()<deadline,'Setter wartet auf Admission-Lock');await new Promise(r=>setTimeout(r,5));
 }
 eq(cutDone,false,'Cut kann vor Abschluss alter Admission nicht committen');
 // Dritter Akteur: neue Fachzulassung wartet hinter dem bereits wartenden Cut.
 const nachCut=txH(c=>halt.fordereReverseAdmission(c)).then(()=>({zugelassen:true}),e=>({code:e.code}));
 await admission.query('COMMIT');await cut;
 eq(await nachCut,{code:'reverse_pipeline_gehalten'},'Drei Akteure: alte Admission vor Cut, neue Admission danach abgewiesen');
 await admission.query('BEGIN');await assert.rejects(()=>halt.fordereReverseAdmission(admission),/reverse_pipeline_gehalten/);await admission.query('ROLLBACK');admission.release();
 eq((await halt.leseReversePipelineHalt(db)).aktiv,true,'neuer PG-Leseweg sieht persistenten Halt');
 // Frühestes Gate: Eintrag absichtlich gesperrt. Ablehnung muss vor dem Entry-Lock eintreten.
 const blocker=await db.connect();await blocker.query('BEGIN');await blocker.query('SELECT id FROM reverse_eintraege WHERE id=$1 FOR UPDATE',[rid]);
 let called=0;const heldService=core.createReverseToolService({pool:db,runtime:{analysieren:async()=>{called++;return {};}}});
 let timer;const early=await Promise.race([heldService.ausfuehren({action:'analysieren',agent_id:agent,project,reverse_id:rid,bis_schicht:'E'}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Gate hinter Entry-Lock')),1000);})]).finally(()=>clearTimeout(timer));
 await blocker.query('ROLLBACK');blocker.release();
 eq(early.fehler,'reverse_pipeline_gehalten','Halt vor Policy/Eintrag/Runtime '+JSON.stringify(early));eq(called,0);
 await setzeProfilProduktSchalter({ebene:'global',funktion:'reverse_pipeline_halt',aktiv:false,grund:'T97 nächste Probe'}, {system:'user'});
 // Eigene Work-/Fachbindung entsteht in genau einer zugelassenen Transaktion.
 const bound=await txH(async c=>{
  await halt.fordereReverseAdmission(c);
  const j=await core.createWorkJobService({pool:db}).enqueue({kind:'reverse-E',capability:'reverse_bibliothek',project:'reverse-bibliothek',scope:'reverse',
   inputRef:{scope:'reverse',id:rid,revision:'1',sha256:'a'.repeat(64)},resourceNeed:{cpu:1,ram:64,vram:0,gpu:false},idempotencyKey:'t97:'+randomUUID()},c);
  const fid=randomUUID();
  await c.query("INSERT INTO reverse_auftraege(id,eintrag_id,medium_id,schicht,status,p20_auftrag_id,fingerabdruck,werkzeug,werkzeug_version,profil_version,policy_pin) VALUES($1,$2,1,'E','wartet',$3,$4,'reverse-E','probe','probe',$5::jsonb)",[fid,rid,j.id,'b'.repeat(64),JSON.stringify({probe:true})]);
  await halt.belegeReverseAdmission(c,j.id,fid);return j;
 });
 eq(await halt.pruefeReverseFachbindung(db,bound),null,'belegte Bindung ist gültig');
 await setzeProfilProduktSchalter({ebene:'global',funktion:'reverse_pipeline_halt',aktiv:true,grund:'T97 Drain vorhandener Jobs'}, {system:'user'});
 eq(await halt.pruefeReverseFachbindung(db,bound),null,'vor Cut belegter Pending bleibt claimbar');
 eq(await halt.pruefeReverseFachbindung(db,{...bound,inputRef:{...bound.inputRef,sha256:'c'.repeat(64)}}),'reverse_fachbindung_ungueltig','fremder Hash scheitert');
 // Generische Route ist unverändert: nacktes Pending bleibt möglich, darf aber nie laufen.
 const naked=await core.createWorkJobService({pool:db}).enqueue({kind:'reverse-E',capability:'reverse_bibliothek',project:'reverse-bibliothek',scope:'reverse',
  inputRef:bound.inputRef,resourceNeed:{cpu:1,ram:64,vram:0,gpu:false},idempotencyKey:'t97:naked:'+randomUUID()});
 eq(await halt.pruefeReverseFachbindung(db,naked),'reverse_fachbindung_fehlt');
 eq((await halt.reverseAdmissionDiagnose(db,rid,10,0)).drain_fertig,false,'nacktes Pending hält Drain-Tor rot');
 // Isolierter Schema-Cleanup: kein Produktionsjob und kein Container.
 await db.query("UPDATE work_jobs SET state='cancelled' WHERE id=ANY($1::uuid[])",[[bound.id,naked.id]]);
 await db.query('DELETE FROM reverse_auftraege WHERE p20_auftrag_id=$1',[bound.id]);
 await setzeProfilProduktSchalter({ebene:'global',funktion:'reverse_pipeline_halt',aktiv:false,grund:'T97 Probe abgeschlossen'}, {system:'user'});
 await db.query("DELETE FROM agent_profil_schalter WHERE funktion='reverse_pipeline_halt'");
 // P18-T97 A-R2: reine lokale S0/S1-Arbeit samt noch lebenden Leases hält das globale Drain-Tor rot.
 const localFile=(await db.query("INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,groesse,sha256,art) VALUES($1,1,'drain.dat',0,$2,'binaer') RETURNING id::text",[rid,'d'.repeat(64)])).rows[0].id;
 const local=(await db.query("INSERT INTO reverse_auftraege(eintrag_id,datei_id,schicht,ausfuehrung,status,lease_token,lease_bis) VALUES($1,$2,'S0','api','wartet',NULL,NULL),($1,$2,'S1','api','laeuft',gen_random_uuid(),clock_timestamp()+interval '1 minute') RETURNING id",[rid,localFile])).rows.map(x=>x.id);
 let localDrain=await halt.reverseAdmissionDiagnose(db,rid,10,0);
 eq(localDrain.drain.pending,'0');eq(localDrain.drain.running,'0');
 eq(localDrain.drain_fertig,false,'S0/S1-only ist ROT');eq(localDrain.api.wartend,'1');eq(localDrain.api.laufend,'1');
 await db.query("UPDATE reverse_auftraege SET status='fertig' WHERE id=ANY($1::uuid[])",[local]);
 eq((await halt.reverseAdmissionDiagnose(db,rid,10,0)).drain_fertig,false,'lebende lokale Lease bleibt ROT');
 await db.query("UPDATE reverse_auftraege SET lease_token=NULL,lease_bis=NULL WHERE id=ANY($1::uuid[])",[local]);
 eq((await halt.reverseAdmissionDiagnose(db,rid,10,0)).drain_fertig,true,'erst vollständige logische Ruhe ist GRÜN');

 // G18: tatsächliche Lesefunktion + derselbe kanonische Beleg, keine echte Registrierung/Ausführung.
 const {reverseLeserNachzugFreigegeben}=await import('../dist/services/reverse-leser-nachzug.js');
 const {reverseLeserHash,reverseLeserKanonisch}=await import('../dist/services/reverse-leser-vertrag.js');
 const leserJob=randomUUID(),leserFach=randomUUID();
 const originalRow={id:leserFach,work_job_id:leserJob,kind:'reverse-leser',capability:'reverse_leser',
  project:'reverse-bibliothek',scope:'reverse',input_ref:{scope:'reverse',id:rid,revision:localFile,sha256:'a'.repeat(64)},
  profile_id:null,request_hash:'b'.repeat(64),eintrag_id:rid,datei_id:localFile,leser_id:randomUUID(),
  quell_sha256:'a'.repeat(64),einstellungen_revision:'c'.repeat(64),runtime_sha256:'d'.repeat(64),
  runtime_image_digest:'sha256:'+'e'.repeat(64),diagnose:{nachzug:true,policy_revision:reverseLeserHash(reverseLeserKanonisch({}))}};
 let readerRows=[structuredClone(originalRow)];
 const readerDb={query:async(q,v)=>{
  const text=String(q);
  if(text.includes('FROM reverse_leser_laeufe')||text.includes('FROM reverse_leser_laeufe l JOIN'))return {rows:readerRows,rowCount:readerRows.length};
  if(text.includes('UPDATE reverse_leser_laeufe SET diagnose=')){readerRows[0].diagnose.admission=JSON.parse(v[1]);return {rows:[],rowCount:1};}
  if(text.includes('SELECT 1 FROM reverse_eintraege e WHERE'))return {rows:[{ok:1}],rowCount:1};
  return db.query(q,v);
 }};
 for(const funktion of ['reverse_leser','reverse_leser_nachzug'])await db.query("INSERT INTO agent_profil_schalter(ebene,funktion,aktiv,grund,gesetzt_von) VALUES('global',$1,true,'synthetische G18-Probe','fixture')",[funktion]);
 await halt.belegeReverseAdmission(readerDb,leserJob,leserFach,true);
 const validReader=structuredClone(readerRows[0]);
 eq(await reverseLeserNachzugFreigegeben(readerDb,leserJob),true,'G18 gültiger regulärer Nachzug lesbar');
 const mutations=[
  ['Scope',r=>r.scope='projekt'],['Projekt',r=>r.project='fremd'],['Eintrag',r=>r.eintrag_id='rev-fremd'],
  ['Datei',r=>r.datei_id='99999'],['Hash',r=>r.quell_sha256='f'.repeat(64)],
  ['Leserrevision',r=>r.leser_id=randomUUID()],['Runtime',r=>r.runtime_sha256='f'.repeat(64)],
  ['Image',r=>r.runtime_image_digest='sha256:'+'f'.repeat(64)],['Einstellungen',r=>r.einstellungen_revision='f'.repeat(64)],
  ['Policy',r=>r.diagnose.policy_revision='f'.repeat(64)],['Request',r=>r.request_hash='f'.repeat(64)],
  ['Input',r=>r.input_ref.sha256='f'.repeat(64)],['Beleg fehlt',r=>delete r.diagnose.admission],
  ['Beleg manipuliert',r=>r.diagnose.admission.sha256='f'.repeat(64)],['kein Nachzug',r=>delete r.diagnose.nachzug]
 ];
 for(const [name,mutate]of mutations){readerRows=[structuredClone(validReader)];mutate(readerRows[0]);eq(await reverseLeserNachzugFreigegeben(readerDb,leserJob),false,'G18 '+name+' fail closed');}
 readerRows=[];eq(await reverseLeserNachzugFreigegeben(readerDb,leserJob),false,'G18 kein Lauf');
 readerRows=[structuredClone(validReader),structuredClone(validReader)];eq(await reverseLeserNachzugFreigegeben(readerDb,leserJob),false,'G18 mehrdeutiger Lauf');
 readerRows=[{diagnose:{testmodus:true}}];eq(await reverseLeserNachzugFreigegeben(readerDb,leserJob),true,'G18 expliziter Testmodus bleibt separat');
 await db.query("DELETE FROM agent_profil_schalter WHERE funktion=ANY($1::text[])",[['reverse_leser','reverse_leser_nachzug']]);
 await db.query('DELETE FROM reverse_auftraege WHERE id=ANY($1::uuid[])',[local]);await db.query('DELETE FROM reverse_dateien WHERE id=$1',[localFile]);
 const job=randomUUID(),work=join(root,'_arbeit',job);
 const exported=JSON.parse(execFileSync('uv',['run','--no-project','python','-B',new URL('../../../docker/synapse-reverse/test_siedler3.py',import.meta.url).pathname,'--export',work],{encoding:'utf8'}));
 eq(exported.manifest.length,15,'three originals + nine GFX + two WAV + MAP report');
 eq(exported.status.fehlercode,'verschluesselt','no MAP decryption');
 const cfg=core.ladeAssetKonfiguration({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:root});
 const imported=await core.uebernehmeEErgebnis(db,{jobId:job,reverseId:rid,mediumId:'1',arbeitsWurzel:work,manifest:exported.manifest},{konfiguration:cfg});
 eq(imported,{dateien:15,verworfen:0});
 const service=core.createReverseToolService({pool:db});
 const call=(action,extra={})=>service.ausfuehren({action,project,agent_id:agent,reverse_id:rid,...extra});
 eq((await call('dateien')).fehlercode,'nicht_gebunden');
 eq((await call('binden')).success,true);
 const all=[];let offset=0;
 do{const r=await call('dateien',{offset,limit:4});eq(r.success,true,JSON.stringify(r));all.push(...r.dateien);offset=r.naechster_offset;}while(offset!==null);
 eq(all.length,15);eq(new Set(all.map(d=>d.pfad)).size,15);
 const image=all.find(d=>d.pfad.endsWith('.png')&&d.siedler3.typ==='sprite');
 const sound=all.find(d=>d.pfad.endsWith('.wav'));
 eq(image.art,'asset');eq(sound.art,'asset');
 eq(image.quelle.archiv,'CD1/gfx.dat');eq(image.siedler3.versatz_x,-2);
 for(const [entry,mime,type] of [[image,'image/png','image'],[sound,'audio/wav','audio']]){
  const inspected=await call('inspect',{datei:entry.pfad});eq(inspected.success,true,JSON.stringify(inspected));
  eq(inspected.inspektion.datei.asset_type,type);
  eq(inspected.inspektion.datei.metadata.mime_type,mime);
  eq(inspected.inspektion.datei.metadata.siedler3.quellbereich_sha256,entry.siedler3.quellbereich_sha256);
  const source=await core.holeReverseAnsichtDatei(db,rid,entry.pfad);
  eq(source.mime,mime);eq(source.sha256,entry.sha256);
  const bytes=await readFile(join(root,rid,'entpackt','m1',entry.pfad.slice(4)));
  eq(sha(bytes),entry.sha256);
 }
 const report=all.find(d=>d.pfad.startsWith('CD1/karte.map~inhalt/'));
 eq(report.art,'text');eq(all.find(d=>d.pfad==='CD1/karte.map').verschachtelt.grund,'verschluesselt');
 eq((await call('dateien',{path:'../x'})).fehlercode,'pfad_gefahr');
 const tree=await call('assets_tree',{path:'CD1',recursive:true,limit:50});eq(tree.success,true);
 const {MCP_TOOLS,handleToolCall}=await import('../../rest-api/dist/routes/mcp.js');
 const {reverseTool,rufeReverseApi}=await import('../../mcp-server/dist/tools/consolidated/reverse.js');
 eq(MCP_TOOLS.find(t=>t.name==='reverse'),core.REVERSE_DEFINITION);
 eq(reverseTool.definition,core.REVERSE_DEFINITION);
 const request={action:'dateien',project,agent_id:agent,reverse_id:rid,limit:4};
 const rest=await handleToolCall('reverse',request,agent);eq(rest,await call('dateien',{limit:4}));
 const rpc=core.baueToolErgebnis(rest,{tool:'reverse',strukturiert:true});
 eq(await rufeReverseApi(request,{url:'http://fixture.invalid/mcp',token:'fixture-only',fetchImpl:async()=>({ok:true,status:200,json:async()=>({jsonrpc:'2.0',id:1,result:rpc})})}),rpc);


 // R5-Nachfix: lokale S1-Profilwechsel behalten exakt die Basissemantik, auch nach fertiger Generation.
 const profileProben=[['aktuell',core.ReversePipelineDienst,async f=>f()]];
 // Optionaler, vom Koordinator bereitgestellter Basisbaum; normaler Testlauf braucht keinen /tmp-Worktree.
 if(process.env.SYNAPSE_REVERSE_TEST_BASIS){
  const basisRoot=process.env.SYNAPSE_REVERSE_TEST_BASIS;
  const basisPipeline=await import(basisRoot+'/packages/core/dist/services/reverse-pipeline.js');
  const basisClient=await import(basisRoot+'/packages/core/dist/db/client.js');
  profileProben.push(['basis',basisPipeline.ReversePipelineDienst,f=>basisClient.mitLesePool(db,f)]);
 }
 const {bereiteReversePolicyPin}=await import('../dist/services/reverse-analyse-policy.js');
 for(const [label,Dienst,context]of profileProben){
  await db.query("DELETE FROM agent_profil_schalter WHERE funktion='reverse_blockuebernahme'");
  const dienst=new Dienst({pool:db,konfiguration:cfg,ausfuehrbareKinds:[]});
  try{await context(async()=>{
   await dienst.einstellungen();
   const codeHash=sha('int profil(void) { return 1; }'),file=(await db.query("INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,groesse,sha256,art,format) VALUES($1,1,$2,29,$3,'text','c') RETURNING id::text",[rid,'profilwechsel-'+label+'.c',codeHash])).rows[0].id;
   const oldId=randomUUID(),fp=core.reverseAnalyseFingerabdruck(codeHash,'S1','asset-inspektoren',dienst.version,dienst.profilFuer('S1'));
   const pin=await bereiteReversePolicyPin(db,{id:oldId,reverseId:rid,dateiId:file,mediumId:null,angefragt:'S1'});
   await db.query("INSERT INTO reverse_auftraege(id,eintrag_id,datei_id,schicht,status,ausfuehrung,fingerabdruck,werkzeug,werkzeug_version,profil_version,policy_pin) VALUES($1,$2,$3,'S1','fertig','api',$4,'asset-inspektoren',$5,$6,$7)",[oldId,rid,file,fp,dienst.version,dienst.profilFuer('S1'),pin]);
   for(const stage of ['S0','S1'])await db.query("INSERT INTO reverse_schichten(datei_id,schicht,fingerabdruck,status,werkzeug,werkzeug_version,profil_version,auftrag_id) VALUES($1,$2,$3,'fertig','asset-inspektoren',$4,$5,$6)",[file,stage,core.reverseAnalyseFingerabdruck(codeHash,stage,'asset-inspektoren',dienst.version,dienst.profilFuer(stage)),dienst.version,dienst.profilFuer(stage),stage==='S1'?oldId:null]);
   const vorher=(await db.query('SELECT to_jsonb(r) AS row FROM reverse_auftraege r WHERE id=$1',[oldId])).rows[0].row;
   await db.query("INSERT INTO agent_profil_schalter(ebene,funktion,aktiv,grund,gesetzt_von) VALUES('global','reverse_blockuebernahme',true,'synthetischer Profilwechsel','fixture')");
   await dienst.einstellungen();
   assert.notEqual(dienst.profilFuer('S1'),vorher.profil_version,label+' Profilwechsel wirksam');
   const next=await txH(c=>dienst.queue(c,{reverseId:rid,dateiId:file,mediumId:null,project,agentId:agent,bisSchicht:'S1',prioritaet:'hintergrund'}));
   assert.notEqual(next.auftrag_id,oldId,label+' eigener neuer S1-Lauf');eq(next.status,'wartet',label+' wartender neuer S1-Lauf');
   eq((await db.query("SELECT count(*)::int n FROM reverse_auftraege WHERE datei_id=$1 AND schicht='S1' AND status='wartet'",[file])).rows[0].n,1,label+' genau ein wartender S1-Lauf');
   eq((await db.query('SELECT to_jsonb(r) AS row FROM reverse_auftraege r WHERE id=$1',[oldId])).rows[0].row,vorher,label+' alte fertige Zeile bytegleich, keine Umsignierung');
   const claim=await dienst.claim();eq(claim.id,next.auftrag_id,label+' neuer Lauf tatsächlich claimbar');
   await db.query("UPDATE reverse_auftraege SET status='abgebrochen',lease_token=NULL,lease_bis=NULL WHERE id=$1",[claim.id]);
  });}finally{await dienst.beende();}
 }
 await db.query("DELETE FROM agent_profil_schalter WHERE funktion='reverse_blockuebernahme'");

 eq((await schalter()).aktiv,false,'default OFF');
 await db.query("INSERT INTO agent_profil_schalter(ebene,funktion,aktiv,grund,gesetzt_von) VALUES('global','alle',true,'fixture','fixture')");
 eq((await schalter()).aktiv,false,'alle excludes new feature');
 await setzeProfilProduktSchalter({ebene:'global',funktion:'reverse_siedler3',aktiv:true,grund:'Fixture Freigabe'},{system:'user'});
 eq((await schalter()).quelle,'produkt-schalter');
 eq((await leseProfilProduktSchalter('reverse_siedler3',project)).project,null,'global library');
 await assert.rejects(setzeProfilProduktSchalter({ebene:'projekt',project,funktion:'reverse_siedler3',aktiv:true,grund:'Fixture Freigabe'},{system:'user'}),e=>e.code==='nur_global');
 await assert.rejects(setzeProfilProduktSchalter({ebene:'global',funktion:'reverse_siedler3',aktiv:false,grund:'Fixture kein Recht'},{}),e=>e.code==='recht_fehlt');
 const off=await setzeSchalter('reverse_siedler3',{aktiv:false,modus:'freigegeben',dauer_min:1,grund:'Fixture temporary OFF'});
 assert(off.bis);eq(off.modus,'freigegeben');eq((await schalter()).aktiv,false);eq((await schalter()).quelle,'intern');
 const productionEnv={...process.env,SYNAPSE_INTERN_TOOL:'0'};
 const restarted=execFileSync(process.execPath,['--input-type=module','-e',
  "import {leseReverseSiedler3Schalter as read} from './packages/core/dist/services/reverse-siedler3-schalter.js';import {closePool} from './packages/core/dist/db/client.js';console.log(JSON.stringify(await read()));await closePool();"
 ],{env:productionEnv,encoding:'utf8'});
 const production=JSON.parse(restarted.trim().split('\n').pop());
 eq(production.aktiv,true,'restart persistence / production ignores temporary OFF');eq(production.quelle,'produkt-schalter');
 await db.query("UPDATE intern_schalter SET bis=now()-interval '1 second'");
 eq((await schalter()).aktiv,true,'expiry returns product');
 await setzeProfilProduktSchalter({ebene:'global',funktion:'reverse_siedler3',aktiv:false,grund:'Fixture default OFF'},{system:'user'});
 await setzeSchalter('reverse_siedler3',{aktiv:true,modus:'freigegeben',dauer_min:1,grund:'Fixture temporary ON'});
 eq((await schalter()).aktiv,true);
 await db.query('ALTER TABLE intern_schalter RENAME COLUMN bis TO missing_bis');
 let s=await schalter();eq(s.aktiv,false);eq(s.letzter_fehler,'reverse_siedler3_override_nicht_lesbar');
 await db.query('ALTER TABLE agent_profil_schalter RENAME COLUMN aktiv TO missing_aktiv');
 eq((await schalter()).aktiv,false,'unavailable product -> standard OFF');
 console.log('T72 BEISPIEL',JSON.stringify({imported,image,sound,map_report:report.pfad,checks}));
 console.log('P18-T72 PASS: GFX/SND/MAP -> E -> dateien/inspect/Ansichtsquelle, REST=stdio, Herkunft/Hash/Paging, Rechte/global/Persistenz, intern ON/OFF/Ablauf/Ausfall.');
}finally{
 await closePool();await raw.query('DROP SCHEMA '+schema+' CASCADE');await raw.end();await rm(root,{recursive:true,force:true});
}
