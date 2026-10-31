/** P22-T194: HOME-Mount nach dem Einhaengen mit dem unveraenderlichen Image-Paket verbinden. */
import { mkdirSync, lstatSync, realpathSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pruefeRuntimeModPaket } from '@synapse/agents';
export interface RuntimeModPaketStand {
  bereit: boolean; quelle: 'image' | 'aus'; revision: string | null; version: string | null;
  image_pfad: string | null; home_pfad: string | null; sha256: string | null; letzter_fehler: string | null;
}
export function provisioniereRuntimeMods(env: NodeJS.ProcessEnv = process.env): RuntimeModPaketStand {
  const aus: RuntimeModPaketStand = { bereit:false, quelle:'aus', revision:null, version:null, image_pfad:null, home_pfad:null, sha256:null, letzter_fehler:null };
  if(env.SYNAPSE_RUNTIME_MOD_POLICY !== '1')return aus;
  const p=pruefeRuntimeModPaket(env.SYNAPSE_RUNTIME_MOD_MARKETPLACE || '/opt/synapse/current/mods');
  if(!/^[a-zA-Z0-9._-]+$/.test(p.revision))throw Error('runtime_mod_revision_ungueltig');
  const home=join(env.HOME || '/root','.claude','synapse-mods');
  mkdirSync(home,{recursive:true,mode:0o755});
  const link=join(home,p.revision);
  let vorhanden=false;
  try{const s=lstatSync(link);vorhanden=true;if(!s.isSymbolicLink()||realpathSync(link)!==p.root)throw Error('runtime_mod_home_pfad_belegt');}
  catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(!vorhanden)symlinkSync(p.root,link,'dir');
  const stand: RuntimeModPaketStand={bereit:true,quelle:'image',revision:p.revision,version:p.version,image_pfad:p.root,home_pfad:link,
    sha256:createHash('sha256').update(readFileSync(join(p.root,'synapse-paket.json'))).digest('hex'),letzter_fehler:null};
  console.error('[runtime-mods] '+JSON.stringify(stand));
  return stand;
}
