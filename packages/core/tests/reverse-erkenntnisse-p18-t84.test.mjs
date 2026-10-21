/** P18-T84: reale PG-Guards/Importpfade, CAS/Rechte/Hex/@ref. Nur privates synapse_test-Schema. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',SYNAPSE_INTERN_TOOL:'1',SYNAPSE_REVERSE_BIS_SCHICHT:'S3',QDRANT_URL:'http://127.0.0.1:1'});
const {Pool}=createRequire(new URL('../package.json',import.meta.url))('pg');
const raw=new Pool({connectionString:url.href,max:10}),schema='p18_t84_'+process.pid+'_'+randomUUID().slice(0,8);
const pool={async connect(){const c=await raw.connect();await c.query('SET search_path TO '+schema+',public');return c;},async query(...a){const c=await this.connect();try{return await c.query(...a);}finally{c.release();}}};
const temp=await mkdtemp(join(tmpdir(),'p18-t84-')),root=join(temp,'reverse');
await mkdir(join(root,'_arbeit'),{recursive:true});
Object.assign(process.env,{SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:root});
const P='t84-source',Q='t84-reader',R='rev-t84',sha=v=>createHash('sha256').update(v).digest('hex');
const scoped=new URL(url);scoped.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=scoped.href;
const core=await import('../dist/index.js');
const {mitLesePool}=await import('../dist/db/client.js');
const {fuehreErkenntnisAus}=await import('../dist/services/reverse-erkenntnisse.js');
const {leseReverseEinstellungen}=await import('../dist/services/reverse-einstellungen.js');
const {fuehreHexFormateAus}=await import('../dist/services/hex-formate.js');
const {leseHexEinstellungen}=await import('../dist/services/hex-einstellungen.js');
const {reverseAnalyseFingerabdruck}=await import('../dist/services/reverse-pipeline.js');
const {uebernehmeEErgebnis}=await import('../dist/services/reverse-e-uebernahme.js');
const {ReverseEingang}=await import('../dist/services/reverse-eingang.js');
const {refVergleich}=await import('../dist/services/ref-vergleich.js');
const inDb=fn=>mitLesePool(pool,fn);
const tx=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
const bezug={modus:'neu',standard:'neu',quelle:'standard',bis:null,letzter_fehler:null};
const actor=(project=P,name='writer')=>({art:'legacy',project,agent_id:name});
const context=(p,fn,extra={})=>inDb(()=>core.mitAgentAufrufKontext({principal:p,bezug,...extra},fn));
const user=fn=>core.mitUserHerkunft('web-ui-chat',fn);
const production=()=>JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',"const {leseReverseEinstellungen}=await import('./packages/core/dist/services/reverse-einstellungen.js');const {closePool}=await import('./packages/core/dist/db/client.js');console.log(JSON.stringify((await leseReverseEinstellungen('t84-source','reverse_erkenntnisse')).schalter));await closePool();"],{env:{...process.env,SYNAPSE_INTERN_TOOL:'0'},encoding:'utf8',timeout:10000}).trim());
const call=(action,args={},p=actor(),extra={})=>context(p,()=>fuehreErkenntnisAus(pool,{action,project:p.project,reverse_id:R,...args}),extra);
let checks=0,pipeline;
const eq=(a,b,m)=>{assert.deepEqual(a,b,m);checks++;};
const ok=(x,m)=>{assert.ok(x,m);checks++;};
const reject=async(fn,code)=>{await assert.rejects(fn,e=>[e.kennung,e.code,e.message].filter(Boolean).join(' ').includes(code));checks++;};
const override=async(aktiv=true,expired=false)=>pool.query("INSERT INTO intern_schalter(name,aktiv,modus,bis,grund,gesetzt_von) VALUES('reverse_erkenntnisse',$1,'freigegeben',NOW()+($2*interval '1 second'),'T84','fixture') ON CONFLICT(name) DO UPDATE SET aktiv=EXCLUDED.aktiv,bis=EXCLUDED.bis",[aktiv,expired?-1:600]);
async function switchOn(project=P){
 await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'reverse_erkenntnisse',true,'T84','fixture') ON CONFLICT(ebene,(COALESCE(project,'')),funktion) DO UPDATE SET aktiv=true",[project]);
}
async function eImport(mid,bytes){
 const jobId=randomUUID(),arbeitsWurzel=join(root,'_arbeit',jobId);await mkdir(arbeitsWurzel);await writeFile(join(arbeitsWurzel,'source.bin'),bytes);
 return uebernehmeEErgebnis(pool,{jobId,reverseId:R,mediumId:mid,arbeitsWurzel,manifest:[{pfad:'source.bin',groesse:bytes.length,sha256:sha(bytes),art:'binaer'}]},{konfiguration:cfg});
}
const cfg=core.ladeAssetKonfiguration({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:root});
const snapshot=async()=>JSON.stringify((await pool.query("SELECT row_to_json(r) AS wurzel,(SELECT jsonb_agg(to_jsonb(v) ORDER BY version) FROM reverse_verweis_versionen v WHERE v.verweis_id=r.id) AS versionen FROM reverse_verweise r WHERE ursprung='manuell' ORDER BY r.id")).rows);
try{
 await raw.query('CREATE SCHEMA '+schema);
 for(const t of ['projects','agent_sessions','agent_identitaeten','agent_profil_schalter','intern_schalter','tool_aktivitaet','plan_tasks','thoughts','asset_upload_sitzungen','code_symbols'])await pool.query('CREATE TABLE '+t+' (LIKE public.'+t+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 for(const file of ['work-jobs-schema','reverse-schema','reverse-pipeline-schema','reverse-eingang-schema','reverse-verknuepfungen-schema','reverse-code-stuecke-schema','hex-schema','hex-formate-schema','reverse-erkenntnisse-schema','reverse-einstellwerte-schema']){
  const mod=await import('../dist/db/'+file+'.js'),sql=Object.values(mod).find(x=>typeof x==='string');
  await pool.query(sql);await pool.query(sql);
 }
 for(const [t,c]of [['reverse_eintraege','creator_identity_id'],['reverse_eintraege','confirmer_identity_id'],['reverse_bindungen','binder_identity_id'],['reverse_auftraege','trigger_identity_id']])await pool.query('ALTER TABLE '+t+' ADD COLUMN IF NOT EXISTS '+c+' TEXT');
 for(const project of [P,Q]){
  await pool.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,'fixture','/synthetic/t84',true)",[project]);
  await pool.query("INSERT INTO agent_sessions(id,project,status) VALUES($1,$2,'active')",[project==='t84-source'?'writer':'reader',project]);
 }
 await pool.query("INSERT INTO reverse_eintraege(id,titel,status,analyse_policy) VALUES($1,'T84 fixture','bestaetigt','{\"automatisch\":false}')",[R]);
 const mid=(await pool.query("INSERT INTO reverse_medien(eintrag_id,position,art,status) VALUES($1,0,'ordner','vollstaendig') RETURNING id::text",[R])).rows[0].id;
 for(const p of [P,Q])await pool.query("INSERT INTO reverse_bindungen(project,eintrag_id,gebunden_von) VALUES($1,$2,'fixture')",[p,R]);
 const bytes=Buffer.from('T84 source bytes for preservation evidence and gfx/tree.dat');
 eq((await eImport(mid,bytes)).dateien,1,'initial real E import');
 const source=(await pool.query('SELECT id::text,pfad,sha256 FROM reverse_dateien WHERE eintrag_id=$1',[R])).rows[0];
 pipeline=new core.ReversePipelineDienst({pool,konfiguration:cfg,ausfuehrbareKinds:[]});
 const input={titel:'Pinned evidence',kategorie:'format',idempotency_key:'first',inhalt:{text:'Stable original evidence',status:'aktiv',aussagen:[{schluessel:'bytes',text:'First three bytes identify the fixture',konfidenz:'belegt',begruendung:'Read source bytes',belege:['b1']}],belege:[{id:'b1',reverse_id:R,pfad:source.pfad,sha256:source.sha256,art:'bytes',offset:'0',laenge:'3'}],ziele:[]}};
 await reject(()=>call('erkenntnis_liste'),'erkenntnisse_deaktiviert');
 await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,'alle',true,'T84','fixture')");
 await reject(()=>call('erkenntnis_liste'),'erkenntnisse_deaktiviert');
 await override();eq(production().aktiv,false,'production process ignores internal override');
 eq((await call('erkenntnis_liste')).erkenntnisse,[],'internal override works');
 await override(true,true);await reject(()=>call('erkenntnis_liste'),'erkenntnisse_deaktiviert');
 await override(false);await switchOn();await reject(()=>call('erkenntnis_liste'),'erkenntnisse_deaktiviert');
 eq(production().aktiv,true,'product switch persists across restart and ignores debug OFF');
 await override(false,true);await switchOn(Q);
 eq((await call('erkenntnis_liste')).erkenntnisse,[],'production switch ignores debug override');
 const first=(await call('erkenntnis_speichern',input)).erkenntnis,id=first.verweis_id;
 eq(first.version,1,'first version');eq((await call('erkenntnis_speichern',input)).erkenntnis.canonical_hash,first.canonical_hash,'identical retry');
 await reject(()=>call('erkenntnis_speichern',{...input,titel:'Different'}),'erkenntnis_idempotenzkonflikt');
 const next={...input,verweis_id:id,basis_version:1,idempotency_key:'race',titel:'Second version'};
 const race=await Promise.allSettled([call('erkenntnis_speichern',next),call('erkenntnis_speichern',{...next,idempotency_key:'race-other',titel:'Other author'},actor(P,'second'))]);
 eq(race.filter(x=>x.status==='fulfilled').length,1,'one CAS winner');
 ok(race.some(x=>x.status==='rejected'&&x.reason.kennung==='erkenntnis_versionskonflikt'),'other author gets conflict');
 eq((await call('erkenntnis_get',{verweis_id:id,version:1})).erkenntnis.canonical_hash,first.canonical_hash,'v1 pinned');
 const second=(await call('erkenntnis_get',{verweis_id:id,version:2})).erkenntnis;
 eq((await call('erkenntnis_get',{verweis_id:id,version:1},actor(Q,'reader'))).erkenntnis.canonical_hash,first.canonical_hash,'bound other project reads');
 await reject(()=>call('erkenntnis_speichern',{...input,idempotency_key:'visa'},actor(),{fremdprojekt:{project:P,heimat:Q,zugang:'visum',identity_id:randomUUID()}}),'visum_nur_lesen');
 await pool.query('UPDATE reverse_bindungen SET geloest_at=NOW() WHERE project=$1',[Q]);
 await reject(()=>call('erkenntnis_get',{verweis_id:id,version:1},actor(Q,'reader')),'nicht_gebunden');
 await pool.query("INSERT INTO reverse_bindungen(project,eintrag_id,gebunden_von) VALUES($1,$2,'fixture')",[Q,R]);
 for(const [key,mutate,error]of [
  ['hash',x=>x.belege[0].sha256='0'.repeat(64),'erkenntnis_quellstand_abweichend'],
  ['range',x=>x.belege[0].laenge='999999','erkenntnis_bereich_ungueltig'],
  ['path',x=>x.belege[0].pfad='../x','erkenntnis_pfad_ungueltig'],
  ['unknown',x=>x.command='do something','erkenntnis_feld_unbekannt'],
  ['proof',x=>x.aussagen[0].belege=['missing'],'erkenntnis_aussage_ungueltig']
 ]){
  const inhalt=structuredClone(input.inhalt);mutate(inhalt);await reject(()=>call('erkenntnis_speichern',{...input,inhalt,idempotency_key:key}),error);
 }
 const review={...input,verweis_id:id,basis_version:2,idempotency_key:'review',inhalt:{...input.inhalt,review:{status:'geprueft',grund:'Fixture reviewed'}}};
 await reject(()=>call('erkenntnis_speichern',review),'keine_berechtigung');
 const reviewed=await user(()=>call('erkenntnis_speichern',review));eq(reviewed.erkenntnis.inhalt.review.autor,'legacy:'+P+':writer','review author comes from context');
 for(const rolle of ['main','koordinator']){
  const identity_id=randomUUID(),agent_id='review-'+rolle;
  await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,erstellt_von) VALUES($1,$2,$3,$3,$4,'fixture')",[identity_id,P,agent_id,rolle]);
  const p={art:'identity',project:P,identity_id,agent_id,rolle,modell:null,context_epoch:1,lauf_id:null};
  const r=await call('erkenntnis_speichern',{...input,idempotency_key:'review-'+rolle,inhalt:review.inhalt},p);
  eq(r.erkenntnis.inhalt.review.autor,'identity:'+identity_id,rolle+' may review');
 }
 // Review A1: two projects, but only the author is bound to the foreign source.
 const B='rev-t84-private-source',group='review-a1',secret='Foreign source details';
 await pool.query("INSERT INTO reverse_eintraege(id,titel,status) VALUES($1,'Private source','bestaetigt')",[B]);
 const bm=(await pool.query("INSERT INTO reverse_medien(eintrag_id,position,art,status) VALUES($1,0,'ordner','vollstaendig') RETURNING id",[B])).rows[0].id;
 const bsha=sha('foreign bytes');
 await pool.query("INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,groesse,sha256,art,status) VALUES($1,$2,'private.bin',13,$3,'binaer','offen')",[B,bm,bsha]);
 await pool.query("INSERT INTO reverse_bindungen(project,eintrag_id,gebunden_von) VALUES($1,$2,'fixture')",[P,B]);
 const note={text:'Local hypothesis',status:'aktiv',aussagen:[{schluessel:'hypothesis',text:'Local hypothesis',konfidenz:'vermutet',begruendung:'Open question',belege:[]}],belege:[],ziele:[]};
 const saveNote=(key,titel,extra={})=>call('erkenntnis_speichern',{titel,kategorie:group,idempotency_key:key,inhalt:structuredClone(note),...extra});
 const publicBefore=(await saveNote('a1-before','Public before')).erkenntnis;
 const hist=(await saveNote('a1-history','Local v1')).erkenntnis;
 const foreignBeleg={id:'foreign',reverse_id:B,pfad:'private.bin',sha256:bsha,art:'bytes',offset:'0',laenge:'3'};
 const privateV2=(await saveNote('a1-history-v2',secret,{verweis_id:hist.verweis_id,basis_version:1,inhalt:{...note,text:secret,belege:[foreignBeleg]}})).erkenntnis;
 await saveNote('a1-history-v3','Local v3',{verweis_id:hist.verweis_id,basis_version:2});
 await saveNote('a1-history-v4',secret,{verweis_id:hist.verweis_id,basis_version:3,inhalt:{...note,text:secret,ziele:[{art:'reverse_datei',reverse_id:B,pfad:'private.bin',sha256:bsha}]}});
 const publicAfter=(await saveNote('a1-after','Public after')).erkenntnis;
 const qargs={kategorie:group,limit:1},reader=actor(Q,'reader');
 const page1=await call('erkenntnis_liste',qargs,reader);
 eq(page1.erkenntnisse.map(x=>x.verweis_id),[publicBefore.verweis_id],'A1 first visible list page');
 const page2=await call('erkenntnis_liste',{...qargs,liste_nach:page1.liste_nach},reader);
 eq(page2.erkenntnisse.map(x=>x.verweis_id),[publicAfter.verweis_id],'A1 hidden row does not consume page size');
 eq(page2.liste_nach,null,'A1 visible pagination ends');
 eq((await call('erkenntnis_liste',{kategorie:group})).erkenntnisse.length,3,'A1 author bound to both sees all rows');
 eq((await call('erkenntnis_liste',{kategorie:group,query:secret},reader)).erkenntnisse,[],'A1 search hides inaccessible metadata');
 const h1=await call('erkenntnis_get',{verweis_id:hist.verweis_id,historie:true,limit:1},reader);
 const h2=await call('erkenntnis_get',{verweis_id:hist.verweis_id,historie:true,limit:1,offset:h1.naechster_offset},reader);
 eq(h1.versionen.map(x=>x.version),[3],'A1 history skips foreign target version');
 eq(h2.versionen.map(x=>x.version),[1],'A1 history skips foreign source version');
 eq(h2.naechster_offset,null,'A1 history ends after visible versions');
 eq((await call('erkenntnis_get',{verweis_id:hist.verweis_id,historie:true})).versionen.map(x=>x.version),[4,3,2,1],'A1 author sees complete history');
 for(const response of [page1,page2,h1,h2])for(const hidden of [B,'private.bin',secret,bsha,privateV2.canonical_hash])ok(!JSON.stringify(response).includes(hidden),'A1 no foreign metadata '+hidden.slice(0,12));
 await reject(()=>call('erkenntnis_get',{verweis_id:hist.verweis_id,version:2},reader),'nicht_gebunden');
 await reject(()=>call('erkenntnis_get',{verweis_id:hist.verweis_id,version:4},reader),'nicht_gebunden');
 await pool.query("INSERT INTO reverse_bindungen(project,eintrag_id,gebunden_von) VALUES($1,$2,'fixture')",[Q,B]);
 eq((await call('erkenntnis_liste',{kategorie:group},reader)).erkenntnisse.length,3,'A1 binding makes row visible');
 await pool.query('UPDATE reverse_bindungen SET geloest_at=NOW() WHERE project=$1 AND eintrag_id=$2',[Q,B]);
 eq((await call('erkenntnis_liste',{kategorie:group},reader)).erkenntnisse.length,2,'A1 revoked binding hides only affected row');

 // Review A2: immutable knowledge without files blocks source/target merge and split.
 const K='rev-t84-knowledge-only',T='rev-t84-empty-target';
 await pool.query("INSERT INTO reverse_eintraege(id,titel,status) VALUES($1,'Knowledge only','bestaetigt'),($2,'Empty target','bestaetigt')",[K,T]);
 await pool.query("INSERT INTO reverse_bindungen(project,eintrag_id,gebunden_von) VALUES($1,$2,'fixture')",[P,K]);
 const kms=(await pool.query("INSERT INTO reverse_medien(eintrag_id,position,art,status) VALUES($1,0,'ordner','vollstaendig'),($1,1,'ordner','vollstaendig') RETURNING id::text",[K])).rows;
 const knowledge=(await saveNote('a2-knowledge','Without files',{reverse_id:K})).erkenntnis;
 eq((await pool.query('SELECT count(*)::int n FROM reverse_dateien WHERE eintrag_id=$1',[K])).rows[0].n,0,'A2 fixture has no files');
 const unchanged=await snapshot(),medienBefore=(await pool.query('SELECT id,eintrag_id,position FROM reverse_medien ORDER BY id')).rows;
 const service=core.createReverseToolService({pool});
 const confirm=extra=>user(()=>inDb(()=>service.ausfuehren({action:'bestaetigen',project:P,agent_id:'user',...extra})));
 for(const args of [
  {reverse_id:K,zusammenfuehren_mit:T},
  {reverse_id:T,zusammenfuehren_mit:K},
  {reverse_id:K,aufteilen:[{titel:'Part A',medien:[kms[0].id]},{titel:'Part B',medien:[kms[1].id]}]}
 ]){
  const r=await confirm(args);eq(r.fehlercode,'ziel_belegt','A2 grouping blocked');eq(r.fehler,'gruppierung_manuelle_erkenntnisse','A2 clear reason');
  ok(r.hinweis.includes('manuelle Erkenntnisse'),'A2 actionable explanation');
  eq(await snapshot(),unchanged,'A2 roots and every version remain byte-identical');
  eq((await pool.query('SELECT id,eintrag_id,position FROM reverse_medien ORDER BY id')).rows,medienBefore,'A2 media not moved');
 }
 eq((await pool.query('SELECT status FROM reverse_eintraege WHERE id=$1',[K])).rows[0].status,'bestaetigt','A2 entry remains writable');
 eq((await saveNote('a2-after','Still editable',{reverse_id:K,verweis_id:knowledge.verweis_id,basis_version:1})).erkenntnis.version,2,'A2 version can still be appended after blocked grouping');
 // Every DB mutation guard is exercised independently, with transaction rollback.
 const before=await snapshot();
 for(const sql of [
  "DELETE FROM reverse_verweise",
  "UPDATE reverse_verweise SET kind=kind WHERE ursprung='manuell'",
  'DELETE FROM reverse_verweis_versionen',
  'UPDATE reverse_verweis_versionen SET titel=titel',
  'TRUNCATE reverse_verweise CASCADE',
  'TRUNCATE reverse_verweis_versionen'
 ])await reject(()=>pool.query(sql),'reverse_erkenntnis');
 eq(await snapshot(),before,'DB guards preserve every byte of root and history');
 await reject(()=>pool.query("INSERT INTO reverse_verweis_versionen(verweis_id,version,titel,kategorie,inhalt,canonical_hash,anfrage_id,autor,quellprojekt) VALUES($1,99,'bad','bad','{}',$2,'gap','fixture',$3)",[id,'0'.repeat(64),P]),'reverse_erkenntnis_versionskonflikt');
 // S1 materializer is the real importer, not a SQL imitation. Two revisions replace only analysis rows.
 const s1=async marker=>{
  const version=marker,fp=reverseAnalyseFingerabdruck(source.sha256,'S1','asset-inspektoren',version,'fixture');
  await pool.query("UPDATE reverse_schichten SET aktuell=false WHERE datei_id=$1 AND schicht='S1' AND aktuell",[source.id]);
  await pool.query("INSERT INTO reverse_schichten(datei_id,schicht,fingerabdruck,aktuell,status,werkzeug) VALUES($1,'S1',$2,true,'fertig','fixture')",[source.id,fp]);
  const job={id:randomUUID(),datei_id:source.id,eintrag_id:R,schicht:'S1',fingerabdruck:fp,werkzeug:'asset-inspektoren',werkzeug_version:version,profil_version:'fixture',lease_token:randomUUID()};
  await inDb(()=>tx(db=>pipeline.materialisiere(db,job,{status:'fertig',dauer_ms:1,metadata:{},strings:['gfx/'+marker+'.dat'],result:{format:'pe',asset_type:'executable',metadata:{bits:32,architektur:'x86'},objects:[],references:[{kind:'library',target:marker+'.dll'}]}})));
 };
 await s1('old');await s1('new');
 eq(await snapshot(),before,'S1 rerun keeps manual root and all versions');
 const refs=(await pool.query("SELECT target FROM reverse_verweise WHERE ursprung='analyse' ORDER BY target")).rows.map(x=>x.target);
 ok(refs.includes('new.dll')&&!refs.includes('old.dll'),'S1 rerun replaces analysis references');
 eq((await eImport(mid,bytes)).dateien,1,'real E rerun imported existing target');
 eq(await snapshot(),before,'E rerun preserves all manual versions');
 const s3=async(maxPgBytes,marker)=>{
  const jobId=randomUUID(),fp=sha(jobId),arbeitsWurzel=join(root,'_arbeit',jobId);await mkdir(arbeitsWurzel);
  await pool.query("INSERT INTO reverse_auftraege(id,eintrag_id,datei_id,schicht,prioritaet,status,ausloeser,ausfuehrung,fingerabdruck,ziel_schicht,projekt,werkzeug,werkzeug_version,profil_version) VALUES($1,$2,$3,'S3','interaktiv','wartet','fixture','container',$4,'S3',$5,'reverse-S3','fixture','fixture')",[jobId,R,source.id,fp,P]);
  const values={'functions.jsonl':JSON.stringify({name:'Fixture',address_offset:4096,size:16,prototype:'void Fixture()',decompile_status:'ok',decompiled:'void Fixture(){ '+marker+'(); }'})+'\n','s1-rz-strings.json':JSON.stringify([{vaddr:5000,string:'gfx/'+marker+'.dat',size:16}]),'s1-rz-imports.json':'[]','s1-rz-symbols.json':'[]','normalisierer-status.json':'{"status":"fertig"}'};
  const manifest=[];for(const [pfad,text]of Object.entries(values)){await writeFile(join(arbeitsWurzel,pfad),text);manifest.push({pfad,sha256:sha(text),groesse:Buffer.byteLength(text)});}
  const e={jobId,reverseId:R,dateiId:source.id,arbeitsWurzel,manifest};
  return {e,result:await inDb(()=>tx(db=>core.uebernehmeS3Ergebnis(db,e,{konfiguration:cfg,maxPgBytes})))};
 };
 await s3(100000,'first');await s3(100000,'second');
 eq(await snapshot(),before,'S3 rerun + raw normalizer preserve all manual versions');
 const pending=await s3(1,'catchup');eq(pending.result.gespeichert,0,'low budget creates real catch-up need');
 const caught=await inDb(()=>tx(db=>core.uebernehmeS3Ergebnis(db,pending.e,{konfiguration:cfg,maxPgBytes:100000,nachzug:true})));
 eq(caught.gespeichert,1,'real retained-artifact catch-up imports function');
 eq(await snapshot(),before,'catch-up preserves manual history');
 await new ReverseEingang({db:pool,konfiguration:cfg}).aktualisieren(R);
 eq(await snapshot(),before,'entry re-evaluation preserves manual history');
 // File lifecycle does not own manual knowledge; cascading index cleanup leaves it intact.
 await pool.query('DELETE FROM reverse_auftraege WHERE datei_id=$1',[source.id]);
 await pool.query('DELETE FROM reverse_dateien WHERE id=$1',[source.id]);
 eq(await snapshot(),before,'file cascade cannot erase manual history');
 const historic=await call('erkenntnis_speichern',{...input,verweis_id:id,basis_version:3,idempotency_key:'historical',inhalt:{...input.inhalt,status:'korrigiert',grund:'Historical evidence retained'}});
 eq(historic.erkenntnis.version,4,'unchanged historical proof remains usable after file replacement');
 // Exact Hex version grants, same central reader for list/get/base/cursor.
 const hex=async(project,action,args={})=>context(actor(project),async()=>{
  const stand=await leseHexEinstellungen(project);stand.formate_schalter={aktiv:true,quelle:'standard',bis:null,letzter_fehler:null};
  return fuehreHexFormateAus(project,{action,...args},stand);
 });
 const definition={profil:'kaitai-read-v1',meta:{id:'t84_fixture',endian:'le'},seq:[{id:'head',type:'u1'}]};
 const format=await hex(P,'format_speichern',{format:definition,herkunft:{reverse_id:R}});
 await reject(()=>hex(Q,'format_liste',{format_id:format.format_id,format_version:1,mit_format:true}),'format_nicht_gefunden');
 const attach={verweis_id:id,basis_version:4,idempotency_key:'attach',format_id:format.format_id,format_version:1,canonical_hash:format.canonical_hash};
 await reject(()=>call('format_anhaengen',attach),'keine_berechtigung');
 const attached=await user(()=>call('format_anhaengen',attach));eq(attached.erkenntnis.version,5,'grant and new knowledge version atomic');
 eq((await hex(Q,'format_liste',{format_id:format.format_id,format_version:1,mit_format:true})).canonical_hash,format.canonical_hash,'bound project reads exact scoped format');
 eq((await hex(Q,'format_liste',{format_id:format.format_id})).formate.length,1,'list does not duplicate scoped grants');
 const f2=await hex(P,'format_speichern',{format_id:format.format_id,basis_version:1,format:definition,herkunft:{reverse_id:R}});
 await reject(()=>hex(Q,'format_liste',{format_id:f2.format_id,format_version:2,mit_format:true}),'format_nicht_gefunden');
 const privateOther=await hex(Q,'format_speichern',{format:definition,herkunft:{reverse_id:R}});
 await reject(()=>user(()=>call('format_anhaengen',{...attach,basis_version:5,idempotency_key:'foreign',format_id:privateOther.format_id,canonical_hash:privateOther.canonical_hash})),'erkenntnis_ziel_nicht_lesbar');
 const cursor=randomUUID();
 await pool.query("INSERT INTO hex_format_cursor(id,project,akteur,format_id,format_version,canonical_hash,ref,zustand,expires_at) VALUES($1,$2,$3,$4,1,$5,'{}','{}',NOW()+interval '1 hour')",[cursor,Q,'legacy:'+Q+':writer',format.format_id,format.canonical_hash]);
 await pool.query('UPDATE reverse_bindungen SET geloest_at=NOW() WHERE project=$1',[Q]);
 await reject(()=>hex(Q,'format_anwenden',{cursor}),'format_nicht_gefunden');
 await reject(()=>hex(Q,'format_liste',{format_id:format.format_id,format_version:1,mit_format:true}),'format_nicht_gefunden');
 eq((await call('erkenntnis_get',{verweis_id:id,version:1})).erkenntnis.version,1,'historical knowledge unchanged by format append');
 const original=await context(actor(),()=>refVergleich({project:P,file_path:'fixture.ts',content:'// '+first.ref+'\nfunction use(){}',agent_id:'writer'},{db:{query:async()=>({rows:[{line_start:1,value:'// '+first.ref}]})},reverse:a=>call(a.action,a)}));
 eq(original.vergleiche[0].original.version,1,'@ref resolves exact v1 after v5 without function lookup');
 // Binding recheck occurs before every exact read.
 await pool.query('UPDATE reverse_bindungen SET geloest_at=NOW() WHERE project=$1',[P]);
 await reject(()=>call('erkenntnis_get',{verweis_id:id,version:1}),'nicht_gebunden');
 console.log('T84 PASS '+checks+' checks: DB guards, version/CAS/idempotency, bindings/visa/review, source validation, real S1/E/S3 reruns + normalizer + catch-up + entry re-evaluation, file cascade, scoped Hex versions, pinned @ref');
}finally{
 await pipeline?.beende();await raw.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await raw.end();await core.closePool();await rm(temp,{recursive:true,force:true});
}
