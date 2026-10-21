/** P18-T44: PG configuration and diagnostics for read-only code/file linking. */
import {getPool} from '../db/client.js';
import {leseProfilProduktSchalter} from './agent-profil-schalter.js';
import {internToolAktiv} from './intern-tool.js';
import {aktuellerW1bAkteur,pruefeProfilVerwalter,ProfilVerwaltungFehler,pflichtText} from './agent-profil-verwalter.js';
import type {AusweisAkteur} from './agent-profil-vertrag.js';

export const REVERSE_EINSTELLUNGEN={
 s3_pg_budget_bytes:1073741824,s3_nachzug_lease_ms:300000,
 erkenntnis_bytes:60000,erkenntnis_belege:100,erkenntnis_aussagen:100,
 antwort_bytes:80000,seiten_limit:50,max_limit:200,max_pfad_zeichen:4096,analyse_verweise:10000,analyse_dateien:30000,
 analyse_funktionen:50000,analyse_kanten:100000,max_ziele:200,
 aufrufer_tiefe:3,aufrufer_max:100,konfidenz_prozent:80,max_muster_zeichen:512,laufzeit_ms:5000,
 // P18-T85: Live-Fortschritt: Meldetakt des Runners (s, hoechstens 600) und Schwelle fuer den Haenger-Hinweis (s, kein Abbruch).
 fortschritt_takt_s:10,fortschritt_haenger_s:180,
} as const;
export type ReverseEinstellungName=keyof typeof REVERSE_EINSTELLUNGEN;
export interface ReverseWert {wert:number;quelle:'standard'|'global'|'projekt';standard:number;global:number|null;projekt:number|null}
export interface ReverseStand {
 project:string|null;werte:Record<ReverseEinstellungName,ReverseWert>;letzter_fehler:string|null;
 schalter:{aktiv:boolean;quelle:'standard'|'produkt-schalter'|'intern';bis:string|null;letzter_fehler:string|null};
}
export async function leseReverseEinstellungen(project:string|null,funktion:'reverse_verknuepfungen'|'reverse_erkenntnisse'='reverse_verknuepfungen'):Promise<ReverseStand>{
 const werte={} as ReverseStand['werte'];let fehler:string|null=null;
 let rows:Array<{ebene:string;name:string;wert:string}>=[];
 try{rows=(await getPool().query("SELECT ebene,name,wert::text FROM reverse_einstellungen WHERE ebene='global' OR (ebene='projekt' AND project=$1)",[project])).rows;}
 catch{fehler='reverse_einstellungen_nicht_lesbar';}
 for(const name of Object.keys(REVERSE_EINSTELLUNGEN) as ReverseEinstellungName[]){
  const g=rows.find(r=>r.name===name&&r.ebene==='global'),p=rows.find(r=>r.name===name&&r.ebene==='projekt'),z=p??g;
  const n=z?Number(z.wert):REVERSE_EINSTELLUNGEN[name],gueltig=Number.isSafeInteger(n)&&n>0&&n<=2147483647&&(name!=='konfidenz_prozent'||n<=100);
  if(!gueltig)fehler='reverse_einstellung_ungueltig';
  werte[name]={wert:gueltig?n:REVERSE_EINSTELLUNGEN[name],quelle:gueltig&&z?(p?'projekt':'global'):'standard',
   standard:REVERSE_EINSTELLUNGEN[name],global:g?Number(g.wert):null,projekt:p?Number(p.wert):null};
 }
 const produkt=await leseProfilProduktSchalter(funktion,project);
 let schalter:ReverseStand['schalter']={aktiv:produkt.aktiv,quelle:produkt.quelle,bis:null,letzter_fehler:produkt.letzter_fehler};
 if(internToolAktiv()){
  try{
   const r=await getPool().query({text:"SELECT aktiv,bis FROM intern_schalter WHERE name=$1 AND modus='freigegeben' AND bis>NOW()",values:[funktion],query_timeout:2000} as import('pg').QueryConfig & {query_timeout:number});
   const z=r.rows[0];if(z)schalter={aktiv:z.aktiv,quelle:'intern',bis:new Date(z.bis).toISOString(),letzter_fehler:null};
  }catch{schalter.letzter_fehler='reverse_override_nicht_lesbar';}
 }
 return {project,werte,letzter_fehler:fehler,schalter};
}
/** Nutzdatenbudget: maskierter C/ASM-Text und Referenzdaten, ohne PostgreSQL-Index-/Zeilenoverhead. */
export async function leseReverseSpeicherVerbrauch(db:{query:Function},reverseId:string|null):Promise<{verbrauch_bytes:number;fehlend_gesamt:number;eintraege:number}>{
 const r=(await db.query("SELECT COALESCE(sum(CASE WHEN metadaten#>>'{s3_speicher,verbrauch_bytes}' ~ '^[0-9]+$' THEN (metadaten#>>'{s3_speicher,verbrauch_bytes}')::bigint ELSE 0 END),0)::text AS bytes,COALESCE(sum(CASE WHEN metadaten#>>'{s3_speicher,fehlend_gesamt}' ~ '^[0-9]+$' THEN (metadaten#>>'{s3_speicher,fehlend_gesamt}')::bigint ELSE 0 END),0)::text AS fehlend,count(DISTINCT eintrag_id)::int AS eintraege FROM reverse_dateien WHERE ($1::text IS NULL OR eintrag_id=$1) AND metadaten ? 's3_speicher'",[reverseId])).rows[0];
 return {verbrauch_bytes:Number(r?.bytes??0),fehlend_gesamt:Number(r?.fehlend??0),eintraege:Number(r?.eintraege??0)};
}
export const REVERSE_ADMIN_ACTIONS=['reverse_einstellungen'] as const;
export const REVERSE_ADMIN_PARAMETER={
 reverse_werte:{type:'object',additionalProperties:{type:'integer',minimum:1},description:'reverse_einstellungen setzen: Reverse-Budgets (status nennt Namen und Quellen)'},
 reverse_namen:{type:'array',items:{type:'string'},description:'reverse_einstellungen entfernen: Namen auf dieser Ebene zuruecksetzen'},
};
export async function fuehreReverseAdminAus(args:Record<string,unknown>,wer:AusweisAkteur|null=aktuellerW1bAkteur()):Promise<Record<string,unknown>>{
 try{
  const project=typeof args.project==='string'&&args.project?args.project:null;
  if(!project||!wer)throw new ProfilVerwaltungFehler('recht_fehlt');
  // Verwaltungsrecht aus bezeugtem Akteur; der Main verwaltet seinen eigenen Rahmen, keine fremden Projekte.
  let akteur:{wer:string;actor_identity_id:string|null};
  if(wer.art==='identitaet'&&wer.principal.rolle==='main'&&wer.principal.project===project){
   const p=wer.principal;
   const r=await getPool().query("SELECT 1 FROM agent_identitaeten WHERE id=$1 AND project=$2 AND rolle='main' AND status='aktiv'",[p.identity_id,project]);
   if(!r.rows[0])throw new ProfilVerwaltungFehler('recht_fehlt');
   akteur={wer:p.identity_id,actor_identity_id:p.identity_id};
  }else akteur=await pruefeProfilVerwalter(wer,project);
  const modus=args.modus??'status';
  if(modus!=='status'){
   if(modus!=='setzen'&&modus!=='entfernen')throw new ProfilVerwaltungFehler('modus_ungueltig');
   const ebene=args.ebene??'projekt';
   if(ebene!=='global'&&ebene!=='projekt')throw new ProfilVerwaltungFehler('ebene_ungueltig');
   const grund=pflichtText(args.grund,'grund_fehlt');
   const raw=args.reverse_werte;
   if(modus==='setzen'&&(!raw||typeof raw!=='object'||Array.isArray(raw)))throw new ProfilVerwaltungFehler('reverse_werte_fehlen');
   if(modus==='entfernen'&&(!Array.isArray(args.reverse_namen)||!args.reverse_namen.length))throw new ProfilVerwaltungFehler('reverse_namen_fehlen');
   const entries=modus==='setzen'?Object.entries(raw as Record<string,unknown>):(args.reverse_namen as unknown[]).map(n=>[n,null]);
   if(!entries.length)throw new ProfilVerwaltungFehler('reverse_werte_fehlen');
   for(const [name,v] of entries){
    if(typeof name!=='string'||!Object.hasOwn(REVERSE_EINSTELLUNGEN,name))throw new ProfilVerwaltungFehler('reverse_name_ungueltig');
    if(modus==='setzen'&&(typeof v!=='number'||!Number.isSafeInteger(v)||v<1||v>2147483647||(name==='konfidenz_prozent'&&v>100)))throw new ProfilVerwaltungFehler('reverse_wert_ungueltig');
   }
   const c=await getPool().connect();
   try{
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='10s'; SET LOCAL idle_in_transaction_session_timeout='10s'");
    const ziel=ebene==='projekt'?project:null;
    if(modus==='entfernen')await c.query("DELETE FROM reverse_einstellungen WHERE ebene=$1 AND COALESCE(project,'')=COALESCE($2,'') AND name=ANY($3::text[])",[ebene,ziel,entries.map(e=>e[0])]);
    else await c.query("INSERT INTO reverse_einstellungen(ebene,project,name,wert,grund,gesetzt_von) SELECT $1,$2,n,v,$3,$4 FROM unnest($5::text[],$6::bigint[]) AS x(n,v) ON CONFLICT(ebene,(COALESCE(project,'')),name) DO UPDATE SET wert=EXCLUDED.wert,grund=EXCLUDED.grund,gesetzt_von=EXCLUDED.gesetzt_von,gesetzt_am=NOW()",[ebene,ziel,grund,akteur.wer,entries.map(e=>e[0]),entries.map(e=>e[1])]);
    await c.query('COMMIT');
   }catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e;}finally{c.release();}
  }
  return {success:true,action:'reverse_einstellungen',modus,...await leseReverseEinstellungen(project),verbrauch:await leseReverseSpeicherVerbrauch(getPool(),null)};
 }catch(e){return {success:false,action:'reverse_einstellungen',error:e instanceof ProfilVerwaltungFehler?e.code:'reverse_einstellungen_speicher_fehler'};}
}
