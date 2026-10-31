/**
 * P22-T194: exakt freigegebene Mod-Dateien fuer das Image paketieren.
 * Nur beim Imagebau oder mit einem expliziten Test-Zielverzeichnis aufrufen.
 */
import { readFileSync, readdirSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
export function paketiereMods(quelle, ziel, revision) {
  quelle=resolve(quelle);ziel=resolve(ziel);
  if(ziel===quelle||ziel.startsWith(quelle+'/'))throw Error('Mod-Paket-Ziel muss ausserhalb der Quelle liegen');
  const dateien={};
  const kopiere=rel=>{
    const data=readFileSync(join(quelle,rel));
    mkdirSync(join(ziel,rel,'..'),{recursive:true});
    copyFileSync(join(quelle,rel),join(ziel,rel));
    dateien[rel]=createHash('sha256').update(data).digest('hex');
  };
  kopiere('.claude-plugin/marketplace.json');
  kopiere('synapse-inbox/.claude-plugin/plugin.json');
  for(const f of readdirSync(join(quelle,'synapse-inbox/hooks')).sort()){
    if(/\.test\./.test(f)||!(/\.(ts|js|json)$/.test(f)))continue;
    kopiere('synapse-inbox/hooks/'+f);
  }
  const plugin=JSON.parse(readFileSync(join(ziel,'synapse-inbox/.claude-plugin/plugin.json'),'utf8'));
  const manifest={revision,version:plugin.version,dateien};
  writeFileSync(join(ziel,'synapse-paket.json'),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===new URL(import.meta.url).pathname){
  if(!process.argv[2]||!process.argv[3]||!process.argv[4])throw Error('Quelle Ziel Revision erforderlich');
  paketiereMods(process.argv[2],process.argv[3],process.argv[4]);
}
