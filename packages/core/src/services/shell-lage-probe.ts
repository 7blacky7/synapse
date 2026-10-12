/** P10-T36: fester read-only Helfer, auch als Node-Programm im Container/Windows. */
export interface ShellProbePfad {
  pfad: string; kanonisch?: string; existiert?: boolean; verzeichnis?: boolean;
  naechster_elternpfad?: string; links: Array<{pfad:string;ziel:string}>;
  mount?: string; dev?: string; fehler?: string;
}
export interface ShellProbeAnfrage { cwd?: string; variablen?: string[]; pfade?: string[]; prozesse?:boolean; }
export interface ShellProbeAntwort {
  cwd: string; os: 'linux'|'windows'|'macos'|'wsl'; env: Record<string,string>;
  pfade: ShellProbePfad[]; prozesse?:{pids:number[];namen:string[]}; rechner?:string;
}
export async function probeShellLage(input: ShellProbeAnfrage): Promise<ShellProbeAntwort> {
  // Alles in dieser Funktion: toString() erzeugt denselben festen Helfer, keine zweite Implementierung.
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const windows = process.platform === 'win32';
  const p = windows ? path.win32 : path.posix;
  if ((input.pfade?.length ?? 0)>256 || (input.variablen?.length ?? 0)>256) throw Error('lage_probe_grenze');
  const cwd = input.cwd ? p.resolve(input.cwd) : process.cwd();
  const env: Record<string,string> = {};
  for (const name of input.variablen ?? []) {
    if (!/^[A-Za-z_]\w*$/.test(name)) continue;
    const key=windows?Object.keys(process.env).find(k=>k.toLowerCase()===name.toLowerCase()):name;
    if(key && process.env[key]!==undefined)env[name]=process.env[key]!;
  }
  const records: ShellProbePfad[]=[];
  for(const raw of input.pfade ?? []){
    const pfad=p.resolve(cwd,raw);
    const r:ShellProbePfad={pfad,links:[]};
    // Geräte/Netzwerk-Namespace niemals zur Dateisystemprobe öffnen.
    if(windows && /^\\\\(?:[?.]\\|[^\\]+\\[^\\]+)/.test(pfad)){r.fehler='namespace_nicht_geprueft';records.push(r);continue;}
    if(!windows && /^\/dev(?:\/|$)/.test(pfad)){r.fehler='geraet_nicht_geprueft';records.push(r);continue;}
    let parent=pfad, found=false;
    for(let depth=0;depth<64;depth++){
      try {
        const st=await fs.lstat(parent);
        r.existiert=parent===pfad;r.verzeichnis=parent===pfad?st.isDirectory():undefined;
        r.naechster_elternpfad=r.existiert?p.dirname(pfad):parent;
        const real=await fs.realpath(parent);
        r.kanonisch=p.join(real,p.relative(parent,pfad));r.dev=String(st.dev);
        if(parent===pfad)r.verzeichnis=(await fs.stat(real)).isDirectory();
        found=true;
        const parsed=p.parse(parent);
        let part=parsed.root;
        for(const segment of parent.slice(parsed.root.length).split(p.sep).filter(Boolean)){
          part=p.join(part,segment);
          const linkStat=await fs.lstat(part);
          if(linkStat.isSymbolicLink()){
            if(r.links.length>=32){r.fehler='link_grenze';break;}
            const target=await fs.readlink(part);
            r.links.push({pfad:part,ziel:p.isAbsolute(target)?target:p.resolve(p.dirname(part),target)});
          }
        }
        // Nächster Mount: Metadaten lesen, keine Inhalte oder Verzeichnisbäume.
        let mount=real;
        let mountStat=await fs.stat(real);
        if(!mountStat.isDirectory()){mount=p.dirname(mount);mountStat=await fs.stat(mount);}
        for(let n=0;n<64;n++){
          const next=p.dirname(mount);
          if(next===mount){r.mount=mount;break;}
          const nextStat=await fs.stat(next);
          if(nextStat.dev!==mountStat.dev){r.mount=mount;break;}
          mount=next;mountStat=nextStat;
        }
        break;
      }catch(e){
        const code=(e as NodeJS.ErrnoException).code;
        if(code!=='ENOENT' && code!=='ENOTDIR'){r.fehler=code??'pfad_nicht_lesbar';break;}
        const next=p.dirname(parent);
        if(next===parent){r.fehler='kein_existierender_elternpfad';break;}
        parent=next;
      }
    }
    if(!found && !r.fehler)r.fehler='elternpfad_grenze';
    records.push(r);
  }
  let prozesse:ShellProbeAntwort['prozesse'];
  if(input.prozesse){
    if(process.platform!=='linux')throw Error('container_prozesslage_nicht_verfuegbar');
    const pids=new Set<number>(),namen=new Set<string>(),seen=new Set<number>();
    let pid=process.pid;
    for(let i=0;i<32&&pid>0&&!seen.has(pid);i++){
      seen.add(pid);
      const raw=await fs.readFile('/proc/'+pid+'/stat','utf8');
      const m=raw.match(/^(\d+)\s+\((.*)\)\s+\S+\s+(\d+)\s+(\d+)/);
      if(!m)throw Error('container_prozesslage_nicht_lesbar');
      pids.add(Number(m[1]));namen.add(m[2].toLowerCase());
      if(Number(m[4])>0)pids.add(Number(m[4]));
      pid=Number(m[3]);
    }
    prozesse={pids:[...pids],namen:[...namen]};
  }
  return {cwd,os:windows?'windows':process.platform==='darwin'?'macos':process.env.WSL_DISTRO_NAME?'wsl':'linux',env,pfade:records,
    ...(prozesse?{prozesse,rechner:(await import('node:os')).hostname()}:{} )};
}
/** Der Nutzerbefehl ist nie Teil dieses Programms; nur JSON-Daten in argv[1]. */
export function shellLageProbeProgramm(): string {
  return '('+probeShellLage.toString()+')(JSON.parse(process.argv[1]))' +
    '.then(x=>process.stdout.write(JSON.stringify(x))).catch(()=>{process.stderr.write("lage_probe_fehlgeschlagen");process.exitCode=2;})';
}
