/** P18-T88: begrenztes JSONL-Lesen aus dem bereits gesperrten Auftragsordner, keine Medienbytes in PG. */
import {createHash} from 'node:crypto';
import {constants,promises as fs} from 'node:fs';
import path from 'node:path';
import type {ReverseEMetadatei} from './reverse-e-bloecke.js';
export interface ReverseManifestVerweis {version:1;pfad:'.e-manifest.jsonl';sha256:string;bytes:string;zeilen:string}
export function reverseManifestVerweis(roh:unknown):ReverseManifestVerweis {
 const v=roh as Partial<ReverseManifestVerweis>|null;
 if(!v||v.version!==1||v.pfad!=='.e-manifest.jsonl'||typeof v.sha256!=='string'||!/^[a-f0-9]{64}$/.test(v.sha256)
  ||typeof v.bytes!=='string'||!/^(0|[1-9][0-9]*)$/.test(v.bytes)||typeof v.zeilen!=='string'||!/^(0|[1-9][0-9]*)$/.test(v.zeilen))
  throw new Error('reverse_manifest_verweis_ungueltig');
 return v as ReverseManifestVerweis;
}
async function oeffne(wurzel:string,v:ReverseManifestVerweis){
 const root=await fs.realpath(wurzel);
 if(root!==path.resolve(wurzel))throw new Error('reverse_manifest_wurzel_geaendert');
 const h=await fs.open(path.join(root,v.pfad),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 const st=await h.stat({bigint:true});
 if(!st.isFile()||st.nlink!==1n||st.size!==BigInt(v.bytes)){await h.close();throw new Error('reverse_manifest_datei_ungueltig');}
 return h;
}
export async function pruefeReverseManifest(wurzel:string,v:ReverseManifestVerweis,chunkBytes:number):Promise<void>{
 const h=await oeffne(wurzel,v);
 try{
  const hash=createHash('sha256');let bytes=0n;
  for await(const b of h.createReadStream({autoClose:false,highWaterMark:chunkBytes})){hash.update(b);bytes+=BigInt(b.length);}
  if(bytes!==BigInt(v.bytes)||hash.digest('hex')!==v.sha256)throw new Error('reverse_manifest_hash_geaendert');
 }finally{await h.close();}
}
export async function* leseReverseManifest(wurzel:string,v:ReverseManifestVerweis,recordBytes:number,chunkBytes:number):AsyncGenerator<ReverseEMetadatei>{
 const h=await oeffne(wurzel,v);let rest=Buffer.alloc(0),zeilen=0n;
 try{
  for await(const block of h.createReadStream({autoClose:false,highWaterMark:Math.min(recordBytes+1,chunkBytes)})){
   let b=Buffer.concat([rest,block]);let pos:number;
   while((pos=b.indexOf(10))>=0){
    if(pos>recordBytes)throw new Error('reverse_manifest_record_zu_gross');
    const roh=new TextDecoder('utf-8',{fatal:true}).decode(b.subarray(0,pos));
    const d=JSON.parse(roh) as ReverseEMetadatei;
    if(!d||typeof d!=='object'||Array.isArray(d)||typeof d.pfad!=='string'||typeof d.sha256!=='string'||typeof d.groesse!=='string')
     throw new Error('reverse_manifest_record_ungueltig');
    if(d.metadaten!==undefined&&(!d.metadaten||typeof d.metadaten!=='object'||Array.isArray(d.metadaten)))
     throw new Error('reverse_manifest_metadaten_ungueltig');
    zeilen++;yield d;b=b.subarray(pos+1);
   }
   if(b.length>recordBytes)throw new Error('reverse_manifest_record_zu_gross');
   rest=Buffer.from(b);
  }
  if(rest.length||zeilen!==BigInt(v.zeilen))throw new Error('reverse_manifest_unvollstaendig');
 }finally{await h.close();}
}
