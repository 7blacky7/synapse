/**
 * P21-T1/RV27: echter S0/S1-Pipeline-Lauf, PG, Rechte/Bindung und REST/stdio.
 * Ausschliesslich synapse_test:5433, privates Schema/Sequenzen, temporaere Fixturebytes und Loopback-HTTP.
 */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deflateSync} from 'node:zlib';
const repo=join(dirname(fileURLToPath(import.meta.url)),'../../..');
const dbUrl=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(dbUrl.port,'5433');assert.equal(dbUrl.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_COMPUTE_ADMISSION','SYNAPSE_COMPUTE_POLICY'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'1',SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const schema='p21_rv27_'+process.pid+'_'+randomUUID().slice(0,8),P='p21-rv27-test',Q='p21-rv27-other',RID='rev-rv27-fixture-000001';
const temp=await mkdtemp(join(tmpdir(),'p21-rv27-')),assetRoot=join(temp,'projekte'),reverseRoot=join(temp,'reverse');
Object.assign(process.env,{SYNAPSE_ASSET_ENABLED:'1',SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_PROJEKTE_ROOT:assetRoot,SYNAPSE_REVERSE_ROOT:reverseRoot});
const require=createRequire(join(repo,'packages/core/package.json')),{Pool}=require('pg');
const admin=new Pool({connectionString:dbUrl.href});
const secrets=[],failures=[],close=[],sha=b=>createHash('sha256').update(b).digest('hex');
const mask=s=>secrets.reduce((s,k)=>s.replaceAll(k,'[GEHEIM]'),String(s)).replace(/sai_[a-z0-9]+/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
let pipeline,core,pool,checks=0,seq=0,nextAsset=100,app,client,loopback,actor;
const eq=(a,b,label)=>{checks++;assert.deepEqual(a,b,label);};
const ok=(v,label)=>{checks++;assert.equal(!!v,true,label);};
async function section(label,fn){try{await fn();console.log('PASS '+label);}catch(e){failures.push(label);console.error('FAIL '+label+': '+mask(e.stack??e));}}
const unwrap=r=>r.structuredContent??JSON.parse(r.content.find(c=>c.type==='text').text);
const normal=r=>JSON.parse(JSON.stringify(r,(k,v)=>['dauer_ms','cursor'].includes(k)?'<volatil>':v));
const quote=s=>'"'+s.replaceAll('"','""')+'"';
async function row(table,values){
 const cols=(await pool.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND ((is_nullable='NO' AND column_default IS NULL AND is_identity='NO') OR column_name=ANY($3::text[]))",[schema,table,Object.keys(values)])).rows;
 const vals=cols.map(c=>Object.hasOwn(values,c.column_name)?values[c.column_name]:(c.data_type==='boolean'?false:c.data_type.includes('int')||c.data_type.includes('numeric')?0:c.data_type.includes('json')?'{}':c.data_type.includes('time')?new Date():c.data_type==='ARRAY'?[]:'fixture'));
 await pool.query('INSERT INTO '+quote(table)+'('+cols.map(c=>quote(c.column_name)).join(',')+') VALUES('+vals.map((_,i)=>'$'+(i+1)).join(',')+')',vals);
}
async function textFile(file_path,content,project=P){
 const id=randomUUID();
 await row('code_files',{id,project,file_path,file_name:file_path.split('/').at(-1),file_type:'txt',content,content_hash:sha(Buffer.from(content)),file_size:Buffer.byteLength(content)});
 return {art:'projekt_text',file_path};
}
async function asset(file_path,bytes,project=P){
 const id=String(nextAsset++),key=project+'/.intern/revisionen/'+id+'/1.bin',path=join(assetRoot,key);
 await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes);
 await row('asset_files',{id,project,file_path,file_name:file_path.split('/').at(-1),file_type:'bin',status:'ok',storage_kind:'assets',storage_status:'ready',storage_key:project+'/assets/'+file_path,transport_revision:1,transport_sha256:sha(bytes),file_size:bytes.length});
 await row('asset_revisionen',{asset_id:id,revision:1,sha256:sha(bytes),groesse:bytes.length,storage_key:key,quelle:'share',tombstone:false});
 return {art:'projekt_asset',id,revision:'1'};
}
async function override(name,aktiv=true,expired=false){
 await pool.query("INSERT INTO intern_schalter(name,aktiv,modus,bis,grund,gesetzt_von) VALUES($1,$2,'freigegeben',NOW()+($3*interval '1 second'),'P21 synthetischer Test','test') ON CONFLICT(name) DO UPDATE SET aktiv=EXCLUDED.aktiv,modus=EXCLUDED.modus,bis=EXCLUDED.bis",[name,aktiv,expired?-1:600]);
}
async function budgets(values){
 for(const [name,wert]of Object.entries(values))await pool.query("INSERT INTO hex_einstellungen(ebene,project,name,wert,grund,gesetzt_von) VALUES('projekt',$1,$2,$3,'P21 Test','test') ON CONFLICT(ebene,(COALESCE(project,'')),name) DO UPDATE SET wert=EXCLUDED.wert",[P,name,wert]);
}
async function resetBudgets(){await pool.query("DELETE FROM hex_einstellungen WHERE project=$1",[P]);}
const context=()=>({principal:actor,bezug:{modus:'beide',standard:'beide',quelle:'standard',bis:null,letzter_fehler:null}});
const call=(action,args={})=>core.mitAgentAufrufKontext(context(),()=>core.fuehreHexAus({action,project:P,...args},{apiAusfuehrung:true}));
const success=(r,label)=>{ok(r.success,label+': '+(r.fehler??r.error??'ok'));return r;};
async function transports(){
 const fastify=(await import('../../rest-api/node_modules/fastify/fastify.js')).default;
 const {mcpRoutes}=await import('../../rest-api/dist/routes/mcp.js');
 const {registerAuthHook}=await import('../../rest-api/dist/middleware/auth-hook.js');
 const bearer=randomUUID()+randomUUID();secrets.push(bearer);
 await pool.query("INSERT INTO auth_tokens(token_hash,kind,scope,expires_at) VALUES($1,'access','mcp:tools',NOW()+interval '1 hour')",[sha(Buffer.from(bearer))]);
 app=fastify({logger:false});registerAuthHook(app);await app.register(mcpRoutes);await app.listen({host:'127.0.0.1',port:0});
 close.push(()=>app.close());loopback='http://127.0.0.1:'+app.server.address().port+'/mcp/messages';
 const native=globalThis.fetch;
 globalThis.fetch=async(url,opts)=>{if(String(url)!==loopback)throw Error('Testnetz gesperrt');return native(url,opts);};close.push(async()=>{globalThis.fetch=native;});
 const rest=async(name,args)=>{const r=await app.inject({method:'POST',url:'/mcp/messages',headers:{authorization:'Bearer '+bearer},payload:{jsonrpc:'2.0',id:++seq,method:'tools/call',params:{name,arguments:args}}});eq(r.statusCode,200,'REST HTTP200');const x=r.json();ok(x.result,'REST result vorhanden');return unwrap(x.result);};
 const sdk='../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/';
 const {InMemoryTransport}=await import(sdk+'inMemory.js'),{Client}=await import(sdk+'client/index.js'),{createServer}=await import('../../mcp-server/dist/server.js');
 const server=createServer();client=new Client({name:'p21-fixture',version:'1'});
 const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);close.push(()=>server.close());close.push(()=>client.close());
 process.env.SYNAPSE_API_URL=loopback;process.env.SYNAPSE_API_TOKEN=bearer;
 const token=await core.stelleAgentTokenAus({project:P,name:'hex-fixture',rolle:'subagent'},{system:'user'});
 secrets.push(token.token);
 return {rest,stdio:async(name,args)=>unwrap(await client.callTool({name,arguments:args})),token:token.token};
}
try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows)await admin.query('CREATE TABLE '+schema+'.'+quote(tablename)+' (LIKE public.'+quote(tablename)+' INCLUDING ALL)');
 const serials=(await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%'",[schema])).rows;
 for(const [i,c]of serials.entries()){const s=schema+'.private_serial_'+i;await admin.query('CREATE SEQUENCE '+s);await admin.query('ALTER TABLE '+schema+'.'+quote(c.table_name)+' ALTER COLUMN '+quote(c.column_name)+" SET DEFAULT nextval('"+s+"'::regclass)");}
 dbUrl.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=dbUrl.href;
 core=await import('../dist/index.js');pool=core.getPool();
 eq((await pool.query('SELECT current_database() d,current_schema() s')).rows[0],{d:'synapse_test',s:schema},'privates Testschema');
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','agent-ausweis-fristen-schema','agent-ausweis-projekte-schema','hex-schema','hex-formate-schema','hex-analysen-schema','work-jobs-schema']){
  const mod=await import('../dist/db/'+file+'.js'),sql=Object.values(mod).find(v=>typeof v==='string');await pool.query(sql);await pool.query(sql);
 }
 // Keine Sequenz aus public verwenden, auch fuer die Ausweis-Numerierung nicht.
 await pool.query('CREATE SEQUENCE IF NOT EXISTS '+schema+'.agent_ausweis_nr');
 for(const p of [P,Q])await row('projects',{name:p,path:join(temp,p),hostname:'synthetic',enabled:true});
 actor={art:'legacy',project:P,agent_id:'hex-test'};

 const {ReversePipelineDienst}=await import('../dist/services/reverse-pipeline.js');
 const {getAssetKonfiguration}=await import('../dist/config/asset-konfig.js');
 const cfg=getAssetKonfiguration();cfg.inspektion={...cfg.inspektion,maxReadBytes:262144,maxHashBytes:262144,maxObjects:64,timeoutMs:15000};
 cfg.sync.parallelInspektionen=1;
 pipeline=new ReversePipelineDienst({pool,konfiguration:cfg,ausfuehrbareKinds:[]});close.push(()=>pipeline.beende());
 const release=core.configureReverseRuntime({analysieren:(a,db)=>pipeline.analysieren(a,db),abbrechen:(a,b,db)=>pipeline.abbrechen(a,b,db)});
 close.push(async()=>release());
 await row('agent_sessions',{id:actor.agent_id,project:P,status:'active',sitzung_seit:new Date()});
 await row('agent_sessions',{id:'rv27-other',project:Q,status:'active',sitzung_seit:new Date()});
 await row('reverse_eintraege',{id:RID,titel:'RV27 Synthetic',status:'bestaetigt',analyse_policy:{automatisch:false,bis_schicht:'S1'}});
 await row('reverse_medien',{id:1,eintrag_id:RID,position:0,art:'datei'});
 const rev=(action,args={},agent=actor.agent_id)=>core.mitAgentAufrufKontext(context(),()=>core.fuehreReverseAus({action,project:P,agent_id:agent,reverse_id:RID,...args}));
 const fixtures=[];
 async function file(id,path,bytes){
  const key=RID+'/binaries/'+path;await mkdir(dirname(join(reverseRoot,key)),{recursive:true});await writeFile(join(reverseRoot,key),bytes);
  await row('reverse_dateien',{id,eintrag_id:RID,medium_id:1,pfad:path,art:'sonstig',groesse:bytes.length,sha256:sha(bytes),storage_key:key});
  const f={id,path,bytes,ref:{art:'reverse_datei',reverse_id:RID,id:String(id)}};fixtures.push(f);return f;
 }
 const pairA=Buffer.alloc(1024);pairA.set([0x10,0x20,0x30,0x40]);const pairB=Buffer.from(pairA);pairB[8]=0x11;
 await file(10,'a.dat',pairA);await file(11,'b.dat',pairB);
 const entropy=Buffer.alloc(131072);for(let i=65536;i<entropy.length;i++)entropy[i]=i%256;await file(12,'entropy.bin',entropy);
 const embedded=Buffer.alloc(2048);[16,32,48,64].forEach((v,i)=>embedded.writeUInt32LE(v,i*4));
 embedded.set(Buffer.from('89504e470d0a1a0a0000000d4948445200000002000000030806000000','hex'),80);
 const bmp=Buffer.alloc(54);bmp.write('BM');bmp.writeUInt32LE(54,2);bmp.writeUInt32LE(54,10);bmp.writeUInt32LE(40,14);bmp.writeUInt32LE(2,18);bmp.writeUInt32LE(2,22);embedded.set(bmp,240);
 embedded.write('BM',500);await file(13,'embedded.bin',embedded);await file(14,'empty.dat',Buffer.alloc(0));
 function independentEntropy(bytes){const bins=Array(256).fill(0);for(const b of bytes)bins[b]++;return Number(bins.reduce((s,n)=>n?s-(n/bytes.length)*Math.log2(n/bytes.length):s,0).toFixed(4));}
 await section('Reverse-Rechte, Bindung und noch nicht analysierte PG-Dateien',async()=>{
  eq((await rev('struktur')).fehlercode,'nicht_gebunden','ohne Bindung keine Struktur');
  eq((await rev('struktur',{},'rv27-other')).fehlercode,'keine_berechtigung','fremde Legacy-Identitaet darf Projekt nicht behaupten');
  await row('reverse_bindungen',{id:1,eintrag_id:RID,project:P,gebunden_von:'test'});
  const r=success(await rev('struktur'),'leere Analyse');eq(r.analysiert,0,'keine erfundene Analyse');eq(r.nicht_analysiert.length,fixtures.length,'Dateien fehlen ehrlich');eq(r.status,'teilweise','Teilstatus');
 });
 await section('Echter geleaster S0/S1-Lauf materialisiert RV27-Metadaten in PG',async()=>{
  eq(Number((await pool.query('SELECT count(*) n FROM reverse_assets')).rows[0].n),0,'anfangs keine Assets');
  for(const f of fixtures)success(await rev('analysieren',{datei:f.path,bis_schicht:'S1'}),'Analyse angenommen '+f.path);
  // Aktive Pipeline-Schritte, kein zeitgesteuertes Warten und keine Hintergrundschleife.
  for(let step=0;step<12;step++){
   await pipeline.durchlauf();
   if(Number((await pool.query("SELECT count(*) n FROM reverse_dateien WHERE metadaten->'rv27' IS NOT NULL AND metadaten->'rv27'<>'null'::jsonb")).rows[0].n)===fixtures.length)break;
  }
  const rows=(await pool.query('SELECT id::text,pfad,metadaten,status FROM reverse_dateien ORDER BY id')).rows;
  if(rows.some(r=>!r.metadaten?.rv27))console.log('PIPELINE '+JSON.stringify((await pool.query('SELECT datei_id::text,schicht,status,fehlercode FROM reverse_auftraege ORDER BY datei_id,schicht')).rows));
  eq(rows.filter(r=>r.metadaten.rv27).length,fixtures.length,'jede Datei durch echte S1 analysiert');
  for(const r of rows){ok(r.metadaten.rv27.scan_vollstaendig,'voller Scan '+r.pfad);ok(['fertig','teilweise'].includes(r.status),'ehrlicher Status');}
  const jobs=(await pool.query("SELECT schicht,status,lease_token FROM reverse_auftraege WHERE schicht IN ('S0','S1')")).rows;
  eq(jobs.length,fixtures.length*2,'S0 und S1 je Datei');ok(jobs.every(j=>['fertig','teilweise'].includes(j.status)&&j.lease_token===null),'alle Leases terminal freigegeben');
  eq(Number((await pool.query('SELECT count(*) n FROM work_jobs')).rows[0].n),0,'keine neue P20-Nebenwarteschlange');
  eq(Number((await pool.query('SELECT count(*) n FROM reverse_assets')).rows[0].n),0,'keine Kandidaten persistiert');
 });
 await section('Entropie gesamt/Block und 4096-Stichprobe sind getrennt und exakt',async()=>{
  const m=(await pool.query('SELECT metadaten FROM reverse_dateien WHERE id=12')).rows[0].metadaten,r=m.rv27;
  ok(r,'PG RV27 vorhanden');eq(r.entropie_stichprobe_4096,{wert:0,bytes:4096,bereich:'[0,min(groesse,4096))'},'Stichprobe Nullpraefix');
  eq(r.entropie_gesamt.wert,independentEntropy(entropy),'Gesamtentropie unabhaengig gerechnet');eq(r.entropie_gesamt.bytes,entropy.length,'alle Bytes');eq(r.entropie_gesamt.vollstaendig,true,'keine Stichprobenbehauptung');
  eq(r.entropie_bloecke,[{offset:'0',laenge:65536,entropie:0},{offset:'65536',laenge:65536,entropie:8}],'Blockwerte unabhaengig bekannt');
  eq(m.entropie_stichprobe_4096.wert,0,'Legacy-Stichprobe bleibt als solche');
  const empty=(await pool.query('SELECT metadaten FROM reverse_dateien WHERE id=14')).rows[0].metadaten.rv27;
  eq(empty.entropie_gesamt,{wert:null,bytes:0,vollstaendig:true},'keine Messung bei leerer Quelle');eq(empty.entropie_stichprobe_4096.wert,null,'leere Stichprobe unbekannt');
 });
 await section('Strukturgruppen, Bytebelege und plausible Kandidaten ohne Asset-Persistenz',async()=>{
  const r=success(await rev('struktur',{limit:20}),'Struktur');eq(r.gesamt_dateien,fixtures.length,'alle Dateien');eq(r.analysiert,fixtures.length,'alle analysiert');
  const pair=r.gruppen.find(g=>g.files.some(f=>f.path==='a.dat'));eq(pair.count,2,'Gruppe nach Endung/Magic/Groessenband');eq(pair.header_comparison.different_offsets,[8],'Headerdifferenz');eq(pair.header_comparison.bytes_compared,32,'32 Bytes verglichen');
  const e=r.gruppen.flatMap(g=>g.files).find(f=>f.path==='embedded.bin');
  const table=e.struktur_hypothesen.find(h=>h.type==='offsettabelle'&&h.endianness==='le');
  ok(table,'Tabellenhypothese');eq(table.evidence.offset,'0','Tabellenoffset ist Quellbereich');eq(table.evidence.bytes_hex,embedded.subarray(0,16).toString('hex'),'Bytebeleg');
  ok(e.struktur_hypothesen.every(h=>h.confidence>0&&h.confidence<=1&&h.evidence?.bytes_hex),'Hypothesen statt Behauptungen');
  const png=e.eingebettete_kandidaten.find(c=>c.format==='png'),bmp=e.eingebettete_kandidaten.find(c=>c.format==='bmp');
  eq(png.offset,'80','PNG gefunden');eq(png.length,null,'PNG Ende noch unbekannt');eq(bmp.offset,'240','BMP gefunden');eq(bmp.length,'54','BMP plausibler Bereich');
  ok(e.eingebettete_kandidaten.every(c=>c.candidate&&c.stored===false),'nur Kandidaten');ok(!e.eingebettete_kandidaten.some(c=>c.offset==='500'),'zufaelliges BM abgewiesen');
  const pages=[];for(let offset=0;offset<fixtures.length;offset+=2){const p=success(await rev('struktur',{offset,limit:2}),'Strukturseite');pages.push(...p.gruppen.flatMap(g=>g.files).map(f=>f.path));eq(p.naechster_offset,offset+2<fixtures.length?offset+2:null,'Fortsetzung');}
  eq([...pages].sort(),fixtures.map(f=>f.path).sort(),'Paging ohne Verlust/Duplikat');
  eq(Number((await pool.query('SELECT count(*) n FROM reverse_assets')).rows[0].n),0,'nur Metadaten/keine Assets');
 });
 await section('Echte REST/stdio-Fachantworten fuer RV27 und entziehbare Reverse-Bindung',async()=>{
  await override('agenten_ausweis');await override('hex_lesen');
  const t=await transports();
  for(const a of [{action:'struktur',reverse_id:RID,limit:20},{action:'struktur',reverse_id:RID,limit:2,offset:2}]){
   const r=success(await t.rest('reverse',{...a,token:t.token}),'REST Struktur'),s=success(await t.stdio('reverse',{...a,token:t.token}),'stdio Struktur');
   const expected=success(await rev(a.action,{reverse_id:RID,limit:a.limit,offset:a.offset}),'Core Struktur');
   const fach=x=>Object.fromEntries(Object.keys(expected).map(k=>[k,x[k]]));
   eq(normal(fach(r)),normal(expected),'REST=Core einschliesslich fachlicher null-Werte');
   eq(normal(fach(s)),normal(expected),'stdio=Core einschliesslich fachlicher null-Werte');
  }
  const source=fixtures[3],h=success(await t.rest('hex',{action:'hex',ref:source.ref,laenge:16,token:t.token}),'Hex Reverse Original');
  eq(h.zeilen[0].hex.replaceAll(' ',''),source.bytes.subarray(0,16).toString('hex'),'Originalbytes');
  const foreign=await core.stelleAgentTokenAus({project:Q,name:'rv27-foreign',rolle:'subagent'},{system:'user'});secrets.push(foreign.token);
  for(const send of [t.rest,t.stdio]){const x=await send('reverse',{action:'struktur',reverse_id:RID,token:foreign.token});eq(x.fehlercode,'nicht_gebunden','Fremdprojekt ohne Bindung');}
  await pool.query('UPDATE reverse_bindungen SET geloest_at=NOW() WHERE project=$1 AND eintrag_id=$2',[P,RID]);
  for(const send of [t.rest,t.stdio]){const x=await send('reverse',{action:'struktur',reverse_id:RID,token:t.token});eq(x.fehlercode,'nicht_gebunden','sofortiger Bindungsentzug');}
  const h2=await t.stdio('hex',{action:'hex',cursor:h.cursor,token:t.token});eq(h2.fehler,'nicht_gebunden','Hex-Cursor revalidiert gleiche Quelle');
  await pool.query('UPDATE reverse_bindungen SET geloest_at=NULL WHERE project=$1 AND eintrag_id=$2',[P,RID]);
  const again=success(await t.stdio('reverse',{action:'struktur',reverse_id:RID,token:t.token}),'Bindung wieder gueltig');eq(again.analysiert,fixtures.length,'Metadaten weiterlesbar');
  eq(Number((await pool.query('SELECT count(*) n FROM reverse_assets')).rows[0].n),0,'auch Transporte persistieren keine Kandidaten');
 });
}catch(e){failures.push('Setup/Lauf');console.error('FAIL Setup/Lauf: '+mask(e.stack??e));}finally{
 for(const fn of close.reverse())await fn().catch(()=>{});
 if(core)await core.closePool().catch(()=>{});
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>{});await admin.end();
 await rm(temp,{recursive:true,force:true});
 console.log('P21 RV27 CHECKS='+checks+' FAILURES='+failures.length+' '+failures.join('|'));
 if(failures.length)process.exitCode=1;
}
process.exit(process.exitCode??0);
