/** RV16 Ansicht-Ausgabe: A14-Renderer, A15-Links, A16-Bildblöcke. Kein eigener Renderer. */
import type {Pool} from 'pg';
import {getAssetKonfiguration} from '../config/asset-konfig.js';
import {gemeinsamerAnsichtDienst,standardAnsichtLinkDienst,type AnsichtLinkErzeugung,type AnsichtLinkEingang} from './asset-ansicht-link.js';
import type {AssetAnsichtErgebnis,AssetAnsichtReferenz} from './asset-ansicht.js';
import {holeReverseAnsichtDatei} from './reverse-ansicht-adapter.js';
import {pruefeReverseAnsichtBindung} from './reverse-ansicht-retention.js';
import {pruefeAnsichtParameter,setzeMcpBilder,ansichtUmwandlungsVermerk,ansichtNichtDekodierbarVermerk,ANSICHT_NICHT_DEKODIERBAR,type McpBild} from './asset-ansicht-ausgabe.js';
type Row=Record<string,unknown>;
const HINWEIS='Alternative: Hex-/Struktur-Ansicht (RV27), sobald verfügbar.';
interface Dienste {
 ansicht:{ansichten(refs:readonly AssetAnsichtReferenz[]):Promise<AssetAnsichtErgebnis[]>};
 link:{erzeugen(e:AnsichtLinkEingang):Promise<AnsichtLinkErzeugung>};
}
let ersatz:Partial<Dienste>={};
/** Tests ersetzen nur die API-Dienste, nie einen lokalen Bytesweg. */
export function setzeReverseAnsichtDienste(d:Partial<Dienste>):()=>void{
 const vorher=ersatz;ersatz={...ersatz,...d};return()=>{ersatz=vorher;};
}
export async function fuehreReverseAnsichtAus(a:Row,pool:Pool):Promise<Row>{
 try {
 const f=pruefeAnsichtParameter(a);
 if(f)return {fehlercode:'ansicht_nicht_darstellbar',fehler:f.fehlercode,message:f.message,hinweis:HINWEIS};
 if(a.ansicht===undefined||a.ansicht===null)return {fehlercode:'ansicht_nicht_darstellbar',fehler:'ansicht_fehlt',hinweis:'ansicht inline, link oder beides angeben.'};
 const rid=String(a.reverse_id),project=String(a.project),pfad=String(a.datei??a.file_path);
 const row=await holeReverseAnsichtDatei(pool,rid,pfad);
 if(!row)return {fehlercode:'nicht_gefunden'};
 const ref:AssetAnsichtReferenz={bereich:'reverse',ziel_ref:rid,id:row.id,revision:row.sha256,sha256:row.sha256};
 if(await pruefeReverseAnsichtBindung(pool,{projekt:project,eintrag_id:rid,sha256:row.sha256})!=='ok')return {fehlercode:'nicht_gebunden'};
 const modus=a.ansicht;
 const result:Row={modus},bilder:McpBild[]=[];
 const quellFormat=String(row.format&&row.format!=='unbekannt'?row.format:row.pfad.split('.').pop()??'').toLowerCase();
 let gelungen=false;
 if(modus==='inline'||modus==='beides'){
   const [r]=await (ersatz.ansicht??gemeinsamerAnsichtDienst()).ansichten([ref]);
   if(r?.success){
     if(r.quelle.bereich!=='reverse'||r.quelle.ziel_ref!==rid||r.quelle.id!==row.id||r.quelle.revision!==row.sha256||r.quelle.sha256!==row.sha256)return {fehlercode:'ansicht_nicht_darstellbar',fehler:'ansicht_revision_falsch',hinweis:HINWEIS};
     bilder.push({type:'image',mimeType:r.mimeType,data:r.png.toString('base64')});
     result.inline={success:true,mimeType:r.mimeType,breite:r.breite,hoehe:r.hoehe,bytes:r.png.length,revision:row.sha256,sha256:row.sha256,cache_treffer:r.cacheTreffer,hinweis:'Bild folgt als image-Block.',...ansichtUmwandlungsVermerk(quellFormat,r.mimeType)};
     gelungen=true;
   }else{
     const code=r?.fehlercode??'ansicht_nicht_darstellbar';
     result.inline={success:false,fehlercode:code,grund:r?.grund??'Keine Ansicht verfügbar.',hinweis:HINWEIS,
       ...((ANSICHT_NICHT_DEKODIERBAR as readonly string[]).includes(code)?ansichtNichtDekodierbarVermerk(quellFormat):{})};
   }
 }
 if(modus==='link'||modus==='beides'){
   const format=quellFormat;
   const art=String(row.mime??'').startsWith('audio/')||!getAssetKonfiguration().vorschau.formate.includes(format)?'original':'ansicht';
   const l=await (ersatz.link??standardAnsichtLinkDienst()).erzeugen({...ref,art,offen_sekunden:a.offen_sekunden,einmalig:a.einmalig,agent_id:String(a.agent_id),projekt:project});
   result.link=l.success?l:{success:false,fehlercode:l.fehlercode,grund:l.grund,hinweis:HINWEIS};
   gelungen=gelungen||l.success;
 }
 // Bindung und Hash nach Render/Token-Erzeugung erneut prüfen; kein Bild nach einer inzwischen gelösten Bindung.
 if(await pruefeReverseAnsichtBindung(pool,{projekt:project,eintrag_id:rid,sha256:row.sha256})!=='ok')return {fehlercode:'nicht_gebunden'};
 return setzeMcpBilder({datei:row.pfad,format:quellFormat||'unbekannt',arch:row.arch??'unbekannt',bits:row.bits??null,status:gelungen?'fertig':'fehler',ansicht:result,
   ...(gelungen?{}:{fehlercode:'ansicht_nicht_darstellbar',hinweis:HINWEIS})},bilder);
 }catch(e){
   const code=(e as {code?:unknown})?.code;
   return {fehlercode:'ansicht_nicht_darstellbar',fehler:typeof code==='string'?code:'ansicht_fehler',hinweis:HINWEIS};
 }
}
