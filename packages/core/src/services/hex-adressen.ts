/** P21-T9: Dateioffset/RVA/VA exakt ueber vorhandene Inspektoren und gepinnte Hex-Quelle. */
import {getPool} from '../db/client.js';
import {HexFehler,mitHexQuelle,type HexQuelle} from './hex-quellen.js';
import type {HexStand} from './hex-einstellungen.js';
import type {AssetSource,AssetContext} from '../asset-intel/types.js';
import {AssetLimitError} from '../asset-intel/errors.js';
import {lesePeAdresskarte} from '../asset-intel/inspectors/exe/pe.js';
import {leseElfAdresskarte} from '../asset-intel/inspectors/exe/elf.js';
import type {ExeAdresskarte,ExeBereich} from '../asset-intel/inspectors/exe/adressvertrag.js';
import {leseAltExeAdresskarte} from './hex-exe-alt.js';
import {hexExeFormat} from './hex-exe-formate.js';
export const HEX_ADRESS_PARAMETER={
 von:{type:'string',enum:['datei_offset','rva','va','segment_offset']},
 adresse:{type:['number','string'],description:'Exakte nichtnegative Adresse (dezimal oder 0x, bis u64)'},
 adress_bytes:{type:['number','string'],description:'Vollstaendig abzubildende Bereichslaenge, Standard 1'},
 ladebasis:{type:['number','string'],description:'Explizite Laufzeit-Imagebasis; bei MZ fuer VA erforderlich, ELF ersetzt niedrigste PT_LOAD-Adresse'},
 segment:{type:['number','string'],description:'NE Segmentindex bzw. LE/LX Objektindex, ab 1; bei MZ relatives Paragraphensegment'},
 symbol_offset:{type:['number','string']},symbol_limit:{type:['number','string']},
} as const;
const U64=(1n<<64n)-1n;
export function hexAdresse(v:unknown,name='adresse',fallback?:bigint):bigint{
 if(v===undefined&&fallback!==undefined)return fallback;
 let b:bigint;
 if(typeof v==='number'&&Number.isSafeInteger(v)&&v>=0)b=BigInt(v);
 else if(typeof v==='string'&&/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(v)&&v.length<=22)b=BigInt(v);
 else throw new HexFehler('adresse_ungueltig',{parameter:name});
 if(b<0n||b>U64)throw new HexFehler('adresse_ungueltig',{parameter:name});return b;
}
const wert=(v:bigint|null):{dezimal:string;hex:string}|null=>v===null?null:{dezimal:v.toString(),hex:'0x'+v.toString(16)};
function bereich(v:bigint,start:bigint,len:bigint,bytes:bigint):boolean{return v>=start&&v-start<len&&bytes<=len-(v-start);}
export function rechneHexAdresse(k:ExeAdresskarte,groesse:number,a:Record<string,unknown>,maxTreffer:number):Record<string,unknown>{
 const von=a.von;if(!['datei_offset','rva','va','segment_offset'].includes(String(von)))throw new HexFehler('adressart_ungueltig');
 const input=hexAdresse(a.adresse),bytes=hexAdresse(a.adress_bytes,'adress_bytes',1n);if(bytes===0n)throw new HexFehler('adresse_ungueltig',{parameter:'adress_bytes'});
 const original=k.basis===null?null:BigInt(k.basis),actual=a.ladebasis===undefined?original:hexAdresse(a.ladebasis,'ladebasis');
 if(von==='va'&&k.format==='mz'&&a.ladebasis===undefined)throw new HexFehler('ladebasis_erforderlich');
 if(k.format==='ne'&&(von==='va'||von==='rva'||a.ladebasis!==undefined))throw new HexFehler('ne_segmentadresse_erforderlich');
 if(von==='rva'&&actual===null||von==='va'&&actual===null)throw new HexFehler('adressbasis_unbekannt');
 const seg=a.segment===undefined?null:hexAdresse(a.segment,'segment');
 if(von==='segment_offset'&&seg===null)throw new HexFehler('segment_erforderlich');
 if(seg!==null&&!['mz','ne','le','lx'].includes(k.format))throw new HexFehler('parameter_nicht_verwendet',{parameter:'segment'});
 if(seg!==null&&(seg>65535n||k.format!=='mz'&&seg===0n))throw new HexFehler('segment_ungueltig');
 if(k.format==='mz'&&von==='segment_offset'&&input>65535n)throw new HexFehler('adresse_ungueltig');
 if(von==='datei_offset'&&(input>=BigInt(groesse)||bytes>BigInt(groesse)-input))throw new HexFehler('bereich_ausserhalb');
 const matches:Record<string,unknown>[]=[],covered=new Set<string>();
 // ELF-Sektionen geben Herkunft/ET_REL-Dateibereiche; PT_LOAD ist die verbindliche Speicherabbildung.
 const maps=k.format==='elf'&&k.bereiche.some(b=>b.art==='segment')?k.bereiche.filter(b=>b.art==='segment'):k.bereiche;
 for(const b of maps){
  if(seg!==null&&k.format!=='mz'&&BigInt(b.segment??0)!==seg)continue;
  const file=b.datei_offset===null?null:BigInt(b.datei_offset),raw=BigInt(b.datei_bytes),mem=BigInt(b.speicher_bytes),va=b.va===null?null:BigInt(b.va);
  const rel=va!==null&&original!==null?va-original:null,runva=rel!==null&&actual!==null?actual+rel:va;
  let delta:bigint;
  if(von==='datei_offset'){if(file===null||!bereich(input,file,raw,bytes))continue;delta=input-file;}
  else if(von==='segment_offset'){
   const local=k.format==='mz'?seg!*16n+input:input,base=BigInt(b.segment_offset??0);
   if(!bereich(local,base,mem,bytes))continue;delta=local-base;
  }else{
   const start=von==='rva'?rel:runva;if(start===null||!bereich(input,start,mem,bytes))continue;delta=input-start;
  }
  let off=file===null?null:file+delta,status:string='datei';
  if(b.abbildung==='kodiert'||b.abbildung==='ungueltig'){status=b.abbildung;off=null;}
  else if(file===null||delta>=raw||bytes>raw-delta){status='nur_speicher';off=null;}
  else if(off!<0n||off!>=BigInt(groesse)||bytes>BigInt(groesse)-off!){status='ausserhalb_datei';off=null;}
  if(von==='datei_offset'&&delta>=mem){status='rohdaten_ohne_speicher';}
  const kodiert=status==='kodiert'||status==='ungueltig';
  const outVa=kodiert?null:runva===null||k.format==='mz'&&a.ladebasis===undefined?null:runva+delta,sourceVa=kodiert||va===null?null:va+delta,outRva=kodiert||rel===null?null:rel+delta;
  if([outVa,sourceVa,outRva].some(x=>x!==null&&(x<0n||x>U64)))throw new HexFehler('adresse_ueberlauf');
  const key=[b.art,b.index,off,outVa].join(':');if(covered.has(key))continue;covered.add(key);
  const sektionen=k.format==='elf'?k.bereiche.filter(s=>s.art==='sektion'&&(sourceVa!==null&&s.va!==null&&bereich(sourceVa,BigInt(s.va),BigInt(s.speicher_bytes),bytes)||off!==null&&s.datei_offset!==null&&bereich(off,BigInt(s.datei_offset),BigInt(s.datei_bytes),bytes))).map(s=>({index:s.index,name:s.name,kopf_offset:String(s.kopf_offset),kopf_bytes:s.kopf_bytes})):[];
  if(sektionen.length>maxTreffer)throw new HexFehler('budget_ueberschritten',{parameter:'max_fundstellen'});
  matches.push({bereich:{art:b.art,index:b.index,name:b.name,segment:b.segment??null,kopf_offset:String(b.kopf_offset),kopf_bytes:b.kopf_bytes},
   datei_offset:wert(off),rva:wert(outRva),va:wert(outVa),quell_va:wert(sourceVa),segment_offset:b.segment&&!(kodiert&&von==='datei_offset')?wert(BigInt(b.segment_offset??0)+delta):null,
   status,adress_bytes:bytes.toString(),sektionen});
  if(matches.length>maxTreffer)throw new HexFehler('budget_ueberschritten',{parameter:'max_fundstellen'});
 }
 const dateiSektionen=von==='datei_offset'?k.bereiche.filter(b=>b.art==='sektion'&&b.datei_offset!==null&&bereich(input,BigInt(b.datei_offset),BigInt(b.datei_bytes),bytes)).map(b=>({index:b.index,name:b.name,kopf_offset:String(b.kopf_offset),kopf_bytes:b.kopf_bytes})):[];
 if(dateiSektionen.length>maxTreffer)throw new HexFehler('budget_ueberschritten',{parameter:'max_fundstellen'});
 return {datei_sektionen:dateiSektionen,eingabe:{von,adresse:wert(input),adress_bytes:bytes.toString(),segment:seg?.toString()??null},basis:wert(actual),bevorzugte_basis:wert(original),
 basis_semantik:k.format==='elf'?'RVA relativ zur niedrigsten PT_LOAD-Adresse; ladebasis ersetzt diese Basis.':k.format==='ne'?'Segmentindex:Offset, keine flache VA.':k.format==='mz'?'DOS-Lademodul relativ; VA nur mit expliziter ladebasis.':'RVA relativ zur Imagebasis.',
 zuordnungen:matches,mehrdeutig:matches.length>1,status:matches.length?'zugeordnet':k.vollstaendig?'nicht_zugeordnet':'karte_unvollstaendig',vollstaendig:k.vollstaendig};
}
export async function ermittleHexAdresskarte(q:HexQuelle,stand:HexStand,signal:AbortSignal):Promise<{karte:ExeAdresskarte;budget:{gelesene_bytes:number};format_name:string}>{
 let read=0;
 const maxRead=Math.min(stand.werte.scan_bytes.wert,stand.werte.ram_bytes.wert),maxEntries=stand.werte.max_adress_eintraege.wert;
 const source:AssetSource={filePath:q.file_path,size:q.groesse,readRange:async(off,n)=>{
  if(!Number.isSafeInteger(off)||!Number.isSafeInteger(n)||off<0||n<0)throw new HexFehler('bereich_ausserhalb');
  if(signal.aborted)throw new AssetLimitError('timeoutMs','Hex-Laufzeitbudget');
  if(off>=q.groesse)return Buffer.alloc(0);
  const len=Math.min(n,q.groesse-off);if(read+len>maxRead)throw new AssetLimitError('maxReadBytes','Hex-Lesebudget');read+=len;
  return q.lesen(off,len,signal);
 }};
 const ctx:AssetContext={format:null,limits:{maxFileBytes:q.groesse,maxReadBytes:maxRead,maxObjects:maxEntries,timeoutMs:stand.werte.laufzeit_ms.wert,maxDepth:stand.werte.max_struktur_tiefe.wert,maxHashBytes:0},depth:0,signal,
 pruefeAbbruch(){if(signal.aborted)throw new AssetLimitError('timeoutMs','Hex-Laufzeitbudget');},warn(){},tiefer(){throw new HexFehler('exe_verschachtelung_nicht_verwendet');}};
 const head=await source.readRange(0,64);let karte:ExeAdresskarte,name:string;
 if(head.length>=6&&head.subarray(0,4).equals(Buffer.from([127,69,76,70]))){
  if(head.length<16)throw new HexFehler('exe_header_abgeschnitten');
  if(![1,2].includes(head[4])||![1,2].includes(head[5]))throw new HexFehler('exe_variante_nicht_unterstuetzt');
  karte=await leseElfAdresskarte(source,ctx);name='exe-elf'+(head[4]===2?'64':'32')+(head[5]===2?'be':'le');
 }else if(head.length>=28&&head.toString('latin1',0,2)==='MZ'){
  const newer=head.length>=64?head.readUInt32LE(60):0;
  let tag='mz';
  if(newer>=64&&newer<=q.groesse-2){const magic=await source.readRange(newer,4);tag=magic.length===4&&magic.equals(Buffer.from([80,69,0,0]))?'pe':['NE','LE','LX'].includes(magic.toString('latin1',0,2))?magic.toString('latin1',0,2).toLowerCase():'mz';}
  karte=tag==='pe'?await lesePeAdresskarte(source,ctx):await leseAltExeAdresskarte(source,ctx,tag as 'mz'|'ne'|'le'|'lx',newer);name='exe-'+tag;
 }else throw new HexFehler('exe_format_nicht_erkannt');
 if(signal.aborted)throw new HexFehler('zeitlimit');
 if(karte.bereiche.length>maxEntries*2||JSON.stringify(karte).length>stand.werte.ram_bytes.wert-read)throw new HexFehler('budget_ueberschritten',{parameter:'ram_bytes'});
 return {karte,budget:{gelesene_bytes:read},format_name:name};
}
async function reverseSymbole(q:HexQuelle,a:Record<string,unknown>,matches:Record<string,unknown>[],stand:HexStand):Promise<Record<string,unknown>>{
 if(q.ref.art!=='reverse_datei')return {status:'keine_reverse_originalquelle',symbole:[]};
 const addr=matches.map(m=>(m.quell_va as {dezimal:string}|null)?.dezimal).filter((s):s is string=>s!==undefined);
 if(!addr.length)return {status:'keine_virtuelle_adresse',symbole:[]};
 const off=hexAdresse(a.symbol_offset,'symbol_offset',0n),limit=hexAdresse(a.symbol_limit,'symbol_limit',BigInt(stand.werte.max_fundstellen.wert));
 if(off>2147483647n||limit<1n||limit>BigInt(stand.werte.max_fundstellen.wert))throw new HexFehler('budget_ueberschritten',{parameter:'symbol_limit'});
 const r=await getPool().query("SELECT s.id,s.name,s.symbol_type,s.adresse::text,s.groesse_bytes::text,s.file_path,s.line_start,s.line_end,s.schicht,s.fingerabdruck FROM reverse_code_symbole s JOIN reverse_dateien f ON f.id=s.datei_id AND f.eintrag_id=s.eintrag_id JOIN reverse_code_dateien d ON d.datei_id=s.datei_id AND d.eintrag_id=s.eintrag_id AND d.file_path=s.file_path AND d.schicht=s.schicht AND d.fingerabdruck=s.fingerabdruck JOIN reverse_schichten z ON z.datei_id=s.datei_id AND z.schicht=s.schicht AND z.fingerabdruck=s.fingerabdruck AND z.aktuell AND z.status IN ('fertig','teilweise') WHERE s.eintrag_id=$1 AND f.id=$2::bigint AND f.sha256=$3 AND s.schicht IN ('S1','S3') AND s.symbol_type IN ('function','method') AND EXISTS(SELECT 1 FROM unnest($4::numeric[]) a(v) WHERE s.adresse::numeric=a.v OR (s.groesse_bytes>0 AND s.adresse::numeric<=a.v AND a.v-s.adresse::numeric<s.groesse_bytes::numeric)) ORDER BY s.adresse,s.id LIMIT $5 OFFSET $6",[q.ref.reverse_id,q.ref.id,q.sha256,addr,Number(limit)+1,Number(off)]);
 const rows=r.rows.slice(0,Number(limit));
 return {status:rows.length?'vorhanden':'keine_passenden_aktuellen_symbole',symbole:rows,naechster_symbol_offset:r.rows.length>Number(limit)?String(off+limit):null,
 folgeaufruf:{tool:'reverse',action:'functions',reverse_id:q.ref.reverse_id,name:'0x'+BigInt(addr[0]).toString(16)}};
}
export async function fuehreHexAdressenAus(project:string,a:Record<string,unknown>,stand:HexStand):Promise<Record<string,unknown>>{
 if(!stand.adressen_schalter?.aktiv||stand.adressen_schalter.letzter_fehler)throw new HexFehler('hex_adressen_deaktiviert',{schalter:stand.adressen_schalter});
 const allowed=new Set(['action','project','agent_id','token','ref',...Object.keys(HEX_ADRESS_PARAMETER)]);
 if(Object.keys(a).some(k=>a[k]!==undefined&&!allowed.has(k)))throw new HexFehler('parameter_nicht_verwendet');
 hexAdresse(a.adresse);hexAdresse(a.adress_bytes,'adress_bytes',1n);
 if(!['datei_offset','rva','va','segment_offset'].includes(String(a.von)))throw new HexFehler('adressart_ungueltig');
 const so=hexAdresse(a.symbol_offset,'symbol_offset',0n),sl=hexAdresse(a.symbol_limit,'symbol_limit',BigInt(stand.werte.max_fundstellen.wert));
 if(so>2147483647n||sl<1n||sl>BigInt(stand.werte.max_fundstellen.wert))throw new HexFehler('budget_ueberschritten',{parameter:'symbol_limit'});
 return mitHexQuelle(project,a.ref,stand,async(q,signal)=>{
  let r:Awaited<ReturnType<typeof ermittleHexAdresskarte>>;
  try{r=await ermittleHexAdresskarte(q,stand,signal);}catch(e){if(e instanceof AssetLimitError)throw new HexFehler(e.grenze==='timeoutMs'?'zeitlimit':'budget_ueberschritten',{parameter:e.grenze});throw e;}
  const mapping=rechneHexAdresse(r.karte,q.groesse,a,stand.werte.max_fundstellen.wert),builtin=hexExeFormat(r.format_name);
  const antwort:Record<string,unknown>={success:true,action:'adressen',project,beantwortet_von:'hex',format:r.karte.format,ref:q.ref,file_path:q.file_path,revision:q.revision,sha256:q.sha256,groesse:q.groesse,bytebasis:q.bytebasis,...mapping,
   warnungen:r.karte.warnungen,budget:r.budget,schalter:stand.adressen_schalter,formate:builtin?{format_id:builtin.format_id,format_version:builtin.format_version,folgeaufruf:{action:'format_anwenden',ref:q.ref,format_id:builtin.format_id,format_version:builtin.format_version}}:null};
  if(r.karte.verzeichnisse){
   antwort.verzeichnisse=r.karte.verzeichnisse.filter(d=>d.bytes!=='0').map(d=>{
    const candidate=d.ist_dateioffset?{datei_offset:wert(BigInt(d.rva)),status:BigInt(d.rva)+BigInt(d.bytes)<=BigInt(q.groesse)?'datei':'ausserhalb_datei'}:rechneHexAdresse(r.karte,q.groesse,{von:'rva',adresse:d.rva,adress_bytes:d.bytes},stand.werte.max_fundstellen.wert);
    const name=({0:'exe-pe-export',1:'exe-pe-import',2:'exe-pe-resource',5:'exe-pe-reloc'} as Record<number,string>)[d.index],f=name?hexExeFormat(name):undefined;
    const zuordnungen=(candidate as Record<string,unknown>).zuordnungen as Array<{datei_offset:{dezimal:string}|null}>|undefined;
    const folgeaufrufe=f?(zuordnungen??[]).filter(z=>z.datei_offset).map(z=>({action:'format_anwenden',ref:q.ref,format_id:f.format_id,format_version:f.format_version,offset:z.datei_offset!.dezimal})):[];
    return {...d,abbildung:candidate,...(f?{format_id:f.format_id,format_version:f.format_version,folgeaufrufe}:{}),...(d.index===4?{semantik:'Security-Verzeichnis ist Dateioffset, keine RVA.'}:{})};
   });
  }
  antwort.reverse=await reverseSymbole(q,a,mapping.zuordnungen as Record<string,unknown>[],stand);
  if(JSON.stringify(antwort).length>stand.werte.antwort_zeichen.wert)throw new HexFehler('budget_ueberschritten',{parameter:'antwort_zeichen'});
  return antwort;
 });
}
