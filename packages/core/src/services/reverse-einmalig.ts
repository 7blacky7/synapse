/**
 * P22-T245 Nacharbeit (User 31.10.2026, memory regel-reverse-assets-einmalig-gedrosselt-nie-blockierend; Entwurf thought ac8a8b97,
 * Entscheidungen #t128-team 34651). Gemeinsamer Kern fuer alle Reverse-Lesewege im API-Prozess:
 *  - reverseEinmaligSchicht: reine Entscheidung "was laeuft als Naechstes" (naechste() der Pipeline UND die Vorschau nutzen sie,
 *    damit die Vorschau wirklich misst, was bei pipeline_einmalig an laufen wuerde).
 *  - reverseNeuerInspektor/reverseFormatNeuAbgedeckt: Format-Nachzug nur fuer bisher unerkannte, jetzt abgedeckte Formate.
 *  - Drossel und Betriebsvorrang je Kanal (pipeline | e | leser): Pause bzw. MB/s-Budget nach jedem Auftrag, Last1/CPU und
 *    Event-Loop-p99 ueber dem Grenzwert = ruhen. Wirksam nur bei pipeline_einmalig an; Einstellungen nicht lesbar = ruhen
 *    (fail-closed, Koordinator 34623 (3)). Nur Funktionen und Prozessstand, kein Schema, kein Tool.
 */
import {cpus,loadavg} from 'node:os';
import {createHash} from 'node:crypto';
import {monitorEventLoopDelay,type IntervalHistogram} from 'node:perf_hooks';
import {standardRegistry} from '../asset-intel/index.js';
import {reverseWert,reverseZahl,type ReverseEinstellSnapshot} from './reverse-einstellwerte.js';

export type ReverseDrosselKanal='pipeline'|'e'|'leser';
const KANAELE:ReverseDrosselKanal[]=['pipeline','e','leser'];
const OK=['fertig','teilweise'];
const STUFEN=['E','S0','S1','S2','S3'];

/** Debugstand dieses API-Prozesses (reverse(diagnose) Feld einmalig.drossel). Felder der Pipeline wie bisher, dazu je Kanal. */
export const reverseDrosselStand={
 schalter:'aus' as 'aus'|'an', werte:{} as Record<string,unknown>, stand:null as {werkzeug:string;profil_s0:string;profil_s1:string}|null,
 auftraege:0, bytes:0, pause_ms_summe:0, pausen_betrieb:0, nachzug_erkannt:0,
 letzter_grund:null as string|null, letzte_pause_am:null as string|null, letzte_messung:null as Record<string,unknown>|null,
 /** P22-T245 Abnahme B-2 (f91640e2): Leerlauf-Abkuerzung von entdecke() - uebersprungene Scans, echte Scans, Zeitpunkt und Stand des
  * letzten leeren Scans. */
 entdecke:{uebersprungen:0,vollscans:0,leer_seit:null as string|null,letzter_stand:null as string|null},
 /** P22-T245 Abnahme B-3 (2): zuletzt ermitteltes IO-Limit des Reverse-Containers (rest-api reverse-container-io.ts), sonst null. */
 container_io:null as Record<string,unknown>|null,
 kanaele:Object.fromEntries(KANAELE.map(k=>[k,{auftraege:0,bytes:0,pause_ms_summe:0,ruhen:0,letzter_grund:null as string|null,naechster_start:null as string|null}])) as
  Record<ReverseDrosselKanal,{auftraege:number;bytes:number;pause_ms_summe:number;ruhen:number;letzter_grund:string|null;naechster_start:string|null}>,
};

/** Wartezeit nach einem Auftrag = max(Pause, Lesebytes/Budget - Auftragsdauer). Rein. */
export function reverseDrosselWarteMs(pauseMs:number,mbS:number,bytes:number,dauerMs:number):number{
 const budget=mbS>0?Math.ceil(bytes*1000/(mbS*1_000_000))-dauerMs:0;
 return Math.max(0,pauseMs,budget);
}

/** Grund der Belastung aus Messwerten (Load1 je CPU x1000, Latenz-p99 ms) oder null. Nicht lesbar (NaN) = belastet. Rein. */
export function reverseBelastungsGrund(last:number,latenzMs:number,grenzen:{lastMilli:number;latenzMs:number}):string|null{
 if(!Number.isFinite(last)||!Number.isFinite(latenzMs))return 'last_nicht_lesbar';
 if(grenzen.lastMilli>0&&last>grenzen.lastMilli)return 'last';
 if(grenzen.latenzMs>0&&latenzMs>grenzen.latenzMs)return 'latenz';
 return null;
}

/** P22-T245 Abnahme B-4 (f91640e2): ein Event-Loop-Histogramm JE KANAL. Vorher teilten E- und Leser-Executor eines, und jede Messung
 * setzte das Fenster des anderen Kanals zurueck. Alle Kanaele starten beim ersten Aufruf gemeinsam; jede Messung sieht das Fenster
 * seit der letzten Messung DIESES Kanals (die Pipeline misst weiter mit eigenem Histogramm, gleiche Auswertung). */
const latenzen:Partial<Record<ReverseDrosselKanal,IntervalHistogram>>={};
export function reverseBelastungMessen(kanal:ReverseDrosselKanal='e'):{last:number;latenz_ms:number}{
 try{
  if(!latenzen[kanal])for(const k of KANAELE)if(!latenzen[k]){const h=monitorEventLoopDelay({resolution:20});h.enable();latenzen[k]=h;}
  const latenz=latenzen[kanal]!;
  const last=Math.round(loadavg()[0]/Math.max(1,cpus().length)*1000);
  const l=latenz.count>0?Math.round(latenz.percentile(99)/1e6):0;latenz.reset();
  return {last,latenz_ms:l};
 }catch{return {last:NaN,latenz_ms:NaN};}
}

const naechsterStart:Partial<Record<ReverseDrosselKanal,number>>={};
const zahl=(s:ReverseEinstellSnapshot,n:Parameters<typeof reverseZahl>[1])=>reverseZahl(s,n);

/**
 * Tor vor jedem Claim eines Reverse-Lesewegs. frei=false heisst: in diesem Takt nichts claimen.
 * Einstellungen nicht lesbar -> ruhen (auch bei Schalter aus). Schalter aus -> frei (Altverhalten). Schalter an -> Betriebsvorrang
 * (Last/Latenz) und Drossel (naechster erlaubter Start je Kanal).
 */
export function reverseDrosselTor(kanal:ReverseDrosselKanal,s:ReverseEinstellSnapshot|null|undefined,
 o:{jetzt?:number;messung?:{last:number;latenz_ms:number}}={}):{frei:boolean;grund?:string;warte_ms?:number}{
 const k=reverseDrosselStand.kanaele[kanal],jetzt=o.jetzt??Date.now();
 const ruhe=(grund:string,warte?:number)=>{k.ruhen++;k.letzter_grund=grund;return {frei:false,grund,...(warte!==undefined?{warte_ms:warte}:{})};};
 if(!s||s.letzter_fehler)return ruhe('einstellungen_nicht_lesbar');
 if(reverseWert(s,'pipeline_einmalig')!=='an')return {frei:true};
 const m=o.messung??reverseBelastungMessen(kanal);
 const grund=reverseBelastungsGrund(m.last,m.latenz_ms,{lastMilli:zahl(s,'pipeline_last_max_milli'),latenzMs:zahl(s,'pipeline_latenz_max_ms')});
 if(grund)return ruhe(grund);
 const ab=naechsterStart[kanal]??0;
 if(ab>jetzt)return ruhe('drossel',ab-jetzt);
 return {frei:true};
}

/** Nach einem Auftrag buchen: setzt den naechsten erlaubten Start des Kanals. Liefert die Wartezeit (0 bei Schalter aus). */
export function reverseDrosselBuche(kanal:ReverseDrosselKanal,s:ReverseEinstellSnapshot|null|undefined,bytes:number,dauerMs:number,jetzt=Date.now()):number{
 if(!s||s.letzter_fehler||reverseWert(s,'pipeline_einmalig')!=='an')return 0;
 const warte=reverseDrosselWarteMs(zahl(s,'pipeline_pause_ms'),zahl(s,'pipeline_lese_mb_s'),Math.max(0,bytes||0),Math.max(0,dauerMs||0));
 naechsterStart[kanal]=jetzt+warte;
 const k=reverseDrosselStand.kanaele[kanal];
 k.auftraege++;k.bytes+=Math.max(0,bytes||0);k.pause_ms_summe+=warte;k.naechster_start=new Date(jetzt+warte).toISOString();
 return warte;
}
/** Nur fuer Tests: Drosselstand der Kanaele zuruecksetzen. */
export function vergissReverseDrossel():void{for(const k of KANAELE)delete naechsterStart[k];}

/** Inspektor, der eine bisher UNERKANNTE Datei (format NULL/unbekannt) jetzt ueber Endung bzw. gespeicherte Magic abdeckt;
 * generic-binary zaehlt nicht. null = kein Nachzug. Rein. */
export function reverseNeuerInspektor(d:{pfad?:unknown;format?:unknown;magic?:unknown}|undefined):string|null{
 if(!d||(d.format!=null&&d.format!=='unbekannt'))return null;
 const hex=typeof d.magic==='string'&&/^([0-9a-f]{2})*$/i.test(d.magic)?d.magic:'';
 const det=standardRegistry.detect(String(d.pfad??''),Buffer.from(hex,'hex'));
 return det.inspector&&det.inspector.id!=='generic-binary'?det.inspector.id:null;
}
export function reverseFormatNeuAbgedeckt(d:{pfad?:unknown;format?:unknown;magic?:unknown}|undefined):boolean{return reverseNeuerInspektor(d)!==null;}
/** P22-T245 Abnahme B-1: Werkzeugstand der S0/S1-Inspektion (Registry), dieselbe Formel wie ReversePipelineDienst.version. Der S1-Nachzug
 * (reverse-nachzug-auto.ts) markiert damit bei einmalig gepruefte, nicht neu abgedeckte Dateien je Registry-Stand genau einmal. */
export function reverseInspektorStand():string{return createHash('sha256').update(JSON.stringify(standardRegistry.list().map(i=>[i.id,i.version]).sort())).digest('hex');}

export interface ReverseSchichtZeile {schicht:string;status:unknown;werkzeug_version:unknown;profil_version:unknown}
/** Warum eine Schicht laeuft: neu (keine Schicht), wiederholung (Schicht nicht fertig), format_nachzug, s1_nach_s0, alt (nur bei aus). */
export type ReverseEinmaligGrund='neu'|'wiederholung'|'format_nachzug'|'s1_nach_s0'|'alt';

/**
 * Reine Entscheidung fuer eine Datei (naechste() der Pipeline und reverseEinmaligVorschau):
 *  - einmalig aus: wie vor T245 - die erste nicht aktuelle Schicht bis zum Ziel laeuft (grund alt/neu/wiederholung).
 *  - einmalig an: eine fertige/teilweise Schicht bleibt, auch bei anderem Werkzeug- oder Profilstand. Ausnahmen:
 *    S0 nur bei bisher unerkanntem, jetzt abgedecktem Format (format_nachzug); S1 nur, wenn S0 aktuell ist UND S1 mit einem anderen
 *    Inspektor-Werkzeugstand entstand als der aktuelle (S0 wurde also neu inspiziert). Ein reiner Profil- bzw. Parser-Versionswechsel
 *    loest damit keinen Massen-Neuparse aus (Entscheidung 34651 B1 (ii)).
 */
export async function reverseEinmaligSchicht(o:{schichten:ReverseSchichtZeile[];ziel:string;einmalig:boolean;werkzeug:string;
 aktuell:(stufe:string,zeile:ReverseSchichtZeile|undefined)=>boolean;formatNeu:()=>boolean|Promise<boolean>;grund?:{wert?:ReverseEinmaligGrund}}):Promise<string|null>{
 const setze=(g:ReverseEinmaligGrund)=>{if(o.grund)o.grund.wert=g;};
 for(const stufe of STUFEN.slice(1)){
  if(STUFEN.indexOf(stufe)>STUFEN.indexOf(o.ziel))return null;
  const zeile=o.schichten.find(x=>x.schicht===stufe);
  if(o.aktuell(stufe,zeile))continue;
  if(!zeile){setze('neu');return stufe;}
  if(!OK.includes(String(zeile.status))){setze('wiederholung');return stufe;}
  if(!o.einmalig){setze('alt');return stufe;}
  if(stufe==='S0'&&await o.formatNeu()){setze('format_nachzug');return stufe;}
  if(stufe==='S1'&&o.aktuell('S0',o.schichten.find(x=>x.schicht==='S0'))&&zeile.werkzeug_version!==o.werkzeug){setze('s1_nach_s0');return stufe;}
 }
 return null;
}
