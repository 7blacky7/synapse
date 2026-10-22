/** P18-T102: Inhaltsvertrag für den RO-Leser-Runtimesnapshot. Keine Ausführung. */
import {reverseLeserHash,reverseLeserKanonisch,ReverseLeserFehler} from './reverse-leser-vertrag.js';
import {reverseBigInt,reverseZahl,type ReverseEinstellSnapshot} from './reverse-einstellwerte.js';
export const LESER_RUNTIME_VERTRAG='leser-python3-v1' as const;
export const LESER_RUNTIME_DATEIEN=['checkpoint.py','leser.py','runner.py'] as const;
export interface LeserRuntimeImage {image:string;digest:string}
export interface LeserRuntimeBeleg {pfad:string;sha256:string;bytes:string}
export interface LeserRuntimeIndex {dateien:LeserRuntimeBeleg[]}
export interface LeserRuntimeQuelle {project:string;dateien:Array<{pfad:string;version_id:string}>}
export interface LeserRuntimePin {runtime_sha256:string;runtime_image_digest:string}
export function runtimeFail(code:string):never {throw new ReverseLeserFehler(code);}
const objekt=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
export function pruefeLeserRuntimeImage(x:LeserRuntimeImage|undefined):LeserRuntimeImage {
 if(!x||typeof x.image!=='string'||!x.image||!/^sha256:[a-f0-9]{64}$/.test(x.digest))runtimeFail('leser_runtime_image_fehlt');
 return {image:x.image,digest:x.digest};
}
export function pruefeLeserRuntimePin(x:unknown):string{
 if(typeof x!=='string'||!(/^[a-f0-9]{64}$/).test(x))runtimeFail('leser_runtime_pin_ungueltig');return x;
}
export function pruefeLeserRuntimeIndex(x:unknown,s:ReverseEinstellSnapshot):LeserRuntimeIndex{
 if(!objekt(x)||Object.keys(x).join()!=='dateien'||!Array.isArray(x.dateien)||x.dateien.length!==LESER_RUNTIME_DATEIEN.length)runtimeFail('leser_runtime_index_ungueltig');
 const dateien:LeserRuntimeBeleg[]=x.dateien.map((b:unknown,i:number)=>{
  if(!objekt(b)||Object.keys(b).sort().join()!=='bytes,pfad,sha256'||b.pfad!==LESER_RUNTIME_DATEIEN[i]
   ||typeof b.bytes!=='string'||!(/^[1-9][0-9]*$/).test(b.bytes)||BigInt(b.bytes)>reverseBigInt(s,'leser_paket_bytes'))return runtimeFail('leser_runtime_index_ungueltig');
  return {pfad:LESER_RUNTIME_DATEIEN[i],sha256:pruefeLeserRuntimePin(b.sha256),bytes:b.bytes};
 });
 const index={dateien},n=dateien.reduce((sum,b)=>sum+BigInt(b.bytes),0n)+BigInt(Buffer.byteLength(reverseLeserKanonisch(index)));
 if(n>reverseBigInt(s,'leser_paket_bytes'))runtimeFail('leser_runtime_paket_zu_gross');
 return index;
}
export const leserRuntimePin=(i:LeserRuntimeIndex)=>reverseLeserHash(reverseLeserKanonisch(i));
export function pruefeLeserRuntimeQuelle(x:unknown,s:ReverseEinstellSnapshot):LeserRuntimeQuelle {
 if(!objekt(x)||Object.keys(x).sort().join()!=='dateien,project'||x.project!=='synapse'
  ||!Array.isArray(x.dateien)||x.dateien.length!==LESER_RUNTIME_DATEIEN.length)runtimeFail('leser_runtime_quelle_ungueltig');
 const dateien=x.dateien.map((q:unknown)=>{
  if(!objekt(q)||Object.keys(q).sort().join()!=='pfad,version_id'||!(LESER_RUNTIME_DATEIEN as readonly unknown[]).includes(q.pfad)
   ||typeof q.version_id!=='string'||!(/^[1-9][0-9]*$/).test(q.version_id)||BigInt(q.version_id)>9223372036854775807n) return runtimeFail('leser_runtime_quelle_ungueltig');
  return {pfad:q.pfad as string,version_id:q.version_id};
 }).sort((a,b)=>a.pfad.localeCompare(b.pfad,'en'));
 if(dateien.some((q,i)=>q.pfad!==LESER_RUNTIME_DATEIEN[i]))runtimeFail('leser_runtime_quelle_ungueltig');
 if(Buffer.byteLength(reverseLeserKanonisch(x))>reverseZahl(s,'parameter_text_zeichen'))runtimeFail('leser_runtime_quelle_zu_gross');
 return {project:'synapse',dateien};
}
