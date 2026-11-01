/**
 * P22-T245 Abnahme claude-birke f91640e2, B-3 (Koordinator-Entscheidung nach memory regel-reverse-assets-einmalig-gedrosselt-nie-blockierend:
 * feste Drossel inkl. Lese-MB/s, Vorrang des Betriebs).
 *  (1) reverseAuftragBytes: bekannte Menge eines Reverse-Auftrags fuer die MB/s-Buchung (core reverseDrosselBuche), damit
 *      pipeline_lese_mb_s im Mittel auch fuer E- und Leser-Executor greift (vorher wurde 0 gebucht).
 *  (2) reverseIoGrenzen: IO-Limit fuer Lesen UND Schreiben der Reverse-Container (reverse-e, reverse-leser) ueber Docker
 *      BlkioDeviceReadBps/BlkioDeviceWriteBps. Es begrenzt die Spitzenrate innerhalb eines Laufs, die das Tor vor dem Claim nicht sieht.
 *      - Werte: reverse_einstellungen container_io_lese_mb_s / container_io_schreib_mb_s (Code-Standard im Katalog
 *        reverse-einstellkatalog.ts, 0 = kein Limit), keine Konstante hier.
 *      - Wirksam nur bei pipeline_einmalig an (wie Tor und Buchung); bei aus Verhalten vor T245, also kein Limit.
 *      - Geraete: die Blockgeraete hinter den Mount-Quellen (stat().dev -> /sys/dev/block/<major>:<minor>; Partition -> ganzes Geraet,
 *        denn cgroup io.max nimmt nur ganze Geraete). Ohne Blockgeraet (FUSE/shfs, overlay, tmpfs: major 0 bzw. kein sysfs-Eintrag)
 *        wird die Quelle ausgelassen und im Stand genannt.
 *      - Nie blockierend: jede Stoerung bei der Ermittlung ergibt "kein Limit" mit Grund. Scheitert ein Start mit IO-Limit an einem
 *        Geraetefehler, setzt reverseIoStartFehler das Limit bis zur naechsten Einstellungsrevision aus.
 *      - Wirkt ab dem naechsten Containerstart (Docker uebernimmt die Werte beim Anlegen des Containers).
 *  Debug: reverseDrosselStand.container_io (core reverse-einmalig.ts), sichtbar in reverse(diagnose) Feld einmalig.drossel.
 */
import {stat,readFile,realpath,access} from 'node:fs/promises';
import path from 'node:path';
import type {Pool} from 'pg';
import {leseReverseEinstellwerte,reverseZahl,reverseWert,reverseDrosselStand,type ReverseEinstellSnapshot} from '@synapse/core';
import type {ResolvedToolMount} from './tool-container-docker.js';

export interface ReverseIoGrenzen {BlkioDeviceReadBps?:Array<{Path:string;Rate:number}>;BlkioDeviceWriteBps?:Array<{Path:string;Rate:number}>}

/** Drossel (Buchung, IO-Limit) wirksam: Einstellungen lesbar und pipeline_einmalig an. */
export function reverseDrosselAktiv(s:ReverseEinstellSnapshot|null|undefined):boolean{
 return !!s&&!s.letzter_fehler&&reverseWert(s,'pipeline_einmalig')==='an';
}

/**
 * B-3 (1): Bytes eines beendeten Auftrags. E (reverse-E, inputRef.revision = Medium): Quellgroesse des Mediums (reverse_medien_dateien,
 * sonst reverse_medien.groesse) plus die entpackten Dateien des Mediums (geschriebene Menge). Andere Container-Kinds (S1/S3,
 * revision = Datei): Dateigroesse. Leser: Groesse der Datei des Leser-Laufs. Unbekannt oder Fehler = 0 (dann gilt nur pipeline_pause_ms).
 */
export async function reverseAuftragBytes(db:Pick<Pool,'query'>,art:'e'|'leser',job:{id:string;kind?:string;inputRef?:{revision?:string|null}|null}):Promise<number>{
 try{
  const zahl=(r:{rows:Array<{n?:unknown}>})=>{const n=Number(r.rows[0]?.n??0);return Number.isFinite(n)&&n>0?n:0;};
  if(art==='leser')return zahl(await db.query('SELECT COALESCE(sum(d.groesse),0)::text AS n FROM reverse_leser_laeufe l JOIN reverse_dateien d ON d.id=l.datei_id WHERE l.work_job_id::text=$1',[job.id]));
  const rev=String(job.inputRef?.revision??'');if(!/^[0-9]{1,18}$/.test(rev))return 0;
  if(job.kind==='reverse-E')return zahl(await db.query(`SELECT (COALESCE((SELECT sum(groesse) FROM reverse_medien_dateien WHERE medium_id=$1::bigint),
    (SELECT groesse FROM reverse_medien WHERE id=$1::bigint),0)+COALESCE((SELECT sum(groesse) FROM reverse_dateien WHERE medium_id=$1::bigint),0))::text AS n`,[rev]));
  return zahl(await db.query('SELECT groesse::text AS n FROM reverse_dateien WHERE id=$1::bigint',[rev]));
 }catch{return 0;}
}

/** Linux dev_t -> major/minor (glibc gnu_dev_major/minor). */
export function reverseDevNummer(dev:bigint):{major:number;minor:number}{
 return {major:Number(((dev>>8n)&0xfffn)|((dev>>32n)&~0xfffn)),minor:Number((dev&0xffn)|((dev>>12n)&~0xffn))};
}

/** Ganzes Blockgeraet hinter einem Pfad als /dev/<name>, sonst null mit Grund. sys = Wurzel von /sys/dev/block (nur Tests ersetzen sie). */
export async function reverseIoGeraet(pfad:string,o:{sys?:string;dev?:(pfad:string)=>Promise<bigint>}={}):Promise<{geraet:string|null;grund?:string;nummer?:string}>{
 const sys=o.sys??'/sys/dev/block';
 let nummer:string;
 try{
  const {major,minor}=reverseDevNummer(await (o.dev??(async(p:string)=>(await stat(p,{bigint:true})).dev))(pfad));nummer=major+':'+minor;
  if(major===0)return {geraet:null,grund:'kein_blockgeraet',nummer};
 }catch(e){return {geraet:null,grund:'stat_fehler:'+String((e as {code?:string})?.code??'unbekannt')};}
 try{
  const eintrag=await realpath(path.join(sys,nummer));
  // Partition: das ganze Geraet ist das Verzeichnis darueber (sysfs /sys/devices/.../sda/sda1).
  const ziel=await access(path.join(eintrag,'partition')).then(()=>path.dirname(eintrag),()=>eintrag);
  const name=(await readFile(path.join(ziel,'uevent'),'utf8')).match(/^DEVNAME=(.+)$/m)?.[1]?.trim();
  if(!name||!/^[A-Za-z0-9._/-]+$/.test(name)||name.split('/').includes('..'))return {geraet:null,grund:'devname_fehlt',nummer};
  return {geraet:'/dev/'+name,nummer};
 }catch{return {geraet:null,grund:'kein_blockgeraet',nummer};}
}

let ausgesetzt:{revision:unknown;grund:string}|null=null;
let letzteRevision:unknown=undefined;

/** B-3 (2): IO-Limit fuer einen Reverse-Containerstart oder null (kein Limit). Wirft nie; Stand in reverseDrosselStand.container_io. */
export async function reverseIoGrenzen(mounts:Array<Pick<ResolvedToolMount,'role'|'source'>>,o:{einstellungen?:ReverseEinstellSnapshot;sys?:string;dev?:(pfad:string)=>Promise<bigint>}={}):Promise<ReverseIoGrenzen|null>{
 const stand:Record<string,unknown>={wirksam:false,am:new Date().toISOString()};
 try{
  const s=o.einstellungen??await leseReverseEinstellwerte({});
  if(s.letzter_fehler){stand.grund='einstellungen_nicht_lesbar';return null;}
  if(!reverseDrosselAktiv(s)){stand.grund='pipeline_einmalig_aus';return null;}
  if(ausgesetzt&&ausgesetzt.revision===s.revision){stand.grund='ausgesetzt_nach_startfehler';stand.startfehler=ausgesetzt.grund;return null;}
  ausgesetzt=null;
  const lese=reverseZahl(s,'container_io_lese_mb_s'),schreib=reverseZahl(s,'container_io_schreib_mb_s');
  Object.assign(stand,{lese_mb_s:lese,schreib_mb_s:schreib});
  if(lese<=0&&schreib<=0){stand.grund='kein_limit_eingestellt';return null;}
  const geraete:string[]=[],ausgelassen:Array<Record<string,unknown>>=[];
  for(const m of mounts){
   const g=await reverseIoGeraet(m.source,{sys:o.sys,dev:o.dev});
   if(g.geraet){if(!geraete.includes(g.geraet))geraete.push(g.geraet);}else ausgelassen.push({rolle:m.role,grund:g.grund,nummer:g.nummer??null});
  }
  Object.assign(stand,{geraete,ausgelassen});
  if(!geraete.length){stand.grund='kein_blockgeraet';return null;}
  const r:ReverseIoGrenzen={};
  if(lese>0)r.BlkioDeviceReadBps=geraete.map(Path=>({Path,Rate:lese*1_000_000}));
  if(schreib>0)r.BlkioDeviceWriteBps=geraete.map(Path=>({Path,Rate:schreib*1_000_000}));
  letzteRevision=s.revision;stand.wirksam=true;stand.revision=s.revision??null;
  return r;
 }catch(e){stand.grund='fehler:'+String((e as Error)?.message??e).slice(0,200);return null;}
 finally{reverseDrosselStand.container_io=stand;}
}

/** Start mit IO-Limit gescheitert: bei einem Geraete-/Drosselfehler das Limit bis zur naechsten Einstellungsrevision aussetzen. */
export function reverseIoStartFehler(e:unknown):void{
 const text=String((e as {json?:{message?:string}})?.json?.message??(e as Error)?.message??e);
 if(!/blkio|io\.max|throttle|device/i.test(text))return;
 ausgesetzt={revision:letzteRevision,grund:text.slice(0,300)};
 reverseDrosselStand.container_io={...(reverseDrosselStand.container_io??{}),wirksam:false,grund:'ausgesetzt_nach_startfehler',startfehler:ausgesetzt.grund};
 console.warn('[reverse-container-io] IO-Limit nach Startfehler ausgesetzt (bis zur naechsten Einstellungsrevision):',ausgesetzt.grund);
}
/** Nur fuer Tests: Aussetzung zuruecksetzen. */
export function vergissReverseIoAussetzung():void{ausgesetzt=null;letzteRevision=undefined;}
