/**
 * P18-T85: Live-Fortschritt laufender Reverse-Container-Auftraege (E/S3).
 * Der Runner meldet gedrosselt {status:'fortschritt', phase, dateien_bisher, bytes_geschrieben, aktuelle_datei, gesamt, seit_s};
 * der Executor speichert das letzte Ereignis in work_jobs.fortschritt (nur unter eigener Lease) und reverse(status)/reverse(diagnose)
 * zeigen es je laufendem Auftrag. Kommt laenger als fortschritt_haenger_s nichts, steht dort ein Haenger-Hinweis; abgebrochen wird nie.
 * Produkt-Schalter reverse_fortschritt_live (global, Standard AUS bis Abnahme), intern-Schalter gleichen Namens befristet als Test-Override.
 * Takt und Schwelle sind Reverse-Einstellungen (fortschritt_takt_s, fortschritt_haenger_s).
 */
import type {Pool} from 'pg';
import {getPool} from '../db/client.js';
import {leseProfilProduktSchalter} from './agent-profil-schalter.js';
import {internToolAktiv} from './intern-tool.js';
import {leseReverseEinstellungen} from './reverse-einstellungen.js';
import {maskiereMitKatalog} from './masken-katalog.js';

export const REVERSE_FORTSCHRITT_PHASEN=['start','iso_entpacken','verschachtelt','pe_ressourcen','siedler3','manifest','werkzeug'] as const;
/** Obergrenze des Runner-Takts (runner.py FORTSCHRITT_TAKT_MAX_S). */
const TAKT_MAX_S=600;
const DATEI_ZEICHEN=200;

export interface ReverseFortschrittStand {
 aktiv:boolean;quelle:'standard'|'produkt-schalter'|'intern';bis:string|null;letzter_fehler:string|null;takt_s:number;haenger_s:number;
}

export async function leseReverseFortschrittSchalter():Promise<ReverseFortschrittStand>{
 const produkt=await leseProfilProduktSchalter('reverse_fortschritt_live',null);
 let stand:Omit<ReverseFortschrittStand,'takt_s'|'haenger_s'>={aktiv:produkt.aktiv,quelle:produkt.quelle,bis:null,letzter_fehler:produkt.letzter_fehler};
 if(internToolAktiv()){
  try{
   const r=await getPool().query({text:"SELECT aktiv,bis FROM intern_schalter WHERE name='reverse_fortschritt_live' AND modus='freigegeben' AND bis>NOW()",query_timeout:2000} as import('pg').QueryConfig & {query_timeout:number});
   const z=r.rows[0];
   if(z)stand={aktiv:z.aktiv,quelle:'intern',bis:new Date(z.bis).toISOString(),letzter_fehler:null};
  }catch{stand.letzter_fehler='reverse_fortschritt_override_nicht_lesbar';}
 }
 const werte=(await leseReverseEinstellungen(null)).werte;
 return {...stand,takt_s:Math.min(werte.fortschritt_takt_s.wert,TAKT_MAX_S),haenger_s:werte.fortschritt_haenger_s.wert};
}

const ganz=(v:unknown):number|null=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
const objekt=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);

/** Runner-Zeile -> gespeichertes Ereignis. Nur Zeilen mit phase (das alte Endereignis funktionen_fertig bleibt aussen vor). */
export function normalisiereReverseFortschritt(ev:Record<string,unknown>):Record<string,unknown>|null{
 if(ev.status!=='fortschritt'||typeof ev.phase!=='string')return null;
 const phase=(REVERSE_FORTSCHRITT_PHASEN as readonly string[]).includes(ev.phase)?ev.phase:'unbekannt';
 const datei=typeof ev.aktuelle_datei==='string'&&ev.aktuelle_datei?maskiereMitKatalog(ev.aktuelle_datei.slice(-DATEI_ZEICHEN),'reverse').text:null;
 return {phase,dateien_bisher:ganz(ev.dateien_bisher),bytes_geschrieben:ganz(ev.bytes_geschrieben),aktuelle_datei:datei,gesamt:ganz(ev.gesamt),
  runner_seit_s:typeof ev.seit_s==='number'&&Number.isFinite(ev.seit_s)?Math.round(ev.seit_s):null};
}

/** Letztes Ereignis am Work-Job; Zeitstempel aus der DB-Uhr. Nur solange der Aufrufer die Lease haelt. */
export async function speichereReverseFortschritt(db:Pick<Pool,'query'>,jobId:string,claimToken:string,fortschritt:Record<string,unknown>,versuch:number):Promise<boolean>{
 const r=await db.query("UPDATE work_jobs SET fortschritt=$3::jsonb||jsonb_build_object('empfangen_at',clock_timestamp(),'versuch',$4::int) WHERE id=$1 AND claim_token=$2 AND state='leased'",
  [jobId,claimToken,JSON.stringify(fortschritt),versuch]);
 return (r.rowCount??0)>0;
}

/** Spalten fuer reverseFortschrittAnzeige; erwartet work_jobs als Alias w. Tolerant, falls die Spalte (noch) fehlt. */
export const REVERSE_FORTSCHRITT_SQL="EXTRACT(EPOCH FROM clock_timestamp()-w.claimed_at)::int AS laufzeit_s,to_jsonb(w)->'fortschritt' AS fortschritt,"
 +"EXTRACT(EPOCH FROM clock_timestamp()-(to_jsonb(w)->'fortschritt'->>'empfangen_at')::timestamptz)::int AS meldung_vor_s";

/** Anzeige je laufendem (geleastem) Work-Job; null fuer alles andere. Nur Hinweis, nie Abbruch. */
export function reverseFortschrittAnzeige(w:Record<string,unknown>,haengerS:number):Record<string,unknown>|null{
 if(w.state!=='leased')return null;
 const f=objekt(w.fortschritt)&&(w.attempt===undefined||Number(w.fortschritt.versuch)===Number(w.attempt))?w.fortschritt:null;
 const laufzeit=ganz(w.laufzeit_s),vor=f?ganz(w.meldung_vor_s):null;
 const lease=w.lease_until instanceof Date?w.lease_until.toISOString():w.lease_until==null?null:String(w.lease_until);
 const still=vor!==null?vor>haengerS:laufzeit!==null&&laufzeit>haengerS;
 return {phase:f?.phase??null,dateien_bisher:f?.dateien_bisher??null,bytes:f?.bytes_geschrieben??null,aktuelle_datei:f?.aktuelle_datei??null,
  gesamt:f?.gesamt??null,letzte_meldung_vor_s:vor,laufzeit_s:laufzeit,lease_bis:lease,
  ...(still?{haenger_verdacht:true,hinweis:vor!==null
   ?`Verdacht auf Haenger: seit ${vor} s keine Fortschrittsmeldung (Schwelle ${haengerS} s). Es wird nichts automatisch abgebrochen; reverse(diagnose) pruefen, ggf. reverse(entstoeren).`
   :`Verdacht auf Haenger: seit Start (${laufzeit} s) keine Fortschrittsmeldung (Schwelle ${haengerS} s), oder das Reverse-Image kennt den Live-Fortschritt noch nicht. Es wird nichts automatisch abgebrochen.`}:{})};
}
