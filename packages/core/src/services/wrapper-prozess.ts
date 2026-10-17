/** P7-T34: lokale Prozessidentität vor Stop, niemals PIDs aus fremden Hosts signalisieren. */
import { readFile, realpath } from 'node:fs/promises';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { getPool } from '../db/client.js';
import { aktuelleAgentIdentityId, leseAgentBezugModus } from './agent-bezug.js';

export interface WrapperIdentitaet {
  zustand: 'wrapper' | 'tot' | 'ungeprueft';
  start?: string;
  grund?: string;
}

export async function lokalerProjektpfad(project: string): Promise<string | null> {
  const { rows } = await getPool().query<{ path: string; hostname: string }>(
    "SELECT DISTINCT path,hostname FROM projects WHERE name=$1 AND path NOT LIKE '/virtual/%'",
    [project]);
  // Ohne Host-Spalte am Wrapper ist ein Mehrhost-Projekt nicht eindeutig zuordenbar.
  return rows.length === 1 && rows[0].hostname === hostname() ? rows[0].path : null;
}

export async function pruefeWrapperProzess(pid: number, name: string, project: string, projectPath: string, identityId?: string | null): Promise<WrapperIdentitaet> {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || process.platform !== 'linux') {
    return { zustand: 'ungeprueft', grund: 'PID oder Betriebssystem nicht sicher prüfbar' };
  }
  try {
    process.kill(pid, 0);
    const stat = await readFile('/proc/'+pid+'/stat','utf8');
    const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
    if (fields[0] === 'Z') return { zustand: 'tot' };
    const [cmd, env, erwartet, cwd] = await Promise.all([
      readFile('/proc/'+pid+'/cmdline','utf8'),
      readFile('/proc/'+pid+'/environ','utf8'),
      realpath(fileURLToPath(new URL('../../../agents/dist/wrapper.js', import.meta.url))),
      realpath('/proc/'+pid+'/cwd'),
    ]);
    const argv=cmd.split('\0').filter(Boolean), vars=new Map(env.split('\0').map(v=>{const i=v.indexOf('=');return [v.slice(0,i),v.slice(i+1)]}));
    // Exakt das Wrapper-Skript als Node-Einstieg, kein -e, cc-wrap, Claude/Codex oder Tray.
    if (argv.length!==2 || await realpath(argv[1]).catch(()=>null)!==erwartet ||
        vars.get('SYNAPSE_AGENT_NAME')!==name || vars.get('SYNAPSE_PROJECT_NAME')!==project ||
        (vars.get('SYNAPSE_AGENT_IDENTITY_ID') || null) !== (identityId ?? null) ||
        resolve(vars.get('SYNAPSE_PROJECT_PATH')||'')!==resolve(projectPath) ||
        cwd!==await realpath(projectPath)) {
      return { zustand:'ungeprueft', grund:'Kommandozeile, Projekt oder Agent stimmen nicht mit diesem Wrapper überein' };
    }
    const start=fields[19]; // /proc stat Feld22: Startzeit in Ticks seit Boot.
    if (!/^\d+$/.test(start||'')) return {zustand:'ungeprueft',grund:'Startzeit fehlt'};
    return {zustand:'wrapper',start};
  } catch(e) {
    if ((e as NodeJS.ErrnoException).code==='ESRCH') return {zustand:'tot'};
    if ((e as NodeJS.ErrnoException).code==='ENOENT') {
      try {process.kill(pid,0)} catch(k) {if((k as NodeJS.ErrnoException).code==='ESRCH')return {zustand:'tot'};}
    }
    return {zustand:'ungeprueft',grund:'Prozessidentität nicht vollständig lesbar'};
  }
}

/**
 * P9-T27 Welle 2: Datenzugriff fuer stoppeLokalenWrapper ohne eigene PG-Verbindung (Daemon-API-Weg).
 * Die Prozesspruefung und die Signale bleiben lokal; nur Lesen/Schreiben der Zeilen geht ueber den Zugriff.
 */
export interface WrapperStopZugriff {
  identityId?: (name: string, project: string) => string | null;
  /** Projektpfad dieses Hosts (wie lokalerProjektpfad) oder null. */
  projektpfad: (project: string) => Promise<string | null>;
  /** Wrapper-PID aus wrapper_status (genau eine Zeile) oder null. */
  wrapperPid: (name: string, project: string) => Promise<number | null>;
  /** PID-CAS wie unten: status stopped nur fuer genau diese PID. */
  setzeGestoppt: (name: string, project: string, pid: number) => Promise<void>;
}

export async function stoppeLokalenWrapper(name: string, projectPath: string, project?: string, zugriff?: WrapperStopZugriff): Promise<Record<string, unknown>> {
  const pool=zugriff?null:getPool();
  if (!project && pool) {
    const {rows}=await pool.query<{name:string}>('SELECT DISTINCT name FROM projects WHERE hostname=$1 AND path=$2',[hostname(),projectPath]);
    if(rows.length===1)project=rows[0].name;
  }
  const ungeprueft=(grund:string)=>({success:false,message:'Prozesstod UNGEPRUEFT: '+grund,steps:{prozess_beendet:'ungeprueft'}});
  if(!project || await (zugriff?zugriff.projektpfad(project):lokalerProjektpfad(project))!==projectPath)return ungeprueft('Projekt gehört nicht eindeutig zu diesem Host/Pfad');
  const identityId = zugriff?.identityId?.(name,project) ?? aktuelleAgentIdentityId(project,name);
  let gespeichertePid:number|null=null;
  if(zugriff)gespeichertePid=await zugriff.wrapperPid(name,project);
  else{
    const {rows}=await pool!.query(`SELECT wrapper_pid,last_activity FROM ${identityId ? 'agent_identitaet_wrapper_status' : 'wrapper_status'} WHERE ${identityId ? 'identity_id' : 'agent_name'}=$1 AND project=$2`,[identityId ?? name,project]);
    if(rows.length===1 && rows[0].wrapper_pid)gespeichertePid=Number(rows[0].wrapper_pid);
  }
  if(!gespeichertePid)return ungeprueft('keine Wrapper-PID in PostgreSQL');
  const pid=gespeichertePid, vorher=await pruefeWrapperProzess(pid,name,project,projectPath,identityId);
  if(vorher.zustand==='ungeprueft')return ungeprueft(vorher.grund||'Identität unbekannt');
  let tot=vorher.zustand==='tot';
  const gleich=async()=>{const p=await pruefeWrapperProzess(pid,name,project!,projectPath,identityId);return p.zustand==='wrapper'&&p.start===vorher.start;};
  if(!tot) {
    if(!await gleich())return ungeprueft('Prozessidentität vor SIGTERM verändert');
    process.kill(pid,'SIGTERM');
    const frist=Math.min(120000,Math.max(1000,Number(process.env.SYNAPSE_WRAPPER_STOP_MS)||60000))+1000;
    const ende=Date.now()+frist;
    while(Date.now()<ende) {
      const p=await pruefeWrapperProzess(pid,name,project,projectPath,identityId);
      if(p.zustand==='tot'){tot=true;break}
      if(p.zustand==='wrapper'&&p.start!==vorher.start)return ungeprueft('PID wurde während Stop wiederverwendet');
      // Ein sterbender Prozess kann zwischen stat/cmdline/cwd kurz unlesbar sein.
      // Weiter nur beobachten; ein weiteres Signal braucht unten erneut volle Identität.
      await new Promise(r=>setTimeout(r,100));
    }
    if(!tot) {
      if(!await gleich())return ungeprueft('Prozessidentität vor SIGKILL verändert');
      process.kill(pid,'SIGKILL');
      for(let n=0;n<20;n++){await new Promise(r=>setTimeout(r,100));if((await pruefeWrapperProzess(pid,name,project,projectPath,identityId)).zustand==='tot'){tot=true;break}}
    }
  }
  if(!tot)return ungeprueft('Wrapper nach Frist nicht nachweislich beendet');
  // PID-CAS: ein zwischenzeitlich neu gestarteter Wrapper bleibt unangetastet.
  if(zugriff)await zugriff.setzeGestoppt(name,project,pid);
  else await pool!.query(`UPDATE ${identityId ? 'agent_identitaet_wrapper_status' : 'wrapper_status'} SET status='stopped',busy=false,current_task=NULL,connected_mcp=false WHERE ${identityId ? 'identity_id' : 'agent_name'}=$1 AND project=$2 AND wrapper_pid=$3`,[identityId ?? name,project,pid]);
  return {success:true,message:'Spezialist "'+name+'" gestoppt. Prozess nachweislich beendet.',wrapper_pid:pid,steps:{prozess_beendet:true}};
}

/** Nur lokale, alte Zeilen untersuchen; lebende/unklare Prozesse bleiben unverändert. */
export async function reapLokaleWrapper(projects: string[], alterMs=300000): Promise<number> {
  let count=0;
  const bezug = await leseAgentBezugModus();
  for(const project of projects) {
    const path=await lokalerProjektpfad(project);if(!path)continue;
    const {rows}=await getPool().query(bezug.modus === 'alt' ? "SELECT agent_name,wrapper_pid,last_activity::text AS last_activity FROM wrapper_status WHERE project=$1 AND status IN ('running','idle') AND last_activity < NOW()-($2::double precision * interval '1 millisecond')" : "SELECT agent_name,wrapper_pid,last_activity::text AS last_activity,NULL::text AS identity_id FROM wrapper_status WHERE project=$1 AND status IN ('running','idle') AND last_activity < NOW()-($2::double precision * interval '1 millisecond') UNION ALL SELECT agent_name,wrapper_pid,last_activity::text AS last_activity,identity_id FROM agent_identitaet_wrapper_status WHERE project=$1 AND status IN ('running','idle') AND last_activity < NOW()-($2::double precision * interval '1 millisecond')",[project,alterMs]);
    for(const r of rows) {
      if((await pruefeWrapperProzess(Number(r.wrapper_pid),r.agent_name,project,path,r.identity_id)).zustand!=='tot')continue;
      const updated=await getPool().query(`UPDATE ${r.identity_id ? 'agent_identitaet_wrapper_status' : 'wrapper_status'} SET status='crashed',busy=false,connected_mcp=false WHERE project=$1 AND ${r.identity_id ? 'identity_id' : 'agent_name'}=$2 AND wrapper_pid=$3 AND last_activity=$4 AND status IN ('running','idle')`,[project,r.identity_id ?? r.agent_name,r.wrapper_pid,r.last_activity]);
      count+=updated.rowCount??0;
    }
  }
  return count;
}
