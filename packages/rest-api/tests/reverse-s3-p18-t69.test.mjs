/**
 * P18-T69 E3/E4/E5: reverse-S3 (Ghidra) von der Anforderung bis in die Code-Tabellen.
 *  A Schalter reverse_s3 AUS: nichts eingereiht (kein Auftrag, kein Work-Job).
 *  B Schalter EIN: eine S2-Anforderung wird EIN reverse-S3-Containerauftrag mit 4 GB/2 CPU (User da83be67).
 *  C Executor-Konfig/Descriptor mit S3-Budget; Ausfuehrung ueber Fake-Lebenszyklus mit echtem Lease/Stage/Complete und
 *    echter Uebernahme: S2+S3-Schicht, Code-Dateien, Funktionssymbole mit Adresse/Groesse/Zeilen, Pipeline danach fertig.
 *  D Importer direkt: Idempotenz, SHA-Pruefung (nichts geschrieben), 50-MB-Budget je Eintrag (teilweise/zu_gross).
 *  E Ordnerrechte (E6-Befund): Ordner unter der Wurzel root:65532 0710, Datei 0640; Link/fehlend/ausserhalb/EPERM klar benannt;
 *    Executor ohne Eingaberechte ohne Runner-Lauf; Runnerfehler mit echter Meldung im Log.
 * Nur synapse_test:5433, privates Schema, temporaere Dateien. Kein Docker, kein Ghidra.
 */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
const dbUrl=new URL(process.env.DATABASE_URL??'http://invalid');
assert.equal(dbUrl.port,'5433','nur Test-Port');assert.equal(dbUrl.pathname,'/synapse_test','nur Testdatenbank');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_COMPUTE_POLICY_ENABLED','SYNAPSE_COMPUTE_ADMISSION','SYNAPSE_REVERSE_S3_RESOURCE_NEED',
 'SYNAPSE_REVERSE_S3_PG_MAX_BYTES','SYNAPSE_REVERSE_WERKZEUG_VERSION','SYNAPSE_REVERSE_S3_ZEITLIMIT_S','SYNAPSE_REVERSE_ZEITLIMIT_S'])delete process.env[k];
const sha=b=>createHash('sha256').update(b).digest('hex');
const temp=await mkdtemp(join(tmpdir(),'p18-t69-')),reverseRoot=join(temp,'rev');
await mkdir(join(reverseRoot,'_arbeit'),{recursive:true});
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',
 EMBEDDING_BASE_URL:'http://127.0.0.1:1',SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:reverseRoot,
 SYNAPSE_REVERSE_IMAGE:'synapse-reverse@sha256:'+'c'.repeat(64),SYNAPSE_REVERSE_RESOURCE_NEED:'{"cpu":2,"ram":2048,"vram":0,"gpu":false}',
 SYNAPSE_REVERSE_CONTAINER_PROFIL:'reverse-standard',SYNAPSE_REVERSE_EXECUTOR_KINDS:'reverse-E,reverse-S3'});
const require=createRequire(new URL('../../core/package.json',import.meta.url));
const {Pool}=require('pg');
const quote=s=>'"'+s.replaceAll('"','""')+'"';
const schema='p18_t69_'+process.pid+'_'+randomUUID().slice(0,8);
// Ghidra-Export wie ExportFunctions.java (E2): drei Funktionen, eine nicht dekompiliert.
const JSONL=[
 {name:'FUN_00401000',address:'00401000',address_offset:4198400,size:16,thunk:false,prototype:'void FUN_00401000(void)',decompiled:'\nvoid FUN_00401000(void)\n\n{\n  return;\n}\n\n',decompile_status:'ok'},
 {name:'entry',address:'00401010',address_offset:4198416,size:32,thunk:false,prototype:'int entry(void)',decompiled:'\nint entry(void)\n\n{\n  FUN_00401000();\n  return 0;\n}\n',decompile_status:'ok'},
 {name:'FUN_00401030',address:'00401030',address_offset:4198448,size:8,thunk:false,prototype:'undefined FUN_00401030(void)',decompiled:'',decompile_status:'Decompiler timed out'},
].map(x=>JSON.stringify(x)).join('\n')+'\n';
const JSONL2=JSONL+'{"kaputt":true}\n';
const manifest=t=>[{pfad:'functions.jsonl',sha256:sha(t),groesse:Buffer.byteLength(t)}];
let checks=0;
const eq=(a,b,m)=>{assert.deepEqual(a,b,m);checks++;};
const ok=(v,m)=>{assert.ok(v,m);checks++;};
const admin=new Pool({connectionString:dbUrl.href,max:2});
let made=false,closePool=null,pipe=null,unhook=null,fehler=null;
try{
 await admin.query('CREATE SCHEMA '+schema);made=true;
 for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows)
  await admin.query('CREATE TABLE '+schema+'.'+quote(tablename)+' (LIKE public.'+quote(tablename)+' INCLUDING ALL)');
 const serials=(await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%'",[schema])).rows;
 for(const [i,c]of serials.entries()){const s=schema+'.private_serial_'+i;await admin.query('CREATE SEQUENCE '+s);
  await admin.query('ALTER TABLE '+schema+'.'+quote(c.table_name)+' ALTER COLUMN '+quote(c.column_name)+" SET DEFAULT nextval('"+s+"'::regclass)");}
 dbUrl.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=dbUrl.href;
 const core=await import('../../core/dist/index.js');({closePool}=await import('../../core/dist/db/client.js'));
 const {setzeProfilProduktSchalter}=await import('../../core/dist/services/agent-profil-schalter.js');
 const {reverseAnalyseFingerabdruck}=await import('../../core/dist/services/reverse-pipeline.js');
 const ex=await import('../dist/services/reverse-executor.js');
 const pool=core.getPool();
 eq((await pool.query('SELECT current_database() d,current_schema() s')).rows[0],{d:'synapse_test',s:schema},'privates Testschema');
 for(const file of ['reverse-schema','reverse-pipeline-schema','work-jobs-schema']){
  const mod=await import('../../core/dist/db/'+file+'.js');for(const sql of Object.values(mod).filter(v=>typeof v==='string'))await pool.query(sql);
 }
 const row=async(table,values)=>{
  const cols=(await pool.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND ((is_nullable='NO' AND column_default IS NULL AND is_identity='NO') OR column_name=ANY($3::text[]))",[schema,table,Object.keys(values)])).rows;
  const vals=cols.map(c=>Object.hasOwn(values,c.column_name)?values[c.column_name]:(c.data_type==='boolean'?false:c.data_type.includes('int')||c.data_type.includes('numeric')?0:c.data_type.includes('json')?'{}':c.data_type.includes('time')?new Date():c.data_type==='ARRAY'?[]:'fixture'));
  await pool.query('INSERT INTO '+quote(table)+'('+cols.map(c=>quote(c.column_name)).join(',')+') VALUES('+vals.map((_,i)=>'$'+(i+1)).join(',')+')',vals);
 };
 const tx=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}
  catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}};

 const RID='rev-t69-'+randomUUID().slice(0,8),P='p18-t69';
 await pool.query("INSERT INTO reverse_eintraege(id,titel,status) VALUES($1,'T69','bestaetigt')",[RID]);
 const mid=(await pool.query("INSERT INTO reverse_medien(eintrag_id,position,bezeichnung,art,satz_sha256,status) VALUES($1,0,'medium-1','iso',$2,'vollstaendig') RETURNING id::text AS id",[RID,sha('medium')])).rows[0].id;
 const datei=async(name,inhalt)=>{
  const key=RID+'/entpackt/m'+mid+'/S3/'+name;
  await mkdir(dirname(join(reverseRoot,key)),{recursive:true});await writeFile(join(reverseRoot,key),inhalt);
  return (await pool.query("INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,sha256,groesse,art,storage_key,status) VALUES($1,$2,$3,$4,$5,'binaer',$6,'fertig') RETURNING id::text AS id",
   [RID,mid,'medium-1/S3/'+name,sha(inhalt),inhalt.length,key])).rows[0].id;
 };
 pipe=new core.ReversePipelineDienst({pool,ausfuehrbareKinds:['reverse-E','reverse-S3']});
 const vorstufen=async d=>{for(const s of ['S0','S1'])await pool.query("INSERT INTO reverse_schichten(datei_id,schicht,fingerabdruck,status,werkzeug,werkzeug_version,profil_version) VALUES($1,$2,$3,'fertig','asset-inspektoren',$4,$5)",[d,s,sha(s+d),pipe.version,pipe.profile]);};
 const anfordern=(d,bis)=>tx(db=>pipe.analysieren({reverseId:RID,project:P,agentId:'t69',dateiId:d,mediumId:null,bisSchicht:bis,prioritaet:'interaktiv'},db));
 const zahl=async(sql,args)=>Number((await pool.query(sql,args)).rows[0].n);

 // A Schalter AUS
 const D1=await datei('AUTORUN.EXE',Buffer.from('MZ-autorun-fixture'));await vorstufen(D1);
 let r=await anfordern(D1,'S3');
 eq([r.status,r.fehlercode,r.fehler_detail],['fehler','kein_ausfuehrer','reverse_s3_aus'],'A: Schalter AUS meldet reverse_s3_aus');
 eq(await zahl("SELECT count(*)::int n FROM reverse_auftraege WHERE datei_id=$1 AND schicht IN ('S2','S3')",[D1]),0,'A: kein Auftrag');
 eq(await zahl("SELECT count(*)::int n FROM work_jobs WHERE kind='reverse-S3'",[]),0,'A: kein Work-Job');
 console.log('PASS A Schalter AUS');

 // B Schalter EIN, S2-Anforderung -> ein S3-Containerauftrag
 await setzeProfilProduktSchalter({ebene:'global',funktion:'reverse_s3',aktiv:true,grund:'P18-T69 Test'},{system:'user'});
 r=await anfordern(D1,'S2');
 const a1=(await pool.query("SELECT id,schicht,ausfuehrung,werkzeug,werkzeug_version,profil_version,p20_auftrag_id::text AS job FROM reverse_auftraege WHERE datei_id=$1 AND schicht IN ('S2','S3')",[D1])).rows;
 eq(a1.map(x=>[x.schicht,x.ausfuehrung,x.werkzeug]),[['S3','container','reverse-S3']],'B: S2 fordert genau einen S3-Containerauftrag an');
 const jobId=a1[0].job;ok(jobId,'B: Work-Job verknuepft');
 const wj=(await pool.query('SELECT kind,state,resource_need,input_ref,priority FROM work_jobs WHERE id=$1',[jobId])).rows[0];
 eq([wj.kind,wj.state,wj.resource_need.cpu,wj.resource_need.ram,wj.input_ref.revision,wj.priority],['reverse-S3','pending',2,4096,D1,'interaktiv'],'B: reverse-S3 mit 4 GB/2 CPU, interaktiv');
 console.log('PASS B S2->S3-Auftrag');

 // C Executor
 const konfig=ex.ladeReverseExecutorKonfig(process.env,reverseRoot);
 eq(konfig.kinds,['reverse-E','reverse-S3'],'C: Kinds');
 eq([konfig.s3ResourceNeed.cpu,konfig.s3ResourceNeed.ram,konfig.s3ZeitlimitS,konfig.s3MaxBytes],[2,4096,3600,268435456],'C: S3-Budget (User da83be67)');
 const d=ex.reverseToolDescriptor(konfig);
 eq([d.resources.cpu,d.resources.ram,d.limits.time_ms],[2,4096,3660000],'C: ein Container mit S3-Budget');
 eq(ex.reverseToolDescriptor(ex.ladeReverseExecutorKonfig({...process.env,SYNAPSE_REVERSE_EXECUTOR_KINDS:'reverse-E'},reverseRoot)).resources.ram,2048,'C: ohne S3 unveraendert');
 const wer={nodeId:'t69-node',bootGeneration:randomUUID(),authHash:'t69-hash'};
 await row('embedding_knoten',{node_id:wer.nodeId,boot_id:wer.bootGeneration,service_token_hash:wer.authHash,status:'ready',gesperrt_vom_user:false,letzter_kontakt:new Date(),node_kind:'cpu',max_concurrency:1,contract_version:1,features:['compute_cpu_only'],modell:null,modell_digest:null,native_dimension:null,ollama_url:null,quantisierung:null,ziel_dimension:null,num_ctx:null,vram_gesamt_mb:null,vram_frei_mb:null});
 const aufrufe=[];
 const fakeLc={
  async execute(tool,projekt,id,_w,_t,bauen){
   const req=await bauen();aufrufe.push({tool,projekt,id,req});
   if(lcAntwort)return lcAntwort;
   await writeFile(join(konfig.arbeitRoot,id,'functions.jsonl'),JSONL);
   return {status:'fertig',fehlercode:null,werkzeug_version:'11.4.3',dauer_s:1.5,manifest:manifest(JSONL),ausgabe_bytes:Buffer.byteLength(JSONL)};
  },
  async wake(){},async status(){return {status:'warm'};},async neustart(){return {neu_gestartet:false,zustand:'warm'};},
 };
 const lesbar=[];let lesbarAntwort=null,lcAntwort=null;
 const executor=new ex.ReverseExecutor({pool,konfig,lifecycle:()=>fakeLc,identitaet:async()=>wer,eingabeLesbar:async(pfade,wurzel)=>{lesbar.push([pfade,wurzel]);return lesbarAntwort;}});
 executor.wer=wer;
 unhook=ex.registriereWorkJobHooks(ex.REVERSE_CAPABILITY,executor.hooks());
 const jobs=core.createWorkJobService({pool});
 let claim=(await jobs.claim(wer,{limit:1,leaseSeconds:300})).find(j=>j.id===jobId);
 if(!claim){
  // Der Claim-Guard verlangt live einen warmen Tool-Container; ohne Docker die Lease wie ein Claim setzen.
  await pool.query(`UPDATE work_jobs SET state='leased',owner_node=$2,boot_generation=$3::uuid,owner_auth_hash=$4,claim_token=$5::uuid,
   lease_until=clock_timestamp()+interval '5 minutes',resource_domain=$6,attempt=1,updated_at=clock_timestamp() WHERE id=$1`,
   [jobId,wer.nodeId,wer.bootGeneration,wer.authHash,randomUUID(),'reverse:'+wer.nodeId]);
  claim=await jobs.get(jobId,'reverse-bibliothek');
 }
 ok(claim?.claimToken,'C: Auftrag geleast');
 await executor.fuehreAus(fakeLc,wer,claim);
 eq(aufrufe.length,1,'C: genau ein Runner-Aufruf');
 eq(lesbar,[[[join(reverseRoot,RID+'/entpackt/m'+mid+'/S3/AUTORUN.EXE')],reverseRoot]],'C: Eingaberechte mit Wurzel (Ordner durchquerbar)');
 eq(aufrufe[0].req,{werkzeug:'analyzeHeadless',schicht:'S3',eingabe:'/bib/'+RID+'/entpackt/m'+mid+'/S3/AUTORUN.EXE',ausgabe:'/arbeit/'+jobId,
  grenzen:{zeitlimit_s:3600,max_bytes:268435456,max_dateien:konfig.maxDateien}},'C: Runner-Auftrag fuer Ghidra');
 eq((await pool.query('SELECT state FROM work_jobs WHERE id=$1',[jobId])).rows[0].state,'completed','C: Work-Job completed (stage+complete ueber die Hooks)');
 const schichten=Object.fromEntries((await pool.query("SELECT schicht,status,fehlercode,funktionen_gesamt,funktionen_fertig,fingerabdruck,werkzeug,werkzeug_version,profil_version,ausgabe_key FROM reverse_schichten WHERE datei_id=$1 AND aktuell",[D1])).rows.map(x=>[x.schicht,x]));
 eq([schichten.S3.status,schichten.S3.funktionen_gesamt,schichten.S3.funktionen_fertig,schichten.S3.fehlercode],['teilweise',3,2,null],'C: S3 teilweise (eine Funktion ohne Dekompilat)');
 eq(schichten.S3.ausgabe_key,core.reverseS3AusgabeKey(RID,D1,jobId),'C: S3-Marker dieses Auftrags');
 eq([schichten.S2.status,schichten.S2.funktionen_gesamt,schichten.S2.werkzeug],['fertig',3,'reverse-S3'],'C: S2 aus demselben Lauf');
 eq(schichten.S2.fingerabdruck,reverseAnalyseFingerabdruck(sha(Buffer.from('MZ-autorun-fixture')),'S2','reverse-S3',a1[0].werkzeug_version,a1[0].profil_version),'C: S2-Fingerabdruck passt zur Pipeline');
 eq((await pool.query('SELECT status FROM reverse_auftraege WHERE id=$1',[a1[0].id])).rows[0].status,'teilweise','C: Auftrag abgeschlossen');
 const files=(await pool.query("SELECT file_path,schicht,file_type,content FROM reverse_code_dateien WHERE datei_id=$1 ORDER BY file_path",[D1])).rows;
 eq(files.map(f=>[f.file_path,f.schicht,f.file_type]).filter(f=>f[1]!=='S1'),[
  ['medium-1/S3/AUTORUN.EXE@S2/funktionen-0001.txt','S2','txt'],['medium-1/S3/AUTORUN.EXE@S3/dekompiliert-0001.c','S3','c']],'C: virtuelle S2/S3-Dateien');
 const c=files.find(f=>f.schicht==='S3').content.split('\n');
 const sym=(await pool.query("SELECT name,symbol_type,adresse::text,groesse_bytes::text,line_start,line_end,value FROM reverse_code_symbole WHERE datei_id=$1 AND schicht='S3' ORDER BY adresse",[D1])).rows;
 eq(sym.map(s=>[s.name,s.symbol_type,s.adresse,s.groesse_bytes]),[['FUN_00401000','function','4198400','16'],['entry','function','4198416','32'],['FUN_00401030','function','4198448','8']],'C: Funktionssymbole mit Adresse und Groesse');
 const e=sym.find(s=>s.name==='entry');
 ok(c[e.line_start-1].includes('entry @ 0x00401010'),'C: Zeilenbeginn = Funktionskopf');eq(c[e.line_end-1],'}','C: Zeilenende = Funktionsende');eq(e.value,'int entry(void)','C: Prototyp');
 ok(c.join('\n').includes('kein Dekompilat: Decompiler timed out'),'C: Fehlerstatus statt leerem Text');
 ok(files.find(f=>f.schicht==='S2').content.includes('0x00401010\t32\tentry\tint entry(void)'),'C: Funktionsliste S2');
 eq(await zahl("SELECT count(*)::int n FROM reverse_code_dateien d WHERE d.eintrag_id=$1 AND d.schicht IN ('S2','S3') AND EXISTS(SELECT 1 FROM reverse_schichten rs WHERE rs.datei_id=d.datei_id AND rs.schicht=d.schicht AND rs.fingerabdruck=d.fingerabdruck AND rs.aktuell AND rs.status IN ('fertig','teilweise'))",[RID]),2,'C: fuer den Code-Leser sichtbar (fertige Schicht, gleicher Fingerabdruck)');
 r=await anfordern(D1,'S3');eq(r.status,'fertig','C: Pipeline danach fertig, kein neuer Auftrag');
 console.log('PASS C Executor + Uebernahme');

 // D Importer direkt
 const again=await tx(db=>core.uebernehmeS3Ergebnis(db,{jobId,reverseId:RID,dateiId:D1,arbeitsWurzel:join(konfig.arbeitRoot,jobId),manifest:manifest(JSONL)}));
 eq([again.status,again.funktionen,again.dekompiliert],['teilweise',3,2],'D: idempotent je Auftrag');
 eq(await zahl("SELECT count(*)::int n FROM reverse_code_symbole WHERE datei_id=$1",[D1]),3,'D: keine doppelten Symbole');
 const D2=await datei('SETUP.EXE',Buffer.from('MZ-setup-fixture'));await vorstufen(D2);
 await anfordern(D2,'S3');
 const job2=(await pool.query("SELECT p20_auftrag_id::text AS job FROM reverse_auftraege WHERE datei_id=$1 AND schicht='S3'",[D2])).rows[0].job;
 const arbeit2=join(konfig.arbeitRoot,job2);await mkdir(arbeit2,{recursive:true});await writeFile(join(arbeit2,'functions.jsonl'),JSONL2);
 await assert.rejects(()=>tx(db=>core.uebernehmeS3Ergebnis(db,{jobId:job2,reverseId:RID,dateiId:D2,arbeitsWurzel:arbeit2,
  manifest:[{pfad:'functions.jsonl',sha256:'0'.repeat(64),groesse:Buffer.byteLength(JSONL2)}]})),x=>x.code==='beschaedigt');checks++;
 eq(await zahl("SELECT count(*)::int n FROM reverse_code_dateien WHERE datei_id=$1 AND schicht IN ('S2','S3')",[D2]),0,'D: falscher Hash schreibt nichts');
 const d1Bytes=await zahl("SELECT sum(file_size)::int n FROM reverse_code_dateien WHERE datei_id=$1 AND schicht='S3'",[D1]);
 const r2=await tx(db=>core.uebernehmeS3Ergebnis(db,{jobId:job2,reverseId:RID,dateiId:D2,arbeitsWurzel:arbeit2,manifest:manifest(JSONL2)},{maxPgBytes:d1Bytes+120}));
 eq([r2.status,r2.funktionen,r2.gespeichert,r2.verworfen],['teilweise',3,1,1],'D: Budget je Eintrag erreicht, ungueltige Zeile verworfen');
 const s2=(await pool.query("SELECT schicht,status,fehlercode FROM reverse_schichten WHERE datei_id=$1 AND aktuell AND schicht IN ('S2','S3') ORDER BY schicht",[D2])).rows;
 eq(s2.map(x=>[x.schicht,x.status,x.fehlercode]),[['S2','teilweise',null],['S3','teilweise','zu_gross']],'D: S3 zu_gross, S2 vollstaendige Liste aber verworfene Zeile');
 eq(await zahl("SELECT count(*)::int n FROM reverse_code_symbole WHERE datei_id=$1",[D2]),1,'D: nur gespeicherte Funktionen als Symbol');
 ok((await pool.query("SELECT content FROM reverse_code_dateien WHERE datei_id=$1 AND schicht='S2'",[D2])).rows[0].content.includes('FUN_00401030'),'D: S2 listet alle Funktionen');
 console.log('PASS D Importer');

 // E Ordnerrechte: entpackte Dateien liegen unter 0750-Ordnern, der Runner (65532) muss hindurch.
 const {lstat:fsLstat,chmod:fsChmod,stat:fsStat,symlink}=await import('node:fs/promises');
 const rw=join(temp,'rechte'),rk='rev-x/entpackt/m1/S3/X.EXE';
 for(const t of ['rev-x','rev-x/entpackt','rev-x/entpackt/m1','rev-x/entpackt/m1/S3']){await mkdir(join(rw,t),{recursive:true});await fsChmod(join(rw,t),t==='rev-x'?0o755:0o750);}
 await writeFile(join(rw,rk),'MZ');await fsChmod(join(rw,rk),0o600);
 const gesetzt=[];
 const ops={lstat:fsLstat,chmod:fsChmod,chown:async(p,u,g)=>{gesetzt.push([p.slice(rw.length+1),u,g]);}};
 eq(await ex.reverseEingabeLesbar([join(rw,rk)],rw,ops),null,'E: Rechte gesetzt');
 eq(gesetzt,[['rev-x/entpackt',0,65532],['rev-x/entpackt/m1',0,65532],['rev-x/entpackt/m1/S3',0,65532],[rk,0,65532]],'E: Ordner unter der Eintragswurzel (755 bleibt) und Datei an Gruppe 65532');
 eq(await Promise.all(['rev-x','rev-x/entpackt','rev-x/entpackt/m1','rev-x/entpackt/m1/S3',rk].map(async t=>(await fsStat(join(rw,t))).mode&0o777)),
  [0o755,0o710,0o710,0o710,0o640],'E: Ordner 0710 (betreten, nicht auflisten), Datei 0640');
 eq(await ex.reverseEingabeLesbar([join(rw,'rev-x/entpackt/m9/Y.EXE')],rw,ops),'nicht_gefunden','E: fehlender Ordner');
 await symlink(join(rw,'rev-x/entpackt/m1'),join(rw,'rev-x/entpackt/link'));
 eq(await ex.reverseEingabeLesbar([join(rw,'rev-x/entpackt/link/S3/X.EXE')],rw,ops),'pfad_gefahr','E: Link im Pfad');
 eq(await ex.reverseOrdnerDurchquerbar(rw,join(temp,'anderswo/X.EXE'),ops),'pfad_gefahr','E: Pfad ausserhalb der Wurzel');
 await fsChmod(join(rw,'rev-x/entpackt'),0o750);
 eq(await ex.reverseEingabeLesbar([join(rw,rk)],rw,{...ops,chown:async()=>{throw Object.assign(Error('nein'),{code:'EPERM'});}}),
  'keine_berechtigung:eingabe_rechte','E: chown verweigert -> klarer Fehlercode');
 const leasen=async id=>{
  await pool.query(`UPDATE work_jobs SET state='leased',owner_node=$2,boot_generation=$3::uuid,owner_auth_hash=$4,claim_token=$5::uuid,
   lease_until=clock_timestamp()+interval '5 minutes',resource_domain=$6,attempt=1,updated_at=clock_timestamp() WHERE id=$1`,
   [id,wer.nodeId,wer.bootGeneration,wer.authHash,randomUUID(),'reverse:'+wer.nodeId]);
  return jobs.get(id,'reverse-bibliothek');
 };
 const s3Job=async name=>{
  const d=await datei(name,Buffer.from('MZ-'+name));await vorstufen(d);await anfordern(d,'S3');
  return (await pool.query("SELECT p20_auftrag_id::text AS job FROM reverse_auftraege WHERE datei_id=$1 AND schicht='S3'",[d])).rows[0].job;
 };
 const job3=await s3Job('RECHTE.EXE'),vorher=aufrufe.length;
 lesbarAntwort='keine_berechtigung:eingabe_rechte';
 try{await executor.fuehreAus(fakeLc,wer,await leasen(job3));}finally{lesbarAntwort=null;}
 eq(aufrufe.length,vorher,'E: ohne Eingaberechte kein Runner-Lauf');
 eq(Object.values((await pool.query('SELECT state,error_code FROM work_jobs WHERE id=$1',[job3])).rows[0]),['failed','keine_berechtigung:eingabe_rechte'],'E: Auftrag scheitert mit dem Rechte-Code');
 const job4=await s3Job('MELDUNG.EXE');
 lcAntwort={status:'fehler',fehlercode:'ungueltiger_auftrag',meldung:"[Errno 13] Permission denied: '/bib/x'"};
 const warn=console.warn,zeilen=[];console.warn=(...a)=>{zeilen.push(a.join(' '));};
 try{await executor.fuehreAus(fakeLc,wer,await leasen(job4));}finally{console.warn=warn;lcAntwort=null;}
 ok(zeilen.some(z=>z.includes(job4)&&z.includes('ungueltiger_auftrag')&&z.includes('Permission denied')),'E: Logzeile mit echter Runner-Meldung');
 eq((await pool.query('SELECT state FROM work_jobs WHERE id=$1',[job4])).rows[0].state,'failed','E: Runnerfehler beendet den Work-Job');
 console.log('PASS E Ordnerrechte + Runner-Meldung');
 console.log('P18-T69 S3: '+checks+' Pruefungen, 0 Fehler');
}catch(e){fehler=e;console.error('FAIL',e);}
finally{
 unhook?.();await pipe?.beende?.().catch(()=>{});
 await closePool?.().catch(()=>{});
 if(made)await admin.query('DROP SCHEMA '+schema+' CASCADE').catch(()=>{});
 await admin.end();await rm(temp,{recursive:true,force:true});
}
process.exit(fehler?1:0);
