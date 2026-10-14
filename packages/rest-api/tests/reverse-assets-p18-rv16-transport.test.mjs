/** RV16 Transporttest (gebündelte Testphase): REST + stdio-API-Forwarder, eigenes synapse_test-Schema.
 * node packages/rest-api/tests/reverse-assets-p18-rv16-transport.test.mjs
 * Echte BMP->PNG-Vorschau (FFmpeg/ffprobe/prlimit erforderlich), A15-Link 200/410 mit kontrollierter Uhr.
 * Kein echter Daemon/API/Docker; Fastify inject + Fake-fetch als Transport.
 */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
const req=createRequire(new URL('../../core/package.json',import.meta.url));
const {Pool}=req('pg');
const basis=new URL(process.env.DATABASE_URL??'http://invalid');
assert.equal(basis.port,'5433');assert.equal(basis.pathname,'/synapse_test');
const admin=new Pool({connectionString:basis.toString()});
const schema='p18_rv16_transport_'+randomUUID().replaceAll('-','');
const scoped=new URL(basis);scoped.searchParams.set('options','-c search_path='+schema+',public');
process.env.DATABASE_URL=scoped.toString();delete process.env.SYNAPSE_DATABASE_URL;
process.env.SYNAPSE_SKIP_EMBEDDINGS='1';process.env.SYNAPSE_AUTH_DISABLED='1';process.env.PARSER_LOOP_DISABLED='1';
const core=await import('../../core/dist/index.js');
const {ensureSchema}=await import('../../core/dist/db/schema.js');
const Fastify=createRequire(new URL('../package.json',import.meta.url))('fastify');
const {mcpRoutes}=await import('../dist/routes/mcp.js');
const {rufeReverseApi}=await import('../../mcp-server/dist/tools/consolidated/reverse.js');
const rest=Fastify({logger:false});
const project='p18_rv16_transport',agent='p18_rv16_transport-agent',rid='rev-transport-000016';
const fixture=await fs.mkdtemp(join(tmpdir(),'synapse-p18-rv16-'));
let resetDienste=()=>{};
function bmp(){
 const b=Buffer.alloc(62);b.write('BM');b.writeUInt32LE(62,2);b.writeUInt32LE(54,10);b.writeUInt32LE(40,14);
 b.writeInt32LE(2,18);b.writeInt32LE(1,22);b.writeUInt16LE(1,26);b.writeUInt16LE(24,28);b[56]=255;b[59]=255;return b;
}
let created=false;
try {
 assert.equal((await admin.query('SELECT current_database() AS n')).rows[0].n,'synapse_test');
 await admin.query('CREATE SCHEMA '+schema);created=true;
 const db=core.getPool();
 assert(String((await db.query('SHOW search_path')).rows[0].search_path).startsWith(schema));
 await ensureSchema({sperrSchema:schema,versuche:1,lockTimeoutMs:5000,statementTimeoutMs:120000,idleTimeoutMs:10000});
 await db.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,'fixture','/synthetic/p18_rv16_transport',true)",[project]);
 await db.query("INSERT INTO agent_sessions(id,project,status,sitzung_seit) VALUES($1,$2,'active',NOW())",[agent,project]);
 await db.query("INSERT INTO reverse_eintraege(id,titel) VALUES($1,'Transport fixture')",[rid]);
 await db.query("INSERT INTO reverse_medien(id,eintrag_id,position,art) VALUES(1,$1,0,'ordner')",[rid]);
 await db.query("INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,sha256,groesse,format,art,status,metadaten) VALUES($1,1,'gfx/menu.bmp',$2,70,'bmp','asset','ok','{}')",[rid,'a'.repeat(64)]);
 const bytes=bmp(),sha=createHash('sha256').update(bytes).digest('hex');
 const cfg=core.ladeAssetKonfiguration({SYNAPSE_ASSET_ENABLED:'1',SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_PROJEKTE_ROOT:join(fixture,'projekt'),SYNAPSE_REVERSE_ROOT:join(fixture,'reverse')});
 const key=rid+'/assets/fixture/menu.bmp';
 await fs.mkdir(join(cfg.speicher.reverseRoot,rid,'assets','fixture'),{recursive:true});
 await fs.writeFile(join(cfg.speicher.reverseRoot,key),bytes);
 await db.query('UPDATE reverse_dateien SET sha256=$2,groesse=$3,storage_key=$4 WHERE eintrag_id=$1',[rid,sha,bytes.length,key]);
 await db.query("INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,sha256,groesse,format,art,status,storage_key) VALUES($1,1,'gfx/active.svg',$2,62,'svg','asset','ok',$3)",[rid,sha,rid+'/assets/fixture/active.svg']);
 const dienst=new core.AssetAnsichtDienst({db,konfiguration:cfg});
 dienst.registriereQuellenAdapter('reverse',core.reverseAnsichtAdapter({db,konfiguration:cfg}));
 let uhr=new Date();
 const links=new core.AnsichtLinkDienst({db,dienst,konfiguration:cfg,jetzt:()=>uhr,
  link:{basisUrl:'https://rv16.invalid',basisFehler:null,produktion:true,rateProMinute:10000,vertrauenswuerdigeProxies:[],maxOriginalBytes:1024*1024}});
 resetDienste=core.setzeReverseAnsichtDienste({ansicht:dienst,link:links});
 const meta={clientIp:'198.51.100.16',userAgent:'RV16 Test'};
 await rest.register(mcpRoutes);await rest.ready();
 let sequence=0;
 const rpc=async(method,params)=>{
   const r=await rest.inject({method:'POST',url:'/',headers:{'content-type':'application/json',accept:'application/json'},payload:{jsonrpc:'2.0',id:++sequence,method,params}});
   assert.equal(r.statusCode,200,r.body);const body=r.json();assert(!body.error,JSON.stringify(body));return body.result;
 };
 const direct=args=>rpc('tools/call',{name:'reverse',arguments:args});
 const forwarded=args=>rufeReverseApi(args,{url:'http://rv16.invalid/',token:'synthetic',fetchImpl:async(url,init)=>{
   assert.equal(url,'http://rv16.invalid/');assert.equal(init.headers.authorization,'Bearer synthetic');
   const request=JSON.parse(init.body);assert.equal(request.params.name,'reverse');
   const result=await rpc(request.method,request.params);
   return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}),{status:200,headers:{'content-type':'application/json'}});
 }});
 const data=r=>r.structuredContent??JSON.parse(r.content.find(b=>b.type==='text').text);
 const definitions=(await rpc('tools/list')).tools;const reverse=definitions.find(d=>d.name==='reverse');
 assert.deepEqual(reverse,core.REVERSE_DEFINITION);assert(reverse.inputSchema.properties.action.enum.includes('assets_tree'));assert(reverse.inputSchema.properties.action.enum.includes('inspect'));
 for(const [name,call] of [['REST',direct],['stdio',forwarded]]){
   const args={project,agent_id:agent,reverse_id:rid};
   assert.equal(data(await call({...args,action:'loesen'})).success,true);
   assert.equal(data(await call({...args,action:'inspect',file_path:'gfx/menu.bmp'})).fehlercode,'nicht_gebunden',name);
   assert.equal(data(await call({...args,action:'binden'})).success,true);
   const tree=data(await call({...args,action:'assets_tree'}));assert.equal(tree.success,true,JSON.stringify(tree));assert(tree.baum.includes('menu.bmp'));
   const inspect=await call({...args,action:'inspect',datei:'gfx/menu.bmp',objects_limit:0});
   assert.equal(data(inspect).success,true,JSON.stringify(inspect));assert.equal(data(inspect).format,'bmp');
   assert(!inspect.content.some(b=>b.type==='image'));assert(!JSON.stringify(inspect).includes('storage_key'));
   assert.equal(data(await call({...args,action:'inspect',datei:'../etc/passwd'})).fehlercode,'pfad_gefahr');
   const inline=await call({...args,action:'ansicht',file_path:'gfx/menu.bmp',ansicht:'inline'});
   assert.equal(data(inline).success,true,JSON.stringify(data(inline)));
   const image=inline.content.find(b=>b.type==='image');assert(image,name+' Bildblock fehlt');
   const png=Buffer.from(image.data,'base64');assert.equal(png.toString('hex',0,8),'89504e470d0a1a0a');
   assert.equal(png.readUInt32BE(16),2);assert.equal(png.readUInt32BE(20),1);assert.equal(image.mimeType,'image/png');
   assert(!JSON.stringify(data(inline)).includes(image.data));assert(!inline.content.filter(b=>b.type==='text').some(b=>b.text.includes(image.data)));
   assert.equal(data(inline).ansicht.inline.revision,sha);
   const both=await call({...args,action:'ansicht',file_path:'gfx/menu.bmp',ansicht:'beides',offen_sekunden:2});
   assert.equal(data(both).success,true,JSON.stringify(data(both)));assert(both.content.some(b=>b.type==='image'));
   const token=data(both).ansicht.link.url.split('/').pop();
   assert.equal((await links.abrufen(token,meta)).status,200,name+' Link im Fenster');
   uhr=new Date(uhr.getTime()+3000);assert.equal((await links.abrufen(token,meta)).status,410,name+' Link nach Ablauf');
   const once=data(await call({...args,action:'ansicht',datei:'gfx/menu.bmp',ansicht:'link',einmalig:true}));
   assert.equal(once.success,true);assert(!once.ansicht.inline);const onceToken=once.ansicht.link.url.split('/').pop();
   assert.equal((await links.abrufen(onceToken,meta)).status,200);assert.equal((await links.abrufen(onceToken,meta)).status,410);
   const unsupported=data(await call({...args,action:'ansicht',file_path:'gfx/active.svg',ansicht:'inline'}));
   assert.equal(unsupported.success,false);assert.equal(unsupported.fehlercode,'ansicht_nicht_darstellbar');assert(unsupported.hinweis.includes('Hex'));
   const invalid=data(await call({...args,action:'ansicht',file_path:'gfx/menu.bmp',ansicht:'inline',offen_sekunden:10}));
   assert.equal(invalid.success,false);assert.equal(invalid.fehler,'ansicht_kombination_ungueltig');
   assert.equal(data(await call({...args,action:'loesen'})).success,true);
   const unbound=await call({...args,action:'ansicht',file_path:'gfx/menu.bmp',ansicht:'inline'});
   assert.equal(data(unbound).fehlercode,'nicht_gebunden');assert(!unbound.content.some(b=>b.type==='image'));
   assert.equal(createHash('sha256').update(await fs.readFile(join(cfg.speicher.reverseRoot,key))).digest('hex'),sha,'Originalbytes unverändert');

 }
 console.log('PASS RV16 REST/stdio metadata, binding and shared definition');
} finally {
 resetDienste();await rest.close();await core.closePool();
 await fs.rm(fixture,{recursive:true,force:true});
 if(created)await admin.query('DROP SCHEMA '+schema+' CASCADE');
 await admin.end();
}
