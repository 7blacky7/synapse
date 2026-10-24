/**
 * P18-T113: Belegung je Reverse-Eintrag (Summe reverse_dateien.groesse) aus dem laufenden Zaehler reverse_eintrag_belegung
 * statt Voll-Summe je Record/Block. Der Zaehler wird per Statement-Trigger in derselben TX gepflegt (147_reverse_belegung.sql),
 * ein Abbruch rollt Zeile und Zaehler gemeinsam zurueck.
 * Schalter Reverse-Einstellwert belegung_zaehler (global, Standard aus):
 *   aus   = bisherige Summe (unveraendert),
 *   an    = nur Zaehler lesen,
 *   debug = Zaehler + echte Summe, Abweichung ins Reverse-Fehlerlog und in reverseBelegungVerlauf(); gerechnet wird mit der echten Summe.
 * gleicheReverseBelegungAb() ist nachrangig und befristet: Zaehler und echte Summe aus EINEM Statement-Snapshot ohne FOR UPDATE,
 * Korrektur als kurze Delta-Buchung; Frist/Konkurrenz -> uebersprungen + Fehlerlog, blockiert nie einen Schreiber.
 */
import type {Pool} from 'pg';
import {reverseWert,reverseZahl,type ReverseEinstellSnapshot} from './reverse-einstellwerte.js';
import {loggeReverseFehler} from './reverse-fehlerlog.js';

type Db={query:Function};
export type ReverseBelegungModus='aus'|'an'|'debug';
export interface ReverseBelegungBefund {am:string;eintrag_id:string;quelle:string;art:'lesung'|'abgleich';zaehler:string|null;echt:string;abweichung:string;korrigiert:boolean;uebersprungen?:string}
const verlauf:ReverseBelegungBefund[]=[];
/** Debug: letzte Abweichungen dieses Prozesses (Laenge = diagnose_verlauf_speicher). */
export function reverseBelegungVerlauf():ReverseBelegungBefund[]{return verlauf.slice();}
export function reverseBelegungModus(s:ReverseEinstellSnapshot):ReverseBelegungModus{
 const w=reverseWert(s,'belegung_zaehler');return w==='an'||w==='debug'?w:'aus';
}
const ECHT_SQL='SELECT COALESCE(sum(groesse),0)::text AS bytes FROM reverse_dateien WHERE eintrag_id=$1';
function merke(b:ReverseBelegungBefund,s:ReverseEinstellSnapshot,db:Db){
 verlauf.push(b);const max=Math.max(1,reverseZahl(s,'diagnose_verlauf_speicher'));if(verlauf.length>max)verlauf.splice(0,verlauf.length-max);
 console.warn('[reverse-belegung] '+(b.uebersprungen?'Abgleich uebersprungen':'Abweichung'),JSON.stringify(b));
 void loggeReverseFehler({eintrag_id:b.eintrag_id,komponente:'entpacken',name:'belegung_zaehler',grund:b.uebersprungen?'belegung_abgleich_uebersprungen_'+b.uebersprungen.split(':')[0]:'belegung_abweichung_'+b.art,
  detail:`zaehler=${b.zaehler??'fehlt'} echt=${b.echt} abweichung=${b.abweichung}${b.korrigiert?' korrigiert':''}`,quelle:b.quelle},db);
}
/** Bytes aller reverse_dateien des Eintrags als Dezimaltext. Im Modus aus exakt die bisherige Summe. */
export async function leseReverseDateienBelegt(db:Db,eintragId:string,s:ReverseEinstellSnapshot,quelle:string):Promise<string>{
 const modus=reverseBelegungModus(s);
 if(modus==='aus')return String((await db.query(ECHT_SQL,[eintragId])).rows[0].bytes);
 const z=(await db.query('SELECT dateien_bytes::text AS bytes FROM reverse_eintrag_belegung WHERE eintrag_id=$1',[eintragId])).rows[0];
 // Fehlende Zeile = noch keine Datei seit Anlage des Zaehlers (Trigger legt sie bei der ersten an).
 const zaehler:string|null=z?String(z.bytes):null;
 if(modus==='an')return zaehler??'0';
 const echt=String((await db.query(ECHT_SQL,[eintragId])).rows[0].bytes);
 const diff=BigInt(echt)-BigInt(zaehler??'0');
 if(diff!==0n)merke({am:new Date().toISOString(),eintrag_id:eintragId,quelle,art:'lesung',zaehler,echt,abweichung:diff.toString(),korrigiert:false},s,db);
 return echt;
}
/** Abgleich in eigener, befristeter TX (lock_timeout/statement_timeout aus belegung_abgleich_*_ms):
 * - nur ein Abgleich je Eintrag gleichzeitig (pg_try_advisory_xact_lock, sonst uebersprungen),
 * - Zaehler und echte Summe aus EINEM Statement-Snapshot ohne FOR UPDATE: beide sehen genau die committeten Zeilen,
 *   offene TX zaehlen weder hier noch im Zaehler -> die Differenz ist exakt,
 * - Korrektur als Delta-Buchung (dateien_bytes+diff): spaeter committete Trigger-Deltas bleiben erhalten.
 * Frist ueberschritten/Konkurrenz -> uebersprungen + Fehlerlog. Im Modus aus nichts. Wirft nie; Aufrufer warten nicht. */
export async function gleicheReverseBelegungAb(pool:Pool,eintragId:string,s:ReverseEinstellSnapshot,quelle:string):Promise<ReverseBelegungBefund|null>{
 if(reverseBelegungModus(s)==='aus')return null;
 const basis={am:new Date().toISOString(),eintrag_id:eintragId,quelle,art:'abgleich' as const};
 let c;
 try{
  c=await pool.connect();
  await c.query('BEGIN');
  await c.query("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",
   [String(reverseZahl(s,'belegung_abgleich_lock_ms')),String(reverseZahl(s,'belegung_abgleich_timeout_ms'))]);
  if(!(await c.query("SELECT pg_try_advisory_xact_lock(hashtext('reverse_belegung:'||$1)) AS ok",[eintragId])).rows[0].ok){
   await c.query('ROLLBACK');
   const b:ReverseBelegungBefund={...basis,zaehler:null,echt:'0',abweichung:'0',korrigiert:false,uebersprungen:'abgleich_laeuft'};
   merke(b,s,pool);return b;
  }
  const r=(await c.query(`SELECT (SELECT dateien_bytes::text FROM reverse_eintrag_belegung WHERE eintrag_id=$1) AS zaehler,
   (SELECT COALESCE(sum(groesse),0)::text FROM reverse_dateien WHERE eintrag_id=$1) AS echt`,[eintragId])).rows[0];
  const zaehler:string|null=r.zaehler??null,echt=String(r.echt),diff=BigInt(echt)-BigInt(zaehler??'0');
  if(diff!==0n)await c.query(`INSERT INTO reverse_eintrag_belegung(eintrag_id,dateien_bytes,abgeglichen_at,letzte_abweichung) VALUES($1,$2::numeric,clock_timestamp(),$2::numeric)
   ON CONFLICT(eintrag_id) DO UPDATE SET dateien_bytes=reverse_eintrag_belegung.dateien_bytes+EXCLUDED.dateien_bytes,
    abgeglichen_at=clock_timestamp(),letzte_abweichung=EXCLUDED.letzte_abweichung,updated_at=clock_timestamp()`,[eintragId,diff.toString()]);
  await c.query('COMMIT');
  const b:ReverseBelegungBefund={...basis,zaehler,echt,abweichung:diff.toString(),korrigiert:diff!==0n};
  if(diff!==0n)merke(b,s,pool);
  return b;
 }catch(e){
  await c?.query('ROLLBACK').catch(()=>{});
  const code=String((e as {code?:string})?.code??'');
  const grund=code==='55P03'?'lock_timeout':code==='57014'?'statement_timeout':'fehler:'+(code||(e as Error)?.message||'unbekannt').slice(0,80);
  const b:ReverseBelegungBefund={...basis,zaehler:null,echt:'0',abweichung:'0',korrigiert:false,uebersprungen:grund};
  try{merke(b,s,pool);}catch(x){console.error('[reverse-belegung] Befund nicht meldbar',eintragId,(x as Error)?.message);}
  return b;
 }finally{c?.release();}
}
