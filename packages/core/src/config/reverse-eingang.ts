/** RV5/RV33: austauschbarer Startkatalog bis zur RV34-Parserregistry. */
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
 const number=(key:string,fallback:number)=>{const n=Number(env[key]??fallback);if(!Number.isSafeInteger(n)||n<1)throw new Error(key+': positive Ganzzahl erforderlich');return n;};
 const imageEndungen=(env.SYNAPSE_REVERSE_IMAGE_EXTENSIONS??'iso,img,bin,nrg,cdi,mdf').split(',').map(s=>s.trim());
 if(imageEndungen.some(s=>!/^[a-z0-9]+$/.test(s)))throw new Error('SYNAPSE_REVERSE_IMAGE_EXTENSIONS: ungültiger Katalog');
 const loeschVerhalten=(env.SYNAPSE_REVERSE_LOESCH_VERHALTEN??'behalten').trim() as ReverseLoeschVerhalten;
 if(loeschVerhalten!=='behalten'&&loeschVerhalten!=='mitloeschen')throw new Error('SYNAPSE_REVERSE_LOESCH_VERHALTEN: behalten oder mitloeschen erwartet');
 return {companions,imageEndungen,maxBatch:number('SYNAPSE_REVERSE_BATCH_MAX',10000),maxDescriptorBytes:number('SYNAPSE_REVERSE_DESCRIPTOR_MAX_BYTES',1024*1024),
  stabilMs:number('SYNAPSE_REVERSE_STABIL_MS',2000),loeschVerhalten};
}
