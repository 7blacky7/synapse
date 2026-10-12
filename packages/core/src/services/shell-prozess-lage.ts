/** P10-T37: feste native Prozess-Metadatenprobe ohne Datenbank oder Nutzerbefehl. */
import{readFile}from'node:fs/promises';
import{execFile}from'node:child_process';import{promisify}from'node:util';import path from'node:path';
/** Nur Metadaten der eigenen Elternkette, kein Nutzerbefehl und keine Signale. */
export async function geschuetzteShellProzesse():Promise<{pids:number[];namen:string[]}>{
  const pids=new Set<number>([process.pid,process.ppid]);const namen=new Set<string>([path.basename(process.execPath).toLowerCase()]);
  if(process.platform==='win32'){
    const script='$p='+process.pid+';$rows=@();$seen=@{};$lookup=@{};'+
      'Get-CimInstance Win32_Process | ForEach-Object {$lookup[[int]$_.ProcessId]=$_};'+
      'for($i=0;$i -lt 32 -and $p -gt 0 -and -not $seen.ContainsKey($p);$i++){'+
      '$seen[$p]=$true;$r=$lookup[$p];if(-not $r){break};'+
      '$rows+=@{pid=[int]$r.ProcessId;parent=[int]$r.ParentProcessId;name=$r.Name};$p=[int]$r.ParentProcessId};'+
      'ConvertTo-Json -Compress -InputObject @($rows)';
    const run=promisify(execFile);
    const r=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{
      timeout:10000,maxBuffer:65536,windowsHide:true,
      env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,PATH:process.env.PATH},
    });
    const rows=JSON.parse(r.stdout.trim()) as Array<{pid:number;parent:number;name:string}>;
    for(const row of rows){if(Number.isInteger(row.pid))pids.add(row.pid);if(Number.isInteger(row.parent)&&row.parent>0)pids.add(row.parent);if(typeof row.name==='string')namen.add(row.name.toLowerCase());}
  }else if(process.platform==='linux'){
    let pid=process.pid;const seen=new Set<number>();
    for(let i=0;i<32&&pid>0&&!seen.has(pid);i++){
      seen.add(pid);const raw=await readFile('/proc/'+pid+'/stat','utf8');
      const m=raw.match(/^(\d+)\s+\((.*)\)\s+\S+\s+(\d+)\s+(\d+)/);if(!m)throw Error('prozesslage_nicht_lesbar');
      pids.add(Number(m[1]));namen.add(m[2].toLowerCase());
      // Gruppenleiter gehört zur Eltern-Prozessgruppe; negatives kill-Ziel trifft ihn.
      const group=Number(m[4]);if(group>0)pids.add(group);
      pid=Number(m[3]);
    }
  }
  return {pids:[...pids],namen:[...namen]};
}
