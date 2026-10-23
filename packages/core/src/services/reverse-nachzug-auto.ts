/**
 * P18-T98/T111: gedrosselter Reverse-Nachzug mit niedrigster Priorität. Schalter in reverse_einstellungen (global), Standard aus.
 * - s1_neu_parsen_auto: S1 neu parsen, wenn die aktuelle S1-Schicht nicht vom aktuellen Parser-Profil stammt
 *   (nur bei reverse_parser_adapter EIN). Höchstens s1_neu_parsen_schritt offene Nachzug-Aufträge.
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
import type {ReverseAnalyseAnfrage} from './reverse-tool.js';

type Row=Record<string,unknown>;
type Db={query:Function};
export type ReverseNachzugArt='s1';
export interface ReverseNachzugKandidat {id:string;eintrag_id:string;medium_id:string|null;pfad:string|null}
export interface ReverseNachzugAutoKontext {
 pool:Db;ein:ReverseEinstellSnapshot;
 /** Aktuelles S1-Parserprofil der Pipeline; null = reverse_parser_adapter aus, dann kein Neu-Parsen. */
 parserProfil:string|null;
 /** Pipeline-queue in eigener Transaktion (Admission, Policy-Sperre). */
 einreihen:(a:ReverseAnalyseAnfrage)=>Promise<Row>;
}
export const REVERSE_NACHZUG_AGENT='reverse-nachzug-auto';
const OFFEN="('offen','wartet','laeuft')";
const VORUEBERGEHEND=['warteschlange_voll','container_gesperrt'];
const schalterAn=(ein:ReverseEinstellSnapshot,n:'s1_neu_parsen_auto'|'auto_nachzug_debug')=>reverseWert(ein,n)==='an';

/** Abgebrochener jüngster Auftrag einer Datei: die Automatik reiht nichts neu ein (wie entdecke, P18-T87). */
const NICHT_ABGEBROCHEN=`NOT EXISTS(SELECT 1 FROM reverse_auftraege ab WHERE ab.datei_id=d.id AND ab.status='abgebrochen'
 AND NOT EXISTS(SELECT 1 FROM reverse_auftraege nz WHERE nz.datei_id=d.id AND nz.created_at>ab.created_at))`;
const AUTOMATISCH=`e.status='bestaetigt' AND COALESCE((e.analyse_policy->>'automatisch')::boolean,true) AND d.storage_key IS NOT NULL AND d.sha256 IS NOT NULL`;

/** $1 Limit, $2 aktuelles Parser-Profil. */
export const REVERSE_S1_NEU_PARSEN_SQL=`SELECT d.id::text AS id,d.eintrag_id,d.medium_id::text AS medium_id,d.pfad FROM reverse_dateien d JOIN reverse_eintraege e ON e.id=d.eintrag_id
 WHERE ${AUTOMATISCH}
  AND EXISTS(SELECT 1 FROM reverse_schichten s WHERE s.datei_id=d.id AND s.schicht='S1' AND s.aktuell AND s.status IN ('fertig','teilweise') AND s.profil_version<>$2)
  AND COALESCE(d.metadaten->'nachzug_auto'->>'s1_kennung','')<>$2
  AND NOT EXISTS(SELECT 1 FROM reverse_auftraege r WHERE r.datei_id=d.id AND r.status IN ${OFFEN})
  AND ${NICHT_ABGEBROCHEN}
 ORDER BY d.id LIMIT $1`;

/** Vorrang: offene interaktive oder Hintergrund-Arbeit der Reverse-Pipeline geht immer vor. */
export async function reverseNachzugVorrangOffen(db:Db):Promise<boolean>{
 return !!(await db.query(`SELECT 1 FROM reverse_auftraege WHERE status IN ${OFFEN} AND prioritaet IN ('interaktiv','hintergrund') LIMIT 1`)).rowCount;
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
 const voruebergehend=r.status==='gehalten'||VORUEBERGEHEND.includes(code??'');
 if(!voruebergehend)try{
  await k.pool.query("UPDATE reverse_dateien SET metadaten=COALESCE(metadaten,'{}'::jsonb)||jsonb_build_object('nachzug_auto',COALESCE(metadaten->'nachzug_auto','{}'::jsonb)||$2::jsonb) WHERE id=$1::bigint",
   [d.id,JSON.stringify({[art+'_kennung']:kennung,[art+'_at']:new Date().toISOString(),[art+'_ergebnis']:fehler?code:String(r.status??'wartet')})]);
 }catch{/* Marke ist nur Drossel; der naechste Takt versucht es erneut. */}
 return fehler?'fehler:'+(code??'werkzeug_fehler'):String(r.status??'wartet');
}

/** T98: ein Takt S1-Neu-Parsen. Ergebnis nur für Debug/Tests. */
export async function reverseS1NeuParsenTakt(k:ReverseNachzugAutoKontext):Promise<Row>{
 if(!schalterAn(k.ein,'s1_neu_parsen_auto'))return {aktiv:false,grund:'s1_neu_parsen_auto_aus'};
 if(!k.parserProfil)return {aktiv:false,grund:'reverse_parser_adapter_aus'};
 if(await reverseNachzugVorrangOffen(k.pool))return {aktiv:true,ausgesetzt:'vorrang_offen'};
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

/** Ein Takt aller Nachzüge; wirft nie, damit der Pipeline-Durchlauf weiterläuft. */
export async function reverseNachzugAutoTakt(k:ReverseNachzugAutoKontext):Promise<Row>{
 const takt:Row={};
 try{takt.s1=await reverseS1NeuParsenTakt(k);}catch(e){takt.s1={fehler:String((e as Error)?.message??e).slice(0,200)};}
 if(schalterAn(k.ein,'auto_nachzug_debug'))console.error('[Reverse-Nachzug-Auto]',JSON.stringify(takt));
 return takt;
}
