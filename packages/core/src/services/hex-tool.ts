/**
 * P21-T3/H1: EINE Definition und EIN API-Core fuer REST und weitergeleitetes stdio.
 * Folgeaktionen benutzen hexGanzzahl/mitHexQuelle und leseHexEinstellungen, niemals eigene Bytepfade.
 */
import {randomUUID} from 'node:crypto';
import {getPool} from '../db/client.js';
import {pruefeUnbekannteParameter} from './unbekannte-parameter.js';
import {HEX_ADRESS_PARAMETER,fuehreHexAdressenAus} from './hex-adressen.js';
import {leseHexEinstellungen} from './hex-einstellungen.js';
import {HEX_FORMAT_ACTIONS,HEX_FORMAT_PARAMETER,fuehreHexFormateAus} from './hex-formate.js';
import {fuehreHexDeutenAus} from './hex-deuten.js';
import {HEX_ENTSCHLUESSEL_PARAMETER,fuehreHexEntschluesselnAus,hexEntschluesselStatus} from './hex-entschluesseln.js';
import {HexFehler,hexGanzzahl,hexAkteur,pruefeHexZugang,mitHexQuelle} from './hex-quellen.js';
import {sucheHex} from './hex-suchen.js';
import {vergleicheHex} from './hex-vergleichen.js';
import {zielinhaltHerkunft} from './zielinhalt.js';

export const HEX_ACTIONS=['adressen','entschluesseln',...HEX_FORMAT_ACTIONS,'deuten','status','hex','suchen','vergleichen'] as const;
const position={type:['number','string'],description:'Nichtnegative Byteposition, dezimal oder 0x-Hex; keine gerundeten Zahlen'};
export const HEX_DEFINITION={
 name:'hex',
 description:'Byte-Werkzeug fuer Agenten: hex zeigt Bereiche; suchen findet Hexmuster (??), ASCII/UTF-16-Strings oder Zahlen; vergleichen liefert offsetgleiche Unterschiede v1. Alle Ergebnisse sind budgetiert und paginierbar. Quellen projekt_asset|projekt_text|reverse_datei|reverse_asset nur ueber API. status zeigt Freigabe/Budgets und Verfahren. entschluesseln erzeugt eine Analyse-ref mit eigener Freigabe, Verfahren und explizitem Schluesselweg; fall-hex-entschluesseln. format_speichern/format_liste/format_anwenden verwalten versionierte kaitai-read-v1-Formate und selektive Strukturbaeume (fall-hex-formate). adressen rechnet Dateioffset/RVA/VA mit Sektion/Segment (fall-hex-adressen). Standard AUS.',
 inputSchema:{type:'object',properties:{
  ...HEX_ADRESS_PARAMETER,...HEX_FORMAT_PARAMETER,...HEX_ENTSCHLUESSEL_PARAMETER,
  action:{type:'string',enum:[...HEX_ACTIONS]},project:{type:'string'},agent_id:{type:'string'},
  ref:{type:'object',additionalProperties:false,properties:{
   art:{type:'string',enum:['projekt_asset','projekt_text','reverse_datei','reverse_asset','analyse']},
   id:{type:'string'},file_path:{type:'string'},reverse_id:{type:'string'},revision:{type:'string'},version_id:{type:'string'},sha256:{type:'string'},
  },required:['art']},
  ref_a:{type:'object',additionalProperties:false,properties:{art:{type:'string',enum:['projekt_asset','projekt_text','reverse_datei','reverse_asset','analyse']},id:{type:'string'},file_path:{type:'string'},reverse_id:{type:'string'},revision:{type:'string'},version_id:{type:'string'},sha256:{type:'string'}},required:['art']},
  ref_b:{type:'object',additionalProperties:false,properties:{art:{type:'string',enum:['projekt_asset','projekt_text','reverse_datei','reverse_asset','analyse']},id:{type:'string'},file_path:{type:'string'},reverse_id:{type:'string'},revision:{type:'string'},version_id:{type:'string'},sha256:{type:'string'}},required:['art']},
  muster:{type:'string',description:'Bytefolge (aa bb ??), String oder Zahlenwert passend zu art'},
  art:{type:'string',enum:['hex','ascii','utf8','utf16le','utf16be','zahl']},
  typ:{type:'string',enum:['u8','i8','u16','i16','u32','i32','u64','i64','f32','f64']},
  wert:{type:['number','string']},endianness:{type:'string',enum:['le','be']},ausrichtung:position,limit:position,
  offset:position,laenge:{...position,description:'Maximale Bytes dieser Seite, begrenzt durch PG-Budgets'},
  typen:{type:'array',description:'deuten: Typnamen oder {typ,name,offset,endianness,anzahl,schrittweite,felder,laenge,kodierung,nullterminiert}; Details fall-hex-deuten',items:{anyOf:[{type:'string'},{type:'object'}]}},
  feld_offset:position,feld_limit:position,
  pruefsummen:{type:'array',items:{type:'object',additionalProperties:false,properties:{algorithmus:{type:'string',enum:['crc32','adler32','md5','sha1','sha256']},offset:position,laenge:position},required:['algorithmus']}},
  cursor:{type:'string',description:'Revisions- und akteursgebundene Fortsetzung; nur fuer action hex'},
 },required:['action','project']},
} as const;
const ERLAUBT=new Set([...Object.keys(HEX_DEFINITION.inputSchema.properties),'token']);
export function hexZeilen(bytes:Uint8Array,start:number):Array<{offset:string;offset_hex:string;hex:string;ascii:string}>{
 const out:Array<{offset:string;offset_hex:string;hex:string;ascii:string}>=[];
 for(let i=0;i<bytes.length;i+=16){
  const b=bytes.subarray(i,i+16),off=start+i;
  out.push({offset:String(off),offset_hex:'0x'+off.toString(16),hex:Array.from(b,n=>n.toString(16).padStart(2,'0')).join(' '),
   ascii:Array.from(b,n=>n>=32&&n<=126?String.fromCharCode(n):'.').join('')});
 }
 return out;
}
/** apiAusfuehrung ist ein serverseitiger Vertrauenseingang, nie ein Tool-Parameter. */
export async function fuehreHexAus(args:Record<string,unknown>,opt:{apiAusfuehrung?:boolean}={}):Promise<Record<string,unknown>>{
 const started=Date.now(),action=args.action,project=typeof args.project==='string'?args.project:'';
 try{
  const p=pruefeUnbekannteParameter('hex',ERLAUBT,args);
  if(p)throw new HexFehler('unbekannte_parameter');
  if(!opt.apiAusfuehrung)throw new HexFehler('api_erforderlich');
  if(!project)throw new HexFehler('project_fehlt');
  if(!(HEX_ACTIONS as readonly unknown[]).includes(action))throw new HexFehler('unbekannte_action');
  await pruefeHexZugang(project);
  const stand=await leseHexEinstellungen(project);
  if(action!=='adressen'&&Object.keys(HEX_ADRESS_PARAMETER).some(k=>args[k]!==undefined))throw new HexFehler('parameter_nicht_verwendet');
  if(action!=='deuten'&&['typen','pruefsummen','feld_offset','feld_limit'].some(k=>args[k]!==undefined))throw new HexFehler('parameter_nicht_verwendet');
  if(action!=='entschluesseln'&&Object.keys(HEX_ENTSCHLUESSEL_PARAMETER).some(k=>args[k]!==undefined))throw new HexFehler('parameter_nicht_verwendet');
  const formatAction=(HEX_FORMAT_ACTIONS as readonly unknown[]).includes(action);
  if(!formatAction&&Object.keys(HEX_FORMAT_PARAMETER).some(k=>args[k]!==undefined))throw new HexFehler('parameter_nicht_verwendet');
  if(action==='status'){
   if(['ref','ref_a','ref_b','muster','art','typ','wert','endianness','ausrichtung','limit','offset','laenge','cursor'].some(k=>args[k]!==undefined))throw new HexFehler('parameter_nicht_verwendet');
   return {success:true,action,beantwortet_von:'hex',...stand,entschluesselung:hexEntschluesselStatus(),dauer_ms:Date.now()-started};
  }
  if(!stand.schalter.aktiv)throw new HexFehler('hex_deaktiviert',{schalter:stand.schalter});
  if(stand.letzter_fehler)throw new HexFehler(stand.letzter_fehler);
  if(action==='entschluesseln')return await fuehreHexEntschluesselnAus(args,project,stand);
  if(action==='adressen')return await fuehreHexAdressenAus(project,args,stand);
  if(formatAction)return await fuehreHexFormateAus(project,args,stand);
  if(action==='deuten')return await fuehreHexDeutenAus(args,project,stand);
  const akteur=hexAkteur(project);
  if(action==='suchen'){
   if(['ref_a','ref_b','laenge','cursor'].some(k=>args[k]!==undefined))throw new HexFehler('parameter_nicht_verwendet');
   return await mitHexQuelle(project,args.ref,stand,(q,signal)=>sucheHex(q,args,stand,signal));
  }
  if(action==='vergleichen'){
   if(['ref','muster','art','typ','wert','endianness','ausrichtung','laenge','cursor'].some(k=>args[k]!==undefined))throw new HexFehler('parameter_nicht_verwendet');
   return await mitHexQuelle(project,args.ref_a,stand,(a)=>mitHexQuelle(project,args.ref_b,stand,(b,signal)=>vergleicheHex(a,b,args,stand,signal)));
  }
  if(['ref_a','ref_b','muster','art','typ','wert','endianness','ausrichtung','limit'].some(k=>args[k]!==undefined))throw new HexFehler('parameter_nicht_verwendet');
  let ref=args.ref,offset=hexGanzzahl(args.offset,'offset',0),laenge=hexGanzzahl(args.laenge,'laenge',Math.min(stand.werte.hex_bytes.wert,stand.werte.max_hex_bytes.wert,stand.werte.ram_bytes.wert,stand.werte.scan_bytes.wert));
  if(args.cursor!==undefined){
   if(typeof args.cursor!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(args.cursor)||['ref','offset','laenge'].some(k=>args[k]!==undefined))throw new HexFehler('cursor_ungueltig');
   const r=await getPool().query("SELECT ref,position::text,laenge FROM hex_cursor WHERE id=$1::uuid AND project=$2 AND akteur=$3 AND action='hex' AND expires_at>NOW()",[args.cursor,project,akteur]);
   const row=r.rows[0];if(!row)throw new HexFehler('cursor_abgelaufen');
   ref=row.ref;offset=hexGanzzahl(row.position,'offset');laenge=Number(row.laenge);
  }
  const max=Math.min(stand.werte.max_hex_bytes.wert,stand.werte.ram_bytes.wert,stand.werte.scan_bytes.wert);
  if(laenge<1||laenge>max)throw new HexFehler('budget_ueberschritten',{parameter:'laenge',max_bytes:max});
  return await mitHexQuelle(project,ref,stand,async(q,signal)=>{
   if(offset>q.groesse)throw new HexFehler('bereich_ausserhalb',{groesse:q.groesse});
   const n=Math.min(laenge,q.groesse-offset),bytes=await q.lesen(offset,n,signal);
   if(signal.aborted)throw new HexFehler('zeitlimit');
   const zeilen=hexZeilen(bytes,offset),cursor=randomUUID();
   const reply:Record<string,unknown>={
    success:true,action,project,beantwortet_von:'hex',ref:q.ref,file_path:q.file_path,revision:q.revision,sha256:q.sha256,groesse:q.groesse,bytebasis:q.bytebasis,
    offset:String(offset),offset_hex:'0x'+offset.toString(16),laenge:bytes.length,zeilen,provenance:zielinhaltHerkunft(['zeilen[].hex','zeilen[].ascii']),
    eof:offset+bytes.length===q.groesse,vollstaendig:true,naechster_offset:null,cursor:null,
    budget:{max_bytes:max,max_zeichen:stand.werte.antwort_zeichen.wert,gelesene_bytes:bytes.length,ausgabe_bytes:bytes.length},
    schalter:stand.schalter,dauer_ms:Date.now()-started,
   };
   const refresh=()=>{
    const used=zeilen.reduce((sum,z)=>sum+z.ascii.length,0),next=offset+used,eof=next===q.groesse;
    reply.laenge=used;reply.eof=eof;reply.vollstaendig=used===n;
    reply.naechster_offset=eof?null:String(next);reply.cursor=eof?null:cursor;
    (reply.budget as Record<string,unknown>).ausgabe_bytes=used;
    return next;
   };
   let next=refresh();
   while(zeilen.length&&JSON.stringify(reply).length>stand.werte.antwort_zeichen.wert){zeilen.pop();next=refresh();}
   if(JSON.stringify(reply).length>stand.werte.antwort_zeichen.wert||(bytes.length>0&&!zeilen.length))throw new HexFehler('budget_ueberschritten',{parameter:'antwort_zeichen'});
   if(!reply.eof){
    const bis=new Date(Date.now()+stand.werte.cursor_minuten.wert*60000);
    await q.halten('hex-cursor:'+cursor,bis);
    try{
     await getPool().query("INSERT INTO hex_cursor(id,project,akteur,action,ref,position,laenge,expires_at) VALUES($1,$2,$3,'hex',$4::jsonb,$5,$6,$7)",[cursor,project,akteur,JSON.stringify(q.ref),next,laenge,bis]);
    }catch(e){await q.freigeben('hex-cursor:'+cursor);throw e;}
   }
   return reply;
  });
 }catch(e){
  const code=e instanceof HexFehler?e.code:'hex_fehler';
  return {success:false,action:typeof action==='string'?action:null,project,beantwortet_von:'hex',fehler:code,
   ...(e instanceof HexFehler?{details:e.details}:{}),
   hinweis:code==='hex_deaktiviert'?'hex status zeigt Produkt-Schalter und Quelle.':'Details: skills get_full fall-hex.',
   dauer_ms:Date.now()-started};
 }
}
