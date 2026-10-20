/** P21-T9: synthetische Unit-Tests, keine Programme, Golden- oder Abnahmetests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {HEX_EINSTELLUNGEN} from '../dist/services/hex-einstellungen.js';
import {hexAdresse,rechneHexAdresse,ermittleHexAdresskarte} from '../dist/services/hex-adressen.js';
import {HEX_EXE_FORMATE,hexExeFormat,hexExeFormatHash} from '../dist/services/hex-exe-formate.js';
import {pruefeHexFormat} from '../dist/services/hex-format-sprache.js';
import {interpretiereHexFormat,neuerFormatZustand} from '../dist/services/hex-format-interpreter.js';
import {peInspector} from '../dist/asset-intel/inspectors/exe/pe.js';
import {elfInspector} from '../dist/asset-intel/inspectors/exe/elf.js';
const url=new URL(process.env.DATABASE_URL);assert.equal(url.pathname,'/synapse_test');assert.equal(url.searchParams.get('port')??url.port,'5433');
const code=c=>e=>e.code===c;
function stand(values={}){return {project:'p21_t9_unit',werte:Object.fromEntries(Object.entries({...HEX_EINSTELLUNGEN,...values}).map(([k,v])=>[k,{wert:v,quelle:'standard'}])),schalter:{aktiv:true},adressen_schalter:{aktiv:true}};}
function source(b){return {ref:{art:'projekt_text',file_path:'test.exe'},file_path:'test.exe',groesse:b.length,lesen:async(off,len)=>{assert.ok(off>=0&&len>=0&&off+len<=b.length);return b.subarray(off,off+len);}};}
async function karte(b,values={}){return ermittleHexAdresskarte(source(b),stand(values),new AbortController().signal);}
const map=(k,b,a)=>rechneHexAdresse(k,b.length,a,64);
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
test('Alle 18 gelieferten Formate validieren im unveraenderten kaitai-read-v1-Profil',()=>{
 assert.equal(HEX_EXE_FORMATE.length,18);
 const ids=new Set();for(const e of HEX_EXE_FORMATE){
  const p=pruefeHexFormat(e.format,stand());assert.equal(p.hash,hexExeFormatHash(e));assert.equal(e.format_version,1);
  assert.ok(!ids.has(e.format_id));ids.add(e.format_id);
 }
 for(const name of ['exe-mz','exe-pe','exe-ne','exe-le','exe-lx','exe-elf32le','exe-elf32be','exe-elf64le','exe-elf64be','exe-pe-import','exe-pe-export','exe-pe-resource','exe-pe-reloc'])assert.ok(hexExeFormat(name));
});
test('PE32 Dateioffset, RVA, VA, Header und explizite Ladebasis',async()=>{
 const b=pe(),{karte:k}=await karte(b);
 assert.equal(k.format,'pe');assert.equal(k.vollstaendig,true);
 let r=map(k,b,{von:'rva',adresse:'0x1010'});assert.equal(r.zuordnungen[0].datei_offset.dezimal,'528');assert.equal(r.zuordnungen[0].va.hex,'0x401010');assert.equal(r.zuordnungen[0].bereich.name,'.text');
 r=map(k,b,{von:'datei_offset',adresse:528});assert.equal(r.zuordnungen[0].rva.hex,'0x1010');
 r=map(k,b,{von:'va',adresse:'0x501010',ladebasis:'0x500000'});assert.equal(r.zuordnungen[0].datei_offset.dezimal,'528');
 r=map(k,b,{von:'rva',adresse:16});assert.equal(r.zuordnungen[0].bereich.art,'header');
});
test('PE-BSS, Overlay und Bereichsgrenzen bekommen keine erfundenen Dateibytes',async()=>{
 const b=pe(),{karte:k}=await karte(b);
 let r=map(k,b,{von:'rva',adresse:'0x1100'});assert.equal(r.zuordnungen[0].status,'nur_speicher');assert.equal(r.zuordnungen[0].datei_offset,null);
 r=map(k,b,{von:'datei_offset',adresse:900});assert.equal(r.status,'nicht_zugeordnet');
 r=map(k,b,{von:'rva',adresse:'0x10ff',adress_bytes:2});assert.equal(r.zuordnungen[0].datei_offset,null);
 assert.throws(()=>map(k,b,{von:'datei_offset',adresse:b.length}),code('bereich_ausserhalb'));
});
test('PE64 und u64-Eingaben bleiben jenseits 2^53 exakt',async()=>{
 const base=0xfffff80000000000n,b=pe(true,base),{karte:k}=await karte(b);
 const r=map(k,b,{von:'va',adresse:(base+0x1010n).toString()});
 assert.equal(r.zuordnungen[0].datei_offset.dezimal,'528');assert.equal(r.zuordnungen[0].va.dezimal,(base+0x1010n).toString());
 assert.throws(()=>hexAdresse(Number(base)),code('adresse_ungueltig'));
 assert.throws(()=>hexAdresse('18446744073709551616'),code('adresse_ungueltig'));
});
test('Ueberlappende PE-Sektionen liefern alle Kandidaten und Teilstatus',async()=>{
 const b=pe(),s=152+224;b.writeUInt16LE(2,134);b.copy(b,s+40,s,s+40);
 const {karte:k}=await karte(b),r=map(k,b,{von:'rva',adresse:'0x1010'});
 assert.equal(r.mehrdeutig,true);assert.equal(r.zuordnungen.length,2);assert.equal(r.vollstaendig,false);
 assert.throws(()=>rechneHexAdresse(k,b.length,{von:'rva',adresse:'0x1010'},1),code('budget_ueberschritten'));
});
for(const bits of [32,64])for(const le of [true,false])test('ELF '+bits+' '+(le?'LE':'BE')+' PT_LOAD/BSS exakt',async()=>{
 const base=bits===64?0xffff800000001000n:0x8048000n,b=elf(bits,le,base),{karte:k,format_name}=await karte(b);
 assert.equal(format_name,'exe-elf'+bits+(le?'le':'be'));assert.equal(k.vollstaendig,true);
 let r=map(k,b,{von:'va',adresse:(base+16n).toString()});assert.equal(r.zuordnungen[0].datei_offset.dezimal,'272');assert.equal(r.zuordnungen[0].quell_va.dezimal,(base+16n).toString());
 r=map(k,b,{von:'rva',adresse:64});assert.equal(r.zuordnungen[0].status,'nur_speicher');
 r=map(k,b,{von:'rva',adresse:16,ladebasis:'0x100000'});assert.equal(r.zuordnungen[0].va.hex,'0x100010');
});
test('NE rechnet ausschliesslich Segment:Offset; uninitialisierte Segmente haben keine Bytes',async()=>{
 const b=ne(),{karte:k}=await karte(b);assert.equal(k.format,'ne');
 let r=map(k,b,{von:'segment_offset',segment:1,adresse:4});assert.equal(r.zuordnungen[0].datei_offset.dezimal,'260');assert.equal(r.zuordnungen[0].va,null);
 r=map(k,b,{von:'datei_offset',adresse:260});assert.equal(r.zuordnungen[0].segment_offset.dezimal,'4');assert.equal(r.zuordnungen[0].bereich.segment,1);
 r=map(k,b,{von:'segment_offset',segment:2,adresse:4});assert.equal(r.zuordnungen[0].status,'nur_speicher');
 assert.throws(()=>map(k,b,{von:'va',adresse:1}),code('ne_segmentadresse_erforderlich'));
});
for(const tag of ['le','lx'])test(tag.toUpperCase()+' Seiten/Objekte und Speicherrest',async()=>{
 const b=linear(tag),{karte:k}=await karte(b);assert.equal(k.format,tag);assert.equal(k.vollstaendig,true);
 let r=map(k,b,{von:'va',adresse:'0x10004'});assert.equal(r.zuordnungen[0].datei_offset.dezimal,'516');
 r=map(k,b,{von:'segment_offset',segment:1,adresse:4});assert.equal(r.zuordnungen[0].datei_offset.dezimal,'516');
 r=map(k,b,{von:'rva',adresse:12});assert.equal(r.zuordnungen[0].datei_offset,null);assert.equal(r.zuordnungen[0].status,'nur_speicher');
 r=map(k,b,{von:'rva',adresse:20});assert.equal(r.zuordnungen[0].status,'nur_speicher');
});
test('Kodierte LX-Seiten und NE-Segmente werden nicht als lineare Bytes ausgegeben',async()=>{
 let b=linear('lx',1),{karte:k}=await karte(b),r=map(k,b,{von:'va',adresse:'0x10004'});
 assert.equal(r.zuordnungen[0].status,'kodiert');assert.equal(r.zuordnungen[0].datei_offset,null);assert.equal(r.zuordnungen[0].va,null);
 b=ne();b.writeUInt16LE(8,132);k=(await karte(b)).karte;r=map(k,b,{von:'datei_offset',adresse:260});
 assert.equal(r.zuordnungen[0].segment_offset,null);assert.equal(r.zuordnungen[0].status,'kodiert');
});
test('DOS MZ trennt Modul/Overlay und braucht Ladebasis fuer VA',async()=>{
 const b=Buffer.alloc(80);b.write('MZ');b.writeUInt16LE(64,2);b.writeUInt16LE(1,4);b.writeUInt16LE(2,8);b.writeUInt16LE(1,10);
 const {karte:k}=await karte(b);assert.equal(k.format,'mz');
 let r=map(k,b,{von:'rva',adresse:4});assert.equal(r.zuordnungen[0].datei_offset.dezimal,'36');assert.equal(r.zuordnungen[0].va,null);
 r=map(k,b,{von:'va',adresse:'0x10004',ladebasis:'0x10000'});assert.equal(r.zuordnungen[0].datei_offset.dezimal,'36');
 r=map(k,b,{von:'datei_offset',adresse:70});assert.equal(r.status,'nicht_zugeordnet');
 assert.throws(()=>map(k,b,{von:'va',adresse:4}),code('ladebasis_erforderlich'));
});
test('Gelieferte Strukturformate verwenden echte Offsets und Lazy-Tabellen',async()=>{
 for(const [name,b,path,expected]of [
 ['exe-pe',pe(),'$.sections[0].raw_pointer','512'],
 ['exe-ne',ne(),'$.segments.entries[0].sector','1'],
 ['exe-le',linear('le'),'$.objects.entries[0].base','65536'],
 ['exe-lx',linear('lx'),'$.pages.entries[0].data_bytes','8'],
 ['exe-elf32le',elf(32,true,0x8048000n),'$.programs.entries[0].p_offset','256'],
 ['exe-elf64be',elf(64,false,0xffff800000001000n),'$.programs.entries[0].p_vaddr','18446603336221200384'],
 ]){
  const p=pruefeHexFormat(hexExeFormat(name).format,stand()),q=source(b);
  const r=await interpretiereHexFormat(p,q,stand(),new AbortController().signal,neuerFormatZustand(b.length,0,path),30000);
  assert.equal(r.vollstaendig,true,name);assert.equal(r.baum[0].wert.dezimal,expected,name);
 }
});
test('Mini-Import/Export/Ressourcen/Reloc- und ELF-Symbolrecords sind anwendbar',async()=>{
 for(const [name,len]of [['exe-pe-import',20],['exe-pe-export',40],['exe-pe-resource',16],['exe-pe-resource-data',16],['exe-elf32be-symbol',16],['exe-elf64le-symbol',24]]){
  const p=pruefeHexFormat(hexExeFormat(name).format,stand()),b=Buffer.alloc(len);
  const r=await interpretiereHexFormat(p,source(b),stand(),new AbortController().signal,neuerFormatZustand(len,0),30000);assert.equal(r.vollstaendig,true,name);
 }
 const b=Buffer.alloc(12);b.writeUInt32LE(0x1000,0);b.writeUInt32LE(12,4);b.writeUInt16LE(0x3010,8);
 const p=pruefeHexFormat(hexExeFormat('exe-pe-reloc').format,stand()),r=await interpretiereHexFormat(p,source(b),stand(),new AbortController().signal,neuerFormatZustand(b.length,0),30000);
 assert.equal(r.baum.find(n=>n.pfad==='$.entries[0]').wert.dezimal,'12304');
});
test('Abgeschnittene/ungueltige Tabellen und Header werden ehrlich gemeldet',async()=>{
 const b=pe();b.writeUInt16LE(500,134);const k=(await karte(b)).karte;assert.equal(k.vollstaendig,false);
 const r=map(k,b,{von:'rva',adresse:'0xf0000000'});assert.equal(r.status,'karte_unvollstaendig');
 const bad=linear('le');bad.writeUIntBE(7,264,3);await assert.rejects(karte(bad),code('exe_seitentabelle_ungueltig'));
 await assert.rejects(karte(Buffer.from('hello')),code('exe_format_nicht_erkannt'));
 await assert.rejects(karte(pe(),{scan_bytes:1}),e=>e.grenze==='maxReadBytes');
});

test('ELF-Sektionsnamen/Herkunft bleiben auch ausserhalb von PT_LOAD sichtbar',async()=>{
 const b=Buffer.alloc(1024);elf().copy(b);b.writeBigUInt64LE(512n,40);b.writeUInt16LE(4,60);b.writeUInt16LE(3,62);
 const strings=Buffer.from('\0.text\0.debug\0.shstrtab\0');strings.copy(b,800);
 const sh=(i,name,type,flags,addr,off,size)=>{const at=512+i*64;b.writeUInt32LE(name,at);b.writeUInt32LE(type,at+4);b.writeBigUInt64LE(BigInt(flags),at+8);b.writeBigUInt64LE(BigInt(addr),at+16);b.writeBigUInt64LE(BigInt(off),at+24);b.writeBigUInt64LE(BigInt(size),at+32);};
 sh(1,1,1,6,0x400000,256,64);sh(2,7,1,0,0,384,16);sh(3,14,3,0,0,800,strings.length);
 const {karte:k}=await karte(b);assert.equal(k.vollstaendig,true);
 let r=map(k,b,{von:'datei_offset',adresse:272});assert.equal(r.zuordnungen[0].sektionen[0].name,'.text');
 r=map(k,b,{von:'datei_offset',adresse:388});assert.equal(r.status,'nicht_zugeordnet');assert.equal(r.datei_sektionen[0].name,'.debug');assert.equal(r.zuordnungen.length,0);
});

test('Magicbytes werden nicht durch ASCII-Maskierung angenaehert',async()=>{
 const b=Buffer.alloc(64);b[0]=0xcd;b[1]=0xda;b.writeUInt16LE(1,4);b.writeUInt16LE(2,8);
 await assert.rejects(karte(b),code('exe_format_nicht_erkannt'));
 const e=elf();e[4]=3;await assert.rejects(karte(e),code('exe_variante_nicht_unterstuetzt'));
});
test('Bestehende PE-/ELF-Inspektoren behalten ihren normalen Ausgabeweg',async()=>{
 for(const [inspector,b]of [[peInspector,pe()],[elfInspector,elf()]]){
  const src={filePath:'unit',size:b.length,readRange:async(off,n)=>b.subarray(off,Math.min(off+n,b.length))};
  const ctx={format:inspector.formats[0],limits:{maxFileBytes:99999,maxReadBytes:999999,maxObjects:1000,timeoutMs:5000,maxDepth:16,maxHashBytes:0},depth:0,signal:new AbortController().signal,pruefeAbbruch(){},warn(){},tiefer(){return this;}};
  const r=await inspector.inspect(src,ctx);assert.equal(r.asset_type,'executable');assert.ok(r.objects.length>0);assert.ok(!Object.hasOwn(r.format_specific,'adresskarte'));
 }
});
