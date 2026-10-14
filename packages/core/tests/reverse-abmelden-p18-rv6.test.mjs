/** P18-T16/RV6: Abmelden, Hinweis ausblenden, Original zurueckholen, lokal/hinweis_ausgeblendet und Policy-Route; isoliertes Schema in synapse_test. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
process.env.SYNAPSE_SKIP_EMBEDDINGS='1';
process.env.SYNAPSE_API_FEATURES='reverse_bibliothek';
process.env.SYNAPSE_REVERSE_STABIL_MS='1500';
process.env.SYNAPSE_REVERSE_BATCH_MAX='50';
const require=createRequire(new URL('../package.json',import.meta.url));
const {Pool}=require('pg');
const {ReverseEingang}=await import('../dist/services/reverse-eingang.js');
const {ladeAssetKonfiguration}=await import('../dist/config/asset-konfig.js');
const {REVERSE_SCHEMA_SQL}=await import('../dist/db/reverse-schema.js');
const {ASSET_UPLOAD_SCHEMA_SQL}=await import('../dist/db/asset-upload-schema.js');
const {API_CONTRACT_HEADER}=await import('../dist/index.js');
const {createReverseEingangRoutes}=await import('../../rest-api/dist/routes/reverse-eingang.js');
const Fastify=createRequire(new URL('../../rest-api/package.json',import.meta.url))('fastify');
const hash=b=>createHash('sha256').update(b).digest('hex');
const file=(rel_pfad,b)=>({rel_pfad,groesse:Buffer.byteLength(b),sha256:hash(b)});
const lesen=async s=>{const c=[];for await(const x of s)c.push(Buffer.from(x));return Buffer.concat(c);};
test('RV6 abmelden/hinweis/original/lokal und Routen-Gate (p18_rv6)',async t=>{
 const root=await mkdtemp(join(tmpdir(),'p18-rv6-core-'));
 const schema='p18_rv6_'+randomUUID().replaceAll('-','');
 const pool=new Pool({connectionString:process.env.DATABASE_URL,max:8});
 const connect=async()=>{const c=await pool.connect();await c.query('SET search_path TO "'+schema+'",public');return c;};
 const db={connect,query:async(...a)=>{const c=await connect();try{return await c.query(...a);}finally{c.release();}}};
 let app;
 try{
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,'synapse_test');
  await pool.query('CREATE SCHEMA "'+schema+'"');
  await db.query('CREATE TABLE asset_upload_sitzungen (LIKE public.asset_upload_sitzungen INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)');
  await db.query('CREATE TABLE asset_files (LIKE public.asset_files INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)');
  await db.query('CREATE TABLE work_jobs(id uuid PRIMARY KEY)');
  await db.query(ASSET_UPLOAD_SCHEMA_SQL);await db.query(REVERSE_SCHEMA_SQL);await db.query(REVERSE_SCHEMA_SQL);
  const cfg=ladeAssetKonfiguration({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:root});
  const eingang=new ReverseEingang({db,konfiguration:cfg});
  const H='rv6-host';
  const ctx=r=>({bereich:'reverse',ziel_ref:r.ziel_ref,host_id:H});
  const upload=async(p,b)=>{const r=(await eingang.fundstellen(H,[file(p,b)])).dateien[0];
   if(r.status==='upload_noetig'){await eingang.upload.teil(ctx(r),r.upload_id,0,b.length,[b]);await eingang.finalisieren(ctx(r),r.upload_id);}return r;};
  const zeile=async p=>{const all=[];let c;do{const s=await eingang.status(H,{cursor:c,limit:100});all.push(...s.dateien);c=s.cursor??undefined;}while(c);return all.find(d=>d.rel_pfad===p);};
  const a=Buffer.from('rv6 synthetisches original a');
  await t.test('Schema additiv und idempotent: hinweis_ausgeblendet_at',async()=>{
   const r=(await db.query("SELECT data_type,is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='reverse_fundstellen' AND column_name='hinweis_ausgeblendet_at'",[schema])).rows[0];
   assert.equal(r.data_type,'timestamp with time zone');assert.equal(r.is_nullable,'YES');
  });
  await t.test('syncOptionen: Budgets, Katalog, Standard behalten, keine Serverpfade',()=>{
   const p=eingang.syncOptionen(H);
   assert.equal(p.host,H);assert.equal(p.stabilMs,1500);assert.equal(p.maxBatch,50);assert.equal(p.loesch_verhalten,'behalten');assert.equal(p.erlaubt_alle_dateien,true);
   assert.equal(p.maxDateiBytes,cfg.reverse.maxDateiBytes);assert.equal(p.chunkBytes,cfg.speicher.chunkBytes);assert.ok(p.endungen.images.includes('iso'));assert.ok(p.endungen.companions.length);
   assert.ok(!JSON.stringify(p).includes(root));
  });
  await t.test('lokal: gesehen -> geloescht_lokal -> Hinweis aus/ein -> Wiedersehen setzt zurueck',async()=>{
   await upload('Lib/a.iso',a);
   let z=await zeile('Lib/a.iso');assert.equal(z.lokal,'gesehen');assert.equal(z.hinweis_ausgeblendet,false);
   const r=await eingang.abmelden(H,[{rel_pfad:'Lib/a.iso',status:'geloescht_lokal'},{rel_pfad:'Lib/nie.iso',status:'fehlt'}]);
   assert.deepEqual(r.dateien.map(d=>d.ergebnis),['gesetzt','unbekannt']);
   z=await zeile('Lib/a.iso');assert.equal(z.lokal,'geloescht_lokal');
   assert.equal((await db.query('SELECT status FROM reverse_eingang_bytes WHERE sha256=$1',[hash(a)])).rows[0].status,'ready','Original bleibt');
   assert.equal((await eingang.hinweis(H,'Lib/a.iso',true)).hinweis_ausgeblendet,true);
   assert.equal((await zeile('Lib/a.iso')).hinweis_ausgeblendet,true);
   await eingang.hinweis(H,'Lib/a.iso',false);assert.equal((await zeile('Lib/a.iso')).hinweis_ausgeblendet,false);
   await eingang.hinweis(H,'Lib/a.iso',true);
   await eingang.fundstellen(H,[file('Lib/a.iso',a)]);
   z=await zeile('Lib/a.iso');assert.equal(z.lokal,'gesehen');assert.equal(z.hinweis_ausgeblendet,false);
   await assert.rejects(eingang.hinweis(H,'Lib/nie.iso',true),e=>e.code==='fundstelle_unbekannt');
   await assert.rejects(eingang.hinweis('anderer-host','Lib/a.iso',true),e=>e.code==='fundstelle_unbekannt');
   await assert.rejects(eingang.hinweis(H,'Lib/a.iso','ja'),e=>e.code==='eingang_ungueltig');
   await assert.rejects(eingang.abmelden(H,[{rel_pfad:'Lib/a.iso',status:'weg'}]),e=>e.code==='eingang_ungueltig');
   await assert.rejects(eingang.abmelden(H,[]),e=>e.code==='eingang_ungueltig');
   await assert.rejects(eingang.abmelden(H,Array.from({length:51},(_,i)=>({rel_pfad:'x'+i,status:'fehlt'}))),e=>e.code==='eingang_ungueltig');
   await assert.rejects(eingang.abmelden(H,[{rel_pfad:'../raus',status:'fehlt'}]));
  });
  await t.test('abmelden vor fertigem Upload legt die Fundstelle an; original dann nicht_gesichert',async()=>{
   const b=Buffer.from('noch nicht hochgeladen');
   assert.equal((await eingang.fundstellen(H,[file('Lib/b.iso',b)])).dateien[0].status,'upload_noetig');
   await eingang.abmelden(H,[{rel_pfad:'Lib/b.iso',status:'fehlt'}]);
   assert.equal((await zeile('Lib/b.iso')).lokal,'fehlt');
   await assert.rejects(eingang.original(H,'Lib/b.iso'),e=>e.code==='nicht_gesichert');
  });
  await t.test('original: nur eigene, gesicherte Bytes, mit offset',async()=>{
   const o=await eingang.original(H,'Lib/a.iso');assert.equal(o.sha256,hash(a));assert.equal(o.groesse,a.length);assert.deepEqual(await lesen(o.stream),a);
   const o2=await eingang.original(H,'Lib/a.iso',4);assert.equal(o2.laenge,a.length-4);assert.deepEqual(await lesen(o2.stream),a.subarray(4));
   assert.deepEqual(await lesen((await eingang.original(H,'Lib/a.iso',a.length)).stream),Buffer.alloc(0));
   await assert.rejects(eingang.original('anderer-host','Lib/a.iso'),e=>e.code==='fundstelle_unbekannt');
   await assert.rejects(eingang.original(H,'Lib/a.iso',a.length+1),e=>e.code==='range_ungueltig');
  });
  await t.test('HTTP: Gate (503 ohne Feature, 403 falscher Host), Policy, abmelden, hinweis, Statusfelder, original',async()=>{
   app=Fastify();
   await app.register(createReverseEingangRoutes({eingang,validateToken:async tok=>({kind:'service',scope:'daemon',token_hash:tok}),daemonHost:async tok=>tok==='other'?'other-host':H}));
   const headers={authorization:'Bearer ok',[API_CONTRACT_HEADER]:'1'};
   const req=(method,u,payload,h=headers)=>app.inject({method,url:u,payload,headers:h});
   let r=await req('GET','/api/reverse/sync-optionen');assert.equal(r.statusCode,200,r.body);
   assert.equal(r.json().host,H);assert.equal(r.json().loesch_verhalten,'behalten');assert.equal(r.json().stabilMs,1500);
   assert.equal((await req('GET','/api/reverse/sync-optionen?host=forged')).statusCode,403);
   assert.equal((await req('POST','/api/reverse/fundstellen/abmelden',{host:'forged',dateien:[{rel_pfad:'Lib/a.iso',status:'fehlt'}]})).statusCode,403);
   assert.equal((await req('POST','/api/reverse/fundstellen/hinweis',{host:'forged',rel_pfad:'Lib/a.iso',ausblenden:true})).statusCode,403);
   assert.equal((await req('GET','/api/reverse/fundstellen/original?rel_pfad=Lib/a.iso&host=forged')).statusCode,403);
   process.env.SYNAPSE_API_FEATURES='';
   try{
    for(const [m,u,b] of [['GET','/api/reverse/sync-optionen'],['POST','/api/reverse/fundstellen/abmelden',{dateien:[{rel_pfad:'Lib/a.iso',status:'fehlt'}]}],
     ['POST','/api/reverse/fundstellen/hinweis',{rel_pfad:'Lib/a.iso',ausblenden:true}],['GET','/api/reverse/fundstellen/original?rel_pfad=Lib/a.iso']])
     assert.equal((await req(m,u,b)).statusCode,503,u);
   }finally{process.env.SYNAPSE_API_FEATURES='reverse_bibliothek';}
   r=await req('POST','/api/reverse/fundstellen/abmelden',{dateien:[{rel_pfad:'Lib/a.iso',status:'geloescht_lokal'}]});
   assert.equal(r.statusCode,200,r.body);assert.equal(r.json().dateien[0].ergebnis,'gesetzt');
   r=await req('POST','/api/reverse/fundstellen/hinweis',{rel_pfad:'Lib/a.iso',ausblenden:true});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().lokal,'geloescht_lokal');
   assert.equal((await req('POST','/api/reverse/fundstellen/hinweis',{rel_pfad:'Lib/zzz.iso',ausblenden:true})).statusCode,404);
   r=await req('GET','/api/reverse/fundstellen');assert.equal(r.statusCode,200,r.body);
   const row=r.json().dateien.find(d=>d.rel_pfad==='Lib/a.iso');assert.equal(row.lokal,'geloescht_lokal');assert.equal(row.hinweis_ausgeblendet,true);
   assert.equal(row.gesichert,true,'M3: gesichert unabhängig vom Analysestatus');
   assert.equal(r.json().dateien.find(d=>d.rel_pfad==='Lib/b.iso').gesichert,false);
   assert.ok(r.json().dateien.every(d=>typeof d.gesichert==='boolean'));
   assert.ok(r.json().dateien.every(d=>['gesehen','fehlt','geloescht_lokal'].includes(d.lokal)&&typeof d.hinweis_ausgeblendet==='boolean'));
   r=await req('GET','/api/reverse/fundstellen/original?rel_pfad='+encodeURIComponent('Lib/a.iso'));
   assert.equal(r.statusCode,200,r.body);assert.equal(r.headers['content-type'],'application/octet-stream');
   assert.equal(r.headers['x-synapse-sha256'],hash(a));assert.equal(r.headers['content-length'],String(a.length));assert.deepEqual(r.rawPayload,a);
   r=await req('GET','/api/reverse/fundstellen/original?rel_pfad=Lib/a.iso&offset=4');assert.equal(r.statusCode,200);assert.deepEqual(r.rawPayload,a.subarray(4));
   r=await req('GET','/api/reverse/fundstellen/original?rel_pfad=Lib/b.iso');assert.equal(r.statusCode,404);assert.equal(r.json().error.code,'nicht_gesichert');
   r=await req('GET','/api/reverse/fundstellen/original?rel_pfad=Lib/a.iso',undefined,{...headers,authorization:'Bearer other'});assert.equal(r.statusCode,404);assert.equal(r.json().error.code,'fundstelle_unbekannt');
   assert.equal((await req('GET','/api/reverse/fundstellen/original?rel_pfad=Lib/a.iso&offset=x')).statusCode,416);
   assert.equal((await req('GET','/api/reverse/fundstellen/original')).statusCode,400);
  });
 }finally{
  if(app)await app.close();
  await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
  await pool.end();await rm(root,{recursive:true,force:true});
 }
});
