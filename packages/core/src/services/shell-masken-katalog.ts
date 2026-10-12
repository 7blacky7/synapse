/** P10-T42: EIN Katalog für Live-Regeln und Ersetzungsprovenienz; keine zweite Maskierungsregelmenge. */
import {istShellGeheimnisName,SHELL_LITERAL_MIN_LAENGE,URL_ZUGANGSDATEN,MCP_JSON_FELD_PREFIX,MCP_JSON_FELD_WERT} from './mcp-json-maske.js';
export const SHELL_KV_ZEILE=/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(.*)$/;
export const SHELL_BEARER=/(Bearer\s+)[A-Za-z0-9._~+\/=-]+/gi;
export const SHELL_JSON_FREI=/(^|[\s,{])(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\2(\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
export const SHELL_KV_FREI=/(^|[\s,{"'])([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;\\]+)/g;
export type ShellMaskenRegel='env_literal'|'url_passwort'|'bearer'|'kv_geheimname'|'json_geheimname'|'mcp_json_feld'|'sshpass_passwort';
export interface ShellMaskenTreffer {regel:ShellMaskenRegel;name?:string;start:number;ende:number;konfiguration:boolean;literal_normales_wort:boolean;}
export function shellIstLeerWert(wert:string):boolean{
 const w=wert.trim();return w===''||w.startsWith('#')||/^(""|''|\x60\x60)\s*(#.*)?$/.test(w);
}
const matcherCache=new WeakMap<readonly string[],RegExp|readonly string[]|null>();
export function holeShellLiteralMatcher(bekannteWerte:readonly string[]){
 let matcher=matcherCache.get(bekannteWerte);
 if(matcher===undefined){
  const werte=[...new Set(bekannteWerte)].filter(w=>w.length>=SHELL_LITERAL_MIN_LAENGE&&w!=='[WERT]').sort((a,b)=>b.length-a.length);
  matcher=werte.reduce((n,w)=>n+w.length,0)>32768?werte:werte.length?new RegExp('\\[WERT\\]|'+werte.map(w=>w.replace(/[.*+?^\x24{}()|[\]\\]/g,'\\$&')).join('|'),'g'):null;
  matcherCache.set(bekannteWerte,matcher);
 }
 return matcher;
}
const kopie=(r:RegExp)=>new RegExp(r.source,r.flags.includes('g')?r.flags:r.flags+'g');
const prioritaet:Record<ShellMaskenRegel,number>={env_literal:1,mcp_json_feld:2,json_geheimname:3,kv_geheimname:4,bearer:5,url_passwort:6,sshpass_passwort:7};
/** Kategorien beziehen sich ausschließlich auf tatsächliche gemeinsame Maskenregeln. */
export function sammleShellMaskenTreffer(text:string,werte:readonly string[],opt:{name?:string;strukturiert?:boolean}={}):ShellMaskenTreffer[]{
 const original=text,treffer:ShellMaskenTreffer[]=[];
 const addRaw=(regel:ShellMaskenRegel,start:number,ende:number,name?:string,konfiguration=false)=>{
  if(ende<=start)return;const raw=original.slice(start,ende),word=raw.replace(/^["'\x60]|["'\x60]$/g,'');
  if(raw==='[WERT]'||word==='[WERT]')return;
  treffer.push({regel,start,ende,name,konfiguration,literal_normales_wort:/^\p{L}{8,}$/u.test(word)});
 };
 const literals:Array<{start:number;ende:number}>=[];
 const matcher=holeShellLiteralMatcher(werte);
 if(matcher instanceof RegExp){for(const m of original.matchAll(kopie(matcher)))if(m[0]!=='[WERT]')literals.push({start:m.index!,ende:m.index!+m[0].length});}
 else if(matcher){
  let base=0;for(const part of original.split('[WERT]')){
   for(const value of matcher){let at=0;while((at=part.indexOf(value,at))>=0){const start=base+at,end=start+value.length;if(!literals.some(t=>t.start<end&&t.ende>start))literals.push({start,ende:end});at+=value.length;}}
   base+=part.length+6;
  }
 }
 literals.sort((a,b)=>a.start-b.start);
 const teile:Array<{start:number;ende:number;rohStart:number;rohEnde:number;maske:boolean}>=[];
 let cursor=0,neu='';
 for(const l of literals){
  if(l.start>cursor){teile.push({start:neu.length,ende:neu.length+l.start-cursor,rohStart:cursor,rohEnde:l.start,maske:false});neu+=original.slice(cursor,l.start);}
  teile.push({start:neu.length,ende:neu.length+6,rohStart:l.start,rohEnde:l.ende,maske:true});neu+='[WERT]';cursor=l.ende;
  addRaw('env_literal',l.start,l.ende,opt.name);
 }
 if(cursor<original.length){teile.push({start:neu.length,ende:neu.length+original.length-cursor,rohStart:cursor,rohEnde:original.length,maske:false});neu+=original.slice(cursor);}
 text=neu;
 const teilAn=(at:number)=>{
  let lo=0,hi=teile.length;
  while(lo<hi){const m=(lo+hi)>>1;if(teile[m].ende<=at)lo=m+1;else hi=m;}
  return teile[lo];
 };
 const startAn=(at:number)=>{const p=teilAn(at);return p?(p.maske?p.rohStart:p.rohStart+at-p.start):original.length;};
 const endeAn=(at:number)=>{const p=teilAn(Math.max(0,at-1));return p?(p.maske?p.rohEnde:p.rohStart+at-p.start):original.length;};
 const add=(regel:ShellMaskenRegel,start:number,end:number,name?:string,config=false)=>{
  const v=text.slice(start,end).replace(/^["'\x60]|["'\x60]$/g,'');if(v==='[WERT]'||!v)return;
  addRaw(regel,startAn(start),endeAn(end),name,config);
 };
 const namen:Array<{start:number;ende:number;name:string}>=[];
 let offset=0;
 for(const line of text.split('\n')){
  const body=line.endsWith('\r')?line.slice(0,-1):line,kv=SHELL_KV_ZEILE.exec(body);
  if(kv){
   const start=offset+kv[1].length+kv[2].length+kv[3].length;namen.push({start,ende:offset+body.length,name:kv[2]});
   if(istShellGeheimnisName(kv[2])&&!shellIstLeerWert(kv[4]))add('kv_geheimname',start,offset+body.length,kv[2],true);
  }
  for(const m of body.matchAll(kopie(MCP_JSON_FELD_PREFIX))){
   let name='';try{name=JSON.parse(m[1]);}catch{/* Unvollständige Logfragmente sind kein verifizierter Feldname. */}
   const start=offset+m.index!+m[0].length,value=MCP_JSON_FELD_WERT.exec(body.slice(m.index!+m[0].length));
   if(value){namen.push({start,ende:start+value[0].length,name});if(istShellGeheimnisName(name)&&!value[0].trim().startsWith('{')&&!value[0].trim().startsWith('['))add('json_geheimname',start,start+value[0].length,name);}
  }
  offset+=line.length+1;
 }
 for(const m of text.matchAll(kopie(SHELL_KV_FREI))){
  const start=m.index!+m[1].length+m[2].length+m[3].length,end=m.index!+m[0].length;namen.push({start,ende:end,name:m[2]});
  if(istShellGeheimnisName(m[2]))add('kv_geheimname',start,end,m[2]);
 }
 for(const m of text.matchAll(kopie(SHELL_JSON_FREI)))if(istShellGeheimnisName(m[3])){const start=m.index!+m[0].length-m[5].length;add('json_geheimname',start,start+m[5].length,m[3]);}
 const nameAn=(start:number,end:number)=>namen.filter(n=>n.start<=start&&n.ende>=end).sort((a,b)=>(a.ende-a.start)-(b.ende-b.start))[0]?.name??opt.name;
 // Schon ersetzte Literale behalten den tatsächlichen Feldnamen, auch bei öffentlichen Flags.
 const rohNamen=namen.map(n=>({...n,start:startAn(n.start),ende:endeAn(n.ende)}));
 for(const t of treffer)if(t.regel==='env_literal'){
  const n=rohNamen.filter(n=>n.start<=t.start&&n.ende>=t.ende).sort((a,b)=>(a.ende-a.start)-(b.ende-b.start))[0];
  if(n)t.name=n.name;
 }
 for(const m of text.matchAll(kopie(URL_ZUGANGSDATEN))){const start=m.index!+m[1].length,end=m.index!+m[0].length-1;add('url_passwort',start,end,nameAn(start,end));}
 for(const m of text.matchAll(kopie(SHELL_BEARER))){const start=m.index!+m[1].length,end=m.index!+m[0].length;add('bearer',start,end,nameAn(start,end)??'Authorization');}
 // Kategorien vorhandener Literal-Ersetzungen: Grenzen NICHT erweitern, keine neuen Ersetzungen erfinden.
 const annotiere=(regel:ShellMaskenRegel,start:number,end:number,name?:string,config=false)=>{
  for(const t of treffer)if(t.start<end&&t.ende>start){t.konfiguration ||=config;if(prioritaet[regel]>prioritaet[t.regel]){t.regel=regel;t.name=name??t.name;}}
 };
 for(const m of original.matchAll(kopie(URL_ZUGANGSDATEN)))annotiere('url_passwort',m.index!+m[1].length,m.index!+m[0].length-1,opt.name);
 for(const m of original.matchAll(kopie(SHELL_BEARER)))annotiere('bearer',m.index!+m[1].length,m.index!+m[0].length,opt.name??'Authorization');
 offset=0;
 for(const line of original.split('\n')){
  const kv=SHELL_KV_ZEILE.exec(line);
  if(kv&&istShellGeheimnisName(kv[2]))annotiere('kv_geheimname',offset+kv[1].length+kv[2].length+kv[3].length,offset+line.length,kv[2],true);
  offset+=line.length+1;
 }
 for(const m of original.matchAll(kopie(SHELL_KV_FREI)))if(istShellGeheimnisName(m[2]))annotiere('kv_geheimname',m.index!+m[1].length+m[2].length+m[3].length,m.index!+m[0].length,m[2]);
 for(const m of original.matchAll(/(?:^|\s)sshpass\s+-p\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)/g)){
  const q=/^["']/.test(m[1]),start=m.index!+m[0].length-m[1].length+(q?1:0),end=m.index!+m[0].length-(q?1:0);
  annotiere('sshpass_passwort',start,end,'sshpass -p');
 }
 if(opt.strukturiert&&opt.name&&istShellGeheimnisName(opt.name)){
  const start=/^[A-Za-z_][A-Za-z0-9_.-]*=/.test(original)?original.indexOf('=')+1:0;addRaw('json_geheimname',start,original.length,opt.name);
 }
 treffer.sort((a,b)=>a.start-b.start||b.ende-a.ende);
 const aus:ShellMaskenTreffer[]=[];
 for(const t of treffer){const last=aus[aus.length-1];if(last&&t.start<last.ende){
  last.ende=Math.max(last.ende,t.ende);last.konfiguration ||=t.konfiguration;
  if(prioritaet[t.regel]>prioritaet[last.regel]){last.regel=t.regel;last.name=t.name??last.name;}else last.name ??=t.name;
  last.literal_normales_wort=last.literal_normales_wort&&t.literal_normales_wort;
 }else aus.push({...t});}
 return aus;
}
