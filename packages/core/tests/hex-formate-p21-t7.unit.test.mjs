/** P21-T7: nur eigene Unit-Tests, keine Golden-/Abnahme- oder Live-DB-Tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {HEX_EINSTELLUNGEN} from '../dist/services/hex-einstellungen.js';
import {pruefeHexFormat,parseFormatExpr,evalFormatExpr} from '../dist/services/hex-format-sprache.js';
import {interpretiereHexFormat,neuerFormatZustand} from '../dist/services/hex-format-interpreter.js';
// Ausfuehrungsziel der Synapse-Shell; niemals auf einer Produktions-Umgebung starten.
const db=new URL(process.env.DATABASE_URL);
assert.equal(db.pathname,'/synapse_test');
assert.equal(db.searchParams.get('port')??db.port,'5433');
function stand(values={}){
 return {project:'p21_t7_unit',werte:Object.fromEntries(Object.entries({...HEX_EINSTELLUNGEN,...values}).map(([k,v])=>[k,{wert:v,quelle:'standard'}])),letzter_fehler:null,
 schalter:{aktiv:true,quelle:'standard',bis:null,letzter_fehler:null},formate_schalter:{aktiv:true,quelle:'standard',bis:null,letzter_fehler:null}};
}
const def=(seq,rest={})=>({profil:'kaitai-read-v1',meta:{id:'unit',endian:'le'},seq,...rest});
function quelle(bytes){
 const reads=[];
 return {ref:{art:'projekt_text',file_path:'unit.bin'},groesse:bytes.length,reads,
 lesen:async(off,n)=>{assert.ok(Number.isSafeInteger(off)&&off>=0&&off+n<=bytes.length);reads.push([off,n]);return bytes.subarray(off,off+n);}};
}
async function run(definition,bytes,opt={}){
 const s=stand(opt.budgets),q=quelle(Buffer.from(bytes)),p=pruefeHexFormat(definition,s);
 const z=opt.zustand??neuerFormatZustand(q.groesse,opt.offset??0,opt.path??'$',opt.start??0,opt.count??Number.MAX_SAFE_INTEGER);
 const r=await interpretiereHexFormat(p,q,s,opt.signal??new AbortController().signal,z,opt.room??30000);return {...r,q,p};
}
const code=c=>e=>e.code===c;
test('Kanonischer Hash ignoriert nur Objektschluessel-Reihenfolge',()=>{
 const a=def([{id:'zahl',type:'u4'}]),b={seq:a.seq,meta:{endian:'le',id:'unit'},profil:'kaitai-read-v1'};
 assert.equal(pruefeHexFormat(a,stand()).hash,pruefeHexFormat(b,stand()).hash);
 const other=def([{id:'zahl',type:'u4be'}]);assert.notEqual(pruefeHexFormat(a,stand()).hash,pruefeHexFormat(other,stand()).hash);
});
test('Unbekannte/aktive Konstrukte, Zyklen und Referenzfehler abweisen',()=>{
 for(const bad of [
  def([{id:'x',type:'u1',process:'zlib'}]),def([{id:'x',type:'external'}]),
  def([{id:'x',type:'bytes',size:'future'},{id:'future',type:'u1'}]),
  def([{id:'x',type:'bytes',size:'process.exit()'}]),
  def([{id:'x',type:'bytes',size:'constructor.name'}]),
  def([{id:'x',type:'loop'}],{types:{loop:{seq:[{id:'again',type:'loop'}]}}}),
  def([{id:'x',type:'str',size:2}]),def([{id:'x',type:'u2'}],{meta:{id:'unit'}}),
 ])assert.throws(()=>pruefeHexFormat(bad,stand()),code('format_ungueltig'));
});
test('Ausdrucksbaum begrenzt linksassoziative Ketten vor Ausfuehrung',()=>{
 assert.throws(()=>pruefeHexFormat(def([{id:'x',type:'bytes',size:Array(40).fill('1').join('+')}]),stand()),code('format_ungueltig'));
});
test('Ganzzahlarithmetik ist exakt, null/Overflow/Shift sind Fehler',()=>{
 const ev=x=>evalFormatExpr(parseFormatExpr(x,16),()=>0n,()=>{});
 assert.equal(ev('0xffffffffffffffff - 2'),18446744073709551613n);
 assert.equal(ev('(9 & 3) == 1 && 7 > 2'),1n);
 assert.throws(()=>ev('1 / 0'),code('format_division_null'));
 assert.throws(()=>ev('0xffffffffffffffff + 1'),code('format_ueberlauf'));
 assert.throws(()=>ev('1 << 64'),code('format_shift_ungueltig'));
});
test('Magic, u64, Enum, explizites BE und Float-Sonderwerte',async()=>{
 const b=Buffer.alloc(18);b[0]=65;b.writeBigUInt64LE(18446744073709551615n,1);b.writeUInt16BE(513,9);b[11]=2;b.writeFloatLE(NaN,12);b.writeUInt16LE(3,16);
 const r=await run(def([{id:'magic',contents:'A'},{id:'large',type:'u8'},{id:'be',type:'u2be'},{id:'kind',type:'u1',enum:'kind'},{id:'special',type:'f4'},{id:'last',type:'s2'}],{enums:{kind:{'2':'two'}}}),b);
 assert.equal(r.vollstaendig,true);assert.equal(r.baum[1].wert.dezimal,'18446744073709551615');
 assert.equal(r.baum[2].wert.dezimal,'513');assert.equal(r.baum[3].enum_name,'two');assert.equal(r.baum[4].wert,'NaN');
 assert.equal(r.baum[5].offset,'16');assert.equal(r.baum[0].bytes_hex,'41');
});
test('Verschachtelte Strukturen, repeats, if und switch rechnen Offsets',async()=>{
 const definition=def([{id:'count',type:'u1'},{id:'items',type:'item',repeat:'expr','repeat-expr':'count'}],{
 types:{item:{seq:[{id:'kind',type:'u1'},{id:'value',type:{'switch-on':'kind',cases:{'1':'u2','_':'u1'}}},{id:'extra',type:'u1',if:'kind == 1'}]}}});
 const r=await run(definition,[2,1,0x34,0x12,9,0,7]);
 assert.equal(r.vollstaendig,true);
 assert.deepEqual(r.baum.filter(n=>n.art==='feld').map(n=>[n.pfad,n.offset,n.wert.dezimal]),[
 ['$.count','0','2'],['$.items[0].kind','1','1'],['$.items[0].value','2','4660'],['$.items[0].extra','4','9'],['$.items[1].kind','5','0'],['$.items[1].value','6','7']]);
});
test('Knotenbudget setzt mitten im Array ohne Verlust/Duplikate fort',async()=>{
 const definition=def([{id:'count',type:'u1'},{id:'values',type:'u2',repeat:'expr','repeat-expr':'count'}]),bytes=[4,1,0,2,0,3,0,4,0];
 let z;const all=[];let pages=0;
 do{
  const r=await run(definition,bytes,{zustand:z,budgets:{max_struktur_knoten:2}});
  all.push(...r.baum);z=JSON.parse(JSON.stringify(r.zustand));pages++;
  assert.ok(pages<10);
  for(const f of z.frames)for(const val of Object.values(f.vars)){assert.deepEqual(Object.keys(val).sort(),['offset','typ']);}
  if(r.vollstaendig)break;
 }while(true);
 assert.ok(pages>1);assert.equal(new Set(all.map(n=>n.pfad)).size,all.length);
 assert.deepEqual(all.filter(n=>n.pfad.startsWith('$.values[')).map(n=>n.wert.dezimal),['1','2','3','4']);
});
test('Selektiver Unterbaum liest keine unangeforderten Strings',async()=>{
 const definition=def([{id:'skip',type:'str',encoding:'ascii',size:3},{id:'item',type:'nested',size:2}],{types:{nested:{seq:[{id:'v',type:'u2'}]}}});
 const r=await run(definition,[255,255,255,2,1],{path:'$.item.v'});
 assert.deepEqual(r.baum.map(n=>n.pfad),['$.item.v']);assert.deepEqual(r.q.reads,[[3,2]]);
 assert.equal(r.baum[0].wert.dezimal,'258');
});
test('Arraybereich gibt nur die angeforderten Elemente aus',async()=>{
 const r=await run(def([{id:'a',type:'u1',repeat:'expr','repeat-expr':5}]),[10,11,12,13,14],{path:'$.a',start:2,count:2});
 assert.deepEqual(r.baum.filter(n=>n.art==='feld').map(n=>n.wert.dezimal),['12','13']);
});
test('Lazy instance wird nur explizit gelesen und bleibt im Substream',async()=>{
 const definition=def([{id:'a',type:'u1'}],{instances:{tail:{type:'u2be',pos:2,size:2}}});
 const a=await run(definition,[7,0,1,2]);assert.equal(a.baum[1].lazy,true);assert.deepEqual(a.q.reads,[[0,1]]);
 const b=await run(definition,[7,0,1,2],{path:'$.tail'});assert.equal(b.baum[0].wert.dezimal,'258');assert.equal(b.baum[0].offset,'2');
});
test('Magic-, EOF-, Substream- und Encodingfehler sind praezise',async()=>{
 await assert.rejects(run(def([{id:'m',contents:'A'}]),[66]),code('format_magic_falsch'));
 await assert.rejects(run(def([{id:'x',type:'u4'}]),[0,1]),code('format_feld_ausserhalb'));
 await assert.rejects(run(def([{id:'x',type:'n',size:1}],{types:{n:{seq:[{id:'x',type:'u2'}]}}}),[0,0]),code('format_feld_ausserhalb'));
 await assert.rejects(run(def([{id:'x',type:'str',encoding:'utf-8',size:1}]),[255]),code('format_encoding_ungueltig'));
});
test('Definition/Feld/Repeat- und Ausgabebudgets greifen vor Allokation',async()=>{
 assert.throws(()=>pruefeHexFormat(def([{id:'x',type:'u1'}]),stand({format_bytes:10})),code('budget_ueberschritten'));
 await assert.rejects(run(def([{id:'x',type:'bytes',size:5}]),[0,0,0,0,0],{budgets:{max_format_feld_bytes:4}}),code('budget_ueberschritten'));
 await assert.rejects(run(def([{id:'x',type:'u1',repeat:'expr','repeat-expr':20}]),[1],{budgets:{max_format_wiederholungen:10}}),code('budget_ueberschritten'));
 await assert.rejects(run(def([{id:'x',type:'u1'}]),[1],{room:10}),code('budget_ueberschritten'));
});
test('Striktes Encoding erhaelt BOM-Bytes und liest UTF-16BE',async()=>{
 const r=await run(def([{id:'utf8',type:'str',encoding:'utf-8',size:4},{id:'utf16',type:'str',encoding:'utf-16be',size:2}]),[0xef,0xbb,0xbf,65,0,66]);
 assert.equal(r.baum[0].wert,'\ufeffA');assert.equal(r.baum[1].wert,'B');assert.equal(r.baum[0].bytes_hex,'efbbbf41');
});

test('Grosse unangeforderte Payload wird ohne Allokation uebersprungen',async()=>{
 const s=stand(),p=pruefeHexFormat(def([{id:'head',type:'u1'},{id:'payload',type:'bytes',size:100000000}]),s);
 const q={groesse:100000001,lesen:async(off,n)=>{assert.equal(off,0);assert.equal(n,1);return Buffer.from([5]);}};
 const r=await interpretiereHexFormat(p,q,s,new AbortController().signal,neuerFormatZustand(q.groesse,0,'$.head'),30000);
 assert.equal(r.vollstaendig,true);assert.equal(r.budget.gelesene_bytes,1);
 assert.equal(r.baum[0].wert.dezimal,'5');
});
test('Bytebudget setzt nach ganzen Feldern fort und ueberschreitet es nie',async()=>{
 const definition=def([{id:'a',type:'u4'},{id:'b',type:'u4'}]),bytes=[1,0,0,0,2,0,0,0];
 const first=await run(definition,bytes,{budgets:{hex_bytes:4}});
 assert.equal(first.vollstaendig,false);assert.equal(first.grund,'hex_bytes');assert.equal(first.budget.ausgabe_bytes,4);assert.deepEqual(first.baum.map(n=>n.pfad),['$.a']);
 const next=await run(definition,bytes,{budgets:{hex_bytes:4},zustand:first.zustand});
 assert.equal(next.vollstaendig,true);assert.deepEqual(next.baum.map(n=>n.pfad),['$.b']);
});
test('Lokale Typen koennen reservierte Skalartypen nicht ueberschreiben',()=>{
 assert.throws(()=>pruefeHexFormat(def([],{types:{bytes:{seq:[]}}}),stand()),code('format_ungueltig'));
});


test('Arraybereich blendet ganze Strukturelemente aus und laesst innere Arrays vollstaendig',async()=>{
 const definition=def([{id:'items',type:'item',repeat:'expr','repeat-expr':3}],{types:{item:{seq:[{id:'values',type:'u1',repeat:'expr','repeat-expr':2}]}}});
 const r=await run(definition,[1,2,3,4,5,6],{path:'$.items',start:1,count:1});
 assert.deepEqual(r.baum.filter(n=>n.art==='feld').map(n=>[n.pfad,n.wert.dezimal]),[['$.items[1].values[0]','3'],['$.items[1].values[1]','4']]);
});

test('Unbekannter Unterbaum und nicht fortschreitendes Zeitbudget melden Fehler',async()=>{
 await assert.rejects(run(def([{id:'x',type:'u1'}]),[1],{path:'$.unknown'}),code('format_feldpfad_unbekannt'));
 const ac=new AbortController();ac.abort();
 await assert.rejects(run(def([{id:'x',type:'u1'}]),[1],{signal:ac.signal}),code('budget_ueberschritten'));
});
