/** P18-T102: ein gemeinsamer Runtime-API-Vertrag, keine Transportkopien. */
import type {Pool} from 'pg';
import {aktuellerAgentAufruf} from './agent-bezug.js';
import {aktuellerW1bAkteur,pruefeProfilVerwalter} from './agent-profil-verwalter.js';
import {leseReverseEinstellwerte,reverseZahl} from './reverse-einstellwerte.js';
import {leseLeserRuntimeVerwaltung,leseLeserRuntime,leseLeserRuntimeStandard,pruefeLeserRuntimeSnapshot,
 stelleLeserRuntimeBereit,setzeLeserRuntimeStandard,type RuntimeSchreibauftrag} from './reverse-leser-runtime.js';
import {runtimeFail,pruefeLeserRuntimeImage,pruefeLeserRuntimePin,type LeserRuntimeImage} from './reverse-leser-runtime-vertrag.js';
export const LESER_RUNTIME_ACTIONS=['leser_runtime_liste','leser_runtime_get','leser_runtime_bereitstellen','leser_runtime_aktivieren','leser_runtime_deaktivieren'] as const;
export const LESER_RUNTIME_PARAMETER={
 runtime_quelle:{type:'object',description:'Exakt {project:"synapse",stand:"nachher",dateien:[{pfad,version_id,sha256,bytes}]}; V1 exakt checkpoint.py/leser.py/runner.py aus docker/synapse-reverse. version_id ist der Aenderungsanker; SHA256/UTF8-Bytezahl pinnen dessen Nachher-Stand.'},
 runtime_pin:{type:'string',description:'Exakter SHA-256 des kanonischen Runtime-Inhaltsindex'},
 runtime_basis_revision:{type:'string',description:'CAS-Revision des Image-Standards aus leser_runtime_get, anfangs "0"'},
 runtime_cursor:{type:'string',description:'Keyset-Cursor aus leser_runtime_liste'},
 runtime_schluessel:{type:'string',description:'Idempotenzschlüssel je Verwaltungsaktion und Akteur'},
 grund:{type:'string',description:'Nachvollziehbarer Grund der globalen Runtime-Verwaltung'},
} as const;
export const LESER_RUNTIME_FELDER={
 leser_runtime_liste:['limit','runtime_cursor'],leser_runtime_get:['runtime_pin'],
 leser_runtime_bereitstellen:['runtime_quelle','runtime_schluessel','grund','vorschau'],
 leser_runtime_aktivieren:['runtime_pin','runtime_basis_revision','runtime_schluessel','grund'],
 leser_runtime_deaktivieren:['runtime_basis_revision','runtime_schluessel','grund'],
} as const;
type Row=Record<string,unknown>;
function text(v:unknown,max:number):string{
 if(typeof v!=='string'||!v||v.length>max||/[\x00-\x1f\x7f]/.test(v))runtimeFail('leser_runtime_parameter_ungueltig');return v;
}
/** Globale Betriebsquelle: User oder bestaetigter Synapse-Koordinator, kein behauptetes Rollenfeld. */
async function verwalter(pool:Pool,a:Row){
 if(a.project!=='synapse'||aktuellerAgentAufruf()?.fremdprojekt)runtimeFail('keine_berechtigung');
 const w=aktuellerW1bAkteur(),p=aktuellerAgentAufruf()?.principal;
 if(!w&&p?.art!=='legacy')runtimeFail('keine_berechtigung');
 try{return await pruefeProfilVerwalter(w??{art:'legacy_koordinator',agent_id:p?.art==='legacy'?p.agent_id:''},'synapse',{db:pool});}
 catch{return runtimeFail('keine_berechtigung');}
}
export async function fuehreLeserRuntimeAus(pool:Pool,a:Row,image?:LeserRuntimeImage):Promise<Record<string,unknown>>{
 const s=await leseReverseEinstellwerte({project:String(a.project)},pool);
 if(s.letzter_fehler)runtimeFail(s.letzter_fehler);
 const max=reverseZahl(s,'parameter_text_zeichen'),schalter=await leseLeserRuntimeVerwaltung(pool);
 const base={werkzeug:'reverse-leser-runtime',schalter,einstellungen_revision:s.revision,keine_neuen_auftraege:true};
 const result=(v:Record<string,unknown>)=>{
  const r={...base,...v};if(Buffer.byteLength(JSON.stringify(r))>reverseZahl(s,'antwort_bytes'))runtimeFail('leser_runtime_antwort_zu_gross');return r;
 };
 if(a.action==='leser_runtime_liste'){
  const n=a.limit??reverseZahl(s,'seiten_limit');
  if(typeof n!=='number'||!Number.isSafeInteger(n)||n<1||n>reverseZahl(s,'max_limit'))runtimeFail('leser_runtime_limit_ungueltig');
  const nach=a.runtime_cursor===undefined?null:pruefeLeserRuntimePin(a.runtime_cursor);
  const rows=(await pool.query('SELECT pin,vertrag,bytes::text,erstellt_von,erstellt_at FROM reverse_leser_runtimes WHERE ($1::text IS NULL OR pin>$1) ORDER BY pin LIMIT $2',[nach,n+1])).rows;
  return result({status:'fertig',runtimes:rows.slice(0,n),naechster_cursor:rows.length>n?rows[n-1].pin:null});
 }
 if(a.action==='leser_runtime_get'){
  const standard=image?await leseLeserRuntimeStandard(pool,image):null;
  const pin=a.runtime_pin===undefined?standard?.runtime_sha256:pruefeLeserRuntimePin(a.runtime_pin);
  if(!pin)return result({status:'kein_pin',standard,image_fehlt:!image});
  const r=await leseLeserRuntime(pool,pin);if(!r)runtimeFail('leser_runtime_pin_unbekannt');
  const images=(await pool.query('SELECT image_digest,image,erstellt_von,erstellt_at FROM reverse_leser_runtime_images WHERE pin=$1 ORDER BY image_digest LIMIT $2',[pin,reverseZahl(s,'max_limit')+1])).rows;
  let share:Record<string,unknown>={status:'image_fehlt'};
  if(image)try{
   await pruefeLeserRuntimeSnapshot(pool,{runtime_sha256:pin,runtime_image_digest:image.digest},s,undefined,image.digest);share={status:'verifiziert'};
  }catch(e){share={status:'fehler',fehlercode:/^(leser_|reverse_)[a-zA-Z0-9_]+$/.test((e as Error).message)?(e as Error).message:'leser_runtime_share_nicht_lesbar'};}
  return result({status:'fertig',runtime:r,standard,share,images:images.slice(0,reverseZahl(s,'max_limit')),images_gekappt:images.length>reverseZahl(s,'max_limit')});
 }
 const wer=await verwalter(pool,a),i=pruefeLeserRuntimeImage(image),grund=text(a.grund,max),schluessel=text(a.runtime_schluessel,max);
 if(grund.trim().length<5)runtimeFail('leser_runtime_grund_fehlt');
 const o:RuntimeSchreibauftrag={akteur:wer.wer,grund,schluessel,image:i,pruefeRecht:async()=>{await verwalter(pool,a);}};
 if(a.action==='leser_runtime_bereitstellen'){
  if(a.vorschau!==undefined&&typeof a.vorschau!=='boolean')runtimeFail('leser_runtime_parameter_ungueltig');
  return result(await stelleLeserRuntimeBereit(pool,a.runtime_quelle,o,a.vorschau!==false));
 }
 if(a.action!=='leser_runtime_aktivieren'&&a.action!=='leser_runtime_deaktivieren')runtimeFail('leser_runtime_action_ungueltig');
 const revision=text(a.runtime_basis_revision,max);
 return result(await setzeLeserRuntimeStandard(pool,a.action==='leser_runtime_aktivieren'?pruefeLeserRuntimePin(a.runtime_pin):null,revision,o));
}
