/** RV30: real S3 references, canonical graph, both directions and current file list. Only private schema in synapse_test:5433. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
process.env.SYNAPSE_INTERN_TOOL='1'; // Start-time flag; production fallback is tested in a separate process.
process.env.SYNAPSE_AUTH_DISABLED='1';process.env.PARSER_LOOP_DISABLED='1';
process.env.SYNAPSE_SKIP_EMBEDDINGS='1';process.env.SYNAPSE_REVERSE_BIS_SCHICHT='S3';
const temp=await mkdtemp(join(tmpdir(),'p18-rv30-')),root=join(temp,'reverse');
Object.assign(process.env,{SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:root});
await mkdir(join(root,'_arbeit'),{recursive:true});
const {Pool}=createRequire(new URL('../package.json',import.meta.url))('pg');
const raw=new Pool({connectionString:url.href,max:3});
const schema='p18_rv30_'+process.pid+'_'+randomUUID().slice(0,8),project='p18_rv30',agent='p18_rv30-agent',rid='rev-p18-rv30';
let profileReal=false;
const pool={async connect(){const c=await raw.connect();
 if(process.env.P18_RV30_PROFILE&&!c.rv30Profile){
  const original=c.query.bind(c);c.rv30Profile=true;
  c.query=async(...args)=>{const started=Date.now(),sql=typeof args[0]==='string'?args[0]:args[0]?.text;
   if(profileReal&&sql?.startsWith('WITH kandidaten')){
    const plan=await original({text:'EXPLAIN (FORMAT JSON) '+sql,values:args[0].values});
    console.log('RV30_EXPLAIN '+JSON.stringify(plan.rows));
   }
   try{return await original(...args);}finally{const ms=Date.now()-started;if(ms>100&&/^(SELECT|WITH)/.test(sql))console.log('RV30_SQL '+JSON.stringify({ms,sql}));}};
 }
 await c.query('SET search_path TO '+schema+',public');return c;},
 async query(...a){const c=await this.connect();try{return await c.query(...a);}finally{c.release();}}};
const tx=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const v=await fn(c);await c.query('COMMIT');return v;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
const sha=v=>createHash('sha256').update(v).digest('hex');
let checks=0,made=false;
const eq=(a,b,m)=>{assert.deepEqual(a,b,m);checks++;},ok=(v,m)=>{assert.ok(v,m);checks++;};
const secret='SyntheticSecret987654321';
try{
 await raw.query('CREATE SCHEMA '+schema);made=true;
 for(const table of ['projects','agent_sessions','tool_aktivitaet','code_files','tool_calls'])await pool.query('CREATE TABLE '+schema+'.'+table+' (LIKE public.'+table+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 const scoped=new URL(url);scoped.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=scoped.href;
 const core=await import('../dist/index.js');
 const {mitLesePool}=await import('../dist/db/client.js');
 const {leseReverseEinstellungen,fuehreReverseAdminAus}=await import('../dist/services/reverse-einstellungen.js');
 const {REVERSE_VERKNUEPFUNGEN_SCHEMA_SQL}=await import('../dist/db/reverse-verknuepfungen-schema.js');
 await pool.query(REVERSE_VERKNUEPFUNGEN_SCHEMA_SQL);await pool.query(REVERSE_VERKNUEPFUNGEN_SCHEMA_SQL);
 for(const table of ['agent_profil_schalter','intern_schalter'])await pool.query('CREATE TABLE '+table+' (LIKE public.'+table+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 await pool.query('CREATE TABLE agent_identitaeten(id TEXT PRIMARY KEY,project TEXT,rolle TEXT,status TEXT)');
 const inDb=fn=>mitLesePool(pool,fn);
 const admin=(args,wer={art:'user'})=>inDb(()=>fuehreReverseAdminAus({project,...args},wer));
 const {REVERSE_SCHEMA_SQL}=await import('../dist/db/reverse-schema.js');
 const {REVERSE_PIPELINE_SCHEMA_SQL}=await import('../dist/db/reverse-pipeline-schema.js');
 await pool.query(REVERSE_SCHEMA_SQL);
 // P18-T84: current schema for origin filters; no production migration from this fixture.
 await pool.query((await import('../dist/db/hex-formate-schema.js')).HEX_FORMATE_SCHEMA_SQL);
 await pool.query((await import('../dist/db/reverse-erkenntnisse-schema.js')).REVERSE_ERKENNTNISSE_SCHEMA_SQL);await pool.query(REVERSE_PIPELINE_SCHEMA_SQL);
 for(const [t,c]of [['reverse_eintraege','creator_identity_id'],['reverse_eintraege','confirmer_identity_id'],['reverse_bindungen','binder_identity_id'],['reverse_auftraege','trigger_identity_id']])await pool.query('ALTER TABLE '+t+' ADD COLUMN IF NOT EXISTS '+c+' TEXT');
 await pool.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,'fixture','/synthetic/p18_rv30',true)",[project]);
 await pool.query("INSERT INTO agent_sessions(id,project,status) VALUES($1,$2,'active')",[agent,project]);
 await pool.query("INSERT INTO reverse_eintraege(id,titel,status) VALUES($1,'REA fixture','bestaetigt')",[rid]);
 const mid=(await pool.query("INSERT INTO reverse_medien(eintrag_id,position,art,status) VALUES($1,0,'image','vollstaendig') RETURNING id::text id",[rid])).rows[0].id;
 const service=core.createReverseToolService({pool,runtime:{containerStatus:async()=>({zustand:'ruht',kaltstart_s:null}),analysieren:async()=>({status:'wartet',auftrag_id:randomUUID()})}});
 const binding=await service.ausfuehren({action:'binden',project,agent_id:agent,reverse_id:rid});ok(binding.success,'binding');
 const call=(action,args={})=>inDb(()=>service.ausfuehren({action,project,agent_id:agent,reverse_id:rid,...args}));
 const prepare=async(name,text,maxPgBytes,sidecars)=>{
  const did=(await pool.query("INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,sha256,groesse,art,status,format,arch,bits) VALUES($1,$2,$3,$4,1,'binaer','fertig','pe','x86',32) RETURNING id::text id",[rid,mid,name,sha(name)])).rows[0].id;
  const job=randomUUID(),fp=sha(name+job),work=join(root,'_arbeit',job);
  await pool.query("INSERT INTO reverse_auftraege(id,eintrag_id,datei_id,schicht,prioritaet,status,ausloeser,ausfuehrung,fingerabdruck,ziel_schicht,projekt,werkzeug,werkzeug_version,profil_version) VALUES($1,$2,$3,'S3','interaktiv','wartet','fixture','container',$4,'S3',$5,'reverse-S3','fixture','fixture')",[job,rid,did,fp,project]);
  await mkdir(work);await writeFile(join(work,'functions.jsonl'),text);
  const e={jobId:job,reverseId:rid,dateiId:did,arbeitsWurzel:work,manifest:[{pfad:'functions.jsonl',sha256:sha(text),groesse:Buffer.byteLength(text)}]};
  if(sidecars){
   await pool.query("INSERT INTO reverse_schichten(datei_id,schicht,fingerabdruck,aktuell,status,werkzeug) VALUES($1,'S1',$2,true,'fertig','fixture')",[did,sha('s1:'+name)]);
   for(const [p,content]of Object.entries(sidecars)){
    await writeFile(join(work,p),content);e.manifest.push({pfad:p,sha256:sha(content),groesse:Buffer.byteLength(content)});
   }
  }
  const result=await tx(db=>core.uebernehmeS3Ergebnis(db,e,maxPgBytes===undefined?{}:{maxPgBytes}));
  return {did,e,result,name};
 };
 const aus=await call('verknuepfungen');eq(aus.status,'aus','product standard OFF');eq(aus.links,[],'old behavior OFF');
 await call('loesen');eq((await call('verknuepfungen')).fehlercode,'nicht_gebunden','binding before any content');await call('binden');
 const akt=(rolle,projectId=project)=>({art:'identitaet',principal:{art:'identity',identity_id:'rv30-'+rolle,project:projectId,rolle}});
 for(const rolle of ['main','koordinator','subagent'])await pool.query("INSERT INTO agent_identitaeten VALUES($1,$2,$3,'aktiv')",['rv30-'+rolle,project,rolle]);
 for(const rolle of ['user','main','koordinator']){
  const r=await admin({modus:'setzen',ebene:'projekt',reverse_werte:{max_limit:123},grund:'RV30 rights fixture'},rolle==='user'?{art:'user'}:akt(rolle));ok(r.success,'settings actor '+rolle);
 }
 eq((await admin({modus:'setzen',reverse_werte:{max_limit:12},grund:'RV30 denied'},akt('subagent'))).error,'recht_fehlt','foreign role denied');
 eq((await admin({modus:'status'},akt('main','another'))).error,'recht_fehlt','foreign main denied');
 eq((await admin({modus:'setzen',reverse_werte:{konfidenz_prozent:101},grund:'RV30 invalid'})).error,'reverse_wert_ungueltig','threshold validation');
 let settings=await inDb(()=>leseReverseEinstellungen(project));eq(settings.werte.max_limit.wert,123,'persistent setting');eq(settings.werte.max_limit.quelle,'projekt','source');
 await admin({modus:'entfernen',reverse_namen:['max_limit'],grund:'RV30 reset'});eq((await inDb(()=>leseReverseEinstellungen(project))).werte.max_limit.quelle,'standard','remove override');
 await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'reverse_verknuepfungen',true,'RV30 fixture','fixture')",[project]);
 const target=async path=>(await pool.query("INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,art,status) VALUES($1,$2,$3,'binaer','fertig') RETURNING id::text",[rid,mid,path])).rows[0].id;
 const gfx1=await target('CD1/GFX/0001.dat'),gfx2=await target('CD1/gfx/0012.dat'),snd=await target('CD1/SND/0001.dat'),falseName=await target('CD1/gfx/abc.dat');
 const rows=[
  {name:'entry',address_offset:4096,size:32,prototype:'void entry()',decompiled:'void entry() { LoadGfx(); }',decompile_status:'ok',callees:[{name:'LoadGfx',address_offset:8192}]},
  {name:'LoadGfx',address_offset:8192,size:32,prototype:'void LoadGfx()',decompiled:'void LoadGfx() {}',decompile_status:'ok',callees:[{name:'entry',address_offset:4096}],
   references:[{name:'s_pattern',address_offset:32768,from_offset:8196,kind:'string',value:'gfx\\%04d.dat'},
    {name:'s_group',address_offset:32784,from_offset:8200,kind:'string',value:'.\\Gfx'},
    {name:'s_random',address_offset:32800,from_offset:8204,kind:'string',value:'random text data'},
    {name:'s_secret',address_offset:32816,from_offset:8208,kind:'string',value:'password = "'+secret+'"'}]},
  {name:'BrokenSound',address_offset:12288,size:32,prototype:'void BrokenSound()',decompiled:'',decompile_status:'fixture failure',assembly:'00003000 RET\n',
   references:[{name:'s_snd',address_offset:32832,from_offset:12290,kind:'string',value:'.\\Snd'}]},
 ];
 const fixture=await prepare('game.exe',rows.map(JSON.stringify).join('\n')+'\n');
 const all=await call('verknuepfungen');ok(all.success,JSON.stringify(all));eq(all.status,'fertig','query finished');
 const patterned=all.links.find(x=>x.muster==='gfx/%04d.dat');ok(patterned,'format reference');eq(patterned.funktion.name,'LoadGfx','actual source function');
 eq(patterned.ziele.map(x=>x.datei_id),[gfx1,gfx2],'case and slash normalized, digits only');
 ok(patterned.aufrufer.some(x=>x.name==='entry'&&x.tiefe===1),'reverse callers');ok(patterned.aufrufer.length<3,'cycle bounded');
 const broken=all.links.find(x=>x.muster==='snd');eq(broken.funktion.name,'BrokenSound','S2 fallback source by machine address');
 eq(broken.ziele.map(x=>x.datei_id),[snd],'directory group');
 const backwards=await call('verknuepfungen',{datei:'CD1/GFX/0001.dat'});ok(backwards.links.some(x=>x.funktion?.name==='LoadGfx'),'file -> function');
 const forwards=await call('verknuepfungen',{funktion:patterned.funktion.id});ok(forwards.links.some(x=>x.ziele.some(z=>z.datei_id===gfx1)),'function -> files');
 const ancestor=await call('verknuepfungen',{funktion:'entry'});ok(ancestor.links.some(x=>x.funktion?.name==='LoadGfx'),'caller -> indirect file');
 const group=await call('verknuepfungen',{gruppe:'gfx'});ok(group.links.length>0&&group.links.every(x=>x.ziele.every(z=>/\/gfx\//i.test(z.pfad))),'group case insensitive');
 const ext=await call('verknuepfungen',{gruppe:'.dat'});ok(ext.links.length>=2,'extension filter');
 ok(!all.links.some(x=>x.string.includes('random'))&&!JSON.stringify(all).includes(secret),'no random word and secret links');
 eq(all.provenance.untrusted_content,true,'target content marked');eq(all.provenance.felder,['links[]'],'provenance covers links');
 const one=await call('verknuepfungen',{limit:1});eq([one.links.length,one.gekappt,one.naechster_offset],[1,true,1],'paging');
 eq((await call('verknuepfungen',{limit:1,offset:1})).links.length,1,'page 2');
 await admin({modus:'setzen',reverse_werte:{konfidenz_prozent:96},grund:'RV30 threshold'});
 eq((await call('verknuepfungen')).links.length,0,'confidence threshold excludes weaker candidates');
 await admin({modus:'entfernen',reverse_namen:['konfidenz_prozent'],grund:'RV30 threshold reset'});
 const later=await target('CD1/GFX/0023.dat');
 ok((await call('verknuepfungen')).links.find(x=>x.muster==='gfx/%04d.dat').ziele.some(x=>x.datei_id===later),'new extracted files immediately included, no stale cache');
 await admin({modus:'setzen',reverse_werte:{max_ziele:1},grund:'RV30 target cap'});
 ok((await call('verknuepfungen')).links.find(x=>x.muster==='gfx/%04d.dat').ziele_gekappt,'target cap explicit');
 await admin({modus:'entfernen',reverse_namen:['max_ziele'],grund:'RV30 target cap reset'});
 const struktur=await call('struktur');ok(struktur.success&&struktur.geladen_von.some(x=>x.funktion?.name==='LoadGfx'),'structure loaded by section');
 const old=await pool.query("UPDATE reverse_schichten SET aktuell=false WHERE datei_id=$1 RETURNING id",[fixture.did]);
 eq((await call('verknuepfungen')).links.length,0,'stale fingerprints excluded');await pool.query('UPDATE reverse_schichten SET aktuell=true WHERE id=ANY($1::bigint[])',[old.rows.map(x=>x.id)]);
 process.env.SYNAPSE_INTERN_TOOL='1';
 await pool.query("INSERT INTO intern_schalter(name,modus,aktiv,bis,grund) VALUES('reverse_verknuepfungen','freigegeben',false,NOW()+interval '1 minute','RV30 override')");
 eq((await call('verknuepfungen')).diagnose.schalter.quelle,'intern','temporary OFF override source');
 await pool.query("UPDATE intern_schalter SET bis=NOW()-interval '1 second' WHERE name='reverse_verknuepfungen'");
 ok((await call('verknuepfungen')).links.length>0,'expiry -> production standard');
 await pool.query("UPDATE intern_schalter SET bis=NOW()+interval '1 minute' WHERE name='reverse_verknuepfungen'");
 delete process.env.SYNAPSE_INTERN_TOOL;
 const child=execFileSync(process.execPath,['--input-type=module','-e',
  "import {leseReverseEinstellungen} from "+JSON.stringify(new URL('../dist/services/reverse-einstellungen.js',import.meta.url).href)+";"+
  "import {closePool} from "+JSON.stringify(new URL('../dist/db/client.js',import.meta.url).href)+";"+
  "console.log(JSON.stringify((await leseReverseEinstellungen("+JSON.stringify(project)+")).schalter));await closePool();"
 ],{env:{...process.env,SYNAPSE_INTERN_TOOL:'0',PGOPTIONS:'-c search_path='+schema+',public'},encoding:'utf8'});
 const production=JSON.parse(child.trim().split('\n').pop());ok(production.aktiv&&production.quelle==='produkt-schalter','production process without intern -> product');
 process.env.SYNAPSE_INTERN_TOOL='1';await pool.query('ALTER TABLE intern_schalter RENAME TO intern_schalter_unavailable');
 ok((await call('verknuepfungen')).links.length>0,'override DB error -> product');
 await pool.query('ALTER TABLE intern_schalter_unavailable RENAME TO intern_schalter');delete process.env.SYNAPSE_INTERN_TOOL;
 await pool.query("DELETE FROM intern_schalter WHERE name='reverse_verknuepfungen'");
 const baselineBatches=await call('verknuepfungen');
 await admin({modus:'setzen',reverse_werte:{analyse_verweise:1},grund:'RV30 keyset batch size'});
 const batched=await call('verknuepfungen');
 eq(batched.links,baselineBatches.links,'single-reference keyset batches preserve complete ordered links');
 eq(batched.analyse_gekappt,false,'batch size is not an analysis cap');
 ok(batched.diagnose.verweis_stapel>1,'multiple keyset batches observed');
 eq(batched.diagnose.verweise_gelesen,baselineBatches.diagnose.verweise_gelesen,'no skipped or repeated references');
 await admin({modus:'entfernen',reverse_namen:['analyse_verweise'],grund:'RV30 batch size reset'});
 const {reverseDateiMuster}=await import('../dist/services/reverse-verknuepfungen.js');
 const stress=reverseDateiMuster('*a'.repeat(70)+'.dat',512);
 const vor=Date.now();eq(stress.test('a'.repeat(200)+'b.dat'),false,'hostile glob does not match');ok(Date.now()-vor<1000,'no regex backtracking');
 eq((await call('verknuepfungen',{limit:-1})).success,false,'invalid paging is an error');
 eq((await call('verknuepfungen',{datei:'../x.dat'})).fehlercode,'pfad_gefahr','unsafe path rejected');
 await admin({modus:'setzen',reverse_werte:{antwort_bytes:1},grund:'RV30 tiny response'});
 eq((await call('verknuepfungen')).fehlercode,'zu_gross','tiny response limit is error');
 await admin({modus:'entfernen',reverse_namen:['antwort_bytes'],grund:'RV30 response reset'});
 const s1=await prepare('s1.exe',JSON.stringify(rows[0])+'\n',undefined,{
  's1-rz-strings.json':JSON.stringify([{vaddr:123,string:'CD1/GFX/0001.dat'}]),'s1-rz-imports.json':'[]','s1-rz-symbols.json':'[]','normalisierer-status.json':'{"status":"fertig"}'});
 // F1: retain all parser forms across the SQL prefilter (including trim/path wrappers).
 const corpus=['.dat','.\u005cGFX',' \u00a0"gfx\u005c%04d.dat"\u3000','GFX/','"0001.DAT"','SND','./snd/','missing.zzz','random'];
 for(let i=0;i<corpus.length;i++)await pool.query("INSERT INTO reverse_code_symbole(id,eintrag_id,file_path,symbol_type,value,line_start,datei_id,schicht,fingerabdruck) SELECT $1,eintrag_id,file_path,'string',$2,1,datei_id,schicht,fingerabdruck FROM reverse_code_symbole WHERE datei_id=$3 AND schicht='S1' LIMIT 1",['rv30-corpus-'+i,corpus[i],s1.did]);
 const corpusLinks=await call('verknuepfungen');
 for(const rawValue of corpus){
  const pattern=reverseDateiMuster(rawValue,512);
  if(pattern&&['cd1/gfx/0001.dat','cd1/snd/0001.dat'].some(p=>pattern.test(p)))
   ok(corpusLinks.links.some(x=>x.quelle==='S1'&&x.muster===pattern.text),'prefilter preserves '+JSON.stringify(rawValue));
 }
 // More than one STANDARD batch of relevant references; a last candidate must not disappear.
 await pool.query("INSERT INTO reverse_code_symbole(id,eintrag_id,file_path,symbol_type,value,line_start,datei_id,schicht,fingerabdruck) SELECT 'rv30-bulk-'||lpad(n::text,6,'0'),s.eintrag_id,s.file_path,'string',CASE WHEN n=10001 THEN 'snd/0001.dat' ELSE 'CD1/GFX/0001.dat' END,1,s.datei_id,s.schicht,s.fingerabdruck FROM (SELECT * FROM reverse_code_symbole WHERE datei_id=$1 AND schicht='S1' LIMIT 1) s CROSS JOIN generate_series(1,10001) n",[s1.did]);
 const bigBatch=await call('verknuepfungen');
 ok(bigBatch.success&&!bigBatch.analyse_gekappt,'more than 10000 relevant refs finish');
 ok(bigBatch.diagnose.verweis_stapel>=2&&bigBatch.diagnose.verweise_gelesen>=10001,'standard keyset crosses 10000');
 ok(bigBatch.links.some(x=>x.verweis_id==='rv30-bulk-010001'),'last reference beyond first batch retained');
 const functionWithS1=await call('verknuepfungen',{funktion:'LoadGfx'});
 ok(functionWithS1.success&&functionWithS1.links.every(x=>x.quelle==='S3')&&functionWithS1.diagnose.verweise_gelesen<10000,'function query skips irrelevant S1');
 await pool.query("DELETE FROM reverse_code_symbole WHERE id LIKE 'rv30-bulk-%' OR id LIKE 'rv30-corpus-%'");
 const s1Links=await call('verknuepfungen');
 ok(s1Links.links.some(x=>x.quelle==='S1'&&x.quell_datei_id===s1.did&&x.funktion===null),'S1 candidate has no invented function');
 await admin({modus:'setzen',reverse_werte:{analyse_verweise:1},grund:'RV30 canonical S1 plus legacy keyset'});
 const allSources=await call('verknuepfungen');
 eq(allSources.links,s1Links.links,'S3, canonical S1 and legacy candidates preserve ordered links across single-row batches');
 eq(allSources.diagnose.verweise_gelesen,s1Links.diagnose.verweise_gelesen,'all three source counts match');
 await admin({modus:'entfernen',reverse_namen:['analyse_verweise'],grund:'RV30 canonical S1 reset'});
 await pool.query("DELETE FROM reverse_code_dateien WHERE datei_id=$1 AND schicht='S1'",[s1.did]);
 const legacy=await call('verknuepfungen');
 ok(legacy.links.some(x=>x.verweis_id.startsWith('kandidat:')&&x.quell_datei_id===s1.did&&x.funktion===null),'existing reverse_verweise candidates work without a parallel symbol store');
 await admin({modus:'setzen',reverse_werte:{analyse_verweise:1},grund:'RV30 source transition keyset'});
 const mixedBatches=await call('verknuepfungen');
 eq(mixedBatches.links,legacy.links,'S3 to S1 candidate keyset transition preserves all links');
 eq(mixedBatches.diagnose.verweise_gelesen,legacy.diagnose.verweise_gelesen,'mixed source reference counts match');
 await admin({modus:'entfernen',reverse_namen:['analyse_verweise'],grund:'RV30 source transition reset'});
 // S1-only executable formats remain eligible; non-code data does not supply loader hints.
 const codeLayers=await pool.query("UPDATE reverse_schichten SET aktuell=false WHERE datei_id=$1 AND schicht IN ('S2','S3') AND aktuell RETURNING id",[s1.did]);
 ok((await call('verknuepfungen')).links.some(x=>x.quell_datei_id===s1.did),'S1-only PE loader hint retained');
 await pool.query("UPDATE reverse_dateien SET format='gif' WHERE id=$1",[s1.did]);
 ok(!(await call('verknuepfungen')).links.some(x=>x.quell_datei_id===s1.did),'legacy data-image hints excluded');
 await pool.query('UPDATE reverse_schichten SET aktuell=true WHERE id=ANY($1::bigint[])',[codeLayers.rows.map(x=>x.id)]);
 ok((await call('verknuepfungen')).links.some(x=>x.quell_datei_id===s1.did),'current code layer overrides unrecognized format');
 await pool.query("UPDATE reverse_dateien SET format='pe' WHERE id=$1",[s1.did]);
 const langerPfad='CD1/'+'deep/'.repeat(110)+'gfx/0001.dat';await target(langerPfad);
 ok((await call('verknuepfungen',{datei:langerPfad})).links.some(x=>x.funktion?.name==='LoadGfx'),'file filter uses configured path limit, not pattern limit');
 const beforeBudget=await call('verknuepfungen'),maxAntwort=Buffer.byteLength(JSON.stringify(beforeBudget))-Math.floor(Buffer.byteLength(JSON.stringify(beforeBudget.links[0]))/2);
 await admin({modus:'setzen',reverse_werte:{antwort_bytes:maxAntwort},grund:'RV30 UTF8 budget'});
 const bounded=await call('verknuepfungen');
 ok(bounded.success&&Buffer.byteLength(JSON.stringify(bounded))<=maxAntwort,'UTF8 response includes envelope in budget');
 ok(bounded.links.length<beforeBudget.links.length&&bounded.antwort_gekappt,'response trimmed with visible flag');
 await admin({modus:'entfernen',reverse_namen:['antwort_bytes'],grund:'RV30 UTF8 reset'});
 // Same definition/dispatcher via HTTP and the stdio API forwarder, no live API.
 const Fastify=createRequire(new URL('../../rest-api/package.json',import.meta.url))('fastify');
 const {mcpRoutes}=await import('../../rest-api/dist/routes/mcp.js');
 const {rufeReverseApi}=await import('../../mcp-server/dist/tools/consolidated/reverse.js');
 const {registerAgentProfilRoutes}=await import('../../rest-api/dist/routes/agent-profil.js');
 const http=Fastify({logger:false});
 try{
  await http.register(mcpRoutes);
  await registerAgentProfilRoutes(http,{validateToken:async s=>s==='rv30-synthetic'?{kind:'session',scope:null}:null});
  await http.ready();let sequence=0;
  const rpc=async(method,params)=>{
   const r=await inDb(()=>http.inject({method:'POST',url:'/',headers:{'content-type':'application/json',accept:'application/json'},payload:{jsonrpc:'2.0',id:++sequence,method,params}}));
   eq(r.statusCode,200,'HTTP status');const body=r.json();ok(!body.error,JSON.stringify(body));return body.result;
  };
  const defs=(await rpc('tools/list')).tools.find(t=>t.name==='reverse');
  ok(defs.inputSchema.properties.action.enum.includes('verknuepfungen'),'HTTP definition includes action');
  const data=r=>r.structuredContent??JSON.parse(r.content.find(c=>c.type==='text').text);
  const args={action:'verknuepfungen',reverse_id:rid,project,agent_id:agent,funktion:'LoadGfx'};
  const rest=data(await rpc('tools/call',{name:'reverse',arguments:args}));
  ok(rest.success&&rest.links.some(x=>x.funktion?.name==='LoadGfx'),'HTTP real graph '+JSON.stringify(rest));
  const forward=data(await rufeReverseApi(args,{url:'http://rv30.invalid/',token:'fixture',fetchImpl:async(url,init)=>{
   const request=JSON.parse(init.body),result=await rpc(request.method,request.params);
   return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}),{status:200,headers:{'content-type':'application/json'}});
  }}));
  eq(forward.links,rest.links,'stdio/HTTP same payload');eq(forward.provenance,rest.provenance,'stdio/HTTP same provenance');
  const status=await inDb(()=>http.inject({method:'GET',url:'/api/projects/'+project+'/agent-profile/reverse-einstellungen',headers:{authorization:'Bearer rv30-synthetic'}}));
  eq(status.statusCode,200,'WebUI settings route');ok(status.json().werte.max_ziele,'WebUI exposes budgets');
  const put=await inDb(()=>http.inject({method:'PUT',url:'/api/projects/'+project+'/agent-profile/reverse-einstellungen',headers:{authorization:'Bearer rv30-synthetic'},payload:{ebene:'projekt',reverse_werte:{seiten_limit:1},grund:'RV30 HTTP setting'}}));
  eq(put.statusCode,200,'WebUI settings write');eq((await call('verknuepfungen')).links.length,1,'HTTP setting affects tool immediately');
  await admin({modus:'entfernen',reverse_namen:['seiten_limit'],grund:'RV30 HTTP reset'});
 }finally{await http.close();}
 if(process.env.P18_RV30_REAL_JSONL){
  // Real coordinator-generated Ghidra output only; never read or execute original bytes.
  const input=process.env.P18_RV30_REAL_JSONL,sidecars={};
  for(const name of ['s1-rz-strings.json','s1-rz-imports.json','s1-rz-symbols.json','normalisierer-status.json']){
   try{sidecars[name]=await readFile(join(dirname(input),name),'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  const real=await prepare('medium-1/inhalt/session1/S3/s3.ex_',await readFile(input,'utf8'),undefined,sidecars);
  const targets=JSON.parse(await readFile(process.env.P18_RV30_REAL_FILES,'utf8'));
  for(const p of targets)await target(p);
  if(process.env.P18_RV30_S1_NOISE){
   const n=Number(process.env.P18_RV30_S1_NOISE);assert.ok(Number.isSafeInteger(n)&&n>=0&&n<=3000000);
   const noiseDid=await target('noise/assets.dat'),noisePath='noise/assets.dat@S1/strings.txt';
   await pool.query("INSERT INTO reverse_schichten(datei_id,schicht,fingerabdruck,aktuell,status,werkzeug) VALUES($1,'S1','rv30-noise-fp',true,'fertig','fixture')",[noiseDid]);
   await pool.query("INSERT INTO reverse_code_dateien(id,eintrag_id,file_path,file_name,file_type,datei_id,schicht,fingerabdruck) VALUES('rv30-noise-file',$1,$2,'strings.txt','txt',$3,'S1','rv30-noise-fp')",[rid,noisePath,noiseDid]);
   await pool.query("INSERT INTO reverse_code_symbole(id,eintrag_id,file_path,symbol_type,value,line_start,datei_id,schicht,fingerabdruck) SELECT 'rv30-noise-'||i,$1,$2,'string',CASE WHEN i=$4 THEN 'GFX' WHEN i%10=0 THEN 'noise.'||i||'.invalid' ELSE 'noise-'||i END,1,$3,'S1','rv30-noise-fp' FROM generate_series(1,$4) i",[rid,noisePath,noiseDid,n]);
   const excluded=await call('verknuepfungen',{gruppe:'GFX'});
   ok(excluded.success&&!excluded.links.some(x=>x.quell_datei_id===noiseDid),'data container strings excluded even when they match GFX');
   console.log('REAL_RV30_S1_NOISE '+n);
  }
  const defaultSettings=await inDb(()=>leseReverseEinstellungen(project));
  ok(Object.values(defaultSettings.werte).every(x=>x.quelle==='standard'),'real probe uses only standard settings');
  profileReal=true;
  let started=Date.now();
  const realLinks=await call('verknuepfungen',{funktion:'FUN_005f6fd0',limit:5});
  const gfxMs=Date.now()-started;
  ok(realLinks.success&&realLinks.links.some(x=>x.muster==='gfx'),'real s3.ex_ GFX function '+JSON.stringify(realLinks));
  started=Date.now();
  const soundLinks=await call('verknuepfungen',{funktion:'FUN_005feb05',limit:5});
  const sndMs=Date.now()-started;
  eq(realLinks.analyse_gekappt,false,'real GFX standard scan is complete');
  eq(soundLinks.analyse_gekappt,false,'real SND standard scan is complete');
  ok(gfxMs<defaultSettings.werte.laufzeit_ms.wert&&sndMs<defaultSettings.werte.laufzeit_ms.wert,'real standard time budget');
  ok(realLinks.diagnose.verweis_stapel>=1,'real candidate scan reported');
  ok(soundLinks.success&&soundLinks.links.some(x=>x.muster==='snd'),'real s3.ex_ SND function');
  ok(realLinks.links.some(x=>x.ziele.some(z=>z.pfad.includes('DATA1.CAB~inhalt/GFX/'))),'real GFX target path');
  ok(soundLinks.links.some(x=>x.ziele.some(z=>z.pfad.includes('DATA1.CAB~inhalt/EXE/SND/'))),'real SND target path');
  const groupTimes={};
  for(const gruppe of [undefined,'GFX','SND']){
   const t=Date.now(),r=await call('verknuepfungen',{gruppe,limit:5});groupTimes[gruppe]=Date.now()-t;
   ok(r.success&&r.links.length>0&&!r.analyse_gekappt&&groupTimes[gruppe]<defaultSettings.werte.laufzeit_ms.wert,'real group '+gruppe+' within standard budget '+JSON.stringify({ms:groupTimes[gruppe],success:r.success,fehlercode:r.fehlercode,fehler_detail:r.fehler_detail,links:r.links?.length,analyse_gekappt:r.analyse_gekappt,diagnose:r.diagnose}));
  }
  console.log('REAL_RV30_GROUPS '+JSON.stringify(groupTimes));
  console.log('REAL_RV30 '+JSON.stringify({import:real.result,gfx:realLinks.links,snd:soundLinks.links,analyse_gekappt:realLinks.analyse_gekappt,gfx_ms:gfxMs,snd_ms:sndMs,diagnose:realLinks.diagnose}));
 }
 console.log('RV30 PASS '+checks+' checks');
}finally{
 await (await import('../dist/db/client.js')).closePool();
 if(made)await raw.query('DROP SCHEMA '+schema+' CASCADE');
 await raw.end();await rm(temp,{recursive:true,force:true});
}
