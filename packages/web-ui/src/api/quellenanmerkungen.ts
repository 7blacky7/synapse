import {apiFetch} from './auth';
export type AnmerkungArt='thought'|'memory'|'task'|'plan'|'artefakt'|'chat'|'nachricht';
export interface QuellenAnmerkung {id:string;art:AnmerkungArt;quelle_id:string;ausschnitt:string;position:{zeile_von:number;zeile_bis:number};anmerkung:string;status:'offen'|'eingearbeitet'|'abgelehnt';version_id:string;begruendung:string|null;bearbeitet_von:string|null}
export interface AnmerkungEntwurf {id:string;project:string;art:AnmerkungArt;quelle_id:string;hash:string;ausschnitt:string;start:number;ende:number;anmerkung:string}
export interface AnmerkungStand {success:true;schalter:{aktiv:boolean;quelle:string;bis:string|null;letzter_fehler:string|null};grenzen:{max_anzahl:number;anmerkung_max:number;ausschnitt_max:number};debug:Record<string,unknown>}
export interface AnmerkungQuellenStand extends AnmerkungStand {quelle:{project:string;art:AnmerkungArt;id:string;anzeige_id:string;titel:string;text:string;hash:string};eintraege:QuellenAnmerkung[];mehr:boolean;naechster_offset:number|null}
const basis='/api/agent-runtimes/anmerkungen';
async function anfrage<T>(pfad:string,body?:unknown,methode?:string):Promise<T>{
 const r=await apiFetch(basis+pfad,{method:methode??(body===undefined?'GET':'POST'),...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
 const d=await r.json().catch(()=>({}));if(!r.ok||!d.success)throw Error(d.error?.message??'Anmerkungen konnten nicht geladen werden.');return d as T;
}
export const leseAnmerkungStand=(project:string)=>anfrage<AnmerkungStand>('/'+encodeURIComponent(project)+'/stand');
export const schalteAnmerkungen=(project:string,aktiv:boolean)=>anfrage<AnmerkungStand>('/'+encodeURIComponent(project)+'/stand',{aktiv},'PUT');
export const leseAnmerkungQuelle=(project:string,art:AnmerkungArt,id:string,offset=0)=>anfrage<AnmerkungQuellenStand>('/'+encodeURIComponent(project)+'/quelle/'+art+'/'+encodeURIComponent(id)+'?offset='+offset);
export const leseAnmerkungVergleich=(project:string,id:string)=>anfrage<{versionen:Array<{id:string;stand:Record<string,unknown>;text:string}>;aktuelle_version:{id:string;text:string}|null}>('/'+encodeURIComponent(project)+'/eintrag/'+encodeURIComponent(id));
export const sendeAnmerkungKorb=(body:{project:string;vorgang:string;eintraege:AnmerkungEntwurf[];empfaenger?:string[];pin?:{project:string;art:AnmerkungArt;id:string}})=>anfrage<{success:true;debug:{anzahl:number};pin:{thought_id:string}|null}>('/sammelkorb',body);
