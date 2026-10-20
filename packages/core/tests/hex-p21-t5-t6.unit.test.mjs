/** P21-T5/T6: isolierte Regressionen fuer Pagination und getrennte Scan/RAM/Antwortbudgets. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {HEX_EINSTELLUNGEN} from '../dist/services/hex-einstellungen.js';
import {sucheHex} from '../dist/services/hex-suchen.js';
import {vergleicheHex} from '../dist/services/hex-vergleichen.js';
const url=new URL(process.env.DATABASE_URL);assert.equal(url.pathname,'/synapse_test');assert.equal(url.searchParams.get('port')??url.port,'5433');
function stand(values={}){return {project:'p21_t5_t6_unit',werte:Object.fromEntries(Object.entries({...HEX_EINSTELLUNGEN,...values}).map(([k,v])=>[k,{wert:v,quelle:'standard'}]))};}
function source(b,reads={n:0}){return {ref:{art:'projekt_text',file_path:'unit.bin'},file_path:'unit.bin',revision:'r1',sha256:'a'.repeat(64),groesse:b.length,bytebasis:'pg_text_utf8',lesen:async(off,len)=>{assert.ok(off>=0&&len>=0&&off+len<=b.length);reads.n+=len;return b.subarray(off,off+len);}};}
const signal=()=>new AbortController().signal;
test('P21-T5 hit limit has a cursor; repeated matches across chunks remain reachable',async()=>{
 const b=Buffer.from('xxxxABCDEFxxxxABCDEFxxxx'),s=stand({chunk_bytes:8,max_fundstellen:1,scan_bytes:64});
 const first=await sucheHex(source(b),{muster:'41 42 ?? 44 45 46'},s,signal());
 assert.equal(first.fundstellen[0].offset,'4');assert.equal(first.eof,false);assert.equal(first.vollstaendig,false);assert.equal(first.naechster_offset,'5');
 const second=await sucheHex(source(b),{muster:'41 42 ?? 44 45 46',offset:first.naechster_offset},s,signal());
 assert.equal(second.fundstellen[0].offset,'14');assert.equal(second.eof,false);assert.notEqual(second.naechster_offset,null);
 const third=await sucheHex(source(b),{muster:'41 42 ?? 44 45 46',offset:second.naechster_offset},s,signal());
 assert.equal(third.fundstellen.length,0);assert.equal(third.eof,true);assert.equal(third.naechster_offset,null);
});
test('P21-T5 scan context consumes the shared read budget and response JSON stays within its cap',async()=>{
 const b=Buffer.alloc(2048,0x41);b.set(Buffer.from('ABCDEF'),60);const reads={n:0},s=stand({chunk_bytes:64,scan_bytes:180,ram_bytes:16384,antwort_zeichen:1200,max_fundstellen:64});
 const r=await sucheHex(source(b,reads),{muster:'41 42 43 44 45 46'},s,signal());
 assert.ok(reads.n<=180);assert.ok(r.budget.gelesen_bytes<=180);assert.ok(JSON.stringify(r).length<=1200);assert.ok(r.budget.ram_schaetzung_peak<=4096);
 assert.equal(r.fundstellen[0].offset,'60');assert.equal(r.fundstellen[0].kontext.vollstaendig,true);assert.equal(r.eof,false);assert.ok(r.naechster_offset!==null);
});
test('P21-T6 diff pagination honors block limit, scan/RAM and exact whole-response size',async()=>{
 const a=Buffer.alloc(512,0),b=Buffer.from(a);for(let i=0;i<512;i+=2)b[i]=1;
 const ra={n:0},rb={n:0},s=stand({chunk_bytes:64,scan_bytes:512,ram_bytes:32768,antwort_zeichen:1800,max_diff_bloecke:1,max_hex_bytes:1024});
 const first=await vergleicheHex(source(a,ra),source(b,rb),{},s,signal());
 assert.equal(first.anzahl_bloecke,1);assert.equal(first.eof,false);assert.ok(first.naechster_offset!==null);
 assert.ok(JSON.stringify(first).length<=1800);assert.ok(first.budget.bytes_a<=512);assert.ok(first.budget.bytes_b<=512);assert.ok(first.budget.ram_schaetzung_peak<=32768);
 const second=await vergleicheHex(source(a),source(b),{offset:first.naechster_offset},s,signal());
 assert.ok(Number(second.offset)>Number(first.offset));
});
test('P21-T6 offset-equal diff reports a larger source tail',async()=>{
 const a=source(Buffer.from('abc')),b=source(Buffer.from('abc123')),r=await vergleicheHex(a,b,{},stand({scan_bytes:16}),signal());
 assert.equal(r.eof,true);assert.equal(r.differenzen.length,1);assert.equal(r.differenzen[0].offset,'3');assert.equal(r.differenzen[0].laenge,3);
});
