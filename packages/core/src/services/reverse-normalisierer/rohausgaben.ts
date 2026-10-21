/** RV14: fixed-name, manifest-checked S1 sidecars from the SAME S3 runner job. */
import {constants,promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import type {ReverseEManifestEintrag} from '../reverse-e-uebernahme.js';
import {normalisiereRzBin} from './rz-bin.js';
import {normalisiereWasmObjdump} from './wasm-objdump.js';
import {normalisiereJavap} from './javap.js';
import {uebernehmeNormalisiert,type NormalBudget,type NormalErgebnis} from './s1.js';
type Db={query:Function};
export async function uebernehmeRohWerkzeuge(db:Db,e:{arbeit:string;manifest:ReverseEManifestEintrag[];reverseId:string;dateiId:string;pfad:string;fp2:string},b:NormalBudget){
 const namen=['s1-rz-strings.json','s1-rz-imports.json','s1-rz-symbols.json','s1-wasm.txt','s1-javap.txt','normalisierer-status.json'];
 const roh:Record<string,string>={},fehler:string[]=[],werkzeuge:string[]=[];
 let rawBytes=0;
 for(const name of namen){
  const m=e.manifest.find(x=>x.pfad===name);if(!m)continue;
  if(!Number.isSafeInteger(m.groesse)||m.groesse<0||rawBytes+m.groesse>b.maxBytes||!/^[0-9a-f]{64}$/.test(m.sha256)){fehler.push('rohausgabe_budget_oder_manifest');continue;}
  const h=await fs.open(path.join(e.arbeit,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   const st=await h.stat();
   if(!st.isFile()||st.nlink!==1||st.size!==m.groesse)throw new Error('rohausgabe_beschaedigt');
   const data=await h.readFile();
   if(createHash('sha256').update(data).digest('hex')!==m.sha256)throw new Error('rohausgabe_beschaedigt');
   rawBytes+=data.length;roh[name]=data.toString('utf8');
  }finally{await h.close();}
 }
 if(roh['normalisierer-status.json']!==undefined){
  try{if((JSON.parse(roh['normalisierer-status.json']) as {status?:unknown}).status!=='fertig')fehler.push('runner_normalisierung_teilweise');}
  catch{fehler.push('normalisierer_status_beschaedigt');}
 }
 const ergebnisse:NormalErgebnis[]=[];
 try{
  if(Object.keys(roh).some(n=>n.startsWith('s1-rz-'))){
   if(['strings','imports','symbols'].every(n=>roh['s1-rz-'+n+'.json']!==undefined)){
    ergebnisse.push(normalisiereRzBin({strings:roh['s1-rz-strings.json'],imports:roh['s1-rz-imports.json'],symbols:roh['s1-rz-symbols.json']},b));werkzeuge.push('rz-bin');
   }else fehler.push('rz_bin_unvollstaendig');
  }
  if(roh['s1-wasm.txt']!==undefined){ergebnisse.push(normalisiereWasmObjdump(roh['s1-wasm.txt'],b));werkzeuge.push('wasm-objdump');}
  if(roh['s1-javap.txt']!==undefined){ergebnisse.push(normalisiereJavap(roh['s1-javap.txt'],b));werkzeuge.push('javap');}
 }catch{fehler.push('rohausgabe_parse_fehler');}
 const s1=(await db.query("SELECT fingerabdruck FROM reverse_schichten WHERE datei_id=$1::bigint AND schicht='S1' AND aktuell AND status IN ('fertig','teilweise') LIMIT 1",[e.dateiId])).rows[0];
 let maskiert=0,bytes=0;
 for(const r of ergebnisse){
  maskiert+=r.maskiert;if(r.gekappt)fehler.push('normalisierung_gekappt');
  const n=Buffer.byteLength(JSON.stringify(r));if(bytes+n>b.maxBytes){fehler.push('normalisierung_budget');continue;}bytes+=n;
  for(const stage of ['S1','S2'] as const){
   const dateien=r.dateien.filter(d=>d.schicht===stage);
   if(!dateien.length)continue;
   if(stage==='S1'&&!s1){fehler.push('s1_fehlt');continue;}
   const fp=stage==='S1'?String(s1.fingerabdruck):e.fp2;
   if(werkzeuge.includes('rz-bin')&&stage==='S1')await db.query("DELETE FROM reverse_code_dateien WHERE eintrag_id=$1 AND datei_id=$2::bigint AND schicht='S1' AND (file_name LIKE 'strings%' OR file_name LIKE 'imports%' OR file_name='symbols.txt')",[e.reverseId,e.dateiId]);
   await uebernehmeNormalisiert(db,{reverseId:e.reverseId,dateiId:e.dateiId,pfad:e.pfad,fingerabdruck:fp},{...r,dateien});
   if(stage==='S1'&&r.dateiKandidaten.length){
    await db.query("DELETE FROM reverse_verweise WHERE datei_id=$1::bigint AND kind='string_datei'",[e.dateiId]);
    await db.query("INSERT INTO reverse_verweise(datei_id,eintrag_id,ordnung,kind,target,aufloesung) SELECT $1::bigint,$2,(SELECT COALESCE(max(ordnung),-1) FROM reverse_verweise WHERE datei_id=$1::bigint)+u.i,'string_datei',u.target,'unbekannt' FROM unnest($3::text[]) WITH ORDINALITY AS u(target,i)",
      [e.dateiId,e.reverseId,r.dateiKandidaten]);
   }
  }
 }
 return {status:fehler.length?'teilweise':'fertig',werkzeuge,fehler:[...new Set(fehler)],maskiert};
}
