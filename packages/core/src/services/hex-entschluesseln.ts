/** P21-T15/H2b: explizite Verfahren + Schluesselherkunft; neue Analysequelle statt Originalmutation. */
import {HexFehler,hexGanzzahl,mitHexQuelle,pruefeHexZugang,type HexQuelle} from './hex-quellen.js';
import type {HexStand} from './hex-einstellungen.js';
import {hexAnalyseWurzeln,reserviereHexAnalyse,stageHexAnalyse,publiziereHexAnalyse,verwerfeHexAnalyse} from './hex-analysen.js';
import {starteHexKryptoWorker} from './hex-krypto-worker.js';
import {mitHexWorkJob,hexWorkStatus} from './hex-work-job.js';
type R=Record<string,unknown>;
const obj=(v:unknown):v is R=>!!v&&typeof v==='object'&&!Array.isArray(v);
export const HEX_VERFAHREN=[
 {name:'xor',version:'1',schluessel:true,parameter:'phase: Startindex im wiederholten Schluessel (Standard 0)',offset_abbildung:true},
 {name:'xor_rolling',version:'1',schluessel:true,parameter:'phase=0, schritt=1; P[i]=C[i] XOR ((K[(i+phase)%N]+i*schritt)%256), i beginnt am Bereichsanfang',offset_abbildung:true},
 {name:'aes_cbc',version:'1',schluessel:true,parameter:'16/24/32 Byte Key, iv: 16 Byte Hex; padding: none oder pkcs7 explizit',offset_abbildung:'nur padding none'},
 {name:'aes_ctr',version:'1',schluessel:true,parameter:'16/24/32 Byte Key; iv: 16 Byte Hex; Zaehler big endian gemaess OpenSSL AES-CTR',offset_abbildung:true},
 {name:'aes_gcm',version:'1',schluessel:true,parameter:'16/24/32 Byte Key; iv: 12 Byte Hex; tag: 16 Byte Hex; aad optional Hex. Ergebnis erst nach erfolgreicher Authentifizierung',offset_abbildung:true},
 {name:'zlib',version:'1',schluessel:false,parameter:'zlib-umhuelltes DEFLATE, keine Parameter',offset_abbildung:false},
 {name:'deflate',version:'1',schluessel:false,parameter:'rohes DEFLATE ohne zlib-Header, keine Parameter',offset_abbildung:false},
] as const;
export const HEX_ENTSCHLUESSEL_PARAMETER={
 verfahren:{type:'string',enum:HEX_VERFAHREN.map(v=>v.name)},
 parameter:{type:'object',description:'Explizite oeffentliche Verfahrensparameter; status nennt den Vertrag'},
 schluessel_ref:{type:'object',additionalProperties:false,properties:{ref:{type:'object'},offset:{type:['number','string']},laenge:{type:['number','string']},kodierung:{type:'string',enum:['raw','hex','base64']}},required:['ref','laenge','kodierung']},
 schluessel_inline:{type:'object',additionalProperties:false,properties:{kodierung:{type:'string',enum:['raw','hex','base64']},wert:{anyOf:[{type:'string'},{type:'array',items:{type:'integer',minimum:0,maximum:255}}]}},required:['kodierung','wert'],description:'Nur dieser Aufruf; niemals gespeichert. raw: UTF-8-String oder Bytearray, hex/base64: String'},
} as const;
export function hexEntschluesselStatus(){return {verfahren:HEX_VERFAHREN,worker:hexWorkStatus()};}
function dekodiere(v:unknown,kodierung:unknown,max:number):Buffer{
 let b:Buffer;
 if(kodierung==='raw'){
  if(typeof v==='string'){if(Buffer.byteLength(v,'utf8')>max)throw new HexFehler('schluessel_ungueltig');b=Buffer.from(v,'utf8');}
  else if(Array.isArray(v)&&v.length<=max&&v.every(n=>typeof n==='number'&&Number.isInteger(n)&&n>=0&&n<=255))b=Buffer.from(v);
  else throw new HexFehler('schluessel_ungueltig');
 }else{
  if(typeof v!=='string'||v.length>max*4)throw new HexFehler('schluessel_ungueltig');
  if(kodierung==='hex'){const s=v.replace(/[\t\r\n ]/g,'');if(!/^(?:[a-f0-9]{2})+$/i.test(s))throw new HexFehler('schluessel_ungueltig');b=Buffer.from(s,'hex');}
  else if(kodierung==='base64'){
   if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v))throw new HexFehler('schluessel_ungueltig');
   b=Buffer.from(v,'base64');if(b.toString('base64')!==v){b.fill(0);throw new HexFehler('schluessel_ungueltig');}
  }else throw new HexFehler('schluessel_ungueltig');
 }
 if(!b.length||b.length>max){b.fill(0);throw new HexFehler('schluessel_ungueltig');}return b;
}
function oeffentlicheParameter(v:unknown,verfahren:string,keyLen:number,stand:HexStand):R{
 const p=v===undefined?{}:v;if(!obj(p))throw new HexFehler('verfahren_parameter_ungueltig');
 if(JSON.stringify(p).length>stand.werte.krypto_parameter_bytes.wert)throw new HexFehler('budget_ueberschritten');
 const erlaubt=verfahren==='xor'?['phase']:verfahren==='xor_rolling'?['phase','schritt']:verfahren==='aes_cbc'?['iv','padding']:verfahren==='aes_ctr'?['iv']:verfahren==='aes_gcm'?['iv','tag','aad']:[];
 if(Object.keys(p).some(k=>!erlaubt.includes(k)))throw new HexFehler('verfahren_parameter_ungueltig');
 if(verfahren.startsWith('xor')){
  const phase=hexGanzzahl(p.phase,'phase',0),schritt=hexGanzzahl(p.schritt,'schritt',1);
  if(phase>=keyLen||schritt>255)throw new HexFehler('verfahren_parameter_ungueltig');
  return verfahren==='xor'?{phase}:{phase,schritt};
 }
 if(verfahren.startsWith('aes_')){
  if(![16,24,32].includes(keyLen))throw new HexFehler('schluessel_ungueltig');
  const h=(x:unknown,n?:number)=>typeof x==='string'&&/^(?:[a-f0-9]{2})*$/i.test(x)&&(n===undefined||x.length===n*2);
  if(!h(p.iv,verfahren==='aes_gcm'?12:16))throw new HexFehler('verfahren_parameter_ungueltig');
  if(verfahren==='aes_cbc'&&!['none','pkcs7'].includes(String(p.padding)))throw new HexFehler('verfahren_parameter_ungueltig');
  if(verfahren==='aes_gcm'&&(!h(p.tag,16)||(p.aad!==undefined&&!h(p.aad))))throw new HexFehler('verfahren_parameter_ungueltig');
  return Object.fromEntries(Object.entries(p).map(([k,x])=>[k,k==='padding'?x:String(x).toLowerCase()]));
 }
 return {};
}
export async function fuehreHexEntschluesselnAus(args:R,project:string,stand:HexStand):Promise<R>{
 const erlaubt=new Set(['action','project','agent_id','token','ref','offset','laenge',...Object.keys(HEX_ENTSCHLUESSEL_PARAMETER)]);
 if(Object.keys(args).some(k=>!erlaubt.has(k)))throw new HexFehler('parameter_nicht_verwendet');
 if(!stand.entschluesseln_schalter?.aktiv)throw new HexFehler('hex_entschluesseln_deaktiviert',{schalter:stand.entschluesseln_schalter});
 if(stand.entschluesseln_schalter.letzter_fehler)throw new HexFehler(stand.entschluesseln_schalter.letzter_fehler);
 const v=HEX_VERFAHREN.find(v=>v.name===args.verfahren);if(!v)throw new HexFehler('verfahren_unbekannt');
 const offset=hexGanzzahl(args.offset,'offset',0),laenge=hexGanzzahl(args.laenge,'laenge');
 if(laenge<1||laenge>Math.min(stand.werte.entschluesseln_bytes.wert,stand.werte.scan_bytes.wert))throw new HexFehler('budget_ueberschritten',{parameter:'laenge'});
 if(v.schluessel?(Number(args.schluessel_ref!==undefined)+Number(args.schluessel_inline!==undefined)!==1):(args.schluessel_ref!==undefined||args.schluessel_inline!==undefined))throw new HexFehler('schluessel_ungueltig');
 if(!hexWorkStatus().bereit)throw new HexFehler('kein_hex_ausfuehrer');
 return mitHexQuelle(project,args.ref,stand,async(q,signal)=>{
  if(offset>q.groesse||laenge>q.groesse-offset)throw new HexFehler('bereich_ausserhalb');
  const starten=async(key:Buffer|undefined,keyQuelle:HexQuelle|undefined,keyHerkunft:R):Promise<R>=>{
   let bytes:Buffer|undefined,out:Buffer|undefined,id:string|undefined,publiziert=false;
   try{
    const parameter=oeffentlicheParameter(args.parameter,v.name,key?.length??0,stand);
    if(v.name==='aes_cbc'&&laenge%16!==0)throw new HexFehler('verfahren_parameter_ungueltig');
    const maxOutput=Math.min(stand.werte.analyse_bytes.wert,v.name==='zlib'||v.name==='deflate'?stand.werte.analyse_bytes.wert:laenge);
    const ram=4*laenge+4*maxOutput+4*(key?.length??0)+stand.werte.hex_worker_heap_bytes.wert;
    if(ram>stand.werte.ram_bytes.wert||maxOutput<1)throw new HexFehler('budget_ueberschritten',{parameter:'ram_bytes'});
    if(signal.aborted)throw new HexFehler('zeitlimit');
    const basis=hexAnalyseWurzeln(keyQuelle?[q,keyQuelle]:[q],stand);
    const linear=v.name!=='zlib'&&v.name!=='deflate'&&(v.name!=='aes_cbc'||parameter.padding==='none');
    const herkunft:R={ursprung:q.ref,ursprung_sha256:q.sha256,offset:String(offset),laenge:String(laenge),verfahren:v.name,verfahrensversion:v.version,parameter,schluessel_herkunft:keyHerkunft,
     offset_abbildung:linear?{verfuegbar:true,art:'linear',quell_offset:String(offset)}:{verfuegbar:false}};
    id=await reserviereHexAnalyse(project,herkunft,basis,stand,maxOutput);
    const bis=new Date(Date.now()+stand.werte.analyse_minuten.wert*60000);
    await q.halten('hex-analyse:'+id+':quelle',bis);await keyQuelle?.halten('hex-analyse:'+id+':schluessel',bis);
    bytes=await q.lesen(offset,laenge,signal);
    const job=await mitHexWorkJob(project,id,q.sha256,stand,signal,
     ()=>starteHexKryptoWorker({verfahren:v.name,bytes:bytes!,schluessel:key,parameter,maxOutput},{ramBytes:stand.werte.hex_worker_heap_bytes.wert,laufzeitMs:stand.werte.laufzeit_ms.wert,signal}),
     async b=>{await pruefeHexZugang(project);await q.pruefen();await keyQuelle?.pruefen();if(signal.aborted)throw new HexFehler('zeitlimit');return stageHexAnalyse(project,id!,b,maxOutput);},
     b=>b.fill(0));
    out=job.wert;
    await pruefeHexZugang(project);await q.pruefen();await keyQuelle?.pruefen();if(signal.aborted)throw new HexFehler('zeitlimit');
    const vorRef={art:'analyse',id,sha256:'0'.repeat(64),revision:'0'.repeat(64)};
    const reply:R={success:true,action:'entschluesseln',project,beantwortet_von:'hex',ref:vorRef,sha256:vorRef.sha256,groesse:out.length,herkunft,work_job_id:job.job_id,schalter:stand.entschluesseln_schalter,
     budget:{eingabe_bytes:laenge,ausgabe_bytes:out.length,max_ausgabe_bytes:maxOutput,ram_reserviert:ram}};
    if(JSON.stringify(reply).length>stand.werte.antwort_zeichen.wert)throw new HexFehler('budget_ueberschritten',{parameter:'antwort_zeichen'});
    const ref=await publiziereHexAnalyse(project,id,job.job_id);publiziert=true;reply.ref=ref;reply.sha256=ref.sha256;return reply;
   }catch(e){if(id)await verwerfeHexAnalyse(project,id).catch(()=>{});if(e instanceof HexFehler)throw e;
    const code=e instanceof Error&&['zeitlimit','budget_ueberschritten'].includes(e.message)?e.message:'entschluesselung_fehlgeschlagen';throw new HexFehler(code);
   }finally{
    bytes?.fill(0);out?.fill(0);key?.fill(0);
    if(id&&!publiziert)await Promise.allSettled([q.freigeben('hex-analyse:'+id+':quelle'),...(keyQuelle?[keyQuelle.freigeben('hex-analyse:'+id+':schluessel')]:[])]);
   }
  };
  if(!v.schluessel)return starten(undefined,undefined,{art:'kein'});
  if(args.schluessel_inline!==undefined){
   const s=args.schluessel_inline;
   if(!obj(s)||Object.keys(s).some(k=>!['wert','kodierung'].includes(k)))throw new HexFehler('schluessel_ungueltig');
   return starten(dekodiere(s.wert,s.kodierung,stand.werte.schluessel_bytes.wert),undefined,{art:'inline'});
  }
  const s=args.schluessel_ref;if(!obj(s)||Object.keys(s).some(k=>!['ref','offset','laenge','kodierung'].includes(k))||!['raw','hex','base64'].includes(String(s.kodierung)))throw new HexFehler('schluessel_ungueltig');
  const start=hexGanzzahl(s.offset,'schluessel_offset',0),n=hexGanzzahl(s.laenge,'schluessel_laenge');
  if(n<1||n>stand.werte.schluessel_bytes.wert*(s.kodierung==='raw'?1:4)||n+laenge>stand.werte.scan_bytes.wert)throw new HexFehler('budget_ueberschritten',{parameter:'schluessel_laenge'});
  return mitHexQuelle(project,s.ref,stand,async(kq,keySignal)=>{
   if(start>kq.groesse||n>kq.groesse-start)throw new HexFehler('bereich_ausserhalb');
   const kb=await kq.lesen(start,n,keySignal);let key:Buffer|undefined;
   try{
    key=s.kodierung==='raw'?Buffer.from(kb):dekodiere(new TextDecoder('utf-8',{fatal:true}).decode(kb),s.kodierung,stand.werte.schluessel_bytes.wert);
    return await starten(key,kq,{art:'ref',ref:kq.ref,offset:String(start),laenge:String(n),kodierung:s.kodierung});
   }finally{kb.fill(0);key?.fill(0);}
  });
 });
}
