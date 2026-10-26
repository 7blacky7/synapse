/**
 * P22-T195 / Entwurf ac4d8052, User-Ergaenzung b48ad571.
 * PG ist die Wahrheit: Ausschnitt + unveraenderliche Quellversion, Status nur mit Beleg/Grund.
 * Keine Quelle wird hier umgeschrieben. Historisierung aller annotierten Schreibwege: Schema166-Trigger.
 */
import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { internToolAktiv } from './intern-tool-aktiv.js';
import { leseRuntimeUeberwachungEinstellungen } from './runtime-ueberwachung.js';
import { leseChatZitateEinstellungen } from './chat-zitate.js';
import { aktuellerAgentPrincipal } from './agent-bezug.js';

export const ANMERKUNG_ARTEN = ['thought','memory','task','plan','artefakt','chat','nachricht'] as const;
export type AnmerkungArt = typeof ANMERKUNG_ARTEN[number];
type DB = Pick<PoolClient,'query'>;
type R = Record<string,unknown>;
export class AnmerkungFehler extends Error {
 constructor(public code:string, message:string, public status=400){super(message);}
}
const fehler=(code:string,message:string,status=400):never=>{throw new AnmerkungFehler(code,message,status);};
export function anmerkungArt(v:unknown):AnmerkungArt {
 if(typeof v!=='string'||!(ANMERKUNG_ARTEN as readonly string[]).includes(v))return fehler('quelle_art','Diese Quellenart kann nicht kommentiert werden.');
 return v as AnmerkungArt;
}
export async function leseAnmerkungenStand(project:string){
 const p=await leseProfilProduktSchalter('zeilen_anmerkungen',project);
 let schalter={aktiv:p.aktiv&&!p.letzter_fehler,quelle:p.quelle as string,bis:null as string|null,letzter_fehler:p.letzter_fehler,standard:false};
 if(internToolAktiv())try{
  const r=await getPool().query<{aktiv:boolean;bis:Date}>("SELECT aktiv,bis FROM intern_schalter WHERE name='zeilen_anmerkungen' AND modus='freigegeben' AND bis IS NOT NULL AND bis>NOW()");
  if(r.rows[0]&&!p.letzter_fehler)schalter={...schalter,aktiv:r.rows[0].aktiv,quelle:'intern',bis:r.rows[0].bis.toISOString()};
 }catch{schalter={...schalter,letzter_fehler:'intern_nicht_lesbar'};}
 const [e,z]=await Promise.all([leseRuntimeUeberwachungEinstellungen(),leseChatZitateEinstellungen()]);
 return {success:true,schalter,grenzen:z.werte,einstellungen:{seite:e.anmerkungen_seite,snapshot_bytes:e.anmerkungen_snapshot_bytes},debug:{speicher:'postgresql',vorversion:'schema166-trigger',letzter_fehler:schalter.letzter_fehler??z.letzter_fehler}};
}
async function freigabe(project:string){const s=await leseAnmerkungenStand(project);if(!s.schalter.aktiv)fehler('funktion_aus','Zeilen-Anmerkungen sind ausgeschaltet.',409);return s;}
const statusText:Record<string,string>={todo:'Offen',in_progress:'In Arbeit',done:'Erledigt',blocked:'Blockiert'};
export function anmerkungQuelltext(art:AnmerkungArt,s:R):string {
 if(art==='task')return String(s.description??'');
 if(art==='plan'){
  const t:string[]=[];if(s.description)t.push(String(s.description));
  if(Array.isArray(s.goals)&&s.goals.length)t.push('Ziele\n'+s.goals.map(x=>'- '+x).join('\n'));
  if(s.architecture)t.push('Architektur\n'+s.architecture);
  if(Array.isArray(s.tasks)&&s.tasks.length)t.push('Tasks\n'+(s.tasks as R[]).map(x=>'- '+String(x.kurz_id??'')+' ['+(statusText[String(x.status)]??x.status)+'] '+x.title).join('\n'));
  return t.join('\n\n');
 }
 if(art==='artefakt')return String(s.vorlage??s.text_inhalt??s.html??'');
 return String(s.content??'');
}
export interface AnmerkungQuelle {project:string;art:AnmerkungArt;id:string;anzeige_id:string;titel:string;text:string;hash:string;stand:R}
/** SQL nur ueber feste Tabellen/Spalten. lock=true sperrt die physische Quellzeile bis Anmerkung/Snapshot gespeichert sind. */
export async function ladeAnmerkungQuelle(project:string,artRoh:unknown,refRoh:unknown,db:DB=getPool(),lock=false,user=false):Promise<AnmerkungQuelle>{
 const art=anmerkungArt(artRoh),ref=typeof refRoh==='string'?refRoh.trim():'';
 if(!project||!ref)return fehler('quelle_fehlt','Projekt und Quelle angeben.');
 let stand:R|undefined;
 if(art==='artefakt'){
  const {loeseArtefaktName,darfArtefaktLesen}=await import('./artefakt-katalog.js'),p=aktuellerAgentPrincipal();
  const b:import('./artefakt-katalog.js').ArtefaktDateiZugang=user?{art:'user'}:{art:'agent',project,identity_id:p?.art==='identity'?p.identity_id:null,agent_id:p?.agent_id??null,main:p?.art==='identity'&&p.rolle==='main'};
  const z=await loeseArtefaktName(ref,b);
  const r=await db.query<{stand:R;identity_project:string|null}>("SELECT to_jsonb(q) stand,i.project identity_project FROM agent_artifacts q LEFT JOIN agent_identitaeten i ON i.id=q.created_by_identity_id WHERE q.id::text=$1"+(lock?' FOR UPDATE OF q':''),[z.artefakt_id]);
  const row=r.rows[0];if(row){
   const s=row.stand,aktuell={...z,project:typeof s.standard_project==='string'?s.standard_project:row.identity_project,
    bereich:(s.bereich??(s.vorlage!==null?'global':'projekt')) as 'global'|'projekt',
    created_by_identity_id:s.created_by_identity_id as string|null,session_id:s.session_id as string|null,
    ablauf_am:s.ablauf_am?new Date(String(s.ablauf_am)):null};
   if(darfArtefaktLesen(aktuell,b))stand=s;
  }
 }else if(art==='task'||art==='plan'){
  const r=await db.query<{stand:R}>('SELECT to_jsonb(q) stand FROM plans q WHERE project=$1'+(lock?' FOR UPDATE':''),[project]);
  if(art==='plan')stand=r.rows.map(x=>x.stand).find(x=>x.id===ref||String(x.kurz_id??'').toLowerCase()===ref.toLowerCase());
  else stand=r.rows.flatMap(x=>Array.isArray(x.stand.tasks)?x.stand.tasks as R[]:[]).find(x=>x.id===ref||String(x.kurz_id??'').toLowerCase()===ref.toLowerCase());
 }else if(art==='nachricht'){
  const r=await db.query<{stand:R}>(`SELECT to_jsonb(q) stand FROM specialist_channel_messages q JOIN specialist_channels c ON c.id=q.channel_id WHERE c.project=$1 AND q.id::text=$2`+(lock?' FOR UPDATE OF q':''),[project,ref]);stand=r.rows[0]?.stand;
 }else{
  const table={thought:'thoughts',memory:'memories',chat:'chat_messages'}[art];
  const p='q.project=$1';
  const key=art==='memory'?'(q.id::text=$2 OR q.name=$2)':'q.id::text=$2';
  const r=await db.query<{stand:R}>(`SELECT to_jsonb(q) stand FROM ${table} q WHERE ${p} AND ${key}`+(lock?' FOR UPDATE OF q':''),[project,ref]);stand=r.rows[0]?.stand;
 }
 if(!stand)return fehler('quelle_unbekannt','Quelle in diesem Projekt nicht gefunden.',404);
 const hash=(await db.query<{hash:string}>('SELECT quellenanmerkung_hash($1::jsonb) hash',[JSON.stringify(stand)])).rows[0].hash;
 return {project,art,id:String(stand.id),anzeige_id:String(stand.kurz_id??(art==='memory'?stand.name:stand.id)),titel:String(stand.title??stand.name??String(stand.content??'').slice(0,70)),text:anmerkungQuelltext(art,stand),hash,stand};
}
export interface AnmerkungEntwurf {id:string;project:string;art:AnmerkungArt;quelle_id:string;hash:string;ausschnitt:string;start:number;ende:number;anmerkung:string}
export async function speichereQuellenanmerkungen(db:DB,vorgang:string,eintraege:AnmerkungEntwurf[],nutzer:string){
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(vorgang)||!nutzer)return fehler('vorgang_ungueltig','Vorgang oder Nutzer fehlt.');
 if(!Array.isArray(eintraege)||!eintraege.length)return fehler('korb_leer','Der Sammelkorb ist leer.');
 const ids=new Set<string>(),aus:R[]=[];
 for(const e of eintraege){
  if(!e||typeof e!=='object'||typeof e.project!=='string'||!e.project.trim())return fehler('eintrag_ungueltig','Ungültiger Korbeintrag.');
  const s=await freigabe(e.project);
  if(eintraege.length>s.grenzen.max_anzahl)return fehler('korb_voll','Zu viele Anmerkungen im Korb.');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(e.id)||ids.has(e.id))return fehler('id_ungueltig','Ungültige oder doppelte Anmerkungs-ID.');
  ids.add(e.id);
  if(typeof e.anmerkung!=='string'||!e.anmerkung.trim()||e.anmerkung.length>s.grenzen.anmerkung_max)return fehler('anmerkung_ungueltig','Anmerkung fehlt oder ist zu lang.');
  const vorhanden=(await db.query<R>('SELECT * FROM quellenanmerkungen WHERE id=$1',[e.id])).rows[0];
  if(vorhanden){
   const q=await ladeAnmerkungQuelle(e.project,e.art,e.quelle_id,db,false,true);
   if(vorhanden.art!==e.art||vorhanden.quelle_id!==q.id||vorhanden.vorgang!==vorgang||vorhanden.nutzer!==nutzer||vorhanden.anmerkung!==e.anmerkung||vorhanden.ausschnitt!==e.ausschnitt||vorhanden.project!==e.project)return fehler('vorgang_konflikt','Dieser Vorgang enthält bereits andere Daten.',409);
   aus.push(vorhanden);continue;
  }
  const q=await ladeAnmerkungQuelle(e.project,e.art,e.quelle_id,db,true,true);
  if(q.hash!==e.hash)return fehler('revision_konflikt','Quelle inzwischen geändert. Bitte den Ausschnitt neu lesen.',409);
  if(!Number.isInteger(e.start)||!Number.isInteger(e.ende)||e.start<0||e.ende<=e.start||q.text.slice(e.start,e.ende)!==e.ausschnitt||!e.ausschnitt.trim()||e.ausschnitt.length>s.grenzen.ausschnitt_max)return fehler('auswahl_ungueltig','Ausschnitt und Position passen nicht zur Quelle.');
  if(Buffer.byteLength(JSON.stringify(q.stand),'utf8')>s.einstellungen.snapshot_bytes.wert)return fehler('snapshot_zu_gross','Quelle überschreitet die eingestellte Snapshot-Grenze.');
  const version=(await db.query<{id:string}>('SELECT merke_quellenanmerkung_version($1,$2,$3,$4::jsonb)::text id',[e.project,q.art,q.id,JSON.stringify(q.stand)])).rows[0].id;
  const position={start:e.start,ende:e.ende,zeile_von:q.text.slice(0,e.start).split('\n').length,zeile_bis:q.text.slice(0,e.ende).split('\n').length,hash:q.hash};
  const r=await db.query<R>(`INSERT INTO quellenanmerkungen(id,project,art,quelle_id,version_id,ausschnitt,position,anmerkung,nutzer,vorgang)
   VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) RETURNING *`,[e.id,e.project,q.art,q.id,version,e.ausschnitt,JSON.stringify(position),e.anmerkung,nutzer,vorgang]);
  aus.push(r.rows[0]);
  await db.query('INSERT INTO quellenanmerkung_ereignisse(anmerkung_id,stand) VALUES($1,$2::jsonb)',[e.id,JSON.stringify(r.rows[0])]);
 }
 console.debug('[quellenanmerkungen]',{vorgang,anzahl:aus.length,aktion:'speichern',nutzer});
 return aus;
}
/** P22-T195/e55ed3da: dieselbe aktuelle Quelle entscheidet für Liste, get und jeden Status.
 * Keine Fehlerdetails der fremden Quelle ausgeben. User behält Historie gelöschter Quellen. */
async function berechtigteAnmerkungQuelle(project:string,a:R,db:DB=getPool(),lock=false,user=false):Promise<AnmerkungQuelle|null>{
 try{return await ladeAnmerkungQuelle(project,a.art,a.quelle_id,db,lock,user);}
 catch(e){
  const code=(e as {code?:string}).code;
  if(code==='quelle_unbekannt'||code==='artefakt_unbekannt'||code==='projekt_fremd'){
   if(user&&code==='quelle_unbekannt')return null;
   if(user&&code==='artefakt_unbekannt'&&!(await db.query('SELECT 1 FROM agent_artifacts WHERE id::text=$1',[a.quelle_id])).rows.length)return null;
   return fehler('quelle_nicht_lesbar','Quelle nicht gefunden oder nicht lesbar.',404);
  }
  throw e;
 }
}
export async function listeQuellenanmerkungen(project:string,filter:{art?:unknown;quelle_id?:unknown;status?:unknown;offset?:unknown}={},user=false){
 const s=await leseAnmerkungenStand(project),values:unknown[]=[project],where=['a.project=$1'];
 if(filter.art!==undefined){values.push(anmerkungArt(filter.art));where.push('a.art=$'+values.length);}
 if(filter.quelle_id!==undefined){const q=await ladeAnmerkungQuelle(project,filter.art,filter.quelle_id,getPool(),false,user);values.push(q.id);where.push('a.quelle_id=$'+values.length);}
 if(filter.status!==undefined&&filter.status!=='alle'){
  if(!['offen','eingearbeitet','abgelehnt'].includes(String(filter.status)))return fehler('status_ungueltig','Unbekannter Status.');
  values.push(filter.status);where.push('a.status=$'+values.length);
 }
 const offset=Number(filter.offset??0);if(!Number.isSafeInteger(offset)||offset<0)return fehler('offset_ungueltig','Ungültiger Cursor.');
 const limit=s.einstellungen.seite.wert,batch=limit+1,lesbar:R[]=[],rechte=new Map<string,Promise<boolean>>();
 let rohOffset=0,uebersprungen=0;
 // Paging zählt nur lesbare Einträge. Verweigerte Quellen erzeugen weder Löcher noch ein Mehr-Signal.
 for(;;){
  const params=[...values,batch,rohOffset];
  const r=await getPool().query<R>(
   `SELECT a.*,v.hash quell_hash FROM quellenanmerkungen a JOIN quellenanmerkung_versionen v ON v.id=a.version_id WHERE ${where.join(' AND ')} ORDER BY a.erstellt_am,a.id LIMIT $${params.length-1} OFFSET $${params.length}`,params);
  for(const a of r.rows){
   const key=String(a.art)+'\0'+String(a.quelle_id);
   let erlaubt=rechte.get(key);
   if(!erlaubt){erlaubt=berechtigteAnmerkungQuelle(project,a,undefined,false,user).then(()=>true).catch(e=>{
    if(e instanceof AnmerkungFehler&&e.code==='quelle_nicht_lesbar')return false;throw e;
   });rechte.set(key,erlaubt);}
   if(!await erlaubt)continue;
   if(uebersprungen<offset){uebersprungen++;continue;}
   lesbar.push(a);if(lesbar.length>limit)break;
  }
  if(lesbar.length>limit||r.rows.length<batch)break;
  rohOffset+=r.rows.length;
 }
 return {...s,eintraege:lesbar.slice(0,limit),mehr:lesbar.length>limit,naechster_offset:lesbar.length>limit?offset+limit:null};
}
export async function holeQuellenanmerkung(project:string,id:unknown,user=false){
 const a=(await getPool().query<R>('SELECT * FROM quellenanmerkungen WHERE project=$1 AND id::text=$2',[project,id])).rows[0];
 if(!a)return fehler('anmerkung_unbekannt','Anmerkung nicht gefunden.',404);
 const q=await berechtigteAnmerkungQuelle(project,a,undefined,false,user);
 const aktuelle=q?(await getPool().query<R>('SELECT * FROM quellenanmerkung_versionen WHERE project=$1 AND art=$2 AND quelle_id=$3 AND hash=$4',[project,a.art,a.quelle_id,q.hash])).rows[0]??null:null;
 const v=await getPool().query<R>('SELECT * FROM quellenanmerkung_versionen WHERE id=$1 OR id=$2 ORDER BY id',[a.version_id,a.beleg_version_id??null]);
 const ereignisse=(await getPool().query<R>('SELECT stand,zeit FROM quellenanmerkung_ereignisse WHERE anmerkung_id=$1 ORDER BY id',[a.id])).rows;
 return {success:true,anmerkung:a,versionen:v.rows.map(x=>({...x,text:anmerkungQuelltext(a.art as AnmerkungArt,x.stand as R)})),aktuelle_version:aktuelle?{...aktuelle,text:anmerkungQuelltext(a.art as AnmerkungArt,aktuelle.stand as R)}:null,ereignisse};
}
export async function setzeAnmerkungStatus(project:string,args:R,akteur:string){
 const freigegeben=await freigabe(project);if(!akteur)return fehler('akteur_fehlt','Authentifizierter Bearbeiter fehlt.',403);
 const status=String(args.status??''),grund=typeof args.grund==='string'?args.grund.trim():'';
 if(!['eingearbeitet','abgelehnt'].includes(status)||!grund||grund.length>freigegeben.grenzen.anmerkung_max)return fehler('status_begruendung','Status und Begründung angeben.');
 const db=await getPool().connect();
 try{
  await db.query('BEGIN');
  const a=(await db.query<R>('SELECT * FROM quellenanmerkungen WHERE project=$1 AND id::text=$2 FOR UPDATE',[project,args.id])).rows[0];
  if(!a)return fehler('anmerkung_unbekannt','Anmerkung nicht gefunden.',404);
  const q=await berechtigteAnmerkungQuelle(project,a,db,true);
  if(!q)return fehler('quelle_nicht_lesbar','Quelle nicht gefunden oder nicht lesbar.',404);
  if(a.status!=='offen')return fehler('status_konflikt','Diese Anmerkung ist bereits abgeschlossen.',409);
  let beleg:string|null=null;
  if(status==='eingearbeitet'){
   const v=(await db.query<{id:string}>('SELECT id::text FROM quellenanmerkung_versionen WHERE project=$1 AND art=$2 AND quelle_id=$3 AND hash=$4',[project,a.art,a.quelle_id,q.hash])).rows[0];
   if(!v||v.id===String(a.version_id)||String(args.beleg_version_id??'')!==v.id)return fehler('versionsbeleg_fehlt','Die aktuelle geänderte Quellversion als beleg_version_id angeben.',409);
   const alt=(await db.query<{stand:R}>('SELECT stand FROM quellenanmerkung_versionen WHERE id=$1',[a.version_id])).rows[0].stand;
   if(q.text===anmerkungQuelltext(q.art,alt)&&q.stand.title===alt.title&&q.stand.name===alt.name)return fehler('inhalt_unveraendert','Der Quelleninhalt wurde noch nicht geändert.',409);
   beleg=v.id;
  }
  const r=await db.query<R>("UPDATE quellenanmerkungen SET status=$3,begruendung=$4,beleg_version_id=$5,bearbeitet_von=$6,bearbeitet_am=NOW() WHERE project=$1 AND id=$2 RETURNING *",[project,a.id,status,grund,beleg,akteur]);
  await db.query('INSERT INTO quellenanmerkung_ereignisse(anmerkung_id,stand) VALUES($1,$2::jsonb)',[a.id,JSON.stringify(r.rows[0])]);
  await db.query('COMMIT');console.debug('[quellenanmerkungen]',{id:a.id,status,beleg,akteur});return {success:true,anmerkung:r.rows[0]};
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
/** Gemeinsame additive Lesebeilage: eine PG-Abfrage fuer alle wirklich gelieferten Quellen, kein N+1 pro Plan-Task. */
export async function haengeUserAnmerkungenAn(tool:string,args:R,result:unknown):Promise<unknown>{
 if((tool!=='search'&&!['get','read','search','list'].includes(String(args.action)))||!['plan','thought','memory','artefakt','chat','channel','search'].includes(tool)||!result||typeof result!=='object')return result;
 const project=typeof args.project==='string'?args.project:'';if(!project||project==='*')return result;
 const clone=structuredClone(result) as R,ziele:Array<{obj:R;art:AnmerkungArt;id:string}>=[];
 const liste=(x:unknown):unknown[]=>Array.isArray(x)?x:[];
 const ziel=async(obj:unknown,art:AnmerkungArt)=>{
  if(!obj||typeof obj!=='object')return;const x=obj as R,ref=x.id??x.artefakt_id??x.name;if(typeof ref!=='string'&&typeof ref!=='number')return;
  let id=String(ref);
  if(!/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]+)$/i.test(id)){
   try{id=(await ladeAnmerkungQuelle(project,art,id)).id;}catch{return;}
  }
  if(art==='artefakt')try{await berechtigteAnmerkungQuelle(project,{art,quelle_id:id});}catch{return;}
  ziele.push({obj:x,art,id});
 };
 if(tool==='plan'){
  await ziel(clone.plan??clone,'plan');for(const t of liste(clone.tasks??(clone.plan as R|undefined)?.tasks))await ziel(t,'task');
  for(const p of liste(clone.plans))await ziel(p,'plan');
 }else if(tool==='thought'){
  await ziel(clone.thought,'thought');for(const t of liste(clone.thoughts??clone.results))await ziel((t as R).thought??t,'thought');
 }else if(tool==='memory'){
  await ziel(clone.memory,'memory');for(const t of liste(clone.memories??clone.results))await ziel((t as R).memory??t,'memory');
 }else if(tool==='artefakt')await ziel(clone,'artefakt');
 else if(tool==='chat'||tool==='channel')for(const t of liste(clone.messages))await ziel(t,tool==='chat'?'chat':'nachricht');
 else for(const t of liste(clone.results)){
  const x=t as R,art=String(x.type??x.art??x.source_type??x.sourceType??'').replace(/s$/,'');
  if((ANMERKUNG_ARTEN as readonly string[]).includes(art))await ziel(x[art]??x,art as AnmerkungArt);
 }
 if(!ziele.length)return clone;
 try{
  const limit=(await leseRuntimeUeberwachungEinstellungen()).anmerkungen_seite.wert;
  const r=await getPool().query<R>(`SELECT * FROM (
   SELECT a.id,a.art,a.quelle_id,a.ausschnitt,a.position,a.anmerkung,a.nutzer,a.erstellt_am,a.version_id,a.status,v.hash quell_hash,
    row_number() OVER(PARTITION BY a.art,a.quelle_id ORDER BY a.erstellt_am,a.id) rn,
    count(*) OVER(PARTITION BY a.art,a.quelle_id) gesamt
   FROM quellenanmerkungen a JOIN quellenanmerkung_versionen v ON v.id=a.version_id
   JOIN (SELECT DISTINCT * FROM unnest($2::text[],$3::text[]) AS z(art,quelle_id)) z ON z.art=a.art AND z.quelle_id=a.quelle_id
   WHERE a.project=$1 AND a.status='offen') q WHERE rn<=$4 ORDER BY erstellt_am,id`,[project,ziele.map(x=>x.art),ziele.map(x=>x.id),limit]);
  for(const z of ziele){
   const a=r.rows.filter(x=>x.art===z.art&&x.quelle_id===z.id);
   if(a.length){z.obj.user_anmerkungen=a.map(({rn,gesamt,...x})=>x);z.obj.user_anmerkungen_mehr=Number(a[0].gesamt)>a.length;}
  }
 }catch(e){if((e as {code?:string}).code!=='42P01')clone.user_anmerkungen_fehler='nicht_lesbar';}
 return clone;
}
export async function fuehreAnmerkungenAus(args:R){
 const project=typeof args.project==='string'?args.project:'',p=aktuellerAgentPrincipal();
 if(!project)return fehler('project_fehlt','Projekt angeben.');
 switch(args.action){
  case 'diagnose':return leseAnmerkungenStand(project);
  case 'liste':return listeQuellenanmerkungen(project,{art:args.art,quelle_id:args.quelle_id,status:args.status??'offen',offset:args.offset});
  case 'get':return holeQuellenanmerkung(project,args.id);
  case 'status':if(!p)return fehler('akteur_fehlt','Ausweis erforderlich.',403);return setzeAnmerkungStatus(project,args,p.art==='identity'?p.identity_id:p.agent_id);
  default:return fehler('aktion_unbekannt','Unbekannte Anmerkungsaktion.');
 }
}
