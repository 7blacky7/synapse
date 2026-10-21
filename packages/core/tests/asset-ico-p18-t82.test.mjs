/** P18-T82: real ICO inspector/FFmpeg + project and Reverse inline previews in private synapse_test. */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inflateSync} from 'node:zlib';
import {createRequire} from 'node:module';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;process.env.SYNAPSE_SKIP_EMBEDDINGS='1';
const core=await import('../dist/index.js'),intel=await import('../dist/asset-intel/index.js');
const {kodiereAnsichtPng,pruefeAnsichtPng}=await import('../dist/services/asset-ansicht-renderer.js');
const {fuehreReverseAnsichtAus}=await import('../dist/services/reverse-ansicht-ausgabe.js');
const {trenneMcpBilder}=await import('../dist/services/asset-ansicht-ausgabe.js');
const {Pool}=createRequire(new URL('../package.json',import.meta.url))('pg');
const raw=new Pool({connectionString:url.href,max:4}),schema='p18_t82_'+randomUUID().replaceAll('-','');
const db={async connect(){const c=await raw.connect();await c.query('SET search_path TO '+schema+',public');return c;},
 async query(...args){const c=await this.connect();try{return await c.query(...args);}finally{c.release();}}};
const root=await mkdtemp(join(tmpdir(),'p18-t82-')),project='p18_t82_fixture',rid='rev-p18-t82-fixture';
const cfg=core.ladeAssetKonfiguration({SYNAPSE_ASSET_ENABLED:'1',SYNAPSE_PROJEKTE_ROOT:join(root,'project'),SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:join(root,'reverse')});
const limits={maxPixel:16777216,maxBytes:8388608,maxRamBytes:1073741824,timeoutMs:15000,maxKante:2048,maxFrames:1,maxDauerMs:12000};
const sha=v=>createHash('sha256').update(v).digest('hex');
let made=false,reset=()=>{},checks=0;
const eq=(a,b,m)=>{assert.deepEqual(a,b,m);checks++;};
function dib(w,bits){
 const h=w,stride=Math.ceil(w*bits/32)*4,maskStride=Math.ceil(w/32)*4,palette=bits<=8?2**bits*4:0;
 const b=Buffer.alloc(40+palette+(stride+maskStride)*h);
 b.writeUInt32LE(40);b.writeInt32LE(w,4);b.writeInt32LE(h*2,8);b.writeUInt16LE(1,12);b.writeUInt16LE(bits,14);b.writeUInt32LE(stride*h,20);
 for(let i=0;i<palette/4;i++)b[40+i*4+2]=255;
 const start=40+palette;
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  const at=start+y*stride;
  if(bits===1)b[at+(x>>3)]|=0x80>>(x&7);
  else if(bits===4)b[at+(x>>1)]=0x11;
  else if(bits===8)b[at+x]=1;
  else if(bits===16)b.writeUInt16LE(0x7c00,at+x*2);
  else{b[at+x*(bits/8)+2]=255;if(bits===32)b[at+x*4+3]=y===h-1?(x===0?0:x===1?128:255):255;}
 }
 const mask=start+stride*h;for(const x of [0,7,8])b[mask+(h-1)*maskStride+(x>>3)]|=0x80>>(x&7);
 b[mask+((w-1)>>3)]|=0x80>>((w-1)&7);
 return {w,h,bits,data:b};
}
function ico(entries){
 let offset=6+16*entries.length;const head=Buffer.alloc(offset);head.writeUInt16LE(1,2);head.writeUInt16LE(entries.length,4);
 entries.forEach((e,i)=>{const at=6+i*16;head[at]=e.w===256?0:e.w;head[at+1]=e.h===256?0:e.h;head.writeUInt16LE(1,at+4);head.writeUInt16LE(e.bits,at+6);head.writeUInt32LE(e.data.length,at+8);head.writeUInt32LE(offset,at+12);offset+=e.data.length;});
 return Buffer.concat([head,...entries.map(e=>e.data)]);
}
function pixels(png){
 const dims=pruefeAnsichtPng(png,limits),data=[];let at=8;
 while(at<png.length){const n=png.readUInt32BE(at);if(png.toString('ascii',at+4,at+8)==='IDAT')data.push(png.subarray(at+8,at+8+n));at+=n+12;}
 return {dims,raw:inflateSync(Buffer.concat(data))};
}
try{
 await mkdir(cfg.speicher.reverseRoot,{recursive:true});
 await raw.query('CREATE SCHEMA '+schema);made=true;
 for(const name of ['95_asset_intel.sql','96_asset_transport.sql','97_reverse.sql','98_asset_upload.sql','99_asset_manifest.sql','100_asset_konflikte.sql','102_asset_ansicht_links.sql','104_reverse_ansicht.sql'])await db.query(await readFile(new URL('../src/db/schema-sql/'+name,import.meta.url),'utf8'));
 const {WORK_JOBS_SCHEMA_SQL}=await import('../dist/db/work-jobs-schema.js');
 await db.query(WORK_JOBS_SCHEMA_SQL);await db.query(core.REVERSE_PIPELINE_SCHEMA_SQL);
 await db.query("INSERT INTO reverse_eintraege(id,titel,status) VALUES($1,'ICO fixture','bestaetigt')",[rid]);
 await db.query("INSERT INTO reverse_medien(id,eintrag_id,position,bezeichnung,art) VALUES(1,$1,0,'CD1','ordner')",[rid]);
 await db.query("INSERT INTO reverse_bindungen(project,eintrag_id,gebunden_von) VALUES($1,$2,'fixture')",[project,rid]);
 const rgba=Buffer.alloc(64*64*4);for(let i=0;i<64*64;i++){rgba[i*4+1]=255;rgba[i*4+3]=255;}rgba[3]=0;
 const embedded={w:64,h:64,bits:32,data:await kodiereAnsichtPng(rgba,64,64,limits)};
 const entries=[dib(16,4),dib(32,8),dib(48,24),dib(32,32),embedded],multi=ico(entries);
 eq(intel.detectAsset('renamed.bin',multi).format,'ico','magic recognizes ICO without extension');
 eq(intel.detectAsset('S3GOLD.ICO',Buffer.alloc(0)).format,'ico','uppercase extension fallback');

 const falseMagic=Buffer.alloc(64);falseMagic.set([0,0,1,0,1,0]);
 await writeFile(join(root,'game-data.dat'),falseMagic);
 const datResult=await intel.inspectAsset(join(root,'game-data.dat'));
 eq([datResult.status,datResult.format],['nicht_erkannt',null],'DAT start code alone must not claim ICO');
 eq(intel.detectAsset('raw.bin',falseMagic).format,null);
 eq(intel.detectAsset('broken.ICO',falseMagic).format,'ico','explicit ICO extension retains damaged-file diagnostics');
 for(const [at,value] of [[4,0],[4,257],[9,1],[10,2],[12,7],[14,0],[18,multi.length+1]]){
  const bad=Buffer.from(multi);if(at===9)bad[at]=value;else if(at>=14)bad.writeUInt32LE(value,at);else bad.writeUInt16LE(value,at);
  eq(intel.detectAsset('foreign.dat',bad).format,null,'implausible ICO directory '+at);
 }
 await writeFile(join(root,'renamed.bin'),ico([dib(256,8)]));
 eq((await intel.inspectAsset(join(root,'renamed.bin'))).format,'ico','known file size validates image payload beyond 4096-byte head');

 const input=join(root,'multi.ico');await writeFile(input,multi);
 const inspected=await intel.inspectAsset(input);
 eq([inspected.status,inspected.format,inspected.asset_type,inspected.metadata.mime_type],['ok','ico','image','image/x-icon']);
 eq(inspected.objects.map(o=>o.data.bits_per_pixel),[4,8,24,32,32]);
 eq(inspected.objects.map(o=>o.data.width),[16,32,48,32,64]);
 const capped=await intel.inspectAsset(input,{maxObjects:1});eq([capped.status,capped.objects.length],['teilweise',1]);
 const none=await intel.inspectAsset(input,{maxObjects:0});eq([none.status,none.objects.length],['teilweise',0],'zero object budget is not a malformed ICO');
 const broken=Buffer.from(multi);broken.writeUInt32LE(multi.length+1,18);await writeFile(join(root,'broken.ico'),broken);
 eq((await intel.inspectAsset(join(root,'broken.ico'))).status,'teilweise','bad sibling is explicit');
 const kern=new core.AssetUploadKern({db,konfiguration:cfg,speicher:new core.AssetSpeicher({konfiguration:cfg})});
 const ctx={bereich:'projekt',ziel_ref:project,host_id:'fixture'};
 const dienst=new core.AssetAnsichtDienst({db,konfiguration:cfg});
 dienst.registriereQuellenAdapter('reverse',core.reverseAnsichtAdapter({db,konfiguration:cfg}));
 reset=core.setzeReverseAnsichtDienste({ansicht:dienst});
 const legacy32=dib(32,32);for(let i=40+3;i<40+32*32*4;i+=4)legacy32.data[i]=0;
 const cases=[...entries.map(e=>({bytes:ico([e]),width:e.w})),{bytes:multi,width:16},...[dib(17,4),dib(256,8),dib(16,1),dib(16,16),legacy32].map(e=>({bytes:ico([e]),width:e.w}))];
 for(let index=0;index<cases.length;index++){
  const {bytes,width}=cases[index],before=sha(bytes);
  const name='icon-'+index+'.ico',upload=await kern.erstellen(ctx,{logischer_pfad:name,storage_kind:'assets',groesse:bytes.length,sha256:before,basis_revision:'0',idempotency_key:randomUUID(),mime_type:'image/x-icon',format:'ico'});
  await kern.teil(ctx,upload.id,0,bytes.length,[bytes]);const version=await kern.finalisieren(ctx,upload.id);
  await db.query("UPDATE asset_files SET format='unbekannt' WHERE id=$1",[version.asset_id]);
  const ref={bereich:'projekt',ziel_ref:project,id:version.asset_id,revision:version.revision};
  const rendered=await dienst.ansicht(ref);eq(rendered.success,true,JSON.stringify(rendered));
  eq(rendered.mimeType,'image/png');eq(pixels(rendered.png).dims,{breite:width,hoehe:width});
  const decoded=pixels(rendered.png).raw;
  eq(decoded[4],0,'AND / native 32-bit / PNG first-pixel transparency survives');
  const legacy=index!==3&&index!==4,px=(x,y)=>pixels(rendered.png).raw[y*(width*4+1)+1+x*4+3];
  eq(px(7,0),legacy?0:255,'MSB mask bit at x7 / native alpha overrides AND');
  eq(px(8,0),legacy?0:255,'next mask byte at x8');
  eq(px(width-1,width-1),legacy?0:255,'bottom-right mask row and DWORD padding');
  eq(px(0,width-1),255,'bottom-left remains opaque: bottom-up orientation');

  eq([...decoded.subarray(5,9)],index===4?[0,255,0,255]:[255,0,0,index===3?128:255],'actual ICO pixels survive');
  eq((await dienst.ansicht(ref)).cacheTreffer,true,'cache retains PNG under source revision');
  eq(sha(await readFile(join(cfg.speicher.root,project,'assets',name))),before,'project original unchanged');
  const job=randomUUID(),work=join(cfg.speicher.reverseRoot,'_arbeit',job);await mkdir(work,{recursive:true});await writeFile(join(work,name),bytes);
  await core.uebernehmeEErgebnis(db,{jobId:job,reverseId:rid,mediumId:'1',arbeitsWurzel:work,manifest:[{pfad:name,sha256:before,groesse:bytes.length,art:'asset',metadaten:{mime_type:'image/x-icon'}}]},{konfiguration:cfg});
  await db.query("UPDATE reverse_dateien SET format='unbekannt' WHERE eintrag_id=$1 AND pfad=$2",[rid,'CD1/'+name]);
  const out=await fuehreReverseAnsichtAus({reverse_id:rid,project,datei:'CD1/'+name,ansicht:'inline',agent_id:'fixture'},db),transport=trenneMcpBilder(out);
  eq(out.status,'fertig',JSON.stringify(out));eq(out.format,'ico');eq(out.ansicht.inline.umgewandelt_aus,'ico');eq(out.ansicht.inline.original_unveraendert,true);
  eq(transport.bilder.length,1);eq(transport.bilder[0].mimeType,'image/png');
  eq(pixels(Buffer.from(transport.bilder[0].data,'base64')).dims,{breite:width,hoehe:width});

  const reversePng=Buffer.from(transport.bilder[0].data,'base64');
  eq(pixels(reversePng).raw,pixels(rendered.png).raw,'Reverse and project pixel/alpha equality');
  eq(sha(await readFile(join(cfg.speicher.reverseRoot,rid,'entpackt','m1',name))),before,'Reverse original unchanged');

  eq(JSON.stringify(out).includes(transport.bilder[0].data),false,'base64 stays outside structured content');
 }
 eq((await db.query('SELECT count(*)::int n FROM reverse_ansicht_retention WHERE released_at IS NULL')).rows[0].n,0,'Reverse holds released');
 eq((await db.query('SELECT count(*)::int n FROM asset_retention_referenzen WHERE released_at IS NULL')).rows[0].n,0,'project holds released');

 // FD-bound renderer, downscale after AND, malformed/truncated AND and native 32-bit alpha.
 const {open}=await import('node:fs/promises');
 const renderer=new (await import('../dist/services/asset-ansicht-renderer.js')).FfmpegAnsichtRenderer(cfg);
 eq(renderer.version,'ffmpeg-rgba-png-v2-ico-and','old opaque preview cache version invalidated');
 const down=dib(32,8),downStride=4,downStart=40+1024+32*32;
 for(let row=0;row<32;row++)down.data.fill(255,downStart+row*downStride,downStart+row*downStride+2);
 const directRender=async(bytes,g=limits)=>{const name=join(root,'direct.ico');await writeFile(name,bytes);const f=await open(name,'r');try{return await renderer.render(f.fd,'ico',g);}finally{await f.close();}};
 const scaled=await directRender(ico([down]),{...limits,maxKante:16});
 eq([scaled.breite,scaled.hoehe],[16,16]);
 const sr=pixels(scaled.png).raw;eq(sr[4],0);eq(sr[1+15*4+3],255,'scaled masked half remains transparent / unmasked half opaque');
 const cut=dib(16,8);cut.data=cut.data.subarray(0,cut.data.length-64);
 await assert.rejects(()=>directRender(ico([cut])),e=>e.code==='ansicht_nicht_darstellbar');checks++;
 const corrupt=ico([dib(16,8)]);corrupt.writeUInt32LE(0xffffffff,18);
 await assert.rejects(()=>directRender(corrupt),e=>e.code==='ansicht_nicht_darstellbar');checks++;

 // Decoder and input/pixel budgets still reject invalid or over-budget icons.
 const malformed=ico([dib(16,8)]);malformed.writeUInt16LE(0,4);
 const file=join(root,'malformed.ico');await writeFile(file,malformed);eq((await intel.inspectAsset(file)).status,'fehler');
 const source=bytes=>({aufloesen:async()=>({bereich:'reverse',id:'bad',revision:sha(bytes),sha256:sha(bytes),adresse:{bereich:'reverse',ziel_ref:rid,storage_kind:'assets',logischer_pfad:'bad.ico'},groesse:bytes.length,format:'ico',mimeType:'image/x-icon',lesen:async()=>{const {Readable}=await import('node:stream');return Readable.from([bytes]);},halten:async()=>{},freigeben:async()=>{}})});
 const badService=new core.AssetAnsichtDienst({db,konfiguration:cfg});badService.registriereQuellenAdapter('reverse',source(malformed));
 eq((await badService.ansicht({bereich:'reverse',ziel_ref:rid,id:'bad'})).success,false,'malformed ICO is not fabricated');
 const smallCfg=core.ladeAssetKonfiguration({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:join(root,'limited'),SYNAPSE_ASSET_PREVIEW_MAX_PIXELS:'4'});
 const limited=new core.AssetAnsichtDienst({db,konfiguration:smallCfg});limited.registriereQuellenAdapter('reverse',source(ico([dib(16,8)])));
 eq((await limited.ansicht({bereich:'reverse',ziel_ref:rid,id:'bad'})).fehlercode,'ansicht_limit');
 await db.query('UPDATE reverse_bindungen SET geloest_at=now() WHERE project=$1 AND eintrag_id=$2',[project,rid]);
 eq((await fuehreReverseAnsichtAus({reverse_id:rid,project,datei:'CD1/icon-0.ico',ansicht:'inline'},db)).fehlercode,'nicht_gebunden','binding remains enforced');
 console.log('P18-T82 PASS '+checks+' checks: ICO 4/8/24/32bpp+PNG/multi, real project/Reverse inline PNG, pixels/alpha, legacy unknown/cache/limits/retention/hash.');
}finally{
 reset();await core.closePool();if(made)await raw.query('DROP SCHEMA '+schema+' CASCADE');await raw.end();await rm(root,{recursive:true,force:true});
}
