/** RV5/RV33: austauschbarer Startkatalog bis zur RV34-Parserregistry. */
import {REVERSE_EINSTELLKATALOG} from '../services/reverse-einstellkatalog.js';
export interface ReverseCompanionRegel {
 format:string; endungen:string[]; referenzen?:'cue';
 pflicht:string[]; optional:string[];
}
/** RV6: was mit dem Bibliotheksoriginal geschieht, wenn der PC eine Datei lokal löscht (dokumentierter Standard: behalten). */
export type ReverseLoeschVerhalten='behalten'|'mitloeschen';
export interface ReverseEingangKonfiguration {
 companions:ReverseCompanionRegel[]; imageEndungen:string[]; maxBatch:number; maxDescriptorBytes:number;
 /** RV6: Größe/mtime müssen so lange unverändert sein, bevor der Daemon hasht. */
 stabilMs:number; loeschVerhalten:ReverseLoeschVerhalten;
}
/** P18-T86: Batch, Descriptor, Stabilität und Löschverhalten sind Reverse-Einstellwerte (reverse_einstellungen);
 * hier stehen nur deren Katalogstandards, ReverseEingang trägt die wirksamen Werte je Aufruf ein.
 * Companion- und Image-Katalog bleiben vorerst Startkatalog. */
export function ladeReverseEingangKonfiguration(env:NodeJS.ProcessEnv=process.env):ReverseEingangKonfiguration {
 const defaults:ReverseCompanionRegel[]=[
  {format:'cue',endungen:['cue'],referenzen:'cue',pflicht:[],optional:[]},
  {format:'ccd',endungen:['ccd'],pflicht:['img'],optional:['sub']},
  {format:'mds',endungen:['mds'],pflicht:['mdf'],optional:['md0','md1']},
  {format:'toc',endungen:['toc'],referenzen:'cue',pflicht:[],optional:[]},
  {format:'b5t',endungen:['b5t'],pflicht:['b5i'],optional:[]},
  {format:'b6t',endungen:['b6t'],pflicht:['b6i'],optional:[]},
 ];
 const companions=env.SYNAPSE_REVERSE_COMPANIONS===undefined?defaults:JSON.parse(env.SYNAPSE_REVERSE_COMPANIONS) as ReverseCompanionRegel[];
 if(!Array.isArray(companions)||companions.some(r=>!r||typeof r.format!=='string'||![r.endungen,r.pflicht,r.optional].every(a=>Array.isArray(a)&&a.every(s=>typeof s==='string'&&/^[a-z0-9]+$/.test(s)))||r.referenzen!==undefined&&r.referenzen!=='cue'))throw new Error('SYNAPSE_REVERSE_COMPANIONS: ungültiger Katalog');
 const imageEndungen=(env.SYNAPSE_REVERSE_IMAGE_EXTENSIONS??'iso,img,bin,nrg,cdi,mdf').split(',').map(s=>s.trim());
 if(imageEndungen.some(s=>!/^[a-z0-9]+$/.test(s)))throw new Error('SYNAPSE_REVERSE_IMAGE_EXTENSIONS: ungültiger Katalog');
 const k=REVERSE_EINSTELLKATALOG;
 return {companions,imageEndungen,maxBatch:Number(k.eingang_block_dateien.standard),maxDescriptorBytes:Number(k.descriptor_bytes.standard),
  stabilMs:Number(k.eingang_stabil_ms.standard),loeschVerhalten:k.eingang_loeschverhalten.standard as ReverseLoeschVerhalten};
}
