/** P21-T7: resumierbare Struktur-VM. Cursor speichert nur Kontrollstand/Byteadressen, keine gelesenen Werte. */
import {HexFehler,type HexQuelle} from './hex-quellen.js';
import type {HexStand} from './hex-einstellungen.js';
import {evalFormatExpr,FORMAT_ZAHL,type Ast,type Expr,type Feld,type FormatProgramm,type Struktur} from './hex-format-sprache.js';
interface ZahlRef {offset:number;typ:string}
interface Frame {
 typ:string;pfad:string;base:number;pos:number;end:number;index:number;inst:number;
 vars:Record<string,ZahlRef>;sichtbar?:boolean;rep?:{index:number;count:number};rueckkehr?:number;
}
export interface FormatZustand {version:1;frames:Frame[];auswahl:string;array_start:number;array_anzahl:number;gefunden:boolean}
export interface FormatKnoten {pfad:string;elternpfad:string;art:string;offset:string;offset_hex:string;laenge:string|null;[k:string]:unknown}
class SeiteEnde extends Error{constructor(public grund:string){super(grund);}}
function eltern(p:string):string{const a=p.lastIndexOf('.'),b=p.lastIndexOf('[');return p.slice(0,Math.max(a,b))||'$';}
function knoten(p:string,art:string,off:number,len:number|null):FormatKnoten{return {pfad:p,elternpfad:eltern(p),art,offset:String(off),offset_hex:'0x'+off.toString(16),laenge:len===null?null:String(len)};}
function sicher(v:bigint,p:string):number{if(v<0n||v>BigInt(Number.MAX_SAFE_INTEGER))throw new HexFehler('format_bereich_ungueltig',{pfad:p});return Number(v);}
function zahlenwert(b:Buffer,t:string,endian:string|undefined):bigint|number|string{
 const n=Number(t[1]),le=t.endsWith('le')||(!t.endsWith('be')&&endian==='le');
 if(t[0]==='f'){
  const x=n===4?(le?b.readFloatLE():b.readFloatBE()):(le?b.readDoubleLE():b.readDoubleBE());
  return Number.isNaN(x)?'NaN':x===Infinity?'+Infinity':x===-Infinity?'-Infinity':Object.is(x,-0)?'-0':x;
 }
 if(n===8)return t[0]==='s'?(le?b.readBigInt64LE():b.readBigInt64BE()):(le?b.readBigUInt64LE():b.readBigUInt64BE());
 return BigInt(t[0]==='s'?(le?b.readIntLE(0,n):b.readIntBE(0,n)):(le?b.readUIntLE(0,n):b.readUIntBE(0,n)));
}
export function neuerFormatZustand(groesse:number,offset:number,auswahl='$',array_start=0,array_anzahl=Number.MAX_SAFE_INTEGER):FormatZustand{
 return {version:1,frames:[{typ:'$',pfad:'$',base:offset,pos:offset,end:groesse,index:0,inst:0,vars:{}}],auswahl,array_start,array_anzahl,gefunden:auswahl==='$'};
}
export async function interpretiereHexFormat(p:FormatProgramm,q:HexQuelle,stand:HexStand,signal:AbortSignal,
 state:FormatZustand,maxZeichen:number):Promise<{baum:FormatKnoten[];zustand:FormatZustand;vollstaendig:boolean;grund:string|null;budget:Record<string,number>}>{
 const w=stand.werte,baum:FormatKnoten[]=[],f=p.format;let readBytes=0,exprSteps=0,steps=0,outBytes=0,outRaw=0,grund:string|null=null;
 const maxOut=Math.min(w.hex_bytes.wert,w.max_hex_bytes.wert,w.ram_bytes.wert);
 const maxRead=Math.min(w.scan_bytes.wert,w.ram_bytes.wert),cache=new Map<string,bigint>();
 const tick=()=>{if(signal.aborted)throw new SeiteEnde('laufzeit_ms');if(++exprSteps>w.max_expr_schritte.wert)throw new SeiteEnde('max_expr_schritte');};
 const struktur=(t:string):Struktur=>t==='$'?f:f.types![t];
 async function lesen(off:number,n:number):Promise<Buffer>{
  if(signal.aborted)throw new SeiteEnde('laufzeit_ms');
  if(n>maxRead)throw new HexFehler('budget_ueberschritten',{parameter:'scan_bytes',benoetigt:n,max_bytes:maxRead});
  if(readBytes+n>maxRead)throw new SeiteEnde('scan_bytes');readBytes+=n;
  try{return await q.lesen(off,n,signal);}catch(e){if(signal.aborted)throw new SeiteEnde('laufzeit_ms');throw e;}
 }
 async function expr(v:Expr,fr:Frame,index:number):Promise<bigint>{
  const ast=p.ausdruecke.get(JSON.stringify(v));if(!ast)throw new HexFehler('format_ausdruck_fehlt');
  const vals=new Map<string,bigint>(),todo:Ast[]=[ast];
  while(todo.length){
   tick();const a=todo.pop()!;
   if(a.k==='b')todo.push(a.a,a.b);if(a.k==='u')todo.push(a.a);
   if(a.k!=='r'||vals.has(a.v))continue;const n=a.v;let val:bigint;
   if(n==='true'||n==='false')val=n==='true'?1n:0n;
   else if(n==='_index')val=BigInt(index);
   else if(n==='_io.size')val=BigInt(fr.end-fr.base);
   else if(n==='_io.pos')val=BigInt(fr.pos-fr.base);
   else{
    const root=n.startsWith('_root.'),vr=(root?state.frames[0].vars:fr.vars)[root?n.slice(6):n];
    if(!vr||typeof vr.offset!=='number')throw new HexFehler('format_referenz_nicht_verfuegbar',{referenz:n});
    const key=vr.offset+':'+vr.typ,old=cache.get(key);
    if(old!==undefined)val=old;
    else{const b=await lesen(vr.offset,Number(vr.typ[1])),x=zahlenwert(b,vr.typ,f.meta.endian);if(typeof x!=='bigint')throw new HexFehler('format_referenz_nicht_ganzzahlig');val=x;cache.set(key,val);}
   }vals.set(n,val);
  }return evalFormatExpr(ast,n=>{const v=vals.get(n);if(v===undefined)throw new HexFehler('format_referenz_fehlt');return v;},tick);
 }
 function relevant(path:string):boolean{return state.auswahl==='$'||path===state.auswahl||path.startsWith(state.auswahl+'.')||path.startsWith(state.auswahl+'[');}
 function ancestor(path:string):boolean{return state.auswahl.startsWith(path+'.')||state.auswahl.startsWith(path+'[');}
 function add(n:FormatKnoten):void{
  if(!relevant(n.pfad))return;
  if(n.pfad===state.auswahl)state.gefunden=true;
  if(baum.length>=w.max_struktur_knoten.wert)throw new SeiteEnde('max_struktur_knoten');
  const size=JSON.stringify(n).length+1;
  if(size>maxZeichen)throw new HexFehler('budget_ueberschritten',{parameter:'antwort_zeichen'});
  if(outBytes+size>maxZeichen)throw new SeiteEnde('antwort_zeichen');
  const raw=typeof n.bytes_hex==='string'?n.bytes_hex.length/2:0;
  if(raw>maxOut)throw new HexFehler('budget_ueberschritten',{parameter:'hex_bytes',max_bytes:maxOut});
  if(outRaw+raw>maxOut)throw new SeiteEnde('hex_bytes');
  baum.push(n);outBytes+=size;outRaw+=raw;
 }
 function range(fr:Frame,off:number,len:number,path:string):void{
  if(!Number.isSafeInteger(off)||!Number.isSafeInteger(len)||off<fr.base||len<0||off>fr.end||len>fr.end-off)throw new HexFehler('format_feld_ausserhalb',{pfad:path,offset:String(off),laenge:String(len),ende:String(fr.end)});
 }
 let last=JSON.stringify(state);
 try{
  while(state.frames.length){
   last=JSON.stringify(state);
   if(signal.aborted)throw new SeiteEnde('laufzeit_ms');
   if(++steps>w.max_format_schritte.wert)throw new SeiteEnde('max_format_schritte');
   if(Buffer.byteLength(last)+p.kanonisch.length+outBytes+readBytes+cache.size*128>w.ram_bytes.wert)throw new SeiteEnde('ram_bytes');
   const fr=state.frames[state.frames.length-1],s=struktur(fr.typ),instances=Object.entries(s.instances??{});
   if(fr.index>=s.seq.length&&fr.inst>=instances.length){
    state.frames.pop();const parent=state.frames[state.frames.length-1];
    if(parent)parent.pos=fr.rueckkehr??fr.pos;
    continue;
   }
   const instance=fr.index>=s.seq.length;
   const field:Feld=instance?{...instances[fr.inst][1],id:instances[fr.inst][0]}:s.seq[fr.index];
   const basePath=fr.pfad+'.'+field.id,idx=fr.rep?.index??0;
   if(field.if!==undefined&&!fr.rep&&(await expr(field.if,fr,idx))===0n){if(instance)fr.inst++;else fr.index++;continue;}
   if(!instance&&field.repeat==='expr'&&!fr.rep){
    const count=sicher(await expr(field['repeat-expr']!,fr,0),basePath);
    if(count>w.max_format_wiederholungen.wert)throw new HexFehler('budget_ueberschritten',{parameter:'max_format_wiederholungen',pfad:basePath,count});
    fr.rep={index:0,count};if(fr.sichtbar!==false)add({...knoten(basePath,'array',fr.pos,null),anzahl:String(count)});
    if(!count){delete fr.rep;fr.index++;}continue;
   }
   const path=fr.rep?basePath+'['+idx+']':basePath;
   const begrenzt=fr.rep&&(state.auswahl===basePath||state.auswahl==='$'&&fr.pfad==='$');
   const showArray=fr.sichtbar!==false&&(!begrenzt||idx>=state.array_start&&idx-state.array_start<state.array_anzahl);
   let off=fr.pos,end=fr.end;
   if(instance){
    off=fr.base+sicher(await expr(field.pos!,fr,idx),path);
    const n=sicher(await expr(field.size!,fr,idx),path);range(fr,off,n,path);end=off+n;
    if(!relevant(path)&&!ancestor(path)){fr.inst++;continue;}
    // Root selection lists lazy instances, but does not eagerly execute them.
    if(state.auswahl!==path&&!ancestor(path)){
     if(fr.sichtbar!==false)add({...knoten(path,'instance',off,n),lazy:true,folgeaufruf:{feldpfad:path}});fr.inst++;continue;
    }
   }
   let typ=field.contents!==undefined?'bytes':field.type!;
   if(typeof typ!=='string'){
    const key=(await expr(typ['switch-on'],fr,idx)).toString();
    const selected=Object.hasOwn(typ.cases,key)?typ.cases[key]:typ.cases['_'];
    if(!selected)throw new HexFehler('format_switch_ohne_fall',{pfad:path});typ=selected;
   }
   const magic=field.contents===undefined?null:typeof field.contents==='string'?Buffer.from(field.contents,'utf8'):Buffer.from(field.contents);
   const local=Object.hasOwn(f.types??{},typ);
   let len=magic?.length??(FORMAT_ZAHL.test(typ)?Number(typ[1]):null);
   if(field.size!==undefined)len=sicher(await expr(field.size,fr,idx),path);
   if(len!==null)range(fr,off,len,path);
   if(instance&&len!==null&&off+len>end)throw new HexFehler('format_feld_ausserhalb',{pfad:path});
   const wanted=showArray&&(relevant(path)||ancestor(path));
   if(local){
    if(state.frames.length>=w.max_struktur_tiefe.wert)throw new HexFehler('budget_ueberschritten',{parameter:'max_struktur_tiefe'});
    // Explizite substreams sind sicher ueberspringbar, unbekannte Laengen werden interpretiert.
    if(!wanted&&len!==null){fr.pos=instance?fr.pos:off+len;}
    else{
     if(showArray)add({...knoten(path,'struktur',off,len),typ});
     const returnPos=instance?fr.pos:len===null?undefined:off+len;
     if(instance)fr.inst++;else if(fr.rep){if(++fr.rep.index===fr.rep.count){delete fr.rep;fr.index++;}}else fr.index++;
     state.frames.push({typ,pfad:path,base:off,pos:off,end:len===null?end:off+len,index:0,inst:0,vars:{},sichtbar:wanted,rueckkehr:returnPos});
     continue;
    }
   }else{
    if(len===null)throw new HexFehler('format_groesse_fehlt',{pfad:path});
    const natural=FORMAT_ZAHL.test(typ)?Number(typ[1]):len;
    if(FORMAT_ZAHL.test(typ)&&natural!==len)throw new HexFehler('format_groesse_ungueltig',{pfad:path});
    // Nicht angeforderte Byte-/Stringfelder werden nicht materialisiert; Magic wird immer validiert.
    if(wanted||magic){
     if(len>w.max_format_feld_bytes.wert)throw new HexFehler('budget_ueberschritten',{parameter:'max_format_feld_bytes',pfad:path,benoetigt:len});
     const b=await lesen(off,len);let value:unknown=null;
     if(magic){if(!b.equals(magic))throw new HexFehler('format_magic_falsch',{pfad:path,offset:String(off)});}
     else if(FORMAT_ZAHL.test(typ)){
      const x=zahlenwert(b,typ,f.meta.endian);value=typeof x==='bigint'?{dezimal:x.toString(),hex:(x<0n?'-0x'+(-x).toString(16):'0x'+x.toString(16))}:x;
     }else if(typ==='str'){
      if(field.encoding==='ascii'){if(b.some(v=>v>127))throw new HexFehler('format_encoding_ungueltig',{pfad:path});value=b.toString('ascii');}
      else{try{value=new TextDecoder(field.encoding,{fatal:true,ignoreBOM:true}).decode(b);}catch{throw new HexFehler('format_encoding_ungueltig',{pfad:path});}}
     }
     if(showArray&&relevant(path)){
      const n:FormatKnoten={...knoten(path,magic?'magic':'feld',off,len),typ,bytes_hex:b.toString('hex')};
      if(typ!=='bytes')n.wert=value;
      if(FORMAT_ZAHL.test(typ)&&Number(typ[1])>1)n.endian=typ.endsWith('le')?'le':typ.endsWith('be')?'be':f.meta.endian;
      if(typ==='str')n.encoding=field.encoding;
      if(field.enum){const x=zahlenwert(b,typ,f.meta.endian);n.enum=field.enum;n.enum_name=f.enums![field.enum][String(x)]??null;}
      add(n);
     }
    }
    if(!instance&&!fr.rep&&/^[us]/.test(typ)&&FORMAT_ZAHL.test(typ))fr.vars[field.id]={offset:off,typ};
    if(!instance)fr.pos=off+len;
   }
   if(instance)fr.inst++;else if(fr.rep){if(++fr.rep.index===fr.rep.count){delete fr.rep;fr.index++;}}else fr.index++;
  }
 }catch(e){
  if(!(e instanceof SeiteEnde))throw e;
  state=JSON.parse(last) as FormatZustand;grund=e.grund;
  if(!baum.length&&steps<=1)throw new HexFehler('budget_ueberschritten',{parameter:e.grund});
 }
 if(!state.frames.length&&!state.gefunden)throw new HexFehler('format_feldpfad_unbekannt',{feldpfad:state.auswahl});
 return {baum,zustand:state,vollstaendig:state.frames.length===0,grund,budget:{gelesene_bytes:readBytes,ausgabe_bytes:outRaw,expr_schritte:exprSteps,format_schritte:steps,knoten:baum.length,ausgabe_zeichen:outBytes}};
}
