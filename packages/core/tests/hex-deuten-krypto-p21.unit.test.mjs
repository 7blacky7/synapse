/** P21-T4/T15: feste Zahlen-/Kryptovektoren und Auditgrenzen. Aufruf nur in synapse_test-Shell. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync,deflateRawSync} from 'node:zlib';
import {deuteHexPrimitive} from '../dist/services/hex-deuten.js';
import {hexGanzzahl,pruefeHexRef} from '../dist/services/hex-quellen.js';
import {starteHexKryptoWorker} from '../dist/services/hex-krypto-worker.js';
import {schwaerzeToolDaten,schwaerzeToolLogText,toolArgsVorschau} from '../dist/services/tool-args-schwaerzen.js';
const db=new URL(process.env.DATABASE_URL);assert.equal(db.pathname,'/synapse_test');assert.equal(db.port,'5433');
const b=s=>Buffer.from(s,'hex');
const run=(verfahren,bytes,schluessel,parameter={},maxOutput=1024,g={})=>starteHexKryptoWorker({verfahren,bytes,schluessel,parameter,maxOutput},{ramBytes:16777216,laufzeitMs:3000,...g});
test('u64/i64 exakt ohne Number-Rundung, LE/BE und Bitmuster',()=>{
 assert.equal(deuteHexPrimitive(b('ffffffffffffffff'),'u64','le').wert,'18446744073709551615');
 assert.equal(deuteHexPrimitive(b('0000000000000080'),'i64','le').wert,'-9223372036854775808');
 assert.equal(deuteHexPrimitive(b('ffffffffffffffff'),'i64','be').wert,'-1');
 assert.equal(deuteHexPrimitive(b('01020304'),'u32','le').wert,'67305985');
 assert.equal(deuteHexPrimitive(b('01020304'),'u32','be').wert,'16909060');
 assert.equal(deuteHexPrimitive(b('ffffffffffffffff'),'i64','le').wert_hex,'0xffffffffffffffff');
});
test('Float-Sonderwerte sind eindeutiges JSON',()=>{
 for(const [hex,w]of [['00000080','-0'],['0000807f','Infinity'],['000080ff','-Infinity'],['0000c07f','NaN']])
  assert.equal(deuteHexPrimitive(b(hex),'f32','le').wert,w);
});
test('Offsetgrenzen und Traversal vor I/O',()=>{
 for(const n of [-1,-0.5,Infinity,NaN,9007199254740992,'-1','9007199254740992','0x20000000000000','1e3'])
  assert.throws(()=>hexGanzzahl(n,'offset'),e=>e.code==='offset_ungueltig');
 assert.equal(hexGanzzahl('0x1fffffffffffff','offset'),Number.MAX_SAFE_INTEGER);
 for(const file_path of ['../secret','a/../secret','/etc/passwd','a\\b','a//b','a/\u0000b'])
  assert.throws(()=>pruefeHexRef({art:'projekt_text',file_path}));
 assert.throws(()=>pruefeHexRef({art:'projekt_asset',id:'9223372036854775808'}));
});
test('AES-CBC/CTR/GCM feste NIST-Vektoren, keine Originalmutation',async()=>{
 const key=b('2b7e151628aed2a6abf7158809cf4f3c'),plain='6bc1bee22e409f96e93d7e117393172a';
 const cipher=b('7649abac8119b246cee98e9b12e9197d');
 const before=Buffer.from(cipher),kb=Buffer.from(key);
 assert.equal((await run('aes_cbc',cipher,key,{iv:'000102030405060708090a0b0c0d0e0f',padding:'none'})).toString('hex'),plain);
 assert.deepEqual(cipher,before);assert.deepEqual(key,kb);
 assert.equal((await run('aes_ctr',b('874d6191b620e3261bef6864990db6ce'),key,{iv:'f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff'})).toString('hex'),plain);
 assert.equal((await run('aes_gcm',b('0388dace60b6a392f328c2b971b2fe78'),Buffer.alloc(16),{iv:'00'.repeat(12),tag:'ab6e47d42cec13bdf53a67b21257bddf'})).toString('hex'),'00'.repeat(16));
 await assert.rejects(run('aes_gcm',b('0388dace60b6a392f328c2b971b2fe78'),Buffer.alloc(16),{iv:'00'.repeat(12),tag:'00'.repeat(16)}),e=>e.message==='entschluesselung_fehlgeschlagen');
});
test('XOR/Rolling-XOR haben dokumentierte Phase und Schritt',async()=>{
 const key=Buffer.from([1,2]),cipher=Buffer.from([11,22,31,42]);
 assert.deepEqual(await run('xor',cipher,key),Buffer.from([10,20,30,40]));
 // K[(i+1)%2]+i*3 -> 2,4,8,10
 assert.deepEqual(await run('xor_rolling',Buffer.from([8,16,22,34]),key,{phase:1,schritt:3}),Buffer.from([10,20,30,40]));
});
test('DEFLATE/zlib, Ausgabebombe und hartes Zeitlimit',async()=>{
 const plain=Buffer.from('synthetic payload '.repeat(50));
 assert.deepEqual(await run('zlib',deflateSync(plain),undefined,{},plain.length),plain);
 assert.deepEqual(await run('deflate',deflateRawSync(plain),undefined,{},plain.length),plain);
 await assert.rejects(run('zlib',deflateSync(Buffer.alloc(100000)),undefined,{},32),e=>e.message==='budget_ueberschritten');
 const ac=new AbortController();ac.abort();
 await assert.rejects(run('xor',Buffer.alloc(10),Buffer.from([1]),{},32,{signal:ac.signal}),e=>e.message==='zeitlimit');
 await assert.rejects(run('xor',Buffer.alloc(1000000),Buffer.from([1]),{},1000000,{laufzeitMs:1}),e=>e.message==='zeitlimit');
});
test('Inline-Key immer ganz maskieren, auch malformed/scalar/Ausweis-aehnlich',()=>{
 const label='inline-secret-fixture';
 const samples=[
  {schluessel_inline:{wert:label,kodierung:'raw'}},
  {schluessel_inline:{wert:[1,2,3],kodierung:'raw'}},
  {schluessel_inline:label},{schluessel_inline:123},{schluessel_inline:true},{schluessel_inline:'sai_'+'fixture'},
 ];
 for(const x of samples){assert.equal(schwaerzeToolDaten(x).schluessel_inline,'[WERT]');assert(!toolArgsVorschau(x).includes(label));}
 for(const s of [
  '{"schluessel_inline":{"wert":"'+label+'","kodierung":"raw"},"x":2}',
  '{"schluessel_inline":{"wert":"'+label,
  'failure schluessel_inline={"wert":"'+label+'"} next',
  'failure schluessel_inline="'+label+'" next',
  '{"x":"before","schluessel_inline":[1,2,3',
 ]){
  const masked=schwaerzeToolLogText(s);assert(!masked.includes(label));assert(masked.includes('[WERT]'));
 }
 assert.equal(schwaerzeToolDaten({harmlos:'still here'}).harmlos,'still here');
});
