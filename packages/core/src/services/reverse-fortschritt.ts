/**
 * P18-T85: Live-Fortschritt laufender Reverse-Container-Auftraege (E/S3).
 * Der Runner meldet gedrosselt {status:'fortschritt', phase, dateien_bisher, bytes_geschrieben, aktuelle_datei, gesamt, seit_s};
 * der Executor speichert das letzte Ereignis in work_jobs.fortschritt (nur unter eigener Lease) und reverse(status)/reverse(diagnose)
 * zeigen es je laufendem Auftrag. Kommt laenger als fortschritt_haenger_s nichts, steht dort ein Haenger-Hinweis; abgebrochen wird nie.
 * Produkt-Schalter reverse_fortschritt_live (global, Standard AUS bis Abnahme), intern-Schalter gleichen Namens befristet als Test-Override.
 * Takt, Schwelle und Dateianzeige sind Reverse-Einstellungen (fortschritt_takt_s, fortschritt_haenger_s, fortschritt_datei_zeichen);
 * ihre Bereiche prueft der Katalog, hier wird nichts nochmals gekappt (P18-T86).
 */
import type {Pool} from 'pg';
import {leseReverseEinstellwerte,leseReverseProduktSchalter,reverseZahl} from './reverse-einstellwerte.js';
import {REVERSE_EINSTELLKATALOG} from './reverse-einstellkatalog.js';
import {maskiereMitKatalog} from './masken-katalog.js';

/** P18-T88: inventarisieren/uebernahme/s1_materialisieren melden die fortsetzbaren Blockschritte. */
export const REVERSE_FORTSCHRITT_PHASEN=['start','iso_entpacken','verschachtelt','pe_ressourcen','siedler3','manifest','werkzeug','inventarisieren','uebernahme','s1_materialisieren'] as const;

export interface ReverseFortschrittStand {
 aktiv:boolean;quelle:'standard'|'produkt-schalter'|'intern';bis:string|null;letzter_fehler:string|null;takt_s:number;haenger_s:number;datei_zeichen:number;
}

export async function leseReverseFortschrittSchalter():Promise<ReverseFortschrittStand>{
 const stand=await leseReverseProduktSchalter('reverse_fortschritt_live',null);
 const s=await leseReverseEinstellwerte({});
 return {...stand,letzter_fehler:stand.letzter_fehler==='reverse_fortschritt_live_override_nicht_lesbar'?'reverse_fortschritt_override_nicht_lesbar':stand.letzter_fehler,
  takt_s:reverseZahl(s,'fortschritt_takt_s'),haenger_s:reverseZahl(s,'fortschritt_haenger_s'),datei_zeichen:reverseZahl(s,'fortschritt_datei_zeichen')};
}

const ganz=(v:unknown):number|null=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
const objekt=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);

/** Runner-Zeile -> gespeichertes Ereignis. Nur Zeilen mit phase (das alte Endereignis funktionen_fertig bleibt aussen vor).
 * dateiZeichen: wirksamer Wert aus leseReverseFortschrittSchalter (Standard nur der Katalogstandard). */
export function normalisiereReverseFortschritt(ev:Record<string,unknown>,dateiZeichen=Number(REVERSE_EINSTELLKATALOG.fortschritt_datei_zeichen.standard)):Record<string,unknown>|null{
 if(ev.status!=='fortschritt'||typeof ev.phase!=='string')return null;
 const phase=(REVERSE_FORTSCHRITT_PHASEN as readonly string[]).includes(ev.phase)?ev.phase:'unbekannt';
 const datei=typeof ev.aktuelle_datei==='string'&&ev.aktuelle_datei?maskiereMitKatalog(ev.aktuelle_datei.slice(-dateiZeichen),'reverse').text:null;
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
