/**
 * P18-T49/RV34: Spurtabelle eines Disc-Images (CD/DVD), identisch zum Modell im Reverse-Runner
 * (docker/synapse-reverse/disc.py, SPURTABELLE_VERSION). Jeder Image-Parser liefert NUR diese Tabelle; der
 * gemeinsame Extraktor im Container macht daraus ISO je Session, WAV je Audiospur und Rohspuren (MODE2 Form2/formless).
 * Hier: Typen + dieselbe Pruefung (Spur ausserhalb der Datei, Ueberlappung, Sektorgroessen) fuer API und Tests.
 */
import {REVERSE_EINSTELLKATALOG} from './reverse-einstellkatalog.js';
export const REVERSE_SPURTABELLE_VERSION=1;
export const REVERSE_SPUR_MODI=['MODE0','AUDIO','MODE1','MODE2_FORM1','MODE2_FORM2','MODE2_FORMLESS','MODE2_MIXED'] as const;
export type ReverseSpurModus=typeof REVERSE_SPUR_MODI[number];
/** Erlaubte Sektorgroessen (Hauptdaten in der Datei) je Modus. */
export const REVERSE_SPUR_SEKTORGROESSEN:Readonly<Record<ReverseSpurModus,readonly number[]>>={
  MODE0:[2048,2336,2352],AUDIO:[2352],MODE1:[2048,2352],MODE2_FORM1:[2048,2336,2352],MODE2_FORM2:[2324,2336,2352],
  MODE2_FORMLESS:[2336,2352],MODE2_MIXED:[2336,2352],
};
export interface ReverseSubchannel {art:'getrennt'|'verschachtelt';groesse:16|96;datei:string|null;byte_offset:number|null}
/** Zusammenhaengender Bereich einer Spur: datei=null = Sektoren liegen nicht im Image (z. B. Pregap). */
export interface ReverseSpurAbschnitt {lba:number;sektoren:number;datei:string|null;byte_offset:number;sektorgroesse:number;subchannel:ReverseSubchannel|null}
export interface ReverseSpurIndex {nummer:number;lba:number}
export interface ReverseSpur {
  nummer:number;session:number;art:'daten'|'audio';mode:ReverseSpurModus;sektorgroesse:number;
  subchannel:ReverseSubchannel|null;datei:string|null;byte_offset:number|null;
  /** LBA von INDEX 01; laenge_sektoren ab dort bis Spurende (ohne Pregap der Folgespur). */
  start_lba:number;laenge_sektoren:number;pregap:number;pregap_in_datei:boolean;postgap:number;
  indizes:ReverseSpurIndex[];isrc:string|null;titel:string|null;audio_byte_reihenfolge:'le'|'be'|null;
  abschnitte:ReverseSpurAbschnitt[];
}
export interface ReverseSpurSession {nummer:number;lead_out_lba:number|null;spuren:ReverseSpur[]}
export interface ReverseSpurtabelle {
  version:typeof REVERSE_SPURTABELLE_VERSION;medium:'cd'|'dvd'|'bd'|'hd';format:string;katalognummer:string|null;
  lead_out_lba:number|null;layer_break:number|null;
  parser:{id:string;version:string;registry_version:string};
  herkunft?:{format:string;steuerdatei:string;dateien:string[]};
  sessions:ReverseSpurSession[];
}
export class ReverseSpurtabellenFehler extends Error {
  constructor(readonly code:'beschaedigt'|'nicht_unterstuetzt'|'nicht_gefunden',message:string){super(message);}
}
/** P18-T86: Sicherheitsfenster als Reverse-Einstellwerte (disc_*); Spur-/Sessionnummern 1..99 bleiben Formatgrenzen. */
export interface ReverseSpurGrenzen {sessions_max:number;abschnitte_max:number;lba_vorlauf_max:number;lba_max:number}
const K=REVERSE_EINSTELLKATALOG;
export const REVERSE_SPUR_STANDARD:ReverseSpurGrenzen={sessions_max:Number(K.disc_sessions_max.standard),abschnitte_max:Number(K.disc_abschnitte_max.standard),
  lba_vorlauf_max:Number(K.disc_lba_vorlauf_max.standard),lba_max:Number(K.disc_lba_max.standard)};
const fehler=(code:ReverseSpurtabellenFehler['code'],m:string):never=>{throw new ReverseSpurtabellenFehler(code,m);};
const ganz=(w:unknown,feld:string,lo:number,hi:number):number=>{
  if(typeof w!=='number'||!Number.isSafeInteger(w)||w<lo||w>hi)fehler('beschaedigt',`Spurtabelle: ${feld} ungueltig (${String(w)})`);
  return w as number;
};
/** Bytes je Sektor in der Datei: Hauptdaten + verschachtelter Subchannel. */
export function reverseSpurSchritt(a:Pick<ReverseSpurAbschnitt,'sektorgroesse'|'subchannel'>):number{
  return a.sektorgroesse+(a.subchannel?.art==='verschachtelt'?a.subchannel.groesse:0);
}
/** Gleiche Pruefung wie pruefe_spurtabelle im Runner. dateigroessen: Name im Medium -> Bytes. */
export function pruefeReverseSpurtabelle(t:ReverseSpurtabelle,dateigroessen:Record<string,number>,g:ReverseSpurGrenzen=REVERSE_SPUR_STANDARD):void{
  const LBA_MIN=-g.lba_vorlauf_max,LBA_MAX=g.lba_max;
  if(!t||t.version!==REVERSE_SPURTABELLE_VERSION)fehler('beschaedigt','Spurtabelle: unbekannte Version');
  if(!Array.isArray(t.sessions)||t.sessions.length<1||t.sessions.length>g.sessions_max)fehler('beschaedigt','Spurtabelle: keine oder zu viele Sessions');
  const nummern=new Set<number>();let vorherEnde:number|null=null,vorherSession=0;
  for(const s of t.sessions){
    const sn=ganz(s.nummer,'session.nummer',1,99);
    if(sn<=vorherSession)fehler('beschaedigt','Spurtabelle: Sessions nicht aufsteigend');
    vorherSession=sn;
    if(!Array.isArray(s.spuren)||!s.spuren.length)fehler('beschaedigt',`Spurtabelle: Session ${sn} ohne Spuren`);
    for(const sp of s.spuren){
      const nr=ganz(sp.nummer,'spur.nummer',1,99);
      if(nummern.has(nr))fehler('beschaedigt',`Spurtabelle: Spur ${nr} doppelt`);
      nummern.add(nr);
      if(sp.session!==sn)fehler('beschaedigt',`Spur ${nr}: falsche Session`);
      if(!(REVERSE_SPUR_MODI as readonly string[]).includes(sp.mode))fehler('nicht_unterstuetzt',`Spur ${nr}: Modus ${String(sp.mode)} unbekannt`);
      if(sp.art!==(sp.mode==='AUDIO'?'audio':'daten'))fehler('beschaedigt',`Spur ${nr}: Art passt nicht zum Modus ${sp.mode}`);
      if(!REVERSE_SPUR_SEKTORGROESSEN[sp.mode].includes(sp.sektorgroesse))fehler('nicht_unterstuetzt',`Spur ${nr}: Sektorgroesse ${sp.sektorgroesse} fuer ${sp.mode}`);
      const start=ganz(sp.start_lba,'start_lba',LBA_MIN,LBA_MAX),laenge=ganz(sp.laenge_sektoren,'laenge_sektoren',1,LBA_MAX);
      const pregap=ganz(sp.pregap??0,'pregap',0,LBA_MAX);ganz(sp.postgap??0,'postgap',0,LBA_MAX);
      const anfang=start-pregap;
      if(vorherEnde!==null&&anfang<vorherEnde)fehler('beschaedigt',`Spur ${nr} ueberlappt die vorherige Spur`);
      vorherEnde=start+laenge;
      if(!Array.isArray(sp.abschnitte)||sp.abschnitte.length<1||sp.abschnitte.length>g.abschnitte_max)fehler('beschaedigt',`Spur ${nr}: Abschnitte fehlen`);
      let cursor=anfang;
      for(const a of sp.abschnitte){
        const lba=ganz(a.lba,'abschnitt.lba',LBA_MIN,LBA_MAX),n=ganz(a.sektoren,'abschnitt.sektoren',1,LBA_MAX);
        if(lba!==cursor)fehler('beschaedigt',`Spur ${nr}: Abschnitte nicht lueckenlos`);
        cursor=lba+n;
        if(a.datei===null)continue;
        if(a.sektorgroesse!==sp.sektorgroesse)fehler('nicht_unterstuetzt',`Spur ${nr}: wechselnde Sektorgroesse`);
        if(!(a.datei in dateigroessen))fehler('nicht_gefunden',`Spur ${nr}: Bilddatei ${a.datei} fehlt im Medium`);
        const off=ganz(a.byte_offset,'byte_offset',0,Number.MAX_SAFE_INTEGER);
        const sub=a.subchannel;
        if(sub){
          if(!['getrennt','verschachtelt'].includes(sub.art)||![16,96].includes(sub.groesse))fehler('nicht_unterstuetzt',`Spur ${nr}: Subchannel-Format`);
          if(sub.art==='getrennt'){
            if(!sub.datei||!(sub.datei in dateigroessen))fehler('nicht_gefunden',`Spur ${nr}: Subchannel-Datei ${String(sub.datei)} fehlt`);
            const subOff=ganz(sub.byte_offset,'subchannel.byte_offset',0,Number.MAX_SAFE_INTEGER);
            if(subOff+n*sub.groesse>dateigroessen[sub.datei as string])fehler('beschaedigt',`Spur ${nr}: Subchannel ausserhalb der Datei ${sub.datei}`);
          }
        }
        if(off+n*reverseSpurSchritt(a)>dateigroessen[a.datei])fehler('beschaedigt',`Spur ${nr} liegt ausserhalb der Datei ${a.datei}`);
      }
      if(cursor!==start+laenge)fehler('beschaedigt',`Spur ${nr}: Abschnitte decken die Spur nicht ab`);
    }
    if(s.lead_out_lba!==null&&s.lead_out_lba!==undefined&&ganz(s.lead_out_lba,'session.lead_out_lba',LBA_MIN,LBA_MAX)<(vorherEnde??0))
      fehler('beschaedigt',`Session ${sn}: Lead-out vor dem Spurende`);
  }
  if(t.lead_out_lba!==null&&t.lead_out_lba!==undefined&&ganz(t.lead_out_lba,'lead_out_lba',LBA_MIN,LBA_MAX)<(vorherEnde??0))
    fehler('beschaedigt','Lead-out liegt vor dem Ende der letzten Spur');
}
