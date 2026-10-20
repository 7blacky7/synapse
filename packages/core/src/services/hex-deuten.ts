/** P21-T4/H2: exakte Typdeutung, feste Feldfenster, paginierte Arrays und Streaming-Pruefsummen. */
import {createHash,type Hash} from 'node:crypto';
import {HexFehler,hexGanzzahl,mitHexQuelle,type HexQuelle} from './hex-quellen.js';
import type {HexStand} from './hex-einstellungen.js';
type R=Record<string,unknown>;
type Endian='le'|'be';
interface Knoten {name:string;typ:string;offset:number;anzahl:number;schritt:number;breite:number;span:number;blaetter:number;einzeln:number;endians:Endian[];felder:Knoten[];kodierung:string;nullterminiert:boolean}
const OBJEKT=(v:unknown):v is R=>!!v&&typeof v==='object'&&!Array.isArray(v);
const ARTEN=/^(u|i)(8|16|32|64)$|^f(32|64)$|^bool$/;
const HOECHST=BigInt(Number.MAX_SAFE_INTEGER);
function exakt(v:bigint):number{if(v<0n||v>HOECHST)throw new HexFehler('beschreibung_zu_gross');return Number(v);}
export function hexTypBreite(typ:string):number{
 if(typ==='bool')return 1;
 if(!ARTEN.test(typ))throw new HexFehler('typ_unbekannt');
 return Number(typ.slice(1))/8;
}
/** JSON-sichere Ergebnisse; signed hex ist das unveraenderte Bitmuster, keine Number-Rundung. */
export function deuteHexPrimitive(b:Buffer,typ:string,endian:Endian='le'):R{
 const breite=hexTypBreite(typ);if(b.length!==breite)throw new HexFehler('bereich_ausserhalb');
 const u=breite===1?BigInt(b[0]):breite===2?BigInt(endian==='le'?b.readUInt16LE():b.readUInt16BE()):breite===4?BigInt(endian==='le'?b.readUInt32LE():b.readUInt32BE()):(endian==='le'?b.readBigUInt64LE():b.readBigUInt64BE());
 const hex='0x'+u.toString(16).padStart(breite*2,'0');
 if(typ==='bool')return {wert:b[0]!==0,wert_dez:String(b[0]),wert_hex:hex};
 if(typ.startsWith('f')){
  const n=typ==='f32'?(endian==='le'?b.readFloatLE():b.readFloatBE()):(endian==='le'?b.readDoubleLE():b.readDoubleBE());
  const value=Number.isNaN(n)?'NaN':n===Infinity?'Infinity':n===-Infinity?'-Infinity':Object.is(n,-0)?'-0':n;
  return {wert:value,wert_hex:hex,sonderwert:typeof value==='string'};
 }
 const bits=BigInt(breite*8),signed=typ.startsWith('i')&&(u&(1n<<(bits-1n)))!==0n;
 const n=signed?u-(1n<<bits):u;
 return {wert:n.toString(),wert_dez:n.toString(),wert_hex:hex};
}
function kompiliere(raw:unknown,stand:HexStand,defaultName:string,defaultOffset:number,tiefe:number,budget:{knoten:number}):Knoten{
 if(tiefe>stand.werte.max_deuten_tiefe.wert||++budget.knoten>stand.werte.max_struktur_knoten.wert)throw new HexFehler('beschreibung_zu_gross');
 const d=typeof raw==='string'?{typ:raw}:raw;
 if(!OBJEKT(d)||Object.keys(d).some(k=>!['typ','name','offset','endianness','laenge','kodierung','nullterminiert','anzahl','schrittweite','felder'].includes(k)))throw new HexFehler('typ_ungueltig');
 if(typeof d.typ!=='string')throw new HexFehler('typ_ungueltig');
 const suffix=/^(u(?:8|16|32|64)|i(?:8|16|32|64)|f(?:32|64))(le|be)$/.exec(d.typ);
 const typ=suffix?suffix[1]:d.typ;
 const name=d.name===undefined?defaultName:d.name;
 if(typeof name!=='string'||!name||name.length>200)throw new HexFehler('feldname_ungueltig');
 const offset=hexGanzzahl(d.offset,'feld.offset',defaultOffset),anzahl=hexGanzzahl(d.anzahl,'anzahl',1);
 let endians:Endian[]=[],breite=0,einzeln=1,felder:Knoten[]=[],kodierung='',nullterminiert=false;
 if(d.endianness!==undefined&&!['le','be'].includes(String(d.endianness)))throw new HexFehler('endianness_ungueltig');
 if(suffix&&d.endianness!==undefined&&suffix[2]!==d.endianness)throw new HexFehler('endianness_konflikt');
 if(typ==='struct'){
  if(!Array.isArray(d.felder)||!d.felder.length||d.laenge!==undefined||d.kodierung!==undefined||d.nullterminiert!==undefined||d.endianness!==undefined)throw new HexFehler('struktur_ungueltig');
  let position=0;einzeln=0;
  for(let i=0;i<d.felder.length;i++){
   const f=kompiliere(d.felder[i],stand,'feld'+i,position,tiefe+1,budget);felder.push(f);
   position=Math.max(position,exakt(BigInt(f.offset)+BigInt(f.span)));
   einzeln=exakt(BigInt(einzeln)+BigInt(f.blaetter));
  }
  breite=position;
 }else if(typ==='string'){
  if(d.felder!==undefined||d.endianness!==undefined)throw new HexFehler('typ_ungueltig');
  breite=hexGanzzahl(d.laenge,'string.laenge',stand.werte.string_bytes.wert);
  if(breite<1||breite>Math.min(stand.werte.max_hex_bytes.wert,stand.werte.ram_bytes.wert))throw new HexFehler('budget_ueberschritten',{parameter:'string.laenge'});
  kodierung=d.kodierung===undefined?'utf8':String(d.kodierung);
  if(!['ascii','latin1','utf8','utf16le'].includes(kodierung))throw new HexFehler('kodierung_ungueltig');
  if(d.nullterminiert!==undefined&&typeof d.nullterminiert!=='boolean')throw new HexFehler('typ_ungueltig');
  nullterminiert=d.nullterminiert===true;
  if(kodierung==='utf16le'&&breite%2)throw new HexFehler('string_laenge_ungerade');
 }else{
  if(d.felder!==undefined||d.laenge!==undefined||d.kodierung!==undefined||d.nullterminiert!==undefined)throw new HexFehler('typ_ungueltig');
  breite=hexTypBreite(typ);
  if(breite>1){endians=suffix?[suffix[2] as Endian]:d.endianness?[d.endianness as Endian]:['le','be'];einzeln=endians.length;}
  else if(d.endianness!==undefined)throw new HexFehler('endianness_nicht_verwendet');
 }
 const schritt=hexGanzzahl(d.schrittweite,'schrittweite',breite);
 if(anzahl>1&&schritt<1)throw new HexFehler('schrittweite_ungueltig');
 const span=anzahl===0?0:exakt(BigInt(anzahl-1)*BigInt(schritt)+BigInt(breite));
 return {name,typ,offset,anzahl,schritt,breite,span,blaetter:exakt(BigInt(einzeln)*BigInt(anzahl)),einzeln,endians,felder,kodierung,nullterminiert};
}
function deuteString(b:Buffer,k:Knoten):R{
 let ende=b.length,terminiert=false;
 if(k.nullterminiert){
  if(k.kodierung==='utf16le'){for(let i=0;i+1<b.length;i+=2)if(b[i]===0&&b[i+1]===0){ende=i;terminiert=true;break;}}
  else {const i=b.indexOf(0);if(i>=0){ende=i;terminiert=true;}}
 }
 const data=b.subarray(0,ende);
 let wert:string;
 try{
  if(k.kodierung==='ascii'){if(data.some(n=>n>127))throw Error();wert=data.toString('ascii');}
  else if(k.kodierung==='latin1')wert=data.toString('latin1');
  else wert=new TextDecoder(k.kodierung==='utf16le'?'utf-16le':'utf-8',{fatal:true,ignoreBOM:true}).decode(data);
 }catch{throw new HexFehler('string_ungueltig',{kodierung:k.kodierung});}
 return {wert,kodierung:k.kodierung,nullterminiert:k.nullterminiert,terminiert:k.nullterminiert?terminiert:null,nutzbytes:ende};
}
const CRC_TABELLE=Uint32Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
interface Summe {algorithmus:string;hash?:Hash;crc:number;a:number;b:number}
export async function fuehreHexDeutenAus(args:R,project:string,stand:HexStand):Promise<R>{
 const erlaubt=['action','project','agent_id','token','ref','offset','typen','pruefsummen','feld_offset','feld_limit','laenge'];
 if(Object.keys(args).some(k=>!erlaubt.includes(k)))throw new HexFehler('parameter_nicht_verwendet');
 const start=hexGanzzahl(args.offset,'offset',0),ab=hexGanzzahl(args.feld_offset,'feld_offset',0);
 const limit=hexGanzzahl(args.feld_limit,'feld_limit',stand.werte.max_struktur_knoten.wert);
 if(limit<1||limit>stand.werte.max_struktur_knoten.wert)throw new HexFehler('budget_ueberschritten',{parameter:'limit',max:stand.werte.max_struktur_knoten.wert});
 if(args.typen!==undefined&&!Array.isArray(args.typen))throw new HexFehler('typ_ungueltig');
 if(args.pruefsummen!==undefined&&!Array.isArray(args.pruefsummen))throw new HexFehler('pruefsumme_ungueltig');
 const typen=(args.typen??[]) as unknown[],sums=(args.pruefsummen??[]) as unknown[];
 if(args.laenge!==undefined&&!sums.length)throw new HexFehler('parameter_nicht_verwendet',{parameter:'laenge'});
 if(!typen.length&&!sums.length)throw new HexFehler('typen_fehlen');
 const budget={knoten:0},knoten=typen.map((t,i)=>kompiliere(t,stand,'typ'+i,0,0,budget));
 if(sums.length>stand.werte.max_struktur_knoten.wert)throw new HexFehler('beschreibung_zu_gross');
 const total=knoten.reduce((s,k)=>exakt(BigInt(s)+BigInt(k.blaetter)),0);
 if(ab>total)throw new HexFehler('feld_offset_ungueltig',{total_felder:total});
 return mitHexQuelle(project,args.ref,stand,async(q,signal)=>{
  for(const k of knoten)if(start>q.groesse||k.offset>q.groesse-start||k.span>q.groesse-start-k.offset)throw new HexFehler('bereich_ausserhalb',{feld:k.name,groesse:q.groesse});
  let gelesen=0,stopp=false;
  const felder:R[]=[],pruefsummen:R[]=[];
  const antwort:R={success:true,action:'deuten',project,beantwortet_von:'hex',ref:q.ref,revision:q.revision,sha256:q.sha256,groesse:q.groesse,bytebasis:q.bytebasis,
   offset:String(start),feld_offset:ab,total_felder:total,felder,pruefsummen,vollstaendig:false,naechstes_feld:ab,
   layout:'typen_am_selben_offset; struct_felder_relativ; string_laenge_ist_festes_fenster',budget:{scan_bytes:stand.werte.scan_bytes.wert,antwort_zeichen:stand.werte.antwort_zeichen.wert,gelesene_bytes:0}};
  const read=async(offset:number,len:number)=>{
   if(signal.aborted)throw new HexFehler('zeitlimit');
   if(len>stand.werte.ram_bytes.wert||gelesen+len>stand.werte.scan_bytes.wert)throw new HexFehler('budget_ueberschritten',{parameter:'scan_bytes',gelesene_bytes:gelesen});
   gelesen+=len;(antwort.budget as R).gelesene_bytes=gelesen;
   const b=await q.lesen(offset,len,signal);if(signal.aborted)throw new HexFehler('zeitlimit');return b;
  };
  const visit=async(k:Knoten,basis:number,erster:number,pfad:string):Promise<void>=>{
   if(stopp||!k.blaetter||erster+k.blaetter<=ab)return;
   const i0=Math.max(0,Math.floor((ab-erster)/k.einzeln));
   for(let i=i0;i<k.anzahl&&!stopp;i++){
    const pos=exakt(BigInt(basis)+BigInt(k.offset)+BigInt(i)*BigInt(k.schritt)),index=erster+i*k.einzeln;
    const name=pfad+k.name+(k.anzahl!==1?'['+i+']':'');
    if(k.typ==='struct'){let idx=index;for(const f of k.felder){await visit(f,pos,idx,name+'.');idx+=f.blaetter;if(stopp)break;}continue;}
    const b=await read(pos,k.breite),varianten=k.endians.length?k.endians:[null];
    for(let vi=0;vi<varianten.length;vi++){
     const feldIndex=index+vi;if(feldIndex<ab)continue;
     const endian=varianten[vi];
     const wert=k.typ==='string'?deuteString(b,k):deuteHexPrimitive(b,k.typ,endian??'le');
     const feld={index:feldIndex,pfad:name+(varianten.length>1?'.'+endian:''),typ:k.typ,endianness:endian,
      offset:String(pos),offset_hex:'0x'+pos.toString(16),laenge:k.breite,bytes:b.toString('hex'),...wert};
     felder.push(feld);antwort.naechstes_feld=feldIndex+1;
     if(JSON.stringify(antwort).length>stand.werte.antwort_zeichen.wert){felder.pop();antwort.naechstes_feld=feldIndex;stopp=true;break;}
     if(felder.length>=limit){stopp=true;break;}
    }
   }
  };
  let idx=0;for(const k of knoten){await visit(k,start,idx,'');idx+=k.blaetter;if(stopp)break;}
  const gruppen=new Map<string,{offset:number;laenge:number;summen:Summe[]}>();
  for(const raw of sums){
   if(!OBJEKT(raw)||Object.keys(raw).some(k=>!['algorithmus','offset','laenge'].includes(k))||!['crc32','adler32','md5','sha1','sha256'].includes(String(raw.algorithmus)))throw new HexFehler('pruefsumme_ungueltig');
   const offset=hexGanzzahl(raw.offset,'pruefsumme.offset',start),len=hexGanzzahl(raw.laenge??args.laenge,'pruefsumme.laenge',q.groesse-offset);
   if(offset>q.groesse||len>q.groesse-offset)throw new HexFehler('bereich_ausserhalb',{parameter:'pruefsumme'});
   const key=offset+':'+len,g=gruppen.get(key)??{offset,laenge:len,summen:[]};
   if(g.summen.some(s=>s.algorithmus===raw.algorithmus))continue;
   const alg=String(raw.algorithmus);g.summen.push({algorithmus:alg,hash:['md5','sha1','sha256'].includes(alg)?createHash(alg):undefined,crc:0xffffffff,a:1,b:0});gruppen.set(key,g);
  }
  for(const g of gruppen.values()){
   if(g.laenge>stand.werte.scan_bytes.wert-gelesen)throw new HexFehler('budget_ueberschritten',{parameter:'scan_bytes'});
   const chunk=Math.min(stand.werte.chunk_bytes.wert,stand.werte.ram_bytes.wert);
   for(let off=0;off<g.laenge;off+=chunk){
    const b=await read(g.offset+off,Math.min(chunk,g.laenge-off));
    for(const s of g.summen){
     if(s.hash)s.hash.update(b);
     else if(s.algorithmus==='crc32'){for(const n of b)s.crc=CRC_TABELLE[(s.crc^n)&255]^(s.crc>>>8);}
     else for(const n of b){s.a=(s.a+n)%65521;s.b=(s.b+s.a)%65521;}
    }
   }
   for(const s of g.summen){
    const hex=s.hash?s.hash.digest('hex'):(s.algorithmus==='crc32'?(s.crc^0xffffffff)>>>0:((s.b<<16)|s.a)>>>0).toString(16).padStart(8,'0');
    pruefsummen.push({algorithmus:s.algorithmus,offset:String(g.offset),laenge:g.laenge,wert_hex:hex,revision:q.revision});
   }
  }
  if(signal.aborted)throw new HexFehler('zeitlimit');
  const next=Number(antwort.naechstes_feld);antwort.vollstaendig=next>=total;antwort.naechstes_feld=next>=total?null:next;
  if(!felder.length&&total>ab)throw new HexFehler('budget_ueberschritten',{parameter:'antwort_zeichen'});
  if(JSON.stringify(antwort).length>stand.werte.antwort_zeichen.wert)throw new HexFehler('budget_ueberschritten',{parameter:'antwort_zeichen'});
  return antwort;
 });
}
