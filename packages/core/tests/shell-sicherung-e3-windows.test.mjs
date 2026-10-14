import assert from'node:assert/strict';import{execFile}from'node:child_process';import{promisify}from'node:util';import{join}from'node:path';
import{ermittleShellLage}from'../dist/services/shell-lage.js';
import{pruefeShellStart}from'../dist/services/shell-start-sicherung.js';
import{SHELL_SICHERUNG_SEED}from'../dist/services/shell-sicherung-seed.js';
import{geschuetzteShellProzesse}from'../dist/services/shell-prozess-lage.js';
import{waehleShellStart}from'../dist/services/shell-start.js';
if(process.platform!=='win32'){console.log('SKIP shell-sicherung-e3-windows: benötigt Windows/Win32');process.exit(0);}const run=promisify(execFile),root=process.cwd();
const p=await geschuetzteShellProzesse();assert.ok(p.pids.includes(process.pid));assert.ok(p.pids.includes(process.ppid));
const katalog=structuredClone(SHELL_SICHERUNG_SEED);
katalog.regeln.push({id:'owned.windows-marker',version:1,art:'text',stufe:'anleitung',muster:{command:['^(echo|Write-Output)$']},antwort_id:'fs.rm',quelle:'owned-test',status:'aktiv'});
for(const mode of ['cmd','ps5','ps7']){
 const shell=mode==='cmd'?'cmd':'pwsh',command=mode==='cmd'?'echo E3_WIN':'Write-Output E3_WIN';
 const ctx={shell,os:'windows',cwd:root,project_root:root,env:{...process.env},env_vollstaendig:true};
 const lage=await ermittleShellLage(command,ctx),input={project:'owned-e3-windows',command,lage,agent_id:'sol-2',geschuetzte_pids:p.pids,geschuetzte_namen:p.namen};
 let d=pruefeShellStart(input,katalog);assert.equal(d.darf_starten,false);assert.equal(d.antwort.ausgefuehrt,false);
 const grant={grund:'Eigener ungefährlicher Windows-Marker',...d.antwort.bestaetigungsdaten};
 assert.equal(pruefeShellStart({...input,agent_id:'user',bestaetigt:grant},katalog).darf_starten,false);
 d=pruefeShellStart({...input,agent_id:'koordinator',bestaetigt:grant},katalog);assert.equal(d.darf_starten,true);
 const start=waehleShellStart(shell),program=mode==='ps5'?'powershell.exe':mode==='ps7'?join(root,'pwsh7','pwsh.exe'):start.programm;
 const output=await run(program,[...start.prefix,command],{cwd:root,timeout:10000});assert.equal(output.stdout.trim(),'E3_WIN');
 const stale=pruefeShellStart({...input,lage:{...lage,hash:'changed'},agent_id:'koordinator',bestaetigt:grant},katalog);
 assert.equal(stale.darf_starten,false);assert.equal(stale.antwort.error,'bestaetigung_veraltet');
 const hardCommand=mode==='cmd'?'taskkill /PID '+process.pid:'Stop-Process -Id '+process.pid;
 const hard=pruefeShellStart({...input,command:hardCommand,lage:await ermittleShellLage(hardCommand,ctx),agent_id:'koordinator',bestaetigt:grant},katalog);
 assert.equal(hard.darf_starten,false);assert.equal(hard.antwort.stufe,'sperre');
 console.log(mode+': native Lage/Prozesskette, Bestätigung/Marker/Drift/geschützte PID grün');
}
console.log('P10-T37 Windows: keine Signalbefehle ausgeführt, keine DB angesprochen.');
