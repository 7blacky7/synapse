/**
 * P22-T194: optionale echte CLI-Policy-Abnahme ohne Modell/Netz/Runtime/Host-Settings.
 * Voraussetzung Linux+bwrap+Claude CLI; explizit manuell, kein Gesamttest-Eintrag.
 * mise exec node@25 -- node scripts/pruefe-runtime-mod-policy-p22-t194.mjs
 * Die CLI sieht /etc/claude-code ausschliesslich im eigenen Mount-Namespace.
 */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {paketiereMods} from '../docker/synapse-agent-runtime/paketiere-mods.mjs';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const dir=await mkdtemp(join(tmpdir(),'p22-t194-policy-cli-'));
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
try{
 const paket=join(dir,'paket');paketiereMods(join(root,'mods'),paket,'t194-cli-probe');
 const policyDir=join(dir,'etc'),helper=join(dir,'policy-helper');
 await mkdir(policyDir);
 await writeFile(helper,'#!/bin/sh\nexec '+quote(process.execPath)+' '+quote(join(root,'packages/agents/dist/runtime-mod-policy-helper.js'))+'\n');
 await chmod(helper,0o700);
 const settings=JSON.parse(await readFile(join(root,'docker/synapse-agent-runtime/managed-settings.json'),'utf8'));
 settings.policyHelper.path=helper;
 await writeFile(join(policyDir,'managed-settings.json'),JSON.stringify(settings));
 // t223-Nachbesserung: nicht verwaltet (Schalter AUS) -> leere managed Policy; verwaltet mit Mod AUS bzw. EIN.
 for(const [aktiv,verwaltet] of [[false,false],[false,true],[true,true]]){
  const home=join(dir,'home-'+aktiv+'-'+verwaltet);await mkdir(home);await mkdir(join(home,'.claude'));
  const zustand={aktiv,quelle:'produkt-schalter',bis:null,letzter_fehler:null,produkt:{aktiv,quelle:'produkt-schalter',letzter_fehler:null}};
  const debug=join(home,'debug.log');
  const env={PATH:process.env.PATH,HOME:home,TMPDIR:home,LANG:'C.UTF-8',
   SYNAPSE_RUNTIME_MOD_POLICY:'1',SYNAPSE_RUNTIME_MOD_MARKETPLACE:paket,...(verwaltet?{SYNAPSE_RUNTIME_MOD_VERWALTET:'1'}:{}),
   SYNAPSE_RUNTIME_SYNAPSE_MODS_STAND:JSON.stringify(zustand),SYNAPSE_TOOL_AUSGABE_AKTIV:'0',
   SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',
   CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
  const r=spawnSync('bwrap',['--unshare-all','--die-with-parent','--ro-bind','/','/',
   '--bind',dir,dir,'--tmpfs','/etc','--ro-bind',policyDir,'/etc/claude-code',
   '--proc','/proc','--dev','/dev','--chdir',home,'--','claude','--debug-file',debug,'plugin','list','--json'],
   {env,encoding:'utf8',timeout:25000,maxBuffer:2*1024*1024});
  console.log('CLI-POLICY '+JSON.stringify({aktiv,status:r.status,signal:r.signal,error:r.error?.code,stdout:r.stdout,stderr:r.stderr}));
  assert.equal(r.status,0,'CLI-POLICY erwartet Exit0 '+aktiv);
  JSON.parse(r.stdout);
  const log=await readFile(debug,'utf8');
  assert.match(log,/policyHelper applied \(keys: managedSettings\)/,'produktiver policyHelper wird angewandt');
  if(aktiv){
   assert.match(log,/synapse-inbox@synapse-runtime\(managed\)/,'nur eigene Quelle besitzt managed-Scope');
   assert.match(log,/Read hooks\.json for plugin synapse-inbox \(enabled=true\)/,'eigene Mod ist im echten CLI-Loader freigegeben');
  }else if(verwaltet)assert.match(log,/Read hooks\.json for plugin synapse-inbox \(enabled=false; will NOT register/,'verwaltet, Mod AUS: registriert keine Mod-Hooks');
  else assert.doesNotMatch(log,/synapse-inbox@synapse-runtime/,'Schalter AUS: leere managed Policy ohne Synapse-Mod');
  console.log('POLICY-DEBUG '+log.split('\n').filter(x=>/policyHelper|enabled plugins with scopes|Read hooks\.json/.test(x)).join('\n'));
  console.log('BESTANDEN echte CLI-Policy '+aktiv+' verwaltet '+verwaltet+' (eigener Namespace, kein Netz/Modell)');
 }
}finally{await rm(dir,{recursive:true,force:true});}
