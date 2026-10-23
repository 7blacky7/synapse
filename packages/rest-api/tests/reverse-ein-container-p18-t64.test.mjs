/** P18-T64: EIN globaler Reverse-Container, Diagnose und Entstörer. synapse_test, eigenes Schema, mkdtemp, Fake-Container statt Docker. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import fs from 'node:fs/promises';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
assert.equal(url.port,'5433','nur Test-Port');assert.equal(url.pathname,'/synapse_test','nur Testdatenbank');
delete process.env.SYNAPSE_DATABASE_URL;delete process.env.SYNAPSE_COMPUTE_POLICY_ENABLED;delete process.env.SYNAPSE_COMPUTE_ADMISSION;
process.env.SYNAPSE_SKIP_EMBEDDINGS='1';process.env.SYNAPSE_REVERSE_ENTSTOERER_GNADE_S='0';
const require=createRequire(new URL('../../core/package.json',import.meta.url));
const {Pool}=require('pg');
const {WORK_JOBS_SCHEMA_SQL}=await import('../../core/dist/db/work-jobs-schema.js');
const {TOOL_CONTAINER_SCHEMA_SQL}=await import('../../core/dist/db/tool-container-schema.js');
const {TOOL_AKTIVITAET_SCHEMA_SQL}=await import('../../core/dist/db/tool-aktivitaet-schema.js');
const {REVERSE_SCHEMA_SQL}=await import('../../core/dist/db/reverse-schema.js');
const {REVERSE_PIPELINE_SCHEMA_SQL}=await import('../../core/dist/db/reverse-pipeline-schema.js');
const {ASSET_UPLOAD_SCHEMA_SQL}=await import('../../core/dist/db/asset-upload-schema.js');
const {ladeAssetKonfiguration}=await import('../../core/dist/config/asset-konfig.js');
const core=await import('../../core/dist/index.js');
const {mitLesePool}=await import('../../core/dist/db/client.js');
const {ToolLifecycle}=await import('../dist/services/tool-lifecycle.js');
const {buildToolContainerOptions}=await import('../dist/services/tool-container-docker.js');
let ex;
const sha=b=>createHash('sha256').update(b).digest('hex');

test('P18-T64 ein Reverse-Container, Diagnose, Entstörer',async()=>{
 const root=await mkdtemp(join(tmpdir(),'p18-t64-'));const reverseRoot=join(root,'rev');await mkdir(reverseRoot);
 // Gleiche eng begrenzte UID-Attrappe wie F2F3: nur eigene temporäre Daten, kein Docker.
 const originalChown=fs.chown;
 if(process.env.P18_T64_REAL_CHOWN!=='1')fs.chown=async(p,uid,gid)=>{assert(String(p).startsWith(root+'/'));assert.equal(uid,0);assert.equal(gid,65532);};
 syncBuiltinESMExports();ex=await import('../dist/services/reverse-executor.js');
 const schema='p18_t64_'+randomUUID().replaceAll('-','');
 const pool=new Pool({connectionString:process.env.DATABASE_URL,max:6});
 const connect=async()=>{const c=await pool.connect();await c.query('SET search_path TO "'+schema+'",public');return c;};
 const db={connect,query:async(...a)=>{const c=await connect();try{return await c.query(...a);}finally{c.release();}}};
 let lc,unhook,abmelden;
 try{await mitLesePool(db,async()=>{
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,'synapse_test');
  await pool.query('CREATE SCHEMA "'+schema+'"');
  await db.query('CREATE TABLE asset_upload_sitzungen (LIKE public.asset_upload_sitzungen INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)');
  await db.query('CREATE TABLE asset_files (LIKE public.asset_files INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)');
  await db.query('CREATE TABLE projects(name text,enabled boolean)');
  await db.query("CREATE TABLE embedding_knoten(node_id text PRIMARY KEY,boot_id text NOT NULL,service_token_hash text NOT NULL,status text NOT NULL DEFAULT 'ready',gesperrt_vom_user boolean NOT NULL DEFAULT false,letzter_kontakt timestamptz NOT NULL DEFAULT now(),node_kind text DEFAULT 'cpu')");
  for(const sql of [WORK_JOBS_SCHEMA_SQL,ASSET_UPLOAD_SCHEMA_SQL,REVERSE_SCHEMA_SQL,REVERSE_PIPELINE_SCHEMA_SQL,TOOL_AKTIVITAET_SCHEMA_SQL,TOOL_CONTAINER_SCHEMA_SQL])await db.query(sql);

  await db.query('ALTER TABLE tool_activation ADD COLUMN IF NOT EXISTS updater_identity_id TEXT');
  await db.query((await import('../../core/dist/db/reverse-analyse-policy-schema.js')).REVERSE_ANALYSE_POLICY_SCHEMA_SQL);
  await db.query('ALTER TABLE reverse_auftraege ADD COLUMN IF NOT EXISTS uebernahme JSONB, ADD COLUMN IF NOT EXISTS trigger_identity_id TEXT');
  await db.query('CREATE TABLE agent_profil_schalter (LIKE public.agent_profil_schalter INCLUDING DEFAULTS INCLUDING INDEXES)');
  await db.query('CREATE TABLE reverse_einstellungen(ebene text,project text,eintrag_id text,name text,wert numeric,wert_text text)');
  await db.query("INSERT INTO reverse_einstellungen(ebene,name,wert) VALUES('global','entstoerer_gnade_s',0),('global','entstoerer_ohne_ausfuehrer_s',0)");
  const konfig=ex.ladeReverseExecutorKonfig({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_IMAGE:'synapse-reverse:p18-t64@sha256:'+'b'.repeat(64),
   SYNAPSE_REVERSE_RESOURCE_NEED:'{"cpu":1,"ram":512,"vram":0,"gpu":false}',SYNAPSE_REVERSE_EXECUTOR_LEASE_SECONDS:'30'},reverseRoot);
  konfig.renewMs=3600000;
  const d=ex.reverseToolDescriptor(konfig);
  assert.equal(d.instance_scope,'project','globaler Container statt je Auftrag');assert.equal(d.lifecycle.idle_ms,300000,'schläft nach Leerlauf (Standard 5 min)');
  const cfg=ladeAssetKonfiguration({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:reverseRoot});
  const wer={nodeId:'srv-t64',bootGeneration:randomUUID(),authHash:'hash-srv-t64'};
  await db.query('INSERT INTO embedding_knoten(node_id,boot_id,service_token_hash) VALUES($1,$2,$3)',[wer.nodeId,wer.bootGeneration,wer.authHash]);

  // Fake-Container: echte Mount-/Optionsauflösung, Runner simuliert, stop wirklich beobachtbar.
  const resolve=ex.reverseMountResolver(konfig),arbeitVon=new Map(),gestoppt=new Set(),starts=[],kommandos=[];let absturzFuer=null,physischesEndeBestaetigt=true,rohfehlerFuer=null;
  const unbekannterRohgrund='unknown_fixture_code: Sonderzeichen ä / '+ 'ungekuerzt'.repeat(12),rohesFormatdetail='Detail ä / unverändert';
  const fake={
   async start(d,ctx){const mounts=await resolve(d,ctx);const o=buildToolContainerOptions(d,ctx,mounts);starts.push(o);
    const id='fake-'+ctx.generation;arbeitVon.set(id,mounts.find(m=>m.role==='arbeit').source);return {id,coldstart_ms:3};},
   async observe(id){return {container_id:id,running:!gestoppt.has(id)||!physischesEndeBestaetigt,start_observed:true,cpu_percent:0,gpu_percent:null,measured_at:(await db.query('SELECT clock_timestamp() AS t')).rows[0].t.toISOString()};},
   async stop(id){gestoppt.add(id);},async cleanup(){},
   async command(id,req,_t,_m,onTerminal){
    kommandos.push({container:id,req});
    assert.equal(req.ausgabe,'/arbeit/'+req.auftrag_id);
    const out=join(arbeitVon.get(id),req.auftrag_id);
    assert.deepEqual(await readdir(out),[],'Ausgabeordner leer vorab angelegt');
    if(rohfehlerFuer===req.auftrag_id){await writeFile(join(out,'roh.bin'),'unveraenderter Rohstand');onTerminal?.();return {status:'fehler',fehlercode:unbekannterRohgrund,format_detail:rohesFormatdetail};}
    if(absturzFuer===req.auftrag_id){onTerminal?.();return {status:'fehler',fehlercode:'werkzeug_fehler',meldung:'Fixture-Absturz'};}
    await writeFile(join(out,'a.txt'),'hallo');
    onTerminal?.();return {status:'fertig',fehlercode:null,manifest:[{pfad:'a.txt',groesse:5,sha256:sha('hallo')}]};
   },
  };
  lc=new ToolLifecycle({pool:db,executor:fake,resources:ex.reverseRessourcen,maxContainers:4});
  const executor=new ex.ReverseExecutor({pool:db,konfig,lifecycle:()=>lc,identitaet:async()=>wer,uebernahmeOptionen:{konfiguration:cfg},
   registriereProjekt:async n=>{await db.query('INSERT INTO projects SELECT $1,true WHERE NOT EXISTS(SELECT 1 FROM projects WHERE name=$1)',[n]);}});
  unhook=ex.registriereWorkJobHooks(ex.REVERSE_CAPABILITY,executor.hooks());
  let kapazitaet={belegt:4,max:4};
  abmelden=core.meldeReverseAusfuehrer({kinds:konfig.kinds,parallel:konfig.parallel,kapazitaet:async()=>kapazitaet,
   containerNeustart:async j=>{
    try{return await lc.neustart(ex.REVERSE_TOOL_ID,ex.REVERSE_PROJEKT,j??null);}
    catch(e){if(!physischesEndeBestaetigt&&e.message==='tool_stop_unconfirmed')return {neu_gestartet:false,zustand:'stopping'};throw e;}
   }});
  const jobs=core.createWorkJobService({pool:db});
  const tool=a=>core.fuehreReverseAus(a,{pool:db});

  const eintrag=async(nr)=>{const rid='rev-t64-'+nr+'-'+randomUUID().slice(0,6);await db.query("INSERT INTO reverse_eintraege(id,titel,status) VALUES($1,'T64','bestaetigt')",[rid]);return rid;};
  const neuerAuftrag=async(nr,{kind='reverse-E',rid=null,haupt=null,begleit=[]}={})=>{
   rid??=await eintrag(nr);const satz=sha('satz'+nr+rid+kind);
   let m=(await db.query('SELECT id::text FROM reverse_medien WHERE eintrag_id=$1',[rid])).rows[0]?.id;
   if(!m){
    m=(await db.query("INSERT INTO reverse_medien(eintrag_id,position,bezeichnung,art,satz_sha256,status) VALUES($1,0,'CD1','iso',$2,'vollstaendig') RETURNING id::text",[rid,satz])).rows[0].id;
    const dateien=[{rolle:'haupt',name:'disc.iso',inhalt:haupt??'iso!'},...begleit.map(b=>({rolle:'begleit',...b}))];
    for(const f of dateien){
     const key=rid+'/original/dateien/'+sha(f.inhalt).slice(0,8)+'/'+f.name;
     await mkdir(dirname(join(reverseRoot,key)),{recursive:true});await writeFile(join(reverseRoot,key),f.inhalt);
     await db.query('INSERT INTO reverse_medien_dateien(medium_id,rolle,original_name,sha256,groesse,storage_key) VALUES($1,$2,$3,$4,$5,$6)',[m,f.rolle,f.name,sha(f.inhalt),Buffer.byteLength(f.inhalt),key]);
    }
   }
   const s=(await db.query('SELECT satz_sha256 FROM reverse_medien WHERE id=$1',[m])).rows[0].satz_sha256;
   const job=await jobs.enqueue({kind,capability:ex.REVERSE_CAPABILITY,project:ex.REVERSE_PROJEKT,scope:'reverse',
    inputRef:{scope:'reverse',id:rid,revision:m,sha256:s},resourceNeed:{cpu:1,ram:512,vram:0,gpu:false},priority:'hintergrund',idempotencyKey:'t64:'+rid+':'+kind});
   const schicht=kind==='reverse-E'?'E':kind.slice(8),fp=sha('fp'+rid+kind);
   const a=(await db.query("INSERT INTO reverse_auftraege(eintrag_id,medium_id,schicht,status,p20_auftrag_id,ausfuehrung,fingerabdruck) VALUES($1,$2,$3,'wartet',$4,'container',$5) RETURNING id::text",[rid,m,schicht,job.id,fp])).rows[0].id;
   if(schicht==='E')await db.query("INSERT INTO reverse_schichten(medium_id,schicht,fingerabdruck,status,auftrag_id) VALUES($1,$2,$3,'wartet',$4)",[m,schicht,fp,a]);
   const {bereiteReversePolicyPin}=await import('../../core/dist/services/reverse-analyse-policy.js');
   const pin=await bereiteReversePolicyPin(db,{id:a,reverseId:rid,dateiId:null,mediumId:m,angefragt:'E'});
   await db.query('UPDATE reverse_auftraege SET policy_pin=$2 WHERE id=$1',[a,pin]);
   if(core.ReversePipelineDienst.AdmissionFehler)await (await import('../../core/dist/services/reverse-pipeline-halt.js')).belegeReverseAdmission(db,job.id,a);
   return {rid,m,job,auftrag:a};
  };
  const zustand=async id=>(await db.query('SELECT state,error_code FROM work_jobs WHERE id=$1',[id])).rows[0];
  const auftrag=async id=>(await db.query("SELECT a.status,a.fehlercode,s.status AS schicht_status,s.fehlercode AS schicht_fehler FROM reverse_auftraege a LEFT JOIN reverse_schichten s ON s.auftrag_id=a.id AND s.aktuell WHERE a.id=$1",[id])).rows[0];
  const reverseContainer=async()=>(await db.query("SELECT count(*)::int AS n FROM tool_containers WHERE tool_id=$1 AND state<>'cold'",[ex.REVERSE_TOOL_ID])).rows[0].n;
  const durchlaufe=async n=>{for(let i=0;i<n;i++){await executor.durchlauf();await executor.leerlauf();assert.ok(await reverseContainer()<=1,'nie mehr als ein Reverse-Container');}};
  await executor.einrichten();

  // 1) Fälle von heute: E wartet auf Platz (Kapazität voll), S1 ohne Ausführer – sichtbar, status nennt ALLE offenen auftrag_ids.
  const e0=await neuerAuftrag(0),s1=await neuerAuftrag(0,{kind:'reverse-S1',rid:e0.rid});
  let diag=await core.diagnoseReverse({pool:db});
  const u=id=>diag.auftraege.find(x=>x.auftrag_id===id);
  assert.equal(u(e0.auftrag).ursache,'wartet_auf_platz',JSON.stringify(u(e0.auftrag)));
  assert.equal(u(s1.auftrag).ursache,'kein_ausfuehrer');assert.equal(u(s1.auftrag).automatisch,true);
  assert.equal(diag.ausfuehrer.aktiv,true);assert.deepEqual(diag.container,{belegt:4,max:4,reverse_container:0,instanzen:[]});
  const st=await tool({action:'status',agent_id:'claude-t64',reverse_id:e0.rid});
  assert.equal(st.success,true,JSON.stringify(st));assert.deepEqual(st.auftraege.map(a=>a.auftrag_id).sort(),[e0.auftrag,s1.auftrag].sort(),'status: alle offenen Aufträge');
  const dt=await tool({action:'diagnose',agent_id:'claude-t64',reverse_id:e0.rid});
  assert.equal(dt.success,true,JSON.stringify(dt));assert.equal(dt.ursachen.kein_ausfuehrer,1);
  console.log('PASS 1 diagnose: wartet_auf_platz + kein_ausfuehrer, status mit allen auftrag_ids');

  // 2) entstoeren: nur Koordinator/User, Vorschau ändert nichts, Ausführen storniert, zweiter Lauf idempotent.
  assert.equal((await tool({action:'entstoeren',agent_id:'claude-t64'})).fehlercode,'keine_berechtigung');
  const vor=await tool({action:'entstoeren',agent_id:'koordinator'});
  assert.equal(vor.vorschau,true);assert.equal(vor.anzahl,1,JSON.stringify(vor));assert.equal(vor.massnahmen[0].ergebnis,'vorschau');
  assert.equal((await zustand(s1.job.id)).state,'pending','Vorschau ändert nichts');
  const aus=await tool({action:'entstoeren',agent_id:'koordinator',vorschau:false});
  assert.equal(aus.massnahmen[0].ergebnis,'storniert',JSON.stringify(aus));
  assert.deepEqual(await zustand(s1.job.id),{state:'cancelled',error_code:'kein_ausfuehrer'});
  assert.deepEqual(await auftrag(s1.auftrag),{status:'fehler',fehlercode:'kein_ausfuehrer',schicht_status:null,schicht_fehler:null});
  assert.equal((await zustand(e0.job.id)).state,'pending','E bleibt unberührt');
  const nochmal=await tool({action:'entstoeren',agent_id:'koordinator',vorschau:false});
  assert.equal(nochmal.anzahl,0,JSON.stringify(nochmal));
  diag=await core.diagnoseReverse({pool:db});assert.equal(u(s1.auftrag).ursache,'kein_ausfuehrer');assert.equal(u(s1.auftrag).automatisch,false);
  assert.ok(diag.automatik.massnahmen.some(m=>m.quelle==='agent:koordinator'&&m.ergebnis==='storniert'),'Maßnahmen sichtbar');
  console.log('PASS 2 entstoeren Vorschau/Ausführen/idempotent');

  // 3) Ein Container für mehrere Aufträge nacheinander.
  kapazitaet={belegt:0,max:4};
  const e1=await neuerAuftrag(1),e2=await neuerAuftrag(2);
  await durchlaufe(4);
  for(const a of [e0,e1,e2])assert.equal((await zustand(a.job.id)).state,'completed');
  assert.equal(starts.length,1,'ein Containerstart für drei Aufträge');assert.equal(new Set(kommandos.map(k=>k.container)).size,1);
  assert.deepEqual(starts[0].HostConfig.Binds,[reverseRoot+':/bib:ro',konfig.arbeitRoot+':/arbeit:rw']);
  assert.equal(await reverseContainer(),1);
  diag=await core.diagnoseReverse({pool:db});assert.equal(diag.container.instanzen[0].scope,'global');
  console.log('PASS 3 ein Container, drei Aufträge nacheinander');

  // 4) Werkzeugabsturz trifft nur diesen Auftrag; Container läuft weiter.
  const e3=await neuerAuftrag(3),e4=await neuerAuftrag(4);absturzFuer=e3.job.id;
  await durchlaufe(3);
  assert.deepEqual(await zustand(e3.job.id),{state:'failed',error_code:'werkzeug_fehler'});
  assert.equal((await auftrag(e3.auftrag)).status,'wartet','wiederholbarer Fehler: Pipeline versucht erneut');
  assert.equal((await zustand(e4.job.id)).state,'completed');assert.equal(starts.length,1,'Container läuft weiter');
  absturzFuer=null;
  console.log('PASS 4 Absturz trifft nur einen Auftrag');
  // T93 R1: echter E-AUS-Aufrufer, keine direkte eHalten-Matrix; unbekannt/lang/Unicode bleibt roh.
  const rohfall=await neuerAuftrag('rohgrund');rohfehlerFuer=rohfall.job.id;
  await durchlaufe(2);rohfehlerFuer=null;
  assert.deepEqual(await zustand(rohfall.job.id),{state:'failed',error_code:'werkzeug_fehler'});
  assert.equal((await auftrag(rohfall.auftrag)).status,'wartet');
  const rohcp=(await db.query('SELECT uebernahme FROM reverse_auftraege WHERE id=$1',[rohfall.auftrag])).rows[0].uebernahme;
  assert.equal(rohcp.retention,true);assert.equal(rohcp.fortsetzung_gesperrt,true);
  assert.equal(rohcp.rueckhalt.grund,unbekannterRohgrund);
  assert.equal(rohcp.letzter_fehler,unbekannterRohgrund);assert.equal(rohcp.abschluss.grund,unbekannterRohgrund);
  assert.equal(rohcp.format_detail,rohesFormatdetail);
  const rohjournal=JSON.parse(await fs.readFile(join(konfig.arbeitRoot,rohfall.job.id,'.e-retention.json'),'utf8'));
  assert.equal(rohjournal.grund,unbekannterRohgrund);
  assert.equal(await fs.readFile(join(konfig.arbeitRoot,rohfall.job.id,'roh.bin'),'utf8'),'unveraenderter Rohstand');
  console.log('PASS T93 Rohgrund echter E-AUS-Aufrufer: Journal/Checkpoint unverändert, öffentlich failed/werkzeug_fehler, Fach wartet');

  // 5) P18-T46 (angepasst in der Testphase Welle 2): CloneCD liest der Runner jetzt mit dem eigenen Parser. Keine
  //    Vorab-Ablehnung mehr (vorher P18-T64: format_nicht_unterstuetzt:clonecd ohne Containerlauf); Haupt- und
  //    Begleitdateien gehen mit Originalnamen an den Runner, der fachliche Ausgang kommt vom Runner.
  const n=kommandos.length;
  const ccdPfad=join(root,'vorab.ccd');await writeFile(ccdPfad,'[CloneCD]\nVersion=3\n');
  assert.equal(await ex.reverseFormatVorpruefung([{pfad:ccdPfad,rolle:'haupt',name:'disc.ccd'}]),null,'keine Vorab-Ablehnung für CloneCD');
  const e5=await neuerAuftrag(5,{haupt:'[CloneCD]\nVersion=3\n',begleit:[{name:'disc.img',inhalt:'raw'},{name:'disc.sub',inhalt:'sub'}]});
  await durchlaufe(2);
  assert.deepEqual(await zustand(e5.job.id),{state:'completed',error_code:null});
  assert.equal(kommandos.length,n+1,'CloneCD läuft im Container');
  const k5=kommandos.find(k=>k.req.auftrag_id===e5.job.id).req;
  assert.equal(k5.eingabe_name,'disc.iso','Originalname der Hauptdatei an den Runner');
  assert.deepEqual(k5.begleitdateien.map(b=>b.name).sort(),['disc.img','disc.sub']);
  for(const b of k5.begleitdateien)assert.match(b.pfad,/^\/bib\/rev-t64-5-/);
  assert.notEqual((await auftrag(e5.auftrag)).fehlercode,'format_nicht_unterstuetzt:clonecd');
  const e6=await neuerAuftrag(6,{begleit:[{name:'disc.sub',inhalt:'sub6'}]});
  await durchlaufe(2);
  assert.equal((await zustand(e6.job.id)).state,'completed');
  const k6=kommandos.find(k=>k.req.auftrag_id===e6.job.id).req;
  assert.equal(k6.begleitdateien.length,1);assert.match(k6.begleitdateien[0].pfad,/^\/bib\/rev-t64-6-.*\/disc\.sub$/);assert.equal(k6.begleitdateien[0].name,'disc.sub');
  console.log('PASS 5 CloneCD läuft im Container (P18-T46), Begleitdateien');

  // 6) Abgelaufene Lease wird erkannt und freigegeben.
  const e7=await neuerAuftrag(7);
  await db.query("UPDATE work_jobs SET state='leased',owner_node='weg',boot_generation=$2,owner_auth_hash='weg',claim_token=$3,resource_domain='x',lease_until=clock_timestamp()-interval '1 minute' WHERE id=$1",[e7.job.id,randomUUID(),randomUUID()]);
  diag=await core.diagnoseReverse({pool:db});assert.equal(u(e7.auftrag).ursache,'lease_abgelaufen');
  const lr=await core.entstoereReverse({pool:db,ausfuehren:true,ursachen:['lease_abgelaufen'],quelle:'test'});
  assert.equal(lr.massnahmen[0].ergebnis,'freigegeben:pending',JSON.stringify(lr));assert.equal((await zustand(e7.job.id)).state,'pending');
  console.log('PASS 6 lease_abgelaufen freigegeben');

  // 7) Neustart über den Lebenszyklus; danach startet der nächste Durchlauf denselben globalen Container neu.
  const ns=await lc.neustart(ex.REVERSE_TOOL_ID,ex.REVERSE_PROJEKT);
  assert.equal(ns.neu_gestartet,true);assert.equal(await reverseContainer(),0);
  await durchlaufe(2);
  assert.equal((await zustand(e7.job.id)).state,'completed');assert.equal(starts.length,2);assert.equal(await reverseContainer(),1);
  console.log('PASS 7 Neustart über den Lebenszyklus');

  // 8) Pipeline: kein Ausführer für S1 -> keine ergänzenden Container-Aufträge mehr (Gate über die Registry).
  assert.equal(core.reverseKindAusfuehrbar('reverse-S1'),false);assert.equal(core.reverseKindAusfuehrbar('reverse-E'),true);
  assert.equal(core.reverseFehlerDeterministisch('format_nicht_unterstuetzt:clonecd'),true);assert.equal(core.reverseFehlerDeterministisch('werkzeug_fehler'),false);
  console.log('PASS 8 Registry/Fehlerregeln');

  // 9) Pipeline: ohne Ausführer kein Work-Job (kein_ausfuehrer sichtbar), mit Ausführer lebt der Auftrag wieder auf;
  //    fachlicher Fehler (CloneCD) wird NICHT still wiederholt, der echte Code bleibt stehen.
  process.env.SYNAPSE_REVERSE_RESOURCE_NEED='{"cpu":1,"ram":512,"vram":0,"gpu":false}';process.env.SYNAPSE_REVERSE_CONTAINER_PROFIL='t64';
  const rid9=await eintrag(9),satz9=sha('s9'+rid9);
  const m9=(await db.query("INSERT INTO reverse_medien(eintrag_id,position,bezeichnung,art,satz_sha256,status) VALUES($1,0,'CD1','iso',$2,'vollstaendig') RETURNING id::text",[rid9,satz9])).rows[0].id;
  const tx=async fn=>{const c=await connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
  const anfrage={reverseId:rid9,project:'reverse-bibliothek',agentId:'t64',dateiId:null,mediumId:m9,bisSchicht:'E',prioritaet:'hintergrund'};
  const workZahl=async()=>(await db.query("SELECT count(*)::int AS n FROM work_jobs WHERE input_ref->>'id'=$1",[rid9])).rows[0].n;
  const ohne=new core.ReversePipelineDienst({pool:db,konfiguration:cfg,ausfuehrbareKinds:[]});
  const mit=new core.ReversePipelineDienst({pool:db,konfiguration:cfg,ausfuehrbareKinds:['reverse-E']});
  try{
   const r9a=await tx(c=>ohne.queue(c,anfrage));
   assert.equal(r9a.fehlercode,'kein_ausfuehrer',JSON.stringify(r9a));assert.equal(await workZahl(),0,'kein ewig pending Work-Job');
   const r9b=await tx(c=>mit.queue(c,anfrage));
   assert.equal(r9b.status,'wartet',JSON.stringify(r9b));assert.equal(await workZahl(),1,'mit Ausführer eingereiht');
   assert.equal((await db.query("SELECT status FROM reverse_schichten WHERE medium_id=$1 AND schicht='E' AND aktuell",[m9])).rows[0].status,'wartet');
   await db.query("UPDATE work_jobs SET state='failed',error_code='format_nicht_unterstuetzt:clonecd' WHERE input_ref->>'id'=$1",[rid9]);
   for(let i=0;i<2;i++){
    const r9c=await tx(c=>mit.queue(c,anfrage));
    assert.equal(r9c.status,'fehler',JSON.stringify(r9c));assert.equal(r9c.fehlercode,'format_nicht_unterstuetzt:clonecd');
   }
   assert.equal(await workZahl(),1,'fachlicher Fehler wird nicht wiederholt');
   assert.deepEqual((await db.query("SELECT status,fehlercode FROM reverse_schichten WHERE medium_id=$1 AND schicht='E' AND aktuell",[m9])).rows[0],{status:'fehler',fehlercode:'format_nicht_unterstuetzt:clonecd'});
  }finally{await ohne.beende();await mit.beende();}
  console.log('PASS 9 Pipeline kein_ausfuehrer/Wiederbelebung/kein stiller Neuversuch');

  // 10) Migration (M2): alter Descriptor je Auftrag mit zwei warmen Job-Containern. Neuer Executor (= API-Neustart mit
  //     neuem Code) weckt KEINE neuen Job-Container, stoppt die ruhenden Alt-Container und stellt sofort um.
  await lc.neustart(ex.REVERSE_TOOL_ID,ex.REVERSE_PROJEKT);assert.equal(await reverseContainer(),0);
  const neu=ex.reverseToolDescriptor(konfig);
  const altD={...neu,instance_scope:'job',mounts:[{role:'bibliothek',target:'/bib',write:false},{role:'arbeit',target:'/arbeit',write:true,job_only:true}],
   resources:{...neu.resources,concurrency:1},lifecycle:{...neu.lifecycle,idle_ms:30000}};
  await core.registerToolDescriptor(db,altD,{role:'koordinator',authenticated:true});
  const m1=await neuerAuftrag(10),m2=await neuerAuftrag(11);
  await lc.wake(ex.REVERSE_TOOL_ID,ex.REVERSE_PROJEKT,m1.job.id);await lc.wake(ex.REVERSE_TOOL_ID,ex.REVERSE_PROJEKT,m2.job.id);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM tool_containers WHERE tool_id=$1 AND state='warm' AND work_job_id IS NOT NULL",[ex.REVERSE_TOOL_ID])).rows[0].n,2,'zwei Alt-Container');
  const vorMigration=starts.length;
  unhook();
  const executor2=new ex.ReverseExecutor({pool:db,konfig,lifecycle:()=>lc,identitaet:async()=>wer,uebernahmeOptionen:{konfiguration:cfg},
   registriereProjekt:async()=>{}});
  unhook=ex.registriereWorkJobHooks(ex.REVERSE_CAPABILITY,executor2.hooks());
  const mig=await executor2.durchlauf();
  assert.equal(mig.hinweis,'migration_alte_container_laufen_aus',JSON.stringify(mig));
  assert.equal(starts.length,vorMigration,'im Altmodus keine neuen Job-Container');assert.equal(await reverseContainer(),0,'ruhende Alt-Container gestoppt');
  assert.equal((await db.query('SELECT enabled FROM tool_activation WHERE tool_id=$1 AND project=$2',[ex.REVERSE_TOOL_ID,ex.REVERSE_PROJEKT])).rows[0].enabled,false,'Aktivierung während der Migration aus');
  for(let i=0;i<3;i++){await executor2.durchlauf();await executor2.leerlauf();assert.ok(await reverseContainer()<=1);}
  assert.equal((await zustand(m1.job.id)).state,'completed');assert.equal((await zustand(m2.job.id)).state,'completed');
  assert.equal(starts.length,vorMigration+1,'genau ein neuer, globaler Container');
  assert.deepEqual(starts.at(-1).HostConfig.Binds,[reverseRoot+':/bib:ro',konfig.arbeitRoot+':/arbeit:rw']);
  assert.equal((await db.query('SELECT descriptor->>\'instance_scope\' AS s FROM tool_descriptors WHERE tool_id=$1',[ex.REVERSE_TOOL_ID])).rows[0].s,'project');
  assert.equal((await db.query('SELECT enabled FROM tool_activation WHERE tool_id=$1 AND project=$2',[ex.REVERSE_TOOL_ID,ex.REVERSE_PROJEKT])).rows[0].enabled,true);
  console.log('PASS 10 Migration ohne neue Job-Container, sofortige Umstellung');

  // 11) API-Neustart mitten im Auftrag + automatischer Entstörer: unbekannter Lauf blockiert den Container, Lease ist
  //     abgelaufen, dazu ein ausführerloser S1-Auftrag. Ein Automatik-Durchlauf behebt alles, danach läuft der Auftrag.
  const h=await neuerAuftrag(12),hs1=await neuerAuftrag(12,{kind:'reverse-S1',rid:h.rid});
  const inst=(await db.query("SELECT instance_id,generation,container_id FROM tool_containers WHERE tool_id=$1 AND state='warm'",[ex.REVERSE_TOOL_ID])).rows[0];
  assert.ok(inst,'globaler Container warm');
  await db.query("UPDATE work_jobs SET state='leased',attempt=1,owner_node=$2,boot_generation=$3,owner_auth_hash=$4,claim_token=$5,resource_domain='x',lease_until=clock_timestamp()-interval '1 minute' WHERE id=$1",
   [h.job.id,wer.nodeId,randomUUID(),wer.authHash,randomUUID()]);
  await db.query("INSERT INTO tool_container_runs(job_id,attempt,instance_id,generation,state) VALUES($1,1,$2,$3,'unknown')",[h.job.id,inst.instance_id,inst.generation]);
  diag=await core.diagnoseReverse({pool:db});
  assert.equal(diag.container.instanzen[0].ursache,'container_haengt',JSON.stringify(diag.container));
  assert.equal(u(h.auftrag).ursache,'lease_abgelaufen');assert.equal(u(hs1.auftrag).ursache,'kein_ausfuehrer');
  process.env.SYNAPSE_REVERSE_ENTSTOERER_KEIN_AUSFUEHRER_S='0';process.env.SYNAPSE_REVERSE_ENTSTOERER_MS='3600000';
  physischesEndeBestaetigt=false;
  const auto=core.starteReverseEntstoerer({pool:db});
  try{
   const lauf=await auto.durchlauf();
   const alle=[...lauf.kein_ausfuehrer.massnahmen,...lauf.rest.massnahmen];
   assert.ok(alle.some(m=>m.ursache==='kein_ausfuehrer'&&m.ergebnis==='storniert'),JSON.stringify(alle));
   assert.ok(alle.some(m=>m.ursache==='lease_abgelaufen'&&m.ergebnis==='freigegeben:pending'),JSON.stringify(alle));
   assert.ok(alle.some(m=>m.ursache==='container_haengt'&&m.ergebnis.startsWith('ausstehend')),JSON.stringify(alle));
   assert.equal((await fake.observe(inst.container_id)).running,true,'Stopanforderung allein ist kein physischer Endbeleg');
   assert.equal((await db.query('SELECT state FROM tool_containers WHERE instance_id=$1',[inst.instance_id])).rows[0].state,'stopping');
   // T105/28465: vorhandener Fake liefert den Endbeleg erst jetzt; Lifecycle bestätigt Ende/Ressourcen/Run.
   physischesEndeBestaetigt=true;await lc.tick();
   assert.equal((await fake.observe(inst.container_id)).running,false,'physisch gestoppt');
   const gestopptBeleg=(await db.query('SELECT state,container_id,resource_token FROM tool_containers WHERE instance_id=$1',[inst.instance_id])).rows[0];
   assert.deepEqual(gestopptBeleg,{state:'cold',container_id:null,resource_token:null},'gestoppt erst nach physischem Ende');
   assert.equal((await db.query("SELECT count(*)::int n FROM tool_container_runs WHERE instance_id=$1 AND generation=$2 AND state IN('running','unknown')",[inst.instance_id,inst.generation])).rows[0].n,0,'keine unbestätigten Runs nach Endbeleg');
   diag=await core.diagnoseReverse({pool:db});
   assert.equal(diag.automatik.aktiv,true);assert.ok(diag.automatik.letzter_lauf.massnahmen>=3);assert.ok(diag.automatik.massnahmen.some(m=>m.quelle==='automatik'));
   assert.equal((await auto.durchlauf()).rest.anzahl,0,'zweiter Automatik-Lauf: nichts mehr zu tun');
  }finally{auto.beende();}
  await db.query("UPDATE tool_container_runs SET state='done' WHERE job_id=$1",[h.job.id]);
  for(let i=0;i<3;i++){await executor2.durchlauf();await executor2.leerlauf();assert.ok(await reverseContainer()<=1);}
  assert.equal((await zustand(h.job.id)).state,'completed','Auftrag nach Neustart erledigt');
  console.log('PASS 11 API-Neustart + automatischer Entstörer');
 });}finally{
  abmelden?.();unhook?.();lc?.close();
  await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');await pool.end();
  fs.chown=originalChown;syncBuiltinESMExports();
  await rm(root,{recursive:true,force:true});
 }
});
