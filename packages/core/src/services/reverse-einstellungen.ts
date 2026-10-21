/** P18-T86: Reverse-Einstellungen, gemeinsame PG-Quelle und vorhandene Verwaltungsrechte. */
import {getPool} from '../db/client.js';
import {aktuellerW1bAkteur,pruefeProfilVerwalter,ProfilVerwaltungFehler,pflichtText} from './agent-profil-verwalter.js';
import type {AusweisAkteur} from './agent-profil-vertrag.js';
import {REVERSE_EINSTELLKATALOG,reverseEinstellDefinition,reverseEinstellWert,reverseSichereZahl,reverseBudgetZahl,type ReverseEbene} from './reverse-einstellkatalog.js';
import {leseReverseEinstellwerte,reverseEinstellSnapshot,reverseEinstellAnzeige,reverseZahl,leseReverseBlockSchalter,leseReverseProduktSchalter,
 type ReverseSchalterStand} from './reverse-einstellwerte.js';
const LESE_SCHLUESSEL=["s3_pg_budget_bytes","s3_nachzug_lease_ms","erkenntnis_bytes","erkenntnis_belege","erkenntnis_aussagen","antwort_bytes","seiten_limit","max_limit","max_pfad_zeichen","analyse_verweise","analyse_dateien","analyse_funktionen","analyse_kanten","max_ziele","aufrufer_tiefe","aufrufer_max","konfidenz_prozent","max_muster_zeichen","laufzeit_ms","fortschritt_takt_s","fortschritt_haenger_s","hart_puffer_s","nachlauf_s"] as const;
export type ReverseEinstellungName=typeof LESE_SCHLUESSEL[number];
/** number-Rand der bisherigen Leser: Ganzzahlen exakt, Bytebudgets über reverseBudgetZahl (nie gerundet). */
const alsZahl=(name:ReverseEinstellungName,wert:string)=>REVERSE_EINSTELLKATALOG[name].typ==='bigint'?reverseBudgetZahl(wert):reverseSichereZahl(wert,name);
/** Kompatibler number-Vertrag der bisherigen Leser; Standards nur aus dem Katalog. */
export const REVERSE_EINSTELLUNGEN=Object.fromEntries(LESE_SCHLUESSEL.map(n=>[n,alsZahl(n,REVERSE_EINSTELLKATALOG[n].standard)])) as Record<ReverseEinstellungName,number>;
export interface ReverseWert {wert:number;exakt:string;quelle:'standard'|'global'|'projekt'|'eintrag';standard:number;global:number|null;projekt:number|null;eintrag:number|null}
export interface ReverseStand {
 project:string|null;eintrag_id:string|null;werte:Record<ReverseEinstellungName,ReverseWert>;letzter_fehler:string|null;schalter:ReverseSchalterStand;
}
/** eintragId: für Eintragswerte (z. B. s3_pg_budget_bytes); Projektwerte nur für Leser-/Antwortgrenzen. */
export async function leseReverseEinstellungen(project:string|null,funktion:'reverse_verknuepfungen'|'reverse_erkenntnisse'='reverse_verknuepfungen',eintragId:string|null=null):Promise<ReverseStand>{
 const s=await leseReverseEinstellwerte({project,eintrag_id:eintragId});
 const werte={} as ReverseStand['werte'];
 const z=(name:ReverseEinstellungName,v:string|null)=>v===null?null:alsZahl(name,v);
 for(const name of LESE_SCHLUESSEL){
  const w=s.werte[name];
  werte[name]={wert:alsZahl(name,w.wert),exakt:w.wert,quelle:w.ebene??'standard',standard:REVERSE_EINSTELLUNGEN[name],
   global:z(name,w.global),projekt:z(name,w.projekt),eintrag:z(name,w.eintrag)};
 }
 return {project,eintrag_id:eintragId,werte,letzter_fehler:s.letzter_fehler,schalter:await leseReverseProduktSchalter(funktion,project)};
}
/** Nutzdatenbudget: maskierter C/ASM-Text und Referenzdaten, ohne PostgreSQL-Index-/Zeilenoverhead. Summen exakt als Text. */
export async function leseReverseSpeicherVerbrauch(db:{query:Function},reverseId:string|null):Promise<{verbrauch_bytes:number;verbrauch_bytes_exakt:string;fehlend_gesamt:number;eintraege:number}>{
 const r=(await db.query("SELECT COALESCE(sum(CASE WHEN metadaten#>>'{s3_speicher,verbrauch_bytes}' ~ '^[0-9]{1,18}$' THEN (metadaten#>>'{s3_speicher,verbrauch_bytes}')::bigint ELSE 0 END),0)::text AS bytes,COALESCE(sum(CASE WHEN metadaten#>>'{s3_speicher,fehlend_gesamt}' ~ '^[0-9]{1,18}$' THEN (metadaten#>>'{s3_speicher,fehlend_gesamt}')::bigint ELSE 0 END),0)::text AS fehlend,count(DISTINCT eintrag_id)::int AS eintraege FROM reverse_dateien WHERE ($1::text IS NULL OR eintrag_id=$1) AND metadaten ? 's3_speicher'",[reverseId])).rows[0];
 const bytes=String(r?.bytes??'0');
 return {verbrauch_bytes:reverseBudgetZahl(bytes),verbrauch_bytes_exakt:bytes,fehlend_gesamt:reverseBudgetZahl(String(r?.fehlend??'0')),eintraege:Number(r?.eintraege??0)};
}
export const REVERSE_ADMIN_ACTIONS=['reverse_einstellungen'] as const;
export const REVERSE_ADMIN_PARAMETER={
 reverse_id:{type:'string',description:'Gebundener Reverse-Eintrag fuer eintragsbezogene Einstellungen'},
 reverse_ebene:{type:'string',enum:['global','projekt','eintrag'],description:'reverse_einstellungen: Ebene (Standard projekt; eintrag braucht reverse_id). Ersetzt dort ebene.'},
 reverse_werte:{type:'object',additionalProperties:{oneOf:[{type:'integer',minimum:0},{type:'string'}]},description:'Reverse-Einstellwerte; Bytes als Dezimaltext, Auswahlwerte als Text'},
 reverse_namen:{type:'array',items:{type:'string'},description:'reverse_einstellungen entfernen: Namen auf dieser Ebene zuruecksetzen'},
};
export async function fuehreReverseAdminAus(args:Record<string,unknown>,wer:AusweisAkteur|null=aktuellerW1bAkteur()):Promise<Record<string,unknown>>{
 try{
  const project=typeof args.project==='string'&&args.project?args.project:null;
  if(!project||!wer)throw new ProfilVerwaltungFehler('recht_fehlt');
  const rid=typeof args.reverse_id==='string'&&args.reverse_id?args.reverse_id:null;
  const modus=args.modus??'status';
  const ebene=args.reverse_ebene??args.ebene??'projekt';
  // Verwaltungsrecht aus bezeugtem Akteur. Der Main verwaltet nur Werte seines Projekts; globale und
  // eintragsbezogene Werte wirken über Projektgrenzen hinweg und bleiben Koordinator/User vorbehalten.
  let akteur:{wer:string;actor_identity_id:string|null};
  if(wer.art==='identitaet'&&wer.principal.rolle==='main'&&wer.principal.project===project&&(modus==='status'||ebene==='projekt')){
   const p=wer.principal;
   const r=await getPool().query("SELECT 1 FROM agent_identitaeten WHERE id=$1 AND project=$2 AND rolle='main' AND status='aktiv'",[p.identity_id,project]);
   if(!r.rows[0])throw new ProfilVerwaltungFehler('recht_fehlt');
   akteur={wer:p.identity_id,actor_identity_id:p.identity_id};
  }else akteur=await pruefeProfilVerwalter(wer,project);
  if(rid&&!(await getPool().query("SELECT 1 FROM reverse_bindungen WHERE project=$1 AND eintrag_id=$2 AND geloest_at IS NULL",[project,rid])).rows[0])
   throw new ProfilVerwaltungFehler('nicht_gebunden');
  if(modus!=='status'){
   if(modus!=='setzen'&&modus!=='entfernen')throw new ProfilVerwaltungFehler('modus_ungueltig');
   if(ebene!=='global'&&ebene!=='projekt'&&ebene!=='eintrag')throw new ProfilVerwaltungFehler('ebene_ungueltig');
   if(ebene==='eintrag'&&!rid)throw new ProfilVerwaltungFehler('reverse_id_fehlt');
   const grund=pflichtText(args.grund,'grund_fehlt');
   const raw=args.reverse_werte;
   if(modus==='setzen'&&(!raw||typeof raw!=='object'||Array.isArray(raw)))throw new ProfilVerwaltungFehler('reverse_werte_fehlen');
   if(modus==='entfernen'&&(!Array.isArray(args.reverse_namen)||!args.reverse_namen.length))throw new ProfilVerwaltungFehler('reverse_namen_fehlen');
   const entries=modus==='setzen'?Object.entries(raw as Record<string,unknown>):(args.reverse_namen as unknown[]).map(n=>[n,null]);
   if(!entries.length)throw new ProfilVerwaltungFehler('reverse_werte_fehlen');
   const normalisiert=entries.map(([name,v])=>{
    if(typeof name!=='string')throw new ProfilVerwaltungFehler('reverse_name_ungueltig');
    const d=reverseEinstellDefinition(name);
    if(!d.ebenen.includes(ebene as ReverseEbene))throw new ProfilVerwaltungFehler('reverse_ebene_ungueltig');
    return {name,enum:d.typ==='enum',wert:modus==='setzen'?reverseEinstellWert(name,v):null};
   });
   const aktuell=await leseReverseEinstellwerte({project,eintrag_id:rid});
   if(aktuell.letzter_fehler==='reverse_einstellungen_nicht_lesbar')throw new Error(aktuell.letzter_fehler);
   const c=await getPool().connect();
   try{
    await c.query('BEGIN');
    await c.query("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true),set_config('idle_in_transaction_session_timeout',$2,true)",
     [reverseZahl(aktuell,'einstellungen_schreiben_lock_ms')+'ms',reverseZahl(aktuell,'einstellungen_schreiben_timeout_ms')+'ms']);
    await c.query("SELECT pg_advisory_xact_lock(hashtext('reverse-einstellungen'))");
    const ziel=ebene==='projekt'?project:null,eintrag=ebene==='eintrag'?rid:null;
    if(modus==='entfernen')await c.query("DELETE FROM reverse_einstellungen WHERE ebene=$1 AND COALESCE(project,'')=COALESCE($2,'') AND COALESCE(eintrag_id,'')=COALESCE($3,'') AND name=ANY($4::text[])",[ebene,ziel,eintrag,normalisiert.map(e=>e.name)]);
    else await c.query(`INSERT INTO reverse_einstellungen(ebene,project,eintrag_id,name,wert,wert_text,grund,gesetzt_von) SELECT $1,$2,$3,n,v,t,$4,$5 FROM unnest($6::text[],$7::bigint[],$8::text[]) AS x(n,v,t)
     ON CONFLICT(ebene,(COALESCE(project,'')),(COALESCE(eintrag_id,'')),name) DO UPDATE SET wert=EXCLUDED.wert,wert_text=EXCLUDED.wert_text,grund=EXCLUDED.grund,gesetzt_von=EXCLUDED.gesetzt_von,gesetzt_am=NOW()`,
     [ebene,ziel,eintrag,grund,akteur.wer,normalisiert.map(e=>e.name),normalisiert.map(e=>e.enum?null:e.wert),normalisiert.map(e=>e.enum?e.wert:null)]);
    // Globale Änderungen müssen auch mit bestehenden Projekt-/Eintrags-Overrides konsistent bleiben (DB prüft dasselbe am TX-Ende).
    const alle=(await c.query("SELECT ebene,project,eintrag_id,name,COALESCE(wert::text,wert_text) AS wert FROM reverse_einstellungen")).rows;
    const kontexte=[{},...alle.map(z=>({project:z.project,eintrag_id:z.eintrag_id}))];
    for(const k of kontexte){const s=reverseEinstellSnapshot(alle,k);if(s.letzter_fehler)throw new Error(s.letzter_fehler);}
    await c.query('COMMIT');
   }catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e;}finally{c.release();}
  }
  const s=await leseReverseEinstellwerte({project,eintrag_id:rid});
  return {success:true,action:'reverse_einstellungen',modus,project,reverse_id:rid,revision:s.revision,
   werte:reverseEinstellAnzeige(s),migrationsbedarf:s.migrationsbedarf,letzter_fehler:s.letzter_fehler,
   schalter:(await leseReverseEinstellungen(project)).schalter,blockuebernahme:await leseReverseBlockSchalter(),
   verbrauch:await leseReverseSpeicherVerbrauch(getPool(),rid)};
 }catch(e){
  const m=e instanceof Error?e.message:'';
  if(!(e instanceof ProfilVerwaltungFehler)&&!m.startsWith('reverse_'))console.error('[reverse-einstellungen] Verwaltung fehlgeschlagen:',m);
  return {success:false,action:'reverse_einstellungen',error:e instanceof ProfilVerwaltungFehler?e.code:m.startsWith('reverse_')?m
   :/reverse_einstellung(en_widerspruch|_ungueltig)/.test(m)?m.replace(/^.*?(reverse_einstellung)/,'$1'):'reverse_einstellungen_speicher_fehler'};
 }
}
