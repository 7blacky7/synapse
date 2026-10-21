/**
 * P21 Testphase Teil2 T7/T9: PG-Versionen/Rechte, Reverse, boesartige Formate, Adressen und echte REST/stdio-Paritaet.
 * Ausschliesslich synapse_test:5433, privates Schema/Sequenzen, temporaere Fixturebytes und Loopback-HTTP.
 */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=join(dirname(fileURLToPath(import.meta.url)),'../../..');
const dbUrl=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(dbUrl.port,'5433');assert.equal(dbUrl.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_COMPUTE_ADMISSION','SYNAPSE_COMPUTE_POLICY'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'1',SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const schema='p21_h5_'+process.pid+'_'+randomUUID().slice(0,8),P='p21-h5-test',Q='p21-h5-other',RID='rev-h5-fixture-000001';
const temp=await mkdtemp(join(tmpdir(),'p21-h5-')),assetRoot=join(temp,'projekte'),reverseRoot=join(temp,'reverse');
Object.assign(process.env,{SYNAPSE_ASSET_ENABLED:'1',SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_PROJEKTE_ROOT:assetRoot,SYNAPSE_REVERSE_ROOT:reverseRoot});
const require=createRequire(join(repo,'packages/core/package.json')),{Pool}=require('pg');
const admin=new Pool({connectionString:dbUrl.href});
const secrets=[],failures=[],close=[],sha=b=>createHash('sha256').update(b).digest('hex');
const mask=s=>secrets.reduce((s,k)=>s.replaceAll(k,'[GEHEIM]'),String(s)).replace(/sai_[a-z0-9]+/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
let core,pool,checks=0,seq=0,nextAsset=100,app,client,loopback,actor;
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
function pe(plus=false,base=plus?0x140000000n:0x400000n){
 const b=Buffer.alloc(1024);b.write('MZ');b.writeUInt32LE(128,60);b.write('PE\0\0',128);b.writeUInt16LE(plus?0x8664:0x14c,132);b.writeUInt16LE(1,134);
 const os=plus?240:224;b.writeUInt16LE(os,148);b.writeUInt16LE(2,150);const opt=152;
 b.writeUInt16LE(plus?0x20b:0x10b,opt);if(plus)b.writeBigUInt64LE(base,opt+24);else b.writeUInt32LE(Number(base),opt+28);
 b.writeUInt32LE(4096,opt+32);b.writeUInt32LE(512,opt+36);b.writeUInt32LE(8192,opt+56);b.writeUInt32LE(512,opt+60);
 const s=opt+os;b.write('.text',s);b.writeUInt32LE(384,s+8);b.writeUInt32LE(4096,s+12);b.writeUInt32LE(256,s+16);b.writeUInt32LE(512,s+20);b.writeUInt32LE(0x60000020,s+36);
 return b;
}
function elf(bits=64,le=true,va=0x400000n){
 const b=Buffer.alloc(512);Buffer.from([127,69,76,70,bits===64?2:1,le?1:2,1]).copy(b);
 const w16=(v,o)=>le?b.writeUInt16LE(v,o):b.writeUInt16BE(v,o),w32=(v,o)=>le?b.writeUInt32LE(v,o):b.writeUInt32BE(v,o),w64=(v,o)=>le?b.writeBigUInt64LE(v,o):b.writeBigUInt64BE(v,o);
 w16(2,16);w16(bits===64?62:3,18);w32(1,20);const at=bits===64?64:52;
 if(bits===64){w64(va,24);w64(64n,32);w16(64,52);w16(56,54);w16(1,56);w16(64,58);
  w32(1,at);w32(5,at+4);w64(256n,at+8);w64(va,at+16);w64(64n,at+32);w64(128n,at+40);w64(1n,at+48);
 }else{w32(Number(va),24);w32(52,28);w16(52,40);w16(32,42);w16(1,44);w16(40,46);
  w32(1,at);w32(256,at+4);w32(Number(va),at+8);w32(64,at+16);w32(128,at+20);w32(5,at+24);w32(1,at+28);
 }return b;
}
function ne(){
 const b=Buffer.alloc(512);b.write('MZ');b.writeUInt32LE(64,60);b.write('NE',64);b.writeUInt16LE(2,64+28);b.writeUInt16LE(64,64+34);b.writeUInt16LE(8,64+50);
 b.writeUInt16LE(1,128);b.writeUInt16LE(16,130);b.writeUInt16LE(32,134);b.writeUInt16LE(16,142);return b;
}
function linear(tag='le',flag=0){
 const b=Buffer.alloc(544);b.write('MZ');b.writeUInt32LE(64,60);b.write(tag.toUpperCase(),64);b.writeUInt32LE(1,64+20);b.writeUInt32LE(16,64+40);b.writeUInt32LE(tag==='le'?8:0,64+44);
 b.writeUInt32LE(176,64+64);b.writeUInt32LE(1,64+68);b.writeUInt32LE(200,64+72);b.writeUInt32LE(512,64+128);
 b.writeUInt32LE(24,240);b.writeUInt32LE(65536,244);b.writeUInt32LE(1,252);b.writeUInt32LE(1,256);
 if(tag==='le'){b.writeUIntBE(1,264,3);b[267]=flag;}else{b.writeUInt32LE(0,264);b.writeUInt16LE(8,268);b.writeUInt16LE(flag,270);}return b;
}

async function asProject(project,action,args={}) {
 const p={art:'legacy',project,agent_id:'hex-test'};
 return core.mitAgentAufrufKontext({...context(),principal:p},()=>core.fuehreHexAus({action,project,...args},{apiAusfuehrung:true}));
}
async function userCall(action,args={}) {
 const {mitUserHerkunft}=await import('../dist/services/user-herkunft.js');
 return mitUserHerkunft('web-ui-chat',()=>call(action,args));
}
async function tokenCall(token,action,args={},project=P) {
 const {mitAgentToolAufruf}=await import('../dist/services/agent-token-tools.js');
 return mitAgentToolAufruf('hex',{action,project,token,...args},'p21-h5-test',async k=>k.antwort??core.fuehreHexAus(k.args,{apiAusfuehrung:true}));
}
async function rejectsSql(sql,params,label) {
 checks++;await assert.rejects(pool.query(sql,params),/hex_format_version_unveraenderlich/,label);
}
const definition=(seq=[{id:'head',type:'u1'}],extra={})=>({profil:'kaitai-read-v1',meta:{id:'h5_fixture',endian:'le'},seq,...extra});
async function reverseFile(id,path,bytes) {
 const key=RID+'/binaries/'+path;await mkdir(dirname(join(reverseRoot,key)),{recursive:true});await writeFile(join(reverseRoot,key),bytes);
 await row('reverse_dateien',{id,eintrag_id:RID,medium_id:1,art:'binaer',pfad:path,sha256:sha(bytes),groesse:bytes.length,storage_key:key});
 return {art:'reverse_datei',reverse_id:RID,id:String(id)};
}
try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows)await admin.query('CREATE TABLE '+schema+'.'+quote(tablename)+' (LIKE public.'+quote(tablename)+' INCLUDING ALL)');
 const serials=(await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%'",[schema])).rows;
 for(const [i,c]of serials.entries()){const s=schema+'.private_serial_'+i;await admin.query('CREATE SEQUENCE '+s);await admin.query('ALTER TABLE '+schema+'.'+quote(c.table_name)+' ALTER COLUMN '+quote(c.column_name)+" SET DEFAULT nextval('"+s+"'::regclass)");}
 dbUrl.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=dbUrl.href;
 core=await import('../dist/index.js');pool=core.getPool();
 eq((await pool.query('SELECT current_database() d,current_schema() s')).rows[0],{d:'synapse_test',s:schema},'privates Testschema');
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','agent-ausweis-fristen-schema','agent-ausweis-projekte-schema','hex-schema','hex-formate-schema','reverse-erkenntnisse-schema','hex-exe-formate-schema','hex-analysen-schema','work-jobs-schema']){
  const mod=await import('../dist/db/'+file+'.js'),sql=Object.values(mod).find(v=>typeof v==='string');await pool.query(sql);await pool.query(sql);
 }
 // Keine Sequenz aus public verwenden, auch fuer die Ausweis-Numerierung nicht.
 await pool.query('CREATE SEQUENCE IF NOT EXISTS '+schema+'.agent_ausweis_nr');
 for(const p of [P,Q])await row('projects',{name:p,path:join(temp,p),hostname:'synthetic',enabled:true});
 actor={art:'legacy',project:P,agent_id:'hex-test'};

 const ref=await textFile('data.txt','ABCDEFGHIJKLMNOPQRSTUVWX');
 const exeRef=await asset('program.exe',pe());
 const immutable=await import('../dist/services/hex-exe-formate.js');
 let saved,reverseRef,transport;

 await section('PG-Schema/Seed idempotent, 18 kanonische Freigaben und unveraenderliche Versionen',async()=>{
  const {pruefeHexFormat}=await import('../dist/services/hex-format-sprache.js');
  const {leseHexEinstellungen}=await import('../dist/services/hex-einstellungen.js');
  const stand=await leseHexEinstellungen(P);
  const seeded=(await pool.query("SELECT f.id,f.name,v.version,v.canonical_hash,v.definition,g.format_id published FROM hex_formate f JOIN hex_format_versionen v ON v.format_id=f.id LEFT JOIN hex_format_freigaben g ON g.format_id=v.format_id AND g.version=v.version WHERE f.project='__synapse_exe_formate__' ORDER BY f.id")).rows;
  eq(seeded.length,18,'18 Versionen, kein doppelter Seed');
  eq(new Set(seeded.map(r=>r.id)).size,18,'18 stabile IDs');
  for(const r of seeded){
   eq(r.version,1,'Version 1');eq(r.published,r.id,'global freigegeben');
   eq(r.canonical_hash,pruefeHexFormat(r.definition,stand).hash,'PG JSONB kanonisch '+r.name);
   eq(r.canonical_hash,immutable.hexExeFormatHash(immutable.hexExeFormat(r.name)),'Hash passt zum mitgelieferten Katalog');
  }
  const id=seeded[0].id;
  for(const table of ['hex_format_versionen','hex_format_freigaben']){
   await rejectsSql('UPDATE '+table+' SET version=version WHERE format_id=$1',[id],'Update verhindert');
   await rejectsSql('DELETE FROM '+table+' WHERE format_id=$1',[id],'Delete verhindert');
  }
 });
 await section('Produktstandard AUS, getrennte zeitlich befristete Freigaben und Produktionsprozess',async()=>{
  const s=success(await call('status'),'status');eq(s.formate_schalter.aktiv,false,'Formate Standard AUS');eq(s.adressen_schalter.aktiv,false,'Adressen Standard AUS');
  await override('hex_lesen');
  eq((await call('format_liste')).fehler,'hex_formate_deaktiviert','Formate gesperrt');
  eq((await call('adressen',{ref:exeRef,von:'rva',adresse:4096})).fehler,'hex_adressen_deaktiviert','Adressen gesperrt');
  await override('hex_formate');await override('hex_adressen');
  const r=success(await call('format_liste'),'Override');eq(r.formate.length,18,'publizierte Formate sichtbar');
  for(const [gate,action,args,error]of [
   ['hex_formate','format_liste',{},'hex_formate_deaktiviert'],
   ['hex_adressen','adressen',{ref:exeRef,von:'rva',adresse:4096},'hex_adressen_deaktiviert']
  ]){
   await override(gate,true,true);eq((await call(action,args)).fehler,error,'Ablauf '+gate);
   await override(gate);
  }
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
  const childScript='const {leseHexEinstellungen}=await import('+JSON.stringify(new URL('../dist/services/hex-einstellungen.js',import.meta.url).href)+');const {closePool}=await import('+JSON.stringify(new URL('../dist/db/client.js',import.meta.url).href)+');const s=await leseHexEinstellungen('+JSON.stringify(P)+');console.log(JSON.stringify([s.schalter.aktiv,s.formate_schalter.aktiv,s.adressen_schalter.aktiv]));await closePool();process.exit(0);';
  const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',childScript],{env:{...process.env,SYNAPSE_INTERN_TOOL:'0'},timeout:10000});
  eq(JSON.parse(stdout.trim()),[false,false,false],'Produktionsprozess ignoriert Testoverride');
 });
 await section('PG-Ablage/Herkunft, Neustart, optimistische Konkurrenz und exakte Versionen',async()=>{
  const thought=randomUUID();await row('thoughts',{id:thought,project:P,content:'synthetic h5 origin'});
  saved=success(await call('format_speichern',{format:definition(),beschreibung:'Fixture',erkennung:{magic:[{offset:0,hex:'4142'}],endungen:['exe'],min_bytes:1},herkunft:{thought_id:thought}}),'Speichern');
  eq(saved.format_version,1,'Erste Version');
  const one=success(await call('format_liste',{format_id:saved.format_id,format_version:1,mit_format:true}),'Version lesen');
  eq(one.format,definition(),'JSONB Definition');eq(one.herkunft.thought_id,thought,'Herkunft persistent');eq(one.erkennung.magic[0].offset,'0','Erkennung normalisiert');eq(one.status,'entwurf','Entwurf');
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
  const script='const {getPool,closePool}=await import('+JSON.stringify(new URL('../dist/db/client.js',import.meta.url).href)+');console.log(JSON.stringify((await getPool().query("SELECT canonical_hash,definition FROM hex_format_versionen WHERE format_id=$1 AND version=1",['+JSON.stringify(saved.format_id)+'])).rows[0]));await closePool();process.exit(0);';
  const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{env:process.env,timeout:10000});
  eq(JSON.parse(stdout.trim()),{canonical_hash:saved.canonical_hash,definition:definition()},'separater Prozess liest dieselbe PG Version');
  const next=definition([{id:'head',type:'u2'}]);
  const race=await Promise.all([1,2].map(()=>call('format_speichern',{format_id:saved.format_id,basis_version:1,format:next})));
  eq(race.filter(r=>r.success).length,1,'genau ein konkurrierender Autor gewinnt');
  eq(race.find(r=>!r.success).fehler,'format_versionskonflikt','Verlierer expliziter Konflikt');
  eq((await pool.query('SELECT version FROM hex_format_versionen WHERE format_id=$1 ORDER BY version',[saved.format_id])).rows.map(r=>r.version),[1,2],'atomare Versionskette');
  eq((await call('format_speichern',{format_id:saved.format_id,basis_version:1,format:definition()})).fehler,'format_versionskonflikt','alte Basis abgewiesen');
  eq((await call('format_speichern',{format_id:saved.format_id,basis_version:2,format:definition(),format_name:'renamed'})).fehler,'format_name_abweichend','stabiler Name');
  eq((await asProject(Q,'format_liste',{format_id:saved.format_id,format_version:1,mit_format:true})).fehler,'format_nicht_gefunden','fremder Entwurf verborgen');
  eq((await asProject(Q,'format_speichern',{format_id:saved.format_id,basis_version:2,format:definition()})).fehler,'format_fremdes_projekt','fremdes Fortschreiben gesperrt');
  const derived=success(await call('format_speichern',{format:definition(),basis_format:{format_id:saved.format_id,version:1}}),'Ableitung');
  const detail=success(await call('format_liste',{format_id:derived.format_id,format_version:1,mit_format:true}),'Ableitung lesen');
  eq(detail.basis,{format_id:saved.format_id,version:1,canonical_hash:saved.canonical_hash},'Ableitung exakt');
  const r=success(await call('format_anwenden',{ref,format_id:saved.format_id,format_version:1}),'exakte alte Version');
  eq(r.baum[0].wert.dezimal,'65','Version 1 interpretiert u1');
  const v2=success(await call('format_anwenden',{ref,format_id:saved.format_id,format_version:2}),'Version 2');
  eq(v2.baum[0].wert.dezimal,'16961','Version 2 interpretiert u2');
 });
 await section('Verwaltungsrechte, keine Selbstbehauptung und Freigabe nur der exakten Version',async()=>{
  eq((await call('format_speichern',{format_id:saved.format_id,format_version:1,veroeffentlichen:true})).fehler,'keine_berechtigung','Legacy Name ohne verwaltete Rolle reicht nicht');
  await override('agenten_ausweis');
  const coord=await core.stelleAgentTokenAus({project:P,name:'h5-koordinator',rolle:'koordinator'},{system:'user'});
  const sub=await core.stelleAgentTokenAus({project:P,name:'h5-sub',rolle:'subagent'},{system:'user'});
  secrets.push(coord.token,sub.token);
  const denied=await tokenCall(sub.token,'format_speichern',{format_id:saved.format_id,format_version:1,veroeffentlichen:true});
  eq(denied.success,false,'Subagent darf nicht publizieren');eq(denied.fehler??denied.error,'keine_berechtigung','Subagent Fehler');
  success(await tokenCall(coord.token,'format_speichern',{format_id:saved.format_id,format_version:1,veroeffentlichen:true}),'echter Koordinator publiziert');
  const foreign=success(await asProject(Q,'format_liste',{format_id:saved.format_id,format_version:1,mit_format:true}),'global lesbar');
  eq(foreign.status,'freigegeben','Version 1 freigegeben');
  eq((await asProject(Q,'format_liste',{format_id:saved.format_id,format_version:2,mit_format:true})).fehler,'format_nicht_gefunden','Version 2 bleibt Entwurf');
  eq((await asProject(Q,'format_speichern',{format:definition(),basis_format:{format_id:saved.format_id,version:2}})).fehler,'format_nicht_gefunden','unpublizierte Basis verboten');
  const pub2=success(await userCall('format_speichern',{format_id:saved.format_id,format_version:2,veroeffentlichen:true}),'authentifizierter UI User publiziert');
  eq(pub2.format_version,2,'User publiziert exakte v2');
  await rejectsSql('UPDATE hex_format_freigaben SET freigegeben_von=$1 WHERE format_id=$2',['attacker',saved.format_id],'Freigabe unveraenderlich');
  const all=[];let after;
  for(let i=0;i<100;i++){
   const page=success(await call('format_liste',{limit:3,...(after?{liste_nach:after}:{})}),'Listenseite');
   all.push(...page.formate.map(f=>f.format_id+':'+f.format_version));
   if(page.vollstaendig)break;ok(page.liste_nach!==after,'Keyset schreitet fort');after=page.liste_nach;
  }
  eq(new Set(all).size,all.length,'Keyset ohne Duplikate');
  eq(all.length,Number((await pool.query('SELECT count(*) n FROM hex_format_versionen')).rows[0].n),'Liste vollstaendig');
 });

 await section('Boesartige Definitionen atomar abgewiesen; keine Imports/Prozesse/rekursiven Typen',async()=>{
  const before=Number((await pool.query('SELECT count(*) n FROM hex_format_versionen')).rows[0].n);
  const cases=[
   definition([{id:'x',type:'u1',process:'eval'}]),
   definition([{id:'x',type:'bytes',size:'process.exit()'}]),
   definition([{id:'x',type:'external::node'}]),
   definition([{id:'constructor',type:'u1'}]),
   definition([{id:'x',type:'bytes',size:'_root.__proto__'}]),
   definition([{id:'x',type:'u1'}],{imports:['http://127.0.0.1/evil']}),
   definition([{id:'x',type:'loop'}],{types:{loop:{seq:[{id:'again',type:'loop'}]}}}),
   definition([{id:'payload',type:'bytes',size:'future'},{id:'future',type:'u1'}]),
   definition([{id:'x',type:'str',size:3,encoding:'unsafe'}]),
   definition([{id:'x',type:'u1',repeat:'until','repeat-until':'true'}]),
   definition([{id:'x',type:'u1',if:'import("node:fs")'}]),
   definition([{id:'x',type:'u1'}],{meta:{id:'h5_fixture',endian:'host'}}),
   definition([{id:'x',type:'u1'}],{meta:{id:'h5_fixture',ks_version:'0.10',endian:'le'}}),
   definition([{id:'x',type:'u1'}],{instances:{x:{pos:0,type:'u1',io:'external'}}}),
  ];
  const cyclic=definition();cyclic.self=cyclic;cases.push(cyclic);
  for(const [i,format]of cases.entries()){
   const r=await call('format_speichern',{format});eq(r.success,false,'malicious '+i);
  }
  eq(Number((await pool.query('SELECT count(*) n FROM hex_format_versionen')).rows[0].n),before,'keine Teilversion bei Validierungsfehler');
  await budgets({format_bytes:256,max_format_felder:2});
  eq((await call('format_speichern',{format:definition([{id:'a',type:'u1'},{id:'b',type:'u1'},{id:'c',type:'u1'}])})).success,false,'Feldbudget');
  eq((await call('format_speichern',{format:definition(),beschreibung:'x'.repeat(300)})).success,false,'Metadaten zaehlen zum Formatbudget');
  await resetBudgets();
 });
 await section('Runtime-Ausdruecke/Spans strikt: Ueberlauf, Nullteiler, EOF und begrenzte Ausgabe',async()=>{
  for(const size of ['1 / 0','18446744073709551615 + 1','-1','1 << 64']){
   const f=await call('format_speichern',{format:definition([{id:'payload',type:'bytes',size}])});
   // Konstante Fehler duerfen bei Validierung oder spaetestens vor dem Lesen scheitern.
   const r=f.success?await call('format_anwenden',{ref,format_id:f.format_id,format_version:1}):f;
   eq(r.success,false,'Runtime lehnt '+size+' ab');
  }
  const f=success(await call('format_speichern',{format:definition([{id:'payload',type:'bytes',size:25}])}),'EOF Format');
  eq((await call('format_anwenden',{ref,format_id:f.format_id,format_version:1})).success,false,'keine Teilfelder jenseits EOF');
  await budgets({antwort_zeichen:128});
  eq((await call('format_anwenden',{ref,format_id:saved.format_id,format_version:1})).fehler,'budget_ueberschritten','Gesamthuelle wird begrenzt');
  await resetBudgets();
 });
 await section('Persistente Baumseiten: exakte Feldfolge, keine Bytewerte im Cursor, Quelle/Akteur/Ablauf',async()=>{
  const fmt=definition([{id:'count',type:'u1'},{id:'items',type:'u1',repeat:'expr','repeat-expr':'count'}]);
  const bytes=await asset('array.bin',Buffer.from([8,11,12,13,14,15,16,17,18]));
  const f=success(await call('format_speichern',{format:fmt}),'Arrayformat');
  const full=success(await call('format_anwenden',{ref:bytes,format_id:f.format_id,format_version:1}),'voller Baum');
  await budgets({max_struktur_knoten:2});
  let page=success(await call('format_anwenden',{ref:bytes,format_id:f.format_id,format_version:1}),'erste Baumseite');
  const first=page,all=[...page.baum],seen=new Set();
  for(let i=0;page.cursor&&i<30;i++){
   ok(!seen.has(page.cursor),'Cursor-ID neu');seen.add(page.cursor);
   page=success(await call('format_anwenden',{cursor:page.cursor}),'Baumfortsetzung');
   all.push(...page.baum);
  }
  eq(page.vollstaendig,true,'Cursor erreicht Ende');eq(all,full.baum,'Seiten exakt wie voller Baum');
  const stored=(await pool.query('SELECT * FROM hex_format_cursor WHERE id=$1',[first.cursor])).rows[0];
  eq(stored.format_version,1,'Version im PG Cursor');ok(!JSON.stringify(stored.zustand).includes('"wert"'),'keine Bytewerte im Cursor');
  const originalActor=actor;actor={...actor,agent_id:'foreign-h5'};
  eq((await call('format_anwenden',{cursor:first.cursor})).fehler,'cursor_abgelaufen','anderer Akteur gesperrt');actor=originalActor;
  eq((await asProject(Q,'format_anwenden',{cursor:first.cursor})).fehler,'cursor_abgelaufen','anderes Projekt gesperrt');
  eq((await call('format_anwenden',{cursor:first.cursor,format_version:1})).fehler,'cursor_ungueltig','Cursorparameter nicht mischbar');
  await pool.query("UPDATE hex_format_cursor SET expires_at=NOW()-interval '1 second' WHERE id=$1",[first.cursor]);
  eq((await call('format_anwenden',{cursor:first.cursor})).fehler,'cursor_abgelaufen','abgelaufener Cursor');
  await resetBudgets();
  const mutable=await textFile('mutable.txt','abcdefgh');
  const mf=success(await call('format_speichern',{format:definition([{id:'items',type:'u1',repeat:'expr','repeat-expr':8}])}),'Textarray');
  await budgets({max_struktur_knoten:2});
  const m=success(await call('format_anwenden',{ref:mutable,format_id:mf.format_id,format_version:1}),'Textcursor');
  await pool.query("UPDATE code_files SET content='changed!' WHERE project=$1 AND file_path=$2",[P,'mutable.txt']);
  eq((await call('format_anwenden',{cursor:m.cursor})).fehler,'quelle_geaendert','Textrevision pinnt Cursor');
  await resetBudgets();
 });
 await section('Adressen an PG-Assets: PE32/64, Header/BSS/Overlay, ganze Spans und RVA/VA-Rueckweg',async()=>{
  for(const plus of [false,true]){
   const b=pe(plus),rref=await asset('pe'+(plus?64:32)+'.exe',b);
   let r=success(await call('adressen',{ref:rref,von:'rva',adresse:'0x1010'}),'PE');
   eq(r.zuordnungen[0].datei_offset.dezimal,'528','RVA -> Datei');
   eq(r.zuordnungen[0].bereich.name,'.text','Sektionsname');
   const back=success(await call('adressen',{ref:rref,von:'va',adresse:r.zuordnungen[0].va.dezimal}),'VA Rueckweg');
   eq(back.zuordnungen[0].datei_offset.dezimal,'528','VA -> Datei');
   const disk=success(await call('adressen',{ref:rref,von:'datei_offset',adresse:528}),'Datei Rueckweg');
   eq(disk.zuordnungen[0].rva.hex,'0x1010','Datei -> RVA');
   r=success(await call('adressen',{ref:rref,von:'rva',adresse:16}),'Header');eq(r.zuordnungen[0].bereich.art,'header','Header korrekt');
   r=success(await call('adressen',{ref:rref,von:'rva',adresse:'0x1100'}),'BSS');eq(r.zuordnungen[0].datei_offset,null,'BSS ohne erfundene Bytes');eq(r.zuordnungen[0].status,'nur_speicher','BSS markiert');
   r=success(await call('adressen',{ref:rref,von:'rva',adresse:'0x10ff',adress_bytes:2}),'Span Raw/BSS');eq(r.zuordnungen[0].datei_offset,null,'ganzer Span muss abbildbar sein');
   r=success(await call('adressen',{ref:rref,von:'datei_offset',adresse:900}),'Overlay');eq(r.status,'nicht_zugeordnet','Overlay kein Speicher');
   r=success(await call('adressen',{ref:rref,von:'rva',adresse:'0x117f',adress_bytes:2}),'Sektionsgrenze');eq(r.zuordnungen,[],'nicht ueber Bereichsende mappen');
   eq((await call('adressen',{ref:rref,von:'datei_offset',adresse:1024})).fehler,'bereich_ausserhalb','EOF nicht mappen');
   eq((await call('adressen',{ref:rref,von:'datei_offset',adresse:1023,adress_bytes:2})).fehler,'bereich_ausserhalb','Span hinter EOF');
  }
  for(const adresse of [-1,1.2,9007199254740992,'18446744073709551616','0x10000000000000000','1e3','0xzz'])
   eq((await call('adressen',{ref:exeRef,von:'va',adresse})).fehler,'adresse_ungueltig','Adressvalidierung');
  eq((await call('adressen',{ref:exeRef,von:'rva',adresse:4096,adress_bytes:0})).fehler,'adresse_ungueltig','Nullspan');
  eq((await call('adressen',{ref:exeRef,von:'rva',adresse:4096,ladebasis:'18446744073709551615'})).fehler,'adresse_ueberlauf','Rebase ohne Wrap');
  const overlap=pe();overlap.writeUInt16LE(2,134);overlap.copy(overlap,416,376,416);
  const or=await asset('overlap.exe',overlap);
  eq(success(await call('adressen',{ref:or,von:'rva',adresse:4096}),'ueberlappende Sektionen').mehrdeutig,true,'alle Zuordnungen statt Zufall');
  await budgets({max_fundstellen:1});
  eq((await call('adressen',{ref:or,von:'rva',adresse:4096})).fehler,'budget_ueberschritten','Treffer nicht still abschneiden');
  await resetBudgets();
  await budgets({scan_bytes:1});
  eq((await call('adressen',{ref:exeRef,von:'rva',adresse:4096})).fehler,'budget_ueberschritten','Headerlesebudget');
  await resetBudgets();
 });
 await section('ELF32/64 LE/BE, hoher u64-VA, NE/LE/LX/MZ und mitgelieferte Format-Folgekette',async()=>{
  for(const bits of [32,64])for(const le of [true,false]){
   const base=bits===64?0xffff800000001000n:0x8048000n;
   const rref=await asset('elf'+bits+(le?'le':'be'),elf(bits,le,base));
   const r=success(await call('adressen',{ref:rref,von:'va',adresse:(base+16n).toString()}),'ELF');
   eq(r.zuordnungen[0].datei_offset.dezimal,'272','ELF PT_LOAD');
   eq(r.zuordnungen[0].quell_va.dezimal,(base+16n).toString(),'u64 ohne Praezisionsverlust');
   const follow=success(await call('format_anwenden',{...r.formate.folgeaufruf,feldpfad:'$.programs.entries[0].p_vaddr'}),'ELF Formatfolge');
   eq(follow.baum[0].wert.dezimal,base.toString(),'Seedformat aus PG interpretiert exakten Header');
  }
  for(const [name,b,args,off]of [
   ['ne',ne(),{von:'segment_offset',segment:1,adresse:4},'260'],
   ['le',linear('le'),{von:'va',adresse:'0x10004'},'516'],
   ['lx',linear('lx'),{von:'va',adresse:'0x10004'},'516'],
  ]){
   const rref=await asset(name+'.exe',b),r=success(await call('adressen',{ref:rref,...args}),name);
   eq(r.format,name,'Format erkannt');eq(r.zuordnungen[0].datei_offset.dezimal,off,'exakte '+name+' Abbildung');
   if(name==='ne')eq((await call('adressen',{ref:rref,von:'va',adresse:1})).fehler,'ne_segmentadresse_erforderlich','NE keine flache VA');
  }
  const mz=Buffer.alloc(80);mz.write('MZ');mz.writeUInt16LE(64,2);mz.writeUInt16LE(1,4);mz.writeUInt16LE(2,8);mz.writeUInt16LE(1,10);
  const mr=await asset('mz.exe',mz);
  eq((await call('adressen',{ref:mr,von:'va',adresse:4})).fehler,'ladebasis_erforderlich','MZ verlangt Ladebasis');
  eq(success(await call('adressen',{ref:mr,von:'va',adresse:'0x10004',ladebasis:'0x10000'}),'MZ').zuordnungen[0].datei_offset.dezimal,'36','MZ Modul');
  const encoded=await asset('encoded.lx',linear('lx',1));
  const enc=success(await call('adressen',{ref:encoded,von:'va',adresse:'0x10004'}),'kodiertes LX');eq(enc.zuordnungen[0].datei_offset,null,'keine linearen Bytes');eq(enc.zuordnungen[0].va,null,'keine scheinbare flache VA');
  const bad=pe();bad.writeUInt16LE(500,134);const badref=await asset('incomplete.exe',bad);
  eq(success(await call('adressen',{ref:badref,von:'rva',adresse:'0xf0000000'}),'abgeschnittene Tabelle').status,'karte_unvollstaendig','kein falsches Negativergebnis');
 });

 await section('Reverse Originaldatei: aktuelle S1/S3-Funktionen, Fingerprint/Hash/Dateibindung und Symbolseiten',async()=>{
  await row('reverse_eintraege',{id:RID,titel:'H5 Fixture',status:'bestaetigt'});
  await row('reverse_medien',{id:1,eintrag_id:RID,position:0,art:'datei'});
  await row('reverse_bindungen',{id:1,eintrag_id:RID,project:P,gebunden_von:'test'});
  reverseRef=await reverseFile(1,'original.exe',pe());
  const fingerprint=sha(Buffer.from('stage-v1'));
  for(const [stage,path]of [['S1','disassembly.asm'],['S3','decompiled.c']]){
   await row('reverse_schichten',{id:stage==='S1'?1:3,datei_id:1,eintrag_id:RID,schicht:stage,fingerabdruck:fingerprint,aktuell:true,status:'fertig'});
   await row('reverse_code_dateien',{id:'file-'+stage,eintrag_id:RID,datei_id:1,file_path:path,file_name:path,file_type:stage==='S1'?'asm':'c',schicht:stage,fingerabdruck:fingerprint});
   await row('reverse_code_symbole',{id:'symbol-'+stage,eintrag_id:RID,datei_id:1,file_path:path,symbol_type:'function',name:'fun_'+stage,line_start:4,line_end:8,schicht:stage,fingerabdruck:fingerprint,adresse:'4198400',groesse_bytes:32});
  }
  const r=success(await call('adressen',{ref:reverseRef,von:'rva',adresse:'0x1010'}),'Reverse Adresse');
  eq(r.reverse.symbole.map(s=>s.name).sort(),['fun_S1','fun_S3'],'S1/S3 Funktionen der Originaldatei');
  ok(r.reverse.symbole.every(s=>s.fingerabdruck===fingerprint&&s.line_start===4),'Provenienz bis Zeile und Fingerprint');
  const p=success(await call('adressen',{ref:reverseRef,von:'rva',adresse:'0x1010',symbol_limit:1}),'Symbolseite1');
  eq(p.reverse.symbole.length,1,'Symbolseitenlimit');eq(p.reverse.naechster_symbol_offset,'1','Fortsetzung');
  const p2=success(await call('adressen',{ref:reverseRef,von:'rva',adresse:'0x1010',symbol_limit:1,symbol_offset:p.reverse.naechster_symbol_offset}),'Symbolseite2');
  ok(p.reverse.symbole[0].id!==p2.reverse.symbole[0].id,'keine doppelten Symbole');
  await pool.query("UPDATE reverse_code_symbole SET fingerabdruck=$1 WHERE schicht='S3'",[sha(Buffer.from('stale'))]);
  eq(success(await call('adressen',{ref:reverseRef,von:'rva',adresse:'0x1010'}),'stale Fingerprint').reverse.symbole.map(s=>s.name),['fun_S1'],'staler Fingerprint verborgen');
  await pool.query("UPDATE reverse_schichten SET aktuell=false WHERE schicht='S1'");
  eq(success(await call('adressen',{ref:reverseRef,von:'rva',adresse:'0x1010'}),'stale Schicht').reverse.symbole,[],'nicht aktuelle Schicht verborgen');
  await pool.query("UPDATE reverse_schichten SET aktuell=true WHERE schicht='S1'");
  await pool.query("UPDATE reverse_code_symbole SET groesse_bytes=NULL WHERE schicht='S1'");
  eq(success(await call('adressen',{ref:reverseRef,von:'rva',adresse:'0x1010'}),'ohne Ausdehnung').reverse.symbole,[],'keine erfundene Funktionsausdehnung');
  eq(success(await call('adressen',{ref:reverseRef,von:'rva',adresse:'0x1000'}),'exaktes Symbol').reverse.symbole.length,1,'exakte Adresse ohne Groesse erlaubt');
  // Direkte Verbindung zur selben Originaldatei ist zwingend, auch bei passendem Pfad/Fingerprint.
  await pool.query("UPDATE reverse_code_dateien SET datei_id=2 WHERE schicht='S1'");
  eq(success(await call('adressen',{ref:reverseRef,von:'rva',adresse:'0x1000'}),'fremde Originaldatei').reverse.symbole,[],'fremde Dateikette verborgen');
  await pool.query("UPDATE reverse_code_dateien SET datei_id=1 WHERE schicht='S1'");
  const hash=(await pool.query('SELECT sha256 FROM reverse_dateien WHERE id=1')).rows[0].sha256;
  await pool.query('UPDATE reverse_dateien SET sha256=$1 WHERE id=1',[sha(Buffer.from('changed source'))]);
  eq((await call('adressen',{ref:r.ref,von:'rva',adresse:'0x1000'})).fehler,'quelle_geaendert','gepinnten Quellhash erneut pruefen');
  await pool.query('UPDATE reverse_dateien SET sha256=$1 WHERE id=1',[hash]);
 });
 await section('Reverse-Formatcursor revalidiert Bindung, Retention bleibt bytefrei; Adressen pruefen nach dem Lesen',async()=>{
  ok(reverseRef,'Reversefixture steht');
  const f=success(await call('format_speichern',{format:definition([{id:'bytes',type:'u1',repeat:'expr','repeat-expr':16}]),herkunft:{reverse_id:RID}}),'Format mit Reverseherkunft');
  await budgets({max_struktur_knoten:2});
  const page=success(await call('format_anwenden',{ref:reverseRef,format_id:f.format_id,format_version:1}),'Reverse Formatcursor');
  ok(page.cursor,'Reversecursor');
  const held=(await pool.query("SELECT * FROM reverse_ansicht_retention WHERE ref_key=$1",['hex-format-cursor:'+page.cursor])).rows[0];
  eq(held.eintrag_id,RID,'Retention auf Originaleintrag');eq(held.sha256,sha(pe()),'Retention pinnt Hash');
  await pool.query('UPDATE reverse_bindungen SET geloest_at=NOW() WHERE project=$1 AND eintrag_id=$2',[P,RID]);
  eq((await call('format_anwenden',{cursor:page.cursor})).fehler,'nicht_gebunden','Blaettern nach Loesung verweigert');
  eq((await call('adressen',{ref:reverseRef,von:'rva',adresse:4096})).fehler,'nicht_gebunden','Adressen nach Loesung verweigert');
  eq((await call('format_speichern',{format:definition(),herkunft:{reverse_id:RID}})).fehler,'nicht_gebunden','fremde/aufgehobene Herkunft abgewiesen');
  await pool.query('UPDATE reverse_bindungen SET geloest_at=NULL WHERE project=$1 AND eintrag_id=$2',[P,RID]);await resetBudgets();
  // Echte PG-Aenderung am Read-Barrier: kein DB-Mock. Widerruf nach Symbolabfrage, vor Source-Nachpruefung.
  const nativeQuery=pool.query.bind(pool);let revoked=false;
  pool.query=async(...args)=>{
   const result=await nativeQuery(...args);
   const sql=typeof args[0]==='string'?args[0]:args[0]?.text;
   if(!revoked&&sql?.includes('FROM reverse_code_symbole s JOIN reverse_dateien')){
    revoked=true;await nativeQuery('UPDATE reverse_bindungen SET geloest_at=NOW() WHERE project=$1 AND eintrag_id=$2',[P,RID]);
   }
   return result;
  };
  try{eq((await call('adressen',{ref:reverseRef,von:'rva',adresse:4096})).fehler,'nicht_gebunden','Widerruf waehrend Aufruf unterdrueckt Antwort');ok(revoked,'Read-Barrier wurde erreicht');}
  finally{pool.query=nativeQuery;await pool.query('UPDATE reverse_bindungen SET geloest_at=NULL WHERE project=$1 AND eintrag_id=$2',[P,RID]);}
 });
 await section('Echte REST und SDK/stdio: vollstaendige Fachantworten fuer T7/T9 gleich',async()=>{
  transport=await transports();
  const fmt=success(await call('format_speichern',{format:definition([{id:'items',type:'u1',repeat:'expr','repeat-expr':8}])}),'Transportformat');
  const calls=[
   {action:'format_liste',format_id:saved.format_id,format_version:1,mit_format:true},
   {action:'format_liste',limit:5},
   {action:'format_liste',format_id:saved.format_id,limit:20},
   {action:'format_anwenden',ref,format_id:saved.format_id,format_version:1},
   {action:'format_anwenden',ref:exeRef,format_id:immutable.hexExeFormat('exe-pe').format_id,format_version:1,feldpfad:'$.sections[0].raw_pointer'},
   {action:'format_speichern',format:definition([{id:'x',type:'bytes',size:'process.exit()'}])},
   {action:'format_speichern',format_id:saved.format_id,format_version:1,veroeffentlichen:true},
   {action:'adressen',ref:exeRef,von:'rva',adresse:'0x1010'},
   {action:'adressen',ref:exeRef,von:'rva',adresse:'0x1100'},
   {action:'adressen',ref:reverseRef,von:'rva',adresse:'0x1000'},
   {action:'adressen',ref:exeRef,von:'va',adresse:'18446744073709551616'},
  ];
  for(const a of calls){
   const args={...a,token:transport.token};
   const r=await transport.rest('hex',args),s=await transport.stdio('hex',args);
   const expected=await tokenCall(transport.token,a.action,Object.fromEntries(Object.entries(a).filter(([k])=>k!=='action')));
   const keys=Object.keys(expected),fach=x=>Object.fromEntries(keys.map(k=>[k,x[k]]));
   eq(normal(fach(r)),normal(expected),'REST entspricht Core '+a.action);
   eq(normal(fach(s)),normal(expected),'stdio entspricht Core '+a.action);
  }
  await budgets({max_struktur_knoten:2});
  const a={action:'format_anwenden',ref,format_id:fmt.format_id,format_version:1,token:transport.token};
  const r=success(await transport.rest('hex',a),'REST Cursorstart'),s=success(await transport.stdio('hex',a),'stdio Cursorstart');
  eq(normal(r.baum),normal(s.baum),'gleicher Startbaum');
  const r2=success(await transport.rest('hex',{action:'format_anwenden',cursor:r.cursor,token:transport.token}),'REST Cursorweiter');
  const s2=success(await transport.stdio('hex',{action:'format_anwenden',cursor:s.cursor,token:transport.token}),'stdio Cursorweiter');
  const expected=await tokenCall(transport.token,'format_anwenden',{cursor:r.cursor});
  const keys=Object.keys(expected),fach=x=>Object.fromEntries(keys.map(k=>[k,x[k]]));
  eq(normal(fach(r2)),normal(fach(s2)),'Baumfortsetzung REST/stdio fachlich gleich');
  await resetBudgets();
 });


 await section('P18-T84: identischer Reverse-Vertrag auf REST, SDK/stdio und Web',async()=>{
  await override('reverse_erkenntnisse');
  const input={action:'erkenntnis_speichern',reverse_id:RID,titel:'Transport evidence',kategorie:'notiz',idempotency_key:'t84-transport',inhalt:{text:'Transport fixture',status:'aktiv',aussagen:[{schluessel:'fixture',text:'Synthetic observation',konfidenz:'vermutet',begruendung:'No binary claim',belege:[]}],belege:[],ziele:[]},token:transport.token};
  const saved=success(await transport.rest('reverse',input),'REST writes knowledge');
  const id=saved.erkenntnis.verweis_id;
  eq((await transport.stdio('reverse',input)).erkenntnis.canonical_hash,saved.erkenntnis.canonical_hash,'stdio retry same immutable version');
  const {mitAgentToolAufruf}=await import('../dist/services/agent-token-tools.js');
  for(const a of [
   {action:'erkenntnis_liste',reverse_id:RID},
   {action:'erkenntnis_get',reverse_id:RID,verweis_id:id,version:1},
   {action:'erkenntnis_get',reverse_id:RID,verweis_id:id,historie:true}
  ]){
   const args={...a,token:transport.token};
   const expected=await mitAgentToolAufruf('reverse',args,'t84-parity',async k=>k.antwort??core.fuehreReverseAus(k.args));
   const rest=await transport.rest('reverse',args),stdio=await transport.stdio('reverse',args);
   const wire=unwrap(core.baueToolErgebnis(expected,{tool:'reverse',strukturiert:true}));
   const keys=Object.keys(wire),fach=x=>Object.fromEntries(keys.map(k=>[k,x[k]]));
   eq(normal(fach(rest)),normal(wire),'REST knowledge parity '+a.action);
   eq(normal(fach(stdio)),normal(wire),'stdio knowledge parity '+a.action);
  }
  const fastify=(await import('../../rest-api/node_modules/fastify/fastify.js')).default;
  const {reverseErkenntnisseRoutes}=await import('../../rest-api/dist/routes/reverse-erkenntnisse.js');
  const web=fastify({logger:false});close.push(()=>web.close());
  await reverseErkenntnisseRoutes(web,{validateToken:async token=>token==='fixture-session'?{kind:'session',scope:null}:token==='fixture-connector'?{kind:'access',scope:'mcp:tools'}:null});
  const url='/api/projects/'+P+'/reverse-erkenntnisse';
  const a={action:'erkenntnis_get',reverse_id:RID,verweis_id:id,version:1};
  eq((await web.inject({method:'POST',url,payload:a})).statusCode,401,'Web without session denied');
  eq((await web.inject({method:'POST',url,headers:{authorization:'Bearer fixture-session'},payload:{...a,agent_id:'spoof'}})).statusCode,400,'Web rejects asserted identity');
  const w=(await web.inject({method:'POST',url,headers:{authorization:'Bearer fixture-session'},payload:a})).json();
  success(w,'Web bound read');eq(w.erkenntnis.canonical_hash,saved.erkenntnis.canonical_hash,'Web reads same immutable content');
  const t=(await web.inject({method:'POST',url,headers:{authorization:'Bearer fixture-connector','x-synapse-agent-token':transport.token},payload:a})).json();
  success(t,'Web agent transport uses verified wrapper');eq(t.erkenntnis.canonical_hash,w.erkenntnis.canonical_hash,'Web agent/session parity');
  const update={...input,verweis_id:id,basis_version:1,idempotency_key:'t84-web',titel:'Web correction'};delete update.token;
  const changed=(await web.inject({method:'POST',url,headers:{authorization:'Bearer fixture-session'},payload:update})).json();
  success(changed,'Web appends new version');eq(changed.erkenntnis.autor,'user','Web author comes from authenticated session');
  eq(changed.erkenntnis.version,2,'Web preserves v1');
  const stale=(await web.inject({method:'POST',url,headers:{authorization:'Bearer fixture-session'},payload:{...update,idempotency_key:'t84-stale'}})).json();
  eq(stale.erkenntnis_fehler,'erkenntnis_versionskonflikt','Web CAS conflict matches tool');
  await override('reverse_erkenntnisse',false);
  eq((await transport.rest('reverse',{...a,token:transport.token})).erkenntnis_fehler,'erkenntnisse_deaktiviert','REST switch OFF');
  await override('reverse_erkenntnisse');
 });

 await section('Echter Fremdprojekt-Ausweis: Visum lesend, Arbeitsfreigabe schreibend und sofortiger Entzug',async()=>{
  await override('mehrprojekt');
  const foreign=await core.stelleAgentTokenAus({project:Q,name:'h5-visitor',rolle:'subagent'},{system:'user'});secrets.push(foreign.token);
  const read=success(await tokenCall(foreign.token,'format_liste',{format_id:saved.format_id,format_version:1,mit_format:true}),'Visum liest Format');
  eq(read.format_version,1,'Visum exakte Version');
  success(await tokenCall(foreign.token,'adressen',{ref:exeRef,von:'rva',adresse:4096}),'Visum liest Adressen');
  eq((await tokenCall(foreign.token,'format_speichern',{format:definition()})).error,'visum_nur_lesen','Visum verweigert Schreiben');
  const visitor=(await pool.query("SELECT id FROM agent_identitaeten WHERE project=$1 AND name='h5-visitor'",[Q])).rows[0];
  const foreignApi=await import('../dist/services/agent-ausweis-projekte.js');
  await foreignApi.erteileArbeitsfreigabe(P,visitor.id,'Synthetischer Test von T7',{wer:'user',actor_identity_id:null});
  success(await tokenCall(foreign.token,'format_speichern',{format:definition()}),'Arbeitsfreigabe schreibt');
  await foreignApi.entzieheArbeitsfreigabe(P,visitor.id,'Synthetischer sofortiger Entzug',{wer:'user',actor_identity_id:null});
  eq((await tokenCall(foreign.token,'format_speichern',{format:definition()})).error,'visum_nur_lesen','Entzug sofort wirksam');
 });
 await section('PE-Verzeichnisse: ganze Directory-Spans und Security als Dateioffset',async()=>{
  const b=pe(),opt=152;
  b.writeUInt32LE(16,opt+92);
  b.writeUInt32LE(0x10ff,opt+96+1*8);b.writeUInt32LE(20,opt+96+1*8+4);
  b.writeUInt32LE(900,opt+96+4*8);b.writeUInt32LE(200,opt+96+4*8+4);
  const dirRef=await asset('directory-boundary.exe',b);
  const r=success(await call('adressen',{ref:dirRef,von:'rva',adresse:4096}),'Directory Grenzen');
  const imports=r.verzeichnisse.find(d=>d.index===1),security=r.verzeichnisse.find(d=>d.index===4);
  eq(imports.abbildung.zuordnungen[0].status,'nur_speicher','Import-Span verlaesst Rawdaten');
  eq(imports.folgeaufrufe,[],'kein Folgeaufruf ohne vollstaendige Dateibytes');
  eq(security.abbildung.status,'ausserhalb_datei','Security-Span hinter EOF');
  eq(security.abbildung.datei_offset.dezimal,'900','Security ist physischer Offset');
 });

 await section('Main fremdes Projekt nur lesend; alle Produktschalter bleiben AUS',async()=>{
  await override('hauptagent');await override('agenten_ausweis');
  const main=await core.stelleMainIdentitaetSicher({art:'user'},{modell:'synthetic',runtime:'claude'});
  const token=(await pool.query('SELECT token_offen FROM agent_identitaet_tokens WHERE identity_id=$1 AND widerrufen_am IS NULL',[main.identity_id])).rows[0].token_offen;secrets.push(token);
  success(await tokenCall(token,'format_liste',{format_id:saved.format_id,format_version:1,mit_format:true}),'Main Fremdlesen Format');
  success(await tokenCall(token,'adressen',{ref:exeRef,von:'rva',adresse:4096}),'Main Fremdlesen Adressen');
  const denied=await tokenCall(token,'format_speichern',{format:definition()});
  eq(denied.success,false,'Main Fremdschreiben gesperrt');ok(['main_nur_lesen','visum_nur_lesen','main_fremdprojekt_nur_lesen'].includes(denied.error??denied.fehler),'Main Schreibfehler');
  eq((await pool.query("SELECT COUNT(*)::int n FROM agent_profil_schalter WHERE funktion IN ('hex_lesen','hex_formate','hex_adressen') AND aktiv")).rows[0].n,0,'kein Produktschalter aktiviert');
 });
}catch(e){failures.push('Setup/Lauf');console.error('FAIL Setup/Lauf: '+mask(e.stack??e));}finally{
 for(const fn of close.reverse())await fn().catch(()=>{});
 if(core)await core.closePool().catch(()=>{});
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>{});await admin.end();
 await rm(temp,{recursive:true,force:true});
 console.log('P21 CHECKS='+checks+' FAILURES='+failures.length+' '+failures.join('|'));
 if(failures.length)process.exitCode=1;
}

process.exit(process.exitCode??0);
