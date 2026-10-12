/** P10-T37: aktueller Katalog, read-only Prozesslage und maskiertes Job-Audit. */
import {getPool}from'../db/client.js';
import{ladeShellSicherungsKatalog,type ShellSicherungsKatalog}from'./shell-sicherung.js';
import{SHELL_SICHERUNG_SEED}from'./shell-sicherung-seed.js';
import{maskiereShellVorSpeichern}from'./shell-maske.js';
import type{ShellStartEntscheidung,ShellBestaetigung}from'./shell-start-sicherung.js';
import type{ShellLage}from'./shell-lage.js';
/** Gepflegte DB-Einträge überschreiben gleichnamigen Grundstock, auch stillgelegt. */
export async function holeShellStartKatalog():Promise<ShellSicherungsKatalog>{
  const db=await ladeShellSicherungsKatalog(getPool());
  const merge=<T extends {id:string}>(base:T[],rows:T[]):T[]=>[...new Map([...base,...rows].map(x=>[x.id,x])).values()];
  return {regeln:merge(SHELL_SICHERUNG_SEED.regeln,db.regeln),
    antworten:merge(SHELL_SICHERUNG_SEED.antworten,db.antworten),
    risiko_verben:merge(SHELL_SICHERUNG_SEED.risiko_verben,db.risiko_verben)};
}
export{geschuetzteShellProzesse}from'./shell-prozess-lage.js';
export interface ShellPruefSpeicher {
  project:string;command:string;cwd_relative?:string;agent_id?:string|null;job_id?:string;
  entscheidung:ShellStartEntscheidung;lage:ShellLage;bestaetigt?:ShellBestaetigung|null;
  ursprung?:'daemon'|'mcp_local'|'workspace'; rechner?:string;
}
/** Bei normalen direkten Aufrufen keine zusätzliche Zeile; Queue-Jobs immer annotieren. */
export async function beginneShellSicherungsJob(o:ShellPruefSpeicher):Promise<string|undefined>{
  if(!o.job_id&&!o.entscheidung.antwort&&o.entscheidung.audit.entscheidung!=='bestaetigt')return undefined;
  const data=await maskiereShellVorSpeichern(o.project,{
    audit:o.entscheidung.audit,lage:o.lage,rechner:o.rechner??null,ursprung:o.ursprung??'mcp_local',
    ...(o.entscheidung.antwort?{antwort:o.entscheidung.antwort}:{}),
  });
  if(o.job_id){
    const r=await getPool().query<{id:string}>(
      'UPDATE shell_jobs SET sicherung=$4::jsonb,updated_at=NOW() WHERE id=$1::uuid AND project=$2 AND command=$3 RETURNING id',
      [o.job_id,o.project,o.command,JSON.stringify(data)]);
    if(!r.rows[0])throw Error('sicherungs_job_nicht_zugeordnet');return r.rows[0].id;
  }
  const status=o.entscheidung.darf_starten?'running':'rejected';
  const r=await getPool().query<{id:string}>(
    'INSERT INTO shell_jobs(project,command,cwd_relative,status,agent_id,claimed_by,sicherung,error,completed_at)'+
    'VALUES($1,$2,$3,$4::shell_job_status,$5,$6,$7::jsonb,$8,CASE WHEN $4::text=$9::text THEN NOW() ELSE NULL END) RETURNING id',
    [o.project,o.command,o.cwd_relative??null,status,o.agent_id??null,'mcp_local',JSON.stringify(data),
      o.entscheidung.darf_starten?null:o.entscheidung.antwort?.error??'shell_anleitung','rejected']);
  return r.rows[0].id;
}
/** Für direkte Core/Workspace-Läufe; Queue-Worker behält seinen bestehenden Abschlussweg. */
export async function beendeShellSicherungsJob(id:string,project:string,result:Record<string,unknown>):Promise<void>{
  const safe=await maskiereShellVorSpeichern(project,result);
  const state=safe.status==='done'?'done':safe.status==='hard_limit'?'timeout':
    safe.status==='rejected'?'rejected':'failed';
  await getPool().query(
    'UPDATE shell_jobs SET status=$2,exit_code=$3,tail=$4::jsonb,error=$5,message=$6,stream_id=$7,completed_at=NOW(),updated_at=NOW() WHERE id=$1::uuid AND project=$8',
    [id,state,typeof safe.exit_code==='number'?safe.exit_code:null,JSON.stringify(safe.tail??[]),
      safe.error??null,safe.message??null,safe.stream_id??null,project]);
}
