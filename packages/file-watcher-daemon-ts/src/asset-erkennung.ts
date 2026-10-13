/** M2: vorhandene Klassifikation/Registry und zweigeteilte Ignoreregeln, keine neue Endungsliste. */
import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import * as path from 'node:path';
import {assetArt,standardRegistry,loadGitignore,shouldIgnore,istGesperrt,normalisiereSpeicherPfad} from '@synapse/core';
export interface LokalesAsset {format:string;groesse:number;signatur:string;}
export async function pruefeLokalesAsset(root:string,project:string,pfad:string,o:{maxDateiBytes:number;erlaubteTypen?:string[]}):Promise<LokalesAsset|null>{
 const rel=normalisiereSpeicherPfad(pfad);
 if(istGesperrt(rel,root,project)||shouldIgnore(loadGitignore(root,project),rel))return null;
 let parent=await fs.realpath(root);
 if(parent!==path.resolve(root))throw new Error('Assetwurzel ist ein Symlink');
 const parts=rel.split('/');
 for(const part of parts.slice(0,-1)){
  parent=path.join(parent,part);const s=await fs.lstat(parent);
  if(!s.isDirectory()||s.isSymbolicLink())throw new Error('Assetelternpfad ist kein sicheres Verzeichnis');
 }
 const fd=await fs.open(path.join(parent,parts.at(-1)!),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const s=await fd.stat({bigint:true});if(!s.isFile()||s.size>BigInt(o.maxDateiBytes))return null;
  const head=Buffer.alloc(4096),read=await fd.read(head,0,head.length,0);
  const bytes=head.subarray(0,read.bytesRead);
  if(!assetArt(rel,bytes))return null;
  const format=standardRegistry.detect(rel,bytes).format;
  if(!format||o.erlaubteTypen&&!o.erlaubteTypen.includes(format))return null;
  return {format,groesse:Number(s.size),signatur:[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':')};
 }finally{await fd.close();}
}
