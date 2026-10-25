import { apiFetch } from './auth';
export interface NetzEreignis {
 id:string; zeit:string; project:string; agent:string; identity_id:string|null; lauf_id:string|null;
 tool:string; action:string; ok:boolean; empfaenger:string[]; channel:string|null;
 interaktion:'senden'|'lesen'|'aufruf'; quelle:'tool_calls'; routing:string;
 /** P22-T95: offener files-Plan aus Top-Level-Argument plan_id/schatten, sonst null. */
 plan_id?:string|null;
 /** P22-T97: Groesse des Ergebnisses in Bytes (ohne Inhalt). */
 ergebnis_bytes?:number;
 /** P22-T97: erfolgreicher Aufruf mit leerem Ergebnis (0 Treffer). */
 ergebnis_leer?:boolean;
 /** P22-T148: Artefakt bzw. Nachricht an den User, Urheber = agent/identity_id. */
 art?:'an_user'|'artefakt';
}
/** P22-T95: offener (oder gerade committeter) files-Plan als Schattenplan-Knoten; nur Metadaten. */
export interface NetzPlan { id:string; besitzer:string|null; besitzer_name:string|null; status:string; auto_commit?:boolean; coedit:boolean; erstellt:string; committed:string|null; ops:number; dateien:number; dateien_beispiele:string[]; beitraege:string[] }
export interface NetzAgent { id:string;agent:string;name:string;rolle:string;project:string;identity_id:string|null;zuletzt_aktiv:string|null;kanaele:string[];aufrufe_im_fenster?:number;letzter_aufruf?:{zeit:string;tool:string;action:string}|null;typ?:string|null;modell?:string|null;ort?:string|null;ort_quelle?:string|null;letzte_anmeldung?:string|null;metadaten_quelle?:string;koordination?:{koordinator_id:string;quelle:string;beleg_id:string}|null }
export interface NetzSnapshot {
 version:number;stand:string;project:string;schalter:{aktiv:boolean;quelle:string;bis:string|null;letzter_fehler:string|null};
 werte:Record<string,number>;einstellungen:Record<string,{wert:number;quelle:string;min:number;max:number;einheit?:string}>;
 agenten:NetzAgent[];ereignisse:NetzEreignis[];plaene?:NetzPlan[];plaene_ende?:Array<{id:string;status:string}>;channel_ereignisse?:NetzEreignis[];begrenzt:number;letzter_fehler:string|null;
 /** P22-T149: indexierte Dateien und Chunks des Projekts (PG), null wenn nicht lesbar. */
 index?:{dateien:number;chunks:number;stand:string}|null;
}
async function json<T>(path:string, init?:RequestInit):Promise<T> {
 const r=await apiFetch(path,init), d=await r.json();
 if(!r.ok||d.success===false) throw Error(typeof d.error==='string'?d.error:d.error?.message||'Netzwerk nicht erreichbar');
 return d;
}
const basis=(project:string)=>'/api/projects/'+encodeURIComponent(project);
export const ladeNetzwerk=(project:string)=>json<NetzSnapshot>(basis(project)+'/agentennetzwerk');
export const schalteNetzwerk=(project:string,aktiv:boolean)=>json(basis(project)+'/agent-profile/schalter',{
 method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({profil_funktion:'agentennetzwerk',ebene:'projekt',aktiv,grund:'Agentennetzwerk im Arbeitsraum umschalten'})});
export const stelleNetzwerkEin=(project:string,werte:Record<string,number>)=>json(basis(project)+'/agent-profile/agentennetzwerk',{
 method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({netzwerk_werte:werte,grund:'Darstellung des Agentennetzwerks im Arbeitsraum einstellen'})});
