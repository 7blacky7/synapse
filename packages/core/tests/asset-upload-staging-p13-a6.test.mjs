/** P13-T24/A6: nur synthetische eigene Bytewurzel, kein Live-Dataset/PG. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {AssetSpeicher} from '../dist/services/asset-speicher.js';
import {ladeAssetKonfiguration} from '../dist/config/asset-konfig.js';
const sha=b=>createHash('sha256').update(b).digest('hex');
test('A6 interne Chunkstaging-API (rote Altstandkontrolle)',()=>{
  assert.equal(typeof AssetSpeicher.prototype.stageTeil,'function');
  assert.equal(typeof AssetSpeicher.prototype.readStagingStream,'function');
});
test('Teilstream bleibt intern, nach Neustart lesbar und wird nur mit Gesamt-SHA veröffentlicht',async()=>{
  const root=await fs.mkdtemp(join(tmpdir(),'p13-a6-staging-'));
  try {
    const cfg=ladeAssetKonfiguration({SYNAPSE_ASSET_ENABLED:'1',SYNAPSE_PROJEKTE_ROOT:join(root,'projekt')});
    const r={bereich:'projekt',ziel_ref:'p13_a6',storage_kind:'assets',logischer_pfad:'video.bin'};
    const s=new AssetSpeicher({konfiguration:cfg});
    if(!s.stageTeil) return assert.fail('stageTeil fehlt');
    const bytes=Buffer.alloc(128*1024,71);
    async function* input(){for(let i=0;i<32;i++)yield bytes;}
    const a=await s.stageTeil(r,input(),{groesse:bytes.length*32});
    const b=await s.stageTeil(r,[Buffer.from('end')],{groesse:3});
    await assert.rejects(s.readRange(r,0,1),e=>e.code==='ENOENT');
    const fresh=new AssetSpeicher({konfiguration:cfg});
    const totalHash=createHash('sha256');
    for(let i=0;i<32;i++)totalHash.update(bytes);totalHash.update('end');
    const expected=totalHash.digest('hex');
    async function* concatenate(){for(const part of [a,b])for await(const chunk of await fresh.readStagingStream(part))yield chunk;}
    const full=await fresh.stage(r,concatenate(),{groesse:a.groesse+b.groesse,sha256:expected});
    await fresh.publish(full,{basisSha256:null,prepare:async()=>{},commit:async()=>{}});
    assert.equal((await fresh.readRange(r,a.groesse,3)).toString(),'end');
    let size=0,largest=0;const check=createHash('sha256');
    for await(const chunk of await fresh.readStream(r)){size+=chunk.length;largest=Math.max(largest,chunk.length);check.update(chunk);}
    assert.equal(size,a.groesse+3);assert.equal(check.digest('hex'),expected);
    assert.ok(largest<=cfg.speicher.chunkBytes,'Stream ist begrenzt');
    await assert.rejects(fresh.readStagingStream({...a,adresse:{...r,ziel_ref:'foreign'}}));
    await assert.rejects(fresh.stage(r,concatenate(),{groesse:a.groesse+3,sha256:'f'.repeat(64)}),e=>e.code==='hash_falsch');
    assert.equal((await fresh.readRange(r,a.groesse,3)).toString(),'end');
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
test('Abgebrochener Teilstream und Größenfehler berühren bestätigte Teile nicht',async()=>{
  const root=await fs.mkdtemp(join(tmpdir(),'p13-a6-abort-'));
  try {
    const cfg=ladeAssetKonfiguration({SYNAPSE_ASSET_ENABLED:'1',SYNAPSE_PROJEKTE_ROOT:root});
    const r={bereich:'projekt',ziel_ref:'p13_a6_abort',storage_kind:'assets',logischer_pfad:'image.bin'};
    const s=new AssetSpeicher({konfiguration:cfg});
    if(!s.stageTeil) return assert.fail('stageTeil fehlt');
    const part=await s.stageTeil(r,[Buffer.from('good')],{groesse:4});
    async function* broken(){yield Buffer.from('x');throw new Error('connection aborted');}
    await assert.rejects(s.stageTeil(r,broken(),{groesse:4}),/connection aborted/);
    await assert.rejects(s.stageTeil(r,[Buffer.from('too long')],{groesse:1}),e=>e.code==='groesse_falsch');
    let data='';for await(const chunk of await s.readStagingStream(part))data+=chunk;
    assert.equal(data,'good');assert.equal(part.sha256,sha('good'));
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
