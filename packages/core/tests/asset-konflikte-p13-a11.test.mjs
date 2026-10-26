/** A11: real bytes/PG fences; only p13_a11 in a private synapse_test schema. */
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {zieheSpaltenNach} from './_helfer/privatschema-spalten.mjs';
const base=process.env.SYNAPSE_A11_BASIS?pathToFileURL(process.env.SYNAPSE_A11_BASIS+'/packages/core/'):new URL('../',import.meta.url);
const load=p=>import(new URL('dist/'+p,base));
const U=await load('services/asset-upload.js'),S=await load('services/asset-speicher.js'),C=await load('config/asset-konfig.js'),D=await load('db/client.js');
let K,H;
try{K=await load('services/asset-konflikte.js');H=await load('services/asset-konflikt-hinweise.js');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
const pg=createRequire(new URL('../package.json',import.meta.url))('pg');
const schema='p13_a11_'+randomUUID().replaceAll('-',''),project='p13_a11',ctx={bereich:'projekt',ziel_ref:project,host_id:'a11-daemon'};
let admin,db,root,cfg,savedEnv;
const hash=b=>createHash('sha256').update(b).digest('hex');
async function connection(){
 const u=new URL(process.env.DATABASE_URL);assert.equal(u.pathname,'/synapse_test');assert.equal(u.port,'5433');
 const c=new pg.Client({connectionString:u.toString()});await c.connect();
 assert.equal((await c.query('SELECT current_database() AS n')).rows[0].n,'synapse_test');
 await c.query('SET search_path TO '+schema+',public');
 return {query:c.query.bind(c),release:()=>c.end()};
}
before(async()=>{
 if(!K)return;
 admin=await connection();await admin.query('CREATE SCHEMA '+schema);
 for(const file of ['95_asset_intel.sql','96_asset_transport.sql','98_asset_upload.sql','99_asset_manifest.sql','100_asset_konflikte.sql','81_ausloeser_hinweise.sql']){
  const sql=await readFile(new URL('../src/db/schema-sql/'+file,import.meta.url),'utf8');await admin.query(sql);await admin.query(sql);
 }
 await admin.query("CREATE TABLE agent_sessions(id TEXT PRIMARY KEY,project TEXT,sitzung_seit TIMESTAMPTZ,registered_at TIMESTAMPTZ DEFAULT NOW()); CREATE TABLE hinweis_optionen(project TEXT PRIMARY KEY,aktiv BOOLEAN);CREATE TABLE projects(name TEXT,enabled BOOLEAN)");
 // (angepasst P25-T10, Handliste ohne spaetere Spalten, z. B. asset_konflikte.resolver_identity_id aus agent-bezug-schema P22): Spalten aus public nachziehen.
 await zieheSpaltenNach(admin,schema);
 await admin.query('INSERT INTO projects VALUES($1,true)',[project]);
 root=await mkdtemp(join(tmpdir(),'synapse-p13-a11-'));assert.equal(await realpath(root),root);
 cfg=C.ladeAssetKonfiguration({SYNAPSE_ASSET_ENABLED:'1',SYNAPSE_PROJEKTE_ROOT:root});
 savedEnv={...process.env};Object.assign(process.env,{SYNAPSE_API_FEATURES:'asset_sync',SYNAPSE_ASSET_ENABLED:'1',SYNAPSE_PROJEKTE_ROOT:root});C.resetAssetKonfiguration();
 db={connect:connection,async query(sql,v){const c=await connection();try{return await c.query(sql,v);}finally{await c.release();}}};
});
after(async()=>{if(admin){await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.release();}if(root)await rm(root,{recursive:true,force:true});if(savedEnv){for(const k of Object.keys(process.env))if(!(k in savedEnv))delete process.env[k];Object.assign(process.env,savedEnv);C.resetAssetKonfiguration();}});
test('A11 feature present: fails on deployed t85 positive control',()=>assert.equal(typeof K?.AssetKonfliktKern,'function'));
const run=(name,fn)=>test(name,{skip:!K},fn);
const upload=(o={})=>new U.AssetUploadKern({db,konfiguration:cfg,...o});
const conflicts=(o={})=>new K.AssetKonfliktKern({db,konfiguration:cfg,...o});
const row=async path=>(await db.query('SELECT * FROM asset_files WHERE project=$1 AND file_path=$2',[project,path])).rows[0];
async function start(path,b,basis='0',o={}){
 const a=upload(o),s=await a.erstellen(ctx,{logischer_pfad:path,storage_kind:'assets',groesse:b.length,sha256:hash(b),basis_revision:basis,idempotency_key:randomUUID()});
 await a.teil(ctx,s.id,0,b.length,[b]);return {a,s};
}
async function put(path,b,basis='0',o={}){const {a,s}=await start(path,b,basis,o);return a.finalisieren(ctx,s.id);}
async function conflict(path){
 const a=await put(path,Buffer.from('basis'));const pending=await start(path,Buffer.from('pc-new'),a.revision);
 const share=await put(path,Buffer.from('share-new'),a.revision);
 const done=await pending.a.finalisieren(ctx,pending.s.id);return {a,share,done,pending,path};
}
const bytes=path=>readFile(join(root,project,'assets',path),'utf8');
run('DDL mirror equals executed wrapper and is idempotent',async()=>{
 const {ASSET_KONFLIKT_SCHEMA_SQL}=await load('db/asset-konflikt-schema.js');
 assert.equal((await readFile(new URL('../src/db/schema-sql/100_asset_konflikte.sql',import.meta.url),'utf8')).trim(),ASSET_KONFLIKT_SCHEMA_SQL.trim());
});
run('Both changed: Share active, PC immutable revision, replay and clock drift',async()=>{
 const x=await conflict('both.png'),r=await row(x.path),c=x.done.ergebnis.konflikt;
 assert.equal(r.transport_revision,x.share.revision);assert.equal(await bytes(x.path),'share-new');
 assert.equal(c.basis.revision,x.a.revision);assert.equal(c.share.sha256,hash('share-new'));assert.equal(c.pc.sha256,hash('pc-new'));
 assert.notEqual(c.pc.revision,c.share.revision);
 const rev=(await db.query('SELECT *,restore_until>clock_timestamp() AS retained FROM asset_revisionen WHERE asset_id=$1 AND revision=$2',[r.id,c.pc.revision])).rows[0];
 assert.equal(rev.quelle,'pc');assert.equal(rev.retained,true);
 const storage=new S.AssetSpeicher({konfiguration:cfg}),stream=await storage.readStorageStream({bereich:'projekt',ziel_ref:project,storage_kind:'assets',logischer_pfad:x.path},rev.storage_key);
 let pc='';for await(const b of stream)pc+=b;assert.equal(pc,'pc-new');
 await db.query("UPDATE asset_files SET mtime='2099-01-01' WHERE id=$1",[r.id]);await db.query("UPDATE asset_revisionen SET created_at='1901-01-01' WHERE asset_id=$1 AND revision=$2",[r.id,c.pc.revision]);
 assert.deepEqual(await x.pending.a.finalisieren(ctx,x.pending.s.id),x.done);
 assert.equal((await conflicts().liste(project,{file_path:x.path})).total,1);
 assert.equal((await conflicts().liste('p13_a11_foreign')).total,0);
 assert(!JSON.stringify((await conflicts().liste(project)).konflikte).includes('storage_key'));
});
run('PC equal Share is no-op; PC equal basis is not a conflict',async()=>{
 const a=await put('same.png',Buffer.from('a'));await put('same.png',Buffer.from('b'),a.revision);
 const before=(await db.query('SELECT count(*)::int AS n FROM asset_revisionen')).rows[0].n;
 const equal=await put('same.png',Buffer.from('b'),a.revision);
 assert.equal(equal.ergebnis.konflikt,undefined);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM asset_revisionen')).rows[0].n,before);
 const pending=await start('same.png',Buffer.from('a'),a.revision);
 await assert.rejects(pending.a.finalisieren(ctx,pending.s.id),e=>e.code==='revision_konflikt');
 assert.equal((await conflicts().liste(project,{file_path:'same.png'})).total,0);
 await db.query("UPDATE asset_upload_sitzungen SET status='abgebrochen' WHERE id=$1",[pending.s.id]);
});
run('Share choice closes hint, retains PC bytes and is idempotent',async()=>{
 const x=await conflict('share-choice.png');
 await conflicts().loesen(ctx,x.done.asset_id,'share','a11-agent');await conflicts().loesen(ctx,x.done.asset_id,'share','a11-agent');
 assert.equal(await bytes(x.path),'share-new');assert.equal((await conflicts().liste(project,{file_path:x.path})).total,0);
 await assert.rejects(conflicts().loesen(ctx,x.done.asset_id,'pc','a11-agent'),e=>e.code==='idempotency_konflikt');
 assert.equal((await db.query('SELECT count(*)::int AS n FROM asset_revisionen WHERE asset_id=$1',[x.done.asset_id])).rows[0].n,3);
});
run('PC resolution writes fresh canonical revision, audit and immutable Share history',async()=>{
 const x=await conflict('pc-choice.png'),out=await conflicts().loesen(ctx,x.done.asset_id,'pc','a11-agent');
 assert(BigInt(out.revision)>BigInt(x.done.ergebnis.konflikt.pc.revision));assert.equal(await bytes(x.path),'pc-new');
 const stored=(await db.query('SELECT * FROM asset_konflikte WHERE asset_id=$1',[x.done.asset_id])).rows[0];
 assert.equal(stored.status,'uebernommen_pc');assert.equal(stored.erledigt_von,'a11-agent');
 assert.equal((await conflicts().loesen(ctx,x.done.asset_id,'pc','a11-agent')).revision,out.revision);
});
run('PC choice cannot bypass project direction, limits or retention expiry',async()=>{
 const x=await conflict('limits.png');
 await db.query("INSERT INTO asset_projekt_optionen(project,richtung) VALUES($1,'share_to_pc')",[project]);
 await assert.rejects(conflicts().loesen(ctx,x.done.asset_id,'pc','a11-agent'),e=>e.code==='richtung_verboten');
 await db.query("UPDATE asset_projekt_optionen SET richtung='both',max_datei_bytes=1 WHERE project=$1",[project]);
 await assert.rejects(conflicts().loesen(ctx,x.done.asset_id,'pc','a11-agent'),e=>e.code==='quote');
 await db.query('DELETE FROM asset_projekt_optionen WHERE project=$1',[project]);
 await db.query("UPDATE asset_revisionen SET restore_until=NOW()-interval '1 second' WHERE asset_id=$1 AND revision=$2",[x.done.asset_id,x.done.ergebnis.konflikt.pc.revision]);
 await assert.rejects(conflicts().loesen(ctx,x.done.asset_id,'pc','a11-agent'),e=>e.code==='revision_abgelaufen');
 await conflicts().loesen(ctx,x.done.asset_id,'share','a11-agent');
});
run('Rename occupied target saves candidate, preserves source/target; completed rename replay survives later occupation',async()=>{
 const M=await load('services/asset-manifest.js'),m=new M.AssetManifestKern({db,konfiguration:cfg});
 const source=await put('source.png',Buffer.from('source')),target=await put('target.png',Buffer.from('target'));
 const e={event_id:randomUUID(),asset_id:source.asset_id,basis_revision:source.revision,alter_pfad:'source.png',pfad:'target.png'};
 await assert.rejects(m.mutieren(ctx,'verschieben',e),err=>err.code==='ziel_belegt'&&err.details.konflikt.art==='verschieben');
 assert.equal(await bytes('source.png'),'source');assert.equal(await bytes('target.png'),'target');
 const n=(await conflicts().liste(project,{asset_id:target.asset_id})).konflikte[0];
 assert.equal(n.quelle_asset_id,source.asset_id);assert.equal(n.pc.sha256,hash('source'));
 const movable=await put('move-old.png',Buffer.from('move'));
 const event={event_id:randomUUID(),asset_id:movable.asset_id,basis_revision:movable.revision,alter_pfad:'move-old.png',pfad:'move-new.png'};
 const done=await m.mutieren(ctx,'verschieben',event);await put('move-old.png',Buffer.from('other'));
 assert.deepEqual(await m.mutieren(ctx,'verschieben',event),done);
});
run('Transient Share prepare retains verified chunks and can finalize on retry',async()=>{
 const a=await put('retry.png',Buffer.from('a')),pending=await start('retry.png',Buffer.from('pc'),a.revision);
 const share=await put('retry.png',Buffer.from('share'),a.revision);
 await db.query("UPDATE asset_files SET storage_status='prepared',prepared_upload_id=$2 WHERE id=$1",[a.asset_id,share.id]);
 await assert.rejects(pending.a.finalisieren(ctx,pending.s.id),e=>e.code==='revision_konflikt');
 assert.equal((await pending.a.status(ctx,pending.s.id)).status,'laeuft');
 await db.query("UPDATE asset_files SET storage_status='ready',prepared_upload_id=NULL WHERE id=$1",[a.asset_id]);
 const out=await pending.a.finalisieren(ctx,pending.s.id);
 assert.equal(out.revision,share.revision);assert.equal(out.ergebnis.konflikt.pc.sha256,hash('pc'));assert.equal(await bytes('retry.png'),'share');
});
run('Failed PC commit holds prepared journal; only physical-orphan recovery restores Share',async()=>{
 const x=await conflict('recover.png');let crash=true;
 const broken={...db,async connect(){const c=await connection();return {...c,async query(sql,v){if(crash&&sql.startsWith('INSERT INTO asset_revisionen')){crash=false;throw Error('a11 commit crash');}return c.query(sql,v);}}}};
 await assert.rejects(conflicts({db:broken}).loesen(ctx,x.done.asset_id,'pc','a11-agent'),/a11 commit crash/);
 assert.equal((await row(x.path)).storage_status,'prepared');
 const op=(await db.query("SELECT * FROM asset_konflikt_loesungen WHERE project=$1 AND status='prepared' ORDER BY created_at DESC LIMIT 1",[project])).rows[0];
 await db.query("UPDATE asset_konflikt_loesungen SET lease_bis=NOW()-interval '1 second' WHERE id=$1",[op.id]);
 await assert.rejects(conflicts().recovery(ctx,op.id,{istVerwaist:async()=>false}),e=>e.code==='recovery_unbestaetigt');
 await conflicts().recovery(ctx,op.id,{istVerwaist:async()=>true});
 assert.equal((await row(x.path)).storage_status,'ready');assert.equal(await bytes(x.path),'share-new');
 await conflicts().loesen(ctx,x.done.asset_id,'share','a11-agent');
});
run('RV19 project/file scope, session debounce, fresh session, directory and resolved disappearance',async()=>{
 const x=await conflict('hint/drawing.png'),R=await load('services/ausloeser-hinweise.js'),agent='p13_a11-'+randomUUID();
 await db.query("INSERT INTO agent_sessions VALUES($1,$2,NOW(),NOW())",[agent,project]);
 const stop=R.registriereHinweisQuelle(H.assetKonfliktHinweisQuelle(db));
 try{
  const raw={success:true,file_path:x.path},args={project,action:'file',file_path:x.path,agent_id:agent},o={pool:db,zeitbudgetMs:2000};
  const first=await R.haengeAusloeserHinweiseAn(raw,'code_intel',args,agent,o);
  assert.equal(first.ausloeser_hinweise.length,1);const line=first.ausloeser_hinweise[0];
  assert(line.includes('drawing.png'));assert(line.includes('Share'));assert(line.includes(' PC '));assert(line.includes('User fragen'));
  assert(line.includes('wahl:"pc"})'));assert(line.length<=240);
  assert.equal(await R.haengeAusloeserHinweiseAn(raw,'code_intel',args,agent,o),raw);
  const other={...args,file_path:'other.png'},otherRaw={success:true,file_path:'other.png'};
  assert.deepEqual(await H.assetKonfliktHinweisQuelle(db).pruefe(R.baueHinweisKontext('code_intel',other,otherRaw,agent,'test',new AbortController().signal)),[]);
  assert.equal(await R.haengeAusloeserHinweiseAn(otherRaw,'code_intel',other,agent,o),otherRaw);
  await db.query("UPDATE ausloeser_hinweis_zustellungen SET gezeigt_am=NOW()-interval '2 minutes' WHERE agent_id=$1",[agent]);
  const compact=await R.haengeAusloeserHinweiseAn(raw,'code_intel',args,agent,o);assert(compact.ausloeser_hinweise[0].includes('Konflikt offen'));
  await db.query("UPDATE agent_sessions SET sitzung_seit=NOW()+interval '1 second' WHERE id=$1",[agent]);
  assert.equal((await R.haengeAusloeserHinweiseAn(raw,'code_intel',args,agent,o)).ausloeser_hinweise.length,1);
  const context=R.baueHinweisKontext('code_intel',{project,action:'tree',path:'hint'}, {},agent,'test',new AbortController().signal);
  assert.equal((await H.assetKonfliktHinweisQuelle(db).pruefe(context)).length,1);
  await conflicts().loesen(ctx,x.done.asset_id,'share','a11-agent');
  assert.equal(await R.haengeAusloeserHinweiseAn(raw,'code_intel',args,agent,o),raw);
 }finally{stop();}
});
run('HTTP and MCP/stdio adapter use same conflict service; auth and API-only fences',async()=>{
 const {createAssetsRoutes}=await import('../../rest-api/dist/routes/assets.js'),{fuehreAssetIntelAus}=await load('services/asset-intel-tool.js');
 const {rufeAssetKonfliktApi}=await import('../../mcp-server/dist/tools/consolidated/asset-konflikt-api.js');
 const Fastify=createRequire(new URL('../../rest-api/package.json',import.meta.url))('fastify');
 const x=await conflict('http.png'),app=Fastify(),headers={authorization:'Bearer a11-fixture','x-synapse-contract-version':'1'};
 await app.register(createAssetsRoutes({konflikte:conflicts(),projektErlaubt:async p=>p===project,validateToken:async()=>({kind:'access',token_hash:'a11-fixture'})}));
 await app.ready();
 try{
  const unauth=await app.inject({url:'/api/projects/'+project+'/assets/konflikte'});assert.equal(unauth.statusCode,401);
  const http=await app.inject({url:'/api/projects/'+project+'/assets/konflikte?asset_id='+x.done.asset_id,headers});assert.equal(http.statusCode,200);
  const listed=http.json();assert.equal(listed.total,1);
  const old={...process.env};process.env.SYNAPSE_ASSET_ENABLED='1';process.env.SYNAPSE_PROJEKTE_ROOT=root;C.resetAssetKonfiguration();
  try{
   const args={action:'konflikte',project,asset_id:x.done.asset_id};
   const no=await D.mitLesePool(db,()=>fuehreAssetIntelAus(args));assert.equal(no.fehler,'api_erforderlich');
   const direct=await D.mitLesePool(db,()=>fuehreAssetIntelAus(args,{apiAusfuehrung:true,agentId:'a11-agent'}));assert.equal(direct.success,true);assert.deepEqual(direct.konflikte,listed.konflikte);
   const stdio=await rufeAssetKonfliktApi(args,{url:'http://a11.invalid/mcp',token:'fixture',fetchImpl:async(url,request)=>{
    assert.equal(request.headers.authorization,'Bearer fixture');
    const rpc=JSON.parse(request.body);assert.equal(rpc.params.name,'asset_intel');
    const out=await D.mitLesePool(db,()=>fuehreAssetIntelAus(rpc.params.arguments,{apiAusfuehrung:true,agentId:'a11-agent'}));
    return {ok:true,json:async()=>({result:{content:[{type:'text',text:JSON.stringify(out)}]}})};
   }});assert.deepEqual(JSON.parse(stdio.content[0].text),direct);
  }finally{for(const k of Object.keys(process.env))if(!(k in old))delete process.env[k];Object.assign(process.env,old);C.resetAssetKonfiguration();}
  const resolved=await app.inject({method:'POST',url:'/api/projects/'+project+'/assets/konflikte/'+x.done.asset_id+'/loesen',headers,payload:{wahl:'share'}});
  assert.equal(resolved.statusCode,200);assert.equal((await conflicts().liste(project,{file_path:x.path})).total,0);
 }finally{await app.close();}
});

run('Related asset_intel and code_intel file responses expose conflict only when present',async()=>{
 await db.query('CREATE TABLE IF NOT EXISTS code_files(project TEXT,file_path TEXT,file_type TEXT)');
 const A=await load('services/asset-intel-tool.js'),W=await load('services/asset-weiche.js');
 const inspect=await D.mitLesePool(db,()=>A.fuehreAssetIntelAus({action:'inspect',project,file_path:'both.png'}));
 assert.equal(inspect.success,true);assert.equal(inspect.konflikt.file_path,'both.png');
 const weiche=await D.mitLesePool(db,()=>W.ergaenzeCodeIntelAntwort('file',{project,file_path:'both.png'},{success:false,error:'Datei nicht gefunden'}));
 assert.equal(weiche.beantwortet_von,'asset_intel');assert.equal(weiche.konflikt.file_path,'both.png');
 const clean=await D.mitLesePool(db,()=>A.fuehreAssetIntelAus({action:'inspect',project,file_path:'same.png'}));
 assert.equal(clean.success,true);assert.equal('konflikt' in clean,false);
});
run('Gate-off initializer keeps empty RV19 registry and legacy object identity without DB',async()=>{
 const R=await load('services/ausloeser-hinweise.js'),raw={success:true},old=process.env.SYNAPSE_ASSET_ENABLED;
 process.env.SYNAPSE_ASSET_ENABLED='0';C.resetAssetKonfiguration();let queries=0;
 try{
  H.initialisiereAssetKonfliktHinweise();
  const out=await R.haengeAusloeserHinweiseAn(raw,'project',{action:'status',project},'agent',{pool:{query(){queries++;throw Error('unexpected');},connect(){queries++;throw Error('unexpected');}}});
  assert.equal(out,raw);assert.equal(queries,0);
 }finally{process.env.SYNAPSE_ASSET_ENABLED=old;C.resetAssetKonfiguration();}
});

