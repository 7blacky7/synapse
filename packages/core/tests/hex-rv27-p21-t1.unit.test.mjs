/** P21-T1/RV27: Gruppen, Bytebelege, getrennte Entropie und nur plausible Kandidaten. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {analysiereRv27,gruppiereRv27Dateien} from '../dist/services/hex-rv27.js';
const url=new URL(process.env.DATABASE_URL);assert.equal(url.pathname,'/synapse_test');assert.equal(url.searchParams.get('port')??url.port,'5433');
function quelle(b,path='sample.dat',reads={bytes:0}){return {size:b.length,path,readRange:async(offset,length)=>{assert.ok(offset>=0&&length>=0&&offset+length<=b.length);reads.bytes+=length;return b.subarray(offset,offset+length);}};}
const limits={scanBytes:16384,ramBytes:16384,blockBytes:4096,sampleBytes:4096,maxCandidates:32};
test('T1 groups by extension, magic and size band, then exposes header differences',async()=>{
 const a=Buffer.alloc(1024);a.set([0x10,0x20,0x30,0x40]);
 const b=Buffer.from(a);b[8]=0x11;
 const c=Buffer.alloc(4096);c.set([0x10,0x20,0x30,0x40]);
 const rows=await Promise.all([[a,'a.dat'],[b,'b.dat'],[c,'c.bin']].map(async([buf,path])=>{const x=await analysiereRv27(quelle(buf,path),limits);return {...x,path};}));
 const groups=gruppiereRv27Dateien(rows);
 assert.equal(groups.length,2);
 const pair=groups.find(g=>g.count===2);assert.ok(pair);assert.equal(pair.header_comparison.bytes_compared,32);
 assert.ok(pair.header_comparison.different_offsets.includes(8));
 assert.deepEqual(pair.files.map(f=>f.extension),['.dat','.dat']);
});
test('T1 reports full scan entropy separately from the 4096-byte prefix sample and per-block values',async()=>{
 const b=Buffer.alloc(8192,0);for(let i=4096;i<b.length;i++)b[i]=i%256;
 const reads={bytes:0},r=await analysiereRv27(quelle(b,'entropy.dat',reads),limits);
 assert.equal(r.entropie_stichprobe_4096.wert,0);
 assert.equal(r.entropie_stichprobe_4096.bytes,4096);
 assert.ok(r.entropie_gesamt.wert>0);
 assert.equal(r.entropie_gesamt.bytes,8192);
 assert.equal(r.entropie_gesamt.vollstaendig,true);
 assert.equal(r.entropie_bloecke.length,2);
 assert.ok(r.entropie_bloecke[0].entropie<r.entropie_bloecke[1].entropie);
});
test('T1 structure hypotheses carry confidence and byte-range evidence',async()=>{
 const b=Buffer.alloc(4096,0);
 [16,32,48,64].forEach((n,i)=>b.writeUInt32LE(n,i*4));
 const tableRun=await analysiereRv27(quelle(b),limits);
 const table=tableRun.struktur_hypothesen.find(h=>h.type==='offsettabelle'&&h.endianness==='le');
 assert.ok(table);assert.ok(table.confidence>0&&table.confidence<=1);
 assert.equal(table.evidence.offset,'0');assert.equal(table.evidence.length,16);
 assert.equal(table.evidence.bytes_hex,b.subarray(0,16).toString('hex'));
 const records=Buffer.alloc(4096,0);
 for(let row=0;row<4;row++)for(let col=0;col<8;col++)records[row*8+col]=col+1;
 const recordRun=await analysiereRv27(quelle(records),limits);
 const record=recordRun.struktur_hypothesen.find(h=>h.type==='feste_datensatzlaenge');
 assert.ok(record);assert.equal(record.evidence.bytes_hex.length,record.evidence.length*2);
 const palette=recordRun.struktur_hypothesen.find(h=>h.type==='palette_kandidat');
 assert.ok(palette);assert.ok(palette.evidence.bytes_hex.length>0);
});
test('T1 embedded PNG and BMP signatures require plausible headers and are returned only as candidates',async()=>{
 const b=Buffer.alloc(512,0);
 const png=Buffer.from('89504e470d0a1a0a0000000d4948445200000002000000030806000000','hex');
 b.set(png,80);
 const bmp=Buffer.alloc(54);bmp.write('BM',0,'ascii');bmp.writeUInt32LE(54,2);bmp.writeUInt32LE(54,10);bmp.writeUInt32LE(40,14);bmp.writeUInt32LE(2,18);bmp.writeUInt32LE(2,22);b.set(bmp,240);
 const r=await analysiereRv27(quelle(b,'container.bin'),{...limits,scanBytes:512,ramBytes:1024,blockBytes:256,sampleBytes:512});
 assert.ok(r.eingebettete_kandidaten.some(x=>x.format==='png'&&x.offset==='80'&&x.candidate&&x.stored===false));
 assert.ok(r.eingebettete_kandidaten.some(x=>x.format==='bmp'&&x.offset==='240'&&x.length==='54'&&x.candidate&&x.stored===false));
 assert.ok(r.eingebettete_kandidaten.every(x=>x.stored===false));
});
