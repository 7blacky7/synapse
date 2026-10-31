/** M2: vorhandene Klassifikation/Registry und zweigeteilte Ignoreregeln, keine neue Endungsliste. */
import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import * as path from 'node:path';
import {assetArt,ermittleTransferFormat,loadGitignore,shouldIgnore,istGesperrt,normalisiereSpeicherPfad} from '@synapse/core';
/** via (P22-T238): 'inspektor' = Format aus dem Inspector-Katalog, 'generisch' = Binaerdatei ohne Inspector (Endung als Format). */
export interface LokalesAsset {format:string;groesse:number;signatur:string;via?:'inspektor'|'generisch';}
/** generisch (P22-T238): API-Freigabe generischeFormate (Schalter asset_transfer_generisch); fehlt sie, gilt das Altverhalten. */
export async function pruefeLokalesAsset(root:string,project:string,pfad:string,o:{maxDateiBytes:number;erlaubteTypen?:string[];generisch?:boolean}):Promise<LokalesAsset|null>{
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
  // P22-T238: Text/SVG kommt hier nie an (assetArt null); generisch nur fuer Binaerinhalt ohne Inspector.
  const erkannt=ermittleTransferFormat(rel,bytes,o.generisch===true);
  if(!erkannt||o.erlaubteTypen&&!o.erlaubteTypen.includes(erkannt.format))return null;
  return {format:erkannt.format,via:erkannt.via,groesse:Number(s.size),signatur:[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':')};
 }finally{await fd.close();}
}
