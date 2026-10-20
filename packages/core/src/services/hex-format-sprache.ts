/** P21-T7: begrenzte Kaitai-Lesesprache; kein Compiler und keine Codeausfuehrung. */
import {createHash} from 'node:crypto';
import {HexFehler} from './hex-quellen.js';
import type {HexStand} from './hex-einstellungen.js';
export type Expr=number|string|boolean;
export type Ast={k:'n';v:string}|{k:'r';v:string}|{k:'u';op:string;a:Ast}|{k:'b';op:string;a:Ast;b:Ast};
export interface Feld {
 id:string;type?:string|{'switch-on':Expr;cases:Record<string,string>};size?:Expr;contents?:string|number[];
 encoding?:string;enum?:string;if?:Expr;repeat?:'expr';'repeat-expr'?:Expr;pos?:Expr;
}
export interface Struktur {seq:Feld[];instances?:Record<string,Omit<Feld,'id'>>}
export interface Format extends Struktur {
 profil:'kaitai-read-v1';meta:{id:string;endian?:'le'|'be'};
 types?:Record<string,Struktur>;enums?:Record<string,Record<string,string>>;
}
export interface FormatProgramm {format:Format;kanonisch:string;hash:string;ausdruecke:Map<string,Ast>}
export const FORMAT_ZAHL=/^(?:[us][1248](?:le|be)?|f[48](?:le|be)?)$/;
const NAME=/^[a-z][a-z0-9_]*$/;
export function formatFehler(pfad:string,grund:string):never{throw new HexFehler('format_ungueltig',{pfad,grund});}
function obj(v:unknown,p:string):Record<string,unknown>{
 if(!v||typeof v!=='object'||Array.isArray(v))formatFehler(p,'Objekt erwartet');return v as Record<string,unknown>;
}
function keys(v:Record<string,unknown>,ks:string[],p:string):void{
 for(const k of Object.keys(v))if(!ks.includes(k))formatFehler(p+'.'+k,'Konstrukt nicht in kaitai-read-v1');
}
function name(v:unknown,p:string):asserts v is string{if(typeof v!=='string'||!NAME.test(v)||['constructor','prototype'].includes(v))formatFehler(p,'Bezeichner erwartet');}
const OPS:Record<string,number>={'||':1,'&&':2,'|':3,'^':4,'&':5,'==':6,'!=':6,'<':7,'<=':7,'>':7,'>=':7,'<<':8,'>>':8,'+':9,'-':9,'*':10,'/':10,'%':10};
export function parseFormatExpr(expr:Expr,maxTiefe:number):Ast{
 if(typeof expr==='boolean')return {k:'n',v:expr?'1':'0'};
 if(typeof expr==='number'){if(!Number.isSafeInteger(expr))formatFehler('expr','Sichere Ganzzahl erwartet');return {k:'n',v:String(expr)};}
 if(typeof expr!=='string'||!expr.length)formatFehler('expr','Ausdruck erwartet');
 const tokens:string[]=[];let i=0;
 while(i<expr.length){
  if(/\s/.test(expr[i])){i++;continue;}
  const m=/^(0x[0-9a-fA-F]+|[0-9]+|[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*|\|\||&&|==|!=|<=|>=|<<|>>|[()+\-*\/%<>&|^!~])/.exec(expr.slice(i));
  if(!m)formatFehler('expr','Unbekanntes Token');tokens.push(m[0]);i+=m[0].length;
 }
 let pos=0;
 function read(min:number,depth:number):Ast{
  if(depth>maxTiefe)formatFehler('expr','Ausdruck zu tief');
  const t=tokens[pos++];let a:Ast;
  if(t==='('){a=read(0,depth+1);if(tokens[pos++]!==')')formatFehler('expr','Klammer fehlt');}
  else if(['+','-','!','~'].includes(t))a={k:'u',op:t,a:read(11,depth+1)};
  else if(t&&/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(t)){if(t.length>20)formatFehler('expr','Zahl ausserhalb u64');a={k:'n',v:BigInt(t).toString()};}
  else if(t&&/^[a-z_]/.test(t))a={k:'r',v:t};
  else formatFehler('expr','Operand fehlt');
  while(pos<tokens.length){
   const op=tokens[pos],prio=OPS[op];if(prio===undefined||prio<min)break;
   pos++;a={k:'b',op,a,b:read(prio+1,depth+1)};
  }return a;
 }
 const ast=read(0,0);if(pos!==tokens.length)formatFehler('expr','Unerwartetes Token');return ast;
}
const MIN=-(1n<<63n),MAX=(1n<<64n)-1n;
export function evalFormatExpr(a:Ast,ref:(n:string)=>bigint,tick:()=>void):bigint{
 tick();let v:bigint;
 if(a.k==='n')v=BigInt(a.v);else if(a.k==='r')v=ref(a.v);
 else if(a.k==='u'){const x=evalFormatExpr(a.a,ref,tick);v=a.op==='-'?-x:a.op==='!'?(x===0n?1n:0n):a.op==='~'?~x:x;}
 else{
  const x=evalFormatExpr(a.a,ref,tick);
  if(a.op==='&&'&&x===0n)return 0n;if(a.op==='||'&&x!==0n)return 1n;
  const y=evalFormatExpr(a.b,ref,tick);
  if((a.op==='/'||a.op==='%')&&y===0n)throw new HexFehler('format_division_null');
  if((a.op==='<<'||a.op==='>>')&&(y<0n||y>63n))throw new HexFehler('format_shift_ungueltig');
  switch(a.op){
   case '+':v=x+y;break;case '-':v=x-y;break;case '*':v=x*y;break;case '/':v=x/y;break;case '%':v=x%y;break;
   case '&':v=x&y;break;case '|':v=x|y;break;case '^':v=x^y;break;case '<<':v=x<<y;break;case '>>':v=x>>y;break;
   case '==':v=x===y?1n:0n;break;case '!=':v=x!==y?1n:0n;break;case '<':v=x<y?1n:0n;break;case '<=':v=x<=y?1n:0n;break;
   case '>':v=x>y?1n:0n;break;case '>=':v=x>=y?1n:0n;break;case '&&':v=y!==0n?1n:0n;break;case '||':v=y!==0n?1n:0n;break;
   default:throw new HexFehler('format_operator_ungueltig');
  }
 }if(v<MIN||v>MAX)throw new HexFehler('format_ueberlauf');return v;
}
function canonical(v:unknown):unknown{
 if(Array.isArray(v))return v.map(canonical);
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,canonical(x)]));return v;
}
export function pruefeHexFormat(raw:unknown,stand:HexStand):FormatProgramm{
 const w=stand.werte,limit=Math.min(w.format_bytes.wert,w.ram_bytes.wert),depth=w.max_struktur_tiefe.wert;
 const seen=new Set<object>(),stack=[{v:raw,d:0,p:'$'}];let anzahl=0;
 while(stack.length){
  const {v,d,p}=stack.pop()!;if(++anzahl>w.max_format_felder.wert*32||d>depth*4)formatFehler(p,'Definitionsbudget');
  if(v&&typeof v==='object'){
   if(seen.has(v))formatFehler(p,'Geteiltes/zyklisches Objekt');seen.add(v);
   for(const [k,x] of Object.entries(v))stack.push({v:x,d:d+1,p:p+'.'+k});
  }else if(v!==null&&(!['string','number','boolean'].includes(typeof v)||(typeof v==='number'&&!Number.isSafeInteger(v))))formatFehler(p,'Nur sichere JSON-Werte');
 }
 const text=JSON.stringify(raw);if(!text||Buffer.byteLength(text)>limit)throw new HexFehler('budget_ueberschritten',{parameter:'format_bytes',max_bytes:limit});
 const f=obj(raw,'$');keys(f,['profil','meta','seq','types','enums','instances'],'$');
 if(f.profil!=='kaitai-read-v1')formatFehler('$.profil','kaitai-read-v1 erwartet');
 const m=obj(f.meta,'$.meta');keys(m,['id','endian'],'$.meta');name(m.id,'$.meta.id');
 if(m.endian!==undefined&&m.endian!=='le'&&m.endian!=='be')formatFehler('$.meta.endian','le oder be erwartet');
 const types=f.types===undefined?{}:obj(f.types,'$.types'),enums=f.enums===undefined?{}:obj(f.enums,'$.enums');
 if(Object.keys(types).length>w.max_format_typen.wert)formatFehler('$.types','Typbudget');
 for(const [n,e]of Object.entries(enums)){
  name(n,'$.enums.'+n);for(const [k,v]of Object.entries(obj(e,'$.enums.'+n))){
   if(!/^-?(?:0|[1-9][0-9]*)$/.test(k)||k.length>21||BigInt(k)<MIN||BigInt(k)>MAX)formatFehler('$.enums.'+n,'Ganzzahl erwartet');name(v,'$.enums.'+n+'.'+k);
  }
 }
 const ausdruecke=new Map<string,Ast>(),deps=new Map<string,Set<string>>();let fields=0;
 function expr(v:unknown,p:string,refs:Set<string>){
  if(!['string','number','boolean'].includes(typeof v))formatFehler(p,'Ausdruck erwartet');
  const ast=parseFormatExpr(v as Expr,depth),visit=[{a:ast,d:1}];let n=0;
  while(visit.length){
   const {a,d}=visit.pop()!;if(d>depth)formatFehler(p,'Ausdruck zu tief');if(++n>w.max_expr_schritte.wert)formatFehler(p,'Ausdrucksbudget');
   if(a.k==='r'&&!refs.has(a.v))formatFehler(p,'Unbekannte/vorwaerts gerichtete Referenz: '+a.v);
   if(a.k==='u')visit.push({a:a.a,d:d+1});if(a.k==='b')visit.push({a:a.a,d:d+1},{a:a.b,d:d+1});
  }ausdruecke.set(JSON.stringify(v),ast);
 }
 function typ(t:unknown,p:string,owner:string,refs:Set<string>){
  if(typeof t==='string'){
   if(FORMAT_ZAHL.test(t)){
    if(t[1]!=='1'&&!/(le|be)$/.test(t)&&!m.endian)formatFehler(p,'Explizite Endianness fehlt');
   }else if(!['str','bytes'].includes(t)){
    if(!Object.hasOwn(types,t))formatFehler(p,'Unbekannter lokaler Typ');deps.get(owner)!.add(t);
   }
  }else{
   const s=obj(t,p);keys(s,['switch-on','cases'],p);expr(s['switch-on'],p+'.switch-on',refs);
   const cs=obj(s.cases,p+'.cases');if(!Object.keys(cs).length)formatFehler(p,'Leere cases');
   for(const [k,v]of Object.entries(cs)){
    if(k!=='_'&&!/^-?(?:0|[1-9][0-9]*)$/.test(k))formatFehler(p+'.cases','Numerische Fallwerte oder _ erwartet');
    if(typeof v!=='string')formatFehler(p+'.cases.'+k,'Typname erwartet');typ(v,p+'.cases.'+k,owner,refs);
   }
  }
 }
 const rootRefs=new Set<string>(['_index','_io.size','_io.pos','true','false']);
 const rootSeq=Array.isArray(f.seq)?f.seq:[];for(const x of rootSeq){if(x&&typeof x==='object'&&typeof x.id==='string'&&typeof x.type==='string'&&/^[us]/.test(x.type)&&FORMAT_ZAHL.test(x.type)&&x.repeat===undefined)rootRefs.add('_root.'+x.id);}
 function struktur(s:Record<string,unknown>,p:string,owner:string){
  keys(s,owner==='$'?['profil','meta','seq','types','enums','instances']:['seq','instances'],p);
  if(!Array.isArray(s.seq))formatFehler(p+'.seq','seq erwartet');
  deps.set(owner,new Set());const used=new Set<string>(),refs=new Set(rootRefs);
  if(owner==='$')for(const r of [...refs])if(r.startsWith('_root.'))refs.delete(r);
  function feld(v:unknown,fp:string,instance=false,instanceName?:string){
   if(++fields>w.max_format_felder.wert)formatFehler(fp,'Feldbudget');
   const a=obj(v,fp);keys(a,instance?['type','size','contents','encoding','enum','if','pos']:['id','type','size','contents','encoding','enum','if','repeat','repeat-expr'],fp);
   const id=instance?instanceName:a.id;name(id,fp+'.id');if(used.has(id))formatFehler(fp,'Doppeltes Feld');used.add(id);
   if(a.contents===undefined&&a.type===undefined)formatFehler(fp,'type oder contents erforderlich');
   if(a.contents!==undefined){
    if(a.type!==undefined||a.size!==undefined||a.encoding!==undefined||a.enum!==undefined)formatFehler(fp,'contents bestimmt Typ und Groesse');
    if(typeof a.contents!=='string'&&(!Array.isArray(a.contents)||!a.contents.length||!a.contents.every(n=>Number.isInteger(n)&&n>=0&&n<=255)))formatFehler(fp+'.contents','String oder Bytearray erwartet');
    if(a.contents==='')formatFehler(fp+'.contents','Leere Magic');
   }
   if(a.type!==undefined)typ(a.type,fp+'.type',owner,refs);
   if(a.enum!==undefined&&(typeof a.enum!=='string'||!Object.hasOwn(enums,a.enum)||typeof a.type!=='string'||!FORMAT_ZAHL.test(a.type)||a.type.startsWith('f')))formatFehler(fp+'.enum','Enum benoetigt Ganzzahltyp');
   if(a.encoding!==undefined&&!['utf-8','ascii','utf-16le','utf-16be'].includes(String(a.encoding)))formatFehler(fp+'.encoding','Encoding nicht unterstuetzt');
   const ts=typeof a.type==='string'?[a.type]:a.type?Object.values((a.type as {cases:Record<string,string>}).cases):[];
   if(ts.some(t=>t==='str'||t==='bytes')&&a.size===undefined)formatFehler(fp+'.size','Strings/Bytes brauchen size');
   if(ts.includes('str')&&a.encoding===undefined)formatFehler(fp+'.encoding','Strings brauchen encoding');
   if(a.encoding!==undefined&&!ts.includes('str'))formatFehler(fp+'.encoding','encoding nur fuer str');
   for(const k of ['size','if','repeat-expr','pos'])if(a[k]!==undefined)expr(a[k],fp+'.'+k,refs);
   if(instance&&(a.pos===undefined||a.size===undefined))formatFehler(fp,'Lazy instance braucht pos und size');
   if(a.repeat!==undefined&&a.repeat!=='expr')formatFehler(fp+'.repeat','Nur repeat expr');
   if((a.repeat==='expr')!==(a['repeat-expr']!==undefined))formatFehler(fp+'.repeat-expr','repeat und repeat-expr zusammen angeben');
   if(!instance&&a.repeat===undefined&&typeof a.type==='string'&&/^[us]/.test(a.type)&&FORMAT_ZAHL.test(a.type)){
    refs.add(id);if(owner==='$')refs.add('_root.'+id);
   }
  }
  s.seq.forEach((a,i)=>feld(a,p+'.seq['+i+']'));
  if(s.instances!==undefined)for(const [n,v]of Object.entries(obj(s.instances,p+'.instances')))feld(v,p+'.instances.'+n,true,n);
 }
 struktur(f,'$','$');for(const [n,s]of Object.entries(types)){name(n,'$.types.'+n);if(FORMAT_ZAHL.test(n)||['str','bytes'].includes(n))formatFehler('$.types.'+n,'Reservierter Typname');struktur(obj(s,'$.types.'+n),'$.types.'+n,n);}
 // Keine exponentielle Graphtraversierung: pro Start einmal besuchen, Zyklen per aktivem Pfad.
 const done=new Set<string>(),active=new Set<string>();
 function cycle(n:string):void{if(active.has(n))formatFehler('$.types.'+n,'Zyklischer Typgraph');if(done.has(n))return;active.add(n);for(const d of deps.get(n)??[])cycle(d);active.delete(n);done.add(n);}
 for(const n of deps.keys())cycle(n);
 const heights=new Map<string,number>();
 function height(n:string):number{const old=heights.get(n);if(old!==undefined)return old;let h=1;for(const d of deps.get(n)??[])h=Math.max(h,1+height(d));heights.set(n,h);return h;}
 for(const n of deps.keys())if(height(n)>depth)formatFehler('$.types.'+n,'Strukturtiefe');
 const kanonisch=JSON.stringify(canonical(raw));return {format:JSON.parse(kanonisch) as Format,kanonisch,hash:createHash('sha256').update(kanonisch).digest('hex'),ausdruecke};
}
