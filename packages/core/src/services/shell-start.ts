/** P10-T36: explizite native Shellwahl, kein shell:true oder stiller Interpreterwechsel. */
import type {SicherungsShell}from'./shell-sicherung-parser.js';
export function waehleShellStart(shell: SicherungsShell | undefined, platform: NodeJS.Platform = process.platform) {
  const art=shell??(platform==='win32'?'cmd':'sh');
  if(art==='cmd') {
    if(platform!=='win32')throw Error('cmd_nur_windows');
    return {shell:art,programm:'cmd.exe',prefix:['/d','/s','/c'],detached:false};
  }
  if(art==='pwsh')return {shell:art,programm:platform==='win32'?'pwsh.exe':'pwsh',prefix:['-NoLogo','-NoProfile','-NonInteractive','-Command'],detached:platform!=='win32'};
  return {shell:art,programm:art,prefix:['-c'],detached:platform!=='win32'};
}
