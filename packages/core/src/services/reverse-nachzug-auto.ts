/**
 * P18-T98/T111: gedrosselter Reverse-Nachzug mit niedrigster Priorität. Schalter in reverse_einstellungen (global), Standard aus.
 * - s1_neu_parsen_auto: S1 neu parsen, wenn die aktuelle S1-Schicht nicht vom aktuellen Parser-Profil stammt
 *   (nur bei reverse_parser_adapter EIN). Höchstens s1_neu_parsen_schritt offene Nachzug-Aufträge.
 * - s3_auto (P18-T111): S3/Ghidra für PE-Programme (.exe/.dll/.ocx/.sys/.drv), kleinste Datei zuerst, höchstens
 *   s3_auto_offen_max offene und s3_auto_schritt neue Aufträge je Takt. Eigener Pin-Weg (auto_grenze S3), analyse_bis_schicht
 *   bleibt S1. Dedupe je Hash und Werkzeugstand über Fingerabdruck/reverse_analyse_cache; Marke je Werkzeugstand.
 * Eingereiht wird nur über den vorhandenen queue-Weg der Pipeline (Fingerabdruck, Cache, Retry, Policy-Pin) mit Priorität
 * 'nachzug'. Solange interaktive oder Hintergrund-Aufträge offen sind, setzt der Takt aus. Fehler gehen ins Reverse-Fehlerlog
 * (P18-T109), der Takt läuft mit der nächsten Datei weiter. Jede Datei wird je Parser-Profil höchstens einmal automatisch
 * angestoßen (Marke reverse_dateien.metadaten.nachzug_auto); vorübergehende Gründe (Warteschlange voll, Halt) setzen keine Marke.
 *
 * Ursache des Altbestands (Messung 24.10.2026, Siedler 3): abgeschlossene manuelle E-Aufträge der Medien ohne Policy-Pin
 * (Altbestand vor P18-T104) liessen bereiteReversePolicyPin mit policy_pin_fehlt scheitern; entdecke() reihte darum keine
 * Datei dieser Medien neu ein. Nachzug-Aufträge setzen ohneLegacyAbgeschlossen und sind davon nicht mehr betroffen.
 */
import {reverseWert,reverseZahl,type ReverseEinstellSnapshot} from './reverse-einstellwerte.js';
import {loggeReverseFehler,reverseFehlerKomponente} from './reverse-fehlerlog.js';
import {reverseFehlerDeterministisch} from './reverse-ausfuehrer.js';
import {projekteMitBacklog} from './code.js';
import type {ReverseAnalyseAnfrage} from './reverse-tool.js';

type Row=Record<string,unknown>;
type Db={query:Function};
export type ReverseNachzugArt='s1'|'s3';
export interface ReverseNachzugKandidat {id:string;eintrag_id:string;medium_id:string|null;pfad:string|null}
export interface ReverseNachzugAutoKontext {
 pool:Db;ein:ReverseEinstellSnapshot;
 /** Aktuelles S1-Parserprofil der Pipeline; null = reverse_parser_adapter aus, dann kein Neu-Parsen. */
 parserProfil:string|null;
 /** P18-T111: Werkzeugstand des Reverse-Containers (= werkzeug_version der S3-Schicht). */
 s3Kennung:string;
 /** Pipeline-queue in eigener Transaktion (Admission, Policy-Sperre). */
 einreihen:(a:ReverseAnalyseAnfrage)=>Promise<Row>;
 /** Aussetzgrund oder null; Standard reverseNachzugVorrang (Tests ersetzen ihn). */
 vorrang?:(db:Db)=>Promise<string|null>;
}
export const REVERSE_NACHZUG_AGENT='reverse-nachzug-auto';
const OFFEN="('offen','wartet','laeuft')";
/** Nie dauerhaft markieren: aendert sich mit Schaltern, Ausfuehrern oder Policy (reverseFehlerDeterministisch zaehlt kein_ausfuehrer/policy_* als endgueltig). */
const VORUEBERGEHEND=['warteschlange_voll','container_gesperrt','container_ruht','kein_ausfuehrer'];
const schalterAn=(ein:ReverseEinstellSnapshot,n:'s1_neu_parsen_auto'|'s3_auto'|'auto_nachzug_debug')=>reverseWert(ein,n)==='an';

/** Abgebrochener jüngster Auftrag einer Datei: die Automatik reiht nichts neu ein (wie entdecke, P18-T87). */
const NICHT_ABGEBROCHEN=`NOT EXISTS(SELECT 1 FROM reverse_auftraege ab WHERE ab.datei_id=d.id AND ab.status='abgebrochen'
 AND NOT EXISTS(SELECT 1 FROM reverse_auftraege nz WHERE nz.datei_id=d.id AND nz.created_at>ab.created_at))`;
/** Nur aktive Eintraege (Vertrag reverseEintragAktiv, reverse-asset-registrierung.ts): bestaetigt UND eine aktuelle fertige E-Schicht. */
const AUTOMATISCH=`e.status='bestaetigt' AND COALESCE((e.analyse_policy->>'automatisch')::boolean,true) AND d.storage_key IS NOT NULL AND d.sha256 IS NOT NULL
  AND EXISTS(SELECT 1 FROM reverse_schichten es JOIN reverse_medien em ON em.id=es.medium_id WHERE em.eintrag_id=e.id AND es.schicht='E' AND es.aktuell AND es.status IN ('fertig','teilweise'))`;

/** $1 Limit, $2 aktuelles Parser-Profil. */
export const REVERSE_S1_NEU_PARSEN_SQL=`SELECT d.id::text AS id,d.eintrag_id,d.medium_id::text AS medium_id,d.pfad FROM reverse_dateien d JOIN reverse_eintraege e ON e.id=d.eintrag_id
 WHERE ${AUTOMATISCH}
  AND EXISTS(SELECT 1 FROM reverse_schichten s WHERE s.datei_id=d.id AND s.schicht='S1' AND s.aktuell AND s.status IN ('fertig','teilweise') AND s.profil_version<>$2)
  AND COALESCE(d.metadaten->'nachzug_auto'->>'s1_kennung','')<>$2
  AND NOT EXISTS(SELECT 1 FROM reverse_auftraege r WHERE r.datei_id=d.id AND r.status IN ${OFFEN})
  AND ${NICHT_ABGEBROCHEN}
 ORDER BY COALESCE(d.metadaten->'nachzug_auto'->>'s1_versuch_at',''),d.id LIMIT $1`;

/** P18-T111: $1 Limit, $2 Werkzeugstand, $3 Parser-Profil oder NULL (S1 muss aktuell sein, sonst liefe zuerst S1). Kleinste Datei zuerst. */
export const REVERSE_S3_AUTO_SQL=`SELECT d.id::text AS id,d.eintrag_id,d.medium_id::text AS medium_id,d.pfad FROM reverse_dateien d JOIN reverse_eintraege e ON e.id=d.eintrag_id
 WHERE ${AUTOMATISCH} AND d.format='pe' AND lower(d.pfad) ~ '\\.(exe|dll|ocx|sys|drv)$'
  AND EXISTS(SELECT 1 FROM reverse_schichten s WHERE s.datei_id=d.id AND s.schicht='S1' AND s.aktuell AND s.status IN ('fertig','teilweise') AND ($3::text IS NULL OR s.profil_version=$3))
  AND NOT EXISTS(SELECT 1 FROM reverse_schichten s WHERE s.datei_id=d.id AND s.schicht='S3' AND s.aktuell AND s.status IN ('fertig','teilweise') AND s.werkzeug_version=$2)
  AND COALESCE(d.metadaten->'nachzug_auto'->>'s3_kennung','')<>$2
  AND NOT EXISTS(SELECT 1 FROM reverse_auftraege r WHERE r.datei_id=d.id AND r.status IN ${OFFEN})
  AND ${NICHT_ABGEBROCHEN}
 ORDER BY COALESCE(d.metadaten->'nachzug_auto'->>'s3_versuch_at',''),d.groesse NULLS LAST,d.id LIMIT $1`;

/** Vorrang: offene interaktive oder Hintergrund-Arbeit der Reverse-Pipeline geht immer vor. */
export async function reverseNachzugVorrangOffen(db:Db):Promise<boolean>{
 return !!(await db.query(`SELECT 1 FROM reverse_auftraege WHERE status IN ${OFFEN} AND prioritaet IN ('interaktiv','hintergrund') LIMIT 1`)).rowCount;
}
/** Vorrang (User: nichts darf blockiert werden): offene Reverse-Arbeit, laufender Leser-Nachzug, Projekt-Chunk- bzw. Parse-Rueckstand
 * ueber den Schwellen nachzug_vorrang_chunks_max/-parse_max (0 = nicht pruefen). Nur lesend; liefert den Aussetzgrund mit Zahl
 * oder null. Nicht lesbar zaehlt als Vorrang (lieber aussetzen als blockieren). */
export async function reverseNachzugVorrang(db:Db,ein?:ReverseEinstellSnapshot):Promise<string|null>{
 try{
  if(await reverseNachzugVorrangOffen(db))return 'vorrang_offen';
  if((await db.query("SELECT 1 FROM reverse_leser_nachzug WHERE status='offen' LIMIT 1")).rowCount)return 'leser_nachzug_laeuft';
  if((await db.query("SELECT 1 FROM work_jobs WHERE kind LIKE 'reverse-leser%' AND state IN ('pending','leased','staged') LIMIT 1")).rowCount)return 'leser_nachzug_laeuft';
  const chunksMax=ein?reverseZahl(ein,'nachzug_vorrang_chunks_max'):1000,parseMax=ein?reverseZahl(ein,'nachzug_vorrang_parse_max'):100;
  if(chunksMax>0){
   const n=Number((await db.query('SELECT count(*)::int AS n FROM (SELECT 1 FROM code_chunks WHERE embedded_at IS NULL AND prio IS NOT NULL AND (zurueckgestellt_bis IS NULL OR zurueckgestellt_bis<clock_timestamp()) LIMIT $1) x',[chunksMax+1])).rows[0]?.n??0);
   if(n>chunksMax)return 'projekt_chunks_offen:>'+chunksMax;
  }
  if(parseMax>0){
   const n=(await projekteMitBacklog(1000)).reduce((s,p)=>s+Number(p.faellig),0);
   if(n>parseMax)return 'projekt_parse_backlog:'+n+'>'+parseMax;
  }
  return null;
 }catch(e){return 'vorrang_nicht_lesbar:'+String((e as {code?:string})?.code??(e as Error)?.message??e).slice(0,80);}
}
async function offeneNachzuege(db:Db,schicht:string):Promise<number>{
 return Number((await db.query(`SELECT count(*)::int AS n FROM reverse_auftraege WHERE status IN ${OFFEN} AND prioritaet='nachzug' AND (schicht=$1 OR ziel_schicht=$1)`,[schicht])).rows[0]?.n??0);
}

/** Einreihen, Fehler ins Fehlerlog, Marke setzen (ausser bei vorübergehenden Gründen). Wirft nie. */
export async function reiheReverseNachzugEin(k:Pick<ReverseNachzugAutoKontext,'pool'|'einreihen'>,d:ReverseNachzugKandidat,art:ReverseNachzugArt|'s3',kennung:string,a:ReverseAnalyseAnfrage):Promise<string>{
 let r:Row;
 try{r=await k.einreihen(a);}catch(e){r={status:'fehler',fehlercode:String((e as {code?:string})?.code??'werkzeug_fehler'),fehler_detail:String((e as Error)?.message??e).slice(0,200)};}
 const code=r.fehlercode==null?null:String(r.fehlercode);
 const fehler=r.status==='fehler'||r.success===false;
 const schicht=art==='s1'?'S1':'S3';
 if(fehler)await loggeReverseFehler({eintrag_id:d.eintrag_id,datei:d.pfad??d.id,schicht,komponente:reverseFehlerKomponente(code,schicht),
  name:art==='s1'?'s1_neu_parsen_auto':'s3_auto',grund:code??'werkzeug_fehler',detail:r.fehler_detail==null?null:String(r.fehler_detail),quelle:REVERSE_NACHZUG_AGENT},k.pool as never);
 // Dauerhafte Marke (je Profil/Werkzeugstand einmal) nur bei Erfolg oder fachlich endgueltigem Fehler. Voruebergehendes (reverse_s3 aus,
 // kein_ausfuehrer, Policy, Warteschlange voll, Halt) merkt nur den Versuch: die Datei bleibt Kandidat, rueckt aber hinter neue Dateien.
 const voruebergehend=r.status==='gehalten'||fehler&&(VORUEBERGEHEND.includes(code??'')||(code??'').startsWith('policy_')||!reverseFehlerDeterministisch(code??''));
 const dauerhaft=!voruebergehend;
 const jetzt=new Date().toISOString();
 const marke=dauerhaft?{[art+'_kennung']:kennung,[art+'_at']:jetzt,[art+'_ergebnis']:fehler?code:String(r.status??'wartet'),[art+'_fehler']:fehler}
  :{[art+'_versuch_at']:jetzt,[art+'_ergebnis']:code??String(r.status),[art+'_fehler']:true};
 try{
  await k.pool.query("UPDATE reverse_dateien SET metadaten=COALESCE(metadaten,'{}'::jsonb)||jsonb_build_object('nachzug_auto',COALESCE(metadaten->'nachzug_auto','{}'::jsonb)||$2::jsonb) WHERE id=$1::bigint",[d.id,JSON.stringify(marke)]);
 }catch{/* Marke ist nur Drossel; der naechste Takt versucht es erneut. */}
 return fehler?'fehler:'+(code??'werkzeug_fehler'):String(r.status??'wartet');
}

/** T98: ein Takt S1-Neu-Parsen. Ergebnis nur für Debug/Tests. */
export async function reverseS1NeuParsenTakt(k:ReverseNachzugAutoKontext):Promise<Row>{
 if(!schalterAn(k.ein,'s1_neu_parsen_auto'))return {aktiv:false,grund:'s1_neu_parsen_auto_aus'};
 if(!k.parserProfil)return {aktiv:false,grund:'reverse_parser_adapter_aus'};
 const vorrang=await (k.vorrang??(db=>reverseNachzugVorrang(db,k.ein)))(k.pool);if(vorrang)return {aktiv:true,ausgesetzt:vorrang};
 const frei=reverseZahl(k.ein,'s1_neu_parsen_schritt')-await offeneNachzuege(k.pool,'S1');
 if(frei<=0)return {aktiv:true,ausgesetzt:'deckel_erreicht'};
 const kandidaten=(await k.pool.query(REVERSE_S1_NEU_PARSEN_SQL,[frei,k.parserProfil])).rows as ReverseNachzugKandidat[];
 const ergebnisse:Record<string,number>={};
 for(const d of kandidaten){
  const e=await reiheReverseNachzugEin(k,d,'s1',k.parserProfil,{reverseId:d.eintrag_id,project:'reverse-bibliothek',agentId:REVERSE_NACHZUG_AGENT,
   dateiId:d.id,mediumId:d.medium_id,bisSchicht:'S1',prioritaet:'nachzug',ohneLegacyAbgeschlossen:true});
  ergebnisse[e]=(ergebnisse[e]??0)+1;
  if(e==='fehler:warteschlange_voll')break;
 }
 return {aktiv:true,kandidaten:kandidaten.length,ergebnisse};
}

/** T111: ein Takt S3 automatisch. Ergebnis nur für Debug/Tests. */
export async function reverseS3AutoTakt(k:ReverseNachzugAutoKontext):Promise<Row>{
 if(!schalterAn(k.ein,'s3_auto'))return {aktiv:false,grund:'s3_auto_aus'};
 const vorrang=await (k.vorrang??(db=>reverseNachzugVorrang(db,k.ein)))(k.pool);if(vorrang)return {aktiv:true,ausgesetzt:vorrang};
 const frei=Math.min(reverseZahl(k.ein,'s3_auto_schritt'),reverseZahl(k.ein,'s3_auto_offen_max')-await offeneNachzuege(k.pool,'S3'));
 if(frei<=0)return {aktiv:true,ausgesetzt:'deckel_erreicht'};
 const kandidaten=(await k.pool.query(REVERSE_S3_AUTO_SQL,[frei,k.s3Kennung,k.parserProfil])).rows as ReverseNachzugKandidat[];
 const ergebnisse:Record<string,number>={};
 for(const d of kandidaten){
  const e=await reiheReverseNachzugEin(k,d,'s3',k.s3Kennung,{reverseId:d.eintrag_id,project:'reverse-bibliothek',agentId:REVERSE_NACHZUG_AGENT,
   dateiId:d.id,mediumId:d.medium_id,bisSchicht:'S3',prioritaet:'nachzug',ohneLegacyAbgeschlossen:true,autoGrenze:'S3'});
  ergebnisse[e]=(ergebnisse[e]??0)+1;
  if(e==='fehler:warteschlange_voll')break;
 }
 return {aktiv:true,kandidaten:kandidaten.length,ergebnisse};
}

/** Ein Takt aller Nachzüge; wirft nie, damit der Pipeline-Durchlauf weiterläuft. */
export async function reverseNachzugAutoTakt(k:ReverseNachzugAutoKontext):Promise<Row>{
 const takt:Row={};
 try{takt.s1=await reverseS1NeuParsenTakt(k);}catch(e){takt.s1={fehler:String((e as Error)?.message??e).slice(0,200)};}
 try{takt.s3=await reverseS3AutoTakt(k);}catch(e){takt.s3={fehler:String((e as Error)?.message??e).slice(0,200)};}
 if(schalterAn(k.ein,'auto_nachzug_debug'))console.error('[Reverse-Nachzug-Auto]',JSON.stringify(takt));
 return takt;
}
